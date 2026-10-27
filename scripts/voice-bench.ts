// The voice decoder against FFmpeg on the same inputs (D01 T03 §9): runs test/voice/bench.test.ts (our decoder, in the
// Workers test pool) and test/node/voice-bench.test.ts (FFmpeg, which must be installed) with VOICE_BENCH set, and
// prints their timings side by side. Both tests check each output's length (and our refusal of the damaged file)
// before they report, so a failed or truncated run fails here instead of passing for a fast one.
//
//   node scripts/voice-bench.ts
import { spawnSync } from "node:child_process";

type Row = {
  name: string;
  firstMs: number | null;
  doneMs: number | null;
  refusedMs: number | null;
  samples: number | null;
};
type Report = { decoder: string; rows: Row[] };

function report(project: string, file: string): Report {
  const run = spawnSync("pnpm", ["exec", "vitest", "run", "--project", project, file, "--silent=false"], {
    encoding: "utf-8",
    env: { ...process.env, VOICE_BENCH: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = `${run.stdout}\n${run.stderr}`.split("\n").find((l) => l.startsWith("VOICE_BENCH "));
  if (run.status !== 0 || !line) {
    process.stderr.write(`${run.stdout}\n${run.stderr}`.slice(-4_000));
    throw new Error(`voice-bench: ${file} failed (exit ${run.status})`);
  }
  return JSON.parse(line.slice("VOICE_BENCH ".length)) as Report;
}

const ms = (value: number | null) => (value === null ? "-" : `${value} ms`);

if (import.meta.filename === process.argv[1]) {
  const ours = report("worker", "test/voice/bench.test.ts");
  const ffmpeg = report("node", "test/node/voice-bench.test.ts");
  console.log(`ours: ${ours.decoder}\nFFmpeg: ${ffmpeg.decoder}\n`);
  console.log("| Input | Ours: first output | Ours: done or refused | FFmpeg: first output | FFmpeg: done |");
  console.log("| ----- | ------------------ | --------------------- | -------------------- | ------------ |");
  ours.rows.forEach((row, i) => {
    const theirs = ffmpeg.rows[i] as Row;
    const done = row.refusedMs === null ? ms(row.doneMs) : `refused in ${ms(row.refusedMs)}`;
    console.log(`| ${row.name} | ${ms(row.firstMs)} | ${done} | ${ms(theirs.firstMs)} | ${ms(theirs.doneMs)} |`);
  });
}
