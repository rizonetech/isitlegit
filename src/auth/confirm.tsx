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
import { createAuth } from "./auth";
import {
  CONFIRM_PATH,
  ConfirmPage,
  confirmUrl,
  LINK_PATH,
  MessagePage,
  pageResponse,
  returnPath,
  UsedPage,
} from "./confirm-page";

// The errors Better Auth's magic-link verify redirects with (better-auth/dist/plugins/magic-link): a used, expired or
// unknown token, or an address that may not have an account, all of which need a new link (or none); and the two that
// are the service's own failure after the token was taken, told apart as "did not finish".
const SERVICE_ERRORS = new Set(["failed_to_create_session", "failed_to_create_user"]);

const sameOrigin = (env: Env, request: Request) => request.headers.get("origin") === new URL(env.APP_URL).origin;

const log = (step: string) => console.log(JSON.stringify({ event: "signin-confirm", step }));

export const confirmRoutes = new Hono<{ Bindings: Env }>();

confirmRoutes.get(CONFIRM_PATH, (c) => {
  const token = c.req.query("token") ?? "";
  const callbackURL = returnPath(c.req.query("callbackURL"));
  // Logged with no token or address, so a scanner's fetch before the member's click shows in the Worker's logs.
  log("shown");
  if (!token) return pageResponse(<UsedPage callbackURL={callbackURL} />, 400);
  return pageResponse(<ConfirmPage token={token} callbackURL={callbackURL} />);
});

confirmRoutes.post(CONFIRM_PATH, async (c) => {
  if (!sameOrigin(c.env, c.req.raw)) return new Response("Forbidden", { status: 403 });
  const form = await c.req.formData().catch(() => null);
  const token = String(form?.get("token") ?? "");
  const callbackURL = returnPath(form?.get("callbackURL"));
  if (!token) return pageResponse(<UsedPage callbackURL={callbackURL} />, 400);
  const verify = new URL("/api/auth/magic-link/verify", new URL(c.env.APP_URL).origin);
  verify.searchParams.set("token", token);
  verify.searchParams.set("callbackURL", callbackURL);
  let answer: Response;
  try {
    answer = await createAuth(c.env).handler(
      new Request(verify, { headers: { origin: new URL(c.env.APP_URL).origin } }),
    );
  } catch {
    answer = new Response(null, { status: 500 });
  }
  const location = answer.headers.get("location");
  const error = location ? new URL(location, verify).searchParams.get("error") : null;
  const cookies = answer.headers.getSetCookie();
  if (
    answer.status >= 300 &&
    answer.status < 400 &&
    !error &&
    cookies.some((cookie) => cookie.includes("session_token"))
  ) {
    log("signed-in");
    const out = new Response(null, { status: 303, headers: { location: callbackURL, "cache-control": "no-store" } });
    for (const cookie of cookies) out.headers.append("set-cookie", cookie);
    return out;
  }
  if (error && !SERVICE_ERRORS.has(error)) {
    log("used");
    return pageResponse(<UsedPage callbackURL={callbackURL} />, 400);
  }
  // The token may already be spent while the session was not stored: the member needs a new link, and the cause is
  // the service's, so it is logged apart from an expired link.
  log("failed");
  return pageResponse(
    <MessagePage
      title="Sign-in did not finish"
      heading="Sign-in did not finish"
      text="Something went wrong on our side. Ask for a new sign-in link and try again in a moment."
    />,
    503,
  );
});

confirmRoutes.post(LINK_PATH, async (c) => {
  if (!sameOrigin(c.env, c.req.raw)) return new Response("Forbidden", { status: 403 });
  const form = await c.req.formData().catch(() => null);
  const email = String(form?.get("email") ?? "").trim();
  const callbackURL = returnPath(form?.get("callbackURL"));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
    return pageResponse(
      <UsedPage callbackURL={callbackURL} email={email} error="Enter the email you sign in with." />,
      400,
    );
  const asked = await createAuth(c.env).handler(
    new Request(new URL("/api/auth/sign-in/magic-link", new URL(c.env.APP_URL).origin), {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(c.env.APP_URL).origin },
      body: JSON.stringify({ email, callbackURL }),
    }),
  );
  // A sent, refused or rate-limited address answers alike, so the page never tells a stranger who can sign in; only a
  // failed send (the service's) says to try again.
  if (asked.ok || asked.status === 429)
    return pageResponse(
      <MessagePage
        title="Check your inbox"
        heading="Check your inbox"
        text="If that address can sign in, a new link is on its way. It works once, for 15 minutes."
      />,
    );
  return pageResponse(
    <MessagePage
      title="The link could not be sent"
      heading="The link could not be sent"
      text="We could not send the link just now. Go back and try again in a moment."
    />,
    503,
  );
});

// A link mailed before this change named Better Auth's verify URL: it goes to the page with the same token and return
// path, so it still works, and a scanner that opens it still signs no one in.
confirmRoutes.get("/api/auth/magic-link/verify", (c) =>
  Response.redirect(confirmUrl(c.env.APP_URL, c.req.query("token") ?? "", c.req.query("callbackURL")), 303),
);
