import { raw } from "hono/html";
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
import { Select } from "../components/Select";
import {
  EmptyState,
  type ErrorCode,
  ErrorState,
  LoadingState,
  PartialNotice,
  referenceLine,
} from "../components/States";
import { VerdictBadge, VerdictBand, type VerdictBandProps } from "../components/Verdict";
import { GALLERY_SCRIPT } from "./gallery-script";

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
const FORWARD = (
  <>
    Forwarding still works: send suspicious mail to <strong class="font-mono text-ink">{CHECK_ADDRESS}</strong> as
    usual.
  </>
);
// The error boards' own compositions (design/SPEC.md 7): one or two actions, a note or a panel where the board has one.
const ERRORS: {
  code: ErrorCode;
  title: string;
  sentence: Child;
  actions: Child[];
  note?: Child;
  panel?: { lead: string; sentence: string };
}[] = [
  {
    code: 404,
    title: "We can't show you that page.",
    sentence:
      "It may not exist, the address may be mistyped, or it may belong to an organisation you are not part of. We don't say which, so case links never reveal anything.",
    actions: [
      <Button variant="dark" href="/cases">
        Go to your cases
      </Button>,
      <Button variant="ghost" href="/upload">
        Check a file
      </Button>,
    ],
    note: FORWARD,
  },
  {
    code: 403,
    title: "You're not a member of this organisation.",
    sentence: (
      <>
        You are signed in as <strong class="text-ink">ayesha@outeniquapaper.example</strong>, which has no access here.
        Ask an owner of the organisation to invite this address, or sign in with another one.
      </>
    ),
    actions: [
      <Button variant="dark" href="/cases">
        Go to your own cases
      </Button>,
      <Button variant="ghost" href="/signin">
        Sign out
      </Button>,
    ],
  },
  {
    code: 410,
    title: "This report link has expired.",
    sentence:
      "Links in our reply emails work for 7 days, so an old email can't be used to read a report. The case itself stays in your organisation's account: sign in to open it.",
    actions: [
      <Button variant="dark" href="/signin">
        Sign in to see the case
      </Button>,
    ],
    note: (
      <>
        No account? Forward the email again to <strong class="font-mono text-ink">{CHECK_ADDRESS}</strong> for a fresh
        report.
      </>
    ),
  },
  {
    code: 429,
    title: "You've reached today's limit of 50 checks.",
    sentence:
      "Karoo Couriers can check 50 emails or files a day during the launch. The limit resets at 00:00 SAST, in 5 h 12 min.",
    actions: [
      <Button variant="dark" href="/settings/plan">
        See your plan
      </Button>,
      <Button variant="ghost" href="/cases">
        Back to cases
      </Button>,
    ],
    panel: {
      lead: "Too many requests at once?",
      sentence:
        'The same page also covers a short burst limit: then it says "try again in 30 seconds" and counts down.',
    },
  },
  {
    code: 500,
    title: "Sorry, something broke on our side.",
    sentence:
      "This was our fault, not yours, and we have been told about it. Try again in a minute. If it keeps happening, send us the reference below.",
    actions: [
      <Button variant="dark" href="/cases">
        Try again
      </Button>,
      <Button variant="ghost" href="mailto:support@isitlegit.co.za">
        Email support
      </Button>,
    ],
    note: FORWARD,
  },
  {
    code: "maintenance",
    title: "We're upgrading IsItLegit. Back by 02:30 SAST.",
    sentence:
      "The dashboard is offline from 02:00 to 02:30 SAST on Tue 28 Oct 2026. Your cases and settings are safe. Replies to mail forwarded during this window may be late.",
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
  {
    id: "button/disabled-link",
    render: () => (
      <Button id="gallery-export" href="/cases/export" disabled disabledReason="Exports open once a case is checked.">
        Export counts as CSV
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
    id: "select/default",
    render: () => (
      <div class="flex flex-col gap-6">
        <label for="g-select" class="text-14 weight-text-strong">
          Verdict
        </label>
        <Select id="g-select" name="verdict">
          <option value="">All verdicts</option>
          <option value="malicious" selected>
            Malicious
          </option>
          <option value="suspicious">Suspicious</option>
          <option value="safe">Safe</option>
        </Select>
      </div>
    ),
  },
  {
    id: "select/disabled",
    render: () => (
      <div class="flex flex-col gap-6">
        <label for="g-select-disabled" class="text-14 weight-text-strong">
          Role
        </label>
        <Select id="g-select-disabled" name="role" disabled>
          <option value="owner" selected>
            Owner
          </option>
          <option value="admin">Admin</option>
          <option value="member">Member</option>
        </Select>
      </div>
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
  ...ERRORS.map(({ code, title, sentence, actions, note, panel }) => ({
    id: `error/${code}`,
    render: () => (
      <ErrorState
        code={code}
        title={title}
        actions={actions}
        {...(note ? { note } : {})}
        {...(panel ? { panel } : {})}
        footer={
          code === "maintenance" ? "Started 02:00 SAST · expected back 02:30 SAST" : referenceLine(`${code}-7F3K2Q`, at)
        }
      >
        {sentence}
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

// The anchor of a state or a frame, shareable as /dev/components#<anchor>.
export const anchorOf = (kind: "state" | "frame", id: string) => `${kind}-${id.replace(/[^a-z0-9]+/gi, "-")}`;

export function GalleryState(slug: string) {
  const state = GALLERY_STATES.find((s) => anchorOf("state", s.id) === slug);
  if (!state) return null;
  return (
    <Document title={`State ${state.id}`}>
      <main id="content" class="p-16 bg-surface">
        {state.render()}
      </main>
    </Document>
  );
}

export function GalleryPage() {
  return (
    <Document title="Component gallery" scripts={raw(GALLERY_SCRIPT)}>
      <main id="content" class="flex flex-col gap-32 p-16 md:p-48 bg-subtle">
        <h1 class="type-h1">Component gallery</h1>
        {/* The controls for every preview on this page (§15): theme and width, remembered for the session only,
            and axe-core on demand beside each preview. */}
        <div class="flex flex-col gap-16 p-16 bg-surface border border-line rounded-card">
          <div class="flex flex-wrap items-center gap-16">
            <fieldset aria-label="Gallery theme" class="flex items-center gap-8 border-0 p-0 m-0">
              <span class="type-small weight-heading">Theme</span>
              {(["light", "dark", "system"] as const).map((value) => (
                <Button
                  size="small"
                  variant="ghost"
                  data-gallery-theme={value}
                  aria-pressed={value === "system" ? "true" : "false"}
                >
                  {value[0]?.toUpperCase()}
                  {value.slice(1)}
                </Button>
              ))}
            </fieldset>
            <fieldset aria-label="Gallery width" class="flex items-center gap-8 border-0 p-0 m-0">
              <span class="type-small weight-heading">Width</span>
              {(
                [
                  ["360", "360 px"],
                  ["1280", "1280 px"],
                  ["full", "Full"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  size="small"
                  variant="ghost"
                  data-gallery-width={value}
                  aria-pressed={value === "full" ? "true" : "false"}
                >
                  {label}
                </Button>
              ))}
            </fieldset>
            <Button size="small" variant="dark" data-a11y-run>
              Run accessibility checks
            </Button>
            <p data-a11y-status role="status" aria-live="polite" class="type-small text-muted">
              Not run yet.
            </p>
          </div>
          <div data-a11y-results="gallery" data-a11y-state="idle">
            <p class="type-small text-muted">Not scanned yet.</p>
          </div>
        </div>
        {/* One link per state and frame: any of them is a single activation away, by keyboard too. */}
        <nav aria-label="Gallery index" class="p-16 bg-surface border border-line rounded-card">
          <h2 class="type-h4">Index</h2>
          <ul class="flex flex-wrap gap-x-16 gap-y-8 mt-8 type-small">
            {GALLERY_STATES.map((state) => (
              <li>
                <a href={`#${anchorOf("state", state.id)}`} class="inline-flex items-center min-h-24">
                  {state.id}
                </a>
              </li>
            ))}
            {GALLERY_FRAMES.map((frame) => (
              <li>
                <a href={`#${anchorOf("frame", frame.id)}`} class="inline-flex items-center min-h-24">
                  frame {frame.id}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        {GALLERY_STATES.map((state) => (
          <section
            id={anchorOf("state", state.id)}
            data-gallery-state={state.id}
            data-a11y-label={`state ${state.id}`}
            aria-labelledby={`${anchorOf("state", state.id)}-title`}
            class="flex flex-col gap-12 scroll-mt-24"
          >
            <h2 id={`${anchorOf("state", state.id)}-title`} class="type-h4">
              {state.id}
            </h2>
            <div class="overflow-x-auto">
              <iframe
                title={`The ${state.id} state`}
                src={`/dev/components/state/${anchorOf("state", state.id)}`}
                loading="lazy"
                height="480"
                data-gallery-preview
                class="w-full border border-line rounded-card bg-surface"
              />
            </div>
            <div class="flex items-center gap-12">
              <Button size="small" variant="ghost" data-a11y-scan-one>
                Scan this preview
              </Button>
            </div>
            <div data-a11y-results data-a11y-state="idle">
              <p class="type-small text-muted">Not scanned yet.</p>
            </div>
          </section>
        ))}
        <h2 class="type-h2">Frames</h2>
        {/* Loaded as they come near the screen: a frame is a whole document with its scripts. */}
        {GALLERY_FRAMES.map((frame) => (
          <section
            id={anchorOf("frame", frame.id)}
            data-gallery-frame={frame.id}
            data-a11y-label={`frame ${frame.id}`}
            class="flex flex-col gap-12 scroll-mt-24"
          >
            <h3 class="type-h4">{frame.id}</h3>
            <div class="overflow-x-auto">
              <iframe
                title={`The ${frame.id} frame`}
                src={`/dev/components/frame/${frame.id}`}
                loading="lazy"
                height="720"
                data-gallery-preview
                class="w-full border border-line rounded-card bg-surface"
              />
            </div>
            <div class="flex items-center gap-12">
              <Button size="small" variant="ghost" data-a11y-scan-one>
                Scan this preview
              </Button>
            </div>
            <div data-a11y-results data-a11y-state="idle">
              <p class="type-small text-muted">Not scanned yet.</p>
            </div>
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
