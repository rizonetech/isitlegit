// Muse Spark as a second opinion on Loupe's evaluation pages (D03 T04 §9).
//
//   node scripts/glimmer/teacher-label.ts [--max <pages>]
//
// The free rules (`label-rules.ts`) fill every brand and lure type, so Spark's job is a check, not a fill: it answers
// the screener's own request (`buildScreenRequest`, `SCREENER_SYSTEM_PROMPT`) for the pages that can enter evaluation (a
// trusted `lure`), South African pages first. A page where Spark's `lure` disagrees with its source's is written to
// `<store>/review-queue.jsonl`, which keeps it out of training and evaluation (the operator removed the human checks,
// 2026-10-28 21:32 SAST); neither label is overwritten. A field still missing is filled with label source `spark`, which
// evaluation never trusts. `lure` never comes from Spark. Each checked page's outcome is kept in
// `raw/teacher/state.json`, and §10 admits to evaluation only a page whose state is `agreed` (`teacherState`).
//
// Spend: every attempt, a retry included, reserves its own entry in the one Meta ledger both lanes share before it is
// sent, under the ledger's run lock, with `run` = `glimmer-teacher-<id>`, dated by the SAST day; it is settled at that
// attempt's cost, or left at its estimate when its answer is lost. No attempt is sent that would take the ledger's
// `glimmer-` entries past US$20. Each attempt's guard row (main's budget guard) carries its entry's ledger id, so an
// import of the local ledger never counts an attempt twice (scripts/meta-spend-import.ts).
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { type MetaContext, metaResponses } from "../../src/meta/client.ts";
import { sastDay } from "../../src/meta/day.ts";
import { type Budget, BudgetExceeded, BudgetUnavailable } from "../../src/meta/guard.ts";
import { buildScreenRequest, PageAnswer, SCREENER_SYSTEM_PROMPT } from "../../src/vision/page-screen.ts";
import { ledgerId, localBudget } from "../lib/meta-budget.ts";
import {
  GATEWAY_URL,
  metaLedger,
  readLedger,
  readSecretsFromVault,
  reserveSpend,
  type Spend,
  settleSpend,
  takeLock,
  tokenCost,
} from "../meta-smoke.ts";
import { openStore, type StoredPage, storeDir } from "./store.ts";

export const SPARK = "muse-spark-1.3";
export const GLIMMER_CAP_USD = 20;
// The teacher's answer is one PageAnswer object (a verdict, a brand, two form flags and a short reason).
export const TEACHER_MAX_OUTPUT_TOKENS = 600;
// A worst case for one attempt: the system prompt and up to 6,000 characters of text, one 1280 by 2000 screenshot, and
// the whole answer the request allows.
export const ESTIMATE_USD = tokenCost(SPARK, 9_000, TEACHER_MAX_OUTPUT_TOKENS);
const TRUSTED = new Set(["ground-truth", "construction", "dom", "claude", "astra+claude"]);

// The ledger's run lock beside it, never the ledger itself: a lock written over the ledger's path leaves it unreadable.
export const ledgerLock = (ledgerFile: string) => `${ledgerFile}.lock`;

// One page's attempts in the local ledger: `reserve` records an attempt before it is sent (refusing one that would
// pass the cap, or that cannot be written) and answers its ledger id; the others close it.
export type AttemptLedger = {
  reserve(attempt: number, estimateUsd: number): string;
  settle(id: string, usd: number): void;
  uncertain(id: string): void;
};

export type Ask = (
  input: unknown[],
  instructions: string,
  attempts: AttemptLedger,
) => Promise<{ text: string; usd: number | null }>;

// The teacher's Spark call, through main's client and budget guard (D03 T01 §2): every attempt the client makes is
// reserved first in the local ledger (`attempts`) and then in `budget` under the same id, and closed in both. A cap's
// refusal (`BudgetExceeded`) or a ledger or budget that cannot be written (`BudgetUnavailable`) sends nothing, and
// `teach()` stops on either.
export function sparkAsk(context: Omit<MetaContext, "owner">): Ask {
  return async (input, instructions, attempts) => {
    const ids = new Map<string, string>(); // the guard's id of each attempt, to its local ledger id
    const budget: Budget = {
      ...context.budget,
      reserve: async (model, estimateUsd, attempt, _id, call) => {
        const local = attempts.reserve(attempt, estimateUsd);
        let guarded: string;
        try {
          guarded = await context.budget.reserve(model, estimateUsd, attempt, local, call);
        } catch (error) {
          attempts.settle(local, 0); // the guard refused it or could not record it: nothing was sent
          throw error;
        }
        ids.set(guarded, local);
        return guarded;
      },
      settle: async (id, actualUsd, record) => {
        await context.budget.settle(id, actualUsd, record);
        const local = ids.get(id);
        if (local) attempts.settle(local, actualUsd);
      },
      uncertain: async (id, record) => {
        await context.budget.uncertain(id, record);
        const local = ids.get(id);
        if (local) attempts.uncertain(local);
      },
    };
    const { data } = await metaResponses(
      { model: SPARK, input: input as never, instructions, max_output_tokens: TEACHER_MAX_OUTPUT_TOKENS },
      { ...context, budget, owner: { kind: "script", name: "glimmer-teacher-label" } },
    );
    const usage = (
      data as {
        usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
      }
    ).usage;
    const usd =
      typeof usage?.input_tokens === "number" && typeof usage?.output_tokens === "number"
        ? tokenCost(SPARK, usage.input_tokens, usage.output_tokens, usage.input_tokens_details?.cached_tokens ?? 0)
        : null;
    return { text: (data as { output_text?: string }).output_text ?? "", usd };
  };
}

// The ledger's spend on Glimmer's Spark work so far: every `glimmer-` entry's cost, else its estimate.
export function glimmerSpend(ledger: Spend[]): number {
  return ledger
    .filter((entry) => entry.run.startsWith("glimmer-"))
    .reduce((sum, entry) => sum + (typeof entry.cost === "number" ? entry.cost : entry.estimate), 0);
}

// The screener's request as Responses input: the page text and the screenshot, the system prompt as instructions.
export function responsesInput(page: StoredPage, screenshot: Uint8Array, text: string): unknown[] {
  const request = buildScreenRequest({ image: screenshot, host: page.host, text, mode: "image" });
  const user = request.messages.find((m) => m.role === "user");
  const parts = Array.isArray(user?.content) ? user.content : [];
  return [
    {
      role: "user",
      content: parts.map((part) =>
        part.type === "text"
          ? { type: "input_text", text: part.text }
          : { type: "input_image", image_url: part.image_url.url },
      ),
    },
  ];
}

// A checked page's outcome. `pending` is written before its first attempt; `agreed` and `disputed` carry Spark's answer
// and `applied` once its queue entry and filled fields are written; `failed` (no valid answer, or a run stopped while
// it was out) and `refused` (the budget sent nothing) carry the reason. Only a refused page is ever sent again.
export type PageOutcome =
  | { status: "pending" }
  | { status: "agreed" | "disputed"; answer: PageAnswer | null; applied: boolean }
  | { status: "failed" | "refused"; reason: string };
export type TeacherStatus = PageOutcome["status"] | "unchecked";

const stateFile = (dir: string) => join(dir, "raw", "teacher", "state.json");
const queueFile = (dir: string) => join(dir, "review-queue.jsonl");

function writeDurably(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const parent = openSync(dirname(path), "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

// The teacher's state, with the record an earlier version kept (`checked.jsonl`: an id per checked page) read in as
// applied outcomes: a queued page `disputed`, any other `agreed`, so nothing checked then is sent again.
export function readTeacherState(dir: string): Map<string, PageOutcome> {
  const file = stateFile(dir);
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf-8")) as { pages: Record<string, PageOutcome> };
    return new Map(Object.entries(saved.pages));
  }
  const state = new Map<string, PageOutcome>();
  const legacy = join(dir, "raw", "teacher", "checked.jsonl");
  if (!existsSync(legacy)) return state;
  const queued = new Map(readQueue(dir).map((entry) => [entry.id, entry.spark]));
  for (const line of readFileSync(legacy, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const { id, answered } = JSON.parse(line) as { id: string; answered: boolean };
    const spark = queued.get(id);
    state.set(
      id,
      spark
        ? { status: "disputed", answer: spark, applied: true }
        : answered
          ? { status: "agreed", answer: null, applied: true } // its answer was not kept then; it was applied
          : { status: "failed", reason: "no valid answer (an earlier run)" },
    );
  }
  return state;
}

function saveTeacherState(dir: string, state: Map<string, PageOutcome>): void {
  writeDurably(stateFile(dir), `${JSON.stringify({ pages: Object.fromEntries(state) }, null, 1)}\n`);
}

// The queue's entries, a last line cut short by a stop dropped and the file rewritten whole (temp-then-rename).
export function readQueue(dir: string): { id: string; source: { lure: boolean }; spark: PageAnswer }[] {
  const file = queueFile(dir);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf-8").split("\n");
  const entries: { id: string; source: { lure: boolean }; spark: PageAnswer }[] = [];
  let repaired = false;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      if (!lines.slice(index + 1).every((rest) => !rest.trim()))
        throw new Error(`${file} line ${index + 1} does not parse: ${(error as Error).message}`);
      repaired = true;
    }
  }
  if (repaired) writeDurably(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  return entries;
}

function appendQueue(dir: string, entry: { id: string; source: { lure: boolean }; spark: PageAnswer }): void {
  if (readQueue(dir).some((queued) => queued.id === entry.id)) return; // a resumed apply writes it once
  const fd = openSync(queueFile(dir), "a");
  try {
    writeSync(fd, `${JSON.stringify(entry)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// A page's teacher state for §10: only `agreed` lets a page into evaluation.
export function teacherState(state: Map<string, PageOutcome>, id: string): TeacherStatus {
  return state.get(id)?.status ?? "unchecked";
}

// The pages worth a second opinion: those that can enter evaluation, South African first, not checked before.
export function candidates(pages: StoredPage[], checked: Set<string>): StoredPage[] {
  return pages
    .filter((p) => TRUSTED.has(p.label_source.lure ?? "") && p.labels.lure !== undefined && !checked.has(p.id))
    .sort((a, b) => Number(b.south_africa) - Number(a.south_africa) || a.id.localeCompare(b.id));
}

export type TeacherResult = {
  checked: number;
  agreed: number;
  queued: number;
  failed: number;
  filled: number;
  spentUsd: number;
  recovered: number;
  damaged: string[];
  stopped?: string;
};

// Writes an answered page's queue entry and the fields Spark fills, then marks it applied: run again after a stop, it
// writes each once. Only a field still missing is filled, marked as Spark's, which evaluation never trusts.
function apply(
  store: ReturnType<typeof openStore>,
  state: Map<string, PageOutcome>,
  page: StoredPage,
  result: TeacherResult,
): void {
  const outcome = state.get(page.id);
  if (!outcome || (outcome.status !== "agreed" && outcome.status !== "disputed") || outcome.applied) return;
  const { answer } = outcome;
  if (!answer) return;
  if (outcome.status === "disputed") {
    // Neither label is overwritten: the page waits in the queue, out of training and evaluation.
    appendQueue(store.dir, { id: page.id, source: { lure: page.labels.lure as boolean }, spark: answer });
  }
  const labels = { ...page.labels };
  const sources = { ...page.label_source };
  for (const field of ["brand", "has_login_form", "has_payment_form"] as const) {
    if (labels[field] === undefined) {
      (labels as Record<string, unknown>)[field] = answer[field];
      sources[field] = "spark";
      result.filled++;
    }
  }
  if (Object.keys(labels).length !== Object.keys(page.labels).length) store.setLabels(page.id, labels, sources);
  state.set(page.id, { ...outcome, applied: true });
  saveTeacherState(store.dir, state);
}

export async function teach(options: {
  store: ReturnType<typeof openStore>;
  ask: Ask;
  ledgerFile: string;
  run: string;
  max: number;
  now?: () => Date;
}): Promise<TeacherResult> {
  const { store, ask, ledgerFile, run } = options;
  const now = options.now ?? (() => new Date());
  const state = readTeacherState(store.dir);
  const result: TeacherResult = {
    checked: 0,
    agreed: 0,
    queued: 0,
    failed: 0,
    filled: 0,
    spentUsd: 0,
    recovered: 0,
    damaged: [],
  };
  const pages = store.manifest({ tolerant: true });
  const byId = new Map(pages.map((page) => [page.id, page]));
  // A stopped run's pages first: an answer already kept is applied without another call, and an attempt that was out
  // when the run stopped is failed, its spend left uncertain in the ledger, never sent twice.
  for (const [id, outcome] of [...state]) {
    const page = byId.get(id);
    if (outcome.status === "pending") {
      state.set(id, { status: "failed", reason: "the run stopped while its call was out; its spend is uncertain" });
      saveTeacherState(store.dir, state);
      result.recovered++;
    } else if (page && (outcome.status === "agreed" || outcome.status === "disputed") && !outcome.applied) {
      apply(store, state, page, result);
      result.recovered++;
    }
  }
  // A page the budget refused sent nothing: it is asked again; any other state is never sent twice.
  const done = new Set([...state].filter(([, outcome]) => outcome.status !== "refused").map(([id]) => id));
  for (const page of candidates(pages, done).slice(0, options.max)) {
    const read = store.readVerifiedPage(page.id);
    if (!read) {
      // A damaged page is never sent: it is listed, and the inventory excludes it (label-rules.ts).
      result.damaged.push(page.id);
      continue;
    }
    state.set(page.id, { status: "pending" });
    saveTeacherState(store.dir, state);
    const entries = new Map<string, Spend>();
    // An attempt is closed in the ledger as it stands now, never in the copy read when it was reserved, so nothing
    // written in between is lost.
    const close = (id: string, usd: number | null) => {
      const held = entries.get(id);
      if (!held) return;
      const ledger = readLedger(ledgerFile);
      const entry = ledger.find(
        (e) => e.date === held.date && e.run === held.run && e.call === held.call && e.state === "reserved",
      );
      if (entry) unsaved = settleSpend(ledgerFile, ledger, entry, usd) ?? unsaved;
    };
    let unsaved: string | null = null;
    let capReached = false;
    const attempts: AttemptLedger = {
      reserve(attempt, estimateUsd) {
        const ledger = readLedger(ledgerFile);
        if (glimmerSpend(ledger) + estimateUsd > GLIMMER_CAP_USD) {
          capReached = true;
          throw new BudgetExceeded("total", SPARK);
        }
        const call = attempt === 1 ? `${SPARK} ${page.id}` : `${SPARK} ${page.id} attempt ${attempt}`;
        const reserved = reserveSpend(ledgerFile, ledger, { date: sastDay(now()), run, call, estimate: estimateUsd });
        if ("refused" in reserved) {
          unsaved = reserved.refused;
          throw new BudgetUnavailable();
        }
        const id = ledgerId(reserved.entry.date, reserved.entry.run, reserved.entry.call);
        entries.set(id, reserved.entry);
        return id;
      },
      settle: (id, usd) => close(id, usd),
      uncertain: (id) => close(id, null),
    };
    let outcome: PageOutcome;
    let stop: string | undefined;
    try {
      const reply = await ask(responsesInput(page, read.screenshot, read.text), SCREENER_SYSTEM_PROMPT, attempts);
      result.spentUsd += reply.usd ?? ESTIMATE_USD;
      let parsed: ReturnType<typeof PageAnswer.safeParse> | null = null;
      try {
        parsed = PageAnswer.safeParse(JSON.parse(reply.text.replace(/^```(?:json)?\s*|\s*```$/g, "")));
      } catch {
        parsed = null;
      }
      outcome = parsed?.success
        ? { status: parsed.data.lure === page.labels.lure ? "agreed" : "disputed", answer: parsed.data, applied: false }
        : { status: "failed", reason: "Spark's answer was not a valid PageAnswer" };
    } catch (error) {
      if (error instanceof BudgetExceeded || error instanceof BudgetUnavailable) {
        stop = capReached
          ? `the next attempt would take Glimmer's Spark spend past US$${GLIMMER_CAP_USD}`
          : error instanceof BudgetExceeded
            ? `the Meta budget refused: ${error.message}`
            : unsaved
              ? `the ledger could not be written: ${unsaved}`
              : "the Meta budget could not be reached";
        // An attempt before it was refused may have been sent: the page is failed, its spend in the ledger as it stood.
        outcome = entries.size
          ? { status: "failed", reason: `a retry was refused: ${stop}` }
          : { status: "refused", reason: stop };
      } else outcome = { status: "failed", reason: `no answer (${(error as Error).name})` };
    }
    state.set(page.id, outcome);
    saveTeacherState(store.dir, state);
    if (outcome.status === "refused") {
      if (stop) result.stopped = stop; // nothing was sent: a later run asks again
      break;
    }
    result.checked++;
    if (outcome.status === "failed") result.failed++;
    else if (outcome.status === "disputed") result.queued++;
    else result.agreed++;
    apply(store, state, page, result);
    if (stop || unsaved) {
      result.stopped = stop ?? `the ledger could not be written: ${unsaved}`;
      break;
    }
  }
  return result;
}

if (import.meta.filename === process.argv[1]) {
  const at = process.argv.indexOf("--max");
  const max = at >= 0 ? Number(process.argv[at + 1]) : 500;
  const ledgerFile = metaLedger();
  const release = takeLock(ledgerLock(ledgerFile));
  if (typeof release === "string") {
    console.error(`teacher-label: ${release}`);
    process.exit(1);
  }
  try {
    const secrets = await readSecretsFromVault();
    const env = { META_API_KEY: secrets.meta, CF_AIG_TOKEN: secrets.run, META_GATEWAY_URL: GATEWAY_URL };
    const ask = sparkAsk({ env, budget: localBudget("glimmer-teacher-label") });
    const result = await teach({
      store: openStore(storeDir()),
      ask,
      ledgerFile,
      run: `glimmer-teacher-${Date.now()}`,
      max,
    });
    console.log(JSON.stringify(result));
  } finally {
    release();
  }
}
