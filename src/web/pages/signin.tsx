// The sign-in page and A1's frame (D07 T02 §7; design/SPEC.md A1, boards `Signin` and `Signin-States`). `SigninFrame`
// is A1's split frame: from `md` a dark brand panel beside a centred column, below `md` the column alone under the
// logo. `SigninState` is one of the right-hand panel's states (an icon tile, a heading, its sentence, its actions);
// the confirm step's and the link request's states (src/auth/confirm-page.tsx) are drawn with it. `SigninPage` is
// `/signin`: the email form, or a used or expired link's state when the session gate sent the member back with an
// `error` (src/auth/auth.ts `recoveryPath`). Every form carries `next`, already validated where the page is served.
import type { Child } from "hono/jsx";
import { LOGO, LOGO_MARK_ON_DARK, LOGO_ON_DARK } from "../assets";
import { cx, FOCUS } from "../components/attrs";
import { Button } from "../components/Button";
import { Document } from "../components/Document";
import { Field } from "../components/Field";
import { ClockIcon, KeyIcon, MailIcon, StopIcon } from "../components/icons";

export const SIGNIN_PATH = "/signin";
// The public site the logo goes home to (board `Signin`'s "IsItLegit home"), as the app shell's footer links it.
const HOME = "https://isitlegit.co.za";
const LINK_PATH = "/signin/link";
const LINK = cx("text-orange-text underline underline-offset-4", FOCUS);

export function SigninFrame(props: { title: string; children: Child }) {
  return (
    <Document title={props.title}>
      <div class="min-h-screen grid md:grid-cols-2">
        <aside
          aria-label="IsItLegit"
          class="hidden md:flex flex-col justify-between gap-48 bg-dark text-on-dark px-80 py-64"
        >
          <a href={HOME} class={cx("self-start rounded-small", FOCUS)}>
            <img src={LOGO_ON_DARK} alt="IsItLegit home" class="h-28" />
          </a>
          <div class="flex flex-col gap-24">
            <img src={LOGO_MARK_ON_DARK} alt="" class="w-72 h-72" />
            <p class="type-h1 max-w-signin-headline">Every suspicious email, investigated. Every reason, cited.</p>
            <p class="text-18 text-on-dark-soft">
              Sign in to see your cases, protect your business name and keep your supplier list honest.
            </p>
          </div>
          <p class="text-14 text-on-dark-muted">IsItLegit by Rizonetech · George, South Africa</p>
        </aside>
        <main id="content" class="flex flex-col px-16 py-24 md:px-80 md:py-64 md:justify-center">
          <a href={HOME} class={cx("md:hidden self-start mb-40 rounded-small", FOCUS)}>
            <img src={LOGO} alt="IsItLegit home" class="h-24" />
          </a>
          <div class="w-full max-w-signin-column flex flex-col gap-24 md:mx-auto">{props.children}</div>
        </main>
      </div>
    </Document>
  );
}

const TILES = {
  mail: { icon: MailIcon, tone: "bg-orange-wash text-orange-text" },
  clock: { icon: ClockIcon, tone: "bg-sus-wash text-sus" },
  stop: { icon: StopIcon, tone: "bg-mal-wash text-mal" },
  key: { icon: KeyIcon, tone: "bg-subtle text-ink" },
} as const;
export type Tile = keyof typeof TILES;

// One of A1's states: its tile, heading and sentence, then the state's own forms and links. A state a member did not
// navigate to (a refusal drawn in place) is announced (`alert`); a page they arrived at is read from its heading.
export function SigninState(props: { tile?: Tile; heading: string; text: Child; alert?: boolean; children?: Child }) {
  const tile = props.tile ? TILES[props.tile] : null;
  return (
    <section class="flex flex-col gap-24">
      {tile && (
        <span class={cx("inline-flex items-center justify-center w-56 h-56 rounded-card", tile.tone)}>
          <tile.icon class="w-24 h-24" />
        </span>
      )}
      <div class="flex flex-col gap-12" {...(props.alert ? { role: "alert" } : {})}>
        <h1 class="type-h2 wrap-anywhere">{props.heading}</h1>
        <p class="text-16 text-muted">{props.text}</p>
      </div>
      {props.children}
    </section>
  );
}

// The email form: the address and where to return, then the request.
export function LinkForm(props: { next: string; email?: string; error?: string; button: string; autofocus?: boolean }) {
  return (
    <form method="post" action={LINK_PATH} class="flex flex-col gap-16" data-busy>
      <input type="hidden" name="callbackURL" value={props.next} />
      <Field
        id="signin-email"
        label="Work email"
        name="email"
        type="email"
        autocomplete="email"
        inputmode="email"
        placeholder="you@yourbusiness.co.za"
        required
        {...(props.autofocus ? { autofocus: true } : {})}
        {...(props.email ? { value: props.email } : {})}
        {...(props.error ? { error: props.error } : {})}
      />
      <Button type="submit" variant="primary" data-busy-label="Sending…">
        {props.button}
      </Button>
    </form>
  );
}

// Why a link brought the member back here, in plain words: Better Auth's magic-link codes, any other as the generic.
const LINK_ERRORS: Record<string, string> = {
  INVALID_TOKEN:
    "Sign-in links work once and only for 15 minutes, so a forwarded or old link cannot be used by someone else.",
  EXPIRED_TOKEN: "Sign-in links work for 15 minutes, and this one has run out.",
  ATTEMPTS_EXCEEDED: "This link was tried too many times, so it no longer works.",
};
// Only the map's own codes: a name like `constructor` or `__proto__` from the address is no code of ours.
export const linkErrorText = (code: string) =>
  (Object.hasOwn(LINK_ERRORS, code) ? LINK_ERRORS[code] : undefined) ??
  "This sign-in link did not work. Ask for a new one below.";

export function SigninPage(props: { next: string; error?: string | null }) {
  if (props.error)
    return (
      <SigninFrame title="That link no longer works">
        <SigninState tile="clock" heading="That link no longer works" text={linkErrorText(props.error)} alert>
          <LinkForm next={props.next} button="Email me a new link" autofocus />
        </SigninState>
      </SigninFrame>
    );
  return (
    <SigninFrame title="Sign in">
      <SigninState heading="Sign in" text="We send a one-time link to your email. No password to remember or steal.">
        <LinkForm next={props.next} button="Email me a sign-in link" />
        <p class="text-14 text-muted">
          New here? You need an invite code during the launch.{" "}
          <a href="/signup" class={LINK}>
            Create an account
          </a>
        </p>
      </SigninState>
    </SigninFrame>
  );
}
