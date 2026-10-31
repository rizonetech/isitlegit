// The Team page (D07 T04 §3; design/SPEC.md M7, board `Team`): the organisation's members, each row's controls by
// Better Auth's own rule for the reader and the target, the last-owner guard, and what a change did, read back from the
// stored state. Changes post to `/team` (./team.tsx); removal confirms on its own page, with or without JavaScript.
// The invitations panel and the pending table are D07 T04 §21.
import { AppShell, type MemberShellProps } from "../components/AppShell";
import { cx, FOCUS } from "../components/attrs";
import { Button, buttonClass } from "../components/Button";
import { Document } from "../components/Document";
import { Pill } from "../components/Pill";

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

// What a change did, carried back signed in the address (./team.tsx).
export const OUTCOMES = [
  "role-changed",
  "removed",
  "locked",
  "gone",
  "last-owner",
  "no-permission",
  "switched",
  "unchanged",
  "failed",
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
    default:
      return { text: `${who} already had that role.`, tone: "done" };
  }
}

const SELECT = cx(
  "h-control px-12 border border-control-border rounded-control text-16 text-ink bg-surface min-w-0",
  FOCUS,
);

// `layout` keeps ids unique: the table (wide screens) and the cards (phones) each draw a row's controls.
function RoleCell(props: { reader: Reader; member: TeamMember; orgId: string; layout: "table" | "card" }) {
  const { reader, member, orgId, layout } = props;
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
      hx-post="/team"
      hx-trigger="change"
      hx-target="#team-main"
      hx-select="#team-main"
      hx-swap="outerHTML"
      hx-disabled-elt="find select"
      data-busy
    >
      <input type="hidden" name="action" value="role" />
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="member" value={member.memberId} />
      <label for={id} class="sr-only">
        Role of {member.name || member.email}
      </label>
      <select id={id} name="role" class={SELECT}>
        {choices.map((role) => (
          <option value={role} selected={member.role === role}>
            {ROLE_WORDS[role]}
          </option>
        ))}
      </select>
      {/* Only without JavaScript: htmx posts the change as it is made. */}
      <noscript>
        <Button type="submit" variant="ghost" size="small">
          Save
        </Button>
      </noscript>
    </form>
  );
}

function RemoveCell(props: { reader: Reader; member: TeamMember; onlyOwner: boolean; layout: "table" | "card" }) {
  const { reader, member, onlyOwner, layout } = props;
  const id = layout === "table" ? `remove-${member.memberId}` : `remove-${member.memberId}-card`;
  const self = member.userId === reader.userId;
  if (self && reader.role === "owner" && onlyOwner)
    return (
      <Button variant="ghost" size="small" id={id} disabled disabledReason="You are the only owner">
        Remove
      </Button>
    );
  if (!mayRemove(reader, member)) {
    if (reader.role === "admin" && member.role === "owner")
      return (
        <Button variant="ghost" size="small" id={id} disabled disabledReason="Only an owner can change an owner">
          Remove
        </Button>
      );
    return null;
  }
  return (
    <a
      href={`/team/remove/${encodeURIComponent(member.memberId)}`}
      class={buttonClass("danger", "small")}
      aria-label={`Remove ${member.name || member.email}`}
    >
      Remove
    </a>
  );
}

export function TeamPage(props: {
  shell: Omit<MemberShellProps, "children">;
  members: TeamMember[];
  reader: Reader;
  outcome: Outcome | null;
  now: Date;
}) {
  const { shell, members, reader, outcome, now } = props;
  const orgName = shell.organization.name;
  const owners = members.filter((m) => m.role === "owner").length;
  const readerIsOnlyOwner = reader.role === "owner" && owners === 1;
  const said = outcome ? outcomeText(outcome) : null;
  return (
    <Document title="Team">
      <AppShell {...shell}>
        <div id="team-main" class="flex flex-col gap-24 px-16 py-24 md:px-56 md:py-40">
          <header class="flex flex-col gap-4 min-w-0">
            <h1 class="type-h1">Team</h1>
            <p class="type-small text-muted wrap-anywhere">People at {orgName} who can check mail and see cases.</p>
          </header>
          <p id="team-outcome" role="status" class={cx("type-small", said ? "" : "sr-only")}>
            {said && (
              <span class={said.tone === "refused" ? "text-mal weight-text-strong" : "text-ink"}>{said.text}</span>
            )}
          </p>
          <p class="type-small text-muted">
            <strong class="text-ink">Owner</strong>: everything, including the plan and removing people.{" "}
            <strong class="text-ink">Admin</strong>: suppliers, protection, domains and invites.{" "}
            <strong class="text-ink">Member</strong>: checks mail and sees cases.
          </p>
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
                {members.map((m) => (
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
                      <RoleCell reader={reader} member={m} orgId={shell.organization.id} layout="table" />
                    </td>
                    <td class="px-16 py-16 align-middle text-muted">{lastActiveText(m.lastActive, now)}</td>
                    <td class="px-16 py-16 align-middle text-right">
                      <RemoveCell reader={reader} member={m} onlyOwner={owners === 1} layout="table" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Phone: one card per member, no sideways scroll. */}
            <ul class="md:hidden flex flex-col">
              {members.map((m) => (
                <li class="flex flex-col gap-8 p-16 border-b border-line last:border-b-0">
                  <span class="weight-text-strong wrap-anywhere">
                    {m.name || m.email}
                    {m.userId === reader.userId && " (you)"}
                  </span>
                  <span class="type-small text-muted wrap-anywhere">{m.email}</span>
                  <span class="type-small text-muted">Last active: {lastActiveText(m.lastActive, now)}</span>
                  <div class="flex flex-wrap items-center justify-between gap-12">
                    <RoleCell reader={reader} member={m} orgId={shell.organization.id} layout="card" />
                    <RemoveCell reader={reader} member={m} onlyOwner={owners === 1} layout="card" />
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
        </div>
      </AppShell>
    </Document>
  );
}

// The confirmation a removal asks first, with or without JavaScript: the member's name, Remove and Cancel.
export function RemoveConfirm(props: { shell: Omit<MemberShellProps, "children">; member: TeamMember }) {
  const { shell, member } = props;
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
          <form method="post" action="/team" class="flex flex-wrap gap-12" data-busy>
            <input type="hidden" name="action" value="remove" />
            <input type="hidden" name="org" value={shell.organization.id} />
            <input type="hidden" name="member" value={member.memberId} />
            <Button type="submit" variant="danger">
              Remove {who}
            </Button>
            <Button variant="ghost" href="/team">
              Cancel
            </Button>
          </form>
        </div>
      </AppShell>
    </Document>
  );
}
