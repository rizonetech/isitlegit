import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Production document readers contain parameter properties; use Node's supported transform mode.
if (!process.execArgv.includes("--experimental-transform-types")) {
  const child = spawnSync(
    process.execPath,
    ["--experimental-transform-types", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  process.exit(child.status ?? 2);
}

register("./lib/ts-resolve.mjs", import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
function atomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
try {
  const { generateCorpus, hash } = await import("../eval/hidden-text/corpus.ts");
  const { evaluate } = await import("../eval/hidden-text/evaluate.ts");
  if (
    args.some((arg, i) => i % 2 === 0 && !["--corpus", "--out"].includes(arg)) ||
    args.length % 2 ||
    new Set(args.filter((_, i) => i % 2 === 0)).size !== args.length / 2
  )
    throw new Error("Usage: node scripts/eval-hidden-text.ts [--corpus FILE] [--out DIRECTORY]");
  const options = new Map(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
  const out = resolve(options.get("--out") ?? resolve(root, "eval/hidden-text"));
  const corpusPath = options.get("--corpus");
  const cases = corpusPath ? JSON.parse(readFileSync(corpusPath, "utf8")) : generateCorpus();
  const corpusBytes = `${JSON.stringify(cases, null, 2)}\n`;
  const result = await evaluate(cases);
  const run = {
    generatedAt: new Date().toISOString(),
    sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    sourceDirty:
      execFileSync(
        "git",
        [
          "status",
          "--porcelain",
          "--",
          "src",
          "test/fixtures/attachments",
          "scripts/lib/ts-resolve.mjs",
          "pnpm-lock.yaml",
          "package.json",
          "eval/hidden-text/corpus.ts",
          "eval/hidden-text/evaluate.ts",
          "eval/hidden-text/runtime.mjs",
          "eval/hidden-text/runtime.d.mts",
          "scripts/eval-hidden-text.ts",
        ],
        { cwd: root, encoding: "utf8" },
      ).trim().length > 0,
    corpusSha256: hash(corpusBytes),
    runtime: process.version,
    platform: `${process.platform}/${process.arch}`,
    timingBoundary:
      "Per case: subject decode or document extraction plus production PhraseStream detection; excludes generation, imports and file I/O; one ordered pass, no warmup; nearest-rank percentiles include failed attempts.",
    ...result,
  };
  atomic(resolve(out, "corpus.json"), corpusBytes);
  atomic(resolve(out, "observations.json"), `${JSON.stringify(run, null, 2)}\n`);
  const s = result.summary;
  const metric = (name: string, value: number | null, target: number) =>
    `| ${name} | ${value === null ? "null" : value.toFixed(4)} | ${target} | ${value !== null && value <= target ? "PASS" : "FAIL"} |`;
  const report = [
    "# Hidden instruction measurements",
    "",
    `Measured ${run.generatedAt}; source ${run.sourceSha}; source dirty: ${run.sourceDirty}.`,
    "",
    `Corpus SHA-256: ${run.corpusSha256}. Runtime: ${run.runtime}, ${run.platform}.`,
    "",
    run.timingBoundary,
    "",
    `${s.attacks} attacks, ${s.controls} controls; ${s.missed.length} misses, ${s.falseFlags.length} false flags, ${s.errors.length} errors. Overall: ${result.pass ? "PASS" : "FAIL"}. Exit: ${result.exitCode}.`,
    "",
    "| Metric | Measured | Maximum | Result |",
    "| --- | --- | --- | --- |",
    metric("Miss rate", s.missRate, result.targets.missRate),
    metric("False-flag rate", s.falseFlagRate, result.targets.falseFlagRate),
    metric("p50 ms", s.p50Ms, result.targets.p50Ms),
    metric("p95 ms", s.p95Ms, result.targets.p95Ms),
    "",
    "## Technique breakdown",
    "",
    "| Technique | Attacks | Controls | Misses | False flags | Errors |",
    "| --- | --- | --- | --- | --- | --- |",
    ...Object.entries(result.byTechnique).map(
      ([key, v]) =>
        `| ${key} | ${v.attacks} | ${v.controls} | ${v.missed.length} | ${v.falseFlags.length} | ${v.errors.length} |`,
    ),
    "",
    "## Language breakdown",
    "",
    "| Language | Attacks | Controls | Misses | False flags | Errors |",
    "| --- | --- | --- | --- | --- | --- |",
    ...Object.entries(result.byLanguage).map(
      ([key, v]) =>
        `| ${key} | ${v.attacks} | ${v.controls} | ${v.missed.length} | ${v.falseFlags.length} | ${v.errors.length} |`,
    ),
    "",
    `Missed IDs: ${s.missed.join(", ") || "null"}.`,
    "",
    `False-flag IDs: ${s.falseFlags.join(", ") || "null"}.`,
    "",
    `Error IDs: ${s.errors.join(", ") || "null"}.`,
    "",
    "These are correlated synthetic template variants, not independent real-world samples. Eight language labels describe business context; instructionLanguage distinguishes English payloads from translated probes. PDF rows reuse three English fixtures with different stream chunk sizes. No production verdict, model, live service or Microsoft Prompt Shields comparison was measured. See README.md for provenance and limitations; observations.json retains every finding and failed observation. Target misses require coordinator disposition, not relabelling or a production change by this lane.",
    "",
  ].join("\n");
  atomic(resolve(out, "results.md"), report);
  process.stdout.write(`${JSON.stringify({ exitCode: result.exitCode, ...s })}\n`);
  process.exitCode = result.exitCode;
} catch (error) {
  process.stderr.write(
    `Hidden-text evaluation failed: ${error instanceof Error ? error.message : "unknown failure"}\n`,
  );
  process.exitCode = 2;
}
