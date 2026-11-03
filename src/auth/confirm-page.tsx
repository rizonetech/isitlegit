// The sign-in confirm page and its states (D07 T02 §10; design/SPEC.md A1), and the confirm link the mail carries,
// drawn on A1's frame (D07 T02 §7, src/web/pages/signin.tsx).
// Rendered without Better Auth, so the pages can be checked in a real browser (test/node/signin-confirm-browser.test.ts);
// the routes that serve them and redeem the token are ./confirm.
import { cx, FOCUS } from "../web/components/attrs";
import { Button } from "../web/components/Button";
import { Field } from "../web/components/Field";
import { LinkForm, PasskeyOption, PasskeyPrompt, SigninFrame, SigninState } from "../web/pages/signin";
import { DEFAULT_RETURN, sameSitePath } from "./paths";
import { CODE_PATH } from "./signin-code";

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

// How long until a limit lets the next try through, as a person reads it: whole minutes, a minute at least.
export const resumesIn = (seconds: number) => {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
};

const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
// A limit's retry, as the page carries it (D07 T02 §7): the moment it lifts, in epoch seconds for the app script (which
// holds the button until then, so without JavaScript an early press is simply refused again) and in SAST words.
export type Retry = { at: number; words: string };
export const retryIn = (seconds: number, now = Date.now()): Retry => {
  const at = Math.ceil(now / 1000 + Math.max(1, seconds));
  return { at, words: clock.format(at * 1000) };
};
const held = (retry: Retry | undefined, ready: string) =>
  retry ? { "data-retry-at": String(retry.at), "data-ready-label": ready } : {};

const LINK = cx("self-start text-orange-text underline underline-offset-4", FOCUS);

// The confirm step; `retry` is its rate-limited state (A1's): too many tries from here, the same link still good, and
// the same button presses it again once the limit lifts (D07 T02 §6: the limiter's own retry time).
export function ConfirmPage(props: { token: string; callbackURL: string; retry?: Retry; elsewhere?: boolean }) {
  const { retry } = props;
  // A link asked for on another device (D07 T02 §12): the member is pointed back to it and its code, and signing in here
  // stays one deliberate, secondary choice. The page the asking browser sees is unchanged.
  if (props.elsewhere && !retry)
    return (
      <SigninFrame title="Sign in">
        <SigninState
          heading="Finish in the browser where you asked"
          text="You asked for this link in another browser. Go back to it and type the 6-digit code from the same email: it signs that browser in. Or sign in in this browser instead."
        >
          <form method="post" action={CONFIRM_PATH} class="flex flex-col gap-16" data-busy>
            <input type="hidden" name="token" value={props.token} />
            <input type="hidden" name="callbackURL" value={props.callbackURL} />
            <Button type="submit" variant="ghost" data-busy-label="Signing in…">
              Sign in in this browser instead
            </Button>
          </form>
        </SigninState>
      </SigninFrame>
    );
  return (
    <SigninFrame title="Sign in">
      <SigninState
        {...(retry ? { tile: "stop" as const } : {})}
        heading={retry ? "Too many sign-in tries" : "Sign in to IsItLegit"}
        text={
          retry
            ? `Too many sign-in tries from here. You can press the button again at ${retry.words} SAST. A link works for 15 minutes from when it was sent; if yours has run out by then, ask for a new one below.`
            : "Press the button to finish signing in. The link works once."
        }
        alert={retry !== undefined}
      >
        <form method="post" action={CONFIRM_PATH} class="flex flex-col gap-16" data-busy>
          <input type="hidden" name="token" value={props.token} />
          <input type="hidden" name="callbackURL" value={props.callbackURL} />
          <Button
            type="submit"
            variant="primary"
            data-busy-label="Signing in…"
            {...held(retry, "Sign in to IsItLegit")}
          >
            {retry ? `Sign in to IsItLegit at ${retry.words}` : "Sign in to IsItLegit"}
          </Button>
        </form>
        {retry ? (
          <a class={LINK} href={`${LINK_PATH}?${new URLSearchParams({ callbackURL: props.callbackURL })}`}>
            Get a new sign-in link
          </a>
        ) : null}
      </SigninState>
    </SigninFrame>
  );
}

// A form that asks for a new sign-in link, keeping the return path and any address already given. It is every
// recovery: A1's "link expired or used" state, a sign-in that did not finish, a send that failed, and "Use a different
// email" from the inbox state. `retry` is the rate-limited state: the same address and return path go again, once.
export type LinkRequestProps = {
  callbackURL: string;
  title?: string;
  heading?: string;
  text?: string;
  email?: string;
  error?: string;
  retry?: Retry;
};

export function LinkRequestPage(props: LinkRequestProps) {
  const { retry } = props;
  if (retry)
    return (
      <SigninFrame title={props.title ?? "Too many sign-in links"}>
        <SigninState
          tile="stop"
          heading={props.heading ?? "Too many sign-in links from here"}
          text={`New links can be sent from here again at ${retry.words} SAST. The latest link you received still works until it runs out.`}
          alert
        >
          <form method="post" action={LINK_PATH} class="flex flex-col gap-16" data-busy>
            <input type="hidden" name="callbackURL" value={props.callbackURL} />
            <input type="hidden" name="email" value={props.email ?? ""} />
            <Button type="submit" variant="ghost" data-busy-label="Sending…" {...held(retry, "Send another link")}>
              {`Send another link at ${retry.words}`}
            </Button>
          </form>
          <PasskeyOption next={props.callbackURL} />
        </SigninState>
        <PasskeyPrompt />
      </SigninFrame>
    );
  return (
    <SigninFrame title={props.title ?? "Link expired or used"}>
      <SigninState
        tile="clock"
        heading={props.heading ?? "That link no longer works"}
        text={
          props.text ??
          "Sign-in links work once and only for 15 minutes, so a forwarded or old link cannot be used by someone else."
        }
      >
        <LinkForm
          next={props.callbackURL}
          button="Email me a new link"
          {...(props.email ? { email: props.email } : {})}
          {...(props.error ? { error: props.error } : {})}
        />
      </SigninState>
    </SigninFrame>
  );
}

// A1's "check your inbox" state: the neutral answer (a Deviation in design/SPEC.md A1: the board names the address a
// link went to, which would tell a stranger who can sign in), the code from the mail (D07 T02 §11: it signs in this
// browser, the one that asked), then Send another link (the same address again) and Use a different email (the
// request form with this address to correct). A refused code comes back here with its message tied to the field;
// `retry` holds Sign in until a rate limit lifts. The page waits for the sign-in to finish in another tab (the app
// script, D07 T02 §7) for this address only (`data-signin-wait`).
export type InboxProps = { email: string; callbackURL: string; codeError?: string; retry?: Retry; code?: string };
// Send another link waits this long after the page is shown, the same for every answer (it says nothing about the
// address): a link is usually there in under a minute, and each press spends one of the address's five links (D07 T02
// §7, completion review). Code entry is never held by it.
const RESEND_WAIT_SECONDS = 30;

export function InboxPage(props: InboxProps) {
  return (
    <SigninFrame title="Check your inbox">
      <div data-signin-wait={props.email} data-signin-next={props.callbackURL} class="contents">
        <SigninState
          tile="mail"
          heading="Check your inbox"
          text="If that address can sign in, a new link is on its way. It works once, for 15 minutes."
        >
          <form method="post" action={CODE_PATH} class="flex flex-col gap-16" data-busy>
            <input type="hidden" name="email" value={props.email} />
            <input type="hidden" name="callbackURL" value={props.callbackURL} />
            <Field
              id="signin-code"
              label="Code from the email"
              name="code"
              hint="Reading the mail on another device? Type its 6-digit code here to sign in on this one."
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength={16}
              autofocus
              required
              {...(props.code ? { value: props.code } : {})}
              {...(props.codeError ? { error: props.codeError } : {})}
            />
            <Button type="submit" variant="primary" data-busy-label="Signing in…" {...held(props.retry, "Sign in")}>
              {props.retry ? `Sign in at ${props.retry.words}` : "Sign in"}
            </Button>
          </form>
          <p class="text-14 text-muted">
            Not there after a minute? Look in junk mail. The email comes from IsItLegit with the subject "Your IsItLegit
            sign-in link".
          </p>
          <form method="post" action={LINK_PATH} data-busy>
            <input type="hidden" name="email" value={props.email} />
            <input type="hidden" name="callbackURL" value={props.callbackURL} />
            <Button
              type="submit"
              variant="ghost"
              class="w-full"
              data-busy-label="Sending…"
              {...held(retryIn(RESEND_WAIT_SECONDS), "Send another link")}
            >
              Send another link in 30 seconds
            </Button>
          </form>
          <a
            class={LINK}
            href={`${LINK_PATH}?${new URLSearchParams({ email: props.email, callbackURL: props.callbackURL })}`}
          >
            Use a different email
          </a>
          <p role="status" aria-live="polite" data-signin-status class="sr-only" />
        </SigninState>
      </div>
    </SigninFrame>
  );
}

// A page that only says what happened and what to do, with no form.
// The check of where a link was asked for failed (the database could not be read): nothing was used or decided, and the
// same link, with its destination, is tried again from here.
export function LinkCheckFailedPage(props: { token: string; callbackURL: string }) {
  return (
    <SigninFrame title="Sign in">
      <SigninState
        tile="stop"
        heading="We could not check this link just now"
        text="Nothing has been used. Try again in a moment: the same link still works."
        alert
      >
        <a
          class={LINK}
          href={`${CONFIRM_PATH}?${new URLSearchParams({ token: props.token, callbackURL: props.callbackURL })}`}
        >
          Try again
        </a>
      </SigninState>
    </SigninFrame>
  );
}

export function MessagePage(props: { title: string; heading: string; text: string }) {
  return (
    <SigninFrame title={props.title}>
      <SigninState tile="stop" heading={props.heading} text={props.text} />
    </SigninFrame>
  );
}

// A page as the answer: the rendered document with the page headers above.
export const pageResponse = async (body: unknown, status = 200) =>
  new Response(String(await (body as Promise<string> | string)), { status, headers: PAGE_HEADERS });
