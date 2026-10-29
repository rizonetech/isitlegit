import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type PageInput, type StoredPage } from "../../scripts/glimmer/store.ts";
import {
  candidates,
  ESTIMATE_USD,
  glimmerSpend,
  ledgerLock,
  SPARK,
  sparkAsk,
  teach,
} from "../../scripts/glimmer/teacher-label.ts";
import { ledgerId } from "../../scripts/lib/meta-budget.ts";
import { readLedger } from "../../scripts/meta-smoke.ts";
import { type Budget, BudgetExceeded } from "../../src/meta/guard.ts";

// scripts/glimmer/teacher-label.ts (D03 T04 §9): Spark's second opinion on evaluation pages, through the shared Meta
// ledger, never overwriting a label and never passing US$20 of Glimmer's Spark spend.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "glimmer-teacher-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function stored(seed: number, lure: boolean, extra: Partial<PageInput> = {}) {
  const store = openStore(join(dir, "store"));
  const screenshot = new Uint8Array(
    await sharp({ create: { width: 64, height: 64, channels: 3, background: `hsl(${seed * 40},60%,50%)` } })
      .jpeg()
      .toBuffer(),
  );
  const labels = {
    lure,
    lure_type: lure ? ("credential" as const) : ("none" as const),
    has_login_form: lure,
    has_payment_form: false,
  };
  return store.putPage("set", {
    screenshot,
    text: `page ${seed} text for the screener`,
    origin: "public",
    licence: "CC0",
    host: null,
    template: null,
    south_africa: seed % 2 === 0,
    labels,
    label_source: { lure: "ground-truth", lure_type: "rule", has_login_form: "dom", has_payment_form: "dom" },
    redacted: false,
    ...extra,
  });
}

const answer = (lure: boolean) =>
  JSON.stringify({
    brand: "Bank",
    has_login_form: lure,
    has_payment_form: false,
    lure,
    lure_type: lure ? "credential" : "none",
    confidence: 0.9,
  });

describe("the ledger lock", () => {
  it("sits beside the ledger, so the ledger stays readable while the run holds it", async () => {
    const { takeLock } = await import("../../scripts/meta-smoke.ts");
    const ledgerFile = join(dir, "ledger", "meta-spend.json");
    mkdirSync(join(dir, "ledger"), { recursive: true });
    writeFileSync(ledgerFile, "[]");
    expect(ledgerLock(ledgerFile)).not.toBe(ledgerFile);
    const release = takeLock(ledgerLock(ledgerFile));
    expect(typeof release).toBe("function");
    expect(readLedger(ledgerFile)).toEqual([]);
    (release as () => void)();
  });
});

describe("candidates", () => {
  it("takes trusted-lure pages, South African first, skipping those checked", () => {
    const page = (id: string, sa: boolean, source: string) =>
      ({ id, south_africa: sa, labels: { lure: true }, label_source: { lure: source } }) as unknown as StoredPage;
    const picked = candidates(
      [
        page("b", false, "ground-truth"),
        page("a", true, "ground-truth"),
        page("c", true, "unverified"),
        page("d", false, "ground-truth"),
      ],
      new Set(["d"]),
    );
    expect(picked.map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("teach", () => {
  it("queues a disagreement without overwriting either label, fills a missing field as Spark's, and settles each call", async () => {
    const agree = await stored(1, true);
    const disagree = await stored(2, false);
    const ledgerFile = join(dir, "ledger", "meta-spend.json");
    const replies: Record<string, string> = {};
    const store = openStore(join(dir, "store"));
    for (const p of store.manifest()) replies[p.id] = p.id === disagree ? answer(true) : answer(true);
    let calls = 0;
    const result = await teach({
      store,
      ledgerFile,
      run: "glimmer-teacher-test",
      max: 10,
      date: "2026-10-29",
      ask: async (input) => {
        calls++;
        const text = JSON.stringify(input);
        const id = text.includes("page 2 ") ? disagree : agree;
        return { text: replies[id] as string, usd: 0.004 };
      },
    });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ checked: 2, agreed: 1, queued: 1, filled: 2 });
    const queue = readFileSync(join(dir, "store", "review-queue.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(queue).toEqual([{ id: disagree, source: { lure: false }, spark: JSON.parse(answer(true)) }]);
    const after = new Map(
      openStore(join(dir, "store"))
        .manifest()
        .map((p) => [p.id, p]),
    );
    expect(after.get(disagree)?.labels.lure).toBe(false);
    expect(after.get(disagree)?.label_source.lure).toBe("ground-truth");
    expect(after.get(agree)?.labels.brand).toBe("Bank");
    expect(after.get(agree)?.label_source.brand).toBe("spark");
    const ledger = readLedger(ledgerFile);
    expect(ledger.map((e) => [e.state, e.cost, e.run])).toEqual([
      ["settled", 0.004, "glimmer-teacher-test"],
      ["settled", 0.004, "glimmer-teacher-test"],
    ]);
    // A second run checks nothing it already checked.
    const again = await teach({
      store: openStore(join(dir, "store")),
      ledgerFile,
      run: "glimmer-teacher-test",
      max: 10,
      ask: async () => ({ text: answer(true), usd: 0.004 }),
    });
    expect(again.checked).toBe(0);
  });

  it("refuses the call that would take Glimmer's Spark spend past US$20", async () => {
    await stored(3, true);
    const ledgerFile = join(dir, "ledger", "meta-spend.json");
    const near = 20 - ESTIMATE_USD / 2;
    mkdirSync(join(dir, "ledger"), { recursive: true });
    writeFileSync(
      ledgerFile,
      JSON.stringify([
        { date: "2026-10-29", run: "glimmer-synth-old", call: "x", estimate: near, cost: near, state: "settled" },
        { date: "2026-10-29", run: "smoke-1", call: "y", estimate: 5, cost: 5, state: "settled" },
      ]),
    );
    expect(glimmerSpend(readLedger(ledgerFile))).toBeCloseTo(near);
    let calls = 0;
    const result = await teach({
      store: openStore(join(dir, "store")),
      ledgerFile,
      run: "glimmer-teacher-test",
      max: 10,
      ask: async () => {
        calls++;
        return { text: answer(true), usd: 0.004 };
      },
    });
    expect(calls).toBe(0);
    expect(result.stopped).toMatch(/past US\$20/);
  });
});

// Every Spark attempt reserved in main's budget guard (D03 T01 §2) through the client, its first attempt's row the
// call's own ledger id, so an import of the local ledger never counts it twice.
describe("the teacher's calls through main's budget guard", () => {
  const env = {
    META_API_KEY: "LLM_test_key_0123456789",
    CF_AIG_TOKEN: "aig-token-0123456789",
    META_GATEWAY_URL: "https://gateway.test/v1/",
  };
  type Row = { id: string; attempt: number; state: string; actual?: number };
  function budget(refuse?: () => Error) {
    const rows: Row[] = [];
    const find = (id: string) => rows.find((r) => r.id === id) as Row;
    const guard: Budget = {
      async reserve(_model, _estimate, attempt, id) {
        if (refuse) throw refuse();
        rows.push({ id: id as string, attempt, state: "reserved" });
        return id as string;
      },
      async settle(id, actual) {
        Object.assign(find(id), { state: "settled", actual });
      },
      async uncertain(id) {
        find(id).state = "uncertain";
      },
      async refused() {},
      async cached() {},
      async outputFailed() {},
    };
    return { guard, rows };
  }
  const reply = () =>
    new Response(
      JSON.stringify({
        id: "resp_1",
        object: "response",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: answer(true) }] }],
        output_text: answer(true),
        usage: { input_tokens: 1000, output_tokens: 100 },
      }),
      { status: 200, headers: { "content-type": "application/json", "cf-aig-log-id": "log-1" } },
    );
  async function run(guard: Budget, fetch: () => Promise<Response>) {
    await stored(1, true);
    const ledgerFile = join(dir, "ledger", "meta-spend.json");
    let sent = 0;
    const ask = sparkAsk({
      env,
      budget: guard,
      fetch: (async () => {
        sent++;
        return fetch();
      }) as typeof globalThis.fetch,
      sleep: async () => {},
      random: () => 0.5,
    });
    const result = await teach({
      store: openStore(join(dir, "store")),
      ask,
      ledgerFile,
      run: "teacher-guard",
      max: 5,
      date: "2026-10-29",
    });
    const entry = readLedger(ledgerFile)[0];
    return { result, sent, entry, id: entry ? ledgerId(entry.date, entry.run, entry.call) : "" };
  }

  it("settles an answered call, its reservation and its ledger entry sharing one id", async () => {
    const { guard, rows } = budget();
    const { result, sent, entry, id } = await run(guard, async () => reply());
    expect(sent).toBe(1);
    expect(result.checked).toBe(1);
    expect(rows).toEqual([{ id, attempt: 1, state: "settled", actual: expect.any(Number) }]);
    expect(entry).toMatchObject({ call: expect.stringContaining(SPARK), state: "settled" });
  });

  it("refuses to send when a cap refuses, and stops the run", async () => {
    const { guard } = budget(() => new BudgetExceeded("day", SPARK));
    const { result, sent, entry } = await run(guard, async () => reply());
    expect(sent).toBe(0);
    expect(result.stopped).toMatch(/budget refused/);
    expect(entry).toMatchObject({ state: "settled", cost: 0 });
  });

  it("refuses to send when the budget cannot be reached, and stops the run", async () => {
    const { guard } = budget(() => new Error("D1 unreachable"));
    const { result, sent } = await run(guard, async () => reply());
    expect(sent).toBe(0);
    expect(result.stopped).toMatch(/could not be reached/);
  });

  it("marks a lost answer uncertain, attempt by attempt, the first under the call's id", async () => {
    const { guard, rows } = budget();
    const { sent, entry, id } = await run(guard, async () => {
      throw new TypeError("fetch failed");
    });
    expect(sent).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ id, attempt: 1, state: "uncertain" });
    expect(rows.slice(1).every((r) => r.id === `${id}:${r.attempt}` && r.state === "uncertain")).toBe(true);
    expect(entry).toMatchObject({ state: "uncertain", cost: null });
  });
});
