import type { Child } from "hono/jsx";
import {
  type AdminShellProps,
  AppShell,
  type AppShellProps,
  CHECK_ADDRESS,
  type MemberShellProps,
  type PublicShellProps,
} from "../components/AppShell";
import { Button } from "../components/Button";
import { Checkbox } from "../components/Checkbox";
import { Document } from "../components/Document";
import {
  EvidenceCard,
  EvidenceFigure,
  EvidenceQuote,
  EvidenceRef,
  type Severity,
  SeverityPill,
} from "../components/Evidence";
import { Field } from "../components/Field";
import { CopyIcon, MenuIcon } from "../components/icons";
import { Pill, type PillVariant } from "../components/Pill";
import {
  EmptyState,
  type ErrorCode,
  ErrorState,
  LoadingState,
  PartialNotice,
  referenceLine,
} from "../components/States";
import { VerdictBadge, VerdictBand, type VerdictBandProps } from "../components/Verdict";

// The component gallery (D07 T01 §10): every shared component in every state on one development page, and every frame
// of the shell in a document of its own, so the set is seen and checked together (test/node/gallery.test.tsx,
// test/node/a11y.test.tsx, test/node/rendered-colours.test.ts) before any page builds on it. Served only in development
// (src/index.ts). Sample words are the boards' fictional ones.

type State = { id: string; render: () => Child };

const at = new Date("2026-10-27T08:12:00Z");
const BANDS: [string, Omit<VerdictBandProps, "children">][] = [
  [
    "complete-malicious",
    { state: "complete", verdict: "malicious", confidence: "high", headline: "Do not pay this invoice" },
  ],
  [
    "complete-suspicious",
    { state: "complete", verdict: "suspicious", confidence: "medium", headline: "Check before you pay" },
  ],
  [
    "complete-safe",
    { state: "complete", verdict: "safe", confidence: "high", headline: "This looks like a real invoice" },
  ],
  ["partial", { state: "partial", verdict: "suspicious", confidence: "medium", headline: "Check before you pay" }],
  ["failed", { state: "failed", headline: "We could not finish checking this email" }],
  ["running", { state: "running", elapsed: 21, headline: "We are investigating this email" }],
];
const PILLS: PillVariant[] = ["safe", "suspicious", "malicious", "partial", "running", "neutral", "brand", "alert"];
const LEVELS: Severity[] = ["critical", "high", "medium", "low", "info", "not-checked"];
const ERRORS: { code: ErrorCode; title: string; actions: Child[] }[] = [
  {
    code: 404,
    title: "We can't show you that page.",
    actions: [
      <Button variant="dark" href="/cases">
        Go to your cases
      </Button>,
    ],
  },
  {
    code: 403,
    title: "You're not a member of this organisation.",
    actions: [
      <Button variant="dark" href="/cases">
        Go to your own cases
      </Button>,
    ],
  },
  {
    code: 410,
    title: "This report link has expired.",
    actions: [
      <Button variant="dark" href="/signin">
        Sign in to see the case
      </Button>,
    ],
  },
  {
    code: 429,
    title: "You've reached today's limit of 50 checks.",
    actions: [
      <Button variant="dark" href="/settings/plan">
        See your plan
      </Button>,
    ],
  },
  {
    code: 500,
    title: "Sorry, something broke on our side.",
    actions: [
      <Button variant="dark" href="/cases">
        Try again
      </Button>,
    ],
  },
  {
    code: "maintenance",
    title: "We're upgrading IsItLegit. Back by 02:30 SAST.",
    actions: [
      <Button variant="ghost" href="/cases">
        Reload
      </Button>,
    ],
  },
];

// Every state, each its own item: the list the gallery test asserts one by one.
export const GALLERY_STATES: State[] = [
  ...(["primary", "dark", "ghost", "danger", "link"] as const).map((variant) => ({
    id: `button/${variant}`,
    render: () => <Button variant={variant}>Check a file</Button>,
  })),
  { id: "button/small", render: () => <Button size="small">Clear filters</Button> },
  { id: "button/icon", render: () => <Button size="icon" label="Copy the check address" icon={<CopyIcon />} /> },
  { id: "button/small-icon", render: () => <Button size="small-icon" label="Menu" icon={<MenuIcon />} /> },
  {
    id: "button/disabled",
    render: () => (
      <Button id="gallery-remove" variant="danger" disabled disabledReason="An organisation keeps at least one owner.">
        Remove
      </Button>
    ),
  },
  { id: "field/plain", render: () => <Field id="g-email" label="Work email" name="email" type="email" /> },
  {
    id: "field/hint",
    render: () => <Field id="g-hint" label="Organisation name" name="org" hint="As your clients know it." />,
  },
  {
    id: "field/error",
    render: () => <Field id="g-error" label="Invite code" name="code" error="That code is not valid." />,
  },
  {
    id: "field/hint-and-error",
    render: () => (
      <Field id="g-both" label="Domain" name="domain" hint="Without www." error="Enter a domain you own." />
    ),
  },
  {
    id: "field/code",
    render: () => (
      <Field
        id="g-code"
        label="Code from the email"
        name="code"
        inputmode="numeric"
        autocomplete="one-time-code"
        maxlength={7}
      />
    ),
  },
  {
    id: "checkbox/unchecked",
    render: () => (
      <Checkbox id="g-c1" name="a">
        Email me the weekly summary
      </Checkbox>
    ),
  },
  {
    id: "checkbox/checked",
    render: () => (
      <Checkbox id="g-c2" name="b" checked>
        Email me the weekly summary
      </Checkbox>
    ),
  },
  {
    id: "checkbox/required",
    render: () => (
      <Checkbox id="g-c3" name="consent" required>
        I agree to the processing described in the privacy notice
      </Checkbox>
    ),
  },
  {
    id: "checkbox/disabled",
    render: () => (
      <Checkbox id="g-c4" name="d" disabled>
        Only owners can change this
      </Checkbox>
    ),
  },
  ...PILLS.flatMap((variant) => [
    { id: `pill/${variant}`, render: () => <Pill variant={variant}>{variant}</Pill> },
    {
      id: `pill/${variant}-compact`,
      render: () => (
        <Pill variant={variant} size="compact">
          1 new
        </Pill>
      ),
    },
  ]),
  ...BANDS.map(([id, props]) => ({
    id: `verdict-band/${id}`,
    render: () => (
      <VerdictBand {...props}>The link opens a fake sign-in page that sends your password elsewhere.</VerdictBand>
    ),
  })),
  ...BANDS.map(([id, props]) => ({
    id: `verdict-badge/${id}`,
    render: () => <VerdictBadge state={props.state} {...(props.verdict ? { verdict: props.verdict } : {})} />,
  })),
  ...LEVELS.map((level) => ({ id: `severity/${level}`, render: () => <SeverityPill id="E7" level={level} /> })),
  { id: "evidence-ref", render: () => <EvidenceRef id="E7" level="critical" /> },
  {
    id: "evidence-card/split",
    render: () => (
      <EvidenceCard id="E7" level="critical" title="Muse Wonder walked the link" meta="6 steps · 31 s" layout="split">
        <EvidenceFigure caption="1. Lure page">
          <EvidenceQuote>nimbusmai1-login.example/invoice</EvidenceQuote>
        </EvidenceFigure>
        <EvidenceFigure caption="2. Where the password went" />
      </EvidenceCard>
    ),
  },
  {
    id: "evidence-card/compact",
    render: () => (
      <EvidenceCard id="E4" level="high" title="Lookalike domain, 3 days old" footnote="RDAP, registered 27 Oct">
        <EvidenceQuote>nimbusmai1-login.example</EvidenceQuote>
      </EvidenceCard>
    ),
  },
  {
    id: "empty/first-run",
    render: () => (
      <EmptyState
        layout="first-run"
        eyebrow="No cases yet"
        title="Check your first suspicious email."
        sentence="Forward it as an attachment, so its original headers come along."
      />
    ),
  },
  {
    id: "empty/filtered",
    render: () => (
      <EmptyState
        layout="filtered"
        title='No cases match "statement", Malicious, last 7 days.'
        sentence="64 cases in total. Try a wider date range or another verdict."
        action={<Button href="/cases">Clear filters</Button>}
      />
    ),
  },
  {
    id: "empty/filtered-without-action",
    render: () => (
      <EmptyState layout="filtered" title="No suppliers yet." sentence="Suppliers appear once you add one." />
    ),
  },
  { id: "loading", render: () => <LoadingState>Running</LoadingState> },
  ...ERRORS.map(({ code, title, actions }) => ({
    id: `error/${code}`,
    render: () => (
      <ErrorState
        code={code}
        title={title}
        actions={actions}
        footer={
          code === "maintenance" ? "Started 02:00 SAST · expected back 02:30 SAST" : referenceLine(`${code}-7F3K2Q`, at)
        }
      >
        One plain sentence on what happened and what to do next.
      </ErrorState>
    ),
  })),
  {
    id: "partial/one",
    render: () => (
      <PartialNotice
        ran={7}
        skipped={[{ name: "Google Web Risk", reason: "the service did not answer within 10 seconds." }]}
      />
    ),
  },
  {
    id: "partial/two",
    render: () => (
      <PartialNotice
        ran={6}
        skipped={[
          { name: "Walkthrough (Muse Wonder)", reason: "today's model limit was reached at 15:20." },
          { name: "Google Web Risk", reason: "the service did not answer within 10 seconds." },
        ]}
      />
    ),
  },
  {
    id: "copy-group",
    render: () => (
      <div data-copy-group class="flex flex-col gap-8">
        <div class="flex items-center gap-8">
          <span data-copy-source class="font-mono text-13 weight-text-strong">
            {CHECK_ADDRESS}
          </span>
          <Button size="icon" label="Copy the check address" icon={<CopyIcon />} data-copy={CHECK_ADDRESS} />
        </div>
        <p data-copy-status role="status" aria-live="polite" class="text-13 text-muted" />
      </div>
    ),
  },
];

// Every frame of the shell (§3) in the states it draws, each a document of its own.
const memberBase = {
  variant: "member" as const,
  organization: { id: "org-karoo", name: "Karoo Couriers" },
  user: { name: "Thandi Nkosi", role: "Owner" },
};
const MEMBER_PAGES = ["cases", "suppliers", "protect", "monitor", "team", "domains", "account", "plan"] as const;
const ADMIN_PAGES = ["overview", "orgs", "invites", "feedback", "eval"] as const;
type FrameProps =
  | Omit<MemberShellProps, "children">
  | Omit<AdminShellProps, "children">
  | Omit<PublicShellProps, "children">;
export const GALLERY_FRAMES: { id: string; props: FrameProps }[] = [
  ...MEMBER_PAGES.map((active) => ({
    id: `member-${active}`,
    props: { ...memberBase, active, otherOrganizations: [], monitorNew: 0, plan: { name: "Business" } },
  })),
  {
    id: "member-several-orgs",
    props: {
      ...memberBase,
      active: "cases",
      otherOrganizations: [{ id: "org-swartberg", name: "Swartberg Transport" }],
      monitorNew: 0,
      plan: { name: "Business" },
    },
  },
  {
    id: "member-trial-findings",
    props: { ...memberBase, active: "cases", otherOrganizations: [], monitorNew: 3, plan: { trialDaysLeft: 11 } },
  },
  ...ADMIN_PAGES.map((active) => ({
    id: `admin-${active}`,
    props: { variant: "admin" as const, active, feedbackOpen: 3, operator: "Rizonetech operator" },
  })),
  { id: "public", props: { variant: "public" as const } },
];

export function GalleryPage() {
  return (
    <Document title="Component gallery">
      <main id="content" class="flex flex-col gap-32 p-16 md:p-48 bg-subtle">
        <h1 class="type-h1">Component gallery</h1>
        {GALLERY_STATES.map((state) => (
          <section
            data-gallery-state={state.id}
            aria-labelledby={`gallery-${state.id.replace(/\W/g, "-")}`}
            class="flex flex-col gap-12"
          >
            <h2 id={`gallery-${state.id.replace(/\W/g, "-")}`} class="type-h4">
              {state.id}
            </h2>
            <div class="p-16 bg-surface border border-line rounded-card">{state.render()}</div>
          </section>
        ))}
        <h2 class="type-h2">Frames</h2>
        {GALLERY_FRAMES.map((frame) => (
          <section data-gallery-frame={frame.id} class="flex flex-col gap-12">
            <h3 class="type-h4">{frame.id}</h3>
            <iframe
              title={`The ${frame.id} frame`}
              src={`/dev/components/frame/${frame.id}`}
              height="720"
              class="w-full border border-line rounded-card bg-surface"
            />
          </section>
        ))}
      </main>
    </Document>
  );
}

// One frame in its own document, or null for a name the gallery does not list.
export function GalleryFrame(id: string) {
  const frame = GALLERY_FRAMES.find((f) => f.id === id);
  if (!frame) return null;
  return (
    <Document title={`Frame ${frame.id}`}>
      <AppShell {...(frame.props as AppShellProps)}>
        <h1 class="type-h2 p-24">{frame.id}</h1>
      </AppShell>
    </Document>
  );
}
