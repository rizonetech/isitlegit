// The sign-in confirm page and its states (D07 T02 §10; design/SPEC.md A1), and the confirm link the mail carries.
// Rendered without Better Auth, so the pages can be checked in a real browser (test/node/signin-confirm-browser.test.ts);
// the routes that serve them and redeem the token are ./confirm.
import { Button } from "../web/components/Button";
import { Document } from "../web/components/Document";
import { Field } from "../web/components/Field";
import { DEFAULT_RETURN, sameSitePath } from "./paths";

export const CONFIRM_PATH = "/signin/confirm";
export const LINK_PATH = "/signin/link";

// A return path on this site only; anything else lands on the default.
export const returnPath = (value: unknown) => (sameSitePath(value) ? value : DEFAULT_RETURN);

// The confirm page's URL for a token and return path, on the app's own origin.
export function confirmUrl(appUrl: string, token: string, callbackURL: unknown): string {
  const url = new URL(CONFIRM_PATH, new URL(appUrl).origin);
  url.searchParams.set("token", token);
  url.searchParams.set("callbackURL", returnPath(callbackURL));
  return url.toString();
}

// The link Better Auth hands `sendMagicLink` (its own verify URL), rewritten to the confirm page with the same token and
// return path, so the mail never carries a URL that signs in on GET.
export function mailedLink(appUrl: string, verifyUrl: string, token: string): string {
  return confirmUrl(appUrl, token, new URL(verifyUrl).searchParams.get("callbackURL"));
}

// `same-origin`, not `no-referrer`: a form POST from a no-referrer page carries `Origin: null`, which the origin check
// refuses (Fetch Standard, "append a request Origin header"). The page loads nothing from another origin, so the token
// in its URL is sent to no one else.
export const PAGE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "same-origin",
  "x-robots-tag": "noindex",
  "content-type": "text/html; charset=utf-8",
};

function Frame(props: { title: string; children: unknown }) {
  return (
    <Document title={props.title}>
      <main class="min-h-screen flex items-center justify-center px-16 py-48">
        <div class="w-full max-w-440 flex flex-col gap-24">{props.children as never}</div>
      </main>
    </Document>
  );
}

// How long until a limit lets the next try through, as a person reads it: whole minutes, a minute at least.
export const resumesIn = (seconds: number) => {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
};

// The confirm step; `retryAfter` is its rate-limited state (A1's): too many tries from here, the same link still good,
// with the time it works again (D07 T02 §6: the limiter's own retry time).
export function ConfirmPage(props: { token: string; callbackURL: string; retryAfter?: number }) {
  return (
    <Frame title="Sign in">
      <h1 class="font-display text-28 weight-display">Sign in to IsItLegit</h1>
      <p class="text-16 text-muted">
        {props.retryAfter !== undefined
          ? `Too many sign-in tries from here. Wait ${resumesIn(props.retryAfter)}, then press the button again. A link works for 15 minutes from when it was sent; if yours has run out by then, ask for a new one below.`
          : "Press the button to finish signing in. The link works once."}
      </p>
      <form method="post" action={CONFIRM_PATH} class="flex flex-col gap-16">
        <input type="hidden" name="token" value={props.token} />
        <input type="hidden" name="callbackURL" value={props.callbackURL} />
        <Button type="submit" variant="primary">
          Sign in to IsItLegit
        </Button>
      </form>
      {props.retryAfter !== undefined ? (
        <a class="text-16" href={`${LINK_PATH}?${new URLSearchParams({ callbackURL: props.callbackURL })}`}>
          Get a new sign-in link
        </a>
      ) : null}
    </Frame>
  );
}

// A form that asks for a new sign-in link, keeping the return path and any address already given. It is every
// recovery: A1's "link expired or used" state, a sign-in that did not finish, a send that failed, and "Use a different
// email" from the inbox state.
export type LinkRequestProps = {
  callbackURL: string;
  title?: string;
  heading?: string;
  text?: string;
  email?: string;
  error?: string;
};

export function LinkRequestPage(props: LinkRequestProps) {
  return (
    <Frame title={props.title ?? "Link expired or used"}>
      <h1 class="font-display text-28 weight-display">{props.heading ?? "This link has expired or was used"}</h1>
      <p class="text-16 text-muted">
        {props.text ?? "Sign-in links work once, for 15 minutes. Enter your email for a new one."}
      </p>
      <form method="post" action={LINK_PATH} class="flex flex-col gap-16">
        <input type="hidden" name="callbackURL" value={props.callbackURL} />
        <Field
          id="signin-email"
          label="Email"
          name="email"
          type="email"
          autocomplete="email"
          inputmode="email"
          required
          {...(props.email ? { value: props.email } : {})}
          {...(props.error ? { error: props.error } : {})}
        />
        <Button type="submit" variant="primary">
          Email me a new link
        </Button>
      </form>
    </Frame>
  );
}

// A1's "check your inbox" state: the neutral answer, then Send another link (the same address again) and Use a
// different email (the request form with this address to correct).
export function InboxPage(props: { email: string; callbackURL: string }) {
  return (
    <Frame title="Check your inbox">
      <h1 class="font-display text-28 weight-display">Check your inbox</h1>
      <p class="text-16 text-muted">
        If that address can sign in, a new link is on its way. It works once, for 15 minutes.
      </p>
      <form method="post" action={LINK_PATH}>
        <input type="hidden" name="email" value={props.email} />
        <input type="hidden" name="callbackURL" value={props.callbackURL} />
        <Button type="submit" variant="primary">
          Send another link
        </Button>
      </form>
      <form method="get" action={LINK_PATH}>
        <input type="hidden" name="email" value={props.email} />
        <input type="hidden" name="callbackURL" value={props.callbackURL} />
        <Button type="submit" variant="ghost">
          Use a different email
        </Button>
      </form>
    </Frame>
  );
}

// A page that only says what happened and what to do, with no form.
export function MessagePage(props: { title: string; heading: string; text: string }) {
  return (
    <Frame title={props.title}>
      <h1 class="font-display text-28 weight-display">{props.heading}</h1>
      <p class="text-16 text-muted">{props.text}</p>
    </Frame>
  );
}

// A page as the answer: the rendered document with the page headers above.
export const pageResponse = async (body: unknown, status = 200) =>
  new Response(String(await (body as Promise<string> | string)), { status, headers: PAGE_HEADERS });
