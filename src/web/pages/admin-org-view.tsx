// The organisation detail page (D07 T08 §5; design/SPEC.md X2, board `Admin-Org`): the header with the plan pill
// and the Extend trial and Change daily cap controls (Suspend waits on §22), the onboarding card drawn from the
// same steps as the member checklist, domains, members, cases by week, top threats, this organisation's feedback
// and the plan card. Server-rendered; every number and row comes from the database in the routes, and this file
// only draws what it is given. The threats card omits money at risk until §23 lands the invoice lane's amounts.
import { AppShell } from "../components/AppShell";
import { cx, FOCUS } from "../components/attrs";
import { Button } from "../components/Button";
import { Document } from "../components/Document";
import { Field } from "../components/Field";
import { Pill } from "../components/Pill";
import { Select } from "../components/Select";
import type { Shell } from "./admin-view";

export type OnboardingStep = { title: string; done: boolean; detail: string };
export type DomainRow = { domain: string; state: "Verified" | "Pending"; detail: string };
export type MemberRow = { name: string; role: string };
export type WeekBar = { label: string; total: number; bad: number };
export type ThreatRow = { name: string; count: number; top: number };
export type OrgFeedbackRow = {
  caseTitle: string;
  caseHref: string;
  verdict: "Safe" | "Suspicious" | "Malicious";
  theySay: "Safe" | "Unsafe";
  status: "New" | "Triaged" | "Closed";
};

export type OrgDetailProps = {
  shell: Shell;
  orgId: string;
  header: { name: string; planPill: string; meta: string };
  extendTrial: {
    enabled: boolean;
    reason: string | null;
    min: string;
    value: string;
    notice: string | null;
    error: string | null;
  };
  cap: { value: string; error: string | null; notice: string | null };
  plan: { current: "trial" | "free" | "protect" | "msp" | null; error: string | null; notice: string | null };
  onboarding: { done: number; steps: OnboardingStep[] };
  domains: DomainRow[];
  members: MemberRow[];
  weeks: WeekBar[];
  threats: ThreatRow[];
  feedback: OrgFeedbackRow[];
  feedbackHref: string;
  planLines: string[];
};

function OnboardingCard(props: { done: number; steps: OnboardingStep[] }) {
  return (
    <section class="card card-pad flex flex-col gap-16" aria-label="Onboarding">
      <h2 class="type-h3">Onboarding</h2>
      <p class="small muted">{props.done} of 5 done</p>
      <div class="h-10 rounded-full bg-subtle" role="img" aria-label={`${props.done} of 5 onboarding steps done`}>
        <div class="h-10 rounded-full bg-ink" style={`width: ${(props.done / 5) * 100}%`} />
      </div>
      <ul class="flex flex-col gap-8">
        {props.steps.map((step) => (
          <li class="flex items-center gap-8">
            <Pill variant={step.done ? "safe" : "neutral"}>{step.done ? "Done" : "Open"}</Pill>
            <div>
              <p class="small weight-text-strong">{step.title}</p>
              <p class="tiny muted">{step.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DomainsCard(props: { domains: DomainRow[] }) {
  return (
    <section class="card card-pad flex flex-col gap-16" aria-label="Domains">
      <h2 class="type-h3">Domains</h2>
      {props.domains.length === 0 ? (
        <p class="small muted">No domains yet.</p>
      ) : (
        <ul class="flex flex-col gap-12">
          {props.domains.map((row) => (
            <li class="flex flex-col gap-2">
              <div class="flex justify-between items-center gap-8">
                <p class="small weight-text-strong font-mono">{row.domain}</p>
                <Pill variant={row.state === "Verified" ? "safe" : "suspicious"}>{row.state}</Pill>
              </div>
              <p class="tiny muted">{row.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MembersCard(props: { members: MemberRow[] }) {
  return (
    <section class="card card-pad flex flex-col gap-16" aria-label="Members">
      <h2 class="type-h3">Members</h2>
      {props.members.length === 0 ? (
        <p class="small muted">No members yet.</p>
      ) : (
        <ul class="flex flex-col gap-8">
          {props.members.map((row) => (
            <li class="flex justify-between items-center gap-8">
              <p class="small">{row.name}</p>
              <Pill variant={row.role === "Invited" ? "running" : "neutral"}>{row.role}</Pill>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CasesCard(props: { weeks: WeekBar[] }) {
  const max = Math.max(1, ...props.weeks.map((week) => week.total));
  return (
    <section class="card card-pad flex flex-col gap-16" aria-label="Cases by week">
      <div class="flex justify-between items-baseline gap-8 flex-wrap">
        <h2 class="type-h3">Cases by week</h2>
        <p class="tiny muted">Malicious and suspicious in colour</p>
      </div>
      <div
        class="grid grid-cols-3 gap-16 items-end"
        role="img"
        aria-label={props.weeks
          .map((week) => `${week.label}: ${week.total} cases, ${week.bad} malicious or suspicious`)
          .join("; ")}
      >
        {props.weeks.map((week) => (
          <div class="flex flex-col gap-4 items-center">
            <p class="type-h3 font-text tabular-nums">{week.total}</p>
            <div class="w-full rounded-card bg-subtle flex flex-col justify-end" style="height: 120px">
              <div class="w-full rounded-card bg-mal" style={`height: ${(week.bad / max) * 100}%`} />
              <div class="w-full" style={`height: ${((week.total - week.bad) / max) * 100}%`} />
            </div>
            <p class="tiny muted">{week.label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function ThreatsCard(props: { threats: ThreatRow[] }) {
  return (
    <section class="card card-pad flex flex-col gap-16" aria-label="Top threats, 30 days">
      <h2 class="type-h3">Top threats, 30 days</h2>
      {props.threats.length === 0 ? (
        <p class="small muted">No threats caught in the last 30 days.</p>
      ) : (
        <ul class="flex flex-col gap-12">
          {props.threats.map((row) => (
            <li class="flex flex-col gap-4">
              <div class="flex justify-between gap-8">
                <p class="small">{row.name}</p>
                <p class="small weight-text-strong tabular-nums">{row.count}</p>
              </div>
              <div class="h-10 rounded-full bg-subtle" role="img" aria-label={`${row.name}: ${row.count}`}>
                <div class="h-10 rounded-full bg-ink" style={`width: ${(row.count / Math.max(1, row.top)) * 100}%`} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FeedbackCard(props: { feedback: OrgFeedbackRow[]; href: string }) {
  return (
    <section class="card card-pad flex flex-col gap-16 min-w-0" aria-label="Feedback from this organisation">
      <div class="flex justify-between items-center gap-8">
        <h2 class="type-h3">Feedback from this organisation</h2>
        <a href={props.href} class={cx("small text-orange-text underline", FOCUS)}>
          Open queue
        </a>
      </div>
      {props.feedback.length === 0 ? (
        <p class="small muted">No feedback from this organisation.</p>
      ) : (
        <section class="card overflow-x-auto" tabindex={0} aria-label="Recent feedback">
          <table class="table min-w-[520px] w-full">
            <thead>
              <tr>
                <th class="sticky left-0 bg-surface">Case</th>
                <th>Our verdict</th>
                <th>They said</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {props.feedback.map((row) => (
                <tr>
                  <td class="sticky left-0 bg-surface">
                    <a href={row.caseHref} class="weight-text-strong">
                      {row.caseTitle}
                    </a>
                  </td>
                  <td>
                    <Pill
                      variant={
                        row.verdict === "Safe" ? "safe" : row.verdict === "Suspicious" ? "suspicious" : "malicious"
                      }
                    >
                      {row.verdict}
                    </Pill>
                  </td>
                  <td>
                    {row.theySay === "Safe" ? <Pill variant="safe">Safe</Pill> : <Pill variant="neutral">Unsafe</Pill>}
                  </td>
                  <td>
                    <Pill
                      variant={row.status === "New" ? "running" : row.status === "Triaged" ? "suspicious" : "neutral"}
                    >
                      {row.status}
                    </Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </section>
  );
}

export function OrgDetailPage(props: OrgDetailProps) {
  return (
    <Document title={`${props.header.name} · IsItLegit admin`}>
      <AppShell variant="admin" active="orgs" feedbackOpen={props.shell.feedbackOpen} operator={props.shell.operator}>
        <div class="flex flex-col gap-24 px-16 py-24 md:px-56 md:py-40">
          <nav aria-label="Breadcrumb">
            <a href="/admin" class={cx("small text-orange-text underline", FOCUS)}>
              Organisations
            </a>
            <span class="small muted"> / {props.header.name}</span>
          </nav>
          <div class="flex justify-between items-center gap-16 flex-wrap">
            <div class="flex items-center gap-8">
              <h1 class="type-h1">{props.header.name}</h1>
              <Pill variant="neutral">{props.header.planPill}</Pill>
            </div>
            <div class="flex gap-8 flex-wrap">
              <form method="post" action={`/admin/orgs/${props.orgId}/trial`} class="flex gap-8 items-end">
                <Field
                  id="trial-until"
                  label="Trial until"
                  name="until"
                  type="text"
                  value={props.extendTrial.value}
                  placeholder="YYYY-MM-DD"
                  {...(props.extendTrial.error ? { error: props.extendTrial.error } : {})}
                />
                <Button
                  type="submit"
                  variant="ghost"
                  size="small"
                  {...(props.extendTrial.enabled
                    ? {}
                    : { disabled: true, ...(props.extendTrial.reason ? { title: props.extendTrial.reason } : {}) })}
                >
                  Extend trial
                </Button>
              </form>
              <form method="post" action={`/admin/orgs/${props.orgId}/cap`} class="flex gap-8 items-end">
                <Field
                  id="daily-cap"
                  label="Daily cap"
                  name="cap"
                  type="number"
                  value={props.cap.value}
                  placeholder="Plan default"
                  {...(props.cap.error ? { error: props.cap.error } : {})}
                />
                <Button type="submit" variant="ghost" size="small" name="action" value="set">
                  Change daily cap
                </Button>
                <Button type="submit" variant="ghost" size="small" name="action" value="clear">
                  Use plan limit
                </Button>
              </form>
            </div>
          </div>
          {props.cap.notice && (
            <p role="status" class="type-small weight-text-strong text-safe">
              {props.cap.notice}
            </p>
          )}
          {props.extendTrial.notice && (
            <p role="status" class="type-small weight-text-strong text-safe">
              {props.extendTrial.notice}
            </p>
          )}
          <p class="small muted">{props.header.meta}</p>
          <div class="grid gap-24 md:grid-cols-3">
            <OnboardingCard done={props.onboarding.done} steps={props.onboarding.steps} />
            <DomainsCard domains={props.domains} />
            <MembersCard members={props.members} />
          </div>
          <div class="grid gap-24 md:grid-cols-2">
            <CasesCard weeks={props.weeks} />
            <ThreatsCard threats={props.threats} />
          </div>
          <div class="grid gap-24 md:grid-cols-[1fr_320px]">
            <FeedbackCard feedback={props.feedback} href={props.feedbackHref} />
            <section class="card card-pad flex flex-col gap-8" aria-label="Plan">
              <h2 class="type-h3">Plan</h2>
              {props.planLines.map((line) => (
                <p class="small">{line}</p>
              ))}
              {props.plan.current !== null && (
                <form method="post" action={`/admin/orgs/${props.orgId}/plan`} class="flex flex-col gap-8">
                  <div class="flex flex-col gap-4">
                    <label for="plan" class="type-small weight-text-strong">
                      Change plan
                    </label>
                    <Select id="plan" name="plan">
                      {(["free", "protect", "msp"] as const).map((plan) => (
                        <option value={plan} selected={props.plan.current === plan}>
                          {plan === "free" ? "Free" : plan === "protect" ? "Protect" : "MSP"}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {props.plan.error && (
                    <p role="alert" class="type-small weight-text-strong text-danger">
                      {props.plan.error}
                    </p>
                  )}
                  <div>
                    <Button type="submit" variant="ghost" size="small">
                      Change plan
                    </Button>
                  </div>
                </form>
              )}
              {props.plan.notice && (
                <p role="status" class="type-small weight-text-strong text-safe">
                  {props.plan.notice}
                </p>
              )}
            </section>
          </div>
        </div>
      </AppShell>
    </Document>
  );
}
