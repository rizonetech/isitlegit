import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CorruptAudio, decodeToWavChunks } from "../../src/voice/decode";
import { benchInputs } from "../fixtures/audio/bench-inputs";
import { toneMp3, toneOgg, toneWav } from "../fixtures/audio/load";

// D01 T03 §9: our decoder's timings for scripts/voice-bench.ts, which sets VOICE_BENCH and prints them beside FFmpeg's.
// First output is the first chunk (10 minutes of samples, or all of a shorter file); completion is everything drained;
// a damaged file has a refusal time and no first output. A timing counts only once its length or refusal is checked.
const REPEATS = 3;
const median = (values: number[]) =>
  Math.round([...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number);
describe.skipIf(!(env as unknown as { VOICE_BENCH?: string }).VOICE_BENCH)("voice decoder timings", () => {
  it("times each bench input", { timeout: 600_000 }, async () => {
    const rows = [];
    for (const input of benchInputs(toneOgg, toneMp3, toneWav)) {
      // Each input three times; the median of each event is reported (runners vary from run to run).
      const runs = [];
      for (let repeat = 0; repeat < REPEATS; repeat++) {
        const started = performance.now();
        let first: number | null = null;
        let samples = 0;
        let refused = false;
        try {
          for await (const chunk of decodeToWavChunks(input.bytes, input.type)) {
            first ??= performance.now() - started;
            samples += (chunk.length - 44) / 2;
          }
        } catch (error) {
          if (!(error instanceof CorruptAudio)) throw error;
          refused = true;
        }
        const done = performance.now() - started;
        if (input.refused) expect(refused, input.name).toBe(true);
        else expect(samples, input.name).toBe(input.samples);
        runs.push({ first: first ?? done, done, samples, refused });
      }
      const refused = input.refused === true;
      rows.push({
        name: input.name,
        firstMs: refused ? null : median(runs.map((r) => r.first)),
        doneMs: refused ? null : median(runs.map((r) => r.done)),
        refusedMs: refused ? median(runs.map((r) => r.done)) : null,
        samples: refused ? null : (runs[0]?.samples ?? null),
      });
    }
    console.log(`VOICE_BENCH ${JSON.stringify({ decoder: "IsItLegit (Worker)", rows })}`);
  });
});
