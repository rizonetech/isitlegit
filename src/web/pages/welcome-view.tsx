// The onboarding checklist (D07 T08 §2; design/SPEC.md A4, board `Welcome`): five steps that tick themselves from stored
// state, the check address, the plan, and for the judges' organisation a banner above the list. Every word that is not
// fixed is chosen here from the counts the route read; the organisation's and the domain's names are drawn escaped.
import { AppShell, CHECK_ADDRESS, type MemberShellProps } from "../components/AppShell";
import { cx } from "../components/attrs";
import { Button } from "../components/Button";
import { Document } from "../components/Document";
import { CheckIcon } from "../components/icons";
import { Pill } from "../components/Pill";

// What the route read for the organisation (src/web/pages/welcome.tsx `stepsOf`).
export type Steps = {
  domain: string | null;
  members: number;
  emailed: boolean;
  suppliers: number;
  protectedIdentity: boolean;
};
// The plan as `planOf` returns it (src/auth/plans.ts); the route passes its own value.
export type WelcomePlan =
  | { plan: "trial"; daysLeft: number }
  | { plan: "free"; trialEnded: boolean }
  | { plan: "protect" | "msp" };

export const STEP_COUNT = 5;
export const doneCount = (s: Steps) =>
  [s.domain !== null, s.members >= 2, s.emailed, s.suppliers >= 1, s.protectedIdentity].filter(Boolean).length;

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
// The trial card's words for each plan the organisation can be on.
export function planCard(plan: WelcomePlan): { title: string; text: string } {
  switch (plan.plan) {
    case "trial":
      return {
        title: "Your trial",
        text:
          plan.daysLeft <= 1
            ? "Your trial ends today. Everything in Protect is free until then. No card needed."
            : `Everything in Protect for ${days(plan.daysLeft)}, free. No card needed.`,
      };
    case "free":
      return {
        title: "Your plan",
        text: plan.trialEnded
          ? "Your trial has ended and you are on the Free plan. See what Protect adds."
          : "You are on the Free plan. See what Protect adds.",
      };
    case "protect":
      return { title: "Your plan", text: "You are on the Protect plan." };
    case "msp":
      return { title: "Your plan", text: "You are on the MSP plan." };
  }
}

const CARD = "bg-surface border border-line rounded-card-large";

type Step = {
  n: number;
  title: string;
  done: boolean;
  text: string;
  action: unknown;
};

function Tick() {
  return (
    <span
      aria-hidden="true"
      class="inline-flex h-40 w-40 flex-none items-center justify-center rounded-pill bg-safe text-on-dark"
    >
      <CheckIcon />
    </span>
  );
}
function Number_(props: { n: number }) {
  return (
    <span
      aria-hidden="true"
      class="inline-flex h-40 w-40 flex-none items-center justify-center rounded-pill border-2 border-line-strong text-16 weight-heading"
    >
      {props.n}
    </span>
  );
}

export function WelcomePage(props: {
  shell: Omit<MemberShellProps, "children">;
  firstName: string;
  steps: Steps;
  plan: WelcomePlan;
  // The reader may verify a domain and invite people (an owner or admin).
  canSetup: boolean;
  // The organisation is the judges' (its metadata flags it): the banner above the list.
  judge: boolean;
  hidden: boolean;
}) {
  const { shell, steps, plan, canSetup, judge, hidden } = props;
  const org = shell.organization;
  const done = doneCount(steps);
  const ownerOnly = <span class="type-small text-muted">An owner or admin does this</span>;
  const list: Step[] = [
    {
      n: 1,
      title: "Verify your domain",
      done: steps.domain !== null,
      text:
        steps.domain !== null
          ? `${steps.domain} is verified, so your team's mail is accepted at check@.`
          : "Prove your company domain is yours, so mail your team forwards is accepted at check@.",
      action: canSetup ? (
        <Button variant="primary" href="/settings/domains">
          Verify a domain
        </Button>
      ) : (
        ownerOnly
      ),
    },
    {
      n: 2,
      title: "Invite your team",
      done: steps.members >= 2,
      text:
        steps.members >= 2
          ? `${steps.members} people joined. Everyone who reads supplier mail should be here.`
          : "Everyone who reads supplier mail should be here. Invite them so they can check mail too.",
      action: canSetup ? (
        <Button variant="primary" href="/team">
          Invite people
        </Button>
      ) : (
        ownerOnly
      ),
    },
    {
      n: 3,
      title: "Forward your first email",
      done: steps.emailed,
      text: steps.emailed
        ? "You have forwarded an email and seen its report."
        : `Pick any email you are unsure about and forward it as an attachment to ${CHECK_ADDRESS}.`,
      action: (
        <Button variant="primary" href="/settings/domains#forwarding-heading">
          Show me how
        </Button>
      ),
    },
    {
      n: 4,
      title: "Add your suppliers",
      done: steps.suppliers >= 1,
      text:
        steps.suppliers >= 1
          ? `${steps.suppliers} ${steps.suppliers === 1 ? "supplier" : "suppliers"} added, so changed bank details on an invoice are caught.`
          : "Upload who you pay and their bank details, so changed details on an invoice are caught.",
      action: (
        <Button variant="ghost" href="/suppliers">
          Add suppliers
        </Button>
      ),
    },
    {
      n: 5,
      title: "Protect your business",
      done: steps.protectedIdentity,
      text: steps.protectedIdentity
        ? "Your logo and bank accounts are registered, so mail pretending to be you is caught."
        : "Register your logo and bank accounts so mail pretending to be you is caught.",
      action: (
        <Button variant="ghost" href="/protect">
          {`Protect ${org.name}`}
        </Button>
      ),
    },
  ];
  const card = planCard(plan);
  const body = (
    <div class="flex flex-col gap-24 px-16 py-24 md:px-56 md:py-40">
      <header class="flex flex-col gap-8 min-w-0">
        <p class="type-eyebrow text-orange-text wrap-anywhere">{`Welcome, ${props.firstName}`}</p>
        <h1 class="type-h1">Five steps to a business that is hard to fool</h1>
        <p class="text-muted">Most teams finish in about ten minutes. You can come back to this list from Cases.</p>
      </header>
      {judge && (
        <section
          aria-labelledby="judge-heading"
          class="flex flex-wrap items-center justify-between gap-16 rounded-card-large border border-orange-text bg-orange-wash p-24"
        >
          <div class="flex min-w-0 flex-1 flex-col gap-8">
            <h2 id="judge-heading" class="type-h3">
              Welcome, judges. This organisation is ready to explore.
            </h2>
            <p>
              It holds sample cases on fictional companies: a phishing email, an invoice with changed bank details, a
              voice note and a safe statement. Forward your own test email to {CHECK_ADDRESS} to see a live check.
            </p>
            <p class="type-small text-muted">Sample data on a fictional company.</p>
          </div>
          <Button variant="dark" href="/cases">
            Open the sample cases
          </Button>
        </section>
      )}
      <div class="grid gap-24 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <section aria-labelledby="steps-heading" class={cx(CARD, "flex flex-col")}>
          <div class="flex flex-col gap-12 p-24">
            <div class="flex flex-wrap items-center justify-between gap-12">
              <h2 id="steps-heading" class="type-h3">
                {`${done} of ${STEP_COUNT} done`}
              </h2>
              {hidden ? (
                <form method="post" action="/welcome">
                  <input type="hidden" name="action" value="show" />
                  <button type="submit" class="underline text-orange-text">
                    Show this list again
                  </button>
                </form>
              ) : (
                <form method="post" action="/welcome">
                  <input type="hidden" name="action" value="hide" />
                  <button type="submit" class="underline text-orange-text">
                    Hide this list
                  </button>
                </form>
              )}
            </div>
            <span
              role="progressbar"
              aria-label="Setup progress"
              aria-valuemin="0"
              aria-valuemax={String(STEP_COUNT)}
              aria-valuenow={String(done)}
              aria-valuetext={`${done} of ${STEP_COUNT} steps done`}
              class="block h-8 w-full rounded-small bg-subtle"
            >
              <span
                class="block h-8 rounded-small bg-safe"
                style={`width: ${Math.round((done / STEP_COUNT) * 100)}%`}
              />
            </span>
          </div>
          <ol class="flex flex-col">
            {list.map((s) => (
              <li class="flex flex-wrap items-center gap-16 border-t border-line p-24">
                {s.done ? <Tick /> : <Number_ n={s.n} />}
                <div class="flex min-w-0 flex-1 basis-64 flex-col gap-4">
                  <h3 class="type-h4 wrap-anywhere">
                    {s.title}
                    {s.done && <span class="sr-only">, done</span>}
                  </h3>
                  <p class="text-muted wrap-anywhere">{s.text}</p>
                </div>
                <div class="flex-none">{s.done ? <Pill variant="safe">Done</Pill> : s.action}</div>
              </li>
            ))}
          </ol>
        </section>
        <div class="flex flex-col gap-16">
          <section
            aria-labelledby="address-heading"
            data-copy-group
            class="flex flex-col gap-12 rounded-card-large bg-dark p-24 text-on-dark"
          >
            <h2 id="address-heading" class="type-eyebrow text-orange-on-dark">
              Your check address
            </h2>
            <p data-copy-source class="type-h3 font-mono wrap-anywhere">
              {CHECK_ADDRESS}
            </p>
            <p>Save it as a contact called "Is it legit?" so it is one tap away.</p>
            <div>
              <Button variant="primary" data-copy={CHECK_ADDRESS}>
                Copy address
              </Button>
            </div>
            <p data-copy-status role="status" aria-live="polite" class="type-small" />
          </section>
          <section aria-labelledby="plan-heading" class={cx(CARD, "flex flex-col gap-8 p-24 bg-subtle")}>
            <h2 id="plan-heading" class="type-h4">
              {card.title}
            </h2>
            <p class="text-muted">{card.text}</p>
            <a class="underline text-orange-text" href="/settings/plan?from=%2Fwelcome">
              See the plan
            </a>
          </section>
        </div>
      </div>
    </div>
  );
  return (
    <Document title="Welcome">
      <AppShell {...shell}>{body}</AppShell>
    </Document>
  );
}
