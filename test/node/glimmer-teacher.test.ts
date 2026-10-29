import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type PageInput, type StoredPage } from "../../scripts/glimmer/store.ts";
import {
  type Ask,
  candidates,
  checkLabels,
  ESTIMATE_USD,
  glimmerSpend,
  ledgerLock,
  readQueue,
  readTeacherState,
  SPARK,
  sharedClock,
  sparkAsk,
  TEACHER_MAX_OUTPUT_TOKENS,
  teach,
  teacherArgs,
  teacherState,
  writeAll,
  writeReceipt,
} from "../../scripts/glimmer/teacher-label.ts";
import { ledgerId } from "../../scripts/lib/meta-budget.ts";
import { readLedger, tokenCost } from "../../scripts/meta-smoke.ts";
import { sastDay } from "../../src/meta/day.ts";
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
// A page's teacher state, read as §10 reads it: by the page as stored now.
const statusOf = (id: string) => {
  const store = openStore(join(dir, "store"));
  const page = store.manifest().find((p) => p.id === id) ?? { id, labels: {}, sha256: { screenshot: "", text: "" } };
  return teacherState(readTeacherState(join(dir, "store")), page as never);
};

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

  it("closes the local entry even when the guard's settlement throws after the answer", async () => {
    const { guard } = budget();
    const settle = guard.settle;
    guard.settle = async (id, actual, record) => {
      await settle(id, actual, record);
      throw new Error("the guard's ledger could not be written");
    };
    const { result, entry } = await run(guard, async () => reply());
    expect(result.checked).toBe(1);
    expect(entry).toMatchObject({ state: "settled" });
  });

  it("stops the run, quarantining nothing, when Spark cannot be asked at all", async () => {
    const { guard } = budget();
    await stored(1, true);
    await stored(2, true);
    let sent = 0;
    const ask = sparkAsk({
      env: {}, // no key: the client refuses before any attempt is reserved
      budget: guard,
      fetch: (async () => {
        sent++;
        return reply();
      }) as typeof globalThis.fetch,
      sleep: async () => {},
      random: () => 0.5,
    });
    const result = await teach({
      store: openStore(join(dir, "store")),
      ask,
      ledgerFile: join(dir, "ledger", "meta-spend.json"),
      run: "teacher-config",
      max: 5,
      now: NOW,
    });
    expect(sent).toBe(0);
    expect(result.stopped).toMatch(/could not be asked/);
    // One page tried, refused and asked again next time; the other never tried; none quarantined.
    const states = [...readTeacherState(join(dir, "store")).values()].map((o) => o.status);
    expect(states).toEqual(["refused"]);
  });

  it("settles an answered call, its reservation and its ledger entry sharing one id", async () => {
    const { guard, rows } = budget();
    const { result, sent, entry, id } = await run(guard, async () => reply());
    expect(sent).toBe(1);
    expect(result.checked).toBe(1);
    expect(rows).toEqual([{ id, attempt: 1, state: "settled", actual: expect.any(Number) }]);
    expect(entry).toMatchObject({ call: expect.stringContaining(SPARK), state: "settled" });
  });

  it("refuses to send when a cap refuses, stops the run, and asks the page again next time", async () => {
    const { guard } = budget(() => new BudgetExceeded("day", SPARK));
    const { result, sent, entry } = await run(guard, async () => reply());
    expect(sent).toBe(0);
    expect(result.stopped).toMatch(/budget refused/);
    expect(entry).toMatchObject({ state: "settled", cost: 0 });
    // Nothing was sent: the page is refused, not failed, so a later run asks it again.
    expect([...readTeacherState(join(dir, "store")).values()][0]).toMatchObject({ status: "refused" });
  });

  it("leaves an attempt settled at its estimate uncertain locally, never measured", async () => {
    const { guard } = budget();
    const { entry } = await run(
      guard,
      async () =>
        new Response(
          JSON.stringify({
            id: "resp_1",
            object: "response",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: answer(true) }] }],
            output_text: answer(true),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    expect(entry).toMatchObject({ state: "uncertain", cost: null });
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
    // The page was sent once, may have been answered, and is not sent again: quarantined (round 2).
    expect([...readTeacherState(join(dir, "store")).values()][0]).toMatchObject({ status: "quarantined" });
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
    expect(TEACHER_MAX_OUTPUT_TOKENS).toBe(2_000);
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
    // Its answer may have come back and been lost: kept out of training and evaluation by the rules.
    expect(statusOf(id)).toBe("quarantined");
    const { applyRules, readExcluded } = await import("../../scripts/glimmer/label-rules.ts");
    applyRules(openStore(join(dir, "store")));
    expect(readExcluded(join(dir, "store")).get(id)).toMatch(/teacher's answer was lost/);
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
    const byText = (input: unknown[]) => {
      const text = JSON.stringify(input);
      return text.includes("page 3 ") ? "not json" : answer(true);
    };
    const go = (ask: Ask) =>
      teach({
        store: openStore(join(dir, "store")),
        ledgerFile: ledgerFile(),
        run: "glimmer-teacher-test",
        max: 10,
        now: NOW,
        ask,
      });
    await go(answering(byText));
    // A page stored later meets a budget that refuses: nothing is sent, and it is asked again on the next run.
    const left = await stored(4, true);
    const refused = await go(async () => {
      throw new BudgetExceeded("day", SPARK);
    });
    expect(refused.stopped).toMatch(/budget refused/);
    expect([agreed, disputed, bad, left].map(statusOf)).toEqual(["agreed", "disputed", "failed", "refused"]);
    expect(statusOf("set-0000000000000000")).toBe("unchecked");
    let again = 0;
    await go(
      answering(
        () => answer(true),
        0.004,
        () => again++,
      ),
    );
    expect(again).toBe(1);
    expect(statusOf(left)).toBe("agreed");
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

  it("reads an earlier version's checked list, sending none of it again and quarantining what it cannot show", async () => {
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
    // Answered with no queue entry: an agreement or a lost disagreement, not known, so quarantined.
    expect(statusOf(id)).toBe("quarantined");
  });
});

describe("the run's receipt and the completion check", () => {
  it("fails on an unexplained page, a missing receipt and a stale one, and passes once each is settled", async () => {
    const { applyRules } = await import("../../scripts/glimmer/label-rules.ts");
    await stored(1, true);
    const loose = await stored(2, true, {
      labels: { has_login_form: false, has_payment_form: false },
      label_source: { has_login_form: "dom", has_payment_form: "dom" },
    });
    const store = openStore(join(dir, "store"));
    expect(checkLabels(store).join("; ")).toMatch(/neither a complete label nor an exclusion.*no receipt/);
    applyRules(store);
    expect(checkLabels(store)).toEqual(["no receipt: run the teacher"]);
    const receipt = writeReceipt(store, [], new Date("2026-10-29T10:00:00Z"));
    expect(receipt).toMatchObject({ snapshot: { pages: 2 }, complete: 1, excluded: { "no lure label": 1 } });
    expect(checkLabels(store)).toEqual([]);
    expect(loose).toBeTruthy();
    // A page stored after the receipt makes it stale.
    await stored(3, false);
    applyRules(store);
    expect(checkLabels(openStore(join(dir, "store"))).join()).toMatch(
      /covers 2 pages and other labels or outcomes than the 3/,
    );
  });
});

describe("the teacher's command line, candidates and receipt spend (§9 final review)", () => {
  it("refuses a misspelt command, an unknown flag and a malformed --max before anything runs", () => {
    expect(teacherArgs(["check"])).toEqual({ command: "check" });
    expect(teacherArgs([])).toEqual({ command: "run", max: 500, retryFailed: false });
    expect(teacherArgs(["--max", "10", "--retry-failed"])).toEqual({ command: "run", max: 10, retryFailed: true });
    for (const argv of [
      ["chek"],
      ["--help"],
      ["--max", "abc"],
      ["--max"],
      ["--max", "0"],
      ["--max", "-5"],
      ["check", "x"],
    ])
      expect(teacherArgs(argv)).toHaveProperty("error");
  });

  it("leaves out a page the rules excluded for good, but not one excluded only as incomplete", async () => {
    const walled = await stored(1, true);
    const incomplete = await stored(3, true);
    const fine = await stored(5, true);
    const pages = openStore(join(dir, "store")).manifest();
    const excluded = new Map([
      [walled, "the capture is a bot challenge, not the page its label was given for"],
      [incomplete, "incomplete after the rules (missing brand)"],
    ]);
    const ids = candidates(pages, new Set(), undefined, excluded).map((p) => p.id);
    expect(ids).not.toContain(walled);
    expect(ids).toContain(fine);
    // The teacher passes only the lasting exclusions: an incomplete page is one it may fill.
    mkdirSync(join(dir, "store", "raw", "labels"), { recursive: true });
    writeFileSync(
      join(dir, "store", "raw", "labels", "excluded.jsonl"),
      [...excluded].map(([id, reason]) => `${JSON.stringify({ id, reason })}\n`).join(""),
    );
    let asked = 0;
    await teach({
      store: openStore(join(dir, "store")),
      ask: answering(
        () => answer(true),
        0.004,
        () => asked++,
      ),
      ledgerFile: join(dir, "ledger", "meta-spend.json"),
      run: "teacher-barred",
      max: 5,
      now: NOW,
    });
    expect(asked).toBe(2);
    expect(statusOf(walled)).toBe("unchecked");
  });

  it("refuses a receipt whose spend is no longer the ledger's", async () => {
    const { applyRules } = await import("../../scripts/glimmer/label-rules.ts");
    await stored(1, true);
    const store = openStore(join(dir, "store"));
    applyRules(store);
    writeReceipt(store, [], NOW());
    expect(checkLabels(store, [])).toEqual([]);
    const later = [
      { date: "2026-10-29", run: "glimmer-teacher-2", call: "x", estimate: 0.01, state: "settled", cost: 0.008 },
    ] as never;
    expect(checkLabels(store, later)).toContain("the receipt's spend is not the ledger's now: run again");
  });
});

describe("the teacher's accounting and coverage", () => {
  it("gives both records of an attempt one instant, so one SAST day, across midnight", () => {
    const times = [new Date("2026-10-29T21:59:59.999Z"), new Date("2026-10-29T22:00:00.001Z")];
    let i = 0;
    const clock = sharedClock(() => times[Math.min(i++, 1)] as Date);
    const reserved = clock.teacher();
    // The guard reads after the clock has moved past midnight, and still gets the teacher's instant.
    expect(clock.guard()).toBe(reserved);
    expect(sastDay(clock.guard())).toBe(sastDay(reserved));
  });

  it("orders candidates South African first, then by a seeded shuffle rather than by id", () => {
    const page = (id: string, sa: boolean) =>
      ({
        id,
        south_africa: sa,
        labels: { lure: true },
        label_source: { lure: "ground-truth" },
      }) as unknown as StoredPage;
    const pages = Array.from({ length: 20 }, (_, n) => page(`src${String(n).padStart(2, "0")}`, n < 4));
    const order = candidates(pages, new Set()).map((p) => p.id);
    expect(order.slice(0, 4).every((id) => Number(id.slice(3)) < 4)).toBe(true);
    expect(order).not.toEqual([...order].sort());
    expect(candidates(pages, new Set(), "other").map((p) => p.id)).not.toEqual(order);
    expect(candidates(pages, new Set()).map((p) => p.id)).toEqual(order);
  });

  it("marks an agreement stale once the page's lure label changes, and the receipt with it", async () => {
    const { applyRules } = await import("../../scripts/glimmer/label-rules.ts");
    const id = await stored(1, true);
    const store = openStore(join(dir, "store"));
    applyRules(store);
    await teach({
      store,
      ledgerFile: join(dir, "ledger", "meta-spend.json"),
      run: "glimmer-teacher-t",
      max: 5,
      now: NOW,
      ask: answering(() => answer(true)),
    });
    writeReceipt(store, []);
    expect(checkLabels(store)).toEqual([]);
    const page = store.manifest()[0] as StoredPage;
    store.setLabels(id, { ...page.labels, lure: false, lure_type: "none" }, page.label_source);
    expect(statusOf(id)).toBe("stale");
    expect(checkLabels(openStore(join(dir, "store"))).join()).toMatch(/other labels or outcomes/);
  });

  it("refuses damaged content whose record still reads, unless it is excluded", async () => {
    const { applyRules } = await import("../../scripts/glimmer/label-rules.ts");
    const id = await stored(1, true);
    const store = openStore(join(dir, "store"));
    applyRules(store);
    writeReceipt(store, []);
    writeFileSync(join(dir, "store", "pages", id, "text.txt"), "altered");
    expect(checkLabels(store).join()).toMatch(/1 damaged pages are not excluded/);
    applyRules(store);
    writeReceipt(store, []);
    expect(checkLabels(store)).toEqual([]);
  });

  it("reports Spark's answers against every stored field by source, and what it agreed with", async () => {
    const { applyRules } = await import("../../scripts/glimmer/label-rules.ts");
    await stored(1, true);
    await stored(2, false);
    const store = openStore(join(dir, "store"));
    applyRules(store);
    await teach({
      store,
      ledgerFile: join(dir, "ledger", "meta-spend.json"),
      run: "glimmer-teacher-t",
      max: 5,
      now: NOW,
      ask: answering(() => answer(true)),
    });
    const receipt = writeReceipt(store, []);
    expect(receipt.fields.lure).toEqual({ "ground-truth": { agree: 1, disagree: 1 } });
    expect(receipt.fields.has_login_form?.dom).toEqual({ agree: 1, disagree: 1 });
    expect(receipt.agreed).toMatchObject({ lures: 1, benign: 0, byType: { credential: 1 }, bySource: { set: 1 } });
    expect(receipt.teacher).toEqual({ agreed: 1, disputed: 1 });
  });
});

describe("the teacher's records through a stop or a short write (round 1)", () => {
  it("writes every byte however few each write takes, and refuses a write that takes none", () => {
    const taken: number[] = [];
    const written: number[] = [];
    writeAll(7, "x".repeat(279), (_fd, buffer, offset, length) => {
      const n = Math.min(length, 139);
      taken.push(n);
      written.push(...buffer.subarray(offset, offset + n));
      return n;
    });
    expect(taken).toEqual([139, 139, 1]);
    expect(written).toHaveLength(279);
    expect(() => writeAll(7, "abc", () => 0)).toThrow(/took no bytes/);
  });

  it("puts the separator back after a whole last queue entry that lost its newline", async () => {
    const first = await stored(2, false);
    const second = await stored(4, false);
    mkdirSync(join(dir, "store", "raw", "teacher"), { recursive: true });
    writeFileSync(
      join(dir, "store", "raw", "teacher", "state.json"),
      JSON.stringify({
        pages: {
          [first]: { status: "disputed", answer: JSON.parse(answer(true)), applied: true },
          [second]: { status: "disputed", answer: JSON.parse(answer(true)), applied: false },
        },
      }),
    );
    // The stop came right after the first entry's closing brace.
    writeFileSync(
      join(dir, "store", "review-queue.jsonl"),
      JSON.stringify({ id: first, source: { lure: false }, spark: JSON.parse(answer(true)) }),
    );
    await teach({
      store: openStore(join(dir, "store")),
      ledgerFile: join(dir, "ledger", "meta-spend.json"),
      run: "glimmer-teacher-test",
      max: 10,
      now: NOW,
      ask: answering(() => answer(true)),
    });
    expect(readQueue(join(dir, "store")).map((e) => e.id)).toEqual([first, second]);
  });

  it("quarantines a page whose answer was lost after sending, and the rules exclude it", async () => {
    const { applyRules, readExcluded } = await import("../../scripts/glimmer/label-rules.ts");
    const id = await stored(2, false);
    const store = openStore(join(dir, "store"));
    await teach({
      store,
      ledgerFile: join(dir, "ledger", "meta-spend.json"),
      run: "glimmer-teacher-test",
      max: 10,
      now: NOW,
      ask: async (_input, _instructions, attempts) => {
        attempts.reserve(1, ESTIMATE_USD);
        throw new Error("settlement timed out after the answer arrived");
      },
    });
    expect(statusOf(id)).toBe("quarantined");
    // Before the rules run again, the check refuses the receipt; after, the page is excluded.
    writeReceipt(store, []);
    expect(checkLabels(store).join()).toMatch(/quarantined pages are not excluded/);
    applyRules(store);
    expect(readExcluded(join(dir, "store")).get(id)).toMatch(/teacher's answer was lost/);
  });

  it("keeps an earlier version's record in the new form at once, so its quarantine reaches the rules", async () => {
    const { applyRules, readExcluded } = await import("../../scripts/glimmer/label-rules.ts");
    const id = await stored(1, true);
    mkdirSync(join(dir, "store", "raw", "teacher"), { recursive: true });
    writeFileSync(join(dir, "store", "raw", "teacher", "checked.jsonl"), `${JSON.stringify({ id, answered: true })}\n`);
    const store = openStore(join(dir, "store"));
    await teach({
      store,
      ledgerFile: join(dir, "ledger", "meta-spend.json"),
      run: "glimmer-teacher-test",
      max: 0,
      now: NOW,
      ask: answering(() => answer(true)),
    });
    applyRules(store);
    expect(readExcluded(join(dir, "store")).get(id)).toMatch(/teacher's answer was lost/);
  });
});

describe("a disagreement whose queue entry was lost (round 3)", () => {
  it("is refused by the check and queued again when the teacher resumes", async () => {
    const id = await stored(2, false);
    mkdirSync(join(dir, "store", "raw", "teacher"), { recursive: true });
    // The state reached the disk as applied; the queue's first entry did not (a power loss).
    writeFileSync(
      join(dir, "store", "raw", "teacher", "state.json"),
      JSON.stringify({ pages: { [id]: { status: "disputed", answer: JSON.parse(answer(true)), applied: true } } }),
    );
    const store = openStore(join(dir, "store"));
    expect(checkLabels(store).join()).toMatch(/1 disagreements are not in the review queue/);
    let calls = 0;
    await teach({
      store,
      ledgerFile: join(dir, "ledger", "meta-spend.json"),
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
    expect(readQueue(join(dir, "store")).map((e) => e.id)).toEqual([id]);
    expect(checkLabels(store).join()).not.toMatch(/review queue/);
  });
});

describe("a reply cut off before its answer", () => {
  it("is failed as cut off, and asked again only when failed pages are retried", async () => {
    const id = await stored(1, true);
    const ledgerFile = join(dir, "ledger", "meta-spend.json");
    const cut: Ask = async (_input, _instructions, attempts) => {
      attempts.settle(attempts.reserve(1, ESTIMATE_USD), 0.004);
      return { text: "", usd: 0.004, incomplete: "max_output_tokens" };
    };
    await teach({
      store: openStore(join(dir, "store")),
      ledgerFile,
      run: "glimmer-teacher-t",
      max: 5,
      now: NOW,
      ask: cut,
    });
    expect(readTeacherState(join(dir, "store")).get(id)).toEqual({
      status: "failed",
      reason: "Spark's answer was cut off (max_output_tokens)",
    });
    let calls = 0;
    const answer1 = answering(
      () => answer(true),
      0.004,
      () => calls++,
    );
    await teach({
      store: openStore(join(dir, "store")),
      ledgerFile,
      run: "glimmer-teacher-t",
      max: 5,
      now: NOW,
      ask: answer1,
    });
    expect(calls).toBe(0);
    await teach({
      store: openStore(join(dir, "store")),
      ledgerFile,
      run: "glimmer-teacher-t",
      max: 5,
      now: NOW,
      ask: answer1,
      retryFailed: true,
    });
    expect(calls).toBe(1);
    expect(statusOf(id)).toBe("agreed");
  });

  it("asks Spark at low reasoning effort with room to answer", async () => {
    let body: Record<string, unknown> = {};
    const ask = sparkAsk({
      env: {
        META_API_KEY: "LLM_test_key_0123456789",
        CF_AIG_TOKEN: "aig-token-0123456789",
        META_GATEWAY_URL: "https://gateway.test/v1/",
      },
      budget: {
        reserve: async (_m, _e, _a, id) => id as string,
        settle: async () => {},
        uncertain: async () => {},
        refused: async () => {},
        cached: async () => {},
        outputFailed: async () => {},
      },
      fetch: (async (_url: string, init: { body: string }) => {
        body = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            id: "r",
            object: "response",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output: [],
            output_text: "",
            usage: { input_tokens: 10, output_tokens: 2000 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as never,
      sleep: async () => {},
      random: () => 0.5,
    });
    const reply = await ask([], "x", { reserve: () => "id", settle: () => {}, uncertain: () => {}, release: () => {} });
    expect(body).toMatchObject({ max_output_tokens: 2_000, reasoning: { effort: "low" } });
    expect(reply.incomplete).toBe("max_output_tokens");
  });
});
