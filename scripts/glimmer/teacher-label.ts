// Muse Spark as a second opinion on Loupe's evaluation pages (D03 T04 §9).
//
//   node scripts/glimmer/teacher-label.ts [--max <pages>] [--retry-failed]   # after label-rules.ts; writes the receipt
//   node scripts/glimmer/teacher-label.ts check             # every page complete or excluded, the receipt current
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

import { createHash } from "node:crypto";
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
import { applyRules, canonicalBrand, completeLabel, readExcluded } from "./label-rules.ts";
import { openStore, type StoredPage, storeDir } from "./store.ts";

export const SPARK = "muse-spark-1.3";
export const GLIMMER_CAP_USD = 20;
// Spark reasons before it answers, and its reasoning counts as output: at 600 tokens and its default effort it spent
// them all reasoning and returned no text (427 of 500 checks, 2026-10-29). At low effort an answer took 285 to 529
// tokens; 2,000 leave room for both.
export const TEACHER_MAX_OUTPUT_TOKENS = 2_000;
export const TEACHER_REASONING_EFFORT = "low";
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
  // The guard refused the attempt after the ledger recorded it: nothing was sent, and it costs nothing.
  release(id: string): void;
};

// One clock for both records of an attempt: the teacher reads it as it reserves an attempt's ledger entry, and the
// guard's budget reads that same instant, so an attempt near SAST midnight never counts on two days.
export function sharedClock(now: () => Date = () => new Date()): { teacher: () => Date; guard: () => Date } {
  let at = now();
  return { teacher: () => (at = now()), guard: () => at };
}

// `incomplete`: why the reply was cut off before its answer ended (Meta's `incomplete_details.reason`), when it was.
export type Ask = (
  input: unknown[],
  instructions: string,
  attempts: AttemptLedger,
) => Promise<{ text: string; usd: number | null; incomplete?: string }>;

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
          attempts.release(local); // the guard refused it or could not record it: nothing was sent
          throw error;
        }
        ids.set(guarded, local);
        return guarded;
      },
      settle: async (id, actualUsd, record) => {
        await context.budget.settle(id, actualUsd, record);
        const local = ids.get(id);
        if (!local) return;
        // Measured from Meta's usage, or nothing because the request never ran: settled at that. Settled at the
        // estimate (an answer without usage): left at its estimate locally too, so the receipt never calls it measured.
        if (record?.certainty === "measured" || record?.certainty === "none") attempts.settle(local, actualUsd);
        else attempts.uncertain(local);
      },
      uncertain: async (id, record) => {
        await context.budget.uncertain(id, record);
        const local = ids.get(id);
        if (local) attempts.uncertain(local);
      },
    };
    const { data } = await metaResponses(
      {
        model: SPARK,
        input: input as never,
        instructions,
        max_output_tokens: TEACHER_MAX_OUTPUT_TOKENS,
        reasoning: { effort: TEACHER_REASONING_EFFORT },
      },
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
    const reply = data as { output_text?: string; status?: string; incomplete_details?: { reason?: string } | null };
    return {
      text: reply.output_text ?? "",
      usd,
      ...(reply.status === "incomplete" ? { incomplete: reply.incomplete_details?.reason ?? "incomplete" } : {}),
    };
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
// What the teacher checked: the page's lure label and its files' hashes then. A later change to either makes the check
// `stale`, so an agreement never outlives the label it agreed with.
export type Checked = { lure: boolean; screenshot: string; text: string };
export type PageOutcome =
  | { status: "pending"; checked?: Checked }
  | { status: "agreed" | "disputed"; answer: PageAnswer | null; applied: boolean; checked?: Checked }
  | { status: "failed" | "refused" | "quarantined"; reason: string };
// `quarantined`: an answer that may have been paid for was lost (a stop while it was out, or an earlier version's
// record that cannot say whether it disagreed); the rules exclude the page from training and evaluation.
export type TeacherStatus = PageOutcome["status"] | "unchecked" | "stale";

const stateFile = (dir: string) => join(dir, "raw", "teacher", "state.json");
const queueFile = (dir: string) => join(dir, "review-queue.jsonl");

// Every byte of `data` written, however few each write takes (a nearly full disk writes less than asked), or the error
// that stopped it: a file is never published or appended to half written.
export function writeAll(
  fd: number,
  data: string,
  write: (fd: number, buffer: Uint8Array, offset: number, length: number) => number = writeSync,
): void {
  const bytes = Buffer.from(data, "utf-8");
  for (let at = 0; at < bytes.length; ) {
    const written = write(fd, bytes, at, bytes.length - at);
    if (written <= 0) throw new Error(`a write took no bytes at ${at} of ${bytes.length}`);
    at += written;
  }
}

function writeDurably(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w");
  try {
    writeAll(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  syncFolder(dirname(path));
}

// A folder's entries made durable: a file just created or renamed into it survives a power loss.
function syncFolder(folder: string): void {
  const fd = openSync(folder, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
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
          ? // Answered, with no queue entry: an agreement, or a disagreement whose queue line was lost; not known.
            { status: "quarantined", reason: "an earlier version's check, whose agreement cannot be shown" }
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
  const file = queueFile(dir);
  // A stop can leave a whole last entry without its newline: the separator goes back before anything is added.
  const text = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const fd = openSync(file, "a");
  try {
    writeAll(fd, `${text && !text.endsWith("\n") ? "\n" : ""}${JSON.stringify(entry)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // The first entry creates the file: its name in the store's folder is made durable before the page is marked applied.
  syncFolder(dirname(file));
}

// A page's teacher state for §10: only `agreed` lets a page into evaluation, and only while its lure label and files
// are the ones Spark checked.
export function teacherState(state: Map<string, PageOutcome>, page: Pick<StoredPage, "id" | "labels" | "sha256">) {
  const outcome = state.get(page.id);
  if (!outcome) return "unchecked" as TeacherStatus;
  if ((outcome.status === "agreed" || outcome.status === "disputed") && outcome.checked) {
    const { lure, screenshot, text } = outcome.checked;
    if (lure !== page.labels.lure || screenshot !== page.sha256.screenshot || text !== page.sha256.text)
      return "stale" as TeacherStatus;
  }
  return outcome.status as TeacherStatus;
}

// The order the teacher checks candidates in: South African pages first, then a seeded shuffle, so a run the cap ends
// early still covers every source in proportion instead of the ones whose ids sort first.
function seededOrder(id: string, seed: string): string {
  return createHash("sha256").update(`${seed}\n${id}`).digest("hex");
}

// The pages worth a second opinion: those that can enter evaluation, South African first, not checked before, in a
// seeded order within each region.
export function candidates(pages: StoredPage[], checked: Set<string>, seed = "glimmer-teacher"): StoredPage[] {
  return pages
    .filter((p) => TRUSTED.has(p.label_source.lure ?? "") && p.labels.lure !== undefined && !checked.has(p.id))
    .map((page) => ({ page, order: seededOrder(page.id, seed) }))
    .sort((a, b) => Number(b.page.south_africa) - Number(a.page.south_africa) || a.order.localeCompare(b.order))
    .map(({ page }) => page);
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
  // Ask again the pages whose check produced no valid answer (a reply cut off, or one that was not a PageAnswer):
  // nothing was learned from them, so nothing is lost. A quarantined page, whose answer may have been lost, never is.
  retryFailed?: boolean;
}): Promise<TeacherResult> {
  const { store, ask, ledgerFile, run } = options;
  const now = options.now ?? (() => new Date());
  const state = readTeacherState(store.dir);
  // An earlier version's record read in is kept in the new form at once, so the rules see its quarantines.
  if (state.size && !existsSync(stateFile(store.dir))) saveTeacherState(store.dir, state);
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
      // Its answer may have come back and been lost before it was kept: what it said cannot be known, so the page is
      // kept out of training and evaluation, never sent again (its spend stays uncertain in the ledger).
      state.set(id, { status: "quarantined", reason: "the run stopped while its call was out; its answer was lost" });
      saveTeacherState(store.dir, state);
      result.recovered++;
    } else if (page && (outcome.status === "agreed" || outcome.status === "disputed") && !outcome.applied) {
      apply(store, state, page, result);
      result.recovered++;
    }
  }
  // A disagreement marked applied whose queue entry did not survive (a power loss before the queue's name reached the
  // disk) is queued again: the queue, not the state, is what keeps it out of training.
  const queued = new Set(readQueue(store.dir).map((entry) => entry.id));
  for (const [id, outcome] of state) {
    const page = byId.get(id);
    if (outcome.status !== "disputed" || !outcome.applied || !outcome.answer || !page || queued.has(id)) continue;
    appendQueue(store.dir, { id, source: { lure: page.labels.lure as boolean }, spark: outcome.answer });
    result.recovered++;
  }
  // A page the budget refused sent nothing: it is asked again; any other state is never sent twice.
  const done = new Set(
    [...state]
      .filter(([, outcome]) => outcome.status !== "refused" && !(options.retryFailed && outcome.status === "failed"))
      .map(([id]) => id),
  );
  for (const page of candidates(pages, done).slice(0, options.max)) {
    const read = store.readVerifiedPage(page.id);
    if (!read) {
      // A damaged page is never sent: it is listed, and the inventory excludes it (label-rules.ts).
      result.damaged.push(page.id);
      continue;
    }
    const checked: Checked = {
      lure: page.labels.lure as boolean,
      screenshot: read.page.sha256.screenshot,
      text: read.page.sha256.text,
    };
    state.set(page.id, { status: "pending", checked });
    saveTeacherState(store.dir, state);
    const entries = new Map<string, Spend>();
    const released = new Set<string>(); // attempts the guard refused after the ledger recorded them: never sent
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
      release: (id) => {
        released.add(id);
        close(id, 0);
      },
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
      outcome = reply.incomplete
        ? { status: "failed", reason: `Spark's answer was cut off (${reply.incomplete})` }
        : parsed?.success
          ? {
              status: parsed.data.lure === page.labels.lure ? "agreed" : "disputed",
              answer: parsed.data,
              applied: false,
              checked,
            }
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
        // An attempt before the refused one was sent, and may have reached Meta with its answer lost: like any lost
        // answer, the page is quarantined (its spend in the ledger as it stood). Nothing sent: refused, asked again.
        const sent = [...entries.keys()].some((id) => !released.has(id));
        outcome = sent
          ? { status: "quarantined", reason: `a retry was refused after an attempt was sent: ${stop}` }
          : { status: "refused", reason: stop };
      }
      // The request may have reached Meta and its answer been lost on the way back (a cut connection, a settlement
      // that timed out after the answer arrived): what Spark said cannot be known, so the page is quarantined.
      else
        outcome = {
          status: "quarantined",
          reason: `no answer reached the teacher (${(error as Error).name}); it may have disagreed`,
        };
    }
    state.set(page.id, outcome);
    saveTeacherState(store.dir, state);
    if (outcome.status === "refused") {
      if (stop) result.stopped = stop; // nothing was sent: a later run asks again
      break;
    }
    result.checked++;
    if (outcome.status === "failed" || outcome.status === "quarantined") result.failed++;
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

// What a receipt was written for: every page's id, file hashes, host, labels and their sources, the exclusions and the
// teacher's outcomes, so a label corrected, a page excluded or a check changed after the receipt makes it stale.
export function snapshotOf(dir: string, pages: StoredPage[]): { pages: number; digest: string } {
  const lines = pages
    .map((p) =>
      JSON.stringify([p.id, p.sha256.screenshot, p.sha256.text, p.host, sorted(p.labels), sorted(p.label_source)]),
    )
    .sort();
  const hash = createHash("sha256").update(lines.join("\n"));
  hash.update(`\n${JSON.stringify([...readExcluded(dir)].sort())}`);
  hash.update(`\n${JSON.stringify([...readTeacherState(dir)].sort(([a], [b]) => a.localeCompare(b)))}`);
  return { pages: pages.length, digest: hash.digest("hex") };
}
const sorted = (record: object) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

const FIELDS = ["lure", "lure_type", "brand", "has_login_form", "has_payment_form"] as const;

export type Receipt = {
  at: string;
  snapshot: { pages: number; digest: string };
  complete: number;
  bySource: Record<string, Record<string, number>>; // label field -> label source -> pages
  excluded: Record<string, number>; // reason -> pages
  teacher: Record<string, number>; // state -> pages
  unchecked: number; // evaluation candidates the teacher has not checked
  unresolvedBrands: { pages: number; ofLures: number }; // lures whose text named no brand the rules know
  // Spark's answers against the stored labels, every field, by the stored label's source: what the checks paid for.
  fields: Record<string, Record<string, { agree: number; disagree: number }>>;
  // The pages Spark agreed with, which alone may enter evaluation: by source, region, verdict and lure type.
  agreed: {
    bySource: Record<string, number>;
    southAfrica: number;
    lures: number;
    benign: number;
    byType: Record<string, number>;
  };
  spend: { measuredUsd: number; uncertainUsd: number }; // the teacher's runs, over every attempt in the ledger
};

const receiptFile = (dir: string) => join(dir, "raw", "teacher", "receipt.json");
const bump = (record: Record<string, number>, key: string) => {
  record[key] = (record[key] ?? 0) + 1;
};

// The run's receipt, written temp-then-replace and read back: the store it covers and how every page ended.
export function writeReceipt(store: ReturnType<typeof openStore>, ledger: Spend[], at: Date = new Date()): Receipt {
  const pages = store.manifest({ tolerant: true });
  const state = readTeacherState(store.dir);
  const excluded = readExcluded(store.dir);
  const bySource: Receipt["bySource"] = {};
  const excludedBy: Record<string, number> = {};
  const teacher: Record<string, number> = {};
  const fields: Receipt["fields"] = {};
  const agreed: Receipt["agreed"] = { bySource: {}, southAfrica: 0, lures: 0, benign: 0, byType: {} };
  for (const reason of excluded.values()) bump(excludedBy, reason.replace(/ \(.*$/, ""));
  let complete = 0;
  let unresolved = 0;
  let lures = 0;
  for (const page of pages) {
    if (completeLabel(page.labels) && !excluded.has(page.id)) complete++;
    for (const [field, source] of Object.entries(page.label_source)) {
      bySource[field] ??= {};
      bump(bySource[field] as Record<string, number>, source as string);
    }
    if (page.labels.lure === true) {
      lures++;
      if (page.labels.brand === null && page.label_source.brand === "rule") unresolved++;
    }
    const status = teacherState(state, page);
    bump(teacher, status === "unchecked" ? "unchecked" : status);
    const outcome = state.get(page.id);
    if (outcome && (outcome.status === "agreed" || outcome.status === "disputed") && outcome.answer) {
      for (const field of FIELDS) {
        const stored = page.labels[field];
        if (stored === undefined) continue;
        const given = outcome.answer[field];
        const same =
          field === "brand"
            ? (stored === null ? null : canonicalBrand(stored as string)) ===
              (given === null ? null : canonicalBrand(given as string))
            : stored === given;
        fields[field] ??= {};
        const byField = fields[field] as Record<string, { agree: number; disagree: number }>;
        const source = page.label_source[field] ?? "none";
        byField[source] ??= { agree: 0, disagree: 0 };
        (byField[source] as { agree: number; disagree: number })[same ? "agree" : "disagree"]++;
      }
    }
    if (status === "agreed") {
      bump(agreed.bySource, page.source);
      if (page.south_africa) agreed.southAfrica++;
      if (page.labels.lure) {
        agreed.lures++;
        if (page.labels.lure_type) bump(agreed.byType, page.labels.lure_type);
      } else agreed.benign++;
    }
  }
  delete teacher.unchecked;
  const done = new Set([...state].filter(([, o]) => o.status !== "refused").map(([id]) => id));
  const teacherRuns = ledger.filter((e) => e.run.startsWith("glimmer-teacher-"));
  const receipt: Receipt = {
    at: at.toISOString(),
    snapshot: snapshotOf(store.dir, pages),
    complete,
    bySource,
    excluded: excludedBy,
    teacher,
    unchecked: candidates(pages, done).length,
    unresolvedBrands: { pages: unresolved, ofLures: lures },
    fields,
    agreed,
    spend: {
      measuredUsd: teacherRuns.filter((e) => e.state === "settled").reduce((s, e) => s + (e.cost ?? 0), 0),
      uncertainUsd: teacherRuns.filter((e) => e.state !== "settled").reduce((s, e) => s + e.estimate, 0),
    },
  };
  writeDurably(receiptFile(store.dir), `${JSON.stringify(receipt, null, 2)}\n`);
  const back = JSON.parse(readFileSync(receiptFile(store.dir), "utf-8")) as Receipt;
  if (back.snapshot.digest !== receipt.snapshot.digest) throw new Error("the receipt did not read back as written");
  return receipt;
}

// Why the labels are not ready for §10: a page with neither a complete label nor an exclusion, a damaged page not
// excluded (its record readable or not), a missing receipt, or a receipt for another store, labels, exclusions or
// teacher outcomes than those there now. Empty when they are.
export function checkLabels(store: ReturnType<typeof openStore>): string[] {
  const problems: string[] = [];
  const pages = store.manifest({ tolerant: true });
  const excluded = readExcluded(store.dir);
  const loose = pages.filter((p) => !excluded.has(p.id) && !completeLabel(p.labels));
  if (loose.length)
    problems.push(`${loose.length} pages have neither a complete label nor an exclusion (first: ${loose[0]?.id})`);
  const damaged = store.verify().damaged.filter((id) => !excluded.has(id));
  if (damaged.length) problems.push(`${damaged.length} damaged pages are not excluded (first: ${damaged[0]})`);
  const state = readTeacherState(store.dir);
  const queued = new Set(readQueue(store.dir).map((entry) => entry.id));
  const unqueued = [...state].filter(([id, o]) => o.status === "disputed" && o.applied && !queued.has(id));
  if (unqueued.length)
    problems.push(
      `${unqueued.length} disagreements are not in the review queue: run the teacher again (first: ${unqueued[0]?.[0]})`,
    );
  const held = [...state].filter(([id, o]) => o.status === "quarantined" && !excluded.has(id));
  if (held.length)
    problems.push(
      `${held.length} quarantined pages are not excluded: run label-rules.ts again (first: ${held[0]?.[0]})`,
    );
  const file = receiptFile(store.dir);
  if (!existsSync(file)) problems.push("no receipt: run the teacher");
  else {
    const receipt = JSON.parse(readFileSync(file, "utf-8")) as Receipt;
    const now = snapshotOf(store.dir, pages);
    if (receipt.snapshot.digest !== now.digest)
      problems.push(
        `the receipt covers ${receipt.snapshot.pages} pages and other labels or outcomes than the ${now.pages} stored now: run again`,
      );
  }
  return problems;
}

if (import.meta.filename === process.argv[1] && process.argv[2] === "check") {
  const problems = checkLabels(openStore(storeDir()));
  console.log(problems.length ? `teacher-label check: failed (${problems.join("; ")})` : "teacher-label check: clean");
  process.exit(problems.length ? 1 : 0);
}

if (import.meta.filename === process.argv[1] && process.argv[2] !== "check") {
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
    const clock = sharedClock();
    const ask = sparkAsk({ env, budget: localBudget("glimmer-teacher-label", undefined, clock.guard) });
    const store = openStore(storeDir());
    const result = await teach({
      store,
      ask,
      ledgerFile,
      run: `glimmer-teacher-${Date.now()}`,
      max,
      now: clock.teacher,
      retryFailed: process.argv.includes("--retry-failed"),
    });
    console.log(JSON.stringify(result));
    // The rules again, so every page this run quarantined is excluded before the receipt is written.
    applyRules(store);
    console.log(JSON.stringify(writeReceipt(store, readLedger(ledgerFile))));
  } finally {
    release();
  }
}
