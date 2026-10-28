import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type PageInput, type StoredPage } from "../../scripts/glimmer/store.ts";
import { candidates, ESTIMATE_USD, glimmerSpend, teach } from "../../scripts/glimmer/teacher-label.ts";
import { readLedger } from "../../scripts/meta-smoke.ts";

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
