import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AnswerLine,
  askLoupe,
  barOf,
  datasetDir,
  type Fetch,
  type Message,
  type PageMeta,
  parseEvaluateArgs,
  readAnswers,
  runAnswers,
  runDir,
  StopRun,
  scoreScreener,
  scoreVersion,
  sparkPreflight,
  sparkRunner,
} from "../../scripts/glimmer/evaluate.ts";
import { ESTIMATE_USD, GLIMMER_CAP_USD } from "../../scripts/glimmer/teacher-label.ts";
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
    expect(metrics.overall.cost_per_page_usd).toBe(0);
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

  it("stops without recording the page when the next attempt would pass --max-usd", async () => {
    writeDataset("1.0");
    const result = await runAnswers({ ...options(), ask: ask(LOUPE, ESTIMATE_USD + 0.001) });
    expect(result.stopped).toMatch(/past US\$/);
    expect(result.asked).toBe(1);
    expect(readAnswers(join(runDir(root, "1.0"), "spark.answers.jsonl")).has("L2")).toBe(false);
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
        answer: p.type === "none" ? NONE : lure(p.type as "credential"),
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
    expect(out.trim()).toBe("promote");
  });

  it("is written whole and holds ids and counts, never page text or an image", async () => {
    writeDataset("1.0");
    await runLoupe("1.0", LOUPE);
    scoreVersion(root, "1.0");
    const runs = runDir(root, "1.0");
    expect(readdirSync(runs).sort()).toEqual(["loupe.answers.jsonl", "metrics.json"]);
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
