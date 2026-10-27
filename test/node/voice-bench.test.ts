import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveReport, timeOutput } from "../../scripts/voice-bench.ts";
import { benchInputs } from "../fixtures/audio/bench-inputs";

// D01 T03 §9: FFmpeg's timings on the same inputs as test/voice/bench.test.ts, for scripts/voice-bench.ts (which sets
// VOICE_BENCH). The events match ours: first output when 9,600,000 samples (or all of a shorter file) have come out,
// completion when the output is drained; a timing counts only once its output length is checked against ours.
const ROOT = join(import.meta.dirname, "../..");
const AUDIO = join(ROOT, "test/fixtures/audio");
const CHUNK = 9_600_000;
const REPEATS = 3;
const median = (values: number[]) =>
  Math.round([...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number);
// FFmpeg's length may differ from ours by up to 1 % (checked below), so its first output is taken at 99 % of a short file.

describe("the bench's timer and report (D01 T03 §9's completion review)", () => {
  it("takes first output when the samples arrive, however long the process lingers after", async () => {
    // 16,000 samples at once, then a second's wait before exiting.
    const timed = await timeOutput("sh", ["-c", "head -c 32000 /dev/zero; sleep 1"], 16_000);
    expect(timed.samples).toBe(16_000);
    expect(timed.firstMs).not.toBeNull();
    expect(timed.firstMs as number).toBeLessThan(500);
    expect(timed.doneMs).toBeGreaterThanOrEqual(1_000);
  });

  it("saves the report through a temporary file and reads it back", () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-bench-"));
    try {
      const path = join(dir, "voice-bench.json");
      const report = {
        at: "2026-10-28T00:00:00.000Z",
        ours: {
          decoder: "IsItLegit (Worker)",
          rows: [{ name: "x", firstMs: 1, doneMs: 2, refusedMs: null, samples: 3 }],
        },
        ffmpeg: { decoder: "ffmpeg", rows: [{ name: "x", firstMs: 4, doneMs: 5, refusedMs: null, samples: 3 }] },
      };
      expect(saveReport(path, report)).toEqual(report);
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual(report);
      expect(readdirSync(dir)).toEqual(["voice-bench.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!process.env.VOICE_BENCH)("FFmpeg timings", () => {
  it("times each bench input", { timeout: 600_000 }, async () => {
    const version = spawnSync("ffmpeg", ["-version"], { encoding: "utf-8" }).stdout.split("\n")[0] ?? "unknown";
    const dir = join(ROOT, "build/voice-bench");
    mkdirSync(dir, { recursive: true });
    const inputs = benchInputs(
      new Uint8Array(readFileSync(join(AUDIO, "tone.ogg"))),
      new Uint8Array(readFileSync(join(AUDIO, "tone.mp3"))),
      new Uint8Array(readFileSync(join(AUDIO, "tone.wav"))),
    );
    const rows = [];
    for (const [i, input] of inputs.entries()) {
      const file = join(dir, `${i}.${{ "audio/mpeg": "mp3", "audio/wav": "wav" }[input.type] ?? "ogg"}`);
      writeFileSync(file, input.bytes);
      const args = ["-hide_banner", "-loglevel", "error", "-i", file, "-ar", "16000", "-ac", "1"];
      const threshold = Math.min(CHUNK, Math.floor((input.samples ?? CHUNK) * 0.99));
      // Each input three times; the median of each event is reported (runners vary from run to run).
      const results = [];
      for (let repeat = 0; repeat < REPEATS; repeat++) {
        const result = await timeOutput("ffmpeg", [...args, "-c:a", "pcm_s16le", "-f", "s16le", "-"], threshold);
        // FFmpeg conceals damage rather than refusing it: its outcome on the damaged files is recorded, not compared.
        if (!input.refused) {
          expect(result.code, input.name).toBe(0);
          const off = Math.abs(result.samples - (input.samples as number)) / (input.samples as number);
          expect(off, input.name).toBeLessThan(0.01);
        }
        results.push(result);
      }
      const firsts = results.map((r) => r.firstMs);
      rows.push({
        name: input.name,
        firstMs: firsts.includes(null) ? null : median(firsts as number[]),
        doneMs: median(results.map((r) => r.doneMs)),
        refusedMs: null,
        samples: results[0]?.samples ?? null,
        exit: results[0]?.code ?? null,
      });
    }
    console.log(`VOICE_BENCH ${JSON.stringify({ decoder: version, rows })}`);
  });
});
