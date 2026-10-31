// Shared by the auth tests (D07 T02 §1): the Worker with an SMTP2GO key, SMTP2GO stubbed, and the magic link it sent.
import { env } from "cloudflare:test";
import { vi } from "vitest";
import worker from "../../src/index";
import { SMTP2GO_URL } from "../../src/mail/smtp2go";

export const ORIGIN = "http://localhost";
export const authEnv = { ...(env as unknown as Env), SMTP2GO_API_KEY: `api-${"k".repeat(32)}` };

export type Answer = "sent" | "refused" | "silent";
export type Sent = { to: string; subject: string; text: string; link: string; html?: string };

// SMTP2GO, answering as told: a confirmed send, a refusal (HTTP 400), or no answer (the request is cut off).
export function stubSmtp2go(answer: () => Answer = () => "sent") {
  const sends: Sent[] = [];
  const real = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== SMTP2GO_URL) return real(input, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      to: string[];
      subject: string;
      text_body: string;
      html_body?: string;
    };
    const kind = answer();
    if (kind === "silent") throw new DOMException("timed out", "TimeoutError");
    if (kind === "refused")
      return Response.json({ data: { error_code: "E_ApiResponseCodes.API_EXCEPTION" } }, { status: 400 });
    const link = /https?:\/\/\S+/.exec(body.text_body)?.[0] ?? "";
    sends.push({
      to: body.to[0] ?? "",
      subject: body.subject,
      text: body.text_body,
      link,
      ...(body.html_body ? { html: body.html_body } : {}),
    });
    return Response.json({ data: { succeeded: 1, failed: 0, email_id: `email-${sends.length}` } });
  });
  return { sends, restore: () => spy.mockRestore() };
}

const context = () =>
  ({ waitUntil: () => {}, passThroughOnException: () => {}, props: {} }) as unknown as ExecutionContext;

// A request to the Worker as a browser on the app's origin would make it.
export function call(path: string, init: RequestInit = {}, workerEnv: Env = authEnv): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("origin")) headers.set("origin", ORIGIN);
  return Promise.resolve(
    worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" }), workerEnv, context()),
  );
}

export const requestLink = (email: string, callbackURL?: string, workerEnv: Env = authEnv) =>
  call(
    "/api/auth/sign-in/magic-link",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, ...(callbackURL === undefined ? {} : { callbackURL }) }),
    },
    workerEnv,
  );

// The emailed link as a path on the app (the tests' origin is the app's).
export const pathOf = (link: string) => {
  const url = new URL(link);
  return `${url.pathname}${url.search}`;
};

// A mailed sign-in link redeemed as a member's browser does (D07 T02 §10): the GET shows the confirm page, whose form
// the member submits. The fields are read from the page itself, so a page that lost them fails here.
export async function redeem(link: string, workerEnv: Env = authEnv): Promise<Response> {
  const shown = await call(pathOf(link), {}, workerEnv);
  if (shown.status !== 200) return shown;
  const html = await shown.text();
  const field = (name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";
  const decode = (value: string) =>
    value
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  const body = new URLSearchParams({ token: decode(field("token")), callbackURL: decode(field("callbackURL")) });
  return call("/signin/confirm", { method: "POST", body }, workerEnv);
}

// Where a redirect goes, as a path on the app: Better Auth answers with the app's own absolute URL.
export const target = (response: Response) => {
  const location = response.headers.get("location");
  if (location === null) return null;
  const url = new URL(location, ORIGIN);
  return url.origin === ORIGIN ? `${url.pathname}${url.search}` : location;
};

// The session cookie a response set, as a Cookie header value.
export const sessionCookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] as string)
    .filter((c) => c.includes("session_token"))
    .join("; ");

// A signed-in member: a link requested and redeemed; the session cookie and the user's id.
export async function signIn(email = "member@demo.isitlegit.co.za") {
  const smtp = stubSmtp2go();
  try {
    const asked = await requestLink(email);
    if (asked.status !== 200) throw new Error(`link request answered ${asked.status}`);
    const redeemed = await redeem(smtp.sends.at(-1)?.link ?? "");
    return { cookie: sessionCookie(redeemed), redeemed };
  } finally {
    smtp.restore();
  }
}
