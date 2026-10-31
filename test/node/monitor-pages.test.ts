import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askLoupe } from "../../scripts/glimmer/evaluate.ts";
import {
  overlap,
  PAGES,
  productionFigures,
  readAnswerLines,
  SET_DIR,
  screenerSpark,
  setDigest,
  trainingHashes,
} from "../../scripts/glimmer/monitor-pages.ts";
import { HOST } from "../../src/vision/page-screen.ts";
import { SPARK_MAX_OUTPUT_TOKENS } from "../../src/vision/screen-request.ts";

// The monitor's synthetic pages (D03 T04 §1): the committed set matches its manifest, its overlap receipt is bound to
// this set and to Loupe 1.0's training file and shares no screenshot with it, and the check catches a planted copy.
type Manifest = {
  pages: number;
  digest: string;
  manifest: {
    id: string;
    host: string;
    screenshot_sha256: string;
    text_sha256: string;
    lure: boolean;
    lure_type: string;
  }[];
};
const manifest = JSON.parse(readFileSync(join(SET_DIR, "MANIFEST.json"), "utf-8")) as Manifest;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

describe("the monitor pages set", () => {
  it("holds 20 lures of fictional brands and 20 benign pages, each with a valid host", () => {
    expect(PAGES).toHaveLength(40);
    expect(PAGES.filter((p) => p.lure)).toHaveLength(20);
    expect(PAGES.filter((p) => !p.lure).every((p) => p.lure_type === "none")).toBe(true);
    expect(PAGES.filter((p) => p.lure).every((p) => p.lure_type !== "none")).toBe(true);
    for (const page of PAGES) expect(HOST.test(page.host), page.host).toBe(true);
    // Hosts on the reserved .example name only: no real domain, no real brand's site.
    expect(PAGES.every((p) => p.host.endsWith(".example"))).toBe(true);
  });

  it("matches its manifest file by file, and the manifest's digest", () => {
    expect(manifest.pages).toBe(40);
    for (const entry of manifest.manifest) {
      expect(sha256(readFileSync(join(SET_DIR, "screens", `${entry.id}.jpg`))), entry.id).toBe(entry.screenshot_sha256);
      expect(sha256(readFileSync(join(SET_DIR, "texts", `${entry.id}.txt`), "utf-8")), entry.id).toBe(
        entry.text_sha256,
      );
    }
    expect(setDigest(manifest.manifest)).toBe(manifest.digest);
    const labels = JSON.parse(readFileSync(join(SET_DIR, "labels.json"), "utf-8")) as Record<string, { lure: boolean }>;
    for (const entry of manifest.manifest) expect(labels[entry.id]?.lure).toBe(entry.lure);
  });

  it("has an overlap receipt bound to this set that shares no screenshot with Loupe 1.0's training", () => {
    const receipt = JSON.parse(readFileSync(join(SET_DIR, "OVERLAP.json"), "utf-8"));
    expect(receipt.set_digest).toBe(manifest.digest);
    expect(receipt.set_hashes).toEqual(manifest.manifest.map((m) => m.screenshot_sha256));
    expect(receipt.training_file).toBe("dataset/1.0/train.jsonl");
    expect(receipt.training_file_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.training_images).toBeGreaterThan(50_000);
    expect(receipt.shared).toEqual([]);
  });

  it("finds a planted copy of a set screenshot in a training file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monitor-pages-"));
    try {
      const shot = readFileSync(join(SET_DIR, "screens", "lure-01.jpg"));
      const line = (b64: string) =>
        JSON.stringify({
          messages: [
            { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } }] },
          ],
        });
      const file = join(dir, "train.jsonl");
      writeFileSync(file, `${line(Buffer.from("other").toString("base64"))}\n${line(shot.toString("base64"))}\n`);
      const training = await trainingHashes(file);
      expect(training.lines).toBe(2);
      const hashes = manifest.manifest.map((m) => m.screenshot_sha256);
      expect(overlap(hashes, training.images)).toEqual([sha256(shot)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to check when the training file cannot be read", () => {
    const dir = mkdtempSync(join(tmpdir(), "monitor-pages-store-"));
    try {
      const run = () =>
        execFileSync(process.execPath, [join(import.meta.dirname, "../../scripts/glimmer/monitor-pages.ts"), "check"], {
          env: { ...process.env, GLIMMER_DATA_DIR: dir },
          stdio: "pipe",
        });
      expect(run).toThrow(/cannot be read; the overlap is unproven/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Completion review gaps 1 and 3: the comparison asks Spark as the screener's fallback does, under the lane's ledger.
describe("the comparison's Spark", () => {
  it("sends the screener's structured request with the proven settings, and returns the validated answer and its cost", async () => {
    const answer = {
      brand: null,
      has_login_form: false,
      has_payment_form: false,
      lure: false,
      lure_type: "none",
      confidence: 0.9,
    };
    const sent: Record<string, unknown>[] = [];
    const settled: number[] = [];
    const budget = {
      reserve: async () => "guard-1",
      refused: async () => {},
      cached: async () => {},
      outputFailed: async () => {},
      settle: async () => {},
      uncertain: async () => {},
    };
    const ask = screenerSpark({
      env: { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" },
      budget,
      sleep: async () => {},
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            id: "r",
            object: "response",
            status: "completed",
            output: [
              { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(answer) }] },
            ],
            usage: { input_tokens: 1000, output_tokens: 300 },
          }),
          { headers: { "content-type": "application/json", "cf-aig-log-id": "log-1" } },
        );
      }) as typeof fetch,
    });
    const ledger = {
      reserve: () => "local-1",
      settle: (_id: string, usd: number) => settled.push(usd),
      uncertain: () => {},
      release: () => {},
    };
    const reply = await ask(
      [{ role: "user", content: [{ type: "input_text", text: "Host: a.example" }] }],
      "prompt",
      ledger,
    );
    expect(JSON.parse(reply.text)).toEqual(answer);
    expect(reply.usd).toBe(settled[0]);
    expect(settled[0]).toBeGreaterThan(0);
    expect(sent[0]).toMatchObject({
      model: "muse-spark-1.3",
      instructions: "prompt",
      max_output_tokens: SPARK_MAX_OUTPUT_TOKENS,
      reasoning: { effort: "low" },
      text: { format: { type: "json_schema", name: "page_screen", strict: true } },
    });
  });
});

// §1 round 1.
describe("round 1", () => {
  const META = { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" };
  const guard = {
    reserve: async () => `guard-${Math.random()}`,
    refused: async () => {},
    cached: async () => {},
    outputFailed: async () => {},
    settle: async () => {},
    uncertain: async () => {},
  };
  const reply = (text: string) =>
    new Response(
      JSON.stringify({
        id: "r",
        object: "response",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
        usage: { input_tokens: 1000, output_tokens: 300 },
      }),
      { headers: { "content-type": "application/json", "cf-aig-log-id": "log-1" } },
    );

  it("gives a structured answer's repair its own ledger entries, never the first call's", async () => {
    const bad = {
      brand: null,
      has_login_form: false,
      has_payment_form: false,
      lure: true,
      lure_type: "none",
      confidence: 0.9,
    };
    const good = { ...bad, lure_type: "credential" };
    const answers = [JSON.stringify(bad), JSON.stringify(good)];
    const reserved: number[] = [];
    const ask = screenerSpark({
      env: META,
      budget: guard,
      sleep: async () => {},
      fetch: (async () => reply(answers.shift() as string)) as unknown as typeof fetch,
    });
    const ledger = {
      reserve: (attempt: number) => {
        if (reserved.includes(attempt)) throw new Error(`attempt ${attempt} reserved twice`);
        reserved.push(attempt);
        return `local-${attempt}`;
      },
      settle: () => {},
      uncertain: () => {},
      release: () => {},
    };
    const got = await ask(
      [{ role: "user", content: [{ type: "input_text", text: "Host: a.example" }] }],
      "prompt",
      ledger,
    );
    expect(JSON.parse(got.text)).toMatchObject({ lure: true, lure_type: "credential" });
    expect(reserved).toEqual([1, 2]);
  });

  it("stops Loupe's retries at the run's window: no wait or request past it", async () => {
    let clock = 0;
    let requests = 0;
    const ask = askLoupe("key", "model", {
      fetcher: (async () => {
        requests += 1;
        return new Response("rate limited", { status: 429 });
      }) as never,
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
      maxWaitMs: 15 * 60_000,
      requestMs: 10_000,
      deadlineAt: 60_000,
    });
    await expect(ask([{ role: "user", content: "x" }] as never)).rejects.toThrow(/window is spent/);
    expect(clock).toBeLessThanOrEqual(60_000);
    expect(requests).toBeLessThan(10);
  });

  it("composes the screener as production runs it: Loupe, Spark after Loupe's failure, and the run's priced minutes", () => {
    const labels = { a: { lure: true }, b: { lure: false }, c: { lure: true }, d: { lure: false } };
    const loupe = [
      { id: "a", answer: { lure: true }, latency_ms: 4000, cost_usd: null },
      { id: "b", answer: { lure: true }, latency_ms: 3000, cost_usd: null },
      { id: "c", answer: null, error: "timeout", latency_ms: 10_000, cost_usd: null },
      { id: "d", answer: null, error: "HTTP 500", latency_ms: 200, cost_usd: null },
    ];
    const spark = [
      { id: "c", answer: { lure: true }, latency_ms: 7000, cost_usd: 0.004 },
      { id: "d", answer: null, error: "refused", latency_ms: 5000, cost_usd: 0.004 },
    ];
    const figures = productionFigures(labels, loupe, spark, { warmup_ms: 150_000, wake_minutes: 15 }, 8);
    expect(figures).toMatchObject({
      pages: 4,
      loupe_answered: 2,
      spark_fallbacks: 1,
      failures: 1,
      lure_recall: 1,
      false_alarm_rate: 0.5,
      cold_start_ms: 150_000,
      loupe_usd: 2,
      // Both Spark attempts are paid, the refused one too.
      spark_usd: 0.008,
      cost_per_page_usd: 0.502,
    });
    // The fallback page's latency is Loupe's failed attempt and Spark's answer together.
    expect(figures.latency_p95_ms).toBe(17_000);
    // Round 2: a retry that answered stands over the error before it, as the answer files are read.
    const retried = productionFigures(
      labels,
      [...loupe, { id: "c", answer: { lure: true }, latency_ms: 2000, cost_usd: null }],
      spark,
      { warmup_ms: 150_000, wake_minutes: 15 },
      8,
    );
    expect(retried).toMatchObject({ loupe_answered: 3, spark_fallbacks: 0, spark_usd: 0.004 });
    // Round 4: a fallback page whose Spark cost is unknown leaves the totals unknown, never a measured zero.
    const unknown = productionFigures(
      labels,
      loupe,
      [{ id: "c", answer: { lure: true }, latency_ms: 7000, cost_usd: null }, ...spark.slice(1)],
      { warmup_ms: 150_000, wake_minutes: 15 },
      8,
    );
    expect(unknown).toMatchObject({ spark_usd: null, cost_per_page_usd: null, loupe_usd: 2 });
    // Round 3: a line a kill cut short is skipped when the figures are read, as the run itself reads it.
    const dir = mkdtempSync(join(tmpdir(), "monitor-score-"));
    try {
      const file = join(dir, "loupe.answers.jsonl");
      writeFileSync(file, `${JSON.stringify(loupe[0])}\n{"id":"b","answ\n${JSON.stringify(loupe[1])}\n`);
      expect(readAnswerLines(file).map((line) => line.id)).toEqual(["a", "b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
