// The app shell's Sign out form posts here (D07 T01 §3, D07 T02 §1): only from the app's own pages, then back to
// /signin with the session ended and its cookie cleared, signed in or not. A form may name where to go instead (`next`,
// a path on this site by §1's rule): the invitation page sends someone signed in as another address back to the
// invitation (D07 T02 §14). Better Auth's sign-out refuses unless the
// session is gone from D1 (src/auth/auth.ts); then the answer is 503 and the cookie is kept, so the member sees it did not
// finish and can try again.
import { createAuth } from "./auth";
import { readSmallForm } from "./form";
import { MAX_RETURN_PATH, sameSitePath } from "./paths";

const unfinished = () =>
  new Response("Signing out did not finish. Try again in a moment.", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "retry-after": "5" },
  });

export async function signOut(env: Env, request: Request): Promise<Response> {
  if (request.headers.get("origin") !== new URL(env.APP_URL).origin) return new Response("Forbidden", { status: 403 });
  const form = await readSmallForm(request, { next: MAX_RETURN_PATH });
  if (!form) return new Response("Request too large", { status: 413, headers: { "cache-control": "no-store" } });
  const next = form.next;
  try {
    const { headers } = await createAuth(env).api.signOut({ headers: request.headers, returnHeaders: true });
    const out = new Response(null, {
      status: 303,
      headers: { location: sameSitePath(next) ? next : "/signin", "cache-control": "no-store" },
    });
    for (const cookie of headers.getSetCookie()) out.headers.append("set-cookie", cookie);
    return out;
  } catch {
    // A page that named where to come back to hears it there, with its own way to try again (the invitation page,
    // D07 T02 §14); otherwise the plain answer.
    if (!sameSitePath(next)) return unfinished();
    const back = new URL(next, "https://same-site.invalid");
    back.searchParams.set("signout", "failed");
    return new Response(null, {
      status: 303,
      headers: { location: `${back.pathname}${back.search}`, "cache-control": "no-store" },
    });
  }
}
