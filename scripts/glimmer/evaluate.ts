// Loupe's held-out evaluation: a published dataset version's `eval.jsonl` through a screener, scored (D03 T04 §13).
//
//   node scripts/glimmer/evaluate.ts loupe <version> --model <Fireworks model or deployment> [--retry-errors]
//   node scripts/glimmer/evaluate.ts spark <version> [--max-usd <n>] [--retry-errors]
//   node scripts/glimmer/evaluate.ts score <version>
//
// `loupe` sends each line's system and user messages (never the assistant turn, the true answer) to Fireworks'
// OpenAI-compatible chat completions at temperature 0, with the inference key ("IsItLegit Fireworks", read through
// conclave-op, sent only in the Authorization header and never printed). A 503 `DEPLOYMENT_SCALING_UP` or a 429 is
// retried with exponential backoff up to a bounded total wait; any other failure is recorded against its page.
// `spark` sends the same requests through Muse Spark as teacher-label.ts sends them (`sparkAsk`), every attempt reserved
// in the one Meta ledger before it is sent and settled after, and refuses to start when the ledger says the run would
// pass `--max-usd` (default 10) or Glimmer's own cap.
// `score` reads both answer files and writes `<store>/runs/eval-<version>/metrics.json` (temp then rename), the file
// version-gate.py and model_card.py read.
//
// Each run appends one line a page to `<store>/runs/eval-<version>/<loupe|spark>.answers.jsonl`
// (`{id, answer | null, error | null, latency_ms, cost_usd}`, fsynced), and a rerun skips every page already recorded
// (`--retry-errors` asks again the pages whose line is an error), so a preemption or a kill resumes where it stopped.
// An answer is parsed strictly as a `PageAnswer`; one that does not parse is an error for its page, never a guess. Files
// and output hold ids and counts only, never page text.
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { sastDay } from "../../src/meta/day.ts";
import { BudgetExceeded, BudgetUnavailable } from "../../src/meta/guard.ts";
import { PageAnswer } from "../../src/vision/page-screen.ts";
import { configureNetwork } from "../fireworks-check.ts";
import { ledgerId, localBudget } from "../lib/meta-budget.ts";
import {
  GATEWAY_URL,
  metaLedger,
  readLedger,
  readSecretsFromVault,
  reserveSpend,
  settleSpend,
  takeLock,
} from "../meta-smoke.ts";
import { eachLine } from "./build-dataset.ts";
import { storeDir } from "./store.ts";
import {
  type AttemptLedger,
  ESTIMATE_USD,
  GLIMMER_CAP_USD,
  glimmerSpend,
  ledgerLock,
  sharedClock,
  sparkAsk,
} from "./teacher-label.ts";

export const INFERENCE_KEY_ITEM = "IsItLegit Fireworks";
export const COMPLETIONS_URL = "https://api.fireworks.ai/inference/v1/chat/completions";
export const DEFAULT_MAX_USD = 10;
export const MAX_ANSWER_TOKENS = 500;
// The longest a request waits in total for a scaling-up deployment (a cold start takes minutes).
export const MAX_SCALING_WAIT_MS = 15 * 60_000;
const FIRST_BACKOFF_MS = 2_000;
const LONGEST_BACKOFF_MS = 30_000;
const ledgerCalls = (version: string) => `glimmer-eval-spark-${version}-`;

export type Screener = "loupe" | "spark";
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type Message = { role: string; content: unknown };
export type Reply = { text: string; usd: number | null; incomplete?: string };
export type AnswerLine = {
  id: string;
  answer: PageAnswer | null;
  error: string | null;
  latency_ms: number;
  cost_usd: number;
};
export type PageMeta = {
  id: string;
  source: string;
  origin: string;
  lure_type: string;
  brand: string | null;
  south_africa: boolean;
  screenshot: string;
};

// A run that must stop, not record a page: the budget refused, or the ledger could not be written.
export class StopRun extends Error {}

export function checkVersion(version: string | undefined): string {
  if (!version || !/^[1-9]\d?\.\d{1,2}$/.test(version)) throw new TypeError(`version "${version}" is not like 1.0`);
  return version;
}
export const datasetDir = (store: string, version: string) => join(store, "dataset", version);
export const runDir = (store: string, version: string) => join(store, "runs", `eval-${version}`);
export const answersFile = (dir: string, screener: Screener) => join(dir, `${screener}.answers.jsonl`);

// ---------------------------------------------------------------------------------------------------------------
// Reading the held-out set. A line is about 250 KB, so the file is indexed once (offsets, by `eachLine`, which also
// takes its SHA-256) and each line is read again only when its page is asked.

export type Span = { offset: number; length: number };

export function indexLines(path: string): { spans: Span[]; sha256: string } {
  const spans: Span[] = [];
  let offset = 0;
  const { sha256 } = eachLine(path, (line) => {
    const length = Buffer.byteLength(line);
    spans.push({ offset, length });
    offset += length + 1;
  });
  return { spans, sha256 };
}

function readSpan(fd: number, span: Span): string {
  const buffer = Buffer.alloc(span.length);
  const read = readSync(fd, buffer, 0, span.length, span.offset);
  if (read !== span.length) throw new Error("the evaluation file changed while it was read");
  return buffer.toString("utf-8");
}

export function readMetas(path: string): PageMeta[] {
  const metas: PageMeta[] = [];
  eachLine(path, (line) => {
    const meta = JSON.parse(line) as PageMeta;
    if (typeof meta.id !== "string" || typeof meta.lure_type !== "string" || typeof meta.source !== "string")
      throw new Error(`${path}: a line is not a page's record`);
    metas.push(meta);
  });
  return metas;
}

// The request a line holds: its messages without the assistant turn.
export function requestOf(line: string): Message[] {
  const parsed = JSON.parse(line) as { messages?: Message[] };
  const messages = (parsed.messages ?? []).filter((m) => m.role === "system" || m.role === "user");
  if (messages.length !== 2 || messages[0]?.role !== "system" || messages[1]?.role !== "user")
    throw new Error("a line does not hold a system and a user message");
  return messages;
}

// What a model said, parsed strictly. null when it is not a PageAnswer.
export function parseAnswer(text: string): PageAnswer | null {
  try {
    const parsed = PageAnswer.safeParse(JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The answer files.

export function readAnswers(path: string): Map<string, AnswerLine> {
  const answers = new Map<string, AnswerLine>();
  if (!existsSync(path)) return answers;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let parsed: AnswerLine;
    try {
      parsed = JSON.parse(line) as AnswerLine;
    } catch {
      continue; // a line cut short by a kill: its page is asked again
    }
    if (typeof parsed.id === "string") answers.set(parsed.id, parsed); // the last line of a page stands
  }
  return answers;
}

function appendLine(path: string, line: AnswerLine) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  try {
    writeSync(fd, `${JSON.stringify(line)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeAtomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

// ---------------------------------------------------------------------------------------------------------------
// Asking.

export type LoupeOptions = {
  fetcher?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
};

// Loupe on Fireworks. A scaling-up deployment (503 DEPLOYMENT_SCALING_UP) or a rate limit (429) is retried with
// exponential backoff until `maxWaitMs` of waiting is spent; anything else throws with its status, never its body.
export function askLoupe(key: string, model: string, options: LoupeOptions = {}) {
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxWait = options.maxWaitMs ?? MAX_SCALING_WAIT_MS;
  return async (messages: Message[]): Promise<Reply> => {
    const body = JSON.stringify({ model, messages, temperature: 0, max_tokens: MAX_ANSWER_TOKENS });
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      const response = await fetcher(COMPLETIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
      });
      const text = await response.text();
      if (response.ok) {
        const choice = (JSON.parse(text) as { choices?: { message?: { content?: unknown }; finish_reason?: string }[] })
          .choices?.[0];
        return {
          text: typeof choice?.message?.content === "string" ? choice.message.content : "",
          usd: 0, // a dedicated deployment is billed by the hour, not by the request
          ...(choice?.finish_reason === "length" ? { incomplete: "length" } : {}),
        };
      }
      const scaling = response.status === 503 && text.includes("DEPLOYMENT_SCALING_UP");
      if (!scaling && response.status !== 429) throw new Error(`Fireworks answered ${response.status}`);
      const delay = Math.min(FIRST_BACKOFF_MS * 2 ** attempt, LONGEST_BACKOFF_MS);
      if (waited + delay > maxWait)
        throw new Error(`Fireworks answered ${response.status} for ${Math.round(waited / 1000)} s of waiting`);
      waited += delay;
      await sleep(delay);
    }
  };
}

// One page's attempts in the shared Meta ledger, as teacher-label.ts reserves them: before it is sent, under a cap that
// refuses (`BudgetExceeded`) or a ledger that cannot be written (`BudgetUnavailable`), and closed as it stands now.
export function attemptLedger(options: {
  ledgerFile: string;
  run: string;
  model: string;
  pageId: string;
  maxUsd: number;
  now: () => Date;
  record: { reason: string | null };
}): AttemptLedger {
  const { ledgerFile, run, model, pageId, maxUsd, now, record } = options;
  const held = new Map<string, { date: string; call: string }>();
  const close = (id: string, usd: number | null) => {
    const entry = held.get(id);
    if (!entry) return;
    const ledger = readLedger(ledgerFile);
    const found = ledger.find(
      (e) => e.date === entry.date && e.run === run && e.call === entry.call && e.state === "reserved",
    );
    if (found) record.reason = settleSpend(ledgerFile, ledger, found, usd) ?? record.reason;
  };
  return {
    reserve(attempt, estimateUsd) {
      const ledger = readLedger(ledgerFile);
      const mine = ledger
        .filter((e) => e.run === run)
        .reduce((sum, e) => sum + (typeof e.cost === "number" ? e.cost : e.estimate), 0);
      if (mine + estimateUsd > maxUsd) {
        record.reason = `the next attempt would take this evaluation past US$${maxUsd}`;
        throw new BudgetExceeded("total", model);
      }
      if (glimmerSpend(ledger) + estimateUsd > GLIMMER_CAP_USD) {
        record.reason = `the next attempt would take Glimmer's Spark spend past US$${GLIMMER_CAP_USD}`;
        throw new BudgetExceeded("total", model);
      }
      const call = attempt === 1 ? `${model} ${pageId}` : `${model} ${pageId} attempt ${attempt}`;
      const reserved = reserveSpend(ledgerFile, ledger, { date: sastDay(now()), run, call, estimate: estimateUsd });
      if ("refused" in reserved) {
        record.reason = `the ledger could not be written: ${reserved.refused}`;
        throw new BudgetUnavailable();
      }
      const id = ledgerId(reserved.entry.date, reserved.entry.run, reserved.entry.call);
      held.set(id, { date: reserved.entry.date, call });
      return id;
    },
    settle: (id, usd) => close(id, usd),
    uncertain: (id) => close(id, null),
    release: (id) => close(id, 0),
  };
}

// Spark's answer to a request: the user message's parts as Responses input, the system prompt as instructions.
export function sparkInput(messages: Message[]): { input: unknown[]; instructions: string } {
  const [system, user] = messages;
  const parts = Array.isArray(user?.content)
    ? (user.content as { type: string; text?: string; image_url?: { url: string } }[])
    : [];
  return {
    instructions: String(system?.content ?? ""),
    input: [
      {
        role: "user",
        content: parts.map((part) =>
          part.type === "text"
            ? { type: "input_text", text: part.text }
            : { type: "input_image", image_url: part.image_url?.url },
        ),
      },
    ],
  };
}

export type SparkAsk = (
  input: unknown[],
  instructions: string,
  attempts: AttemptLedger,
) => Promise<{ text: string; usd: number | null; incomplete?: string }>;

// ---------------------------------------------------------------------------------------------------------------
// Running a screener over the held-out set.

export type RunResult = {
  pages: number;
  skipped: number;
  asked: number;
  answered: number;
  errors: number;
  stopped?: string;
};

export async function runAnswers(options: {
  dataset: string;
  runs: string;
  screener: Screener;
  // One page's reply. Throws `StopRun` to end the run without recording the page.
  ask: (messages: Message[], id: string) => Promise<Reply>;
  concurrency?: number;
  retryErrors?: boolean;
  clock?: () => number;
  // Called with the pages still to ask, before any is sent; a string refuses the run.
  preflight?: (remaining: number) => string | null;
}): Promise<RunResult> {
  const { dataset, runs, screener, ask } = options;
  const clock = options.clock ?? (() => performance.now());
  const metas = readMetas(join(dataset, "eval.meta.jsonl"));
  const evalPath = join(dataset, "eval.jsonl");
  const { spans, sha256 } = indexLines(evalPath);
  if (spans.length !== metas.length) throw new Error("eval.jsonl and eval.meta.jsonl do not hold the same pages");
  const summary = JSON.parse(readFileSync(join(dataset, "summary.json"), "utf-8")) as {
    sha256?: { evaluation?: string };
  };
  if (summary.sha256?.evaluation !== sha256) throw new Error("eval.jsonl is not the file summary.json names");
  const file = answersFile(runs, screener);
  const done = readAnswers(file);
  const todo = metas
    .map((meta, index) => ({ meta, index }))
    .filter(({ meta }) => {
      const had = done.get(meta.id);
      return !had || (options.retryErrors && had.answer === null);
    });
  const result: RunResult = {
    pages: metas.length,
    skipped: metas.length - todo.length,
    asked: 0,
    answered: 0,
    errors: 0,
  };
  const refusal = options.preflight?.(todo.length);
  if (refusal) {
    result.stopped = refusal;
    return result;
  }
  const fd = openSync(evalPath, "r");
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped) {
      const item = todo[next++];
      if (!item) return;
      const started = clock();
      let line: AnswerLine;
      try {
        const reply = await ask(requestOf(readSpan(fd, spans[item.index] as Span)), item.meta.id);
        const answer = reply.incomplete ? null : parseAnswer(reply.text);
        line = {
          id: item.meta.id,
          answer,
          error: answer
            ? null
            : reply.incomplete
              ? `the reply was cut off (${reply.incomplete})`
              : "the reply was not a valid PageAnswer",
          latency_ms: Math.round(clock() - started),
          cost_usd: reply.usd ?? ESTIMATE_USD,
        };
      } catch (error) {
        if (error instanceof StopRun) {
          stopped = true;
          result.stopped = error.message;
          return;
        }
        line = {
          id: item.meta.id,
          answer: null,
          error: `the request failed (${(error as Error).message.slice(0, 120)})`,
          latency_ms: Math.round(clock() - started),
          cost_usd: 0,
        };
      }
      appendLine(file, line);
      result.asked++;
      if (line.answer) result.answered++;
      else result.errors++;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 1) }, worker));
  } finally {
    closeSync(fd);
  }
  return result;
}

// Spark's ask, one ledger-reserved call a page. `ask` is `sparkAsk(...)` in a run, a fake in a test.
export function sparkRunner(options: {
  ask: SparkAsk;
  ledgerFile: string;
  run: string;
  model: string;
  maxUsd: number;
  now: () => Date;
}) {
  return async (messages: Message[], id: string): Promise<Reply> => {
    const record: { reason: string | null } = { reason: null };
    const attempts = attemptLedger({ ...options, pageId: id, record });
    const { input, instructions } = sparkInput(messages);
    try {
      const reply = await options.ask(input, instructions, attempts);
      if (record.reason) throw new StopRun(record.reason);
      return reply;
    } catch (error) {
      if (error instanceof StopRun) throw error;
      if (error instanceof BudgetExceeded || error instanceof BudgetUnavailable)
        throw new StopRun(record.reason ?? `the Meta budget refused: ${error.message}`);
      throw error;
    }
  };
}

// The spend a Spark run would reach: this version's earlier evaluation entries plus the pages left, each at the mean
// of the settled ones so far or, with none, at the worst-case estimate.
export function sparkPreflight(ledger: ReturnType<typeof readLedger>, version: string, maxUsd: number) {
  return (remaining: number): string | null => {
    const mine = ledger.filter((e) => e.run.startsWith(ledgerCalls(version)));
    const settled = mine.filter((e) => e.state === "settled" && typeof e.cost === "number");
    const perPage = settled.length
      ? settled.reduce((s, e) => s + (e.cost as number), 0) / settled.length
      : ESTIMATE_USD;
    const spent = mine.reduce((s, e) => s + (typeof e.cost === "number" ? e.cost : e.estimate), 0);
    const projected = remaining * perPage;
    if (spent + projected > maxUsd)
      return `refused: ${remaining} pages would take this evaluation to about US$${(spent + projected).toFixed(2)}, past --max-usd ${maxUsd}`;
    if (glimmerSpend(ledger) + projected > GLIMMER_CAP_USD)
      return `refused: ${remaining} pages would take Glimmer's Spark spend past US$${GLIMMER_CAP_USD}`;
    return null;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Scoring.

export type Slice = {
  pages: number;
  lures: number;
  benign: number;
  answered: number;
  unanswered: number;
  accuracy: number | null;
  lure_recall: number | null;
  false_alarm_rate: number | null;
  lure_type_accuracy: number | null;
  latency_median_ms: number | null;
  cost_per_page_usd: number | null;
  missed: string[];
  false_alarms: string[];
};
export type Scored = {
  overall: Slice;
  south_africa: Slice;
  by_lure_type: Record<string, Slice>;
  by_benign_source: Record<string, Slice>;
  samples: Slice;
};
type Row = { meta: PageMeta; line: AnswerLine | undefined; answer: PageAnswer | null };

const ratio = (top: number, bottom: number) => (bottom ? top / bottom : null);
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

export function sliceOf(rows: Row[]): Slice {
  const trueLure = (row: Row) => row.meta.lure_type !== "none";
  const lures = rows.filter(trueLure);
  const benign = rows.filter((row) => !trueLure(row));
  const answered = rows.filter((row) => row.answer);
  const correct = rows.filter((row) => row.answer && row.answer.lure === trueLure(row));
  const caught = lures.filter((row) => row.answer?.lure === true);
  const alarms = benign.filter((row) => row.answer?.lure === true);
  const typed = lures.filter((row) => row.answer?.lure_type === row.meta.lure_type);
  const cost = rows.reduce((sum, row) => sum + (row.line?.cost_usd ?? 0), 0);
  return {
    pages: rows.length,
    lures: lures.length,
    benign: benign.length,
    answered: answered.length,
    unanswered: rows.length - answered.length,
    accuracy: ratio(correct.length, rows.length),
    lure_recall: ratio(caught.length, lures.length),
    false_alarm_rate: ratio(alarms.length, benign.length),
    lure_type_accuracy: ratio(typed.length, lures.length),
    latency_median_ms: median(answered.map((row) => row.line?.latency_ms ?? 0)),
    cost_per_page_usd: ratio(cost, rows.length),
    missed: lures.filter((row) => row.answer?.lure !== true).map((row) => row.meta.id),
    false_alarms: alarms.map((row) => row.meta.id),
  };
}

export function scoreScreener(metas: PageMeta[], answers: Map<string, AnswerLine>): Scored {
  const rows: Row[] = metas.map((meta) => {
    const line = answers.get(meta.id);
    // Parsed again, strictly: a line that does not hold a PageAnswer is unanswered, never a guess.
    const parsed = line?.answer ? PageAnswer.safeParse(line.answer) : null;
    return { meta, line, answer: parsed?.success ? parsed.data : null };
  });
  const group = (select: (row: Row) => string | null) => {
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = select(row);
      if (key !== null) groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return Object.fromEntries(
      [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => [key, sliceOf(list)]),
    );
  };
  return {
    overall: sliceOf(rows),
    south_africa: sliceOf(rows.filter((row) => row.meta.south_africa)),
    by_lure_type: group((row) => (row.meta.lure_type === "none" ? null : row.meta.lure_type)),
    by_benign_source: group((row) => (row.meta.lure_type === "none" ? row.meta.source : null)),
    samples: sliceOf(rows.filter((row) => row.meta.origin === "samples")),
  };
}

type BarSlice = {
  loupe_lure_recall: number | null;
  spark_lure_recall: number | null;
  loupe_false_alarm_rate: number | null;
  spark_false_alarm_rate: number | null;
  passed: boolean;
};
export type Bar = { result: "passed" | "failed"; overall: BarSlice; south_africa: BarSlice };

// Passed when Loupe's lure recall is higher than Spark's and its false-alarm rate no higher, overall and on the South
// African slice. A figure that cannot be computed on either side fails the slice.
export function barOf(loupe: Scored, spark: Scored | null): Bar | null {
  if (!spark) return null;
  const compare = (l: Slice, s: Slice): BarSlice => ({
    loupe_lure_recall: l.lure_recall,
    spark_lure_recall: s.lure_recall,
    loupe_false_alarm_rate: l.false_alarm_rate,
    spark_false_alarm_rate: s.false_alarm_rate,
    passed:
      l.lure_recall !== null &&
      s.lure_recall !== null &&
      l.false_alarm_rate !== null &&
      s.false_alarm_rate !== null &&
      l.lure_recall > s.lure_recall &&
      l.false_alarm_rate <= s.false_alarm_rate,
  });
  const overall = compare(loupe.overall, spark.overall);
  const southAfrica = compare(loupe.south_africa, spark.south_africa);
  return { result: overall.passed && southAfrica.passed ? "passed" : "failed", overall, south_africa: southAfrica };
}

export function scoreVersion(store: string, version: string, now: () => Date = () => new Date()) {
  const dataset = datasetDir(store, version);
  const runs = runDir(store, version);
  const metas = readMetas(join(dataset, "eval.meta.jsonl"));
  const summary = JSON.parse(readFileSync(join(dataset, "summary.json"), "utf-8")) as {
    sha256?: { evaluation?: string };
  };
  const evaluation = summary.sha256?.evaluation;
  if (typeof evaluation !== "string") throw new Error("summary.json does not name the evaluation file's sha256");
  const loupeFile = answersFile(runs, "loupe");
  if (!existsSync(loupeFile)) throw new Error(`no Loupe answers at ${loupeFile}; run the loupe command first`);
  const loupe = scoreScreener(metas, readAnswers(loupeFile));
  const sparkPath = answersFile(runs, "spark");
  const spark = existsSync(sparkPath) ? scoreScreener(metas, readAnswers(sparkPath)) : null;
  const metrics = {
    version,
    eval_sha256: evaluation,
    measured: now().toISOString(),
    ...loupe,
    spark,
    bar: barOf(loupe, spark),
    misses_by_cause: null,
  };
  writeAtomic(join(runs, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
  return metrics;
}

// ---------------------------------------------------------------------------------------------------------------
// The command line.

function readInferenceKey(): string {
  const key = execFileSync("conclave-op", ["read", `op://Conclave/${INFERENCE_KEY_ITEM}/credential`], {
    encoding: "utf-8",
    timeout: 60_000,
  }).trim();
  if (!key) throw new Error(`the vault item "${INFERENCE_KEY_ITEM}" has an empty credential`);
  return key;
}

export const USAGE =
  "usage: node scripts/glimmer/evaluate.ts loupe <version> --model <model> [--retry-errors]\n" +
  "       node scripts/glimmer/evaluate.ts spark <version> [--max-usd <n>] [--retry-errors]\n" +
  "       node scripts/glimmer/evaluate.ts score <version>";

export function parseEvaluateArgs(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      model: { type: "string" },
      "max-usd": { type: "string" },
      "retry-errors": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  const [command, version, ...extra] = positionals;
  if (command !== "loupe" && command !== "spark" && command !== "score") throw new TypeError("unknown command");
  if (extra.length) throw new TypeError("too many arguments");
  checkVersion(version);
  const maxUsd = values["max-usd"] === undefined ? DEFAULT_MAX_USD : Number(values["max-usd"]);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new TypeError("--max-usd must be a positive number");
  if (command === "loupe" && !values.model) throw new TypeError("loupe needs --model");
  return {
    command,
    version: version as string,
    model: values.model,
    maxUsd,
    retryErrors: values["retry-errors"] === true,
  };
}

if (import.meta.filename === process.argv[1]) {
  let args: ReturnType<typeof parseEvaluateArgs>;
  try {
    args = parseEvaluateArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`evaluate: ${(error as Error).message}\n${USAGE}`);
    process.exit(2);
  }
  try {
    const store = storeDir();
    const dataset = datasetDir(store, args.version);
    const runs = runDir(store, args.version);
    if (args.command === "score") {
      const metrics = scoreVersion(store, args.version);
      console.log(
        JSON.stringify({
          wrote: join(runs, "metrics.json"),
          overall: { lure_recall: metrics.overall.lure_recall, false_alarm_rate: metrics.overall.false_alarm_rate },
          bar: metrics.bar?.result ?? null,
        }),
      );
    } else if (args.command === "loupe") {
      configureNetwork();
      const ask = askLoupe(readInferenceKey(), args.model as string);
      console.log(
        JSON.stringify(
          await runAnswers({ dataset, runs, screener: "loupe", ask, concurrency: 4, retryErrors: args.retryErrors }),
        ),
      );
    } else {
      const ledgerFile = metaLedger();
      const release = takeLock(ledgerLock(ledgerFile));
      if (typeof release === "string") throw new Error(release);
      try {
        const secrets = await readSecretsFromVault();
        const env = { META_API_KEY: secrets.meta, CF_AIG_TOKEN: secrets.run, META_GATEWAY_URL: GATEWAY_URL };
        const clock = sharedClock();
        const run = `${ledgerCalls(args.version)}${Date.now()}`;
        const ask = sparkRunner({
          ask: sparkAsk({ env, budget: localBudget("glimmer-evaluate", undefined, clock.guard) }),
          ledgerFile,
          run,
          model: "muse-spark-1.3",
          maxUsd: args.maxUsd,
          now: clock.teacher,
        });
        console.log(
          JSON.stringify(
            await runAnswers({
              dataset,
              runs,
              screener: "spark",
              ask,
              retryErrors: args.retryErrors,
              preflight: sparkPreflight(readLedger(ledgerFile), args.version, args.maxUsd),
            }),
          ),
        );
      } finally {
        release();
      }
    }
  } catch (error) {
    console.error(`evaluate: ${(error as Error).message}`);
    process.exit(1);
  }
}
