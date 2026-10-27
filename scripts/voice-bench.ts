// The voice decoder against FFmpeg on the same inputs (D01 T03 §9): runs test/voice/bench.test.ts (our decoder, in the
// Workers test pool) and test/node/voice-bench.test.ts (FFmpeg, which must be installed) with VOICE_BENCH set, prints
// their timings side by side and saves both reports to build/voice-bench.json (written to a temporary file, renamed
// into place and read back). Both tests check each output's length (and our refusal of the damaged files) before they
// report, so a failed or truncated run fails here instead of passing for a fast one. Every timing is the median of
// three runs on the same runner.
//
//   node scripts/voice-bench.ts
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Row = {
  name: string;
  firstMs: number | null;
  doneMs: number | null;
  refusedMs: number | null;
  samples: number | null;
};
type Report = { decoder: string; rows: Row[] };
export type BenchReport = { at: string; ours: Report; ffmpeg: Report };

// Times a process's 16-bit output: first output when `thresholdSamples` have come out on stdout (however long the
// process lingers afterwards), done when it has exited.
export function timeOutput(
  command: string,
  args: string[],
  thresholdSamples: number,
): Promise<{ firstMs: number | null; doneMs: number; samples: number; code: number | null }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args);
    let bytes = 0;
    let first: number | null = null;
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (first === null && bytes >= thresholdSamples * 2) first = performance.now() - started;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ firstMs: first, doneMs: performance.now() - started, samples: bytes / 2, code }),
    );
  });
}

// Writes the report beside its final name, renames it into place and reads it back.
export function saveReport(path: string, report: BenchReport): BenchReport {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  const back = JSON.parse(readFileSync(path, "utf-8")) as BenchReport;
  if (JSON.stringify(back) !== JSON.stringify(report)) throw new Error(`voice-bench: ${path} did not read back`);
  return back;
}

function report(project: string, file: string): Report {
  // The verbose reporter always prints a test's console output; the default one does not everywhere.
  const run = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "--project", project, file, "--silent=false", "--reporter=verbose"],
    {
      encoding: "utf-8",
      env: { ...process.env, VOICE_BENCH: "1", NO_COLOR: "1" },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  // The report's line, wherever a reporter's colour codes put it.
  const line = /VOICE_BENCH (\{.*\})/.exec(`${run.stdout}\n${run.stderr}`)?.[1];
  if (run.status !== 0 || !line) {
    process.stderr.write(`${run.stdout}\n${run.stderr}`.slice(-4_000));
    throw new Error(`voice-bench: ${file} failed (exit ${run.status})`);
  }
  return JSON.parse(line) as Report;
}

const ms = (value: number | null) => (value === null ? "-" : `${value} ms`);

if (import.meta.filename === process.argv[1]) {
  const ours = report("worker", "test/voice/bench.test.ts");
  const ffmpeg = report("node", "test/node/voice-bench.test.ts");
  const path = join(import.meta.dirname, "../build/voice-bench.json");
  saveReport(path, { at: new Date().toISOString(), ours, ffmpeg });
  console.log(`ours: ${ours.decoder}\nFFmpeg: ${ffmpeg.decoder}\nsaved: build/voice-bench.json\n`);
  console.log("| Input | Ours: first output | Ours: done or refused | FFmpeg: first output | FFmpeg: done |");
  console.log("| ----- | ------------------ | --------------------- | -------------------- | ------------ |");
  ours.rows.forEach((row, i) => {
    const theirs = ffmpeg.rows[i] as Row;
    const done = row.refusedMs === null ? ms(row.doneMs) : `refused in ${ms(row.refusedMs)}`;
    console.log(`| ${row.name} | ${ms(row.firstMs)} | ${done} | ${ms(theirs.firstMs)} | ${ms(theirs.doneMs)} |`);
  });
}
