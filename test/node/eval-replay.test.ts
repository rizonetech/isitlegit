// The replay orchestration and merging (D08 T02 section 12): injected clients, no spend.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeReplayResults } from "../../eval/metrics.ts";
import { parseReplayArgs, replayableResults, runReplay } from "../../eval/replay.ts";
import type { Api, Db, Env, ResultRow, RunRow } from "../../eval/run.ts";
import { liveApi, main, replayPopulation } from "../../eval/run.ts";
import { selectSamples } from "../../eval/run-core.ts";

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
  it("replays the whole population under a fresh replay identity and refuses an unknown run", async () => {
    expect(replayableResults([row("a", "done"), row("b", "timeout")]).map((r) => r.sample)).toEqual(["a", "b"]);
    const stored = { run: run(), results: [row("a", "done"), row("b", "timeout")] };
    const sent: string[] = [];
    const clients = {
      readRun: async () => stored,
      createRun: async () => {},
      resubmit: async (r: ResultRow, replayRunId: string) => {
        sent.push(replayRunId);
        return row(r.sample, "done", { runId: replayRunId, verdict: "malicious" });
      },
      putResult: async () => {},
      finishRun: async () => {},
      now: () => "2026-11-02T12:00:00.000Z",
    };
    const out = await runReplay("orig", { ...clients, newId: () => "replay-1" });
    expect(out).toMatchObject({ status: "complete", replayRunId: "replay-1", replayed: 2, stillIncomplete: 0 });
    expect(sent).toEqual(["replay-1", "replay-1"]);
    // A complete source run replays too, under a different fresh identity (section 12).
    const complete = { run: run({ status: "complete" }), results: [row("a", "done"), row("b", "done")] };
    const second = await runReplay("orig", { ...clients, readRun: async () => complete, newId: () => "replay-2" });
    expect(second).toMatchObject({ status: "complete", replayRunId: "replay-2", replayed: 2 });
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

  it("restores the source population whole and refuses drift before any upload (section 12)", () => {
    const root = mkdtempSync(join(tmpdir(), "eval-replay-"));
    try {
      const dir = join(root, "synthetic-sa");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "a.eml"), "attack one");
      writeFileSync(join(dir, "g.eml"), "genuine one");
      const labels = [
        { path: "a.eml", label: "attack", category: "credential-phishing", expected: [], source: "x", basis: "model" },
        { path: "g.eml", label: "genuine", category: "genuine-business", expected: [], source: "x" },
      ];
      writeFileSync(join(dir, "labels.json"), JSON.stringify(labels));
      const select = (sets: readonly string[], limit: number | null) => selectSamples(root, sets, limit);
      const first = select(["synthetic-sa"], null);
      const stored = {
        run: run({ setVersion: first.setVersion, selected: 2, status: "complete" }),
        results: [row("synthetic-sa/a.eml", "done"), row("synthetic-sa/g.eml", "done")],
      };
      // A complete source run restores whole: both samples, measured ones included.
      const restored = replayPopulation(stored, select);
      expect("error" in restored).toBe(false);
      if (!("error" in restored))
        expect(restored.samples.map((s) => s.id)).toEqual(["synthetic-sa/a.eml", "synthetic-sa/g.eml"]);
      // A re-labelled set changes the version and refuses.
      writeFileSync(
        join(dir, "labels.json"),
        JSON.stringify(labels.map((l) => (l.label === "attack" ? { ...l, category: "invoice-bank-change" } : l))),
      );
      expect(replayPopulation(stored, select)).toMatchObject({ error: expect.stringMatching(/not those of run/) });
      // A stored result the disk no longer holds refuses as a different population.
      const second = select(["synthetic-sa"], null);
      const foreign = {
        run: run({ setVersion: second.setVersion, selected: 2, status: "complete" }),
        results: [row("synthetic-sa/a.eml", "done"), row("synthetic-sa/gone.eml", "done")],
      };
      expect(replayPopulation(foreign, select)).toMatchObject({
        error: expect.stringMatching(/is not the population/),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drives the command entry: a replay through main() persists a fresh whole-population run", async () => {
    const root = mkdtempSync(join(tmpdir(), "eval-replay-main-"));
    try {
      const selection = selectSamples(join(process.cwd(), "eval/sets"), ["synthetic-sa"], 2);
      const source: RunRow = {
        ...run({ status: "complete" }),
        id: "source-run-1",
        setVersion: selection.setVersion,
        selected: 2,
        sampleLimit: 2,
        commitSha: "oldcommit",
      };
      const storedResults = selection.samples.map((s) => row(s.id, "done", { verdict: "safe" }));
      const runs = new Map<string, RunRow>([[source.id, source]]);
      const results = new Map<string, ResultRow[]>();
      const sentReplayIds: (string | null)[] = [];
      let seq = 0;
      const db: Db = {
        orgId: async () => "org-eval",
        memberships: async () => ["org-eval"],
        allowance: async () => ({ used: 0, limit: 500 }),
        spent: async () => ({ daySpentUsd: 0, totalSpentUsd: 0 }),
        lastCostPerCase: async () => 0.01,
        caseState: async (caseId) => ({
          status: "done",
          verdict: "malicious",
          costUsd: 0.01,
          critical: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...(caseId ? {} : {}),
        }),
        insertRun: async (r) => void runs.set(r.id, r),
        putResult: async (r) => void results.set(r.runId, [...(results.get(r.runId) ?? []), r]),
        finishRun: async () => {},
        readRun: async (id) => (id === source.id ? { run: source, results: storedResults } : null),
      };
      const api: Api = {
        commit: async () => "newcommit",
        whoami: async () => "user-1",
        upload: async (_sample, _bytes, opts) => {
          sentReplayIds.push(opts.replayRunId);
          return { status: 201, caseId: `fresh-${++seq}` };
        },
      };
      const env: Env = {
        now: () => Date.now(),
        sleep: async () => {},
        id: () => `replay-run-${++seq}`,
        journalDir: root,
        bytes: (file) => new Uint8Array(readFileSync(file)),
        log: () => {},
        ticker: () => () => {},
        timeout: async (_ms, work) => work(),
      };
      const code = await main(
        ["--replay", source.id, "--cap-usd", "5"],
        { EVAL_SESSION_COOKIE: "x" },
        { db, api, env },
      );
      expect(code).toBe(0);
      // Both samples of the stored population were sent, under the new run's own identity.
      expect(sentReplayIds).toHaveLength(2);
      expect(new Set(sentReplayIds).size).toBe(1);
      expect(sentReplayIds[0]).not.toBe(source.id);
      const replayRun = [...runs.values()].find((r) => r.mode === `replay:${source.id}`);
      expect(replayRun?.id).toBe(sentReplayIds[0]);
      expect(results.get(replayRun?.id ?? "")?.every((r) => r.outcome === "done")).toBe(true);
      // An unknown source refuses through the same entry, with nothing sent.
      sentReplayIds.length = 0;
      const refused = await main(
        ["--replay", "no-such-run", "--cap-usd", "5"],
        { EVAL_SESSION_COOKIE: "x" },
        { db, api, env },
      );
      expect(refused).toBe(3);
      expect(sentReplayIds).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes the replay run's own id as the replayRunId multipart field", async () => {
    const bodies: FormData[] = [];
    const fetchImpl = (async (_url: unknown, init?: { body?: FormData }) => {
      bodies.push(init?.body as FormData);
      return { status: 201, json: async () => ({ caseId: "case-1" }) };
    }) as unknown as typeof fetch;
    const api = liveApi("https://example.test", "cookie", fetchImpl);
    const sample = { id: "synthetic-sa/a.eml", path: "a.eml" } as Parameters<typeof api.upload>[0];
    const bytes = new TextEncoder().encode("attack one");
    await api.upload(sample, bytes, { mode: "replay:source-run", replayRunId: "replay-run-own-id" });
    expect(bodies[0]?.get("replayRunId")).toBe("replay-run-own-id");
    // No replay identity, no field: an ordinary upload stays an ordinary duplicate.
    await api.upload(sample, bytes, { mode: "full", replayRunId: null });
    expect(bodies[1]?.get("replayRunId")).toBeNull();
  });

  it("merges a terminal replay over its original from either state and counts replaced lines apart", () => {
    const original = [row("a", "timeout"), row("b", "done", { verdict: "safe" })];
    const merged = mergeReplayResults(original, [
      [
        row("a", "done", { runId: "replay-1", verdict: "malicious" }),
        row("b", "partial", { runId: "replay-1", verdict: "suspicious" }),
      ],
    ]);
    expect(merged.results[0]?.verdict).toBe("malicious");
    // A measured original is replaced too: the replay is the newer measurement of the same population.
    expect(merged.results[1]?.verdict).toBe("suspicious");
    expect(merged.consentLines).toBe(2);
    const kept = mergeReplayResults(original, [[row("a", "timeout", { runId: "replay-1" })]]);
    expect(kept.results[0]?.outcome).toBe("timeout");
    expect(kept.consentLines).toBe(0);
  });
});
