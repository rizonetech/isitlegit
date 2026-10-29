import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type PageInput, type StoredPage } from "../../scripts/glimmer/store.ts";
import {
  type Ask,
  candidates,
  ESTIMATE_USD,
  glimmerSpend,
  ledgerLock,
  readQueue,
  readTeacherState,
  SPARK,
  sparkAsk,
  TEACHER_MAX_OUTPUT_TOKENS,
  teach,
  teacherState,
} from "../../scripts/glimmer/teacher-label.ts";
import { ledgerId } from "../../scripts/lib/meta-budget.ts";
import { readLedger, tokenCost } from "../../scripts/meta-smoke.ts";
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

// A fake Spark that answers at once, reserving and settling its one attempt as the client would.
const answering =
  (text: (input: unknown[]) => string, usd = 0.004, onCall?: () => void): Ask =>
  async (input, _instructions, attempts) => {
    onCall?.();
    const id = attempts.reserve(1, ESTIMATE_USD);
    attempts.settle(id, usd);
    return { text: text(input), usd };
  };
const NOW = () => new Date("2026-10-29T10:00:00Z");

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
      now: NOW,
      ask: answering(
        (input) => replies[JSON.stringify(input).includes("page 2 ") ? disagree : agree] as string,
        0.004,
        () => calls++,
      ),
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
      ask: answering(() => answer(true)),
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
      ask: answering(
        () => answer(true),
        0.004,
        () => calls++,
      ),
    });
    // The fake was asked, but its one attempt was refused before anything was sent.
    expect(calls).toBe(1);
    expect(readLedger(ledgerFile)).toHaveLength(2);
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
      now: NOW,
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

  it("marks a lost answer uncertain, attempt by attempt, each guard row under its own ledger entry's id", async () => {
    const { guard, rows } = budget();
    const { sent, entry, id } = await run(guard, async () => {
      throw new TypeError("fetch failed");
    });
    expect(sent).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ id, attempt: 1, state: "uncertain" });
    const ledger = readLedger(join(dir, "ledger", "meta-spend.json"));
    expect(rows.map((r) => r.id)).toEqual(ledger.map((e) => ledgerId(e.date, e.run, e.call)));
    expect(ledger.every((e) => e.state === "uncertain" && e.cost === null)).toBe(true);
    expect(entry).toMatchObject({ state: "uncertain", cost: null });
  });

  it("counts a failed attempt and its retry, each in the ledger under the guard row's id", async () => {
    const { guard, rows } = budget();
    let n = 0;
    const { result, sent } = await run(guard, async () =>
      ++n === 1 ? new Response("busy", { status: 503 }) : reply(),
    );
    expect(sent).toBe(2);
    expect(result).toMatchObject({ checked: 1, agreed: 1 });
    const ledger = readLedger(join(dir, "ledger", "meta-spend.json"));
    expect(ledger.map((e) => e.state)).toEqual(["uncertain", "settled"]);
    expect(ledger[1]?.call).toMatch(/ attempt 2$/);
    expect(rows.map((r) => r.id)).toEqual(ledger.map((e) => ledgerId(e.date, e.run, e.call)));
  });

  it("sends no retry that would pass US$20, keeping the first attempt's spend counted", async () => {
    const { guard } = budget();
    let estimate = 0;
    const watched: Budget = {
      ...guard,
      async reserve(model, estimateUsd, attempt, id, call) {
        estimate = estimateUsd;
        return guard.reserve(model, estimateUsd, attempt, id, call);
      },
    };
    const ledgerFile = join(dir, "ledger", "meta-spend.json");
    let n = 0;
    const { result, sent } = await run(watched, async () => {
      if (++n === 1) {
        // While the first attempt is out, other Glimmer work brings the spend to half an attempt short of US$20.
        const ledger = readLedger(ledgerFile);
        const fill = 20 - glimmerSpend(ledger) - estimate / 2;
        writeFileSync(
          ledgerFile,
          JSON.stringify([
            ...ledger,
            { date: "2026-10-29", run: "glimmer-other", call: "x", estimate: fill, cost: fill, state: "settled" },
          ]),
        );
      }
      return new Response("busy", { status: 503 });
    });
    expect(sent).toBe(1);
    expect(result.stopped).toMatch(/past US\$20/);
    const ledger = readLedger(ledgerFile);
    expect(ledger.filter((e) => e.run === "teacher-guard").map((e) => e.state)).toEqual(["uncertain"]);
    expect(glimmerSpend(ledger)).toBeLessThanOrEqual(20);
    // The page was sent once and is not sent again.
    expect([...readTeacherState(join(dir, "store")).values()][0]).toMatchObject({ status: "failed" });
  });
});

describe("a teacher run that stops", () => {
  const ledgerFile = () => join(dir, "ledger", "meta-spend.json");
  const stateOf = () => join(dir, "store", "raw", "teacher", "state.json");
  const save = (pages: Record<string, unknown>) => {
    mkdirSync(join(dir, "store", "raw", "teacher"), { recursive: true });
    writeFileSync(stateOf(), JSON.stringify({ pages }));
  };

  it("estimates an attempt at the whole answer the request allows", () => {
    expect(ESTIMATE_USD).toBe(tokenCost(SPARK, 9_000, TEACHER_MAX_OUTPUT_TOKENS));
    expect(TEACHER_MAX_OUTPUT_TOKENS).toBe(600);
  });

  it("fails a page whose call was out when the run stopped, and never sends it again", async () => {
    const id = await stored(1, true);
    save({ [id]: { status: "pending" } });
    let calls = 0;
    const result = await teach({
      store: openStore(join(dir, "store")),
      ledgerFile: ledgerFile(),
      run: "glimmer-teacher-test",
      max: 10,
      now: NOW,
      ask: answering(
        () => answer(true),
        0.004,
        () => calls++,
      ),
    });
    expect(calls).toBe(0);
    expect(result.recovered).toBe(1);
    expect(teacherState(readTeacherState(join(dir, "store")), id)).toBe("failed");
  });

  it("applies an answer kept before the stop without calling again, queueing a disagreement once", async () => {
    const id = await stored(2, false);
    save({ [id]: { status: "disputed", answer: JSON.parse(answer(true)), applied: false } });
    // The stop came mid-way through the queue's write: a torn line is left.
    writeFileSync(join(dir, "store", "review-queue.jsonl"), `{"id":"${id}","sou`);
    let calls = 0;
    for (let i = 0; i < 2; i++)
      await teach({
        store: openStore(join(dir, "store")),
        ledgerFile: ledgerFile(),
        run: "glimmer-teacher-test",
        max: 10,
        now: NOW,
        ask: answering(
          () => answer(true),
          0.004,
          () => calls++,
        ),
      });
    expect(calls).toBe(0);
    const queue = readQueue(join(dir, "store"));
    expect(queue.map((e) => e.id)).toEqual([id]);
    expect(readTeacherState(join(dir, "store")).get(id)).toMatchObject({ status: "disputed", applied: true });
  });

  it("names each page's state: unchecked, agreed, disputed, failed on a bad answer, refused by the budget", async () => {
    const agreed = await stored(1, true);
    const disputed = await stored(2, false);
    const bad = await stored(3, true);
    const left = await stored(4, true);
    const store = openStore(join(dir, "store"));
    const replies: Record<string, string> = { [agreed]: answer(true), [disputed]: answer(true), [bad]: "not json" };
    const byText = (input: unknown[]) => {
      const text = JSON.stringify(input);
      const id = text.includes("page 1 ") ? agreed : text.includes("page 2 ") ? disputed : bad;
      return replies[id] as string;
    };
    // South African pages first (2 and 4), then 1 and 3; the budget refuses the fourth page.
    let n = 0;
    const result = await teach({
      store,
      ledgerFile: ledgerFile(),
      run: "glimmer-teacher-test",
      max: 10,
      now: NOW,
      ask: async (input, instructions, attempts) => {
        if (++n === 4) throw new BudgetExceeded("day", SPARK);
        return answering(byText)(input, instructions, attempts);
      },
    });
    expect(result.stopped).toMatch(/budget refused/);
    const state = readTeacherState(join(dir, "store"));
    const states = Object.fromEntries([agreed, disputed, bad, left].map((id) => [id, teacherState(state, id)]));
    expect(Object.values(states).sort()).toEqual(["agreed", "disputed", "failed", "refused"]);
    expect(teacherState(state, "set-0000000000000000")).toBe("unchecked");
    // A refused page is asked again on the next run; the others are not.
    let again = 0;
    await teach({
      store: openStore(join(dir, "store")),
      ledgerFile: ledgerFile(),
      run: "glimmer-teacher-test",
      max: 10,
      now: NOW,
      ask: answering(
        () => answer(true),
        0.004,
        () => again++,
      ),
    });
    expect(again).toBe(1);
  });

  it("never sends a page whose files no longer match their hashes, and lists it", async () => {
    const id = await stored(1, true);
    writeFileSync(join(dir, "store", "pages", id, "text.txt"), "altered");
    let calls = 0;
    const result = await teach({
      store: openStore(join(dir, "store")),
      ledgerFile: ledgerFile(),
      run: "glimmer-teacher-test",
      max: 10,
      now: NOW,
      ask: answering(
        () => answer(true),
        0.004,
        () => calls++,
      ),
    });
    expect(calls).toBe(0);
    expect(result.damaged).toEqual([id]);
  });

  it("dates each attempt by the SAST day it is made, across midnight", async () => {
    await stored(1, true);
    await stored(3, true);
    const clock = [new Date("2026-10-29T21:59:59Z"), new Date("2026-10-29T22:00:01Z")];
    let tick = 0;
    await teach({
      store: openStore(join(dir, "store")),
      ledgerFile: ledgerFile(),
      run: "glimmer-teacher-test",
      max: 10,
      now: () => clock[Math.min(tick++, 1)] as Date,
      ask: answering(() => answer(true)),
    });
    expect(readLedger(ledgerFile()).map((e) => e.date)).toEqual(["2026-10-29", "2026-10-30"]);
  });

  it("reads an earlier version's checked list as applied outcomes, sending none of them again", async () => {
    const id = await stored(1, true);
    mkdirSync(join(dir, "store", "raw", "teacher"), { recursive: true });
    writeFileSync(join(dir, "store", "raw", "teacher", "checked.jsonl"), `${JSON.stringify({ id, answered: true })}\n`);
    let calls = 0;
    await teach({
      store: openStore(join(dir, "store")),
      ledgerFile: ledgerFile(),
      run: "glimmer-teacher-test",
      max: 10,
      now: NOW,
      ask: answering(
        () => answer(true),
        0.004,
        () => calls++,
      ),
    });
    expect(calls).toBe(0);
    expect(teacherState(readTeacherState(join(dir, "store")), id)).toBe("agreed");
  });
});
