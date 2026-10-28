// The app shell's Sign out form posts here (D07 T01 §3, D07 T02 §1): only from the app's own pages, then back to
// /signin with the session ended and its cookie cleared, signed in or not. Better Auth's sign-out refuses unless the
// session is gone from D1 (src/auth/auth.ts); then the answer is 503 and the cookie is kept, so the member sees it did not
// finish and can try again.
import { createAuth } from "./auth";

const unfinished = () =>
  new Response("Signing out did not finish. Try again in a moment.", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "retry-after": "5" },
  });

export async function signOut(env: Env, request: Request): Promise<Response> {
  if (request.headers.get("origin") !== new URL(env.APP_URL).origin) return new Response("Forbidden", { status: 403 });
  try {
    const { headers } = await createAuth(env).api.signOut({ headers: request.headers, returnHeaders: true });
    const out = new Response(null, { status: 303, headers: { location: "/signin" } });
    for (const cookie of headers.getSetCookie()) out.headers.append("set-cookie", cookie);
    return out;
  } catch {
    return unfinished();
  }
}
