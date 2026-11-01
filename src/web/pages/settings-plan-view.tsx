// The Plan page (D07 T08 §4; design/SPEC.md M10, board `Plan`): what the organisation has, what is coming and how much of
// today it has used. Read-only for every role: there is no checkout, and nothing is billed during the launch. The words
// are chosen here from the plan the route read (`planOf`) and the day's usage (`todayUsage`); nothing from outside reaches
// the page but the organisation's name, drawn escaped.
import { AppShell, type MemberShellProps } from "../components/AppShell";
import { cx } from "../components/attrs";
import { Button } from "../components/Button";
import { Document } from "../components/Document";
import { Pill } from "../components/Pill";

const SAST_DAY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});
// "Fri 7 Nov 2026": a date in South Africa's time.
export function sastDate(iso: string): string {
  const part = Object.fromEntries(SAST_DAY.formatToParts(new Date(iso)).map(({ type, value }) => [type, value]));
  return `${part.weekday} ${part.day} ${part.month} ${part.year}`;
}

// The plan as `planOf` returns it (src/auth/plans.ts), declared here so this view, drawn in the browser tests, takes no
// Worker module; the route passes `planOf`'s own value and the types must keep matching.
export type PlanState =
  | { plan: "trial"; trialEndsAt: string; daysLeft: number }
  | { plan: "free"; trialEndedAt: string | null }
  | { plan: "protect" | "msp" };
// The trial's length (src/auth/plans.ts TRIAL_DAYS; test/web/plan.test.ts holds the two together).
export const TRIAL_DAYS = 14;

const SUPPORT = "mailto:support@isitlegit.co.za";

export type Usage = { used: number; limit: number };

// The status card's words for a plan. `startedAt` is when the organisation was made, the trial's own start: a trial whose
// end sits about `TRIAL_DAYS` after it is the ordinary one (days used out of fourteen, a progress bar); any other end is
// one the operator moved, so only what can be said truthfully is said (days left, the new end, days so far).
export function statusOf(
  plan: PlanState,
  orgName: string,
  startedAt: string | null,
  now = new Date(),
): { heading: string; big: string; text: string; used?: string; progress?: number } {
  if (plan.plan === "trial") {
    const days = plan.daysLeft;
    // The end `planOf` works out for an organisation with no extension is its creation plus the trial's length, to the
    // millisecond; a stored end of any other instant, even one hour later, is the operator's.
    const ordinary =
      startedAt !== null &&
      Math.abs(Date.parse(plan.trialEndsAt) - Date.parse(startedAt) - TRIAL_DAYS * 86_400_000) < 1000;
    const text = `Everything in Protect is switched on until ${sastDate(plan.trialEndsAt)}. After that ${orgName} keeps free checks; we will ask before anything is charged.`;
    const left = `${days} ${days === 1 ? "day" : "days"} left`;
    if (ordinary) {
      const used = Math.min(TRIAL_DAYS, Math.max(0, TRIAL_DAYS - days));
      return {
        heading: "Protect trial",
        big: `${left} of your ${TRIAL_DAYS}-day trial`,
        text,
        used: `${used} of ${TRIAL_DAYS} days`,
        progress: Math.round((used / TRIAL_DAYS) * 100),
      };
    }
    const sofar = startedAt ? Math.max(0, Math.floor((now.getTime() - Date.parse(startedAt)) / 86_400_000)) : null;
    return {
      heading: "Protect trial",
      big: `${left} of your extended trial`,
      text,
      ...(sofar !== null ? { used: `${sofar} ${sofar === 1 ? "day" : "days"} so far` } : {}),
    };
  }
  if (plan.plan === "free")
    return {
      heading: "Free check",
      big: "You are on the free plan",
      text: plan.trialEndedAt
        ? `The Protect trial ended on ${sastDate(plan.trialEndedAt)}. ${orgName} keeps free checks; Protect features are switched off.`
        : `${orgName} is on the free plan: free checks, with Protect features switched off.`,
    };
  const name = plan.plan === "msp" ? "MSP" : "Protect";
  return { heading: name, big: `You are on ${name}`, text: `Everything in ${name} is switched on for ${orgName}.` };
}

// The usage card's words: used of limit, what is left (never below zero), and when it resets, or that checking is paused.
export function usageOf(usage: Usage): { paused: boolean; left: number; percent: number; line: string } {
  const { used, limit } = usage;
  const paused = limit <= 0;
  const left = Math.max(0, limit - used);
  const percent = paused ? 100 : Math.min(100, Math.round((Math.max(0, used) / limit) * 100));
  return { paused, left, percent, line: `${used} of ${limit} checks used` };
}

const TIERS = [
  {
    id: "free",
    name: "Free check",
    price: "R0",
    per: "",
    items: ["Verdicts on forwarded mail", "See whether a business is Protected", "Up to 5 checks a day"],
  },
  {
    id: "protect",
    name: "Protect",
    price: "from R499",
    per: "per month",
    items: [
      "Protected identity, signature badge and website seal",
      "Impersonation alerts",
      "Staff inbox checks",
      "Invoice bank-change detection and supplier ledger",
      "Closed-loop bank verification",
      "Impersonation monitor for fake websites",
      "Payment document check",
    ],
  },
  {
    id: "msp",
    name: "MSP",
    price: "from R199",
    per: "per client per month",
    items: ["For IT providers", "Protect for every client", "One console for all clients", "Your own branding"],
  },
] as const;

const CARD = "bg-surface border border-line rounded-card-large p-24";

export function PlanPage(props: {
  shell: Omit<MemberShellProps, "children">;
  plan: PlanState;
  usage: Usage;
  // When the organisation was made: the trial's start.
  startedAt?: string | null;
  now?: Date;
  // Where the member came from, a same-site path the route validated.
  from?: string | null;
}) {
  const { shell, plan, usage } = props;
  const orgName = shell.organization.name;
  const status = statusOf(plan, orgName, props.startedAt ?? null, props.now);
  const u = usageOf(usage);
  const current = plan.plan === "trial" || plan.plan === "protect" ? "protect" : plan.plan === "msp" ? "msp" : "free";
  return (
    <Document title="Plan">
      <AppShell {...shell}>
        <div class="flex flex-col gap-24 px-16 py-24 md:px-56 md:py-40">
          <header class="flex flex-col gap-4 min-w-0">
            <h1 class="type-h1">Plan</h1>
            <p class="type-small text-muted">Free during launch. No card, no billing.</p>
          </header>
          <section aria-labelledby="status-heading" class={cx(CARD, "flex flex-col gap-12")}>
            <div class="flex flex-wrap items-center justify-between gap-12">
              <h2 id="status-heading" class="type-h3">
                {status.heading}
              </h2>
              {plan.plan === "trial" && (
                <Pill variant="suspicious" size="compact">
                  Trial
                </Pill>
              )}
            </div>
            <p class="type-h2 wrap-anywhere">{status.big}</p>
            <p class="text-muted wrap-anywhere">{status.text}</p>
            {status.used && (
              <div class="flex flex-col gap-4">
                {status.progress !== undefined && (
                  <span
                    role="progressbar"
                    aria-label="Trial used"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    aria-valuenow={String(status.progress)}
                    class="block h-8 w-full rounded-small bg-subtle"
                  >
                    <span class="block h-8 rounded-small bg-orange-text" style={`width: ${status.progress}%`} />
                  </span>
                )}
                <p class="type-small text-muted">
                  Trial used: <strong class="text-ink">{status.used}</strong>
                </p>
              </div>
            )}
          </section>
          <section aria-labelledby="usage-heading" class={cx(CARD, "flex flex-col gap-12")}>
            <h2 id="usage-heading" class="type-h3">
              Today's checks
            </h2>
            {u.paused ? (
              <>
                <p class="type-h2">Paused by IsItLegit</p>
                <p class="text-muted">
                  Checks are paused for {orgName}, and nothing resets at midnight.{" "}
                  <a class="underline" href={SUPPORT}>
                    Tell us
                  </a>{" "}
                  and we will turn them back on.
                </p>
              </>
            ) : (
              <>
                <p class="type-small text-muted">Resets at midnight SAST</p>
                <p class="type-h2">{u.line}</p>
                <span
                  role="progressbar"
                  aria-label="Checks used today"
                  aria-valuemin="0"
                  aria-valuemax={String(usage.limit)}
                  aria-valuenow={String(Math.min(usage.used, usage.limit))}
                  class="block h-8 w-full rounded-small bg-subtle"
                >
                  <span class="block h-8 rounded-small bg-orange-text" style={`width: ${u.percent}%`} />
                </span>
                <p class="type-small weight-text-strong">{u.left} left today</p>
                <p class="type-small text-muted">
                  The daily limit keeps the launch free for everyone. When it is reached, forwarded mail gets a short
                  reply saying when checking resumes. Need more?{" "}
                  <a class="underline text-orange-text" href={SUPPORT}>
                    Tell us
                  </a>
                  .
                </p>
              </>
            )}
          </section>
          <section aria-labelledby="tiers-heading" class="flex flex-col gap-16">
            <h2 id="tiers-heading" class="type-h3">
              What each plan includes
            </h2>
            <div class="grid gap-24 md:grid-cols-3">
              {TIERS.map((t) => (
                <article
                  aria-labelledby={`tier-${t.id}`}
                  class={cx(CARD, "flex flex-col gap-12", t.id === current && "border-ink")}
                  {...(t.id === current ? { "data-current": "true" } : {})}
                >
                  <div class="flex items-center justify-between gap-12">
                    <h3 id={`tier-${t.id}`} class="type-h3">
                      {t.name}
                    </h3>
                    {t.id === current && (
                      <Pill variant="neutral" size="compact">
                        {plan.plan === "trial" ? "Your trial" : "Your plan"}
                      </Pill>
                    )}
                  </div>
                  <p class="type-h2">
                    {t.price} {t.per && <span class="type-small text-muted">{t.per}</span>}
                  </p>
                  <ul class="flex flex-col gap-8 text-muted">
                    {t.items.map((item) => (
                      <li>{item}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
            <p class="type-small text-muted">
              Launch prices, shown so you know what comes next. Nothing is billed during the launch.
            </p>
          </section>
          <div>
            <Button variant="ghost" href={props.from ?? "/cases"}>
              {props.from ? "Back" : "Back to cases"}
            </Button>
          </div>
        </div>
      </AppShell>
    </Document>
  );
}
