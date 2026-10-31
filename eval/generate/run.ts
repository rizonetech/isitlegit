// The synthetic South African mail set's runner (D08 T01 §3): each scenario's subject and body written by Muse Spark,
// checked by the realism rules, assembled in code, and the accepted messages written as one set.
//
//   node eval/generate/run.ts dry                         # the 160 scenarios with their labels; reads no key, spends nothing
//   node eval/generate/run.ts generate [--retry-pending]  # every scenario without an outcome through Spark, then the set
//
// Spend follows the frontier runner (D08 T03 §1, eval/frontier/digits.ts): every attempt, a structured repair included,
// is reserved in the shared ledger under its lock (run cap US$2.00) and then in main's budget guard
// (`localBudget("eval-synthetic")`, live D1 `model_spend` rows) under the ledger entry's id, before it is sent, and
// settled at Meta's reported cost. A refused reservation, a ledger that cannot be written, or a settlement that could not
// be recorded stops the run with nothing more sent.
//
// Results (eval/generate/results.json) are kept by scenario id and written before each call (`pending`) and after it, so
// a resumed run pays nothing for an answered scenario; a scenario an interrupted run left `pending` may have been paid
// for, so it is resent only when asked (`--retry-pending`). A body that fails the realism rules is asked for once more
// with the problems named; a scenario failing twice is replaced by a fresh variant of the same category and parties
// (`scenario(category, n, variant)`). The set is written whole, and only when the accepted messages reach the counts;
// a run that cannot reach them within the cap stops incomplete with nothing written to the set.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { localBudget } from "../../scripts/lib/meta-budget.ts";
import { GATEWAY_URL, metaLedger, readSecretsFromVault, takeLock } from "../../scripts/meta-smoke.ts";
import type { MetaContext } from "../../src/meta/client.ts";
import { sastDay } from "../../src/meta/day.ts";
import type { Budget } from "../../src/meta/guard.ts";
import {
  ModelOutputError,
  type StructuredContext,
  type StructuredRequest,
  structured,
} from "../../src/meta/structured.ts";
import {
  Attempt,
  type AttemptLedger,
  attemptsOf,
  ledgeredBudget,
  sharedLedger,
  writeAtomic,
} from "../frontier/digits.ts";
import { loadSets } from "../load.ts";
import { type Annotation, CATEGORIES, type Label } from "../schema.ts";
import { assemble } from "./assemble.ts";
import { type Generated, MAX_WORDS, MIN_WORDS, realismProblems } from "./realism.ts";
import { labelOf, type Spec, scenario, scenarios } from "./scenarios.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SET_NAME = "synthetic-sa";
export const SETS_DIR = join(ROOT, "eval/sets");
export const SET_DIR = join(SETS_DIR, SET_NAME);
export const RESULTS_FILE = join(ROOT, "eval/generate/results.json");
export const SPARK = "muse-spark-1.3";
// Writing a short mail needs little reasoning; at low effort an answer took under 600 tokens of reasoning and text
// (scripts/glimmer/teacher-label.ts), and 2,000 leave room for a 400-word body.
export const EFFORT = "low" as const;
export const MAX_OUTPUT_TOKENS = 2_000;
export const RUN_CAP_USD = 2;
export const OWNER = "eval-synthetic";
// Tries per scenario (the first and one realism retry), and replacements per scenario number after the first.
export const TRIES = 2;
export const MAX_VARIANTS = 3;
// The Outcome's counts (D08 T01): the synthetic set's own mix floor, and the totals with every other set.
export const MIN_GENUINE = 60;
export const MIN_PER_ATTACK = 8;
export const MIN_TOTAL_ALL = 150;
export const MIN_GENUINE_ALL = 60;
export const SOURCE = `IsItLegit synthetic South African set, written by ${SPARK} from code-built scenarios (D08 T01 §3)`;

export const SyntheticBody = z.strictObject({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(6000),
});

export const INSTRUCTION = [
  "You write one realistic email for a South African small-business email test set.",
  "Every organisation, person, domain, phone number and account in it is fictional and is given to you; use only those.",
  "Never name a real company, bank, brand, government body or product. Write in South African English, in plain text.",
  `The body is ${MIN_WORDS} to ${MAX_WORDS} words, with no placeholders, brackets, template fields or notes about the writing.`,
  "Every detail listed as required must appear in the body exactly as given, character for character.",
  "Answer with the subject line and the body only.",
].join(" ");

// The scenario as the model reads it: who writes to whom, what the message does, and what it must carry.
export function scenarioText(spec: Spec, problems: string[] | null): string {
  const lines = [
    `Kind: ${spec.label === "genuine" ? "genuine business mail" : "a fraudulent message, written as the fraudster would"} (${spec.category}).`,
    `From: ${spec.from.name}, writing as ${spec.claimed}.`,
    `To: ${spec.to.name} at ${spec.recipient}.`,
    `What it does: ${spec.trick}`,
    `Required details, each verbatim: ${Object.entries(spec.details)
      .map(([what, value]) => `${what} "${value}"`)
      .join("; ")}.`,
    ...(spec.attachment ? [`It refers to the attached file ${spec.attachment.filename}.`] : []),
    ...(spec.label === "genuine"
      ? [
          "It is ordinary, honest mail: no changed bank details, no secrecy, no pressure to pay, no deadline threat, and no link outside the sender's own domain.",
        ]
      : []),
  ];
  if (problems?.length) lines.push(`A previous draft was refused for: ${problems.join("; ")}. Fix every one.`);
  return lines.join("\n");
}

export function syntheticRequest(spec: Spec, problems: string[] | null = null): StructuredRequest {
  return {
    name: "synthetic_mail",
    model: SPARK,
    instructions: INSTRUCTION,
    input: [{ role: "user" as const, content: [{ type: "input_text" as const, text: scenarioText(spec, problems) }] }],
    max_output_tokens: MAX_OUTPUT_TOKENS,
    reasoning: { effort: EFFORT },
  };
}

// What the results record per scenario id. `open` has tries left, `rejected` failed its tries, `pending` was sent and
// never closed (perhaps paid for).
export const Written = z.strictObject({
  id: z.string(),
  status: z.enum(["pending", "open", "accepted", "rejected"]),
  tries: z.number().int().min(0),
  generated: SyntheticBody.nullable(),
  problems: z.array(z.string()),
  usd: z.number(),
  uncertainUsd: z.number(),
  attempts: z.number().int(),
  // Every attempt as the shared ledger and Meta's usage record it.
  calls: z.array(Attempt),
  at: z.string(),
});
export type Written = z.infer<typeof Written>;
export const ResultsFile = z.strictObject({ fingerprint: z.string(), results: z.array(Written) });
export type ResultsFile = z.infer<typeof ResultsFile>;

// The scenarios and the request they are asked with: results measured against another never mix with these.
export function fingerprint(): string {
  return createHash("sha256")
    .update(JSON.stringify({ specs: scenarios(), instruction: INSTRUCTION, model: SPARK, effort: EFFORT }))
    .digest("hex");
}
export const runName = () => `eval-synthetic-${fingerprint().slice(0, 12)}`;

// The dry run: every scenario with its label, nothing read, nothing spent.
export function dryRun(specs: Spec[] = scenarios()): string[] {
  const lines = specs.map(
    (s) =>
      `${s.id}\t${s.label}\t${s.category}\t${s.basis === "model" ? "basis model" : s.expected.join(",") || "nothing expected"}`,
  );
  const genuine = specs.filter((s) => s.label === "genuine").length;
  lines.push(`${specs.length} scenarios: ${genuine} genuine, ${specs.length - genuine} attacks; nothing sent`);
  return lines;
}

// Why the accepted messages, with every other set, fall short of the counts; empty when they reach them.
export function countProblems(accepted: Spec[], others: { total: number; genuine: number }): string[] {
  const problems: string[] = [];
  const genuine = accepted.filter((s) => s.label === "genuine").length;
  if (genuine < MIN_GENUINE) problems.push(`${genuine} genuine accepted, fewer than ${MIN_GENUINE}`);
  for (const category of CATEGORIES.filter((c) => !c.startsWith("genuine-"))) {
    const n = accepted.filter((s) => s.category === category).length;
    if (n < MIN_PER_ATTACK) problems.push(`${n} ${category} accepted, fewer than ${MIN_PER_ATTACK}`);
  }
  if (others.total + accepted.length < MIN_TOTAL_ALL)
    problems.push(`${others.total + accepted.length} samples across the sets, fewer than ${MIN_TOTAL_ALL}`);
  if (others.genuine + genuine < MIN_GENUINE_ALL)
    problems.push(`${others.genuine + genuine} genuine across the sets, fewer than ${MIN_GENUINE_ALL}`);
  return problems;
}

// Every other set's totals, read through the loader.
export function otherSets(root = SETS_DIR, name = SET_NAME): { total: number; genuine: number } {
  const sets = loadSets(root).filter((s) => s.name !== name);
  const samples = sets.flatMap((s) => s.samples);
  return { total: samples.length, genuine: samples.filter((s) => s.label === "genuine").length };
}

// The annotation of an accepted message: its scenario and the details its body was found to carry.
export function annotationOf(spec: Spec, path: string, date: string): Annotation {
  const found = Object.entries(spec.details).map(([what, value]) => `${what} ${value}`);
  let rationale = `${spec.trick} The body carries ${found.join("; ")}.`;
  if (rationale.length > 400) rationale = `${spec.trick} The body carries its ${Object.keys(spec.details).join(", ")}.`;
  return { path, rationale: rationale.slice(0, 400), reader: "claude", date, second_reading: null, resolution: null };
}

export type Accepted = { spec: Spec; generated: Generated };

// The set written whole: assembled beside its place and renamed into it, refused when it exists already.
export function writeSet(dir: string, accepted: Accepted[], date: string): void {
  if (existsSync(dir)) throw new Error(`${dir} exists already; the set is never written over`);
  const tmp = `${dir}.${process.pid}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const labels: Label[] = [];
  const annotations: Annotation[] = [];
  for (const { spec, generated } of accepted) {
    const path = `${spec.id}.eml`;
    writeFileSync(join(tmp, path), assemble(spec, generated));
    labels.push(labelOf(spec, path, SOURCE));
    annotations.push(annotationOf(spec, path, date));
  }
  writeFileSync(join(tmp, "labels.json"), `${JSON.stringify(labels, null, 1)}\n`);
  writeFileSync(join(tmp, "annotations.json"), `${JSON.stringify(annotations, null, 1)}\n`);
  renameSync(tmp, dir);
}

export type GenerateOptions = {
  context: Omit<MetaContext, "budget" | "owner">;
  guard: Budget;
  ledger: AttemptLedger;
  resultsFile?: string;
  setDir?: string;
  others?: { total: number; genuine: number };
  specs?: Spec[];
  retryPending?: boolean;
  now?: () => Date;
  log?: (line: string) => void;
};
export type GenerateReport = {
  accepted: number;
  rejected: string[];
  ambiguous: string[];
  unfilled: string[];
  stopped: string | null;
  written: boolean;
  shortfall: string[];
};

const stopping = (error: unknown) =>
  ["BudgetExceeded", "BudgetUnavailable", "LedgerRefused"].includes((error as Error)?.name ?? "");

function readResults(file: string): ResultsFile | null {
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    throw new Error(`${file} is not JSON`);
  }
  const parsed = ResultsFile.safeParse(raw);
  if (!parsed.success) throw new Error(`${file} is malformed (${parsed.error.issues[0]?.path.join(".")})`);
  return parsed.data;
}

// Every scenario through Spark (variants where needed), then the set when the counts are reached. One run per results
// file at a time.
export async function generate(options: GenerateOptions): Promise<GenerateReport> {
  const file = options.resultsFile ?? RESULTS_FILE;
  const report: GenerateReport = {
    accepted: 0,
    rejected: [],
    ambiguous: [],
    unfilled: [],
    stopped: null,
    written: false,
    shortfall: [],
  };
  mkdirSync(dirname(file), { recursive: true });
  const release = takeLock(`${file}.lock`);
  if (typeof release === "string") return { ...report, stopped: `${file} is being run already: ${release}` };
  try {
    return await generateLocked(options, file, report);
  } finally {
    release();
  }
}

async function generateLocked(options: GenerateOptions, file: string, report: GenerateReport): Promise<GenerateReport> {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const print = fingerprint();
  let stored: ResultsFile;
  try {
    stored = readResults(file) ?? { fingerprint: print, results: [] };
  } catch (error) {
    return { ...report, stopped: (error as Error).message };
  }
  if (stored.fingerprint !== print)
    return { ...report, stopped: `${file} was written for other scenarios or another request (fingerprint differs)` };
  const save = () => writeAtomic(file, `${JSON.stringify(stored, null, 1)}\n`);
  const put = (w: Written) => {
    stored.results = [...stored.results.filter((r) => r.id !== w.id), w];
    save();
  };
  const pending: Promise<unknown>[] = [];
  const accepted: Accepted[] = [];
  const finish = async (stopped: string | null) => {
    await Promise.allSettled(pending);
    return { ...report, stopped };
  };

  for (const first of options.specs ?? scenarios()) {
    const n = Number(first.id.match(/-(\d{3})$/)?.[1]);
    let filled = false;
    let ambiguous = false;
    for (let v = 0; v <= MAX_VARIANTS && !filled && !ambiguous; v++) {
      const spec = v === 0 ? first : scenario(first.category, n, v);
      let known = stored.results.find((r) => r.id === spec.id);
      if (known?.status === "accepted" && known.generated) {
        accepted.push({ spec, generated: known.generated });
        filled = true;
        break;
      }
      if (known?.status === "rejected") continue;
      if (known?.status === "pending" && !options.retryPending) {
        report.ambiguous.push(spec.id);
        ambiguous = true;
        break;
      }
      const spend = ledgeredBudget(options.guard, options.ledger, spec.id);
      const costs = async () => {
        try {
          return attemptsOf(await options.ledger.entries(spec.id), spend.usage);
        } catch (error) {
          return (error as Error).message;
        }
      };
      let tries = known?.status === "pending" ? Math.max(known.tries - 1, 0) : (known?.tries ?? 0);
      let problems = known?.problems ?? [];
      while (tries < TRIES) {
        const before = known;
        const blank = { generated: null, usd: 0, uncertainUsd: 0, attempts: 0, calls: [] };
        put({ id: spec.id, status: "pending", tries: tries + 1, problems, ...blank, at: now().toISOString() });
        const late: Promise<unknown>[] = [];
        const ctx: StructuredContext = {
          ...options.context,
          budget: spend.budget,
          owner: { kind: "script", name: OWNER },
          waitUntil: (promise) => {
            pending.push(promise);
            late.push(promise);
          },
        };
        const sentBefore = spend.attempts();
        let generated: Generated | null = null;
        let stop: string | null = null;
        try {
          generated = (await structured(SyntheticBody, syntheticRequest(spec, tries ? problems : null), ctx)).value;
          problems = realismProblems(spec, generated);
        } catch (error) {
          await Promise.allSettled(late);
          if (stopping(error)) stop = spend.refusal() ?? (error as Error).message;
          problems = [
            error instanceof ModelOutputError
              ? `output-${error.kind}`
              : `${(error as Error).name}: ${(error as Error).message}`.slice(0, 300),
          ];
        }
        await Promise.allSettled(late);
        if (stop && spend.attempts() === sentBefore) {
          // Nothing of this try was sent: the scenario goes back to how it was, and the run stops.
          stored.results = stored.results.filter((r) => r.id !== spec.id);
          if (before) stored.results.push(before);
          save();
          return finish(`${spec.id}: ${stop}`);
        }
        tries++;
        const cost = await costs();
        if (typeof cost === "string")
          return finish(`${spec.id}: its attempts could not be read (${cost}); left pending`);
        const ok = generated !== null && problems.length === 0 && !stop;
        const status = ok ? "accepted" : tries >= TRIES ? "rejected" : "open";
        known = { id: spec.id, status, tries, generated, problems, ...cost, at: now().toISOString() };
        put(known);
        log(`${spec.id}: ${status}${problems.length ? ` (${problems.join("; ")})` : ""}`);
        if (stop) return finish(`${spec.id}: ${stop}`);
        const accounting = spend.accounting();
        if (accounting) return finish(`${spec.id}: accounting: a settlement could not be written (${accounting})`);
        if (ok && generated) {
          accepted.push({ spec, generated });
          filled = true;
          break;
        }
      }
      if (!filled) report.rejected.push(spec.id);
    }
    if (!filled && !ambiguous) report.unfilled.push(first.id);
  }
  await Promise.allSettled(pending);
  report.accepted = accepted.length;
  if (report.ambiguous.length) return { ...report, stopped: `${report.ambiguous.length} scenarios left pending` };
  // The bodies are checked again as they are written: a stored answer counts only while it passes today's rules.
  const failing = accepted.filter((a) => realismProblems(a.spec, a.generated).length).map((a) => a.spec.id);
  if (failing.length) return { ...report, stopped: `stored answers fail the realism rules: ${failing.join(", ")}` };
  const setDir = options.setDir ?? SET_DIR;
  report.shortfall = countProblems(
    accepted.map((a) => a.spec),
    options.others ?? otherSets(dirname(setDir), SET_NAME),
  );
  if (report.shortfall.length) return { ...report, stopped: `incomplete: ${report.shortfall.join("; ")}` };
  writeSet(setDir, accepted, sastDay(now()));
  return { ...report, written: true };
}

const USAGE = "usage: node eval/generate/run.ts dry | generate [--retry-pending]";

export type RunArgs = { command: "dry" } | { command: "generate"; retryPending: boolean } | { command: "help" };

// The whole argument list checked before anything reads a secret or spends.
export function parseRunArgs(argv: string[]): RunArgs | { error: string } {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") return { command: "help" };
  const allowed: Record<string, Record<string, { type: "boolean" }>> = {
    dry: {},
    generate: { "retry-pending": { type: "boolean" } },
  };
  const options = command ? allowed[command] : undefined;
  if (!command || !options) return { error: `unknown command ${command ?? "(none)"}` };
  let values: Record<string, boolean | string | undefined>;
  try {
    ({ values } = parseArgs({ args: rest, options, strict: true, allowPositionals: false }));
  } catch (error) {
    return { error: (error as Error).message };
  }
  if (command === "dry") return { command };
  return { command: "generate", retryPending: values["retry-pending"] === true };
}

if (import.meta.filename === process.argv[1]) {
  const args = parseRunArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(`generate: ${args.error}\n${USAGE}`);
    process.exit(2);
  }
  if (args.command === "help") {
    console.log(USAGE);
    process.exit(0);
  }
  if (args.command === "dry") {
    for (const line of dryRun()) console.log(line);
    process.exit(0);
  }
  const clock = new Date();
  const now = () => clock;
  const tick = () => {
    clock.setTime(Date.now());
    return clock;
  };
  const secrets = await readSecretsFromVault();
  const report = await generate({
    context: { env: { META_API_KEY: secrets.meta, CF_AIG_TOKEN: secrets.run, META_GATEWAY_URL: GATEWAY_URL } },
    // One clock for both records of an attempt, so one near SAST midnight never counts on two days.
    guard: localBudget(OWNER, undefined, now),
    ledger: sharedLedger(metaLedger(), runName(), { now: tick, capUsd: RUN_CAP_USD }),
    retryPending: args.retryPending,
    log: (line) => console.log(line),
  });
  console.log(JSON.stringify(report));
  process.exit(report.written ? 0 : 1);
}
