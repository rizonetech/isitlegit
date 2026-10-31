// The edited-digits experiment (D08 T03 §1): can Muse Spark tell from the image alone that an invoice's account number
// was pasted in, and how often does it cry wolf on the unedited twin?
//
//   node eval/frontier/digits.ts build [--out <dir>]    # 20 images and manifest.json; refuses a folder that exists
//   node eval/frontier/digits.ts run [--results <file>] [--retry-pending]
//                                                       # each image without an outcome through Spark
//   node eval/frontier/digits.ts score [--results <file>] [--check <log>]
//                                                       # the numbers, the baseline's and the decision; with --check,
//                                                       # exit 1 unless the log's entry carries all of them
//
// The published run is eval/frontier/sets/digits/results.json. A fresh measurement of the same images goes to another
// file (`run --results results-2.json`), which leaves the published one as it is; a rebuilt set goes to another folder
// (`build --out <dir>`), assembled beside it and renamed into place whole.
//
// Spend (coordinator, 2026-10-31): every attempt, a structured repair and a client retry included, is reserved in the
// shared ledger (`metaLedger()`, under its lock) and then in main's budget guard (`localBudget("eval-frontier")`, live
// D1 `model_spend` rows, the only production write) under the ledger entry's id, before it is sent, and settled at
// Meta's reported cost. A refused reservation, a ledger that cannot be written or locked, or this run's entries
// reaching RUN_CAP_USD stops the run with nothing more sent. An image is recorded `pending` before it is sent; one an
// interrupted run left `pending` may have been paid for, so it is resent only when asked (`--retry-pending`).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { z } from "zod";
import { ledgerId, localBudget } from "../../scripts/lib/meta-budget.ts";
import {
  GATEWAY_URL,
  metaLedger,
  readLedger,
  readSecretsFromVault,
  type Spend,
  saveLedger,
  takeLock,
} from "../../scripts/meta-smoke.ts";
import type { MetaContext } from "../../src/meta/client.ts";
import { sastDay } from "../../src/meta/day.ts";
import type { Budget } from "../../src/meta/guard.ts";
import { MODELS } from "../../src/meta/models.ts";
import {
  ModelOutputError,
  type StructuredContext,
  type StructuredRequest,
  structured,
} from "../../src/meta/structured.ts";
import {
  ACCOUNT_BOX,
  BANK_BOX,
  type Box,
  BRANCH_BOX,
  EDIT_KINDS,
  type EditKind,
  editInvoice,
  editKindFor,
  FONT_PINS,
  invoiceSpecs,
  renderInvoice,
} from "./make-invoices.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SET_DIR = join(ROOT, "eval/frontier/sets/digits");
export const SPARK = "muse-spark-1.3";
export const EFFORT = "high" as const;
// At high effort Spark reasons at length before it answers, and its reasoning counts as output; 8,000 leave room for a
// long chain and the answer (scripts/glimmer/teacher-label.ts found 600 too few at default effort).
export const MAX_OUTPUT_TOKENS = 8_000;
export const RUN_CAP_USD = 1.5;
export const OWNER = "eval-frontier";
// What Spark's tokens cost (US$ per million), as the client prices them (src/meta/models.ts): stored with the results
// so every attempt's cost can be recomputed from its tokens.
export const PRICES = {
  input: MODELS[SPARK].input,
  cached: MODELS[SPARK].cached,
  output: MODELS[SPARK].output,
};
// The baseline flags the account number when its error level stands this many spreads above the page's other text.
export const BASELINE_Z = 3;
// A spread below this share of the page's mean level is its text all re-saving alike; it keeps one quiet page from
// flagging on a hair. Relative, because a page's error levels run near 0.1 grey levels, not whole ones (corrected
// 2026-10-31: a fixed floor of 0.5 stood ten times above every page's spread and could never flag).
export const BASELINE_MIN_SPREAD = 0.1;
export const LIMITATION =
  "Limit: 10 twins cannot show the 2% false-positive target (design spec 4.9), and these are pristine generated invoices, not scans or photos.";

export const FIELDS = ["account_number", "amount", "invoice_number", "date", "bank_name", "other"] as const;
export const DigitsAnswer = z.strictObject({
  edited: z.boolean(),
  confidence: z.number().min(0).max(1),
  regions: z.array(z.strictObject({ field: z.enum(FIELDS), reason: z.string().min(1).max(400) })).max(6),
});
export type DigitsAnswer = z.infer<typeof DigitsAnswer>;

// The instruction never says an edit is present, where, or how: Spark must find it or not.
export const INSTRUCTION = [
  "You are a document forensics examiner. The image is a supplier invoice a small business received by email.",
  "Decide whether any text on it was digitally altered after the document was produced, judging only from the image:",
  "look for characters whose typeface, size, weight, spacing, alignment, baseline, sharpness or compression differ",
  "from the text around them, and for patches whose background differs from the page.",
  "Most invoices are not altered; call it unaltered unless the image itself shows evidence.",
  "Give your confidence that it was altered (0 to 1) and, for each region you suspect, the field and what you saw.",
].join(" ");

const Hex = z.string().regex(/^[0-9a-f]{64}$/);
const BoxShape = z.strictObject({ left: z.number(), top: z.number(), width: z.number(), height: z.number() });
export const ManifestEntry = z.strictObject({
  file: z.string().regex(/^inv-\d\d-(twin|edited)\.jpg$/),
  spec: z.string(),
  edited: z.boolean(),
  kind: z.enum(EDIT_KINDS).nullable(),
  box: BoxShape.nullable(),
  account: z.string(),
  covered: z.string().nullable(),
  sha256: Hex,
});
export type ManifestEntry = z.infer<typeof ManifestEntry>;
const FontFile = z.strictObject({ file: z.string(), sha256: Hex });
export const Manifest = z.strictObject({ fonts: z.record(z.string(), FontFile), images: z.array(ManifestEntry) });
export type Manifest = z.infer<typeof Manifest>;

// One attempt as the shared ledger and Meta's usage record it; tokens are null where an attempt's answer never came.
export const Attempt = z.strictObject({
  call: z.string(),
  ledgerId: z.string(),
  state: z.enum(["reserved", "settled", "uncertain"]),
  estimateUsd: z.number(),
  usd: z.number().nullable(),
  inputTokens: z.number().int().nullable(),
  cachedTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  logId: z.string().nullable(),
});
export type Attempt = z.infer<typeof Attempt>;
export const Outcome = z.strictObject({
  file: z.string(),
  status: z.enum(["pending", "answered", "failed"]),
  answer: DigitsAnswer.nullable(),
  failure: z.string().nullable(),
  ms: z.number().nullable(),
  usd: z.number(),
  uncertainUsd: z.number(),
  attempts: z.number().int(),
  calls: z.array(Attempt),
  at: z.string(),
});
export type Outcome = z.infer<typeof Outcome>;
const Prices = z.strictObject({ input: z.number(), cached: z.number(), output: z.number() });
export const ResultsFile = z.strictObject({ fingerprint: Hex, prices: Prices, results: z.array(Outcome) });
export type ResultsFile = z.infer<typeof ResultsFile>;

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

// Every write lands whole: a temporary file beside the target, then a rename over it.
export function writeAtomic(file: string, data: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export type FontFile = z.infer<typeof FontFile>;
export type FontResolver = (family: string) => FontFile | null;

// The font file fontconfig gives a family on this machine and its hash, or null when it gives none.
export const fontconfig: FontResolver = (family) => {
  try {
    const file = execFileSync("fc-match", ["-f", "%{file}", family], { encoding: "utf-8", timeout: 10_000 }).trim();
    return file && existsSync(file) ? { file, sha256: sha256(readFileSync(file)) } : null;
  } catch {
    return null;
  }
};

// Each pinned typeface resolved to the exact file the published set was drawn with, or the problems: a machine whose
// fontconfig substitutes another file would draw another experiment.
export function verifyFonts(
  resolve: FontResolver = fontconfig,
): { fonts: Record<string, FontFile> } | { problems: string[] } {
  const fonts: Record<string, FontFile> = {};
  const problems: string[] = [];
  for (const [family, pin] of Object.entries(FONT_PINS)) {
    const found = resolve(family);
    if (!found) problems.push(`${family} is not installed (install fonts-dejavu-core and fonts-urw-base35)`);
    else if (found.sha256 !== pin)
      problems.push(`${family} resolves to ${found.file}, not the pinned file (sha256 ${pin})`);
    else fonts[family] = found;
  }
  return problems.length ? { problems } : { fonts };
}

// The set built into a folder beside `dir` and renamed into place whole, so an interrupted build leaves nothing half
// written; a folder that exists is refused, never overwritten.
export async function buildSet(dir = SET_DIR, resolve: FontResolver = fontconfig): Promise<Manifest> {
  if (existsSync(dir)) throw new Error(`${dir} exists; build into another folder (--out)`);
  const checked = verifyFonts(resolve);
  if ("problems" in checked) throw new Error(checked.problems.join("; "));
  const staging = `${dir}.building-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  const images: ManifestEntry[] = [];
  for (const [i, spec] of invoiceSpecs().entries()) {
    const kind = editKindFor(i);
    for (const edited of [false, true]) {
      const image = edited ? await editInvoice(spec, kind) : await renderInvoice(spec);
      const file = `${spec.id}-${edited ? "edited" : "twin"}.jpg`;
      writeAtomic(join(staging, file), image);
      images.push({
        file,
        spec: spec.id,
        edited,
        kind: edited ? kind : null,
        box: edited ? ACCOUNT_BOX : null,
        account: spec.account,
        covered: edited ? spec.originalAccount : null,
        sha256: sha256(image),
      });
    }
  }
  const manifest: Manifest = { fonts: checked.fonts, images };
  writeAtomic(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
  renameSync(staging, dir);
  return manifest;
}

export function readManifest(dir = SET_DIR): Manifest {
  return Manifest.parse(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8")));
}

// The images on disk against their manifest: each problem named.
export function manifestProblems(manifest: Manifest, dir = SET_DIR): string[] {
  return manifest.images.flatMap((entry) => {
    const path = join(dir, entry.file);
    if (!existsSync(path)) return [`${entry.file} is missing`];
    return sha256(readFileSync(path)) === entry.sha256 ? [] : [`${entry.file} does not match its manifest hash`];
  });
}

// What the results measured: the instruction, the schema, the model's settings and every image, so answers from
// another request or another image set are never scored as this one's.
export function fingerprint(manifest: Manifest): string {
  return sha256(
    JSON.stringify({
      instruction: INSTRUCTION,
      schema: z.toJSONSchema(DigitsAnswer),
      model: SPARK,
      effort: EFFORT,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      images: manifest.images.map((e) => [e.file, e.sha256]),
    }),
  );
}

export const RESULTS = "results.json";
const resultsPath = (dir: string, results = RESULTS) => join(dir, results);

// The stored results, or null when none exist; an unreadable or malformed file throws, naming the problem.
export function readResults(dir = SET_DIR, results = RESULTS): ResultsFile | null {
  const path = resultsPath(dir, results);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new Error(`${results} is not JSON`);
  }
  const parsed = ResultsFile.safeParse(raw);
  if (!parsed.success) throw new Error(`${results} is malformed (${parsed.error.issues[0]?.path.join(".")})`);
  return parsed.data;
}

// Stored results against the manifest: another fingerprint, a duplicate or unknown file, an outcome whose answer does
// not match its status, and (when `complete`) a manifest image with no outcome. Each problem named.
export function resultProblems(stored: ResultsFile, manifest: Manifest, complete: boolean): string[] {
  const problems: string[] = [];
  if (stored.fingerprint !== fingerprint(manifest))
    problems.push("results.json was measured with another request or image set (fingerprint differs)");
  const files = new Set(manifest.images.map((e) => e.file));
  const seen = new Set<string>();
  for (const outcome of stored.results) {
    if (seen.has(outcome.file)) problems.push(`${outcome.file} has more than one outcome`);
    seen.add(outcome.file);
    if (!files.has(outcome.file)) problems.push(`${outcome.file} is not in the manifest`);
    if ((outcome.status === "answered") !== (outcome.answer !== null))
      problems.push(`${outcome.file} is ${outcome.status} ${outcome.answer ? "with" : "without"} an answer`);
  }
  if (complete) for (const file of files) if (!seen.has(file)) problems.push(`${file} has no outcome`);
  return problems;
}

// The structured request for one image: the neutral instruction, the image, Spark at high effort.
export function digitsRequest(image: Uint8Array): StructuredRequest {
  return {
    name: "invoice_edit_check",
    model: SPARK,
    instructions: INSTRUCTION,
    input: [
      {
        role: "user" as const,
        content: [
          { type: "input_text" as const, text: "The invoice:" },
          {
            type: "input_image" as const,
            image_url: `data:image/jpeg;base64,${Buffer.from(image).toString("base64")}`,
            detail: "high" as const,
          },
        ],
      },
    ],
    max_output_tokens: MAX_OUTPUT_TOKENS,
    reasoning: { effort: EFFORT },
  };
}

// Why the shared ledger took nothing: the run stops, nothing is sent.
export class LedgerRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerRefused";
  }
}

// The local ledger every attempt is reserved in before the guard: `reserve` answers the entry's id or throws
// LedgerRefused, and the others close the entry.
export type AttemptLedger = {
  reserve(image: string, estimateUsd: number): Promise<string>;
  settle(id: string, usd: number): Promise<void>;
  uncertain(id: string): Promise<void>;
  release(id: string): Promise<void>;
  // Every entry of this run for one image, under the lock: what each attempt cost, across interrupted runs too.
  entries(image: string): Promise<(Spend & { id: string })[]>;
};

// The shared ledger's lock: the same file `scripts/glimmer/teacher-label.ts` locks (`ledgerLock`), beside the ledger.
export const ledgerLock = (ledgerFile: string) => `${ledgerFile}.lock`;

// The shared ledger, each change made under its lock on a fresh read, so another lane's entries written meanwhile are
// kept. A lock still held after `waitMs` refuses, as does an unwritable ledger or this run passing `capUsd`.
export function sharedLedger(
  file: string,
  run: string,
  options: { now?: () => Date; capUsd?: number; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): AttemptLedger {
  const now = options.now ?? (() => new Date());
  const cap = options.capUsd ?? RUN_CAP_USD;
  const waitMs = options.waitMs ?? 30_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const idOf = (e: Spend) => ledgerId(e.date, e.run, e.call);
  async function locked<T>(change: (ledger: Spend[]) => T): Promise<T> {
    let release = takeLock(ledgerLock(file));
    for (let waited = 0; typeof release === "string" && waited < waitMs; waited += 500) {
      await sleep(500);
      release = takeLock(ledgerLock(file));
    }
    if (typeof release === "string") throw new LedgerRefused(`the shared ledger is locked: ${release}`);
    try {
      let ledger: Spend[];
      try {
        ledger = readLedger(file);
      } catch (error) {
        throw new LedgerRefused(`the shared ledger cannot be read (${(error as Error).message})`);
      }
      const value = change(ledger);
      const unsaved = saveLedger(file, ledger);
      if (unsaved) throw new LedgerRefused(unsaved);
      return value;
    } finally {
      release();
    }
  }
  const counted = (e: Spend) => (typeof e.cost === "number" ? e.cost : e.estimate);
  return {
    reserve: (image, estimateUsd) =>
      locked((ledger) => {
        const mine = ledger.filter((e) => e.run === run);
        const spent = mine.reduce((sum, e) => sum + counted(e), 0);
        if (spent + estimateUsd > cap)
          throw new LedgerRefused(`the run would pass its cap (US$${spent.toFixed(4)} + ${estimateUsd.toFixed(4)})`);
        const n = mine.filter((e) => e.call.startsWith(`${image}#`)).length + 1;
        const entry: Spend = {
          date: sastDay(now()),
          run,
          call: `${image}#${n}`,
          estimate: estimateUsd,
          cost: null,
          state: "reserved",
        };
        ledger.push(entry);
        return idOf(entry);
      }),
    settle: (id, usd) =>
      locked((ledger) => {
        const entry = ledger.find((e) => idOf(e) === id);
        if (entry) Object.assign(entry, { cost: usd, state: "settled" });
      }),
    uncertain: (id) =>
      locked((ledger) => {
        const entry = ledger.find((e) => idOf(e) === id);
        if (entry) Object.assign(entry, { cost: null, state: "uncertain" });
      }),
    // Kept, settled at nothing, never removed: its id stays taken, so a later attempt of the image never reuses the id
    // the guard's refusal row already holds in D1 (round 1).
    release: (id) =>
      locked((ledger) => {
        const entry = ledger.find((e) => idOf(e) === id);
        if (entry) Object.assign(entry, { cost: 0, state: "settled" });
      }),
    entries: (image) =>
      locked((ledger) =>
        ledger.filter((e) => e.run === run && e.call.startsWith(`${image}#`)).map((e) => ({ ...e, id: idOf(e) })),
      ),
  };
}

// The guard's budget with every attempt reserved first in the shared ledger under the same id, released there when the
// guard refuses, and closed in both. It keeps each attempt's usage (tokens and log id) by its ledger id, the ledger's
// own refusal (which the guard reports only as unavailable), and an accounting failure: a settlement the ledger could
// not write, which the client swallows once the answer has arrived (src/meta/guard.ts), so the run stops on it.
export function ledgeredBudget(guard: Budget, ledger: AttemptLedger, image: string) {
  const ids = new Map<string, string>();
  const usage = new Map<string, Pick<Attempt, "inputTokens" | "cachedTokens" | "outputTokens" | "logId">>();
  let attempts = 0;
  let refusal: string | null = null;
  let accounting: string | null = null;
  const keep = async (step: () => Promise<void>) => {
    try {
      await step();
    } catch (error) {
      accounting ??= (error as Error).message;
    }
  };
  // The guard's own settlement (the live D1 row) failing is an accounting failure too: recorded so nothing more is
  // sent, then thrown on, as the client expects of its budget (round 2).
  const guarded = async (step: () => Promise<void>) => {
    try {
      await step();
    } catch (error) {
      accounting ??= `the budget guard: ${(error as Error).message}`;
      throw error;
    }
  };
  const budget: Budget = {
    ...guard,
    reserve: async (model, estimateUsd, attempt, _id, call) => {
      // Once a settlement could not be written, nothing more is sent: not even the structured helper's repair (round 1).
      if (accounting) {
        refusal = `accounting: a settlement could not be written (${accounting})`;
        throw new LedgerRefused(refusal);
      }
      let local: string;
      try {
        local = await ledger.reserve(image, estimateUsd);
      } catch (error) {
        refusal = (error as Error).message;
        throw error;
      }
      let guarded: string;
      try {
        guarded = await guard.reserve(model, estimateUsd, attempt, local, call);
      } catch (error) {
        await ledger.release(local); // the guard refused it or could not record it: nothing was sent
        throw error;
      }
      attempts++;
      ids.set(guarded, local);
      return guarded;
    },
    // The local entry closes first: the guard's settlement can throw after the answer arrived.
    settle: async (id, actualUsd, record) => {
      const local = ids.get(id);
      if (local && record)
        usage.set(local, {
          inputTokens: record.inputTokens ?? null,
          cachedTokens: record.cachedTokens ?? null,
          outputTokens: record.outputTokens ?? null,
          logId: record.logId ?? null,
        });
      if (local)
        await keep(() =>
          record?.certainty === "measured" || record?.certainty === "none"
            ? ledger.settle(local, actualUsd)
            : ledger.uncertain(local),
        );
      await guarded(() => guard.settle(id, actualUsd, record));
    },
    uncertain: async (id, record) => {
      const local = ids.get(id);
      if (local) await keep(() => ledger.uncertain(local));
      await guarded(() => guard.uncertain(id, record));
    },
  };
  return {
    budget,
    attempts: () => attempts,
    usage: (ledgerId: string) => usage.get(ledgerId),
    refusal: () => refusal,
    accounting: () => accounting,
  };
}

// An image's attempts and cost from the shared ledger: measured where settled, at the estimate where not (an attempt
// an interrupted run left reserved, or one whose settlement could not be written).
export function attemptsOf(
  entries: (Spend & { id: string })[],
  usage: (ledgerId: string) => Pick<Attempt, "inputTokens" | "cachedTokens" | "outputTokens" | "logId"> | undefined,
): Pick<Outcome, "usd" | "uncertainUsd" | "attempts" | "calls"> {
  const calls: Attempt[] = entries.map((e) => ({
    call: e.call,
    ledgerId: e.id,
    state: e.state,
    estimateUsd: e.estimate,
    usd: e.state === "settled" ? e.cost : null,
    inputTokens: null,
    cachedTokens: null,
    outputTokens: null,
    logId: null,
    ...usage(e.id),
  }));
  const round = (n: number) => Math.round(n * 1e9) / 1e9;
  return {
    usd: round(calls.reduce((sum, c) => sum + (c.usd ?? 0), 0)),
    uncertainUsd: round(calls.reduce((sum, c) => sum + (c.state === "settled" ? 0 : c.estimateUsd), 0)),
    // Sent attempts: an entry settled at nothing with no usage was refused before it left (kept so its id stays taken).
    attempts: calls.filter((c) => !(c.state === "settled" && c.usd === 0 && c.inputTokens === null)).length,
    calls,
  };
}

// An attempt's cost recomputed from its tokens at the stored prices, or null without them.
export function recomputed(call: Attempt, prices: z.infer<typeof Prices>): number | null {
  if (call.inputTokens === null || call.outputTokens === null) return null;
  const cached = Math.min(call.cachedTokens ?? 0, call.inputTokens);
  return (
    ((call.inputTokens - cached) * prices.input + cached * prices.cached + call.outputTokens * prices.output) / 1e6
  );
}

export type RunOptions = {
  dir?: string;
  // The results file inside `dir`: another name measures afresh and leaves the published file as it is.
  results?: string;
  context: Omit<MetaContext, "budget" | "owner">;
  guard: Budget;
  ledger: AttemptLedger;
  retryPending?: boolean;
  now?: () => Date;
  log?: (line: string) => void;
};
export type RunReport = { answered: number; failed: number; ambiguous: string[]; stopped: string | null };

const stopping = (error: unknown) => ["BudgetExceeded", "BudgetUnavailable"].includes((error as Error)?.name ?? "");

// Each manifest image without an outcome, in order, its outcome written before it is sent (`pending`) and after
// (`answered` or `failed`, with every attempt and its cost read back from the shared ledger). Stops at a budget or
// ledger refusal, or a settlement the ledger could not write, with nothing more sent.
export async function runSet(options: RunOptions): Promise<RunReport> {
  const dir = options.dir ?? SET_DIR;
  const results = options.results ?? RESULTS;
  const report: RunReport = { answered: 0, failed: 0, ambiguous: [], stopped: null };
  // One run per results file at a time: a second would read a stale snapshot and write over paid answers (round 1).
  mkdirSync(dir, { recursive: true });
  const release = takeLock(`${resultsPath(dir, results)}.lock`);
  if (typeof release === "string") return { ...report, stopped: `${results} is being run already: ${release}` };
  try {
    return await runLocked(options, dir, results, report);
  } finally {
    release();
  }
}

async function runLocked(options: RunOptions, dir: string, results: string, report: RunReport): Promise<RunReport> {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const manifest = readManifest(dir);
  const broken = manifestProblems(manifest, dir);
  if (broken.length) return { ...report, stopped: broken.join("; ") };
  let stored: ResultsFile;
  try {
    stored = readResults(dir, results) ?? { fingerprint: fingerprint(manifest), prices: PRICES, results: [] };
  } catch (error) {
    return { ...report, stopped: (error as Error).message };
  }
  const problems = resultProblems(stored, manifest, false);
  if (JSON.stringify(stored.prices) !== JSON.stringify(PRICES))
    problems.push(`${results} was priced at other rates than the client's now`);
  if (problems.length) return { ...report, stopped: problems.join("; ") };
  const save = () => writeAtomic(resultsPath(dir, results), `${JSON.stringify(stored, null, 1)}\n`);
  const put = (outcome: Outcome) => {
    stored.results = [...stored.results.filter((r) => r.file !== outcome.file), outcome];
    save();
  };
  const pending: Promise<unknown>[] = [];
  const finish = async (stopped: string) => {
    await Promise.allSettled(pending);
    return { ...report, stopped };
  };
  for (const entry of manifest.images) {
    const known = stored.results.find((r) => r.file === entry.file);
    if (known?.status === "answered" || known?.status === "failed") continue;
    if (known?.status === "pending" && !options.retryPending) {
      report.ambiguous.push(entry.file);
      continue;
    }
    const image = readFileSync(join(dir, entry.file));
    const spend = ledgeredBudget(options.guard, options.ledger, entry.file);
    const late: Promise<unknown>[] = [];
    const blank = { answer: null, failure: null, ms: null, usd: 0, uncertainUsd: 0, attempts: 0, calls: [] };
    put({ file: entry.file, status: "pending", ...blank, at: now().toISOString() });
    // Every attempt of this image in the ledger, an earlier interrupted run's included; null when it cannot be read,
    // and the image stays pending.
    const costs = async () => {
      try {
        return attemptsOf(await options.ledger.entries(entry.file), spend.usage);
      } catch (error) {
        return (error as Error).message;
      }
    };
    const ctx: StructuredContext = {
      ...options.context,
      budget: spend.budget,
      owner: { kind: "script", name: OWNER },
      // This image's late records (a settlement past the client's grace) are awaited before its accounting is read,
      // so one that fails late still stops the run (round 3).
      waitUntil: (promise) => {
        pending.push(promise);
        late.push(promise);
      },
    };
    const started = Date.now();
    let answer: DigitsAnswer | null = null;
    let failure: string | null = null;
    try {
      answer = (await structured(DigitsAnswer, digitsRequest(image), ctx)).value;
    } catch (error) {
      await Promise.allSettled(late);
      if (stopping(error)) {
        const why = spend.refusal() ?? (error as Error).message;
        // Nothing of this image was sent by this run: it goes back to how it was (no outcome, so the next run asks
        // again, or still pending when an earlier run's attempt is unaccounted for).
        if (spend.attempts() === 0) {
          stored.results = stored.results.filter((r) => r.file !== entry.file);
          if (known) stored.results.push(known);
          save();
          return finish(`${entry.file}: ${why}`);
        }
        const cost = await costs();
        if (typeof cost === "string") return finish(`${entry.file}: ${why}; its attempts could not be read (${cost})`);
        put({
          file: entry.file,
          status: "failed",
          ...blank,
          failure: `stopped: ${why}`,
          ...cost,
          at: now().toISOString(),
        });
        return finish(`${entry.file}: ${why}`);
      }
      failure = (
        error instanceof ModelOutputError
          ? `output-${error.kind}`
          : `${(error as Error).name}: ${(error as Error).message}`
      ).slice(0, 300);
    }
    const ms = Date.now() - started;
    await Promise.allSettled(late);
    const cost = await costs();
    if (typeof cost === "string")
      return finish(`${entry.file}: its attempts could not be read (${cost}); left pending`);
    put({
      file: entry.file,
      status: answer ? "answered" : "failed",
      ...blank,
      answer,
      failure,
      ms,
      ...cost,
      at: now().toISOString(),
    });
    if (answer) report.answered++;
    else report.failed++;
    log(`${entry.file}: ${answer ? `edited=${answer.edited} confidence=${answer.confidence}` : `failed (${failure})`}`);
    const accounting = spend.accounting();
    if (accounting) return finish(`${entry.file}: accounting: a settlement could not be written (${accounting})`);
  }
  await Promise.allSettled(pending);
  return report;
}

// The error level of a box: the mean absolute difference between the image and itself re-saved at quality 90.
async function errorLevels(image: Uint8Array, boxes: Box[]): Promise<number[]> {
  const original = await sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true });
  const resaved = await sharp(await sharp(image).jpeg({ quality: 90 }).toBuffer())
    .greyscale()
    .raw()
    .toBuffer();
  const width = original.info.width;
  return boxes.map((box) => {
    let sum = 0;
    for (let y = box.top; y < box.top + box.height; y++)
      for (let x = box.left; x < box.left + box.width; x++)
        sum += Math.abs((original.data[y * width + x] ?? 0) - (resaved[y * width + x] ?? 0));
    return sum / (box.width * box.height);
  });
}

// The page's other text, drawn the same way as the account number: the payment block's values and labels and the
// invoice's number and date.
export const REFERENCE_BOXES: Box[] = [
  BANK_BOX,
  BRANCH_BOX,
  { left: 72, top: 978, width: 236, height: 38 },
  { left: 72, top: 1018, width: 236, height: 38 },
  { left: 72, top: 1058, width: 236, height: 38 },
  { left: 684, top: 304, width: 236, height: 30 },
  { left: 684, top: 330, width: 236, height: 30 },
];

export type BaselineResult = { level: number; mean: number; spread: number; z: number; flagged: boolean };

// The deterministic baseline: error-level analysis of the account number against the page's other text. No model, no
// cost. Flagged when the account number's level stands BASELINE_Z spreads above theirs.
export async function baselineDigits(image: Uint8Array): Promise<BaselineResult> {
  const [level = 0, ...reference] = await errorLevels(image, [ACCOUNT_BOX, ...REFERENCE_BOXES]);
  const mean = reference.reduce((a, b) => a + b, 0) / reference.length;
  const spread = Math.sqrt(reference.reduce((a, b) => a + (b - mean) ** 2, 0) / reference.length);
  const z = (level - mean) / Math.max(spread, BASELINE_MIN_SPREAD * mean);
  return { level, mean, spread, z, flagged: z > BASELINE_Z };
}

export type Score = {
  fingerprint: string;
  set: string;
  images: number;
  answered: number;
  failed: number;
  pending: number;
  correct: number;
  accuracy: number;
  edited: number;
  detected: number;
  detectedByKind: Record<EditKind, [number, number]>;
  accountNamed: number;
  twins: number;
  falseAlarms: number;
  // Regions an answer named as altered that were not: any field but the account number on an edit, any field on a twin.
  unsupportedRegions: number;
  unsupportedAnswers: number;
  medianMs: number;
  worstMs: number;
  costUsd: number;
  uncertainUsd: number;
  attempts: number;
  // Attempts whose stored tokens, at the stored prices, give back their settled cost to the nanodollar.
  reconstructed: number;
  prices: { input: number; cached: number; output: number };
  baseline: { detected: number; falseAlarms: number };
};

export function scoreDigits(
  manifest: Manifest,
  stored: ResultsFile,
  baseline: Record<string, boolean>,
  set = "eval/frontier/sets/digits",
): Score {
  const byFile = new Map(stored.results.map((r) => [r.file, r]));
  const said = (e: ManifestEntry) => byFile.get(e.file)?.answer?.edited;
  const edited = manifest.images.filter((e) => e.edited);
  const twins = manifest.images.filter((e) => !e.edited);
  const detected = edited.filter((e) => said(e) === true);
  const falseAlarms = twins.filter((e) => said(e) === true).length;
  const correct = detected.length + twins.filter((e) => said(e) === false).length;
  const detectedByKind = Object.fromEntries(
    EDIT_KINDS.map((kind) => {
      const of = edited.filter((e) => e.kind === kind);
      return [kind, [of.filter((e) => said(e) === true).length, of.length]];
    }),
  ) as Record<EditKind, [number, number]>;
  const accountNamed = detected.filter((e) =>
    byFile.get(e.file)?.answer?.regions.some((r) => r.field === "account_number"),
  ).length;
  const unsupported = manifest.images.map(
    (e) => byFile.get(e.file)?.answer?.regions.filter((r) => !e.edited || r.field !== "account_number").length ?? 0,
  );
  const times = stored.results
    .flatMap((r) => (r.status === "answered" && r.ms !== null ? [r.ms] : []))
    .sort((a, b) => a - b);
  const mid = Math.floor(times.length / 2);
  const median =
    times.length === 0 ? 0 : times.length % 2 ? (times[mid] ?? 0) : ((times[mid - 1] ?? 0) + (times[mid] ?? 0)) / 2;
  const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
  const calls = stored.results.flatMap((r) => r.calls);
  return {
    fingerprint: stored.fingerprint,
    set,
    images: manifest.images.length,
    answered: stored.results.filter((r) => r.status === "answered").length,
    failed: stored.results.filter((r) => r.status === "failed").length,
    pending: stored.results.filter((r) => r.status === "pending").length,
    correct,
    accuracy: manifest.images.length ? correct / manifest.images.length : 0,
    edited: edited.length,
    detected: detected.length,
    detectedByKind,
    accountNamed,
    twins: twins.length,
    falseAlarms,
    unsupportedRegions: unsupported.reduce((a, b) => a + b, 0),
    unsupportedAnswers: unsupported.filter((n) => n > 0).length,
    medianMs: Math.round(median),
    worstMs: times.at(-1) ?? 0,
    costUsd: round4(stored.results.reduce((sum, r) => sum + r.usd, 0)),
    uncertainUsd: round4(stored.results.reduce((sum, r) => sum + r.uncertainUsd, 0)),
    attempts: calls.length,
    reconstructed: calls.filter((c) => {
      const again = recomputed(c, stored.prices);
      return c.usd !== null && again !== null && Math.abs(again - c.usd) < 1e-9;
    }).length,
    prices: stored.prices,
    baseline: {
      detected: edited.filter((e) => baseline[e.file] === true).length,
      falseAlarms: twins.filter((e) => baseline[e.file] === true).length,
    },
  };
}

export type Decision = "feature" | "cut" | "open question";

// The rule, set before the run (D08 T03 §1).
export function decide(score: Score): Decision {
  if (score.detected <= score.baseline.detected || score.falseAlarms >= 3) return "cut";
  if (score.detected >= 8 && score.accountNamed >= 7 && score.falseAlarms <= 1) return "feature";
  return "open question";
}

// The entry's lines, exactly as the log carries them.
export function scoreLines(score: Score): string[] {
  const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
  const kinds = EDIT_KINDS.map((k) => `${k} ${score.detectedByKind[k][0]}/${score.detectedByKind[k][1]}`).join(", ");
  const made = EDIT_KINDS.map((k) => `${k} ${score.detectedByKind[k][1]}`).join(", ");
  const p = score.prices;
  return [
    `Model and settings: \`${SPARK}\`, reasoning effort ${EFFORT}, \`max_output_tokens\` ${MAX_OUTPUT_TOKENS}, strict structured output (\`DigitsAnswer\`), \`store: false\``,
    `Inputs: ${score.images} images in \`${score.set}/\` (${score.twins} twins; ${score.edited} edits: ${made})`,
    `Fingerprint: \`${score.fingerprint}\``,
    `Accuracy: ${pct(score.accuracy)} (${score.correct}/${score.images}; failed ${score.failed}, pending ${score.pending})`,
    `Detected: ${score.detected}/${score.edited} edited (${kinds}); account_number named on ${score.accountNamed}`,
    `False alarms: ${score.falseAlarms}/${score.twins} twins`,
    `Unsupported regions: ${score.unsupportedRegions} on ${score.unsupportedAnswers} answers (a field named as altered that was not)`,
    `Latency: median ${(score.medianMs / 1000).toFixed(1)} s, worst ${(score.worstMs / 1000).toFixed(1)} s`,
    `Cost: US$${score.costUsd.toFixed(4)} measured, US$${score.uncertainUsd.toFixed(4)} uncertain; ${score.reconstructed}/${score.attempts} attempts recomputed from their tokens at US$${p.input}, ${p.cached} cached and ${p.output} output per million`,
    `Baseline (error level, z > ${BASELINE_Z}): detected ${score.baseline.detected}/${score.edited} edited, false alarms ${score.baseline.falseAlarms}/${score.twins} twins`,
    `Decision: ${decide(score)}`,
  ];
}

const REF = /\bD\d\d T\d\d §\d+\b/g;
const graphResolves = (ref: string) => {
  try {
    execFileSync("python3", ["scripts/todo-graph.py", "resolve", ref], { cwd: ROOT, stdio: "ignore", timeout: 30_000 });
    return true;
  } catch (error) {
    // Exit 3 (stamped) and 4 (waiting) still name a real section.
    const status = (error as { status?: number }).status;
    return status === 3 || status === 4;
  }
};

// The log's entry for this experiment carries every promised field. Answers what is missing, or null.
const repoPathExists = (path: string) => existsSync(join(ROOT, path));

export function checkLog(
  log: string,
  score: Score,
  resolves: (ref: string) => boolean = graphResolves,
  exists: (path: string) => boolean = repoPathExists,
): string | null {
  if (score.answered + score.failed !== score.images)
    return `only ${score.answered + score.failed} of ${score.images} images have an outcome`;
  const entry = log
    .split(/^(?=## )/m)
    .find((part) => /^## 2026-\d\d-\d\d: .*edited invoice digits/i.test(part) && part.includes(score.fingerprint));
  if (!entry) return "no `## 2026-` entry for the edited-digits experiment carrying the results' fingerprint";
  const missing = [...scoreLines(score), "eval/frontier/digits.ts", LIMITATION].filter((line) => !entry.includes(line));
  if (missing.length) return `the entry lacks: ${missing.join(" | ")}`;
  // Every repository path the entry names must still be there (D08 T03 §9): a moved file leaves no dangling evidence.
  const named = [...entry.matchAll(/`((?:eval|docs|src|scripts|test|todo)\/[^`\s]*)`/g)].map((m) => m[1] as string);
  const gone = named.filter((path) => !exists(path));
  if (gone.length) return `the entry names paths that do not exist: ${gone.join(", ")}`;
  // A second, contradicting claim of the model or its settings anywhere in the entry.
  const claims = entry.match(/muse-[a-z]+-\d[\w.-]*|reasoning effort \w+/g) ?? [];
  const wrong = claims.filter((c) => c !== SPARK && c !== `reasoning effort ${EFFORT}`);
  if (wrong.length) return `the entry claims another model or setting: ${wrong.join(", ")}`;
  if (decide(score) === "feature") {
    const refs = entry.match(REF) ?? [];
    if (!refs.some((ref) => !ref.startsWith("D08 T03") && resolves(ref)))
      return "a feature decision names no follow-up section that resolves";
  }
  return null;
}

async function baselines(manifest: Manifest, dir: string): Promise<Record<string, boolean>> {
  const flags: Record<string, boolean> = {};
  for (const e of manifest.images) flags[e.file] = (await baselineDigits(readFileSync(join(dir, e.file)))).flagged;
  return flags;
}

// The score of the stored results, or the problems that stop it.
export async function scoreSet(dir = SET_DIR, results = RESULTS): Promise<{ score: Score } | { problems: string[] }> {
  if (!existsSync(join(dir, "manifest.json"))) return { problems: [`${dir} has no manifest.json`] };
  const manifest = readManifest(dir);
  const broken = manifestProblems(manifest, dir);
  if (broken.length) return { problems: broken };
  let stored: ResultsFile | null;
  try {
    stored = readResults(dir, results);
  } catch (error) {
    return { problems: [(error as Error).message] };
  }
  if (!stored) return { problems: [`${results} does not exist`] };
  const problems = resultProblems(stored, manifest, true);
  if (problems.length) return { problems };
  const set = relative(ROOT, dir).split("\\").join("/");
  return { score: scoreDigits(manifest, stored, await baselines(manifest, dir), set) };
}

// The ledger run an image set and results file spend under: the published results.json keeps the plain name it ran
// under; any other results file is its own run, so a fresh measurement never counts the published one's attempts.
export const runName = (manifest: Manifest, results = RESULTS) =>
  `eval-frontier-digits-${fingerprint(manifest).slice(0, 12)}${results === RESULTS ? "" : `-${results.replace(/\.json$/, "")}`}`;

const USAGE =
  "usage: node eval/frontier/digits.ts build [--out <dir>] | run [--results <file>] [--retry-pending] | score [--results <file>] [--check <log>]";

export type DigitsArgs =
  | { command: "build"; out: string | null }
  | { command: "run"; results: string; retryPending: boolean }
  | { command: "score"; results: string; check: string | null }
  | { command: "help" };

// The whole argument list checked before anything reads a secret or spends: an unknown command, option or stray
// argument is refused (round 4), as scripts/glimmer/teacher-label.ts refuses its own.
export function parseDigitsArgs(argv: string[]): DigitsArgs | { error: string } {
  const [command, ...rest] = argv;
  const allowed: Record<string, Record<string, { type: "string" | "boolean" }>> = {
    build: { out: { type: "string" } },
    run: { results: { type: "string" }, "retry-pending": { type: "boolean" } },
    score: { results: { type: "string" }, check: { type: "string" } },
  };
  if (command === "--help" || command === "-h" || command === "help") return { command: "help" };
  const options = command ? allowed[command] : undefined;
  if (!command || !options) return { error: `unknown command ${command ?? "(none)"}` };
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({ args: rest, options, strict: true, allowPositionals: false }));
  } catch (error) {
    return { error: (error as Error).message };
  }
  const results = (values.results as string | undefined) ?? RESULTS;
  if (!/^[\w.-]+\.json$/.test(results)) return { error: "--results names a .json file in the set's folder" };
  if (command === "build") return { command, out: (values.out as string | undefined) ?? null };
  if (command === "run") return { command, results, retryPending: values["retry-pending"] === true };
  return { command: "score", results, check: (values.check as string | undefined) ?? null };
}

if (import.meta.filename === process.argv[1]) {
  const args = parseDigitsArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(`digits: ${args.error}\n${USAGE}`);
    process.exit(2);
  }
  if (args.command === "help") {
    console.log(USAGE);
    process.exit(0);
  }
  if (args.command === "build") {
    try {
      const manifest = await buildSet(resolve(args.out ?? SET_DIR));
      console.log(`built ${manifest.images.length} images; fonts ${JSON.stringify(manifest.fonts)}`);
    } catch (error) {
      console.error(`digits build: ${(error as Error).message}`);
      process.exit(1);
    }
  } else if (args.command === "score") {
    const result = await scoreSet(SET_DIR, args.results);
    if ("problems" in result) {
      console.error(`digits score: ${result.problems.join("; ")}`);
      process.exit(1);
    }
    if (args.check) {
      const problem = checkLog(readFileSync(args.check, "utf-8"), result.score);
      console.log(problem ? `digits score --check: ${problem}` : "digits score --check: the entry matches the score");
      process.exit(problem ? 1 : 0);
    }
    console.log(JSON.stringify({ ...result.score, lines: scoreLines(result.score) }, null, 1));
  } else {
    const manifest = readManifest();
    const clock = new Date();
    const now = () => clock;
    const tick = () => {
      clock.setTime(Date.now());
      return clock;
    };
    const secrets = await readSecretsFromVault();
    const report = await runSet({
      results: args.results,
      context: { env: { META_API_KEY: secrets.meta, CF_AIG_TOKEN: secrets.run, META_GATEWAY_URL: GATEWAY_URL } },
      // One clock for both records of an attempt, so one near SAST midnight never counts on two days.
      guard: localBudget(OWNER, undefined, now),
      ledger: sharedLedger(metaLedger(), runName(manifest, args.results), { now: tick }),
      retryPending: args.retryPending,
      log: (line) => console.log(line),
    });
    console.log(JSON.stringify(report));
    process.exit(report.stopped || report.ambiguous.length ? 1 : 0);
  }
}
