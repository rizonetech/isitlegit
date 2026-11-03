// GPT-6 Astra as a candidate Loupe 1.1 labeler (coordinator, 2026-11-01 22:55 SAST), through `codex exec`
// exactly as Codex Terra was run: same screenshot, same prompt shape, same schema (`wonder-schema.json`),
// output zod-validated before it is stored.
//
//   node scripts/glimmer/codex-astra-label.ts --ids <id,id> [--test <name>]   # named pages only
//
// Labels land only under `<store>/raw/astra/`; `raw/wonder/`, `raw/teacher/` and `raw/codex-terra/` are
// comparison sets and are never deleted or overwritten. A page already labelled by Astra is skipped.
// Brand is never a label: no brand field exists in the schema. The same refusals as Terra apply (no
// unredacted sample page, no `samples/` path, no screenshot no label).
//
// Spend: this test's cap is 1,500 estimated Codex credits (the Terra tests' token accounting: 125 per 1M
// input tokens, 750 per 1M output), stated in the run file before any call and never raised. The runner
// stops between batches at the cap.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { LURE_TYPES } from "../../src/vision/page-screen.ts";
import { parseTerraUsage, terraPrompt, terraRefusal } from "./codex-terra-label.ts";
import { openStore, type StoredPage, storeDir } from "./store.ts";
import { claimExclusiveLabelSlot, WonderLabel, writeExclusiveLabelFile } from "./wonder-label.ts";

export const ASTRA_MODEL = "gpt-6-astra";
export const ASTRA_EFFORT = "medium";
export const ASTRA_TEACHER = "codex-astra";
const ROOT = resolve(import.meta.dirname, "../..");
export const ASTRA_SCHEMA = join(ROOT, "scripts/glimmer/wonder-schema.json");

// The exact teacher command, as an argv so a test can stub it and the run file can quote it.
export function astraCommand(screenshot: string, outFile: string): string[] {
  return [
    "exec",
    "-m",
    ASTRA_MODEL,
    "-c",
    `model_reasoning_effort="${ASTRA_EFFORT}"`,
    "-s",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--json",
    "-i",
    screenshot,
    "--output-schema",
    ASTRA_SCHEMA,
    "-o",
    outFile,
    "-",
  ];
}

// One answer out of the file `codex exec -o` wrote, validated against the same zod schema. Anything else,
// or an answer the schema refuses, is an error and nothing is stored from it.
export function parseAstraAnswer(output: string): WonderLabel {
  return WonderLabel.parse(JSON.parse(output.trim()));
}

export type AstraExec = (argv: string[], prompt: string, outFile: string) => { jsonl: string };

export const codexAstraExec: AstraExec = (argv, prompt) => {
  const run = spawnSync("codex", argv, {
    encoding: "utf-8",
    input: prompt,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`codex exec exited ${run.status}: ${(run.stderr ?? "").slice(0, 500)}`);
  return { jsonl: run.stdout ?? "" };
};

export type AstraRecord = WonderLabel & {
  page: string;
  teacher: string;
  model: string;
  effort: string;
  test: string | null;
  seconds: number;
  usage: Record<string, unknown> | null;
  source_lure: boolean | null;
};

export const AstraRecordSchema = z
  .strictObject({
    lure: z.boolean(),
    lure_type: z.enum(LURE_TYPES),
    capture_valid: z.boolean(),
    reasons: z.array(z.string().min(1).max(300)).max(10),
    page: z.string().min(1),
    teacher: z.literal(ASTRA_TEACHER),
    model: z.literal(ASTRA_MODEL),
    effort: z.enum(["low", "medium", "high"]),
    test: z.string().nullable().optional(),
    seconds: z.number().nonnegative(),
    usage: z.record(z.string(), z.unknown()).nullable(),
    source_lure: z.boolean().nullable(),
  })
  .refine((label) => (label.lure_type === "none") === !label.lure, {
    message: "lure_type is none exactly when lure is false",
  });

export function validateExistingAstraRecord(file: string, page: StoredPage): AstraRecord {
  const parsed = AstraRecordSchema.parse(JSON.parse(readFileSync(file, "utf-8")));
  if (parsed.page !== page.id) throw new Error(`record names page ${parsed.page}, expected ${page.id}`);
  const expectedSourceLure = page.labels.lure ?? null;
  if (parsed.source_lure !== expectedSourceLure)
    throw new Error(`record source_lure=${String(parsed.source_lure)}, expected ${String(expectedSourceLure)}`);
  return { ...parsed, test: parsed.test ?? null };
}

export function labelPageAstra(options: {
  page: StoredPage;
  screenshot: string;
  text: string;
  outDir: string;
  test?: string;
  exec?: AstraExec;
  now?: () => number;
}): AstraRecord {
  const refusal = terraRefusal(options.page, options.screenshot);
  if (refusal) throw new Error(refusal);
  mkdirSync(options.outDir, { recursive: true });
  const file = join(options.outDir, `${options.page.id}.json`);
  const claim = claimExclusiveLabelSlot(file, "an Astra");
  const now = options.now ?? Date.now;
  const nonce = `${process.pid}.${randomBytes(6).toString("hex")}`;
  const outFile = join(options.outDir, `.answer-${options.page.id}.${nonce}.json`);
  const started = now();
  try {
    const { jsonl } = (options.exec ?? codexAstraExec)(
      astraCommand(options.screenshot, outFile),
      terraPrompt(options.page, options.text),
      outFile,
    );
    const label = parseAstraAnswer(readFileSync(outFile, "utf-8"));
    const record: AstraRecord = {
      ...label,
      page: options.page.id,
      teacher: ASTRA_TEACHER,
      model: ASTRA_MODEL,
      effort: ASTRA_EFFORT,
      test: options.test ?? null,
      seconds: (now() - started) / 1000,
      usage: parseTerraUsage(jsonl),
      source_lure: options.page.labels.lure ?? null,
    };
    writeExclusiveLabelFile(file, `${JSON.stringify(record, null, 2)}\n`, nonce, "an Astra");
    return record;
  } finally {
    rmSync(outFile, { force: true });
    claim.release();
  }
}

export function runAstraCli(options: {
  args?: string[];
  store?: ReturnType<typeof openStore>;
  outDir?: string;
  exec?: AstraExec;
}): {
  exitCode: number;
  labelled: number;
  skipped: number;
  invalid: number;
  secondsTotal: number;
  pagesPerHour: number | null;
  outDir: string;
} {
  const args = options.args ?? process.argv.slice(2);
  const idsAt = args.indexOf("--ids");
  const ids = idsAt >= 0 ? (args[idsAt + 1] ?? "").split(",").filter(Boolean) : [];
  const testAt = args.indexOf("--test");
  const test = testAt >= 0 ? (args[testAt + 1] ?? null) : null;
  if (!ids.length) throw new Error("this test labels only named pages: --ids <id,id> is required");
  const store = options.store ?? openStore(storeDir());
  const outDir = options.outDir ?? join(store.dir, "raw", "astra");
  mkdirSync(outDir, { recursive: true });
  const byId = new Map(store.manifest().map((p) => [p.id, p]));
  let labelled = 0;
  let skipped = 0;
  let invalid = 0;
  const seconds: number[] = [];
  for (const id of ids) {
    const page = byId.get(id);
    if (!page) {
      invalid++;
      console.error(`${id}: not in the store manifest`);
      continue;
    }
    const existing = join(outDir, `${id}.json`);
    if (existsSync(existing)) {
      try {
        validateExistingAstraRecord(existing, page);
        skipped++;
        console.log(`${id}: already labelled, skipped`);
      } catch (error) {
        invalid++;
        console.error(`${id}: existing Astra label is invalid: ${(error as Error).message}`);
      }
      continue;
    }
    const verified = store.readVerifiedPage(id);
    if (!verified) {
      invalid++;
      console.error(`${id}: stored files do not verify`);
      continue;
    }
    try {
      const record = labelPageAstra({
        page,
        screenshot: join(store.dir, "pages", id, "screenshot.jpg"),
        text: verified.text,
        outDir,
        ...(test ? { test } : {}),
        ...(options.exec ? { exec: options.exec } : {}),
      });
      labelled++;
      seconds.push(record.seconds);
      console.log(
        `${id}: lure=${record.lure} type=${record.lure_type} valid=${record.capture_valid} ${record.seconds.toFixed(1)}s usage=${JSON.stringify(record.usage)}`,
      );
    } catch (error) {
      invalid++;
      console.error(`${id}: refused or failed: ${(error as Error).message}`);
    }
  }
  const total = seconds.reduce((sum, s) => sum + s, 0);
  const exitCode = invalid > 0 || labelled + skipped === 0 ? 1 : 0;
  return {
    exitCode,
    labelled,
    skipped,
    invalid,
    secondsTotal: total,
    pagesPerHour: total ? (labelled / total) * 3600 : null,
    outDir,
  };
}

if (import.meta.filename === process.argv[1]) {
  const summary = runAstraCli({});
  console.log(JSON.stringify(summary));
  if (summary.exitCode !== 0) process.exitCode = summary.exitCode;
}
