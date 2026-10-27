import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { benchInputs } from "../fixtures/audio/bench-inputs";

// D01 T03 §9: FFmpeg's timings on the same inputs as test/voice/bench.test.ts, for scripts/voice-bench.ts (which sets
// VOICE_BENCH). The events match ours: first output when 9,600,000 samples (or all of a shorter file) have come out,
// completion when the output is drained; a timing counts only once its output length is checked against ours.
const ROOT = join(import.meta.dirname, "../..");
const AUDIO = join(ROOT, "test/fixtures/audio");
const CHUNK = 9_600_000;

function run(file: string): Promise<{ firstMs: number | null; doneMs: number; samples: number; code: number | null }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const ffmpeg = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-i", file, "-ar", "16000", "-ac", "1"].concat([
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "-",
      ]),
    );
    let bytes = 0;
    let first: number | null = null;
    ffmpeg.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (first === null && bytes >= CHUNK * 2) first = performance.now() - started;
    });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      const doneMs = performance.now() - started;
      resolve({ firstMs: first ?? doneMs, doneMs, samples: bytes / 2, code });
    });
  });
}

describe.skipIf(!process.env.VOICE_BENCH)("FFmpeg timings", () => {
  it("times each bench input", { timeout: 600_000 }, async () => {
    const version = spawnSync("ffmpeg", ["-version"], { encoding: "utf-8" }).stdout.split("\n")[0] ?? "unknown";
    const dir = join(ROOT, "build/voice-bench");
    mkdirSync(dir, { recursive: true });
    const inputs = benchInputs(
      new Uint8Array(readFileSync(join(AUDIO, "tone.ogg"))),
      new Uint8Array(readFileSync(join(AUDIO, "tone.mp3"))),
    );
    const rows = [];
    for (const [i, input] of inputs.entries()) {
      const file = join(dir, `${i}.${input.type === "audio/mpeg" ? "mp3" : "ogg"}`);
      writeFileSync(file, input.bytes);
      const result = await run(file);
      // FFmpeg conceals damage rather than refusing it: its outcome on the damaged file is recorded, not compared.
      if (!input.refused) {
        expect(result.code, input.name).toBe(0);
        expect(
          Math.abs(result.samples - (input.samples as number)) / (input.samples as number),
          input.name,
        ).toBeLessThan(0.01);
      }
      rows.push({
        name: input.name,
        firstMs: Math.round(result.firstMs ?? result.doneMs),
        doneMs: Math.round(result.doneMs),
        refusedMs: null,
        samples: result.samples,
        exit: result.code,
      });
    }
    console.log(`VOICE_BENCH ${JSON.stringify({ decoder: version, rows })}`);
  });
});
