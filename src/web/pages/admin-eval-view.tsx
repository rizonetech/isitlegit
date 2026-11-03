// The operator's eval runs page (D08 T02 §9; design/SPEC.md X5, board Admin-Eval): every run with its own
// published figures, the five target tiles of the latest published report, the ablation table, the frontier
// log link and the CLI guidance that replaces the board's Start a run button (Deviation under X5). Drawing
// only: ./admin.tsx reads the database through src/eval/runs.ts and src/eval/results.ts, the same readers
// the public /eval page uses, so the two pages can never disagree.
import { sastShort } from "../../auth/invite-codes";
import type { AblationRow, EvalRunRow, Published, PublishedReport } from "../../eval/report";
import { AppShell } from "../components/AppShell";
import { cx, FOCUS } from "../components/attrs";
import { Button } from "../components/Button";
import { Document } from "../components/Document";
import { Pill, type PillVariant } from "../components/Pill";
import { EmptyState } from "../components/States";
import type { Shell } from "./admin-view";
import { MODES, pct, points, seconds, usd } from "./eval-view";

const CARD = "flex flex-col gap-8 p-24 bg-surface border border-line rounded-card-large min-w-0";
const PANEL = "bg-surface border border-line rounded-card-large overflow-hidden min-w-0";
const TH = "text-left text-13 text-muted weight-text-strong px-16 py-12 border-b border-line";
const TD = "text-14 px-16 py-12 border-b border-line align-top";
const STICKY = "sticky left-0 bg-surface";
const NUM = "text-right tabular-nums";
const LINK = cx("text-orange-text underline underline-offset-4", FOCUS);

export const frontierUrl = (commit: string) =>
  `https://github.com/rizonetech/isitlegit/blob/${commit}/docs/frontier-log.md`;

const STATE: Record<string, { words: string; variant: PillVariant }> = {
  met: { words: "Target met", variant: "safe" },
  missed: { words: "Target missed", variant: "malicious" },
  incomplete: { words: "Run incomplete", variant: "partial" },
  "not measured": { words: "Not measured", variant: "neutral" },
};
// The ablation arms (D08 T02 §3) in the board's words, keyed by the flag the runner stores after `ablate:`.
const ABLATION_WORDS: Record<string, { off: string; replacedBy: string }> = {
  "no-agent-reasoning": { off: "Muse Spark reasoning", replacedBy: "Rule-based verdict" },
  "no-walkthrough": { off: "Muse Wonder walkthrough", replacedBy: "No walkthrough" },
  "no-sam": { off: "SAM 3.1 logo check", replacedBy: "No logo comparison" },
  "no-transcribe": { off: "Muse Voice Transcribe", replacedBy: "No transcript" },
  "no-screening": { off: "Loupe page screening", replacedBy: "Every page to Muse Spark" },
};
const ablationWords = (mode: string) =>
  ABLATION_WORDS[mode.replace(/^ablate:/, "")] ?? MODES[mode] ?? { off: mode, replacedBy: "Not described" };

const STATUS: Record<string, PillVariant> = {
  complete: "safe",
  incomplete: "partial",
  running: "running",
  aborted: "malicious",
};

export type AdminEvalProps = {
  shell: Shell;
  runs: EvalRunRow[];
  latest: Published | null;
  ablations: AblationRow[];
};

function Tile(props: { label: string; value: string; state: string; note: string }) {
  const s = (STATE[props.state] ?? STATE["not measured"]) as (typeof STATE)[string];
  return (
    <div class={CARD}>
      <p class="text-14 text-muted">{props.label}</p>
      <p class="type-h1 font-text tabular-nums wrap-anywhere">{props.value}</p>
      <Pill variant={s.variant} class="self-start">
        {s.words}
      </Pill>
      <p class="text-13 text-muted">{props.note}</p>
    </div>
  );
}

function Tiles(props: { latest: Published | null }) {
  const r = props.latest?.report ?? null;
  const target = (name: string) => r?.targets.find((t) => t.name === name);
  const det = target("detection");
  const fp = target("false positives");
  const cost = target("median cost per case");
  const reply = target("forward-to-reply time");
  const replyValue = reply && reply.figure !== null ? reply.figureText : "Not measured";
  const replyState = reply?.state ?? "not measured";
  const replyNote = reply
    ? `${reply.threshold}; over ${reply.denominator} measured. ${reply.note ?? ""}`.trim()
    : "Not measured yet.";
  return (
    <section
      aria-label="The latest published run against its targets"
      class="grid gap-16 grid-cols-[repeat(auto-fit,minmax(min(13rem,100%),1fr))]"
    >
      <Tile
        label="Detection on attacks"
        value={det ? det.figureText : "Not measured"}
        state={det?.state ?? "not measured"}
        note={det ? `Target ${det.threshold}; over ${det.denominator} attacks.` : "Target at least 95.0%."}
      />
      <Tile
        label="False alarms on genuine"
        value={fp ? fp.figureText : "Not measured"}
        state={fp?.state ?? "not measured"}
        note={fp ? `Target ${fp.threshold}; over ${fp.denominator} genuine.` : "Target at most 2.0%."}
      />
      <Tile label="Median to reply" value={replyValue} state={replyState} note={replyNote} />
      <Tile label="95th percentile" value={replyValue} state={replyState} note={replyNote} />
      <Tile
        label="Median model cost"
        value={cost ? cost.figureText : "Not measured"}
        state={cost?.state ?? "not measured"}
        note={cost ? `Target ${cost.threshold}; over ${cost.denominator} cases.` : "Target under US$0.0500."}
      />
    </section>
  );
}

function AblationTable(props: { latest: Published | null; rows: AblationRow[] }) {
  const r = props.latest?.report ?? null;
  return (
    <section class={PANEL} aria-labelledby="ablation-heading">
      <div class="px-20 py-16 border-b border-line">
        <h2 id="ablation-heading" class="type-h3">
          What each Meta model is worth
        </h2>
        <p class="text-13 text-muted">The same set, run again with one model switched off.</p>
      </div>
      {r && props.rows.length === 0 ? (
        <p class="px-20 py-16 text-14 text-muted">
          No ablation run has been published yet, so there is nothing to compare.
        </p>
      ) : null}
      <section class="overflow-x-auto" tabindex={0} aria-label="Ablation table, scrolls sideways on a narrow screen">
        <table class="w-full min-w-[720px] border-collapse">
          <caption class="sr-only">Each model switched off against the full pipeline</caption>
          <thead>
            <tr>
              <th scope="col" class={cx(TH, STICKY)}>
                Switched off
              </th>
              <th scope="col" class={TH}>
                Replaced by
              </th>
              <th scope="col" class={cx(TH, NUM)}>
                Detection
              </th>
              <th scope="col" class={cx(TH, NUM)}>
                False alarms
              </th>
              <th scope="col" class={cx(TH, NUM)}>
                Median time
              </th>
              <th scope="col" class={cx(TH, NUM)}>
                Cost per check
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" class={cx(TD, "weight-text-strong", STICKY)}>
                Nothing (full pipeline)
              </th>
              <td class={TD}>Baseline</td>
              <td class={cx(TD, NUM)}>{pct(r?.main.detection.rate ?? null)}</td>
              <td class={cx(TD, NUM)}>{pct(r?.main.falsePositives.rate ?? null)}</td>
              <td class={cx(TD, NUM)}>{seconds(r?.main.analysisMs.median ?? null)}</td>
              <td class={cx(TD, NUM)}>{usd(r?.main.costUsd.median ?? null)}</td>
            </tr>
            {props.rows.map((row) => {
              const words = ablationWords(row.mode);
              return row.comparable ? (
                <tr>
                  <th scope="row" class={cx(TD, "weight-text-strong", STICKY)}>
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
                  <th scope="row" class={cx(TD, "weight-text-strong", STICKY)}>
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
      <p class="px-20 py-12 text-13 text-muted border-t border-line">
        A model whose removal costs nothing is cut or reworked (design spec 4.9).
      </p>
    </section>
  );
}

function RunsTable(props: { runs: EvalRunRow[] }) {
  return (
    <section class={PANEL} aria-labelledby="runs-heading">
      <div class="px-20 py-16 border-b border-line">
        <h2 id="runs-heading" class="type-h3">
          All runs
        </h2>
      </div>
      <section class="overflow-x-auto" tabindex={0} aria-label="All runs table, scrolls sideways on a narrow screen">
        <table class="w-full min-w-[720px] border-collapse">
          <caption class="sr-only">Every eval run, newest first, with its own published figures</caption>
          <thead>
            <tr>
              <th scope="col" class={cx(TH, STICKY)}>
                Run
              </th>
              <th scope="col" class={TH}>
                Commit
              </th>
              <th scope="col" class={TH}>
                Status
              </th>
              <th scope="col" class={cx(TH, NUM)}>
                Detection
              </th>
              <th scope="col" class={cx(TH, NUM)}>
                False alarms
              </th>
              <th scope="col" class={cx(TH, NUM)}>
                Cost
              </th>
              <th scope="col" class={TH}>
                Targets
              </th>
            </tr>
          </thead>
          <tbody>
            {props.runs.map((run) => {
              const p = run.published?.report ?? null;
              const met = p ? p.targets.filter((t) => t.state === "met").length : 0;
              return (
                <tr>
                  <td class={cx(TD, STICKY)}>
                    <span class="weight-text-strong">{sastShort(run.startedAt)}</span>
                    <br />
                    <span class="text-13 text-muted">{run.id}</span>
                  </td>
                  <td class={cx(TD, "font-mono text-13")}>{run.commit.slice(0, 7)}</td>
                  <td class={TD}>
                    <Pill variant={STATUS[run.status] ?? "neutral"}>{run.status}</Pill>
                  </td>
                  <td class={cx(TD, NUM)}>{p ? pct(p.main.detection.rate) : "Not published"}</td>
                  <td class={cx(TD, NUM)}>{p ? pct(p.main.falsePositives.rate) : "Not published"}</td>
                  <td class={cx(TD, NUM)}>{usd(run.costUsd)}</td>
                  <td class={TD}>
                    {p ? (
                      <Pill variant={met === p.targets.length ? "safe" : "neutral"}>
                        {`${met} of ${p.targets.length} met`}
                      </Pill>
                    ) : (
                      "Not published"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <p class="px-20 py-12 text-13 text-muted border-t border-line">
        A missed target shows its cause from eval/RESULTS.md.
      </p>
    </section>
  );
}

export function AdminEvalPage(props: AdminEvalProps) {
  const latest: PublishedReport | null = props.latest?.report ?? null;
  const commit = latest?.run.commit ?? "main";
  const headerLine = latest
    ? `Latest run ${latest.run.id} · ${latest.run.selected} samples · started ${sastShort(latest.run.startedAt)} SAST`
    : "No run has been published yet.";
  return (
    <Document title="Eval runs">
      <AppShell variant="admin" active="eval" feedbackOpen={props.shell.feedbackOpen} operator={props.shell.operator}>
        <div class="flex flex-col gap-24 px-16 py-24 md:px-56 md:py-40">
          <header class="flex flex-wrap items-start justify-between gap-12">
            <div>
              <h1 class="type-h1">Eval runs</h1>
              <p class="type-small text-muted">{headerLine}</p>
            </div>
            <div class="flex flex-wrap gap-8">
              <span class="text-13 text-muted">eval/RESULTS.md is not written yet (D08 T02 §5).</span>
              <Button href={frontierUrl(commit)} variant="dark" size="small">
                Frontier log
              </Button>
            </div>
          </header>

          <section aria-label="Start a run" class={cx(CARD, "gap-4")}>
            <h2 class="type-h3">Start a run</h2>
            <p class="text-14 text-ink-2">
              Runs start from the command line, under a cap stated before the run and never raised. The full rules-only
              baseline is one command:
            </p>
            <p class="font-mono text-13">pnpm eval:baseline</p>
            <p class="text-14 text-ink-2">
              One set at a time (synthetic-sa US$13.00, nazario-2025 US$5.00, synthetic-challenge US$5.00):
            </p>
            <p class="font-mono text-13">pnpm eval:run --set synthetic-sa --cap-usd 13.00</p>
          </section>

          <Tiles latest={props.latest} />
          <AblationTable latest={props.latest} rows={props.ablations} />

          {props.runs.length === 0 ? (
            <EmptyState
              layout="first-run"
              eyebrow="Eval"
              title="No eval runs yet"
              sentence="The first run fills this page: every run, its figures and what each model is worth."
            />
          ) : (
            <div class="grid gap-16 lg:grid-cols-[1.2fr_1fr] items-start">
              <RunsTable runs={props.runs} />
              <section class={PANEL} aria-labelledby="frontier-heading">
                <div class="flex flex-wrap items-baseline justify-between gap-8 px-20 py-16 border-b border-line">
                  <h2 id="frontier-heading" class="type-h3">
                    Frontier log
                  </h2>
                  <a href={frontierUrl(commit)} class={LINK}>
                    docs/frontier-log.md
                  </a>
                </div>
                <p class="px-20 py-16 text-14 text-ink-2">
                  One experiment per build day at the edge of what the Meta models can do. What works becomes a feature
                  through the TODO system; what fails stays in the log with its evidence.
                </p>
              </section>
            </div>
          )}
        </div>
      </AppShell>
    </Document>
  );
}
