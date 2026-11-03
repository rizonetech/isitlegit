import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AnswerLine,
  appendLine,
  askLoupe,
  attemptLedger,
  barOf,
  datasetDir,
  type Fetch,
  lineFacts,
  type Message,
  type PageMeta,
  parseEvaluateArgs,
  proposeCauses,
  readAnswers,
  referenceDataset,
  referenceRuns,
  runAnswers,
  runDir,
  type Scored,
  type Slice,
  StopRun,
  scoreScreener,
  scoreVersion,
  sparkEvaluation,
  sparkPreflight,
  sparkRunner,
  timeBoxedBar,
} from "../../scripts/glimmer/evaluate.ts";
import {
  ESTIMATE_USD,
  GLIMMER_CAP_USD,
  LedgerLocked,
  ledgerLock,
  withLedgerLock,
} from "../../scripts/glimmer/teacher-label.ts";
import { BudgetExceeded, BudgetUnavailable } from "../../src/meta/guard.ts";
import { buildScreenRequest, buildTrainingLine, type PageAnswer } from "../../src/vision/page-screen.ts";
import { fakeJpeg } from "../fixtures/jpeg.ts";

// scripts/glimmer/evaluate.ts (D03 T04 §13): a held-out set through a screener, scored. Every call here is a fake and
// every folder a temporary one.
const NONE: PageAnswer = {
  brand: null,
  has_login_form: false,
  has_payment_form: false,
  lure: false,
  lure_type: "none",
  confidence: 0.9,
};
const lure = (lure_type: "credential" | "payment" | "fake_shop" | "impersonation"): PageAnswer => ({
  brand: "Acme",
  has_login_form: lure_type === "credential",
  has_payment_form: lure_type === "payment",
  lure: true,
  lure_type,
  confidence: 0.8,
});

type Page = { id: string; source: string; origin: string; type: string; sa: boolean };
// Six lures and four benign pages. The ids carry a marker the page text holds, so a fake can tell which page it was asked.
const PAGES: Page[] = [
  { id: "L1", source: "kit", origin: "samples", type: "credential", sa: true },
  { id: "L2", source: "kit", origin: "samples", type: "payment", sa: true },
  { id: "L3", source: "kit", origin: "public", type: "fake_shop", sa: false },
  { id: "L4", source: "kit", origin: "public", type: "credential", sa: false },
  { id: "L5", source: "kit", origin: "public", type: "impersonation", sa: true },
  { id: "L6", source: "kit", origin: "public", type: "credential", sa: false },
  { id: "B1", source: "benign-a", origin: "benign", type: "none", sa: true },
  { id: "B2", source: "benign-a", origin: "benign", type: "none", sa: false },
  { id: "B3", source: "benign-b", origin: "benign", type: "none", sa: false },
  { id: "B4", source: "benign-b", origin: "benign", type: "none", sa: true },
];
const TEXT = (id: string) => `SECRET-PAGE-TEXT-${id}-end`;

// Loupe: L1 caught with its type, L2 missed, L3 caught with its type, L4 caught as the wrong type, L5 unparsable, L6
// caught with its type; B2 is a false alarm.
const LOUPE: Record<string, string> = {
  L1: JSON.stringify(lure("credential")),
  L2: JSON.stringify(NONE),
  L3: JSON.stringify(lure("fake_shop")),
  L4: JSON.stringify(lure("payment")),
  L5: "this is not json",
  L6: JSON.stringify(lure("credential")),
  B1: JSON.stringify(NONE),
  B2: JSON.stringify(lure("credential")),
  B3: JSON.stringify(NONE),
  B4: JSON.stringify(NONE),
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "glimmer-evaluate-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeDataset(version: string, pages: Page[] = PAGES) {
  const dir = datasetDir(root, version);
  mkdirSync(dir, { recursive: true });
  const lines = pages.map((page) => {
    const request = buildScreenRequest({
      image: fakeJpeg(1280, 800, 400),
      host: "example.com",
      text: TEXT(page.id),
      mode: "image",
      nonce: createHash("sha256").update(page.id).digest("hex").slice(0, 32),
    });
    return buildTrainingLine(request, page.type === "none" ? NONE : lure(page.type as "credential"));
  });
  const evaluation = `${lines.join("\n")}\n`;
  writeFileSync(join(dir, "eval.jsonl"), evaluation);
  const metas = pages.map(
    (page): PageMeta => ({
      id: page.id,
      source: page.source,
      origin: page.origin,
      lure_type: page.type,
      brand: null,
      south_africa: page.sa,
      screenshot: "0".repeat(64),
    }),
  );
  writeFileSync(join(dir, "eval.meta.jsonl"), `${metas.map((m) => JSON.stringify(m)).join("\n")}\n`);
  const sha = createHash("sha256").update(evaluation).digest("hex");
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ sha256: { evaluation: sha } }));
  return { dir, sha, metas };
}

const pageOf = (init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as { messages: Message[] };
  return /SECRET-PAGE-TEXT-(\w+?)-end/.exec(JSON.stringify(body.messages))?.[1] as string;
};
const okResponse = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), { status: 200 });
const fakeFireworks = (answers: Record<string, string>) => {
  const bodies: { model: string; temperature: number; messages: Message[] }[] = [];
  const fetcher: Fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)));
    return okResponse(answers[pageOf(init)] ?? "");
  };
  return { fetcher, bodies };
};

async function runLoupe(version: string, answers: Record<string, string>, extra: Parameters<typeof askLoupe>[2] = {}) {
  const { fetcher, bodies } = fakeFireworks(answers);
  const result = await runAnswers({
    dataset: datasetDir(root, version),
    runs: runDir(root, version),
    screener: "loupe",
    ask: askLoupe("test-key", "accounts/x/models/m", { fetcher, ...extra }),
    model: "accounts/x/models/m#accounts/x/deployments/d",
  });
  return { result, bodies };
}

const sparkAnswers =
  (answers: Record<string, string>) =>
  async (
    input: unknown[],
    _instructions: string,
    attempts: { reserve(a: number, e: number): string; settle(id: string, usd: number): void },
  ) => {
    const id = attempts.reserve(1, ESTIMATE_USD);
    const text = JSON.stringify(input);
    const page = /SECRET-PAGE-TEXT-(\w+?)-end/.exec(text)?.[1] as string;
    attempts.settle(id, 0.002);
    return { text: answers[page] ?? "", usd: 0.002 };
  };

describe("scoring", () => {
  it("scores Loupe on a hand-computed set, slice by slice", async () => {
    const { sha } = writeDataset("1.0");
    const { result } = await runLoupe("1.0", LOUPE);
    expect(result).toMatchObject({ pages: 10, asked: 10, answered: 9, errors: 1, skipped: 0 });
    const metrics = scoreVersion(root, "1.0", () => new Date("2026-10-31T10:00:00Z"));
    expect(metrics).toMatchObject({
      version: "1.0",
      eval_sha256: sha,
      measured: "2026-10-31T10:00:00.000Z",
      misses_by_cause: null,
      spark: null,
      bar: null,
    });
    expect(metrics.overall).toMatchObject({
      pages: 10,
      lures: 6,
      benign: 4,
      answered: 9,
      unanswered: 1,
      accuracy: 0.7,
      lure_recall: 4 / 6,
      false_alarm_rate: 0.25,
      lure_type_accuracy: 0.5,
      missed: ["L2", "L5"],
      false_alarms: ["B2"],
    });
    expect(metrics.south_africa).toMatchObject({
      pages: 5,
      lures: 3,
      benign: 2,
      unanswered: 1,
      lure_recall: 1 / 3,
      false_alarm_rate: 0,
      missed: ["L2", "L5"],
    });
    expect(Object.keys(metrics.by_lure_type)).toEqual(["credential", "fake_shop", "impersonation", "payment"]);
    expect(metrics.by_lure_type.credential).toMatchObject({
      pages: 3,
      lures: 3,
      lure_recall: 1,
      lure_type_accuracy: 2 / 3,
    });
    expect(metrics.by_lure_type.impersonation).toMatchObject({
      lures: 1,
      lure_recall: 0,
      unanswered: 1,
      missed: ["L5"],
    });
    expect(metrics.by_lure_type.payment).toMatchObject({ lures: 1, lure_recall: 0, missed: ["L2"] });
    expect(metrics.by_benign_source["benign-a"]).toMatchObject({
      pages: 2,
      benign: 2,
      lures: 0,
      false_alarm_rate: 0.5,
      false_alarms: ["B2"],
      lure_recall: null,
    });
    expect(metrics.by_benign_source["benign-b"]).toMatchObject({ benign: 2, false_alarm_rate: 0 });
    expect(metrics.samples).toMatchObject({ pages: 2, lures: 2, lure_recall: 0.5, missed: ["L2"] });
    expect(metrics.overall.latency_median_ms).toBeGreaterThanOrEqual(0);
    // Loupe's deployment is billed by GPU time: its cost per page is not known, so it is null, never 0.
    expect(metrics.overall.cost_per_page_usd).toBeNull();
    // One page has no valid answer, so the run is not complete.
    expect(metrics.overall.complete).toBe(false);
  });

  it("counts an unparsable answer as an error for its page and as unanswered", async () => {
    writeDataset("1.0");
    await runLoupe("1.0", LOUPE);
    const lines = readAnswers(join(runDir(root, "1.0"), "loupe.answers.jsonl"));
    expect(lines.get("L5")).toMatchObject({ answer: null, error: "the reply was not a valid PageAnswer" });
    expect(lines.get("L1")).toMatchObject({ error: null });
    const metrics = scoreVersion(root, "1.0");
    expect(metrics.overall.unanswered).toBe(1);
    expect(metrics.overall.missed).toContain("L5");
  });

  it("refuses an answer that names a field the contract does not hold", async () => {
    writeDataset("1.0");
    await runLoupe("1.0", { ...LOUPE, L1: JSON.stringify({ ...lure("credential"), screener: "glimmer" }) });
    expect(readAnswers(join(runDir(root, "1.0"), "loupe.answers.jsonl")).get("L1")?.answer).toBeNull();
  });

  // The bar 1.0 is judged on (operator, 2026-10-31 18:46 SAST): recall at least Spark's, false alarms at most 6 percent.
  it("passes the time-boxed bar on recall at least Spark's and false alarms at most 6 percent, judging a slice only with enough pages", () => {
    const slice = (recall: number, alarms: number, lures = 100, benign = 100) =>
      ({ lure_recall: recall, false_alarm_rate: alarms, lures, benign }) as unknown as Slice;
    const scored = (overall: Slice, sa: Slice) => ({ overall, south_africa: sa }) as unknown as Scored;
    const spark = scored(slice(0.9, 0.0), slice(0.9, 0.0));
    // Equal recall passes; Spark's lower false alarms do not count against Loupe.
    expect(timeBoxedBar(scored(slice(0.9, 0.06), slice(0.95, 0.05)), spark)?.result).toBe("passed");
    expect(timeBoxedBar(scored(slice(0.9, 0.0601), slice(0.95, 0.05)), spark)?.result).toBe("failed");
    expect(timeBoxedBar(scored(slice(0.89, 0.01), slice(0.95, 0.05)), spark)?.result).toBe("failed");
    // A South African slice under 30 lures or benign pages is not judged, and its n is reported.
    const small = timeBoxedBar(scored(slice(0.95, 0.03), slice(0, 0, 2, 2)), spark);
    expect(small?.result).toBe("passed");
    expect(small?.south_africa).toMatchObject({ judged: false, passed: null, lures: 2, benign: 2 });
    // Judged where it has enough pages: a South African failure fails the bar.
    expect(timeBoxedBar(scored(slice(0.95, 0.03), slice(0.8, 0.03)), spark)?.result).toBe("failed");
    // The earlier Spark-relative reading of the same figures fails on false alarms.
    expect(barOf(scored(slice(0.95, 0.03), slice(0.95, 0.03)), spark)?.result).toBe("failed");
  });

  it("passes the bar only when recall is higher and false alarms no higher, overall and in South Africa", () => {
    const { metas } = writeDataset("1.0");
    const answers = (given: Record<string, PageAnswer | null>) =>
      new Map<string, AnswerLine>(
        metas.map((m) => [m.id, { id: m.id, answer: given[m.id] ?? null, error: null, latency_ms: 1, cost_usd: 0 }]),
      );
    const perfect = Object.fromEntries(
      PAGES.map((p) => [p.id, p.type === "none" ? NONE : lure(p.type as "credential")]),
    );
    const loupe = scoreScreener(metas, answers(perfect));
    const weak = { ...perfect, L2: NONE, L5: NONE, B2: lure("credential") };
    expect(barOf(loupe, null)).toBeNull();
    expect(barOf(loupe, scoreScreener(metas, answers(weak)))?.result).toBe("passed");
    // Equal recall is not higher.
    expect(barOf(loupe, scoreScreener(metas, answers(perfect)))?.result).toBe("failed");
    // Higher recall on the whole set but a worse false-alarm rate fails.
    const alarmingLoupe = scoreScreener(metas, answers({ ...perfect, B3: lure("credential") }));
    expect(barOf(alarmingLoupe, scoreScreener(metas, answers({ ...weak, B2: NONE })))?.result).toBe("failed");
    // Better overall but not on the South African slice (L1, L2, L5, B1, B4): Spark catches every South African lure.
    const spark = { ...perfect, L3: NONE, L4: NONE, L6: NONE };
    const mixed = scoreScreener(metas, answers({ ...perfect, L1: NONE }));
    const bar = barOf(mixed, scoreScreener(metas, answers(spark)));
    expect(bar?.overall.passed).toBe(true);
    expect(bar?.south_africa.passed).toBe(false);
    expect(bar?.result).toBe("failed");
  });
});

describe("asking", () => {
  it("sends the system and user turns only, at temperature 0, never the true answer", async () => {
    writeDataset("1.0");
    const { bodies } = await runLoupe("1.0", LOUPE);
    expect(bodies).toHaveLength(10);
    for (const body of bodies) {
      expect(body.temperature).toBe(0);
      expect(body.messages.map((m) => m.role)).toEqual(["system", "user"]);
    }
  });

  it("retries a 503 while the deployment scales up, with growing waits, then answers", async () => {
    writeDataset("1.0", PAGES.slice(0, 1));
    let calls = 0;
    const sleeps: number[] = [];
    const fetcher: Fetch = async () =>
      ++calls <= 2
        ? new Response('{"error":{"code":"DEPLOYMENT_SCALING_UP"}}', { status: 503 })
        : okResponse(LOUPE.L1 as string);
    const result = await runAnswers({
      dataset: datasetDir(root, "1.0"),
      runs: runDir(root, "1.0"),
      screener: "loupe",
      ask: askLoupe("k", "m", { fetcher, sleep: async (ms) => void sleeps.push(ms) }),
    });
    expect(result).toMatchObject({ answered: 1, errors: 0 });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([2000, 4000]);
  });

  it("gives up after a bounded wait and records the page as an error, and does not retry another 503", async () => {
    writeDataset("1.0", PAGES.slice(0, 2));
    const sleeps: number[] = [];
    let other = 0;
    const fetcher: Fetch = async (_url, init) => {
      if (pageOf(init) === "L2") {
        other++;
        return new Response("boom", { status: 503 });
      }
      return new Response("busy", { status: 429 });
    };
    const result = await runAnswers({
      dataset: datasetDir(root, "1.0"),
      runs: runDir(root, "1.0"),
      screener: "loupe",
      ask: askLoupe("k", "m", { fetcher, sleep: async (ms) => void sleeps.push(ms), maxWaitMs: 7000 }),
    });
    expect(result).toMatchObject({ answered: 0, errors: 2 });
    expect(sleeps).toEqual([2000, 4000]);
    expect(other).toBe(1);
    const lines = readAnswers(join(runDir(root, "1.0"), "loupe.answers.jsonl"));
    expect(lines.get("L1")?.error).toMatch(/429/);
    expect(lines.get("L2")?.error).toMatch(/503/);
    expect(lines.get("L1")?.answer).toBeNull();
  });

  it("resumes: a rerun asks only the pages not yet recorded, and retries errors only on request", async () => {
    writeDataset("1.0");
    const asked: string[] = [];
    const ask = (stopAt: string | null) => async (_messages: Message[], id: string) => {
      if (id === stopAt) throw new StopRun("killed");
      asked.push(id);
      return { text: LOUPE[id] as string, usd: 0 };
    };
    const options = { dataset: datasetDir(root, "1.0"), runs: runDir(root, "1.0"), screener: "loupe" as const };
    const first = await runAnswers({ ...options, ask: ask("B1") });
    expect(first.stopped).toBe("killed");
    expect(asked).toEqual(["L1", "L2", "L3", "L4", "L5", "L6"]);
    asked.length = 0;
    const second = await runAnswers({ ...options, ask: ask(null) });
    expect(asked).toEqual(["B1", "B2", "B3", "B4"]);
    expect(second).toMatchObject({ skipped: 6, asked: 4 });
    asked.length = 0;
    await runAnswers({ ...options, ask: ask(null) });
    expect(asked).toEqual([]);
    await runAnswers({ ...options, ask: ask(null), retryErrors: true });
    expect(asked).toEqual(["L5"]);
  });

  it("refuses an evaluation file that is not the one summary.json names", async () => {
    const { dir } = writeDataset("1.0");
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ sha256: { evaluation: "f".repeat(64) } }));
    await expect(runLoupe("1.0", LOUPE)).rejects.toThrow(/not the file summary.json names/);
  });
});

describe("Spark", () => {
  const ledgerFile = () => join(root, "ledgers", "meta-spend.json");
  const ask = (answers: Record<string, string>, maxUsd = 10) =>
    sparkRunner({
      ask: sparkAnswers(answers),
      ledgerFile: ledgerFile(),
      run: "glimmer-eval-spark-1.0-1",
      model: "muse-spark-1.3",
      maxUsd,
      now: () => new Date("2026-10-31T10:00:00Z"),
    });
  const options = () => ({ dataset: datasetDir(root, "1.0"), runs: runDir(root, "1.0"), screener: "spark" as const });

  it("reserves every call in the ledger before it is sent and settles it", async () => {
    writeDataset("1.0");
    const result = await runAnswers({ ...options(), ask: ask(LOUPE) });
    expect(result).toMatchObject({ asked: 10, answered: 9, errors: 1 });
    const ledger = JSON.parse(readFileSync(ledgerFile(), "utf-8")) as {
      run: string;
      state: string;
      cost: number;
      call: string;
    }[];
    expect(ledger).toHaveLength(10);
    expect(ledger.every((e) => e.run === "glimmer-eval-spark-1.0-1" && e.state === "settled" && e.cost === 0.002)).toBe(
      true,
    );
    expect(ledger[0]?.call).toBe("muse-spark-1.3 L1");
    const lines = readAnswers(join(runDir(root, "1.0"), "spark.answers.jsonl"));
    expect(lines.get("L1")?.cost_usd).toBe(0.002);
  });

  // Coordinator, 2026-10-31: a run that held the shared ledger's lock from start to end stopped the eval lane's spend.
  it("locks the shared ledger per change only, so another process reserves while a run is in progress", async () => {
    writeDataset("1.0");
    const lock = ledgerLock(ledgerFile());
    // Another lane's reservation, from its own process, with the lock taken exclusively as `takeLock` takes it.
    const otherLane = `
      const fs = require("node:fs");
      const [ledger, lock] = process.argv.slice(1);
      const fd = fs.openSync(lock, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      const entries = fs.existsSync(ledger) ? JSON.parse(fs.readFileSync(ledger, "utf-8")) : [];
      entries.push({ date: "2026-10-31", run: "eval-lane", call: "other", estimate: 0.01, cost: null, state: "reserved" });
      fs.writeFileSync(ledger + ".other.tmp", JSON.stringify(entries));
      fs.renameSync(ledger + ".other.tmp", ledger);
      fs.unlinkSync(lock);`;
    let between = 0;
    const inner = sparkAnswers(LOUPE);
    const result = await sparkEvaluation({
      dataset: datasetDir(root, "1.0"),
      runs: runDir(root, "1.0"),
      version: "1.0",
      ledgerFile: ledgerFile(),
      ask: async (input, instructions, attempts) =>
        inner(input, instructions, {
          reserve: (a, e) => {
            const id = attempts.reserve(a, e);
            // Between this page's reserve and its settle: the lock is free and another process's reserve lands.
            if (between++ === 0) execFileSync(process.execPath, ["-e", otherLane, ledgerFile(), lock]);
            return id;
          },
          settle: (id, usd) => attempts.settle(id, usd),
        }),
      maxUsd: 10,
      now: () => new Date("2026-10-31T10:00:00Z"),
    });
    expect(result).toMatchObject({ asked: 10, answered: 9, errors: 1 });
    const ledger = JSON.parse(readFileSync(ledgerFile(), "utf-8")) as { run: string; state: string }[];
    // The other lane's entry survives every later change this run made, and this run's ten are all settled.
    expect(ledger.filter((e) => e.run === "eval-lane")).toHaveLength(1);
    expect(ledger.filter((e) => e.run.startsWith("glimmer-eval-") && e.state === "settled")).toHaveLength(10);
    // The run's own lock is beside its answers and is gone when it ends.
    expect(existsSync(join(runDir(root, "1.0"), "spark.lock"))).toBe(false);
    expect(existsSync(lock)).toBe(false);
  });

  it("waits for a lock another process holds, then takes it, or refuses after the wait", () => {
    const file = ledgerFile();
    mkdirSync(join(root, "ledgers"), { recursive: true });
    // A live process that is not this one holds the lock: the parent of this test process.
    writeFileSync(ledgerLock(file), String(process.ppid));
    let pauses = 0;
    expect(() =>
      withLedgerLock(
        file,
        () => "changed",
        2_000,
        () => pauses++,
      ),
    ).toThrow(LedgerLocked);
    expect(pauses).toBe(4);
    // Freed during the wait: taken on the next try, and released after the change.
    pauses = 0;
    const freed = () => {
      if (++pauses === 2) rmSync(ledgerLock(file));
    };
    expect(withLedgerLock(file, () => "changed", 2_000, freed)).toBe("changed");
    expect(pauses).toBe(2);
    expect(existsSync(ledgerLock(file))).toBe(false);
  });

  it("stops before sending when the ledger stays locked by another process", async () => {
    writeDataset("1.0");
    mkdirSync(join(root, "ledgers"), { recursive: true });
    writeFileSync(ledgerLock(ledgerFile()), String(process.ppid));
    const run = attemptLedger({
      ledgerFile: ledgerFile(),
      run: "glimmer-eval-spark-1.0-1",
      model: "muse-spark-1.3",
      pageId: "L1",
      maxUsd: 10,
      now: () => new Date("2026-10-31T10:00:00Z"),
      record: { reason: null },
      waitMs: 0,
    });
    expect(() => run.reserve(1, ESTIMATE_USD)).toThrow(BudgetUnavailable);
    expect(existsSync(ledgerFile())).toBe(false);
  });

  it("stops without recording the page when the next attempt would pass --max-usd", async () => {
    writeDataset("1.0");
    const result = await runAnswers({ ...options(), ask: ask(LOUPE, ESTIMATE_USD + 0.001) });
    expect(result.stopped).toMatch(/past US\$/);
    expect(result.asked).toBe(1);
    expect(readAnswers(join(runDir(root, "1.0"), "spark.answers.jsonl")).has("L2")).toBe(false);
  });

  // §13 round 1: a resumed run counts the evaluation's earlier runs against --max-usd, as its preflight does.
  it("refuses an attempt that would take the evaluation's whole spend past --max-usd, earlier runs included", () => {
    mkdirSync(join(root, "ledgers"), { recursive: true });
    writeFileSync(
      ledgerFile(),
      JSON.stringify([
        {
          date: "2026-10-31",
          run: "glimmer-eval-spark-1.0-100",
          call: "x",
          estimate: 0.8,
          cost: 0.8,
          state: "settled",
        },
      ]),
    );
    const resumed = (scope?: string) =>
      attemptLedger({
        ledgerFile: ledgerFile(),
        run: "glimmer-eval-spark-1.0-200",
        model: "muse-spark-1.3",
        pageId: "L1",
        maxUsd: 1,
        now: () => new Date("2026-10-31T10:00:00Z"),
        record: { reason: null },
        ...(scope ? { scope } : {}),
      });
    expect(() => resumed("glimmer-eval-spark-1.0-").reserve(1, 0.3)).toThrow(BudgetExceeded);
    // This run alone (no scope) is under its cap: the old check let the evaluation pass it.
    expect(() => resumed().reserve(1, 0.3)).not.toThrow();
  });

  it("refuses to start when the ledger says the run would pass --max-usd or Glimmer's cap", async () => {
    writeDataset("1.0");
    const refused = await runAnswers({
      ...options(),
      ask: ask(LOUPE),
      preflight: sparkPreflight([], "1.0", ESTIMATE_USD * 3),
    });
    expect(refused.stopped).toMatch(/refused: 10 pages .* past --max-usd/);
    expect(refused.asked).toBe(0);
    const capped = sparkPreflight(
      [
        {
          date: "2026-10-31",
          run: "glimmer-teacher-1",
          call: "x",
          estimate: GLIMMER_CAP_USD - 0.001,
          cost: null,
          state: "reserved",
        },
      ],
      "1.0",
      1_000,
    );
    expect(capped(1)).toMatch(`Glimmer's Spark spend past US$${GLIMMER_CAP_USD}`);
    expect(sparkPreflight([], "1.0", 1_000)(10)).toBeNull();
  });

  it("projects a first run at the teacher's measured cost a page, not the worst case, when the teacher has settled calls", () => {
    const teacher = Array.from({ length: 4 }, (_, n) => ({
      date: "2026-10-30",
      run: `glimmer-teacher-${n}`,
      call: "x",
      estimate: ESTIMATE_USD,
      cost: 0.008,
      state: "settled" as const,
    }));
    // 1,000 pages at the teacher's US$0.008 is about US$8, inside US$10; at the worst case it would not be.
    expect(sparkPreflight(teacher, "1.0", 10)(1_000)).toBeNull();
    expect(sparkPreflight([], "1.0", 10)(1_000)).toMatch(/past --max-usd 10/);
    // A reserved teacher call has no measured cost and does not count as one.
    const reserved = teacher.map((e) => ({ ...e, cost: null, state: "reserved" as const }));
    expect(sparkPreflight(reserved, "1.0", 10)(1_000)).toMatch(/past --max-usd 10/);
  });
});

describe("metrics.json", () => {
  it("holds the keys version-gate.py reads, and version-gate.py promotes on them", () => {
    for (const [version, trained] of [
      ["1.0", 100],
      ["1.1", 200],
    ] as const) {
      writeDataset(version);
      const runs = runDir(root, version);
      mkdirSync(join(root, "runs", `loupe-${version}`), { recursive: true });
      writeFileSync(join(root, "runs", `loupe-${version}`, "run.json"), JSON.stringify({ lines_trained: trained }));
      mkdirSync(runs, { recursive: true });
      const lines = PAGES.map((p) => ({
        id: p.id,
        answer: p.type === "none" || (version === "1.0" && p.id === "L2") ? NONE : lure(p.type as "credential"),
        error: null,
        latency_ms: 5,
        cost_usd: 0,
      }));
      writeFileSync(join(runs, "loupe.answers.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
      writeFileSync(
        join(runs, "spark.answers.jsonl"),
        `${lines.map((l) => JSON.stringify({ ...l, answer: NONE })).join("\n")}\n`,
      );
      scoreVersion(root, version);
    }
    const metrics = JSON.parse(readFileSync(join(runDir(root, "1.1"), "metrics.json"), "utf-8"));
    for (const slice of ["overall", "south_africa"]) {
      expect(typeof metrics[slice].lure_recall).toBe("number");
      expect(typeof metrics[slice].false_alarm_rate).toBe("number");
    }
    expect(Object.keys(metrics)).toEqual(
      expect.arrayContaining([
        "version",
        "eval_sha256",
        "measured",
        "overall",
        "south_africa",
        "by_lure_type",
        "by_benign_source",
        "samples",
        "spark",
        "bar",
        "misses_by_cause",
      ]),
    );
    expect(metrics.bar.result).toBe("passed");
    expect(metrics.spark.overall.lure_recall).toBe(0);
    const out = execFileSync("python3", ["scripts/glimmer/version-gate.py", "1.1", "1.0"], {
      env: { ...process.env, GLIMMER_DATA_DIR: root },
      encoding: "utf-8",
    });
    expect(out).toContain("1.1 (new) overall:");
    expect(out).toContain("1.0 (previous) overall:");
    expect(out.trim().split("\n").at(-1)).toBe("promote");
  });

  it("draws no bar while Spark has pages not yet asked, so a run in progress is not scored as Spark's misses", async () => {
    writeDataset("1.0");
    await runLoupe("1.0", LOUPE);
    const runs = runDir(root, "1.0");
    const asked = PAGES.slice(0, 2).map((p) => ({ id: p.id, answer: NONE, error: null, latency_ms: 5, cost_usd: 0 }));
    writeFileSync(join(runs, "spark.answers.jsonl"), `${asked.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const partial = scoreVersion(root, "1.0");
    expect(partial.spark_pending).toBe(PAGES.length - 2);
    expect(partial.bar).toBeNull();
    expect(partial.bar_withheld).toBe(`Spark has ${PAGES.length - 2} pages not yet asked`);
    // §13 plan review gap 3: an error line is a page without an answer, so it withholds the bar too, with its reason.
    const all = PAGES.map((p, n) => ({
      id: p.id,
      answer: n === 0 ? null : NONE,
      error: n === 0 ? "the request failed" : null,
      latency_ms: 5,
      cost_usd: 0,
    }));
    writeFileSync(join(runs, "spark.answers.jsonl"), `${all.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const errored = scoreVersion(root, "1.0");
    expect(errored.spark_pending).toBe(0);
    expect(errored.bar).toBeNull();
    expect(errored.bar_withheld).toMatch(/^Spark has 1 pages without a valid answer/);
    // Spark complete, Loupe still with its one unparsable page: withheld for Loupe.
    const answered = PAGES.map((p) => ({ id: p.id, answer: NONE, error: null, latency_ms: 5, cost_usd: 0.001 }));
    writeFileSync(join(runs, "spark.answers.jsonl"), `${answered.map((l) => JSON.stringify(l)).join("\n")}\n`);
    expect(scoreVersion(root, "1.0").bar_withheld).toMatch(/^Loupe has 1 pages without a valid answer/);
    // Both complete: the bar is drawn.
    const loupeAll = PAGES.map((p) => ({ id: p.id, answer: NONE, error: null, latency_ms: 5, cost_usd: null }));
    writeFileSync(join(runs, "loupe.answers.jsonl"), `${loupeAll.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const whole = scoreVersion(root, "1.0");
    expect(whole.bar_withheld).toBeNull();
    expect(whole.bar?.result).toMatch(/passed|failed/);
  });

  // §13 plan review gap 6: each miss and false alarm gets the causes the training records propose.
  it("proposes each miss's causes from the training records, and keeps a confirmation across a rerun", async () => {
    writeDataset("1.0");
    await runLoupe("1.0", LOUPE);
    const dataset = datasetDir(root, "1.0");
    // Training: credential and fake shop lures and benign pages; one brand known; payment lines rare.
    const train = [
      ...Array.from({ length: 50 }, () => ({ lure_type: "credential", brand_identity: "acme" })),
      ...Array.from({ length: 49 }, () => ({ lure_type: "none", brand_identity: null })),
      { lure_type: "payment", brand_identity: null },
    ];
    writeFileSync(join(dataset, "train.meta.jsonl"), `${train.map((m) => JSON.stringify(m)).join("\n")}\n`);
    const record = proposeCauses(root, "1.0");
    // Loupe missed L2 (payment) and L5 (unparsable) and falsely alarmed on B2.
    expect(record.pages.map((p) => [p.id, p.kind])).toEqual([
      ["L2", "missed"],
      ["L5", "missed"],
      ["B2", "false alarm"],
    ]);
    expect(record.pages.find((p) => p.id === "L2")?.proposed).toEqual(["lure type underrepresented"]);
    expect(record.pages.find((p) => p.id === "L5")?.proposed).toEqual(["lure type underrepresented"]);
    expect(record.pages.find((p) => p.id === "B2")?.proposed).toEqual(["wrong label?"]);
    expect(record.unconfirmed).toBe(3);
    // Claude confirms one; a rerun keeps it.
    const file = join(runDir(root, "1.0"), "loupe.causes.json");
    const saved = JSON.parse(readFileSync(file, "utf-8"));
    saved.pages[0].confirmed = "lure type underrepresented";
    saved.confirmed_by = "Claude, from each page's text";
    writeFileSync(file, JSON.stringify(saved));
    const again = proposeCauses(root, "1.0");
    expect(again.pages[0]?.confirmed).toBe("lure type underrepresented");
    expect(again).toMatchObject({
      unconfirmed: 2,
      confirmed: { "lure type underrepresented": 1 },
      confirmed_by: "Claude, from each page's text",
    });
    // Each cause's share over every evaluation page is recorded: three of ten pages are lures of a rare type.
    expect(again.base_rates).toEqual({ "lure type underrepresented": 0.3 });
    // A cause every page shares tells no miss from a hit, so it is not proposed: every page's brand absent from training.
    const metaFile = join(dataset, "eval.meta.jsonl");
    const metas = readFileSync(metaFile, "utf-8")
      .trim()
      .split("\n")
      .map((l) => ({ ...JSON.parse(l), brand: "Nowhere" }));
    writeFileSync(metaFile, `${metas.map((m) => JSON.stringify(m)).join("\n")}\n`);
    const common = proposeCauses(root, "1.0");
    expect(common.base_rates["brand absent from training"]).toBe(1);
    expect(common.pages.every((p) => !p.proposed.includes("brand absent from training"))).toBe(true);
    // A line's own facts: its text's length and its screenshot's height.
    const line = readFileSync(join(dataset, "eval.jsonl"), "utf-8").split("\n")[0] as string;
    expect(lineFacts(line)).toEqual({ textCharacters: "SECRET-PAGE-TEXT-L1-end".length, screenshotHeight: 800 });
  });

  // §13 (from §8's plan review finding 2): the South African figures with their denominators, and no metrics without a
  // sample-derived lure.
  it("reports each South African figure with its denominators and lure types, and refuses an evaluation with no sample lure", async () => {
    writeDataset("1.0");
    await runLoupe("1.0", LOUPE);
    const metrics = scoreVersion(root, "1.0");
    expect(metrics.south_africa).toMatchObject({ pages: 5, lures: 3, benign: 2 });
    expect(metrics.samples).toMatchObject({ lures: 2, pages: 2 });
    expect(metrics.south_africa_lure_types).toEqual({ credential: 1, payment: 1, impersonation: 1 });
    // The same pages with no sample origin: no sample-derived lure, so no metrics.
    rmSync(datasetDir(root, "1.0"), { recursive: true, force: true });
    rmSync(runDir(root, "1.0"), { recursive: true, force: true });
    writeDataset(
      "1.0",
      PAGES.map((page) => ({ ...page, origin: page.origin === "samples" ? "public" : page.origin })),
    );
    await runLoupe("1.0", LOUPE);
    expect(() => scoreVersion(root, "1.0")).toThrow(/no sample-derived lure/);
    expect(existsSync(join(runDir(root, "1.0"), "metrics.json"))).toBe(false);
  });

  // §13: the independent reference set is scored beside the teacher-agreed one, with its own bar.
  it("scores the reference set beside the evaluation set, each with its own answers and bar", async () => {
    writeDataset("1.0");
    await runLoupe("1.0", LOUPE);
    const main = datasetDir(root, "1.0");
    const reference = referenceDataset(root, "1.0");
    mkdirSync(reference, { recursive: true });
    for (const name of ["eval.jsonl", "eval.meta.jsonl", "summary.json"])
      writeFileSync(join(reference, name), readFileSync(join(main, name)));
    expect(scoreVersion(root, "1.0").reference).toBeNull(); // no reference answers yet
    const answered = PAGES.map((p) => ({
      id: p.id,
      answer: p.type === "none" ? NONE : lure(p.type as "credential"),
      error: null,
      latency_ms: 5,
      cost_usd: null,
    }));
    const runs = referenceRuns(root, "1.0");
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, "loupe.answers.jsonl"), `${answered.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const spark = PAGES.map((p) => ({ id: p.id, answer: NONE, error: null, latency_ms: 5, cost_usd: 0.001 }));
    writeFileSync(join(runs, "spark.answers.jsonl"), `${spark.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const metrics = scoreVersion(root, "1.0");
    expect(metrics.reference?.loupe.overall).toMatchObject({ complete: true, lure_recall: 1, false_alarm_rate: 0 });
    expect(metrics.reference?.spark?.overall.lure_recall).toBe(0);
    expect(metrics.reference?.bar?.result).toBe("passed");
    // The main set's bar stays its own: Loupe has an unparsable page there.
    expect(metrics.bar_withheld).toMatch(/^Spark has not been run/);
    expect(parseEvaluateArgs(["spark", "1.0", "--set", "reference"]).set).toBe("reference");
    expect(() => parseEvaluateArgs(["score", "1.0", "--set", "reference"])).toThrow(/score reports both sets/);
    // §13 completion review gap 6: the reference set's errors get causes too, from its own pages and answers against
    // the version's training records, into its own record.
    expect(parseEvaluateArgs(["causes", "1.0", "--set", "reference"]).set).toBe("reference");
    writeFileSync(
      join(main, "train.meta.jsonl"),
      `${[
        { lure_type: "credential", brand_identity: "acme" },
        { lure_type: "none", brand_identity: null },
      ]
        .map((m) => JSON.stringify(m))
        .join("\n")}\n`,
    );
    const wrong = PAGES.map((p) => ({
      id: p.id,
      answer: p.type === "none" ? lure("credential") : NONE,
      error: null,
      latency_ms: 5,
      cost_usd: null,
    }));
    writeFileSync(join(runs, "loupe.answers.jsonl"), `${wrong.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const reference_causes = proposeCauses(root, "1.0", "loupe", "reference");
    expect(reference_causes.pages).toHaveLength(PAGES.length);
    expect(existsSync(join(runs, "loupe.causes.json"))).toBe(true);
    expect(existsSync(join(runDir(root, "1.0"), "loupe.causes.json"))).toBe(false);
  });

  // §13 plan review gap 2: a held-out run stops between pages at its time budget and records when it asked.
  it("stops between pages at its minutes, with the reason, and records its first and last request", async () => {
    writeDataset("1.0");
    let clock = 0;
    let wall = Date.parse("2026-10-31T16:00:00Z");
    const result = await runAnswers({
      dataset: datasetDir(root, "1.0"),
      runs: runDir(root, "1.0"),
      screener: "loupe",
      ask: async () => {
        clock += 25_000;
        wall += 25_000;
        return { text: LOUPE.L1 as string, usd: null };
      },
      maxMs: 60_000,
      clock: () => clock,
      wall: () => wall,
    });
    // Pages at 0, 25 and 50 s start inside the minute; the next would start at 75 s.
    expect(result).toMatchObject({ asked: 3, stopped: "the run reached its 1 minutes" });
    expect(result.first_request_at).toBe("2026-10-31T16:00:00.000Z");
    expect(result.last_request_at).toBe("2026-10-31T16:01:15.000Z");
    expect(parseEvaluateArgs(["loupe", "1.0", "--model", "m"]).maxMinutes).toBe(60);
    expect(() => parseEvaluateArgs(["loupe", "1.0", "--model", "m", "--max-minutes", "0"])).toThrow(/--max-minutes/);
  });

  // §13 plan review gap 3: answers are bound to the model and evaluation file they were asked of.
  it("refuses to add answers from another model, or to adopt answers with no record of what they were asked of", async () => {
    writeDataset("1.0");
    await runLoupe("1.0", LOUPE);
    const runs = runDir(root, "1.0");
    const identity = JSON.parse(readFileSync(join(runs, "loupe.identity.json"), "utf-8"));
    expect(identity.model).toBe("accounts/x/models/m#accounts/x/deployments/d");
    await expect(
      runAnswers({
        dataset: datasetDir(root, "1.0"),
        runs,
        screener: "loupe",
        ask: async () => ({ text: LOUPE.L1 as string, usd: null }),
        model: "accounts/x/models/other",
      }),
    ).rejects.toThrow(/were asked of accounts\/x\/models\/m#.* not accounts\/x\/models\/other/);
    rmSync(join(runs, "loupe.identity.json"));
    await expect(
      runAnswers({
        dataset: datasetDir(root, "1.0"),
        runs,
        screener: "loupe",
        ask: async () => ({ text: LOUPE.L1 as string, usd: null }),
        model: "accounts/x/models/m#accounts/x/deployments/d",
      }),
    ).rejects.toThrow(/have no identity file/);
  });

  it("is written whole and holds ids and counts, never page text or an image", async () => {
    writeDataset("1.0");
    await runLoupe("1.0", LOUPE);
    scoreVersion(root, "1.0");
    const runs = runDir(root, "1.0");
    expect(readdirSync(runs).sort()).toEqual(["loupe.answers.jsonl", "loupe.identity.json", "metrics.json"]);
    for (const name of readdirSync(runs)) {
      const text = readFileSync(join(runs, name), "utf-8");
      expect(text).not.toContain("SECRET-PAGE-TEXT");
      expect(text).not.toContain("data:image");
      expect(text).not.toContain("test-key");
    }
  });
});

describe("arguments", () => {
  it("reads the three commands and refuses the rest", () => {
    expect(parseEvaluateArgs(["loupe", "1.0", "--model", "m"])).toMatchObject({ command: "loupe", model: "m" });
    expect(parseEvaluateArgs(["spark", "1.0"])).toMatchObject({ command: "spark", maxUsd: 10 });
    expect(parseEvaluateArgs(["spark", "1.0", "--max-usd", "2.5"]).maxUsd).toBe(2.5);
    expect(parseEvaluateArgs(["score", "1.2"]).command).toBe("score");
    expect(() => parseEvaluateArgs(["loupe", "1.0"])).toThrow(/--model/);
    expect(() => parseEvaluateArgs(["spark", "../x"])).toThrow(/version/);
    expect(() => parseEvaluateArgs(["spark", "1.0", "--max-usd", "0"])).toThrow(/positive/);
    expect(() => parseEvaluateArgs(["nope", "1.0"])).toThrow(/unknown command/);
  });
});

// §13 completion review gaps 2 and 3.
describe("completion review", () => {
  it("ends a line a kill cut short before appending, so the next answer is read", () => {
    const dir = mkdtempSync(join(tmpdir(), "glimmer-tail-"));
    try {
      const file = join(dir, "loupe.answers.jsonl");
      writeFileSync(
        file,
        `${JSON.stringify({ id: "a", answer: null, error: "x", latency_ms: 1, cost_usd: null })}\n{"id":"b","answ`,
      );
      appendLine(file, { id: "c", answer: null, error: "y", latency_ms: 2, cost_usd: null } as never);
      const answers = readAnswers(file);
      expect([...answers.keys()]).toEqual(["a", "c"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ends a stalled Loupe request, its body included, at the request's deadline", async () => {
    const stalled = (async (_url: string, init: RequestInit) =>
      new Promise<Response>((_done, fail) =>
        init.signal?.addEventListener("abort", () => fail(init.signal?.reason)),
      )) as never;
    const started = Date.now();
    await expect(
      askLoupe("key", "model", { fetcher: stalled, requestMs: 200 })([{ role: "user", content: "x" }] as never),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
