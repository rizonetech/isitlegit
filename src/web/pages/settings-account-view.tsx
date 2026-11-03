// The Account page (D07 T08 §3; design/SPEC.md M9, board `Account`): the member's own sign-in details. Name with Save,
// the email as read-only text, the passkeys and the sessions as stored. Removing and renaming are D07 T08 §13 and §14,
// which draw their controls into these rows. For a member with no organisation the page has its own frame, since the
// member shell needs one.

import { LOGO, LOGO_ON_DARK } from "../assets";
import { AppShell, type MemberShellProps } from "../components/AppShell";
import { cx, FOCUS } from "../components/attrs";
import { Button, buttonClass } from "../components/Button";
import { Document } from "../components/Document";
import { Field } from "../components/Field";
import { Pill } from "../components/Pill";

export type AccountPasskey = {
  id: string;
  // The credential the device made for it, which a lost add is told by.
  credentialId?: string;
  name: string;
  addedAt: string | null;
  deviceType: string;
};
export type AccountSession = { id: string; device: string; current: boolean; signedInAt: string; lastActiveAt: string };

export const OUTCOMES = [
  "saved",
  "failed",
  "refused",
  "passkey-removed",
  "session-out",
  "others-out",
  "gone",
  "this-device",
  "partial",
  "unresolved",
  "passkey-still",
  "session-still",
  "others-none",
  "passkey-renamed",
  "rename-still",
  "weekly-on",
  "weekly-off",
] as const;
export type Outcome = { r: (typeof OUTCOMES)[number]; name?: string };

const SAST_OFFSET_MS = 2 * 60 * 60_000;
const sastDay = (ms: number) => Math.floor((ms + SAST_OFFSET_MS) / 86_400_000);
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
// "Today", "Yesterday" or "Sun 25 Oct": when a session was last active, to the day. Better Auth renews a session's
// timestamp at most once a day, not on each request, so a time of day would claim more than is known (design/SPEC.md M9).
export function activeText(iso: string, now: Date): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "Unknown";
  const days = sastDay(now.getTime()) - sastDay(at);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const sameYear =
    new Date(at + SAST_OFFSET_MS).getUTCFullYear() === new Date(now.getTime() + SAST_OFFSET_MS).getUTCFullYear();
  return dayFmt(!sameYear).format(at).replace(",", "");
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
const SAID: Record<string, { text: string; tone: "done" | "refused" }> = {
  "passkey-removed": {
    text: "Passkey removed. It may still be listed in your device's password manager: remove it there too. Sessions you are signed in on are separate.",
    tone: "done",
  },
  "session-out": { text: "That session was signed out.", tone: "done" },
  "weekly-on": { text: "Weekly counts on. They arrive on Fridays for this organisation.", tone: "done" },
  "weekly-off": { text: "Weekly counts off for this organisation.", tone: "done" },
  "others-out": { text: "Every other session was signed out.", tone: "done" },
  gone: { text: "That is no longer on your account. The lists below are as stored now.", tone: "refused" },
  "this-device": {
    text: "That is the session you are using. Use Sign out at the bottom of the page to end it.",
    tone: "refused",
  },
  "passkey-still": {
    text: "That passkey was not removed: it is still on your account. Press Remove on it to try again.",
    tone: "refused",
  },
  "session-still": {
    text: "That session was not signed out: it is still signed in. Press Sign out on it to try again.",
    tone: "refused",
  },
  "others-none": {
    text: "No other session was signed out; they are all still signed in. Press Sign out other sessions to try again.",
    tone: "refused",
  },
  "passkey-renamed": { text: "Passkey renamed.", tone: "done" },
  partial: {
    text: "Some sessions were signed out and some are still open. The list below is as stored now: sign out the rest again.",
    tone: "refused",
  },
  unresolved: {
    text: "We could not confirm what was saved. Reload this page to see the lists as stored before you try again.",
    tone: "refused",
  },
};
const outcomeText = (o: Outcome, stored: string) =>
  (o.r === "rename-still"
    ? {
        text: `That passkey was not renamed: it is still named "${o.name ?? ""}". Press Rename on it to try again.`,
        tone: "refused" as const,
      }
    : null) ??
  SAID[o.r] ??
  (o.r === "saved"
    ? { text: "Name saved.", tone: "done" as const }
    : o.r === "failed"
      ? {
          text: `The change could not be confirmed. Your saved name is still "${stored}"; the field keeps what you typed, so press Save to try again.`,
          tone: "refused" as const,
        }
      : { text: "Nothing was changed: that request is not one this page sends.", tone: "refused" as const });

// A text action in a row, named for what it acts on (the same word repeats down a table).
function RowLink(props: { href: string; label: string; children: string; danger?: boolean }) {
  return (
    <a href={props.href} aria-label={props.label} class={buttonClass(props.danger ? "danger" : "ghost", "small")}>
      {props.children}
    </a>
  );
}

// The confirmation a removal or a sign-out asks first, with or without JavaScript: what it does and what it leaves.
export function AccountConfirm(props: {
  shell: Omit<MemberShellProps, "children"> | null;
  title: string;
  lines: string[];
  action: string;
  id: string;
  label: string;
  // A neighbouring action the member needs here (the passkey removal's Sign out other sessions).
  extra?: { href: string; label: string };
}) {
  const body = (
    <div class="flex flex-col gap-24 px-16 py-24 md:px-56 md:py-40 max-w-[640px]">
      <h1 id="confirm-title" tabindex={-1} data-announce="" class="type-h1 wrap-anywhere">
        {props.title}
      </h1>
      {props.lines.map((line) => (
        <p class="text-16 wrap-anywhere">{line}</p>
      ))}
      <form
        method="post"
        action="/settings/account"
        class="flex flex-wrap gap-12"
        data-busy
        data-busy-check="/settings/account"
      >
        <input type="hidden" name="action" value={props.action} />
        <input type="hidden" name="id" value={props.id} />
        <Button type="submit" variant="danger" data-busy-label="Working…">
          {props.label}
        </Button>
        <Button variant="ghost" href="/settings/account">
          Cancel
        </Button>
      </form>
      {props.extra && (
        <p class="type-small">
          <a class="underline text-orange-text" href={props.extra.href}>
            {props.extra.label}
          </a>
        </p>
      )}
    </div>
  );
  return (
    <Document title={props.title}>
      {props.shell ? <AppShell {...props.shell}>{body}</AppShell> : <main id="content">{body}</main>}
    </Document>
  );
}

// The page that names a passkey: opened from a row's Rename, and straight after an add (`added`), with or without
// JavaScript. Cancel (or, after an add, keeping the name it has) goes back to the Account page.
export function PasskeyRename(props: {
  shell: Omit<MemberShellProps, "children"> | null;
  id: string;
  name: string;
  added: boolean;
  draft?: { name: string; error: string } | undefined;
}) {
  const title = props.added ? "Name your new passkey" : "Rename passkey";
  const body = (
    <div class="flex flex-col gap-24 px-16 py-24 md:px-56 md:py-40 max-w-[640px]">
      <h1
        id="rename-title"
        tabindex={-1}
        {...(props.draft?.error ? {} : { "data-announce": "" })}
        class="type-h1 wrap-anywhere"
      >
        {title}
      </h1>
      {props.added && (
        <p class="text-16">Passkey added. Give it a name you will recognise, such as the device it lives on.</p>
      )}
      <form
        method="post"
        action="/settings/account"
        class="flex flex-col gap-16"
        data-busy
        data-busy-check="/settings/account"
        data-announce-scope
      >
        <input type="hidden" name="action" value="rename-passkey" />
        <input type="hidden" name="id" value={props.id} />
        <Field
          id="passkey-name"
          name="name"
          label="Passkey name"
          hint="One line, up to 100 characters."
          value={props.draft?.name ?? props.name}
          {...(props.draft?.error ? { error: props.draft.error } : {})}
          autocomplete="off"
          required
        />
        <div class="flex flex-wrap gap-12">
          <Button type="submit" variant="dark" data-busy-label="Saving…">
            Save name
          </Button>
          <Button variant="ghost" href="/settings/account">
            {props.added ? "Keep this name" : "Cancel"}
          </Button>
        </div>
      </form>
    </div>
  );
  return (
    <Document title={title}>
      {props.shell ? <AppShell {...props.shell}>{body}</AppShell> : <main id="content">{body}</main>}
    </Document>
  );
}

const CARD = "bg-surface border border-line rounded-card-large p-24";

export type AccountProps = {
  user: { name: string; email: string };
  // The Friday weekly counts for the active organisation (D07 T04 §20): when the member opted in, if they did.
  weekly?: { orgId: string; orgName: string; optedInAt: string | null } | undefined;
  passkeys: AccountPasskey[];
  sessions: AccountSession[];
  outcome: Outcome | null;
  // The name as typed after a refusal, with why.
  draft?: { name: string; error: string } | undefined;
  // A passkey add whose answer was lost, read back: the one that was saved (to name it) or none (to try again).
  reconcile?: { kind: "added"; id: string; name: string } | { kind: "none"; cred: string } | undefined;
  now: Date;
};

function AccountBody(props: AccountProps) {
  const { user, passkeys, sessions, outcome, draft, reconcile, now } = props;
  const said = outcome ? outcomeText(outcome, user.name) : null;
  const lost =
    reconcile?.kind === "added"
      ? "Your passkey was saved, but we did not get the answer. Give it a name you will recognise."
      : reconcile?.kind === "none"
        ? "We could not find a passkey from that attempt yet. It may still be saving, so check again in a few seconds before you add another."
        : null;
  return (
    <div id="account-main" class="flex flex-col gap-24 px-16 py-24 md:px-56 md:py-40">
      <header class="flex flex-col gap-4 min-w-0">
        <h1 class="type-h1">Account</h1>
        <p class="type-small text-muted">Your sign-in details.</p>
      </header>
      <p
        id="account-outcome"
        role={said?.tone === "refused" ? "alert" : "status"}
        class={cx("type-small", said || lost ? "" : "sr-only")}
        {...(said || lost ? { tabindex: -1, "data-announce": "" } : {})}
      >
        {said && <span class={said.tone === "refused" ? "text-mal weight-text-strong" : "text-ink"}>{said.text}</span>}
        {!said && lost && (
          <span class={reconcile?.kind === "none" ? "text-mal weight-text-strong" : "text-ink"}>{lost}</span>
        )}
        {!said && reconcile?.kind === "none" && (
          <>
            {" "}
            <a
              class="underline text-orange-text"
              href={`/settings/account?reconcile=add&cred=${encodeURIComponent(reconcile.cred)}`}
            >
              Check again
            </a>
          </>
        )}
        {!said && reconcile?.kind === "added" && (
          <>
            {" "}
            <a
              class="underline text-orange-text"
              href={`/settings/account/passkeys/${encodeURIComponent(reconcile.id)}/rename?added=1`}
            >
              Name this passkey
            </a>
          </>
        )}
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
          <div class="grid gap-12 md:grid-cols-2">
            <Field
              id="account-name"
              name="name"
              label="Name"
              value={draft?.name ?? outcome?.name ?? user.name}
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
          </div>
          <div>
            <Button type="submit" variant="dark" data-busy-label="Saving…">
              Save
            </Button>
          </div>
        </form>
      </section>
      {props.weekly && (
        <section aria-labelledby="weekly-heading" class={cx(CARD, "flex flex-col gap-12")}>
          <h2 id="weekly-heading" class="type-h3">
            Weekly counts
          </h2>
          <form method="post" action="/settings/account" data-busy>
            <input type="hidden" name="action" value="weekly-report" />
            <input type="hidden" name="org" value={props.weekly.orgId} />
            <label class="flex items-start gap-12">
              <input
                type="checkbox"
                name="weekly"
                value="on"
                checked={props.weekly.optedInAt !== null}
                class="mt-2 h-20 w-20 shrink-0 accent-orange"
              />
              <span class="flex flex-col gap-4">
                <span class="weight-text-strong">Email me this organisation's weekly counts on Fridays</span>
                <span class="type-small text-muted">
                  {props.weekly.optedInAt
                    ? `On since ${dateText(props.weekly.optedInAt)} for ${props.weekly.orgName}. The three Cases numbers, never a case's content.`
                    : `Off for ${props.weekly.orgName}. Switch on and Save to start them.`}
                </span>
              </span>
            </label>
            <div class="mt-12">
              <Button type="submit" variant="dark" data-busy-label="Saving…">
                Save
              </Button>
            </div>
          </form>
        </section>
      )}
      <section aria-labelledby="passkeys-heading" class={cx(CARD, "flex flex-col gap-12")}>
        <div class="flex flex-wrap items-center justify-between gap-12">
          <h2 id="passkeys-heading" class="type-h3">
            Passkeys
          </h2>
          <button type="button" hidden data-passkey-add class={buttonClass("primary", "small")}>
            Add a passkey
          </button>
        </div>
        <p class="type-small text-muted">Sign in with your fingerprint, face or device PIN. Nothing to phish.</p>
        <p data-passkey-add-unavailable class="type-small text-muted">
          Adding a passkey needs a browser that supports passkeys, with JavaScript on. You can still sign in with an
          email link.
        </p>
        <p data-passkey-add-status role="status" class="type-small text-muted" />
        <p
          id="passkey-add-message"
          data-passkey-add-message
          role="alert"
          class="type-small text-mal weight-text-strong"
        />
        {passkeys.length === 0 ? (
          <p id="passkeys-empty" class="type-small text-muted">
            No passkeys yet. You sign in with an email link.
          </p>
        ) : (
          <>
            <table aria-labelledby="passkeys-heading" class="hidden md:table w-full text-left border-collapse">
              <thead>
                <tr class="type-small text-muted border-y border-line bg-subtle">
                  <th scope="col" class="px-16 py-12 weight-text-strong">
                    Passkey
                  </th>
                  <th scope="col" class="px-16 py-12 weight-text-strong">
                    Added
                  </th>
                  <th scope="col" class="px-16 py-12 weight-text-strong">
                    Kind
                  </th>
                  <th scope="col" class="px-16 py-12">
                    <span class="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {passkeys.map((k) => (
                  <tr class="border-b border-line last:border-b-0" data-passkey-row={k.id}>
                    <td class="px-16 py-16 weight-text-strong wrap-anywhere">{k.name}</td>
                    <td class="px-16 py-16 text-muted">{dateText(k.addedAt)}</td>
                    <td class="px-16 py-16 text-muted">{DEVICE_WORDS[k.deviceType] ?? "Passkey"}</td>
                    <td class="px-16 py-16 text-right whitespace-nowrap">
                      <RowLink
                        href={`/settings/account/passkeys/${encodeURIComponent(k.id)}/rename`}
                        label={`Rename passkey ${k.name}`}
                      >
                        Rename
                      </RowLink>{" "}
                      <RowLink
                        href={`/settings/account/passkeys/${encodeURIComponent(k.id)}/remove`}
                        label={`Remove passkey ${k.name}`}
                        danger
                      >
                        Remove
                      </RowLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul class="md:hidden flex flex-col border-t border-line">
              {passkeys.map((k) => (
                <li class="flex flex-col gap-4 py-12 border-b border-line last:border-b-0">
                  <span class="weight-text-strong wrap-anywhere">{k.name}</span>
                  <span class="type-small text-muted">
                    Added {dateText(k.addedAt)} · {DEVICE_WORDS[k.deviceType] ?? "Passkey"}
                  </span>
                  <span class="flex flex-wrap gap-8">
                    <RowLink
                      href={`/settings/account/passkeys/${encodeURIComponent(k.id)}/rename`}
                      label={`Rename passkey ${k.name}`}
                    >
                      Rename
                    </RowLink>
                    <RowLink
                      href={`/settings/account/passkeys/${encodeURIComponent(k.id)}/remove`}
                      label={`Remove passkey ${k.name}`}
                      danger
                    >
                      Remove
                    </RowLink>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <section aria-labelledby="sessions-heading" class={cx(CARD, "flex flex-col gap-12")}>
        <div class="flex flex-wrap items-center justify-between gap-12">
          <h2 id="sessions-heading" class="type-h3">
            Where you are signed in
          </h2>
          {sessions.some((x) => !x.current) && (
            <a href="/settings/account/sessions/sign-out-others" class={buttonClass("ghost", "small")}>
              Sign out other sessions
            </a>
          )}
        </div>
        <p class="type-small text-muted">Sign out anything you do not recognise.</p>
        <table aria-labelledby="sessions-heading" class="hidden md:table w-full text-left border-collapse">
          <thead>
            <tr class="type-small text-muted border-y border-line bg-subtle">
              <th scope="col" class="px-16 py-12 weight-text-strong">
                Device
              </th>
              <th scope="col" class="px-16 py-12 weight-text-strong">
                Signed in
              </th>
              <th scope="col" class="px-16 py-12 weight-text-strong">
                Last active
              </th>
              <th scope="col" class="px-16 py-12">
                <span class="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr class="border-b border-line last:border-b-0" data-session-row={s.id}>
                <td class="px-16 py-16 weight-text-strong wrap-anywhere">
                  {s.device}{" "}
                  {s.current && (
                    <Pill variant="neutral" size="compact">
                      This device
                    </Pill>
                  )}
                </td>
                <td class="px-16 py-16 text-muted">{dateText(s.signedInAt)}</td>
                <td class="px-16 py-16 text-muted">{activeText(s.lastActiveAt, now)}</td>
                <td class="px-16 py-16 text-right">
                  {!s.current && (
                    <RowLink
                      href={`/settings/account/sessions/${encodeURIComponent(s.id)}/sign-out`}
                      label={`Sign out ${s.device}, last active ${activeText(s.lastActiveAt, now)}`}
                    >
                      Sign out
                    </RowLink>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul class="md:hidden flex flex-col border-t border-line">
          {sessions.map((s) => (
            <li class="flex flex-col gap-4 py-12 border-b border-line last:border-b-0">
              <span class="weight-text-strong wrap-anywhere">
                {s.device}
                {s.current && " (this device)"}
              </span>
              <span class="type-small text-muted">
                Signed in {dateText(s.signedInAt)} · Last active {activeText(s.lastActiveAt, now)}
              </span>
              {!s.current && (
                <span>
                  <RowLink
                    href={`/settings/account/sessions/${encodeURIComponent(s.id)}/sign-out`}
                    label={`Sign out ${s.device}, last active ${activeText(s.lastActiveAt, now)}`}
                  >
                    Sign out
                  </RowLink>
                </span>
              )}
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
