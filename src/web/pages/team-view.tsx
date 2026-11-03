// The Team page (D07 T04 §3; design/SPEC.md M7, board `Team`): the organisation's members, each row's controls by
// Better Auth's own rule for the reader and the target, the last-owner guard, and what a change did, read back from the
// stored state. Changes post to `/team` (./team.tsx); removal confirms on its own page, with or without JavaScript.
// The invitations panel and the pending table (D07 T04 §21) post to the same route; the table reads the stored invitations.
import { isProtectedAccount } from "../../auth/protected";
import { fold } from "../../db/search-fold";
import { AppShell, type MemberShellProps } from "../components/AppShell";
import { cx } from "../components/attrs";
import { Button, buttonClass } from "../components/Button";
import { Document } from "../components/Document";
import { Field, INLINE_INPUT } from "../components/Field";
import { Pill } from "../components/Pill";
import { Select } from "../components/Select";

export type Role = "owner" | "admin" | "member";
export type TeamMember = {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  // The newest session's last refresh (`session.updatedAt`), or null with no session.
  lastActive: string | null;
};
export type Reader = { userId: string; role: Role };
// A pending invitation as stored. `delivery` is read from the invitation's own stored send: `sent`, `unknown` (the
// provider may have taken it) or `not-sent`.
export type PendingInvite = {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
  inviter: string | null;
  delivery: "sent" | "unknown" | "not-sent";
};
// The invite panel as the member left it after a refusal: the address and why.
export type InviteDraft = { email: string; role: Role; error: string | null };

// One submit's per-address outcomes (D07 T04 §22): every address listed, and the ones Retry may send again.
// One team history row as drawn (D07 T04 §23): names already resolved, detail already allowlisted.
export type TeamHistoryRow = { at: string; what: string; who: string; whom: string; outcome: string };
export type TeamHistory = {
  rows: TeamHistoryRow[];
  action: string;
  from: string;
  to: string;
  person?: string;
  after?: string;
  people?: { id: string; label: string }[];
  next?: string | null;
  error?: string;
  failed?: boolean;
  more?: boolean;
};

export type InviteBatch = {
  role: Role;
  results: { email: string; word: string; detail?: string }[];
  retry: string[];
};

// What a change did, carried back signed in the address (./team.tsx).
export const OUTCOMES = [
  "role-changed",
  "removed",
  "locked",
  "gone",
  "last-owner",
  "protected",
  "no-permission",
  "switched",
  "unchanged",
  "failed",
  "refused",
  "invited",
  "invite-unsent",
  "resent",
  "revoked",
  "invite-gone",
  "invite-limit",
  "invite-failed",
] as const;
export type Outcome = { r: (typeof OUTCOMES)[number]; name?: string };

const ROLE_WORDS: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };

// The roles a reader may give a target, by Better Auth's rule (better-auth organization updateMemberRole, mirrored in
// src/auth/auth.ts): an owner any role on anyone else; an admin Admin or Member on an admin or member, never an owner's
// row and never Owner; a member nothing; nobody their own row.
export function roleChoices(reader: Reader, target: TeamMember): Role[] {
  if (target.userId === reader.userId) return [];
  if (reader.role === "owner") return ["owner", "admin", "member"];
  if (reader.role === "admin" && target.role !== "owner") return ["admin", "member"];
  return [];
}
// Whether a reader may remove a target, by the same rule; the last-owner guard decides the rest.
export function mayRemove(reader: Reader, target: TeamMember): boolean {
  if (target.userId === reader.userId) return false;
  if (reader.role === "owner") return true;
  return reader.role === "admin" && target.role !== "owner";
}

const SAST_OFFSET_MS = 2 * 60 * 60_000;
const sastDay = (ms: number) => Math.floor((ms + SAST_OFFSET_MS) / 86_400_000);
const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const day = (withYear: boolean) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Johannesburg",
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  });

// "Last active" as the board words it: "Now" within five minutes, "Today 11:20", "Yesterday", the day ("Fri 24 Oct"),
// with the year when not this year's; "No recent sign-in" with no session.
export function lastActiveText(iso: string | null, now: Date): string {
  if (!iso) return "No recent sign-in";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "No recent sign-in";
  const nowMs = now.getTime();
  if (nowMs - at < 5 * 60_000) return "Now";
  const days = sastDay(nowMs) - sastDay(at);
  if (days === 0) return `Today ${clock.format(at)}`;
  if (days === 1) return "Yesterday";
  const sameYear = new Date(at + SAST_OFFSET_MS).getUTCFullYear() === new Date(nowMs + SAST_OFFSET_MS).getUTCFullYear();
  return day(!sameYear).format(at).replace(",", "");
}

// Roles a reader may invite as, by Better Auth's rule: an owner any, an admin Admin or Member, a member none.
export const inviteRoles = (reader: Reader): Role[] =>
  reader.role === "owner" ? ["owner", "admin", "member"] : reader.role === "admin" ? ["admin", "member"] : [];

const GUARD = "You are the only owner, so you cannot be removed or made an admin. Make someone else owner first.";

function outcomeText(o: Outcome): { text: string; tone: "done" | "refused" } {
  const who = o.name ?? "That member";
  switch (o.r) {
    case "role-changed":
      return { text: `${who}'s role was changed.`, tone: "done" };
    case "removed":
      return { text: `${who} was removed.`, tone: "done" };
    case "locked":
      return { text: `Someone else is changing ${who} now. Try again in a moment.`, tone: "refused" };
    case "gone":
      return { text: `${who} is no longer a member.`, tone: "refused" };
    case "last-owner":
      return { text: GUARD, tone: "refused" };
    case "protected":
      return { text: `${who} is a protected demo account and cannot be removed.`, tone: "refused" };
    case "no-permission":
      return { text: "You can no longer change the team.", tone: "refused" };
    case "switched":
      return {
        text: "Nothing was changed: this page was opened for another organisation. Check the team below.",
        tone: "refused",
      };
    case "failed":
      return {
        text: `The change to ${who} could not be confirmed. The team below is as stored now; try again if it is not what you asked.`,
        tone: "refused",
      };
    case "refused":
      return { text: "Nothing was changed: that request is not one this page sends.", tone: "refused" };
    case "invited":
      return { text: `Invitation sent to ${o.name ?? "that address"}.`, tone: "done" };
    case "resent":
      return { text: `Invitation sent again to ${o.name ?? "that address"}.`, tone: "done" };
    case "revoked":
      return { text: `The invitation to ${o.name ?? "that address"} was revoked.`, tone: "done" };
    case "invite-unsent":
      return {
        text: `The invitation to ${o.name ?? "that address"} is saved, but its email may not have gone. See the pending list and send it again.`,
        tone: "refused",
      };
    case "invite-gone":
      return {
        text: `The invitation to ${o.name ?? "that address"} is no longer pending. The list below is as stored now.`,
        tone: "refused",
      };
    case "invite-limit":
      return {
        text: `No new invitation to ${o.name ?? "that address"} could be made: this organisation has too many open invitations. Revoke one, or wait for one to lapse, then send it again.`,
        tone: "refused",
      };
    case "invite-failed":
      return {
        text: `The invitation to ${o.name ?? "that address"} could not be confirmed. The list below is as stored now; try again if it is not what you asked.`,
        tone: "refused",
      };
    default:
      return { text: `${who} already had that role.`, tone: "done" };
  }
}

// `layout` keeps ids unique: the table (wide screens) and the cards (phones) each draw a row's controls.
function RoleCell(props: {
  reader: Reader;
  member: TeamMember;
  orgId: string;
  layout: "table" | "card";
  find?: string | undefined;
}) {
  const { reader, member, orgId, layout, find } = props;
  const choices = roleChoices(reader, member);
  if (!choices.length)
    return (
      <Pill variant="neutral" size="compact">
        {ROLE_WORDS[member.role]}
      </Pill>
    );
  const id = layout === "table" ? `role-${member.memberId}` : `role-${member.memberId}-card`;
  return (
    <form
      method="post"
      action="/team"
      class="flex items-center gap-8"
      // A change whose answer never came (no connection, a gateway's error page) may still have been made. The app script
      // loads the asked address as a page after any failed request, so the address asked is the page that says so:
      // `GET /team?unanswered=1` redraws the stored team with that notice. A change that answers is redirected as usual.
      hx-post={find ? `/team?unanswered=1&find=${encodeURIComponent(find)}` : "/team?unanswered=1"}
      hx-trigger="change"
      hx-target="#team-main"
      hx-select="#team-main"
      hx-swap="outerHTML"
      hx-disabled-elt="find select"
    >
      <input type="hidden" name="action" value="role" />
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="member" value={member.memberId} />
      {find ? <input type="hidden" name="find" value={find} /> : null}
      <label for={id} class="sr-only">
        Role of {member.name || member.email}
      </label>
      <Select id={id} name="role">
        {choices.map((role) => (
          <option value={role} selected={member.role === role}>
            {ROLE_WORDS[role]}
          </option>
        ))}
      </Select>
      {/* Only without JavaScript: htmx posts the change as it is made. */}
      <noscript>
        <Button type="submit" variant="ghost" size="small">
          Save
        </Button>
      </noscript>
    </form>
  );
}

function RemoveCell(props: {
  reader: Reader;
  member: TeamMember;
  onlyOwner: boolean;
  layout: "table" | "card";
  find?: string | undefined;
}) {
  const { reader, member, onlyOwner, layout, find } = props;
  const id = layout === "table" ? `remove-${member.memberId}` : `remove-${member.memberId}-card`;
  const self = member.userId === reader.userId;
  // Every Remove names who it acts on, enabled or not, so a list of controls tells them apart.
  const label = `Remove ${member.name || member.email}`;
  if (self && reader.role === "owner" && onlyOwner)
    return (
      <Button variant="ghost" size="small" id={id} aria-label={label} disabled disabledReason="You are the only owner">
        Remove
      </Button>
    );
  if (!mayRemove(reader, member)) {
    if (reader.role === "admin" && member.role === "owner")
      return (
        <Button
          variant="ghost"
          size="small"
          id={id}
          aria-label={label}
          disabled
          disabledReason="Only an owner can change an owner"
        >
          Remove
        </Button>
      );
    return null;
  }
  // A protected account (src/auth/protected.ts) is never removed: the reader who could remove anyone else sees why.
  if (isProtectedAccount(member.email))
    return (
      <Button
        variant="ghost"
        size="small"
        id={id}
        aria-label={label}
        disabled
        disabledReason="This is a protected demo account"
      >
        Remove
      </Button>
    );
  return (
    <a
      href={`/team/remove/${encodeURIComponent(member.memberId)}${find ? `?find=${encodeURIComponent(find)}` : ""}`}
      class={buttonClass("danger", "small")}
      aria-label={label}
    >
      Remove
    </a>
  );
}

// "Today 09:02", "Yesterday 14:10" or "Fri 24 Oct": when an invitation was made, in SAST.
function sentText(iso: string, now: Date): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "Unknown";
  const days = sastDay(now.getTime()) - sastDay(at);
  if (days === 0) return `Today ${clock.format(at)}`;
  if (days === 1) return `Yesterday ${clock.format(at)}`;
  return day(false).format(at).replace(",", "");
}
// "Wed 29 Oct, 09:02": when it lapses, in SAST.
const expiresText = (iso: string) => {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? `${day(false).format(at).replace(",", "")}, ${clock.format(at)}` : "Unknown";
};
// "Thandi N.": a first name and the initial of the last, as the board writes who sent it.
function shortName(name: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "a team member";
  return parts.length === 1 ? (parts[0] as string) : `${parts[0]} ${(parts.at(-1) as string).charAt(0)}.`;
}

function InvitePanel(props: { reader: Reader; orgId: string; draft: InviteDraft | undefined }) {
  const { reader, orgId, draft } = props;
  const roles = inviteRoles(reader);
  const chosen = draft?.role ?? "member";
  return (
    <section aria-labelledby="invite-heading" class="bg-surface border border-line rounded-card-large p-24">
      <h2 id="invite-heading" class="type-h3">
        Invite by email
      </h2>
      <form
        method="post"
        action="/team"
        class="flex flex-col gap-12 mt-16 md:flex-row md:items-start md:gap-16"
        data-busy
        data-announce-scope
      >
        <input type="hidden" name="action" value="invite" />
        <input type="hidden" name="org" value={orgId} />
        <div class="min-w-0 md:flex-1 md:max-w-[480px]">
          <Field
            id="invite-email"
            name="email"
            label="Email addresses"
            hint="One per line or separated by commas, up to 20. Everyone gets the role you choose."
            value={draft?.email ?? ""}
            {...(draft?.error ? { error: draft.error } : {})}
            autocomplete="off"
            rows={4}
            required
          />
        </div>
        <div class="flex flex-col gap-4">
          <label for="invite-role" class="type-small weight-text-strong">
            Role
          </label>
          <Select id="invite-role" name="role" class="md:min-w-[160px]">
            {roles.map((role) => (
              <option value={role} selected={chosen === role}>
                {ROLE_WORDS[role]}
              </option>
            ))}
          </Select>
        </div>
        <div class="md:pt-24">
          <Button type="submit" variant="primary" data-busy-label="Sending…">
            Send invitation
          </Button>
        </div>
      </form>
    </section>
  );
}

function InviteAction(props: {
  orgId: string;
  invite: PendingInvite;
  action: "resend" | "revoke";
  label: string;
  variant: "ghost" | "danger";
}) {
  const { orgId, invite, action, label, variant } = props;
  return (
    <form method="post" action="/team" class="inline" data-busy data-busy-check="/team">
      <input type="hidden" name="action" value={action} />
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="invitation" value={invite.id} />
      <Button
        type="submit"
        variant={variant}
        size="small"
        aria-label={`${label} invitation to ${invite.email}`}
        data-busy-label={action === "revoke" ? "Revoking…" : "Sending…"}
      >
        {label}
      </Button>
    </form>
  );
}

function DeliveryMark(props: { invite: PendingInvite }) {
  const { invite } = props;
  if (invite.delivery === "sent") return null;
  return (
    <span class="type-small text-mal weight-text-strong" data-delivery={invite.delivery}>
      {invite.delivery === "unknown" ? "Not known if the email went." : "Email not sent."}
    </span>
  );
}

function PendingInvites(props: { orgId: string; invites: PendingInvite[]; now: Date }) {
  const { orgId, invites, now } = props;
  const lapsed = (i: PendingInvite) => Date.parse(i.expiresAt) < now.getTime();
  const actions = (i: PendingInvite) => (
    <div class="flex flex-wrap items-center gap-8">
      <InviteAction
        orgId={orgId}
        invite={i}
        action="resend"
        label={i.delivery === "sent" ? "Resend" : "Send again"}
        variant="ghost"
      />
      <InviteAction orgId={orgId} invite={i} action="revoke" label="Revoke" variant="danger" />
    </div>
  );
  return (
    <section aria-labelledby="pending-heading" class="bg-surface border border-line rounded-card-large overflow-hidden">
      <h2 id="pending-heading" class="type-h3 px-24 py-16">
        Pending invitations
      </h2>
      {invites.length === 0 ? (
        <p id="pending-empty" class="px-24 pb-24 type-small text-muted">
          No pending invitations.
        </p>
      ) : (
        <>
          <table aria-labelledby="pending-heading" class="hidden md:table w-full text-left border-collapse">
            <thead>
              <tr class="type-small text-muted border-y border-line bg-subtle">
                <th scope="col" class="px-16 py-12 weight-text-strong">
                  Email
                </th>
                <th scope="col" class="px-16 py-12 weight-text-strong">
                  Role
                </th>
                <th scope="col" class="px-16 py-12 weight-text-strong">
                  Sent
                </th>
                <th scope="col" class="px-16 py-12 weight-text-strong">
                  Expires
                </th>
                <th scope="col" class="px-16 py-12">
                  <span class="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {invites.map((i) => (
                <tr class="border-b border-line last:border-b-0">
                  <td class="px-16 py-16 align-middle">
                    <span class="flex flex-col gap-4 min-w-0">
                      <span class="weight-text-strong wrap-anywhere">{i.email}</span>
                      <DeliveryMark invite={i} />
                    </span>
                  </td>
                  <td class="px-16 py-16 align-middle">{ROLE_WORDS[i.role]}</td>
                  <td class="px-16 py-16 align-middle text-muted">
                    {sentText(i.createdAt, now)} by {shortName(i.inviter)}
                  </td>
                  <td class="px-16 py-16 align-middle text-muted">
                    {lapsed(i) ? "Expired " : ""}
                    {expiresText(i.expiresAt)}
                  </td>
                  <td class="px-16 py-16 align-middle text-right">{actions(i)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul class="md:hidden flex flex-col border-t border-line">
            {invites.map((i) => (
              <li class="flex flex-col gap-8 p-16 border-b border-line last:border-b-0">
                <span class="weight-text-strong wrap-anywhere">{i.email}</span>
                <span class="type-small text-muted">
                  {ROLE_WORDS[i.role]} · Sent {sentText(i.createdAt, now)} by {shortName(i.inviter)} ·{" "}
                  {lapsed(i) ? "Expired" : "Expires"} {expiresText(i.expiresAt)}
                </span>
                <DeliveryMark invite={i} />
                {actions(i)}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const HISTORY_ACTIONS = [
  ["", "All actions"],
  ["update-member-role", "Role changed"],
  ["cancel-invitation", "Invitation revoked"],
  ["remove-member", "Member removed"],
  ["leave-organization", "Member left"],
] as const;

function historyWhen(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "Unknown";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Johannesburg",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

function TeamHistorySection(props: { history: TeamHistory; now: Date; find?: string | undefined }) {
  const { history } = props;
  return (
    <section
      aria-labelledby="team-history-heading"
      class="bg-surface border border-line rounded-card-large overflow-hidden"
    >
      <h2 id="team-history-heading" class="type-h3 px-24 py-16">
        Team history
      </h2>
      <form method="get" action="/team" class="flex flex-wrap items-end gap-12 px-24 pb-16">
        {props.find ? <input type="hidden" name="find" value={props.find} /> : null}
        <label for="history-action" class="flex flex-col gap-4">
          <span class="type-small weight-text-strong">Action</span>
          <Select id="history-action" name="action">
            {HISTORY_ACTIONS.map(([value, word]) => (
              <option value={value} selected={history.action === value}>
                {word}
              </option>
            ))}
          </Select>
        </label>
        <label for="history-person" class="flex flex-col gap-4">
          <span class="type-small weight-text-strong">Person</span>
          <Select id="history-person" name="person">
            <option value="" selected={!history.person}>
              Anyone
            </option>
            {(history.people ?? []).map((person) => (
              <option value={person.id} selected={history.person === person.id}>
                {person.label}
              </option>
            ))}
          </Select>
        </label>
        <label class="flex flex-col gap-4">
          <span class="type-small weight-text-strong">From</span>
          <input id="history-from" type="date" name="from" value={history.from} class={INLINE_INPUT} />
        </label>
        <label class="flex flex-col gap-4">
          <span class="type-small weight-text-strong">To</span>
          <input id="history-to" type="date" name="to" value={history.to} class={INLINE_INPUT} />
        </label>
        <Button type="submit" variant="dark">
          Apply
        </Button>
        <a
          href={`/team${props.find ? `?find=${encodeURIComponent(props.find)}` : ""}`}
          class="type-small text-orange-text underline underline-offset-4"
        >
          Clear
        </a>
      </form>
      {history.error && (
        <p role="alert" class="px-24 pb-16 type-small text-mal weight-text-strong">
          {history.error}
        </p>
      )}
      {history.failed ? (
        <p class="px-24 pb-24 type-small">
          The team history could not be read just now.{" "}
          <a
            href={`/team?action=${encodeURIComponent(history.action)}&from=${encodeURIComponent(history.from)}&to=${encodeURIComponent(history.to)}&person=${encodeURIComponent(history.person ?? "")}${history.after ? `&after=${encodeURIComponent(history.after)}` : ""}${props.find ? `&find=${encodeURIComponent(props.find)}` : ""}`}
            class="text-orange-text underline underline-offset-4"
          >
            Try again
          </a>
        </p>
      ) : history.rows.length === 0 ? (
        <p class="px-24 pb-24 type-small text-muted">No team changes in this period.</p>
      ) : (
        <>
          <table class="hidden md:table w-full text-left border-collapse" aria-labelledby="team-history-heading">
            <thead>
              <tr class="type-small text-muted border-y border-line bg-subtle">
                <th scope="col" class="px-16 py-12 weight-text-strong">
                  When
                </th>
                <th scope="col" class="px-16 py-12 weight-text-strong">
                  What
                </th>
                <th scope="col" class="px-16 py-12 weight-text-strong">
                  Who
                </th>
                <th scope="col" class="px-16 py-12 weight-text-strong">
                  Whom
                </th>
                <th scope="col" class="px-16 py-12 weight-text-strong">
                  Outcome
                </th>
              </tr>
            </thead>
            <tbody>
              {history.rows.map((row) => (
                <tr class="border-b border-line last:border-b-0">
                  <td class="px-16 py-12">{historyWhen(row.at)}</td>
                  <td class="px-16 py-12 wrap-anywhere">{row.what}</td>
                  <td class="px-16 py-12 wrap-anywhere">{row.who}</td>
                  <td class="px-16 py-12 wrap-anywhere">{row.whom}</td>
                  <td class="px-16 py-12 wrap-anywhere">{row.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul class="md:hidden flex flex-col">
            {history.rows.map((row) => (
              <li class="flex flex-col gap-4 px-16 py-12 border-t border-line">
                <span class="weight-text-strong wrap-anywhere">{row.what}</span>
                <span class="type-small text-muted">{historyWhen(row.at)}</span>
                <span class="type-small wrap-anywhere">
                  {row.who} · {row.whom} · {row.outcome}
                </span>
              </li>
            ))}
          </ul>
          {history.more && !history.next && (
            <p class="px-24 py-12 type-small text-muted">Showing the latest 100 changes.</p>
          )}
          {history.next && (
            <p class="px-24 py-12">
              <a
                href={`/team?action=${encodeURIComponent(history.action)}&from=${encodeURIComponent(history.from)}&to=${encodeURIComponent(history.to)}&person=${encodeURIComponent(history.person ?? "")}&after=${encodeURIComponent(history.next)}${props.find ? `&find=${encodeURIComponent(props.find)}` : ""}`}
                class="type-small text-orange-text underline underline-offset-4"
              >
                More changes
              </a>
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function TeamPage(props: {
  shell: Omit<MemberShellProps, "children">;
  members: TeamMember[];
  reader: Reader;
  outcome: Outcome | null;
  // A change whose answer was lost on the way (`?unanswered=1`): it may or may not have been made.
  lost?: boolean;
  // Owners and admins only: the stored pending invitations, and the panel as it was left after a refusal.
  invites?: PendingInvite[];
  draft?: InviteDraft;
  inviteBatch?: InviteBatch;
  history?: TeamHistory | undefined;
  find?: string | undefined;
  findFocus?: boolean | undefined;
  now: Date;
}) {
  const { shell, members, reader, outcome, lost, now, invites, draft, inviteBatch, history, find, findFocus } = props;
  const findTooLong = (find ?? "").length > 200;
  const visible =
    find && !findTooLong
      ? members.filter((m) => fold(m.name).includes(fold(find)) || fold(m.email).includes(fold(find)))
      : members;
  const mayInvite = reader.role !== "member";
  const orgName = shell.organization.name;
  const owners = members.filter((m) => m.role === "owner").length;
  const readerIsOnlyOwner = reader.role === "owner" && owners === 1;
  const said = outcome
    ? outcomeText(outcome)
    : lost
      ? {
          text: "Your last change may not have reached us. The team below is as stored now; check it and try again if it is not what you asked.",
          tone: "refused" as const,
        }
      : null;
  return (
    <Document title="Team">
      <AppShell {...shell}>
        <div id="team-main" class="flex flex-col gap-24 px-16 py-24 md:px-56 md:py-40">
          <header class="flex flex-col gap-4 min-w-0">
            <h1 class="type-h1">Team</h1>
            <p class="type-small text-muted wrap-anywhere">People at {orgName} who can check mail and see cases.</p>
          </header>
          <p
            id="team-outcome"
            role={said?.tone === "refused" ? "alert" : "status"}
            class={cx("type-small", said ? "" : "sr-only")}
            {...(said ? { tabindex: -1, "data-announce": "" } : {})}
          >
            {said && (
              <span class={said.tone === "refused" ? "text-mal weight-text-strong" : "text-ink"}>{said.text}</span>
            )}
          </p>
          {mayInvite && <InvitePanel reader={reader} orgId={shell.organization.id} draft={draft} />}
          {inviteBatch && (
            <section
              aria-labelledby="invite-batch-heading"
              class="bg-surface border border-line rounded-card-large p-24"
            >
              <h2 id="invite-batch-heading" class="type-h3" tabindex={-1} data-announce="">
                Invitations
              </h2>
              <ul class="mt-12 flex flex-col gap-8">
                {inviteBatch.results.map((r) => (
                  <li class="type-small wrap-anywhere">
                    <strong class="text-ink">{r.email}</strong>: {r.word}
                    {r.detail ? <span class="text-muted"> {r.detail}</span> : null}
                  </li>
                ))}
              </ul>
              {inviteBatch.retry.length > 0 && (
                <form method="post" action="/team" class="mt-16" data-busy>
                  <input type="hidden" name="action" value="invite" />
                  <input type="hidden" name="batch" value="1" />
                  <input type="hidden" name="org" value={shell.organization.id} />
                  <input type="hidden" name="role" value={inviteBatch.role} />
                  <input type="hidden" name="email" value={inviteBatch.retry.join("\n")} />
                  <Button type="submit" variant="primary" data-busy-label="Sending…">
                    Retry the ones that did not go
                  </Button>
                </form>
              )}
            </section>
          )}
          <p class="type-small text-muted">
            <strong class="text-ink">Owner</strong>: everything, including the plan and removing people.{" "}
            <strong class="text-ink">Admin</strong>: suppliers, protection, domains and invites.{" "}
            <strong class="text-ink">Member</strong>: checks mail and sees cases.
          </p>
          <form method="get" action="/team" class="flex flex-wrap items-end gap-12" aria-label="Find a person">
            {history?.action ? <input type="hidden" name="action" value={history.action} /> : null}
            {history?.person ? <input type="hidden" name="person" value={history.person} /> : null}
            {history?.from ? <input type="hidden" name="from" value={history.from} /> : null}
            {history?.to ? <input type="hidden" name="to" value={history.to} /> : null}
            <label class="flex flex-col gap-4">
              <span class="type-small weight-text-strong">Find a person</span>
              <input
                id="team-find"
                type="search"
                name="find"
                value={find ?? ""}
                placeholder="Name or email"
                autocomplete="off"
                class={INLINE_INPUT}
                {...((find !== undefined || findFocus) && !outcome && !lost ? { autofocus: true } : {})}
              />
            </label>
            <Button type="submit" variant="dark">
              Find
            </Button>
            {find ? (
              <a
                href={`/team?focus=find${history?.action ? `&action=${encodeURIComponent(history.action)}` : ""}${history?.from ? `&from=${encodeURIComponent(history.from)}` : ""}${history?.to ? `&to=${encodeURIComponent(history.to)}` : ""}${history?.person ? `&person=${encodeURIComponent(history.person)}` : ""}`}
                class="type-small text-orange-text underline underline-offset-4"
              >
                Clear
              </a>
            ) : null}
          </form>
          {findTooLong && (
            <p role="alert" class="type-small text-mal weight-text-strong">
              That find is too long. Shorten it and try again.
            </p>
          )}
          {find && !findTooLong && visible.length === 0 && (
            <p class="type-small text-muted">No one on the team matches.</p>
          )}
          <div class="bg-surface border border-line rounded-card-large overflow-hidden">
            <table class="hidden md:table w-full text-left border-collapse">
              <caption class="sr-only">Members of {orgName}</caption>
              <thead>
                <tr class="type-small text-muted border-b border-line bg-subtle">
                  <th scope="col" class="px-16 py-12 weight-text-strong">
                    Name
                  </th>
                  <th scope="col" class="px-16 py-12 weight-text-strong">
                    Email
                  </th>
                  <th scope="col" class="px-16 py-12 weight-text-strong">
                    Role
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
                {visible.map((m) => (
                  <tr class="border-b border-line last:border-b-0">
                    <td class="px-16 py-16 align-middle">
                      <span class="weight-text-strong wrap-anywhere">{m.name || m.email}</span>
                      {m.userId === reader.userId && (
                        <>
                          {" "}
                          <Pill variant="neutral" size="compact">
                            You
                          </Pill>
                        </>
                      )}
                    </td>
                    <td class="px-16 py-16 align-middle wrap-anywhere">{m.email}</td>
                    <td class="px-16 py-16 align-middle">
                      <RoleCell reader={reader} member={m} orgId={shell.organization.id} layout="table" find={find} />
                    </td>
                    <td class="px-16 py-16 align-middle text-muted">{lastActiveText(m.lastActive, now)}</td>
                    <td class="px-16 py-16 align-middle text-right">
                      <RemoveCell reader={reader} member={m} onlyOwner={owners === 1} layout="table" find={find} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Phone: one card per member, no sideways scroll. */}
            <ul class="md:hidden flex flex-col">
              {visible.map((m) => (
                <li class="flex flex-col gap-8 p-16 border-b border-line last:border-b-0">
                  <span class="weight-text-strong wrap-anywhere">
                    {m.name || m.email}
                    {m.userId === reader.userId && " (you)"}
                  </span>
                  <span class="type-small text-muted wrap-anywhere">{m.email}</span>
                  <span class="type-small text-muted">Last active: {lastActiveText(m.lastActive, now)}</span>
                  <div class="flex flex-wrap items-center justify-between gap-12">
                    <RoleCell reader={reader} member={m} orgId={shell.organization.id} layout="card" find={find} />
                    <RemoveCell reader={reader} member={m} onlyOwner={owners === 1} layout="card" find={find} />
                  </div>
                </li>
              ))}
            </ul>
            {readerIsOnlyOwner && (
              <p id="team-guard" class="px-16 py-16 border-t border-line bg-sus-wash type-small text-ink">
                {GUARD}
              </p>
            )}
          </div>
          {mayInvite && <PendingInvites orgId={shell.organization.id} invites={invites ?? []} now={now} />}
          {history && <TeamHistorySection history={history} now={now} find={find} />}
        </div>
      </AppShell>
    </Document>
  );
}

// The confirmation a removal asks first, with or without JavaScript: the member's name, Remove and Cancel.
export function RemoveConfirm(props: {
  shell: Omit<MemberShellProps, "children">;
  member: TeamMember;
  find?: string | undefined;
}) {
  const { shell, member, find } = props;
  const who = member.name || member.email;
  return (
    <Document title="Remove a member">
      <AppShell {...shell}>
        <div class="flex flex-col gap-24 px-16 py-24 md:px-56 md:py-40 max-w-[640px]">
          <h1 class="type-h1 wrap-anywhere">Remove {who}?</h1>
          <p class="text-16">
            {who} ({member.email}) will stop seeing {shell.organization.name}'s cases at once and is signed out of it.
            You can invite them again later.
          </p>
          <form method="post" action="/team" class="flex flex-wrap gap-12" data-busy data-busy-check="/team">
            <input type="hidden" name="action" value="remove" />
            <input type="hidden" name="org" value={shell.organization.id} />
            <input type="hidden" name="member" value={member.memberId} />
            {find ? <input type="hidden" name="find" value={find} /> : null}
            <Button type="submit" variant="danger" data-busy-label={`Removing ${who}`}>
              Remove {who}
            </Button>
            <Button variant="ghost" href={find ? `/team?find=${encodeURIComponent(find)}` : "/team"}>
              Cancel
            </Button>
          </form>
        </div>
      </AppShell>
    </Document>
  );
}
