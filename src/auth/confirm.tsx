// Sign-in links that survive link scanners (D07 T02 §10). A mail system's scanner (Microsoft Defender Safe Links,
// Mimecast, Proofpoint) opens every link in a message before the member does; a link that signs in on GET signs the
// scanner in and leaves the member's click refused. So the mailed link opens a page that only shows a button, and the
// button's POST redeems the token through Better Auth's own verify endpoint, server-side. Scanners fetch; they do not
// submit forms.
//
//   GET  /signin/confirm?token=&callbackURL=   the page: one button, nothing created
//   POST /signin/confirm                       redeem the token, then 303 to the return path with the session cookie
//   POST /signin/link                          the "link expired or used" state's recovery: mail a new link
//   GET  /api/auth/magic-link/verify           a link mailed before this change: 303 to the page, never redeemed
import { Hono } from "hono";
import * as z from "zod";
import { createAuth } from "./auth";
import {
  CONFIRM_PATH,
  ConfirmPage,
  confirmUrl,
  InboxPage,
  LINK_PATH,
  LinkRequestPage,
  pageResponse,
  returnPath,
} from "./confirm-page";

// The errors Better Auth's magic-link verify redirects with (better-auth/dist/plugins/magic-link): a used, expired or
// unknown token, or an address that may not have an account, all of which need a new link (or none); and the two that
// are the service's own failure after the token was taken, told apart as "did not finish".
const SERVICE_ERRORS = new Set(["failed_to_create_session", "failed_to_create_user"]);

// A form here is a token and a return path, or an address and a return path: a few hundred bytes. Anything larger is
// refused before it is read, and each field is bounded before it is checked or drawn back into a page, so a large post
// can neither fill the isolate's memory nor be echoed into a larger page (D07 T02 §10 round 1).
const MAX_FORM_BYTES = 8 * 1024;
const MAX_FIELD = { token: 512, callbackURL: 2048, email: 254 } as const;
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
  return headers;
}

const log = (step: string) => console.log(JSON.stringify({ event: "signin-confirm", step }));

export const confirmRoutes = new Hono<{ Bindings: Env }>();

confirmRoutes.get(CONFIRM_PATH, (c) => {
  const token = c.req.query("token") ?? "";
  const callbackURL = returnPath(c.req.query("callbackURL"));
  // Logged with no token or address, so a scanner's fetch before the member's click shows in the Worker's logs.
  log("shown");
  if (!token) return pageResponse(<LinkRequestPage callbackURL={callbackURL} />, 400);
  return pageResponse(<ConfirmPage token={token} callbackURL={callbackURL} />);
});

confirmRoutes.post(CONFIRM_PATH, async (c) => {
  if (!sameOrigin(c.env, c.req.raw)) return new Response("Forbidden", { status: 403 });
  const form = await readForm(c.req.raw);
  if (!form) return tooLarge();
  const token = form.token ?? "";
  const callbackURL = returnPath(form.callbackURL);
  if (!token) return pageResponse(<LinkRequestPage callbackURL={callbackURL} />, 400);
  const verify = new URL("/api/auth/magic-link/verify", new URL(c.env.APP_URL).origin);
  verify.searchParams.set("token", token);
  verify.searchParams.set("callbackURL", callbackURL);
  let answer: Response;
  try {
    answer = await createAuth(c.env).handler(new Request(verify, { headers: forwarded(c.env, c.req.raw) }));
  } catch {
    answer = new Response(null, { status: 500 });
  }
  // Success is a session cookie; a failure is Better Auth's redirect to its failure path (`/signin?next=...&error=`),
  // so an `error` parameter in the member's own destination is never taken for one (round 1).
  const cookies = answer.headers.getSetCookie();
  const signedIn = cookies.some((cookie) => /session_token=[^;]+/.test(cookie));
  const location = answer.headers.get("location");
  const failure = location ? new URL(location, verify) : null;
  const error = failure?.pathname === "/signin" ? failure.searchParams.get("error") : null;
  if (answer.status >= 300 && answer.status < 400 && signedIn) {
    log("signed-in");
    // Serialised as a URL: a header carries no raw non-ASCII, and the token is already spent here (round 2).
    const destination = new URL(callbackURL, verify);
    const to = `${destination.pathname}${destination.search}${destination.hash}`;
    const out = new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } });
    for (const cookie of cookies) out.headers.append("set-cookie", cookie);
    return out;
  }
  if (error && !SERVICE_ERRORS.has(error)) {
    log("used");
    return pageResponse(<LinkRequestPage callbackURL={callbackURL} />, 400);
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
  // A sent, refused or rate-limited address answers alike, so the page never tells a stranger who can sign in; only a
  // failed send (the service's) says to try again, with the address and return path kept for the retry.
  if (asked.ok || asked.status === 429) return pageResponse(<InboxPage email={email} callbackURL={callbackURL} />);
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

// A link mailed before this change named Better Auth's verify URL: it goes to the page with the same token and return
// path, so it still works, and a scanner that opens it still signs no one in.
confirmRoutes.get("/api/auth/magic-link/verify", (c) =>
  Response.redirect(confirmUrl(c.env.APP_URL, c.req.query("token") ?? "", c.req.query("callbackURL")), 303),
);
