// The replay orchestration and merging (D08 T02 section 12): injected clients, no spend.
import { describe, expect, it } from "vitest";
import { parseReplayArgs, replayableResults, runReplay } from "../../eval/replay.ts";
import { mergeReplayResults } from "../../eval/metrics.ts";
import type { ResultRow, RunRow } from "../../eval/run.ts";

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: "orig",
  commitSha: "abc",
  setVersion: "v",
  mode: "full",
  sets: ["synthetic-sa"],
  status: "incomplete",
  selected: 2,
  sampleLimit: null,
  capUsd: 5,
  startedAt: "2026-11-02T10:00:00.000Z",
  finishedAt: null,
  costUsd: 1,
  ...over,
});
const row = (sample: string, outcome: ResultRow["outcome"], over: Partial<ResultRow> = {}): ResultRow => ({
  runId: "orig",
  sample,
  caseId: null,
  outcome,
  label: "attack",
  category: "c",
  verdict: null,
  ms: 1,
  costUsd: 0.1,
  criticalFound: false,
  httpStatus: null,
  detail: null,
  ...over,
});

describe("eval replay", () => {
  it("replays only incomplete cases under a replay-scoped run and refuses an unknown or complete run", async () => {
    expect(replayableResults([row("a", "done"), row("b", "timeout")]).map((r) => r.sample)).toEqual(["b"]);
    const stored = { run: run(), results: [row("a", "done"), row("b", "timeout")] };
    const sent: string[] = [];
    const out = await runReplay("orig", {
      readRun: async () => stored,
      createRun: async () => {},
      resubmit: async (r, replayRunId) => {
        sent.push(replayRunId);
        return row(r.sample, "done", { runId: replayRunId, verdict: "malicious" });
      },
      putResult: async () => {},
      finishRun: async () => {},
      newId: () => "replay-1",
      now: () => "2026-11-02T12:00:00.000Z",
    });
    expect(out).toMatchObject({ status: "complete", replayRunId: "replay-1", replayed: 1, stillIncomplete: 0 });
    expect(sent).toEqual(["replay-1"]);
    const refused = await runReplay("nope", {
      readRun: async () => null,
      createRun: async () => {},
      resubmit: async (r) => r,
      putResult: async () => {},
      finishRun: async () => {},
      newId: () => "x",
      now: () => "t",
    });
    expect(refused.status).toBe("refused");
    expect(parseReplayArgs([])).toHaveProperty("error");
    expect(parseReplayArgs(["--run", "orig"])).toEqual({ runId: "orig" });
  });

  it("merges a complete replay over its original and counts the replaced line apart", () => {
    const original = [row("a", "timeout"), row("b", "done", { verdict: "safe" })];
    const merged = mergeReplayResults(original, [[row("a", "done", { runId: "replay-1", verdict: "malicious" })]]);
    expect(merged.results[0]?.verdict).toBe("malicious");
    expect(merged.results[1]?.verdict).toBe("safe");
    expect(merged.consentLines).toBe(1);
    const kept = mergeReplayResults(original, [[row("a", "timeout", { runId: "replay-1" })]]);
    expect(kept.results[0]?.outcome).toBe("timeout");
    expect(kept.consentLines).toBe(0);
  });
});
