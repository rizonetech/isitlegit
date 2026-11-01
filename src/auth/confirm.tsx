// Sign-in links that survive link scanners (D07 T02 §10). A mail system's scanner (Microsoft Defender Safe Links,
// Mimecast, Proofpoint) opens every link in a message before the member does; a link that signs in on GET signs the
// scanner in and leaves the member's click refused. So the mailed link opens a page that only shows a button, and the
// button's POST redeems the token through Better Auth's own verify endpoint, server-side. Scanners fetch; they do not
// submit forms.
//
//   GET  /signin/confirm?token=&callbackURL=   the page: one button, nothing created
//   POST /signin/confirm                       redeem the token, then 303 to the return path with the session cookie
//   POST /signin/link                          the "link expired or used" state's recovery: mail a new link
//   POST /signin/code                          the code mailed beside the link (D07 T02 §11): signs in the browser that
//                                              asked, redeeming the same token
//   GET  /api/auth/magic-link/verify           a link mailed before this change: 303 to the page, never redeemed
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import * as z from "zod";
import { SIGNIN_PATH, SigninPage } from "../web/pages/signin";
import {
  SIGNUP_PATH,
  type SignupErrors,
  SignupNotConfirmedPage,
  SignupPage,
  type SignupValues,
} from "../web/pages/signup";
import { clientIp, recordAuthEvent } from "./audit";
import { createAuth } from "./auth";
import {
  CONFIRM_PATH,
  ConfirmPage,
  confirmUrl,
  InboxPage,
  LINK_PATH,
  LinkCheckFailedPage,
  LinkRequestPage,
  MessagePage,
  pageResponse,
  type Retry,
  resumesIn,
  retryIn,
  returnPath,
} from "./confirm-page";
import { DEFAULT_RETURN, MAX_RETURN_PATH } from "./paths";
import { APP_RULES, d1RateLimit, LINK_WINDOW_SECONDS } from "./ratelimit";
import { validOrganisationName } from "./schema";
import {
  CODE_COOKIE,
  CODE_PATH,
  clearHandleCookie,
  handleCookie,
  newHandle,
  normaliseCode,
  readHandle,
} from "./signin-code";
import { askedElsewhere, checkCode, giveBack, markUsed } from "./signin-code-store";

// What Better Auth's verify answered, sorted into the confirm page's states (better-auth/dist/plugins/magic-link):
// signed in (a session cookie); rate limited (its limiter's 429, before the token is touched, so the same link works a
// minute later); used (an invalid or expired token: a new link); no account (an account it would not make or could not
// find: a new link would be refused the same way); and failed (anything else, the token possibly spent: a new link).
export type VerifyOutcome = "signed-in" | "rate-limited" | "used" | "no-account" | "failed";
const LINK_ERRORS = new Set(["INVALID_TOKEN", "EXPIRED_TOKEN"]);

export function classifyVerify(answer: Response, origin: string): VerifyOutcome {
  const signedIn = answer.headers.getSetCookie().some((cookie) => /session_token=[^;]+/.test(cookie));
  if (answer.status >= 300 && answer.status < 400 && signedIn) return "signed-in";
  if (answer.status === 429) return "rate-limited";
  // A failure is Better Auth's redirect to its failure path (`/signin?next=...&error=`), so an `error` parameter in the
  // member's own destination is never taken for one (round 1).
  const location = answer.headers.get("location");
  const failure = location ? new URL(location, origin) : null;
  const error = failure?.pathname === "/signin" ? failure.searchParams.get("error") : null;
  if (!error || SERVICE_ERRORS.has(error)) return "failed";
  return LINK_ERRORS.has(error) ? "used" : "no-account";
}

// The reason a link failed, as the audit trail names it: Better Auth's own error code, lowercased (`invalid_token`,
// `expired_token`, `new_user_signup_disabled`, ...), or the outcome when it gave none.
function failureReason(answer: Response, origin: string, outcome: VerifyOutcome): string {
  const location = answer.headers.get("location");
  const failure = location ? new URL(location, origin) : null;
  const error = failure?.pathname === "/signin" ? failure.searchParams.get("error") : null;
  return error && /^[A-Za-z_]{1,64}$/.test(error) ? error.toLowerCase() : outcome;
}

// The errors Better Auth's magic-link verify redirects with (better-auth/dist/plugins/magic-link): a used, expired or
// unknown token, or an address that may not have an account, all of which need a new link (or none); and the two that
// are the service's own failure after the token was taken, told apart as "did not finish".
const SERVICE_ERRORS = new Set(["failed_to_create_session", "failed_to_create_user"]);

// A form here is a token and a return path, or an address and a return path: a few hundred bytes. Anything larger is
// refused before it is read, and each field is bounded before it is checked or drawn back into a page, so a large post
// can neither fill the isolate's memory nor be echoed into a larger page (D07 T02 §10 round 1).
const MAX_FORM_BYTES = 8 * 1024;
const MAX_FIELD = {
  token: 512,
  callbackURL: MAX_RETURN_PATH,
  email: 254,
  code: 16,
  // The signup form (D07 T02 §13): an invite code, the organisation's name (its rule allows 120 characters), consent.
  invite: 200,
  organizationName: 480,
  consent: 8,
} as const;
// Better Auth's own rule for the address (better-auth/dist/plugins/magic-link: `z.email()`), so an address it would
// refuse is a field error here, not a send it then refuses.
const EMAIL = z.email();

type Fields = Partial<Record<keyof typeof MAX_FIELD, string>>;

// The form's fields, or null when the body is over the limit or is not a form. Read as text with a running count, so
// a body without a Content-Length is bounded too.
async function readForm(request: Request): Promise<Fields | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_FORM_BYTES || !request.body) return declared > MAX_FORM_BYTES ? null : {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FORM_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const text = new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
  const fields: Fields = {};
  for (const [name, value] of new URLSearchParams(text))
    if (name in MAX_FIELD && value.length <= MAX_FIELD[name as keyof typeof MAX_FIELD])
      fields[name as keyof typeof MAX_FIELD] = value;
  return fields;
}

const tooLarge = () => new Response("Request too large", { status: 413 });

const sameOrigin = (env: Env, request: Request) => request.headers.get("origin") === new URL(env.APP_URL).origin;

// The headers an internal call to Better Auth carries: the app's origin, and the member's own address, so its limiter
// and the session it stores see the member, not one shared "no address" bucket for everyone (D07 T02 §10, G1).
function forwarded(env: Env, request: Request, extra: Record<string, string> = {}): Headers {
  const headers = new Headers({ origin: new URL(env.APP_URL).origin, ...extra });
  for (const name of ["cf-connecting-ip", "x-forwarded-for", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // The browser's sign-in code handle, and nothing else of its cookies (D07 T02 §11): a new link keeps the handle.
  const handle = readHandle(request.headers);
  if (handle) headers.set("cookie", `${CODE_COOKIE}=${handle}`);
  return headers;
}

// The limiter's retry time (Better Auth's `X-Retry-After`, in seconds); its whole window when it is missing.
const retryAfterOf = (answer: Response) => {
  const seconds = Number(answer.headers.get("x-retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : LINK_WINDOW_SECONDS;
};

const log = (step: string) => console.log(JSON.stringify({ event: "signin-confirm", step }));

// Redeem a token through Better Auth's own verify, server-side, as the confirm page's button and a right code both do.
async function askVerify(env: Env, request: Request, token: string, callbackURL: string) {
  const verify = new URL("/api/auth/magic-link/verify", new URL(env.APP_URL).origin);
  verify.searchParams.set("token", token);
  verify.searchParams.set("callbackURL", callbackURL);
  let answer: Response;
  try {
    answer = await createAuth(env).handler(new Request(verify, { headers: forwarded(env, request) }));
  } catch {
    answer = new Response(null, { status: 500 });
  }
  return { answer, outcome: classifyVerify(answer, verify.origin), origin: verify.origin };
}

// Signed in: 303 to the return path with the session cookie. Serialised as an absolute URL on the app's own origin: a
// header carries no raw non-ASCII (round 2), and a path that resolves to `//host` can never become a protocol-relative
// redirect (round 3).
function signedIn(callbackURL: string, origin: string, cookies: string[]): Response {
  const destination = new URL(callbackURL, origin);
  const to = destination.origin === origin ? destination.href : new URL(DEFAULT_RETURN, origin).href;
  const out = new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } });
  for (const cookie of cookies) out.headers.append("set-cookie", cookie);
  // The page landed on tells this browser's other tabs (the one that asked for the link) that the sign-in finished
  // (D07 T02 §7, src/web/client/app.ts), by a short-lived cookie it reads and clears: the address, its fragment
  // included (a report's evidence anchor), is left as asked.
  out.headers.append("set-cookie", `${SIGNED_IN_COOKIE}=1; Path=/; Max-Age=60; SameSite=Lax; Secure`);
  return out;
}
export const SIGNED_IN_COOKIE = "isitlegit_signed_in";

export const confirmRoutes = new Hono<{ Bindings: Env }>();

// Every sign-in page gives a browser that has no code handle one (D07 T02 §11, round 2), so the handle exists before
// any link is asked for: two requests sent at once from a browser with none would otherwise each be given a handle of
// their own, and the second cookie would orphan the first request's code. A browser that holds one keeps it; a redirect
// (a sign-in, which clears it) and an answer that sets it already are left alone.
// The signup page too (D07 T02 §13): its first link's code is bound to the handle the browser signs up with.
const giveHandle = createMiddleware(async (c, next) => {
  await next();
  if (readHandle(c.req.raw.headers) || c.res.status >= 300) return;
  if (c.res.headers.getSetCookie().some((cookie) => cookie.startsWith(`${CODE_COOKIE}=`))) return;
  c.res.headers.append("set-cookie", handleCookie(newHandle()));
});
confirmRoutes.use("/signin/*", giveHandle);
confirmRoutes.use("/signup", giveHandle);

// The sign-in page (D07 T02 §7): `next` is normalised once, here, and that one value is what every way out of the page
// carries (the link request, the code form, the automatic finish); an `error` is a used or expired link the session
// gate sent back (src/auth/auth.ts `recoveryPath`).
confirmRoutes.get(SIGNIN_PATH, (c) => {
  const error = c.req.query("error");
  return pageResponse(<SigninPage next={returnPath(c.req.query("next"))} error={error ? error.slice(0, 64) : null} />);
});

confirmRoutes.get(CONFIRM_PATH, async (c) => {
  const token = c.req.query("token") ?? "";
  const callbackURL = returnPath(c.req.query("callbackURL"));
  // Logged with no token or address, so a scanner's fetch before the member's click shows in the Worker's logs.
  log("shown");
  if (!token) return pageResponse(<LinkRequestPage callbackURL={callbackURL} />, 400);
  // Whether another browser asked for this link (§12): one read, no write, the same answer for a scanner as for anyone
  // without the asking browser's handle. A read that fails is a retryable page, never a claim either way.
  let elsewhere: boolean;
  try {
    elsewhere = await askedElsewhere(c.env.DB, readHandle(c.req.raw.headers), token);
  } catch {
    log("check-failed");
    return pageResponse(<LinkCheckFailedPage token={token} callbackURL={callbackURL} />, 503);
  }
  return pageResponse(<ConfirmPage token={token} callbackURL={callbackURL} elsewhere={elsewhere} />);
});

confirmRoutes.post(CONFIRM_PATH, async (c) => {
  if (!sameOrigin(c.env, c.req.raw)) return new Response("Forbidden", { status: 403 });
  const form = await readForm(c.req.raw);
  if (!form) return tooLarge();
  const token = form.token ?? "";
  const callbackURL = returnPath(form.callbackURL);
  if (!token) return pageResponse(<LinkRequestPage callbackURL={callbackURL} />, 400);
  const { answer, outcome, origin } = await askVerify(c.env, c.req.raw, token, callbackURL);
  const cookies = answer.headers.getSetCookie();
  // A link that did not sign anyone in is the audit trail's failed sign-in (D07 T02 §6), with Better Auth's reason
  // (used or unknown, expired, no account, the service's failure), never the token.
  if (outcome === "used" || outcome === "no-account" || outcome === "failed")
    await recordAuthEvent(c.env.DB, c.env.BETTER_AUTH_SECRET ?? "", {
      kind: "sign-in-failed",
      outcome: failureReason(answer, origin, outcome),
      ip: clientIp(c.req.raw.headers),
    });
  if (outcome === "signed-in") {
    log("signed-in");
    return signedIn(callbackURL, origin, cookies);
  }
  if (outcome === "rate-limited") {
    // The token is untouched: the same button works again once the limiter's window has passed.
    log("rate-limited");
    return pageResponse(
      <ConfirmPage token={token} callbackURL={callbackURL} retry={retryIn(retryAfterOf(answer))} />,
      429,
    );
  }
  if (outcome === "used") {
    log("used");
    return pageResponse(<LinkRequestPage callbackURL={callbackURL} />, 400);
  }
  if (outcome === "no-account") {
    log("no-account");
    return pageResponse(
      <MessagePage
        title="No account for this address"
        heading="This address has no IsItLegit account"
        text="Ask the owner of your organisation's IsItLegit account to invite you, then sign in from the invitation."
      />,
      403,
    );
  }
  // The token may already be spent while the session was not stored: the member needs a new link, and the cause is
  // the service's, so it is logged apart from an expired link; the page asks for one at once, the return path kept.
  log("failed");
  return pageResponse(
    <LinkRequestPage
      callbackURL={callbackURL}
      title="Sign-in did not finish"
      heading="Sign-in did not finish"
      text="Something went wrong on our side. Enter your email for a new link and try again."
    />,
    503,
  );
});

// "Use a different email" from the inbox state: the request form with the address to correct.
confirmRoutes.get(LINK_PATH, (c) =>
  pageResponse(
    <LinkRequestPage
      callbackURL={returnPath(c.req.query("callbackURL"))}
      email={(c.req.query("email") ?? "").slice(0, MAX_FIELD.email)}
      title="Get a sign-in link"
      heading="Get a sign-in link"
      text="Enter the email you sign in with. We will send a link that works once, for 15 minutes."
    />,
  ),
);

confirmRoutes.post(LINK_PATH, async (c) => {
  if (!sameOrigin(c.env, c.req.raw)) return new Response("Forbidden", { status: 403 });
  const form = await readForm(c.req.raw);
  if (!form) return tooLarge();
  const email = (form.email ?? "").trim();
  const callbackURL = returnPath(form.callbackURL);
  const badAddress = () =>
    pageResponse(
      <LinkRequestPage callbackURL={callbackURL} email={email} error="Enter the email you sign in with." />,
      400,
    );
  if (!EMAIL.safeParse(email).success) return badAddress();
  let asked: Response;
  try {
    asked = await createAuth(c.env).handler(
      new Request(new URL("/api/auth/sign-in/magic-link", new URL(c.env.APP_URL).origin), {
        method: "POST",
        headers: forwarded(c.env, c.req.raw, { "content-type": "application/json" }),
        body: JSON.stringify({ email, callbackURL }),
      }),
    );
  } catch {
    asked = new Response(null, { status: 500 });
  }
  // A sent, refused or address-limited request answers alike, so the page never tells a stranger who can sign in (the
  // per-address limit answers as sent, D01 T02 §2). The per-IP limit (D07 T02 §6) is this client's own, so it says when
  // new links resume, the address and return path kept; a failed send (the service's) says to try again.
  if (asked.ok) {
    // The code's handle Better Auth set on its answer (D07 T02 §11) goes to the browser with the inbox page.
    const page = await pageResponse(<InboxPage email={email} callbackURL={callbackURL} />);
    for (const cookie of asked.headers.getSetCookie())
      if (cookie.startsWith(`${CODE_COOKIE}=`)) page.headers.append("set-cookie", cookie);
    return page;
  }
  if (asked.status === 429)
    return pageResponse(
      <LinkRequestPage callbackURL={callbackURL} email={email} retry={retryIn(retryAfterOf(asked))} />,
      429,
    );
  // Better Auth refusing the request itself (its own validation) is the address, not an outage.
  if (asked.status === 400) return badAddress();
  return pageResponse(
    <LinkRequestPage
      callbackURL={callbackURL}
      email={email}
      title="The link could not be sent"
      heading="The link could not be sent"
      text="We could not send the link just now. Try again in a moment."
    />,
    503,
  );
});

// The code mailed beside a link (D07 T02 §11; ./signin-code): it signs in only the browser holding the handle the link
// was asked with, three wrong codes end it, and a right code redeems the link's own token, so the two are one sign-in.
// Every refusal comes back to the inbox page with its message on the field and the controls to recover.
const unrecorded = (step: string) => (error: unknown) =>
  console.log(JSON.stringify({ event: "signin-code", outcome: step, error: (error as Error).name }));

const CODE_REFUSED = {
  "no-request":
    "This code works only in the browser where you asked for the link, while the link is new. Send another link from here.",
  expired: "That code has run out: codes work for 15 minutes. Send another link.",
  locked: "That code no longer works after three wrong tries. Send another link.",
} as const;

confirmRoutes.post(CODE_PATH, async (c) => {
  if (!sameOrigin(c.env, c.req.raw)) return new Response("Forbidden", { status: 403 });
  const form = await readForm(c.req.raw);
  if (!form) return tooLarge();
  const email = form.email ?? "";
  const callbackURL = returnPath(form.callbackURL);
  // A rate limit's retry keeps the code it stopped, so pressing Sign in again needs nothing typed (completion review).
  const inbox = (codeError: string, status: number, retry?: Retry) =>
    pageResponse(
      <InboxPage
        email={email}
        callbackURL={callbackURL}
        codeError={codeError}
        {...(retry ? { retry, code: (form.code ?? "").slice(0, 16) } : {})}
      />,
      status,
    );
  const secret = c.env.BETTER_AUTH_SECRET ?? "";
  // Counted per IP before anything is read or recorded (D07 T02 §6's limiter, ./ratelimit), so neither guesses nor
  // refusals can be sent faster than the rule; a limiter that cannot count is the service's fault, as below.
  try {
    const limit = await d1RateLimit(
      () => c.env.DB,
      secret,
      (event) => recordAuthEvent(c.env.DB, secret, event),
    ).consume(`${clientIp(c.req.raw.headers) ?? ""}|${CODE_PATH}`, APP_RULES[CODE_PATH]);
    if (!limit.allowed)
      return inbox(
        `Too many codes tried from here. Try again in ${resumesIn(limit.retryAfter ?? LINK_WINDOW_SECONDS)}.`,
        429,
        retryIn(limit.retryAfter ?? LINK_WINDOW_SECONDS),
      );
  } catch (error) {
    unrecorded("uncounted")(error);
    return inbox("We could not check the code just now. Type it again in a moment.", 503);
  }
  const code = normaliseCode(form.code);
  // Not six digits: a slip, not a guess, so no attempt is spent.
  if (!code) return inbox("Enter the 6-digit code from the email.", 400);
  const refused = (outcome: string) =>
    recordAuthEvent(c.env.DB, secret, { kind: "sign-in-failed", outcome, ip: clientIp(c.req.raw.headers) });
  // A row the store cannot read or claim is the service's fault: the member is told to try again, and nothing was spent.
  let check: Awaited<ReturnType<typeof checkCode>>;
  try {
    check = await checkCode(c.env.DB, secret, readHandle(c.req.raw.headers), code);
  } catch (error) {
    unrecorded("unchecked")(error);
    return inbox("We could not check the code just now. Type it again in a moment.", 503);
  }
  if (check.kind === "wrong") {
    await refused("code-wrong");
    return inbox(`That code is not right. ${check.left} ${check.left === 1 ? "try" : "tries"} left.`, 400);
  }
  if (check.kind !== "match") {
    await refused(`code-${check.kind}`);
    return inbox(CODE_REFUSED[check.kind], 400);
  }
  const { answer, outcome, origin } = await askVerify(c.env, c.req.raw, check.token, check.callbackURL);
  if (outcome === "signed-in") {
    // Signed in: the session goes to the browser whatever happens to the row, whose token is spent anyway.
    await markUsed(c.env.DB, check.id).catch(unrecorded("unmarked"));
    log("code-signed-in");
    const out = signedIn(check.callbackURL, origin, answer.headers.getSetCookie());
    out.headers.append("set-cookie", clearHandleCookie());
    return out;
  }
  if (outcome === "rate-limited") {
    // The token is untouched: the attempt is given back and the same code works once the limiter lets it. An attempt
    // that could not be given back may have been the code's last, so the page then points to a new link instead.
    const wait = resumesIn(retryAfterOf(answer));
    const kept = await giveBack(c.env.DB, check.claimed).then(
      () => true,
      (error) => {
        unrecorded("not-given-back")(error);
        return false;
      },
    );
    return inbox(
      kept
        ? `Too many sign-in tries from here. Type the code again in ${wait}.`
        : `Too many sign-in tries from here, and this code could not be kept for later. Send another link in ${wait}.`,
      429,
      kept ? retryIn(retryAfterOf(answer)) : undefined,
    );
  }
  // Used (the link was spent first), no account, or the service's failure after the token was taken: the code is done.
  await markUsed(c.env.DB, check.id).catch(unrecorded("unmarked"));
  await refused(failureReason(answer, origin, outcome));
  if (outcome === "no-account")
    return pageResponse(
      <MessagePage
        title="No account for this address"
        heading="This address has no IsItLegit account"
        text="Ask the owner of your organisation's IsItLegit account to invite you, then sign in from the invitation."
      />,
      403,
    );
  return outcome === "used"
    ? inbox("That code no longer works: its link was already used. Send another link.", 400)
    : inbox("Sign-in did not finish on our side. Send another link and try again.", 503);
});

// The signup page (D07 T02 §13): `GET /signup` draws the form, an invite code shared as `/signup?code=<code>` filled in
// (kept in the form only; the page is no-store and sends no referrer off the site); `POST /signup` checks the form as
// the endpoint would, then calls the invite-code endpoint (D07 T02 §4) with the browser's own address forwarded, so the
// endpoint's per-IP limit counts it, and draws its answer. Every unusable code is one answer (§4: a guess learns
// nothing), said in one sentence that covers each reason (a Deviation in design/SPEC.md A2).
const UNUSABLE_CODE =
  "We do not recognise that code, or it has been used up or has expired. Ask whoever gave it to you for a new one.";

confirmRoutes.get(SIGNUP_PATH, (c) =>
  pageResponse(<SignupPage values={{ invite: (c.req.query("code") ?? "").slice(0, MAX_FIELD.invite) }} />),
);

confirmRoutes.post(SIGNUP_PATH, async (c) => {
  if (!sameOrigin(c.env, c.req.raw)) return new Response("Forbidden", { status: 403 });
  const form = await readForm(c.req.raw);
  // Too large to read: the form again, empty, saying why (the fields' own limits keep a typed form under it).
  if (!form)
    return pageResponse(
      <SignupPage problem={{ text: "That was more than the form can take. Check each field and try again." }} />,
      413,
    );
  const values: SignupValues = {
    invite: (form.invite ?? "").trim(),
    email: (form.email ?? "").trim(),
    organizationName: (form.organizationName ?? "").trim(),
    consent: form.consent === "yes",
  };
  const refused = (errors: SignupErrors, status = 400) =>
    pageResponse(<SignupPage values={values} errors={errors} />, status);
  const errors: SignupErrors = {};
  if (!values.invite) errors.invite = "Enter the invite code you were given.";
  if (!EMAIL.safeParse(values.email).success) errors.email = "Enter your work email.";
  if (!validOrganisationName(values.organizationName))
    errors.organizationName = "Enter your organisation's name, on one line, up to 120 characters.";
  if (!values.consent) errors.consent = "Tick the box to agree before creating your account.";
  if (Object.keys(errors).length) return refused(errors);
  let answer: Response;
  try {
    answer = await createAuth(c.env).handler(
      new Request(new URL("/api/auth/sign-up/invite-code", new URL(c.env.APP_URL).origin), {
        method: "POST",
        headers: forwarded(c.env, c.req.raw, { "content-type": "application/json" }),
        body: JSON.stringify({
          email: values.email,
          code: values.invite,
          organizationName: values.organizationName,
          consent: true,
        }),
      }),
    );
  } catch {
    answer = new Response(null, { status: 500 });
  }
  if (answer.status === 201) {
    const body = (await answer.json().catch(() => ({}))) as { linkSent?: boolean };
    const page = await pageResponse(
      body.linkSent ? (
        <InboxPage email={values.email ?? ""} callbackURL="/welcome" />
      ) : (
        <SignupNotConfirmedPage email={values.email ?? ""} />
      ),
      201,
    );
    // The first link's code is bound to this browser's handle, which the endpoint set (D07 T02 §11).
    for (const cookie of answer.headers.getSetCookie())
      if (cookie.startsWith(`${CODE_COOKIE}=`)) page.headers.append("set-cookie", cookie);
    return page;
  }
  if (answer.status === 409) return refused({ email: "This address already has an account. Sign in instead." }, 409);
  if (answer.status === 400) {
    const message = ((await answer.json().catch(() => ({}))) as { message?: string }).message ?? "";
    if (/invite code/i.test(message)) return refused({ invite: UNUSABLE_CODE });
    if (/consent/i.test(message)) return refused({ consent: "Tick the box to agree before creating your account." });
    if (/organisation name/i.test(message))
      return refused({ organizationName: "Enter your organisation's name, on one line, up to 120 characters." });
    return refused({ email: "Enter your work email." });
  }
  if (answer.status === 429) {
    const retry = retryIn(retryAfterOf(answer));
    return pageResponse(
      <SignupPage
        values={values}
        problem={{ text: `Too many signups from here. You can try again at ${retry.words} SAST.`, retry }}
      />,
      429,
    );
  }
  // The endpoint failing (its 503, or anything else): the code may already be used, and the redemption it made is kept,
  // so the same form sent again resumes this signup (D07 T02 §4).
  return pageResponse(
    <SignupPage
      values={values}
      problem={{ text: "Your account could not be finished just now. Press Create account again in a moment." }}
    />,
    503,
  );
});

// A link mailed before this change named Better Auth's verify URL: it goes to the page with the same token and return
// path, so it still works, and a scanner that opens it still signs no one in.
confirmRoutes.get("/api/auth/magic-link/verify", (c) =>
  Response.redirect(confirmUrl(c.env.APP_URL, c.req.query("token") ?? "", c.req.query("callbackURL")), 303),
);
