// The session gate every member page uses (D07 T02 §1). It reads the session through Better Auth and passes on any
// Set-Cookie that read returns (a session past its update age is renewed, and the browser must get the new cookie, or
// its cookie expires while the session lives on). Signed in: the user and session go on the context. Not signed in: a
// browser asking for a page goes to /signin with `next` (the page asked for, a same-site path), anything else gets 401.
import { createMiddleware } from "hono/factory";
import { type Auth, createAuth, sameSitePath } from "./auth";

export type SignedIn = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;
export type GateEnv = { Bindings: Env; Variables: { signedIn: SignedIn } };

const notSignedIn = () =>
  Response.json({ error: "sign in first" }, { status: 401, headers: { "cache-control": "no-store" } });

function toSignIn(requested: string) {
  const url = new URL(requested);
  const wanted = `${url.pathname}${url.search}`;
  const to = sameSitePath(wanted) ? `/signin?next=${encodeURIComponent(wanted)}` : "/signin";
  return new Response(null, { status: 303, headers: { location: to } });
}

export const requireSession = createMiddleware<GateEnv>(async (c, next) => {
  const auth = createAuth(c.env);
  // A session store that cannot be read is an outage, answered 503 to be retried, not a bare 500 and never a pass.
  const read = await auth.api.getSession({ headers: c.req.raw.headers, returnHeaders: true }).catch(() => null);
  if (!read)
    return c.json({ error: "signing in could not be checked just now; try again in a moment" }, 503, {
      "cache-control": "no-store",
      "retry-after": "5",
    });
  const { headers, response } = read;
  if (!response) {
    // Better Auth's own headers go too: for an expired session they delete its cookie, so the browser stops sending it.
    const refused = (c.req.header("accept") ?? "").includes("text/html") ? toSignIn(c.req.url) : notSignedIn();
    for (const cookie of headers.getSetCookie()) refused.headers.append("set-cookie", cookie);
    return refused;
  }
  c.set("signedIn", response);
  await next();
  for (const cookie of headers.getSetCookie()) c.res.headers.append("set-cookie", cookie);
});
