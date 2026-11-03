// Loupe's held-out evaluation: a published dataset version's `eval.jsonl` through a screener, scored (D03 T04 §13).
//
//   node scripts/glimmer/evaluate.ts loupe <version> --model <Fireworks model or deployment> [--retry-errors]
//   node scripts/glimmer/evaluate.ts spark <version> [--max-usd <n>] [--retry-errors]
//   node scripts/glimmer/evaluate.ts score <version>
//   node scripts/glimmer/evaluate.ts causes <version>  # each miss's proposed causes, for Claude to confirm
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
  fstatSync,
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
import {
  BrandFreePageAnswer,
  jpegSize,
  MAX_TEXT_CHARACTERS,
  PageAnswer,
  type VersionedPageAnswer,
} from "../../src/vision/page-screen.ts";
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
import { MAX_HEIGHT, storeDir } from "./store.ts";
import {
  type AttemptLedger,
  ESTIMATE_USD,
  GLIMMER_CAP_USD,
  glimmerSpend,
  LedgerLocked,
  sharedClock,
  sparkAsk,
  withLedgerLock,
} from "./teacher-label.ts";

export const INFERENCE_KEY_ITEM = "IsItLegit Fireworks";
export const COMPLETIONS_URL = "https://api.fireworks.ai/inference/v1/chat/completions";
export const LOUPE_REQUEST_MS = 60_000;
export const DEFAULT_MAX_USD = 10;
// A held-out Loupe run's time on its deployment: 1.0's 1,000 pages took about 25 minutes at four at a time.
export const DEFAULT_MAX_MINUTES = 60;
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
  answer: VersionedPageAnswer | null;
  error: string | null;
  latency_ms: number;
  // Null where the page's cost is not known per request (Loupe's deployment is billed by GPU time).
  cost_usd: number | null;
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

// What a model said, parsed strictly. null when it is not a PageAnswer (or BrandFreePageAnswer when brandAsTruth is false).
export function parseAnswer(text: string, brandAsTruth = true): VersionedPageAnswer | null {
  try {
    const raw = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    const parsed = brandAsTruth ? PageAnswer.safeParse(raw) : BrandFreePageAnswer.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function datasetBrandAsTruth(dataset: string): boolean {
  for (const candidate of [join(dataset, "summary.json"), join(dataset, "..", "summary.json")]) {
    if (!existsSync(candidate)) continue;
    try {
      const summary = JSON.parse(readFileSync(candidate, "utf-8")) as { brandAsTruth?: unknown; version?: unknown };
      if (typeof summary.brandAsTruth === "boolean") return summary.brandAsTruth;
      if (typeof summary.version === "string") return summary.version === "1.0";
    } catch {
      // fall through
    }
  }
  return true;
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

// A line cut short by a kill or a full disk is ended before the next is appended, so the next answer starts on its own
// line instead of being joined to the fragment and lost with it (§13 completion review gap 2).
export function appendLine(path: string, line: AnswerLine) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a+");
  try {
    const size = fstatSync(fd).size;
    let tail = "";
    if (size > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) tail = "\n";
    }
    writeSync(fd, `${tail}${JSON.stringify(line)}\n`);
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
  // Fields sent with every request beside the messages (§1's comparison sends the screener's JSON schema format).
  body?: Record<string, unknown>;
  // Each request's own deadline, as the screener cuts it once warm (§1: 10 seconds); none by default.
  requestMs?: number;
  // A moment (epoch ms) no request or wait passes, however many pages are left: the run's reserved window (§1).
  deadlineAt?: number;
  now?: () => number;
};

// Loupe on Fireworks. A scaling-up deployment (503 DEPLOYMENT_SCALING_UP) or a rate limit (429) is retried with
// exponential backoff until `maxWaitMs` of waiting is spent; anything else throws with its status, never its body.
export function askLoupe(key: string, model: string, options: LoupeOptions = {}) {
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxWait = options.maxWaitMs ?? MAX_SCALING_WAIT_MS;
  return async (messages: Message[]): Promise<Reply> => {
    const body = JSON.stringify({ model, messages, temperature: 0, max_tokens: MAX_ANSWER_TOKENS, ...options.body });
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      if (
        options.deadlineAt !== undefined &&
        (options.now ?? Date.now)() + (options.requestMs ?? 0) > options.deadlineAt
      )
        throw new Error("the run's window is spent; no request starts past it");
      const response = await fetcher(COMPLETIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
        ...(options.requestMs ? { signal: AbortSignal.timeout(options.requestMs) } : {}),
      });
      const text = await response.text();
      if (response.ok) {
        const choice = (JSON.parse(text) as { choices?: { message?: { content?: unknown }; finish_reason?: string }[] })
          .choices?.[0];
        return {
          text: typeof choice?.message?.content === "string" ? choice.message.content : "",
          usd: null, // a deployment is billed by GPU time, not by the request: a page's cost is not known
          ...(choice?.finish_reason === "length" ? { incomplete: "length" } : {}),
        };
      }
      const scaling = response.status === 503 && text.includes("DEPLOYMENT_SCALING_UP");
      if (!scaling && response.status !== 429) throw new Error(`Fireworks answered ${response.status}`);
      const delay = Math.min(FIRST_BACKOFF_MS * 2 ** attempt, LONGEST_BACKOFF_MS);
      const clock = options.now ?? Date.now;
      if (options.deadlineAt !== undefined && clock() + delay + (options.requestMs ?? 0) > options.deadlineAt)
        throw new Error(`Fireworks answered ${response.status} and the run's window is spent`);
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
  // How long a change waits for a lock another process holds (`withLedgerLock`'s 30 s when not given).
  waitMs?: number;
  // The run names --max-usd counts: every run of this evaluation (its prefix); this run alone when not given.
  scope?: string;
}): AttemptLedger {
  const { ledgerFile, run, model, pageId, maxUsd, now, record, waitMs } = options;
  const held = new Map<string, { date: string; call: string }>();
  const close = (id: string, usd: number | null) => {
    const entry = held.get(id);
    if (!entry) return;
    try {
      withLedgerLock(
        ledgerFile,
        () => {
          const ledger = readLedger(ledgerFile);
          const found = ledger.find(
            (e) => e.date === entry.date && e.run === run && e.call === entry.call && e.state === "reserved",
          );
          if (found) record.reason = settleSpend(ledgerFile, ledger, found, usd) ?? record.reason;
        },
        waitMs,
      );
    } catch (error) {
      // Left reserved at its estimate, which still counts; the run stops on it.
      if (!(error instanceof LedgerLocked)) throw error;
      record.reason = error.message;
    }
  };
  return {
    reserve(attempt, estimateUsd) {
      const call = attempt === 1 ? `${model} ${pageId}` : `${model} ${pageId} attempt ${attempt}`;
      let reserved: ReturnType<typeof reserveSpend>;
      try {
        reserved = withLedgerLock(
          ledgerFile,
          () => {
            const ledger = readLedger(ledgerFile);
            // The evaluation's whole spend, every resumed run of it included, as the preflight counts it (§13 round 1).
            const mine = ledger
              .filter((e) => e.run.startsWith(options.scope ?? run))
              .reduce((sum, e) => sum + (typeof e.cost === "number" ? e.cost : e.estimate), 0);
            if (mine + estimateUsd > maxUsd) {
              record.reason = `the next attempt would take this evaluation past US$${maxUsd}`;
              throw new BudgetExceeded("total", model);
            }
            if (glimmerSpend(ledger) + estimateUsd > GLIMMER_CAP_USD) {
              record.reason = `the next attempt would take Glimmer's Spark spend past US$${GLIMMER_CAP_USD}`;
              throw new BudgetExceeded("total", model);
            }
            return reserveSpend(ledgerFile, ledger, { date: sastDay(now()), run, call, estimate: estimateUsd });
          },
          waitMs,
        );
      } catch (error) {
        if (!(error instanceof LedgerLocked)) throw error;
        record.reason = error.message;
        throw new BudgetUnavailable();
      }
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
  // The first and last request's wall-clock times (ISO), which the run's deployment time is read from; null when none.
  first_request_at?: string | null;
  last_request_at?: string | null;
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
  // The model asked (a Fireworks model or deployment, or Spark's id): the answers are bound to it and to the
  // evaluation file, and a run that would add answers from another model or file is refused.
  model?: string;
  // A time budget: no page starts after it, and the run stops between pages with the reason (§13 plan review gap 2).
  maxMs?: number;
  wall?: () => number;
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
  const brandAsTruth = datasetBrandAsTruth(dataset);
  const file = answersFile(runs, screener);
  if (options.model) bindAnswers(runs, screener, { model: options.model, eval_sha256: sha256 });
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
  const wall = options.wall ?? (() => Date.now());
  const runStart = clock();
  let first: number | null = null;
  let lastAt: number | null = null;
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped) {
      if (options.maxMs !== undefined && clock() - runStart >= options.maxMs) {
        stopped = true;
        result.stopped = `the run reached its ${Math.round(options.maxMs / 60_000)} minutes`;
        return;
      }
      const item = todo[next++];
      if (!item) return;
      const started = clock();
      first ??= wall();
      let line: AnswerLine;
      try {
        const reply = await ask(requestOf(readSpan(fd, spans[item.index] as Span)), item.meta.id);
        const answer = reply.incomplete ? null : parseAnswer(reply.text, brandAsTruth);
        line = {
          id: item.meta.id,
          answer,
          error: answer
            ? null
            : reply.incomplete
              ? `the reply was cut off (${reply.incomplete})`
              : brandAsTruth
                ? "the reply was not a valid PageAnswer"
                : "the reply was not a valid BrandFreePageAnswer",
          latency_ms: Math.round(clock() - started),
          // Spark's cost is Meta's, or its estimate when Meta reports none; Loupe's is not known per page.
          cost_usd: reply.usd ?? (screener === "spark" ? ESTIMATE_USD : null),
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
          cost_usd: screener === "spark" ? 0 : null,
        };
      }
      appendLine(file, line);
      lastAt = wall();
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
  result.first_request_at = first === null ? null : new Date(first).toISOString();
  result.last_request_at = lastAt === null ? null : new Date(lastAt).toISOString();
  return result;
}

// Spark's ask, one ledger-reserved call a page. `ask` is `sparkAsk(...)` in a run, a fake in a test.
// What a screener's answers were asked of: `<runs>/<screener>.identity.json`, written by the first run and checked by
// every later one, so a resume never mixes answers from another model or another evaluation file.
export type Identity = { model: string; eval_sha256: string };
export const identityFile = (runs: string, screener: Screener) => join(runs, `${screener}.identity.json`);
export function readIdentity(runs: string, screener: Screener): Identity | null {
  const file = identityFile(runs, screener);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as Identity) : null;
}
export function bindAnswers(runs: string, screener: Screener, identity: Identity): void {
  const had = readIdentity(runs, screener);
  if (had && (had.model !== identity.model || had.eval_sha256 !== identity.eval_sha256))
    throw new Error(
      `the ${screener} answers were asked of ${had.model} on eval ${had.eval_sha256.slice(0, 12)}, not ${identity.model} on ${identity.eval_sha256.slice(0, 12)}; move them aside to start again`,
    );
  if (!had) {
    // A file of answers from before the binding was recorded holds answers of an unknown model: refused, not adopted.
    if (existsSync(answersFile(runs, screener)) && readAnswers(answersFile(runs, screener)).size)
      throw new Error(`the ${screener} answers have no identity file, so what they were asked of is unknown`);
    mkdirSync(runs, { recursive: true });
    writeAtomic(identityFile(runs, screener), `${JSON.stringify(identity)}\n`);
  }
}

export function sparkRunner(options: {
  ask: SparkAsk;
  ledgerFile: string;
  run: string;
  scope?: string;
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

// One Spark run over a version's held-out pages. One run at a time on this version's answers (`spark.lock` beside
// them); the shared Meta ledger is locked per change only (`withLedgerLock`), never for the run, so the other lanes'
// runs reserve and settle while this one runs (coordinator, 2026-10-31).
export async function sparkEvaluation(options: {
  dataset: string;
  runs: string;
  version: string;
  ledgerFile: string;
  ask: SparkAsk;
  maxUsd: number;
  retryErrors?: boolean;
  now: () => Date;
  // The ledger's run name for these calls: the version's evaluation by default; another set (§1's monitor pages) names
  // its own, so its spend is counted apart from the held-out run's.
  calls?: string;
}) {
  const { dataset, runs, version, ledgerFile, maxUsd, now } = options;
  const calls = options.calls ?? ledgerCalls(version);
  const release = takeLock(join(runs, "spark.lock"));
  if (typeof release === "string") throw new Error(release);
  try {
    const ask = sparkRunner({
      ask: options.ask,
      ledgerFile,
      run: `${calls}${Date.now()}`,
      scope: calls,
      model: "muse-spark-1.3",
      maxUsd,
      now,
    });
    return await runAnswers({
      dataset,
      runs,
      screener: "spark",
      model: "muse-spark-1.3",
      ask,
      retryErrors: options.retryErrors === true,
      preflight: sparkPreflight(readLedger(ledgerFile), version, maxUsd, calls),
    });
  } finally {
    release();
  }
}

// The spend a Spark run would reach: this version's earlier evaluation entries plus the pages left, each at the mean
// of the settled ones so far or, with none, at the mean of the teacher's settled calls (the same requests to the same
// model, `sparkAsk`), and only with neither at the worst-case estimate.
export function sparkPreflight(
  ledger: ReturnType<typeof readLedger>,
  version: string,
  maxUsd: number,
  calls: string = ledgerCalls(version),
) {
  const settledMean = (entries: ReturnType<typeof readLedger>) => {
    const settled = entries.filter((e) => e.state === "settled" && typeof e.cost === "number");
    return settled.length ? settled.reduce((s, e) => s + (e.cost as number), 0) / settled.length : null;
  };
  return (remaining: number): string | null => {
    const mine = ledger.filter((e) => e.run.startsWith(calls));
    const perPage =
      settledMean(mine) ?? settledMean(ledger.filter((e) => e.run.startsWith("glimmer-teacher-"))) ?? ESTIMATE_USD;
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
  // Every page has a valid answer: only then are its rates a screener's figures and not a partial run's.
  complete: boolean;
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
  // The lure types among the South African lures, with their counts: what the South African figures cover.
  south_africa_lure_types: Record<string, number>;
};
type Row = { meta: PageMeta; line: AnswerLine | undefined; answer: VersionedPageAnswer | null };

const ratio = (top: number, bottom: number) => (bottom ? top / bottom : null);
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

export function sliceOf(rows: Row[], costKnown = true): Slice {
  const trueLure = (row: Row) => row.meta.lure_type !== "none";
  const lures = rows.filter(trueLure);
  const benign = rows.filter((row) => !trueLure(row));
  const answered = rows.filter((row) => row.answer);
  const correct = rows.filter((row) => row.answer && row.answer.lure === trueLure(row));
  const caught = lures.filter((row) => row.answer?.lure === true);
  const alarms = benign.filter((row) => row.answer?.lure === true);
  const typed = lures.filter((row) => row.answer?.lure_type === row.meta.lure_type);
  const cost = rows.reduce((sum, row) => sum + (row.line?.cost_usd ?? 0), 0);
  const costUnknown = !costKnown || rows.some((row) => row.line && row.line.cost_usd === null);
  return {
    complete: rows.length > 0 && answered.length === rows.length,
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
    cost_per_page_usd: costUnknown ? null : ratio(cost, rows.length),
    missed: lures.filter((row) => row.answer?.lure !== true).map((row) => row.meta.id),
    false_alarms: alarms.map((row) => row.meta.id),
  };
}

export function scoreScreener(
  metas: PageMeta[],
  answers: Map<string, AnswerLine>,
  costKnown = true,
  brandAsTruth = true,
): Scored {
  const rows: Row[] = metas.map((meta) => {
    const line = answers.get(meta.id);
    // Parsed again, strictly: a line that does not hold a PageAnswer is unanswered, never a guess.
    const parsed = line?.answer
      ? brandAsTruth
        ? PageAnswer.safeParse(line.answer)
        : BrandFreePageAnswer.safeParse(line.answer)
      : null;
    return { meta, line, answer: parsed?.success ? parsed.data : null };
  });
  const group = (select: (row: Row) => string | null) => {
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = select(row);
      if (key !== null) groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return Object.fromEntries(
      [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => [key, sliceOf(list, costKnown)]),
    );
  };
  return {
    overall: sliceOf(rows, costKnown),
    south_africa: sliceOf(
      rows.filter((row) => row.meta.south_africa),
      costKnown,
    ),
    by_lure_type: group((row) => (row.meta.lure_type === "none" ? null : row.meta.lure_type)),
    by_benign_source: group((row) => (row.meta.lure_type === "none" ? row.meta.source : null)),
    samples: sliceOf(
      rows.filter((row) => row.meta.origin === "samples"),
      costKnown,
    ),
    south_africa_lure_types: rows
      .filter((row) => row.meta.south_africa && row.meta.lure_type !== "none")
      .reduce<Record<string, number>>((acc, row) => {
        acc[row.meta.lure_type] = (acc[row.meta.lure_type] ?? 0) + 1;
        return acc;
      }, {}),
  };
}

type BarSlice = {
  loupe_lure_recall: number | null;
  spark_lure_recall: number | null;
  loupe_false_alarm_rate: number | null;
  spark_false_alarm_rate: number | null;
  // The slice's denominators, so a figure with none is read as empty by definition.
  lures: number;
  benign: number;
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
    lures: l.lures,
    benign: l.benign,
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

// One set's figures (the teacher-agreed evaluation, or §13's independent reference set): both screeners scored on its
// pages, the bar drawn only on two complete runs, with the reason when it is withheld.
// The bar 1.0 is judged on (operator, 2026-10-31 18:46 SAST): Loupe's lure recall at least Spark's and its false-alarm
// rate at most 6 percent, on the evaluation set and on the independent reference set alike, and on the South African
// slice only where it holds enough pages to say anything (`MIN_SLICE` lures and benign pages; its n is reported either
// way). The earlier bar ("false alarms no higher than Spark's", `barOf`) read Spark's own labels back on the evaluation
// set, so it could only flatter Spark; its result is kept beside this one.
export const MAX_FALSE_ALARMS = 0.06;
export const MIN_SLICE = 30;
type TimeBoxedSlice = {
  loupe_lure_recall: number | null;
  spark_lure_recall: number | null;
  loupe_false_alarm_rate: number | null;
  lures: number;
  benign: number;
  judged: boolean;
  passed: boolean | null;
};
export type TimeBoxedBar = { result: "passed" | "failed"; overall: TimeBoxedSlice; south_africa: TimeBoxedSlice };
export function timeBoxedBar(loupe: Scored, spark: Scored | null): TimeBoxedBar | null {
  if (!spark) return null;
  const judge = (l: Slice, s: Slice, always: boolean): TimeBoxedSlice => {
    const judged = always || (l.lures >= MIN_SLICE && l.benign >= MIN_SLICE);
    return {
      loupe_lure_recall: l.lure_recall,
      spark_lure_recall: s.lure_recall,
      loupe_false_alarm_rate: l.false_alarm_rate,
      lures: l.lures,
      benign: l.benign,
      judged,
      passed: judged
        ? l.lure_recall !== null &&
          s.lure_recall !== null &&
          l.false_alarm_rate !== null &&
          l.lure_recall >= s.lure_recall &&
          l.false_alarm_rate <= MAX_FALSE_ALARMS
        : null,
    };
  };
  const overall = judge(loupe.overall, spark.overall, true);
  const southAfrica = judge(loupe.south_africa, spark.south_africa, false);
  const passed = overall.passed === true && southAfrica.passed !== false;
  return { result: passed ? "passed" : "failed", overall, south_africa: southAfrica };
}

export function scoreSet(dataset: string, runs: string) {
  const metas = readMetas(join(dataset, "eval.meta.jsonl"));
  const summary = JSON.parse(readFileSync(join(dataset, "summary.json"), "utf-8")) as {
    sha256?: { evaluation?: string };
  };
  const evaluation = summary.sha256?.evaluation;
  if (typeof evaluation !== "string") throw new Error("summary.json does not name the evaluation file's sha256");
  const brandAsTruth = datasetBrandAsTruth(dataset);
  const loupeFile = answersFile(runs, "loupe");
  if (!existsSync(loupeFile)) throw new Error(`no Loupe answers at ${loupeFile}; run the loupe command first`);
  // Loupe's cost per page is not known per request (its deployment is billed by GPU time): reconciled from the bill.
  const loupe = scoreScreener(metas, readAnswers(loupeFile), false, brandAsTruth);
  const sparkPath = answersFile(runs, "spark");
  const sparkAnswers = existsSync(sparkPath) ? readAnswers(sparkPath) : null;
  const spark = sparkAnswers ? scoreScreener(metas, sparkAnswers, true, brandAsTruth) : null;
  // Pages Spark has not been asked yet (a run still going, or stopped at a cap) are not Spark's misses.
  const sparkPending = sparkAnswers ? metas.filter((m) => !sparkAnswers.has(m.id)).length : null;
  const identities = { loupe: readIdentity(runs, "loupe"), spark: readIdentity(runs, "spark") };
  for (const [screener, identity] of Object.entries(identities))
    if (identity && identity.eval_sha256 !== evaluation)
      throw new Error(`the ${screener} answers were asked on another evaluation file (${identity.eval_sha256})`);
  // The bar is drawn only on two complete runs: every page answered by both, an error or a page not yet asked on
  // either side withholds it, with the reason, so a partial run is never scored as the screener's figures.
  const withheld = !spark
    ? "Spark has not been run"
    : sparkPending
      ? `Spark has ${sparkPending} pages not yet asked`
      : !spark.overall.complete
        ? `Spark has ${spark.overall.unanswered} pages without a valid answer; run spark with --retry-errors`
        : !loupe.overall.complete
          ? `Loupe has ${loupe.overall.unanswered} pages without a valid answer; run loupe with --retry-errors`
          : null;
  return {
    evaluation,
    loupe,
    spark,
    sparkPending,
    identities,
    withheld,
    bar: withheld ? null : timeBoxedBar(loupe, spark),
    bar_spark_relative: withheld ? null : barOf(loupe, spark),
  };
}

// §13's independent reference set beside the version's own (`build-dataset.ts reference`), and its answers.
export const referenceDataset = (store: string, version: string) => join(datasetDir(store, version), "reference");
export const referenceRuns = (store: string, version: string) => join(runDir(store, version), "reference");

export function scoreVersion(store: string, version: string, now: () => Date = () => new Date()) {
  const runs = runDir(store, version);
  const set = scoreSet(datasetDir(store, version), runs);
  // The South African figures rest on the redacted sample lures (§13, from §8's plan review finding 2): a version whose
  // evaluation holds none has no South African lure figure to report, so no metrics are written for it.
  if (!set.loupe.samples.lures)
    throw new Error("the evaluation holds no sample-derived lure: there is no South African lure figure to report");
  // The reference set's figures, when its pages have Loupe answers: drawn before any teacher check and kept whatever
  // Spark answered, so it is the set on which Spark's own errors count against it (§13, filed from §9 and §10).
  const reference = existsSync(answersFile(referenceRuns(store, version), "loupe"))
    ? scoreSet(referenceDataset(store, version), referenceRuns(store, version))
    : null;
  const metrics = {
    version,
    eval_sha256: set.evaluation,
    measured: now().toISOString(),
    ...set.loupe,
    spark: set.spark,
    spark_pending: set.sparkPending,
    identities: set.identities,
    // The bar (operator, 2026-10-31 18:46 SAST), and the earlier Spark-relative reading kept beside it.
    bar: set.bar,
    bar_spark_relative: set.bar_spark_relative,
    bar_withheld: set.withheld,
    reference: reference && {
      eval_sha256: reference.evaluation,
      loupe: reference.loupe,
      spark: reference.spark,
      spark_pending: reference.sparkPending,
      identities: reference.identities,
      bar: reference.bar,
      bar_spark_relative: reference.bar_spark_relative,
      bar_withheld: reference.withheld,
    },
    // Passed only when both sets pass the bar; null while either is withheld or the reference set is not run.
    bar_both_sets:
      set.bar && reference?.bar
        ? set.bar.result === "passed" && reference.bar.result === "passed"
          ? "passed"
          : "failed"
        : null,
    misses_by_cause: null,
  };
  writeAtomic(join(runs, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
  return metrics;
}

// ---------------------------------------------------------------------------------------------------------------
// Miss causes (§13, plan review gap 6): each missed lure and false alarm gets the causes its training set's own records
// propose, for Claude to confirm or correct in `causes.json` before a retrain; only a confirmed cause counts.

export const CAUSES = [
  "brand absent from training",
  "lure type underrepresented",
  "text truncated",
  "screenshot cut too short",
  "wrong label?",
] as const;
export type CausePage = {
  id: string;
  kind: "missed" | "false alarm";
  lure_type: string;
  brand: string | null;
  proposed: (typeof CAUSES)[number][];
  confirmed: string | null;
};
// A lure type under this share of the training lines is underrepresented.
export const RARE_SHARE = 0.05;
// A cause that holds for at least this share of every evaluation page cannot tell a miss from a hit, so it is not
// proposed (2026-10-31: 991 of 1.0's 1,000 pages are cut at the render's height limit). Each cause's share over every
// page is recorded beside the proposals, so the confirmer weighs a cause against how common it is.
export const UNTELLING_SHARE = 0.9;

// What one evaluation line shows, read from the line itself: its page text's length in characters and its
// screenshot's height.
export function lineFacts(line: string): { textCharacters: number | null; screenshotHeight: number | null } {
  const user = requestOf(line)[1];
  const parts = Array.isArray(user?.content)
    ? (user.content as { type: string; text?: string; image_url?: { url: string } }[])
    : [];
  const text = parts.map((part) => part.text ?? "").join("\n");
  const block = /<<UNTRUSTED:page-text:([0-9a-f]{32})>>\n([\s\S]*?)\n<<END:\1>>/.exec(text);
  const url = parts.find((part) => part.type === "image_url")?.image_url?.url ?? "";
  const data = /^data:image\/jpeg;base64,(.+)$/.exec(url)?.[1];
  const size = data ? jpegSize(Buffer.from(data, "base64")) : null;
  return {
    textCharacters: block ? Array.from(block[2] as string).length : null,
    screenshotHeight: size?.height ?? null,
  };
}

// `set` is the pages judged: the held-out evaluation set, or §13's independent reference set (completion review gap 6).
// The training set's records are the version's either way.
export function proposeCauses(
  store: string,
  version: string,
  screener: Screener = "loupe",
  set: "evaluation" | "reference" = "evaluation",
) {
  const training = datasetDir(store, version);
  const dataset = set === "reference" ? referenceDataset(store, version) : training;
  const runs = set === "reference" ? referenceRuns(store, version) : runDir(store, version);
  const metas = readMetas(join(dataset, "eval.meta.jsonl"));
  const brandAsTruth = datasetBrandAsTruth(dataset);
  const answers = readAnswers(answersFile(runs, screener));
  // The training set's brands and lure types, from its own records.
  const brands = new Set<string>();
  const types = new Map<string, number>();
  let lines = 0;
  eachLine(join(training, "train.meta.jsonl"), (row) => {
    const meta = JSON.parse(row) as { brand?: string | null; brand_identity?: string | null; lure_type: string };
    const brand = meta.brand_identity ?? meta.brand?.toLowerCase() ?? null;
    if (brand) brands.add(brand);
    types.set(meta.lure_type, (types.get(meta.lure_type) ?? 0) + 1);
    lines++;
  });
  const { spans } = indexLines(join(dataset, "eval.jsonl"));
  const file = join(runs, `${screener}.causes.json`);
  const earlier = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf-8")) as { pages: CausePage[]; confirmed_by?: string })
    : null;
  const had = new Map((earlier?.pages ?? []).map((page) => [page.id, page]));
  let baseRates: Record<string, number> = {};
  const fd = openSync(join(dataset, "eval.jsonl"), "r");
  const pages: CausePage[] = [];
  // Each page's causes, for every evaluation page: their shares over all pages are the base rates.
  const causesOf = (meta: PageMeta, index: number): CausePage["proposed"] => {
    const raw = meta as PageMeta & { brand_identity?: string | null };
    const brand = raw.brand_identity ?? meta.brand?.toLowerCase() ?? null;
    const facts = lineFacts(readSpan(fd, spans[index] as Span));
    const found: CausePage["proposed"] = [];
    if (brand && !brands.has(brand)) found.push("brand absent from training");
    if (meta.lure_type !== "none" && (types.get(meta.lure_type) ?? 0) / Math.max(1, lines) < RARE_SHARE)
      found.push("lure type underrepresented");
    if ((facts.textCharacters ?? 0) >= MAX_TEXT_CHARACTERS) found.push("text truncated");
    if ((facts.screenshotHeight ?? 0) >= MAX_HEIGHT) found.push("screenshot cut too short");
    return found;
  };
  const everyPage: Record<string, number> = {};
  const all: CausePage["proposed"][] = [];
  try {
    metas.forEach((meta, index) => {
      const found = causesOf(meta, index);
      all.push(found);
      for (const cause of found) everyPage[cause] = (everyPage[cause] ?? 0) + 1;
    });
    const base = Object.fromEntries(
      Object.entries(everyPage).map(([cause, n]) => [cause, Math.round((n / Math.max(1, metas.length)) * 1000) / 1000]),
    );
    metas.forEach((meta, index) => {
      const rawAnswer = answers.get(meta.id)?.answer;
      const parsed = rawAnswer
        ? brandAsTruth
          ? PageAnswer.safeParse(rawAnswer)
          : BrandFreePageAnswer.safeParse(rawAnswer)
        : null;
      const answer = parsed?.success ? parsed.data : null;
      const lure = meta.lure_type !== "none";
      const kind = lure && answer?.lure !== true ? "missed" : !lure && answer?.lure === true ? "false alarm" : null;
      if (!kind) return;
      const raw = meta as PageMeta & { brand_identity?: string | null };
      const brand = raw.brand_identity ?? meta.brand?.toLowerCase() ?? null;
      const proposed = (all[index] ?? []).filter((cause) => (base[cause] ?? 0) < UNTELLING_SHARE);
      if (!proposed.length) proposed.push("wrong label?");
      // A rerun keeps what Claude confirmed.
      pages.push({
        id: meta.id,
        kind,
        lure_type: meta.lure_type,
        brand,
        proposed,
        confirmed: had.get(meta.id)?.confirmed ?? null,
      });
    });
    baseRates = base;
  } finally {
    closeSync(fd);
  }
  const count = (select: (page: CausePage) => string[]) => {
    const counts: Record<string, number> = {};
    for (const page of pages) for (const cause of select(page)) counts[cause] = (counts[cause] ?? 0) + 1;
    return counts;
  };
  const record = {
    version,
    screener,
    // Each cause's share over every evaluation page; a cause at UNTELLING_SHARE or above is not proposed.
    base_rates: baseRates,
    // Who confirmed the causes and from what, kept across a rerun.
    ...(earlier?.confirmed_by ? { confirmed_by: earlier.confirmed_by } : {}),
    pages,
    proposed: count((page) => page.proposed),
    confirmed: count((page) => (page.confirmed ? [page.confirmed] : [])),
    unconfirmed: pages.filter((page) => !page.confirmed).length,
  };
  writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

// ---------------------------------------------------------------------------------------------------------------
// The command line.

export function readInferenceKey(): string {
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
  "       node scripts/glimmer/evaluate.ts causes <version>\n" +
  "       node scripts/glimmer/evaluate.ts score <version>";

export function parseEvaluateArgs(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      model: { type: "string" },
      "max-usd": { type: "string" },
      "max-minutes": { type: "string" },
      set: { type: "string" },
      "retry-errors": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  const [command, version, ...extra] = positionals;
  if (command !== "loupe" && command !== "spark" && command !== "score" && command !== "causes")
    throw new TypeError("unknown command");
  if (extra.length) throw new TypeError("too many arguments");
  checkVersion(version);
  const maxUsd = values["max-usd"] === undefined ? DEFAULT_MAX_USD : Number(values["max-usd"]);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new TypeError("--max-usd must be a positive number");
  if (command === "loupe" && !values.model) throw new TypeError("loupe needs --model");
  const set = values.set ?? "evaluation";
  if (set !== "evaluation" && set !== "reference") throw new TypeError("--set is evaluation or reference");
  if (set === "reference" && command === "score")
    throw new TypeError("--set reference is for loupe, spark and causes; score reports both sets");
  const maxMinutes = values["max-minutes"] === undefined ? DEFAULT_MAX_MINUTES : Number(values["max-minutes"]);
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new TypeError("--max-minutes must be a positive number");
  return {
    command,
    version: version as string,
    model: values.model,
    maxUsd,
    maxMinutes,
    set,
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
    // `--set reference` asks the screeners about §13's independent reference pages, answered beside the version's.
    const dataset = args.set === "reference" ? referenceDataset(store, args.version) : datasetDir(store, args.version);
    const runs = args.set === "reference" ? referenceRuns(store, args.version) : runDir(store, args.version);
    if (args.command === "causes") {
      const record = proposeCauses(store, args.version, "loupe", args.set as "evaluation" | "reference");
      console.log(
        JSON.stringify({
          wrote: join(runs, "loupe.causes.json"),
          pages: record.pages.length,
          proposed: record.proposed,
          unconfirmed: record.unconfirmed,
        }),
      );
    } else if (args.command === "score") {
      const metrics = scoreVersion(store, args.version);
      console.log(
        JSON.stringify({
          wrote: join(runs, "metrics.json"),
          overall: { lure_recall: metrics.overall.lure_recall, false_alarm_rate: metrics.overall.false_alarm_rate },
          // The decision is both sets' (the operator's bar), each set's result beside it, and why one is withheld.
          bar_both_sets: metrics.bar_both_sets,
          bar: { evaluation: metrics.bar?.result ?? null, reference: metrics.reference?.bar?.result ?? null },
          withheld: { evaluation: metrics.bar_withheld ?? null, reference: metrics.reference?.bar_withheld ?? null },
        }),
      );
    } else if (args.command === "loupe") {
      configureNetwork();
      // Each request, its body included, ends within a minute (a page took 3.9 s at the median): a stalled request
      // cannot hold the run past its --max-minutes (§13 completion review gap 3).
      const ask = askLoupe(readInferenceKey(), args.model as string, { requestMs: LOUPE_REQUEST_MS });
      console.log(
        JSON.stringify(
          await runAnswers({
            dataset,
            runs,
            screener: "loupe",
            ask,
            concurrency: 4,
            retryErrors: args.retryErrors,
            model: args.model as string,
            maxMs: args.maxMinutes * 60_000,
          }),
        ),
      );
    } else {
      const secrets = await readSecretsFromVault();
      const env = { META_API_KEY: secrets.meta, CF_AIG_TOKEN: secrets.run, META_GATEWAY_URL: GATEWAY_URL };
      const clock = sharedClock();
      console.log(
        JSON.stringify(
          await sparkEvaluation({
            dataset,
            runs,
            version: args.version,
            ledgerFile: metaLedger(),
            ask: sparkAsk({ env, budget: localBudget("glimmer-evaluate", undefined, clock.guard) }),
            maxUsd: args.maxUsd,
            retryErrors: args.retryErrors,
            now: clock.teacher,
          }),
        ),
      );
    }
  } catch (error) {
    console.error(`evaluate: ${(error as Error).message}`);
    process.exit(1);
  }
}
