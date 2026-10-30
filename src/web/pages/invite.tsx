// The invitation page (D07 T02 §14; design/SPEC.md A3, board `Invite`): what an invitation's link opens, on A1's frame
// with A3's panel words. Its answer depends on who is here: signed out (sign in as the invited address first), the
// invitee (accept or decline), or someone else (sign out, back to the invitation); and each invitation that can no
// longer be used has a state of its own, with no form. The routes are src/auth/invitation.tsx.
import { cx, FOCUS } from "../components/attrs";
import { Button } from "../components/Button";
import { type PanelWords, SigninFrame, SigninState } from "./signin";

export const INVITE_PANEL: PanelWords = {
  headline: "Your team checks suspicious mail with IsItLegit.",
  sentence: "Join them, and forward anything that looks wrong to check@isitlegit.co.za.",
};

export type InvitationView = {
  id: string;
  organization: string;
  inviter: string;
  email: string;
  role: string;
  expiresAt: string;
};
export type InviteState =
  | { kind: "signed-out" | "invitee"; invitation: InvitationView; signedInAs?: string; problem?: string }
  | { kind: "someone-else"; invitation: InvitationView; signedInAs: string }
  | { kind: "expired" | "revoked" | "declined" | "accepted" | "unfinished"; invitation: InvitationView }
  | { kind: "unknown" };

const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const sast = (iso: string) => `${clock.format(Date.parse(iso)).replace(",", "")} SAST`;
const LINK = cx("text-orange-text underline underline-offset-4", FOCUS);
const ROLE_WORDS: Record<string, string> = {
  member: "you can check mail and see the cases your team has checked.",
  admin: "you can check mail, see your team's cases, and manage the team and its domains.",
  owner: "you can do everything, including the plan and closing the account.",
};

function Facts(props: { rows: [string, string][]; children?: unknown }) {
  return (
    <div class="flex flex-col gap-16 p-24 border border-line rounded-card-large">
      <dl class="flex flex-col gap-12">
        {props.rows.map(([term, value]) => (
          <div class="flex flex-wrap justify-between gap-12">
            <dt class="text-14 text-muted">{term}</dt>
            <dd class="text-14 weight-text-strong wrap-anywhere">{value}</dd>
          </div>
        ))}
      </dl>
      {props.children as never}
    </div>
  );
}

function Hidden(props: { name: string; value: string }) {
  return <input type="hidden" name={props.name} value={props.value} />;
}

export function InvitePage(props: { state: InviteState }) {
  const { state } = props;
  if (state.kind === "unknown")
    return (
      <SigninFrame title="Invitation not found" panel={INVITE_PANEL}>
        <SigninState
          tile="stop"
          heading="We can't find that invitation"
          text="The link may be mistyped, or the invitation was replaced by a newer one. Ask the person who invited you to send it again."
        />
      </SigninFrame>
    );
  const inv = state.invitation;
  const path = `/invite/${inv.id}`;
  const closed: Record<string, [string, string]> = {
    expired: [
      "This invitation has expired",
      `Invitations are open for 48 hours. Ask ${inv.inviter} to send a new one.`,
    ],
    revoked: [
      "This invitation was withdrawn",
      `${inv.organization} withdrew this invitation. Nothing was shared with you.`,
    ],
    declined: [
      "You declined this invitation",
      `Nothing was shared with you. If you declined by mistake, ask ${inv.inviter} to send a new one.`,
    ],
    accepted: ["This invitation has been used", `It was accepted already. Sign in to see ${inv.organization}'s cases.`],
    unfinished: [
      "This invitation was used but did not finish",
      `Ask ${inv.inviter} to send a new one, and accept that.`,
    ],
  };
  const done = closed[state.kind];
  if (done)
    return (
      <SigninFrame title={done[0]} panel={INVITE_PANEL}>
        <SigninState tile={state.kind === "accepted" ? "mail" : "stop"} heading={done[0]} text={done[1]}>
          {state.kind === "accepted" && (
            <a href="/signin" class={cx(LINK, "self-start")}>
              Sign in
            </a>
          )}
        </SigninState>
      </SigninFrame>
    );
  const heading = `${inv.inviter} invited you to join ${inv.organization}`;
  const role = (
    <>
      You will join as {inv.role === "admin" ? "an" : "a"} <strong class="text-ink">{inv.role}</strong>:{" "}
      {ROLE_WORDS[inv.role] ?? ROLE_WORDS.member}
    </>
  );
  if (state.kind === "someone-else")
    return (
      <SigninFrame title="Invitation" panel={INVITE_PANEL}>
        <SigninState
          tile="stop"
          heading="This invitation is for another address"
          text={`You are signed in as ${state.signedInAs}, but ${inv.inviter} invited ${inv.email}. Sign out, then sign in as ${inv.email} to accept it.`}
        >
          <form method="post" action="/auth/sign-out" data-busy>
            <Hidden name="next" value={path} />
            <Button type="submit" variant="dark" data-busy-label="Signing out…">
              Sign out
            </Button>
          </form>
        </SigninState>
      </SigninFrame>
    );
  const problem = "problem" in state && state.problem;
  return (
    <SigninFrame title="Invitation" panel={INVITE_PANEL}>
      <section class="flex flex-col gap-24">
        <div class="flex flex-col gap-12">
          <p class="type-eyebrow text-orange-text">Invitation</p>
          <h1 class="type-h2 wrap-anywhere">{heading}</h1>
          <p class="text-16 text-muted">{role}</p>
        </div>
        {problem && (
          <p role="alert" class="text-14 text-mal weight-text-strong">
            {problem}
          </p>
        )}
        {state.kind === "signed-out" ? (
          <Facts
            rows={[
              ["Invited address", inv.email],
              ["Invitation expires", sast(inv.expiresAt)],
            ]}
          >
            <p class="text-14 text-muted">Sign in as {inv.email} to accept. We email a link to that address.</p>
            <form method="post" action="/signin/link" data-busy>
              <Hidden name="email" value={inv.email} />
              <Hidden name="callbackURL" value={path} />
              <Button type="submit" variant="primary" class="w-full" data-busy-label="Sending…">
                Email me a sign-in link
              </Button>
            </form>
          </Facts>
        ) : (
          <Facts
            rows={[
              ["Signing in as", ("signedInAs" in state && state.signedInAs) || inv.email],
              ["Invitation expires", sast(inv.expiresAt)],
            ]}
          >
            <form method="post" action={path} data-busy>
              <Hidden name="action" value="accept" />
              <Button type="submit" variant="primary" class="w-full" data-busy-label="Joining…">
                Accept and join
              </Button>
            </form>
            <form method="post" action={path} data-busy class="self-center">
              <Hidden name="action" value="decline" />
              <Button type="submit" variant="link" data-busy-label="Declining…">
                Not you? Decline
              </Button>
            </form>
          </Facts>
        )}
      </section>
    </SigninFrame>
  );
}
