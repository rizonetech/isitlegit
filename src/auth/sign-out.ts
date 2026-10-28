// The app shell's Sign out form posts here (D07 T01 §3, D07 T02 §1): only from the app's own pages, then back to
// /signin with the session ended and its cookie cleared, signed in or not. Better Auth's sign-out logs a failed session
// delete and answers success anyway, so a success here is checked: the session it ended must be gone from D1. When it is
// not, or D1 fails, the answer is 503 and the cookie is kept, so the member sees it did not finish and can try again.
import { createAuth } from "./auth";

const unfinished = () =>
  new Response("Signing out did not finish. Try again in a moment.", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "retry-after": "5" },
  });

export async function signOut(env: Env, request: Request): Promise<Response> {
  if (request.headers.get("origin") !== new URL(env.APP_URL).origin) return new Response("Forbidden", { status: 403 });
  const auth = createAuth(env);
  try {
    const signedIn = await auth.api.getSession({ headers: request.headers });
    const { headers } = await auth.api.signOut({ headers: request.headers, returnHeaders: true });
    if (signedIn && (await (await auth.$context).internalAdapter.findSession(signedIn.session.token)))
      return unfinished();
    const out = new Response(null, { status: 303, headers: { location: "/signin" } });
    for (const cookie of headers.getSetCookie()) out.headers.append("set-cookie", cookie);
    return out;
  } catch {
    return unfinished();
  }
}
