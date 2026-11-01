// The results page (D08 T02 §4; design/SPEC.md S10, board `Results`): how often IsItLegit is right on the latest published
// eval run, each target beside its result with met or missed said in words, what each Meta model adds, and what happened
// in real use (counts only). It is a public page on the app's host (the site's `/eval` redirects here) in the public
// shell. Nothing here is a message, a sender or a subject. A figure no run measures says "not measured", never a number:
// the analysis time is not the forward-to-reply time, so that target is never shown met from this run.
import type { ProductionCounts } from "../../eval/production";
import type { AblationRow, PublishedReport } from "../../eval/results";
import { AppShell } from "../components/AppShell";
import { cx, FOCUS } from "../components/attrs";
import { Button } from "../components/Button";
import { Document } from "../components/Document";
import { Pill, type PillVariant } from "../components/Pill";
import { ErrorState, referenceLine } from "../components/States";

export const ORIGIN_NOTE = "You are on isitlegit.co.za";
export const DATASETS_URL = "https://github.com/rizonetech/isitlegit/blob/main/eval/DATASETS.md";
const CARD = "flex flex-col gap-8 p-24 bg-surface border border-line rounded-card-large min-w-0";
const PANEL = "bg-surface border border-line rounded-card-large overflow-hidden min-w-0";
const LINK = cx("text-orange-text underline underline-offset-4", FOCUS);
const TH = "px-16 py-12 text-left text-13 weight-text-strong text-muted bg-subtle border-b border-line";
const TD = "px-16 py-12 text-14 border-b border-line";
const NUM = "text-right whitespace-nowrap";

const stamp = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
export const pct = (rate: number | null) => (rate === null ? "Not measured" : `${(rate * 100).toFixed(1)}%`);
export const seconds = (ms: number | null) => (ms === null ? "Not measured" : `${(ms / 1000).toFixed(1)} s`);
export const usd = (v: number | null) => (v === null ? "Not measured" : `US$${v.toFixed(4)}`);
const points = (delta: number | null, flip = false) =>
  delta === null
    ? "Not measured"
    : `${(flip ? -delta : delta) * 100 >= 0 ? "plus" : "minus"} ${Math.abs(delta * 100).toFixed(1)} pts`;

// The attack kinds in the board's words; anything else keeps its own name.
const KIND: Record<string, string> = {
  "credential-phishing": "Credential phishing",
  "bec-payment": "Business email compromise",
  "invoice-bank-change": "Invoice bank change",
  impersonation: "Impersonation",
  "voice-lure": "Voice note lures",
  "malware-attachment": "Malware attachments",
};
// The ablation modes (D08 T02 §3) in the board's words: what is switched off and what replaces it.
export const MODES: Record<string, { off: string; replacedBy: string }> = {
  "no-spark": { off: "Muse Spark reasoning", replacedBy: "Rule-based verdict" },
  "no-wonder": { off: "Muse Wonder walkthrough", replacedBy: "No walkthrough" },
  "no-sam": { off: "SAM 3.1 logo check", replacedBy: "No logo comparison" },
  "no-voice": { off: "Muse Voice Transcribe", replacedBy: "No transcript" },
  "no-glimmer": { off: "Muse Glimmer screening", replacedBy: "Every page to Muse Spark" },
};

export type EvalView =
  | { kind: "empty"; counts: ProductionCounts }
  | {
      kind: "report";
      report: PublishedReport;
      publishedAt: string;
      ablations: AblationRow[];
      counts: ProductionCounts;
    };

const STATE: Record<string, { words: string; variant: PillVariant }> = {
  met: { words: "Target met", variant: "safe" },
  missed: { words: "Target missed", variant: "malicious" },
  incomplete: { words: "Run incomplete", variant: "partial" },
  "not measured": { words: "Not measured", variant: "neutral" },
};
const targetOf = (r: PublishedReport | null, name: string) => r?.targets.find((t) => t.name === name);

function Tile(props: { label: string; value: string; pill?: { words: string; variant: PillVariant }; note?: string }) {
  return (
    <div class={CARD}>
      <p class="text-14 text-muted">{props.label}</p>
      <p class="type-h1 wrap-anywhere">{props.value}</p>
      {props.pill ? <Pill variant={props.pill.variant}>{props.pill.words}</Pill> : null}
      {props.note ? <p class="text-13 text-muted">{props.note}</p> : null}
    </div>
  );
}

function Hero(props: { report: PublishedReport | null }) {
  const r = props.report;
  const total = r ? r.main.attacks + r.main.genuine : 0;
  return (
    <header class="flex flex-col gap-16">
      <p class="type-eyebrow text-orange-text">Results</p>
      <h1 class="type-h1 md:text-48">How often is IsItLegit right?</h1>
      {r ? (
        <>
          <p class="text-18 text-ink-2 max-w-[760px]">
            On our latest test of {total} labelled emails and documents, IsItLegit caught {pct(r.main.detection.rate)}{" "}
            of attacks and wrongly flagged {pct(r.main.falsePositives.rate)} of genuine mail. We publish the numbers
            whether they are good or not.
          </p>
          <p class="text-13 text-muted">
            Eval run {r.run.id} · {stamp.format(new Date(r.run.finishedAt ?? r.run.startedAt))} SAST · commit{" "}
            {r.run.commit.slice(0, 7)} · dataset described in{" "}
            <a href={DATASETS_URL} class={LINK}>
              eval/DATASETS.md
            </a>
          </p>
        </>
      ) : (
        <p class="text-18 text-ink-2 max-w-[760px]">
          No test run has been published yet. The figures below fill in when the first complete run is published; until
          then they say Not measured.
        </p>
      )}
    </header>
  );
}

function Tiles(props: { report: PublishedReport | null }) {
  const r = props.report;
  const det = targetOf(r, "detection");
  const fp = targetOf(r, "false positives");
  const cost = targetOf(r, "median cost per case");
  const state = (t: ReturnType<typeof targetOf>) => STATE[t?.state ?? "not measured"] as (typeof STATE)[string];
  return (
    <section aria-label="The latest run against its targets" class="grid gap-16 sm:grid-cols-2 lg:grid-cols-4">
      <Tile
        label="Attacks caught"
        value={pct(r?.main.detection.rate ?? null)}
        pill={state(det)}
        note="Target 95% or more"
      />
      <Tile
        label="False alarms on genuine mail"
        value={pct(r?.main.falsePositives.rate ?? null)}
        pill={state(fp)}
        note="Target 2% or less"
      />
      <Tile
        label="Median time to analyse"
        value={seconds(r?.main.analysisMs.median ?? null)}
        pill={{ words: "Forward-to-reply: not measured", variant: "neutral" }}
        note="The forward-to-reply target (under 60 s) is measured by the live mail run, not by this test."
      />
      <Tile
        label="Median model cost per check"
        value={usd(r?.main.costUsd.median ?? null)}
        pill={state(cost)}
        note="Target under US$0.05"
      />
    </section>
  );
}

function Tables(props: { report: PublishedReport | null }) {
  const r = props.report;
  const attackKinds = r
    ? Object.entries(r.main.byCategory)
        .filter(([, c]) => c.attacks > 0)
        .sort(([a], [b]) => (a < b ? -1 : 1))
    : [];
  const genuine = r
    ? Object.values(r.main.byCategory).reduce((a, c) => ({ n: a.n + c.genuine, fp: a.fp + c.falsePositives }), {
        n: 0,
        fp: 0,
      })
    : null;
  return (
    <div class="grid gap-24 lg:grid-cols-2">
      <section class={PANEL} aria-labelledby="kinds-heading">
        <h2 id="kinds-heading" class="type-h3 p-24">
          By kind of attack
        </h2>
        <table class="w-full border-collapse">
          <caption class="sr-only">Attacks caught, by kind of attack</caption>
          <thead>
            <tr>
              <th scope="col" class={TH}>
                Category
              </th>
              <th scope="col" class={cx(TH, NUM)}>
                Samples
              </th>
              <th scope="col" class={cx(TH, NUM)}>
                Caught
              </th>
            </tr>
          </thead>
          <tbody>
            {attackKinds.length ? (
              attackKinds.map(([name, c]) => (
                <tr>
                  <th scope="row" class={cx(TD, "text-left weight-text")}>
                    {KIND[name] ?? name}
                  </th>
                  <td class={cx(TD, NUM)}>{c.attacks}</td>
                  <td class={cx(TD, NUM)}>{pct(c.attacks ? c.detected / c.attacks : null)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td class={TD} colspan={3}>
                  No run is published yet.
                </td>
              </tr>
            )}
            {genuine ? (
              <tr>
                <th scope="row" class={cx(TD, "text-left weight-text")}>
                  Genuine mail, flagged in error
                </th>
                <td class={cx(TD, NUM)}>{genuine.n}</td>
                <td class={cx(TD, NUM)}>{pct(genuine.n ? genuine.fp / genuine.n : null)}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
      <section class={PANEL} aria-labelledby="speed-heading">
        <h2 id="speed-heading" class="type-h3 p-24">
          Speed and cost
        </h2>
        <table class="w-full border-collapse">
          <caption class="sr-only">Analysis time and model cost against their targets</caption>
          <thead>
            <tr>
              <th scope="col" class={TH}>
                Measure
              </th>
              <th scope="col" class={cx(TH, NUM)}>
                Result
              </th>
              <th scope="col" class={cx(TH, NUM)}>
                Target
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" class={cx(TD, "text-left weight-text")}>
                Time to analyse, median
              </th>
              <td class={cx(TD, NUM)}>{seconds(r?.main.analysisMs.median ?? null)}</td>
              <td class={cx(TD, NUM)}>Forward-to-reply under 60 s: not measured</td>
            </tr>
            <tr>
              <th scope="row" class={cx(TD, "text-left weight-text")}>
                Time to analyse, 95th percentile
              </th>
              <td class={cx(TD, NUM)}>{seconds(r?.main.analysisMs.p95 ?? null)}</td>
              <td class={cx(TD, NUM)}>Forward-to-reply under 3 min: not measured</td>
            </tr>
            <tr>
              <th scope="row" class={cx(TD, "text-left weight-text")}>
                Model cost, median check
              </th>
              <td class={cx(TD, NUM)}>{usd(r?.main.costUsd.median ?? null)}</td>
              <td class={cx(TD, NUM)}>under US$0.05</td>
            </tr>
            <tr>
              <th scope="row" class={cx(TD, "text-left weight-text")}>
                Model cost, with a walkthrough
              </th>
              <td class={cx(TD, NUM)}>Not measured</td>
              <td class={cx(TD, NUM)}>under US$0.25</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Ablation(props: { report: PublishedReport | null; rows: AblationRow[] }) {
  const r = props.report;
  return (
    <section class="bg-subtle" aria-labelledby="models-heading">
      <div class="flex flex-col gap-16 w-full max-w-[1120px] mx-auto px-16 py-40 md:px-32">
        <h2 id="models-heading" class="type-h2">
          What does each Meta model add?
        </h2>
        <p class="text-ink-2 max-w-[760px]">
          We run the same test again with one model switched off at a time. The difference is what that model is worth.
          A model whose removal costs nothing gets cut or reworked.
        </p>
        {r && props.rows.length === 0 ? (
          <p class="text-14 text-muted">
            No model has been switched off in a published run yet, so there is nothing to compare.
          </p>
        ) : null}
        <div class={PANEL}>
          <section
            class="overflow-x-auto"
            aria-label="Ablation table, scrolls sideways on a narrow screen"
            tabindex={0}
          >
            <table class="w-full min-w-[720px] border-collapse">
              <caption class="sr-only">Each model switched off against the full pipeline</caption>
              <thead>
                <tr>
                  <th scope="col" class={TH}>
                    Switched off
                  </th>
                  <th scope="col" class={TH}>
                    Replaced by
                  </th>
                  <th scope="col" class={cx(TH, NUM)}>
                    Attacks caught
                  </th>
                  <th scope="col" class={cx(TH, NUM)}>
                    False alarms
                  </th>
                  <th scope="col" class={cx(TH, NUM)}>
                    Median time
                  </th>
                  <th scope="col" class={cx(TH, NUM)}>
                    Median cost
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row" class={cx(TD, "text-left weight-text-strong")}>
                    Nothing (full pipeline)
                  </th>
                  <td class={TD}>None</td>
                  <td class={cx(TD, NUM)}>{pct(r?.main.detection.rate ?? null)}</td>
                  <td class={cx(TD, NUM)}>{pct(r?.main.falsePositives.rate ?? null)}</td>
                  <td class={cx(TD, NUM)}>{seconds(r?.main.analysisMs.median ?? null)}</td>
                  <td class={cx(TD, NUM)}>{usd(r?.main.costUsd.median ?? null)}</td>
                </tr>
                {props.rows.map((row) => {
                  const words = MODES[row.mode] ?? { off: row.mode, replacedBy: "Not described" };
                  return row.comparable ? (
                    <tr>
                      <th scope="row" class={cx(TD, "text-left weight-text-strong")}>
                        {words.off}
                      </th>
                      <td class={TD}>{words.replacedBy}</td>
                      <td class={cx(TD, NUM)}>{points(row.detectionDelta)}</td>
                      <td class={cx(TD, NUM)}>{points(row.falsePositiveDelta)}</td>
                      <td class={cx(TD, NUM)}>
                        {row.msDelta === null
                          ? "Not measured"
                          : `${row.msDelta >= 0 ? "plus" : "minus"} ${Math.abs(row.msDelta / 1000).toFixed(1)} s`}
                      </td>
                      <td class={cx(TD, NUM)}>
                        {row.usdDelta === null
                          ? "Not measured"
                          : `${row.usdDelta >= 0 ? "plus" : "minus"} US$${Math.abs(row.usdDelta).toFixed(4)}`}
                      </td>
                    </tr>
                  ) : (
                    <tr>
                      <th scope="row" class={cx(TD, "text-left weight-text-strong")}>
                        {words.off}
                      </th>
                      <td class={TD}>{words.replacedBy}</td>
                      <td class={TD} colspan={4}>
                        Not comparable: {row.reason}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </section>
  );
}

function RealUse(props: { counts: ProductionCounts }) {
  const c = props.counts;
  return (
    <section aria-labelledby="use-heading" class="flex flex-col gap-24">
      <div class="grid gap-24 lg:grid-cols-2">
        <div class="flex flex-col gap-16">
          <h2 id="use-heading" class="type-h2">
            What happened in real use?
          </h2>
          <p class="text-ink-2">
            Counts from members' real mail since launch (27 October 2026). Real mail is only ever counted, never added
            to the test set or shown. The eval and demo organisations are left out.
          </p>
          <p class="text-14 text-muted">
            {c.invoiceFlags} cases carried an invoice finding.{" "}
            {c.medianSeconds === null
              ? "No case has a verdict yet."
              : `The median time from arrival to a verdict was ${c.medianSeconds.toFixed(1)} s.`}
          </p>
        </div>
        <div class="grid gap-16 sm:grid-cols-2">
          <Tile label="Cases checked" value={String(c.cases)} />
          <Tile label="Malicious or suspicious" value={String(c.flagged)} />
          <Tile
            label="Bank changes caught"
            value={c.bankChanges === null ? "Not counted yet" : String(c.bankChanges)}
          />
          <Tile label="Verdicts reported wrong" value={String(c.reportedWrong)} />
        </div>
      </div>
    </section>
  );
}

export function EvalPage(props: { view: EvalView }) {
  const { view } = props;
  const report = view.kind === "report" ? view.report : null;
  return (
    <Document title="Results">
      <AppShell variant="public" note={ORIGIN_NOTE}>
        <div class="flex flex-col gap-40 w-full max-w-[1120px] mx-auto px-16 py-24 md:px-32 md:py-56">
          <Hero report={report} />
          <Tiles report={report} />
          <Tables report={report} />
        </div>
        <Ablation report={report} rows={view.kind === "report" ? view.ablations : []} />
        <div class="w-full max-w-[1120px] mx-auto px-16 py-40 md:px-32 md:py-56">
          <RealUse counts={view.counts} />
        </div>
      </AppShell>
    </Document>
  );
}

// A read that failed: no figure is guessed.
export function EvalUnavailable(props: { reference: string; now: Date; retry: string }) {
  return (
    <Document title="Results unavailable">
      <AppShell variant="public" note={ORIGIN_NOTE}>
        <div class="w-full max-w-[880px] mx-auto px-16 py-24 md:py-56">
          <ErrorState
            code={500}
            title="We could not load the results just now."
            actions={[
              <Button variant="dark" href={props.retry}>
                Try again
              </Button>,
            ]}
            footer={referenceLine(props.reference, props.now)}
          >
            Nothing on this page was shown, so no figure here is a guess. Try again in a minute.
          </ErrorState>
        </div>
      </AppShell>
    </Document>
  );
}
