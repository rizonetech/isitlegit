// The Account page (D07 T08 §3; design/SPEC.md M9, board `Account`): the member's own sign-in details. Name with Save,
// the email as read-only text, the passkeys and the sessions as stored. Removing and renaming are D07 T08 §13 and §14,
// which draw their controls into these rows. For a member with no organisation the page has its own frame, since the
// member shell needs one.

import { LOGO, LOGO_ON_DARK } from "../assets";
import { AppShell, type MemberShellProps } from "../components/AppShell";
import { cx, FOCUS } from "../components/attrs";
import { Button } from "../components/Button";
import { Document } from "../components/Document";
import { Field } from "../components/Field";

export type AccountPasskey = { id: string; name: string; addedAt: string | null; deviceType: string };
export type AccountSession = { id: string; device: string; current: boolean; signedInAt: string; lastActiveAt: string };

export const OUTCOMES = ["saved", "failed", "refused"] as const;
export type Outcome = { r: (typeof OUTCOMES)[number] };

const SAST_OFFSET_MS = 2 * 60 * 60_000;
const sastDay = (ms: number) => Math.floor((ms + SAST_OFFSET_MS) / 86_400_000);
const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const dayFmt = (year: boolean) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Johannesburg",
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(year ? { year: "numeric" } : {}),
  });
// "12 Oct 2026": a date in SAST.
export function dateText(iso: string | null): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return "Unknown";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Johannesburg",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(at);
}
// "Now", "Today 08:41", "Sat 25 Oct, 19:10": when a session was last active.
export function activeText(iso: string, now: Date): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "Unknown";
  if (now.getTime() - at < 5 * 60_000) return "Now";
  const days = sastDay(now.getTime()) - sastDay(at);
  if (days === 0) return `Today ${clock.format(at)}`;
  const sameYear =
    new Date(at + SAST_OFFSET_MS).getUTCFullYear() === new Date(now.getTime() + SAST_OFFSET_MS).getUTCFullYear();
  return `${dayFmt(!sameYear).format(at).replace(",", "")}, ${clock.format(at)}`;
}

// A user-agent string as "Edge on Windows": the browser and the system, or "Unknown device". Words only; the string
// itself never reaches the page.
export function deviceOf(userAgent: string | null): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  const system = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad|iOS/.test(ua)
        ? "iPhone"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? "Unknown device";
}

const DEVICE_WORDS: Record<string, string> = { singleDevice: "This device only", multiDevice: "Syncs between devices" };
const outcomeText = (o: Outcome) =>
  o.r === "saved"
    ? { text: "Name saved.", tone: "done" as const }
    : o.r === "failed"
      ? {
          text: "The change could not be confirmed. The name below is as stored now; try again if it is not what you asked.",
          tone: "refused" as const,
        }
      : { text: "Nothing was changed: that request is not one this page sends.", tone: "refused" as const };

const CARD = "bg-surface border border-line rounded-card-large p-24";

export type AccountProps = {
  user: { name: string; email: string };
  passkeys: AccountPasskey[];
  sessions: AccountSession[];
  outcome: Outcome | null;
  // The name as typed after a refusal, with why.
  draft?: { name: string; error: string } | undefined;
  now: Date;
};

function AccountBody(props: AccountProps) {
  const { user, passkeys, sessions, outcome, draft, now } = props;
  const said = outcome ? outcomeText(outcome) : null;
  return (
    <div id="account-main" class="flex flex-col gap-24 px-16 py-24 md:px-56 md:py-40">
      <header class="flex flex-col gap-4 min-w-0">
        <h1 class="type-h1">Account</h1>
        <p class="type-small text-muted">Your sign-in details.</p>
      </header>
      <p id="account-outcome" role="status" class={cx("type-small", said ? "" : "sr-only")}>
        {said && <span class={said.tone === "refused" ? "text-mal weight-text-strong" : "text-ink"}>{said.text}</span>}
      </p>
      <section aria-labelledby="profile-heading" class={cx(CARD, "flex flex-col gap-12")}>
        <h2 id="profile-heading" class="type-h3">
          Profile
        </h2>
        <form
          method="post"
          action="/settings/account"
          class="flex flex-col gap-12 max-w-[520px]"
          data-busy
          data-announce-scope
        >
          <input type="hidden" name="action" value="name" />
          <Field
            id="account-name"
            name="name"
            label="Name"
            value={draft?.name ?? user.name}
            {...(draft?.error ? { error: draft.error } : {})}
            autocomplete="name"
            required
          />
          <div class="flex flex-col gap-4">
            <span class="type-small weight-text-strong">Email</span>
            <p id="account-email" class="wrap-anywhere">
              {user.email}
            </p>
            <p class="type-small text-muted">Your email address cannot be changed during the launch.</p>
          </div>
          <div>
            <Button type="submit" variant="dark" data-busy-label="Saving…">
              Save
            </Button>
          </div>
        </form>
      </section>
      <section aria-labelledby="passkeys-heading" class={cx(CARD, "flex flex-col gap-12")}>
        <h2 id="passkeys-heading" class="type-h3">
          Passkeys
        </h2>
        <p class="type-small text-muted">Sign in with your fingerprint, face or device PIN. Nothing to phish.</p>
        {passkeys.length === 0 ? (
          <p id="passkeys-empty" class="type-small text-muted">
            No passkeys yet. You sign in with an email link.
          </p>
        ) : (
          <ul class="flex flex-col border-t border-line">
            {passkeys.map((k) => (
              <li class="flex flex-col gap-4 py-12 border-b border-line last:border-b-0" data-passkey-row={k.id}>
                <span class="weight-text-strong wrap-anywhere">{k.name}</span>
                <span class="type-small text-muted">
                  Added {dateText(k.addedAt)} · {DEVICE_WORDS[k.deviceType] ?? "Passkey"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="sessions-heading" class={cx(CARD, "flex flex-col gap-12")}>
        <h2 id="sessions-heading" class="type-h3">
          Where you are signed in
        </h2>
        <p class="type-small text-muted">Sign out anything you do not recognise.</p>
        <ul class="flex flex-col border-t border-line">
          {sessions.map((s) => (
            <li class="flex flex-col gap-4 py-12 border-b border-line last:border-b-0" data-session-row={s.id}>
              <span class="weight-text-strong wrap-anywhere">
                {s.device}
                {s.current && " (this device)"}
              </span>
              <span class="type-small text-muted">
                Signed in {dateText(s.signedInAt)} · Last active {activeText(s.lastActiveAt, now)}
              </span>
            </li>
          ))}
        </ul>
        {sessions.length <= 1 && (
          <p id="sessions-only" class="type-small text-muted">
            This is your only session.
          </p>
        )}
      </section>
      <div>
        <form method="post" action="/auth/sign-out">
          <Button type="submit" variant="ghost">
            Sign out
          </Button>
        </form>
      </div>
    </div>
  );
}

export function AccountPage(props: AccountProps & { shell: Omit<MemberShellProps, "children"> | null }) {
  const { shell, ...body } = props;
  return (
    <Document title="Account">
      {shell ? (
        <AppShell {...shell}>
          <AccountBody {...body} />
        </AppShell>
      ) : (
        // A member with no organisation: the account is theirs, so the page still opens, in its own small frame.
        <>
          <a href="#content" class="sr-only focus:not-sr-only">
            Skip to content
          </a>
          <header class="flex items-center justify-between min-h-72 px-16 py-12 md:px-56 border-b border-line bg-surface">
            <a href="/" class={cx("rounded-small", FOCUS)}>
              <img src={LOGO} alt="IsItLegit" class="block h-28 dark:hidden" />
              <img src={LOGO_ON_DARK} alt="IsItLegit" class="hidden h-28 dark:block" />
            </a>
          </header>
          <main id="content">
            <AccountBody {...body} />
          </main>
        </>
      )}
    </Document>
  );
}
