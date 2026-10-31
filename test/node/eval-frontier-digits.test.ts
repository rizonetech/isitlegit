// D08 T03 §1: the edited-digits experiment's images, request, spend, resume, baseline, score and log check.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BASELINE_MIN_SPREAD,
  BASELINE_Z,
  baselineDigits,
  buildSet,
  checkLog,
  DigitsAnswer,
  decide,
  digitsRequest,
  type FontResolver,
  fingerprint,
  INSTRUCTION,
  LIMITATION,
  ledgerLock,
  type Manifest,
  PRICES,
  RESULTS,
  type ResultsFile,
  readManifest,
  readResults,
  recomputed,
  resultProblems,
  runSet,
  type Score,
  scoreDigits,
  scoreLines,
  scoreSet,
  sharedLedger,
  verifyFonts,
} from "../../eval/frontier/digits.ts";
import {
  ACCOUNT_BOX,
  type Box,
  editInvoice,
  FONT_PINS,
  INVOICE_SIZE,
  invoiceSpecs,
  renderInvoice,
} from "../../eval/frontier/make-invoices.ts";
import { ledgerLock as teacherLedgerLock } from "../../scripts/glimmer/teacher-label.ts";
import { readLedger, saveLedger } from "../../scripts/meta-smoke.ts";
import { type Budget, BudgetExceeded } from "../../src/meta/guard.ts";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-digits-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// A machine whose fontconfig gives each family its pinned file.
const PINNED: FontResolver = (family) => ({ file: `/fonts/${family}`, sha256: FONT_PINS[family] as string });

type Grey = { data: Buffer; width: number };
const grey = async (image: Uint8Array): Promise<Grey> => {
  const { data, info } = await sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width };
};
const inBox = (box: Box, x: number, y: number) =>
  x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height;
// The share of dark pixels in a box.
const ink = (g: Grey, box: Box) => {
  let dark = 0;
  for (let y = box.top; y < box.top + box.height; y++)
    for (let x = box.left; x < box.left + box.width; x++) if ((g.data[y * g.width + x] ?? 255) < 128) dark++;
  return dark / (box.width * box.height);
};
// The mean absolute difference of two images inside a box, or outside it.
const diff = (a: Grey, b: Grey, box: Box, inside: boolean) => {
  let sum = 0;
  let n = 0;
  const height = a.data.length / a.width;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < a.width; x++) {
      if (inBox(box, x, y) !== inside) continue;
      sum += Math.abs((a.data[y * a.width + x] ?? 0) - (b.data[y * b.width + x] ?? 0));
      n++;
    }
  return sum / n;
};
// The horizontal extent of the ink in a box: its first and last dark column.
const extent = (g: Grey, box: Box) => {
  let first = -1;
  let last = -1;
  for (let x = box.left; x < box.left + box.width; x++)
    for (let y = box.top; y < box.top + box.height; y++)
      if ((g.data[y * g.width + x] ?? 255) < 128) {
        if (first < 0) first = x;
        last = x;
        break;
      }
  return { first, last };
};
const PAGE: Box = { left: 0, top: 0, width: INVOICE_SIZE.width, height: INVOICE_SIZE.height };

describe("the synthetic invoices", () => {
  it("are ten fictional suppliers, each with a 9 to 11 digit number and a different covered one", () => {
    const specs = invoiceSpecs();
    expect(specs).toHaveLength(10);
    expect(new Set(specs.map((s) => s.supplier)).size).toBe(10);
    for (const spec of specs) {
      expect(spec.account).toMatch(/^\d{9,11}$/);
      expect(spec.originalAccount).toMatch(/^\d{9,11}$/);
      expect(spec.originalAccount).not.toBe(spec.account);
    }
    expect(invoiceSpecs()).toEqual(specs); // a rerun builds the same set
  });

  it("renders a twin with readable text in the account box and across the page", async () => {
    const twin = await renderInvoice(invoiceSpecs()[0] as never);
    const meta = await sharp(twin).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", INVOICE_SIZE.width, INVOICE_SIZE.height]);
    const g = await grey(twin);
    expect(ink(g, ACCOUNT_BOX)).toBeGreaterThan(0.03); // digits, not a blank box
    expect(ink(g, ACCOUNT_BOX)).toBeLessThan(0.45); // and not a solid block
    expect(ink(g, PAGE)).toBeGreaterThan(0.01); // a page of text, not a blank one
  });

  for (const [index, kind] of [
    [0, "font"],
    [1, "spacing"],
    [2, "recompress"],
  ] as const) {
    it(`pastes a ${kind} edit inside the box only, as digits, the intended way`, async () => {
      const spec = invoiceSpecs()[index] as never;
      const twin = await grey(await renderInvoice(spec));
      const edit = await grey(await editInvoice(spec, kind));
      // Outside the box, only the JPEG noise of the same encoding history.
      expect(diff(edit, twin, ACCOUNT_BOX, false)).toBeLessThan(0.05);
      // Inside, digits: neither blank nor solid.
      expect(ink(edit, ACCOUNT_BOX)).toBeGreaterThan(0.03);
      expect(ink(edit, ACCOUNT_BOX)).toBeLessThan(0.45);
      const inside = diff(edit, twin, ACCOUNT_BOX, true);
      const span = (g: Grey) => extent(g, ACCOUNT_BOX);
      if (kind === "font") expect(inside).toBeGreaterThan(8); // other glyph shapes
      if (kind === "spacing") expect(Math.abs(span(edit).last - span(twin).last)).toBeGreaterThanOrEqual(5);
      if (kind === "recompress") {
        // The same glyphs in the same place: only compression noise sets it apart.
        expect(Math.abs(span(edit).first - span(twin).first)).toBeLessThanOrEqual(1);
        expect(Math.abs(span(edit).last - span(twin).last)).toBeLessThanOrEqual(1);
        expect(inside).toBeGreaterThan(0.3);
        expect(inside).toBeLessThan(6);
      }
    });
  }
});

let setDir: string;
let manifest: Manifest;
beforeAll(async () => {
  setDir = join(temp(), "set");
  manifest = await buildSet(setDir, PINNED);
}, 60_000);

describe("the fonts and the build", () => {
  it("refuses a machine whose fontconfig substitutes or lacks a pinned typeface", () => {
    expect(verifyFonts(PINNED)).toMatchObject({ fonts: { "DejaVu Sans": { sha256: FONT_PINS["DejaVu Sans"] } } });
    const substituted: FontResolver = (family) =>
      family === "Nimbus Roman" ? { file: "/fonts/other.ttf", sha256: "0".repeat(64) } : PINNED(family);
    expect(verifyFonts(substituted)).toEqual({
      problems: [expect.stringMatching(/Nimbus Roman resolves to \/fonts\/other/)],
    });
    expect(verifyFonts(() => null)).toMatchObject({
      problems: [expect.stringMatching(/not installed/), expect.anything()],
    });
  });

  it("builds into a new folder only, leaving an existing set untouched", async () => {
    const before = readFileSync(join(setDir, "manifest.json"), "utf-8");
    await expect(buildSet(setDir, PINNED)).rejects.toThrow(/exists/);
    await expect(buildSet(join(temp(), "set"), () => null)).rejects.toThrow(/not installed/);
    expect(readFileSync(join(setDir, "manifest.json"), "utf-8")).toBe(before);
  });
});

describe("the built set", () => {
  it("holds 20 images whose manifest hashes and fields match", () => {
    expect(manifest.images).toHaveLength(20);
    expect(manifest.images.filter((e) => e.edited)).toHaveLength(10);
    expect(readManifest(setDir)).toEqual(manifest);
    for (const e of manifest.images) {
      expect(existsSync(join(setDir, e.file))).toBe(true);
      expect(e.kind === null).toBe(!e.edited);
      expect(e.covered === null).toBe(!e.edited);
      if (e.edited) expect(e.covered).not.toBe(e.account);
    }
  });
});

describe("the answer's schema", () => {
  const ok = { edited: true, confidence: 0.8, regions: [{ field: "account_number", reason: "font differs" }] };
  it("accepts a valid answer and refuses an unknown field, a confidence over 1 and an unknown property", () => {
    expect(DigitsAnswer.safeParse(ok).success).toBe(true);
    expect(DigitsAnswer.safeParse({ ...ok, regions: [{ field: "iban", reason: "x" }] }).success).toBe(false);
    expect(DigitsAnswer.safeParse({ ...ok, confidence: 1.2 }).success).toBe(false);
    expect(DigitsAnswer.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
});

// The client stubs: Spark's reply, a guard that keeps rows, a shared ledger in a temp folder.
const env = {
  META_API_KEY: "LLM_test_key_0123456789",
  CF_AIG_TOKEN: "aig-token-0123456789",
  META_GATEWAY_URL: "https://gateway.test/v1/",
};
const answerText = (edited: boolean) =>
  JSON.stringify({
    edited,
    confidence: edited ? 0.9 : 0.1,
    regions: edited ? [{ field: "account_number", reason: "r" }] : [],
  });
const reply = (text: string, status = 200) =>
  new Response(
    JSON.stringify({
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
      output_text: text,
      usage: { input_tokens: 2000, output_tokens: 1000 },
    }),
    { status, headers: { "content-type": "application/json", "cf-aig-log-id": "log-1" } },
  );
type Row = { id: string; attempt: number; state: string; actual?: number };
function guardStub(refuseAt?: number) {
  const rows: Row[] = [];
  let reserved = 0;
  const guard: Budget = {
    async reserve(model, _estimate, attempt, id) {
      reserved++;
      if (refuseAt !== undefined && reserved >= refuseAt) throw new BudgetExceeded("day", model);
      rows.push({ id: id as string, attempt, state: "reserved" });
      return id as string;
    },
    async settle(id, actual) {
      Object.assign(rows.find((r) => r.id === id) as Row, { state: "settled", actual });
    },
    async uncertain(id) {
      (rows.find((r) => r.id === id) as Row).state = "uncertain";
    },
    async refused() {},
    async cached() {},
    async outputFailed() {},
  };
  return { guard, rows };
}
const context = (fetch: (body: Record<string, unknown>) => Promise<Response>) => {
  const bodies: Record<string, unknown>[] = [];
  return {
    bodies,
    context: {
      env,
      sleep: async () => {},
      random: () => 0.5,
      fetch: (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        return fetch(body);
      }) as typeof globalThis.fetch,
    },
  };
};
const instant = () => new Date("2026-10-31T10:00:00Z");
const ledgerIn = (dir: string, run = "eval-frontier-digits-test") =>
  sharedLedger(join(dir, "meta-spend.json"), run, { now: instant, waitMs: 0, sleep: async () => {} });
// A copy of the built set, so each run test starts with no results.
const freshSet = () => {
  const dir = temp();
  for (const e of manifest.images) writeFileSync(join(dir, e.file), readFileSync(join(setDir, e.file)));
  writeFileSync(join(dir, "manifest.json"), readFileSync(join(setDir, "manifest.json")));
  return dir;
};

describe("the request", () => {
  it("sends Spark at high effort, the image, the output limit, store false and the schema, and no hint of the edit", async () => {
    const dir = freshSet();
    const { guard } = guardStub();
    const { bodies, context: ctx } = context(async () => reply(answerText(false)));
    const one: Manifest = { ...manifest, images: manifest.images.slice(1, 2) };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(one));
    await runSet({ dir, context: ctx, guard, ledger: ledgerIn(dir), now: instant });
    const body = bodies[0] as Record<string, unknown> & {
      input: { content: { type: string; image_url?: string }[] }[];
    };
    expect(body.model).toBe("muse-spark-1.3");
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.max_output_tokens).toBe(8000);
    expect(body.store).toBe(false);
    expect((body.text as { format: { type: string } }).format.type).toBe("json_schema");
    const image = body.input[0]?.content.find((p) => p.type === "input_image");
    expect(image?.image_url).toBe(
      `data:image/jpeg;base64,${readFileSync(join(dir, one.images[0]?.file as string)).toString("base64")}`,
    );
    expect(body.instructions).toBe(INSTRUCTION);
    expect(INSTRUCTION).not.toMatch(/edited|pasted|account/i);
    expect(digitsRequest(new Uint8Array([1])).instructions).toBe(INSTRUCTION);
  });
});

describe("spend in both ledgers", () => {
  const oneImage = () => {
    const dir = freshSet();
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, images: manifest.images.slice(0, 1) }));
    return dir;
  };

  it("records a structured repair as two attempts in both ledgers, both costs summed", async () => {
    const dir = oneImage();
    const { guard, rows } = guardStub();
    let n = 0;
    const { context: ctx } = context(async () => reply(n++ === 0 ? "not json" : answerText(true)));
    await runSet({ dir, context: ctx, guard, ledger: ledgerIn(dir), now: instant });
    const ledger = readLedger(join(dir, "meta-spend.json"));
    expect(ledger.map((e) => [e.call, e.state])).toEqual([
      ["inv-01-twin.jpg#1", "settled"],
      ["inv-01-twin.jpg#2", "settled"],
    ]);
    expect(rows.map((r) => r.state)).toEqual(["settled", "settled"]);
    const outcome = readResults(dir)?.results[0];
    expect(outcome?.attempts).toBe(2);
    expect(outcome?.usd).toBeCloseTo((ledger[0]?.cost ?? 0) + (ledger[1]?.cost ?? 0), 10);
    expect(outcome?.usd).toBeGreaterThan(0);
  });

  it("records a transport retry (503 then 200) as two attempts", async () => {
    const dir = oneImage();
    const { guard, rows } = guardStub();
    let n = 0;
    const { context: ctx } = context(async () =>
      n++ === 0 ? new Response("busy", { status: 503 }) : reply(answerText(false)),
    );
    await runSet({ dir, context: ctx, guard, ledger: ledgerIn(dir), now: instant });
    expect(readLedger(join(dir, "meta-spend.json"))).toHaveLength(2);
    expect(rows).toHaveLength(2);
    expect(readResults(dir)?.results[0]?.status).toBe("answered");
  });

  it("releases the ledger entry the guard refuses, keeps the first settled and sends nothing more", async () => {
    const dir = oneImage();
    const { guard } = guardStub(2);
    const { bodies, context: ctx } = context(async () => reply("not json"));
    const report = await runSet({ dir, context: ctx, guard, ledger: ledgerIn(dir), now: instant });
    expect(bodies).toHaveLength(1);
    // The refused attempt's entry stays, settled at nothing, so its id is never reused (round 1).
    expect(readLedger(join(dir, "meta-spend.json")).map((e) => [e.call, e.state, e.cost === 0])).toEqual([
      ["inv-01-twin.jpg#1", "settled", false],
      ["inv-01-twin.jpg#2", "settled", true],
    ]);
    expect(report.stopped).toMatch(/inv-01-twin/);
    expect(readResults(dir)?.results[0]).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("keeps another caller's entry written between two of this run's updates", async () => {
    const dir = temp();
    const file = join(dir, "meta-spend.json");
    const ledger = ledgerIn(dir);
    const id = await ledger.reserve("a.jpg", 0.01);
    const other = {
      date: "2026-10-31",
      run: "glimmer-teacher-1",
      call: "p1",
      estimate: 0.02,
      cost: 0.02,
      state: "settled" as const,
    };
    saveLedger(file, [...readLedger(file), other]);
    await ledger.settle(id, 0.005);
    expect(readLedger(file)).toEqual([expect.objectContaining({ call: "a.jpg#1", cost: 0.005 }), other]);
  });

  it("locks the same file the teacher locks, and stops before any request while a live process holds it", async () => {
    const dir = freshSet();
    const file = join(dir, "meta-spend.json");
    expect(ledgerLock(file)).toBe(teacherLedgerLock(file));
    writeFileSync(ledgerLock(file), String(process.ppid)); // a live process
    const { guard } = guardStub();
    const { bodies, context: ctx } = context(async () => reply(answerText(false)));
    const report = await runSet({ dir, context: ctx, guard, ledger: ledgerIn(dir), now: instant });
    expect(bodies).toHaveLength(0);
    expect(report.stopped).toMatch(/locked/);
    expect(readResults(dir)?.results).toEqual([]);
  });

  it("refuses an attempt that would take the run past its cap", async () => {
    const dir = temp();
    const ledger = sharedLedger(join(dir, "meta-spend.json"), "r", { capUsd: 0.05, now: instant, waitMs: 0 });
    await ledger.reserve("a.jpg", 0.04);
    await expect(ledger.reserve("b.jpg", 0.02)).rejects.toThrow(/cap/);
  });
});

describe("a run over the set", () => {
  it("answers all 20 images", async () => {
    const dir = freshSet();
    const { guard } = guardStub();
    const { bodies, context: ctx } = context(async () => reply(answerText(false)));
    const report = await runSet({ dir, context: ctx, guard, ledger: ledgerIn(dir), now: instant });
    expect(report).toEqual({ answered: 20, failed: 0, ambiguous: [], stopped: null });
    expect(bodies).toHaveLength(20);
    expect(readResults(dir)?.fingerprint).toBe(fingerprint(manifest));
  });

  it("stops at a refusal on the 5th image with 4 answered and no 5th request; a rerun sends only the rest", async () => {
    const dir = freshSet();
    const { guard } = guardStub(5);
    const first = context(async () => reply(answerText(true)));
    const report = await runSet({ dir, context: first.context, guard, ledger: ledgerIn(dir), now: instant });
    expect(report.answered).toBe(4);
    expect(first.bodies).toHaveLength(4);
    expect(report.stopped).toMatch(/inv-03-twin/);
    expect(readResults(dir)?.results.map((r) => r.status)).toEqual(Array(4).fill("answered"));
    const second = context(async () => reply(answerText(true)));
    const again = await runSet({
      dir,
      context: second.context,
      guard: guardStub().guard,
      ledger: ledgerIn(dir),
      now: instant,
    });
    expect(second.bodies).toHaveLength(16);
    expect(again.answered).toBe(16);
  });

  it("leaves an image pending when the process stops after sending it, and a rerun does not resend it", async () => {
    const dir = freshSet();
    const { guard } = guardStub();
    let calls = 0;
    let reached!: () => void;
    const third = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const hanging = context(async () => {
      if (++calls === 3) {
        reached();
        return new Promise<Response>(() => {}); // the process dies here, the answer never stored
      }
      return reply(answerText(false));
    });
    void runSet({ dir, context: { ...hanging.context }, guard, ledger: ledgerIn(dir, "run-a"), now: instant });
    await third;
    expect(readResults(dir)?.results.map((r) => r.status)).toEqual(["answered", "answered", "pending"]);
    // While it runs, a second run of the same results file is refused before any request.
    const second = context(async () => reply(answerText(false)));
    const refused = await runSet({
      dir,
      context: second.context,
      guard: guardStub().guard,
      ledger: ledgerIn(dir, "run-a"),
      now: instant,
    });
    expect(refused.stopped).toMatch(/being run already/);
    expect(second.bodies).toHaveLength(0);
    expect(readResults(dir)?.results.map((r) => r.status)).toEqual(["answered", "answered", "pending"]);
    // The process dies: a dead holder's lock is reclaimed (takeLock), here removed as the reclaim would.
    rmSync(join(dir, `${RESULTS}.lock`));
    const rerun = context(async () => reply(answerText(false)));
    const report = await runSet({
      dir,
      context: rerun.context,
      guard: guardStub().guard,
      ledger: ledgerIn(dir, "run-a"),
      now: instant,
    });
    expect(report.ambiguous).toEqual(["inv-02-twin.jpg"]);
    expect(rerun.bodies).toHaveLength(17);
    const retried = context(async () => reply(answerText(false)));
    await runSet({
      dir,
      context: retried.context,
      guard: guardStub().guard,
      ledger: ledgerIn(dir, "run-a"),
      retryPending: true,
      now: instant,
    });
    expect(retried.bodies).toHaveLength(1);
    // The interrupted attempt is kept and counted at its estimate beside the retry's measured cost.
    const retriedOutcome = readResults(dir)?.results.find((r) => r.file === "inv-02-twin.jpg");
    expect(retriedOutcome?.attempts).toBe(2);
    expect(retriedOutcome?.calls.map((c) => c.state)).toEqual(["reserved", "settled"]);
    expect(retriedOutcome?.uncertainUsd).toBe(retriedOutcome?.calls[0]?.estimateUsd);
    expect(retriedOutcome?.usd).toBeCloseTo((2000 * PRICES.input + 1000 * PRICES.output) / 1e6, 12);
  });

  it("never reuses a refused attempt's id on a rerun the same day", async () => {
    const dir = freshSet();
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, images: manifest.images.slice(0, 1) }));
    const refusing = guardStub(1);
    const first = context(async () => reply(answerText(false)));
    await runSet({ dir, context: first.context, guard: refusing.guard, ledger: ledgerIn(dir), now: instant });
    const { guard, rows } = guardStub();
    const second = context(async () => reply(answerText(false)));
    await runSet({ dir, context: second.context, guard, ledger: ledgerIn(dir), now: instant });
    const ids = readLedger(join(dir, "meta-spend.json")).map((e) => e.call);
    expect(ids).toEqual(["inv-01-twin.jpg#1", "inv-01-twin.jpg#2"]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(readResults(dir)?.results[0]?.status).toBe("answered");
  });

  it("sends no repair once a settlement could not be written, even when the ledger recovers", async () => {
    const dir = freshSet();
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, images: manifest.images.slice(0, 1) }));
    const ledger = ledgerIn(dir);
    let failures = 1;
    const flaky = {
      ...ledger,
      settle: async (id: string, usd: number) =>
        failures-- > 0 ? Promise.reject(new Error("ENOSPC")) : ledger.settle(id, usd),
    };
    const { bodies, context: ctx } = context(async () => reply("not json"));
    const report = await runSet({ dir, context: ctx, guard: guardStub().guard, ledger: flaky, now: instant });
    expect(bodies).toHaveLength(1);
    expect(report.stopped).toMatch(/accounting.*ENOSPC/);
  });

  it("sends no repair once the guard's own settlement failed, even when D1 recovers", async () => {
    const dir = freshSet();
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, images: manifest.images.slice(0, 1) }));
    const { guard } = guardStub();
    const settle = guard.settle;
    let failures = 1;
    guard.settle = async (id, actual, record) =>
      failures-- > 0 ? Promise.reject(new Error("D1 unreachable")) : settle(id, actual, record);
    const { bodies, context: ctx } = context(async () => reply("not json"));
    const report = await runSet({ dir, context: ctx, guard, ledger: ledgerIn(dir), now: instant });
    expect(bodies).toHaveLength(1);
    expect(report.stopped).toMatch(/accounting.*budget guard: D1 unreachable/);
  });

  it("stops after an answer whose settlement the ledger could not write, keeping it at its estimate", async () => {
    const dir = freshSet();
    const ledger = ledgerIn(dir);
    const failing = { ...ledger, settle: async () => Promise.reject(new Error("disk full")) };
    const { bodies, context: ctx } = context(async () => reply(answerText(false)));
    const report = await runSet({ dir, context: ctx, guard: guardStub().guard, ledger: failing, now: instant });
    expect(report.stopped).toMatch(/accounting.*disk full/);
    expect(bodies).toHaveLength(1);
    const outcome = readResults(dir)?.results[0];
    expect(outcome).toMatchObject({ status: "answered", usd: 0, attempts: 1 });
    expect(outcome?.uncertainUsd).toBeGreaterThan(0);
  });

  it("keeps each attempt's tokens and log id, so its cost recomputes at the stored prices", async () => {
    const dir = freshSet();
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, images: manifest.images.slice(0, 1) }));
    const { context: ctx } = context(async () => reply(answerText(false)));
    await runSet({ dir, context: ctx, guard: guardStub().guard, ledger: ledgerIn(dir), now: instant });
    const stored = readResults(dir) as ResultsFile;
    expect(stored.prices).toEqual(PRICES);
    const call = stored.results[0]?.calls[0];
    expect(call).toMatchObject({ inputTokens: 2000, outputTokens: 1000, logId: "log-1", state: "settled" });
    expect(recomputed(call as never, stored.prices)).toBeCloseTo(call?.usd as number, 12);
  });

  it("measures afresh into another results file, leaving the published one unchanged", async () => {
    const dir = freshSet();
    const first = context(async () => reply(answerText(false)));
    await runSet({ dir, context: first.context, guard: guardStub().guard, ledger: ledgerIn(dir, "a"), now: instant });
    const published = readFileSync(join(dir, RESULTS), "utf-8");
    const fresh = context(async () => reply(answerText(true)));
    const report = await runSet({
      dir,
      results: "results-2.json",
      context: fresh.context,
      guard: guardStub().guard,
      ledger: ledgerIn(dir, "b"),
      now: instant,
    });
    expect(report.answered).toBe(20);
    expect(fresh.bodies).toHaveLength(20);
    expect(readFileSync(join(dir, RESULTS), "utf-8")).toBe(published);
    expect(readResults(dir, "results-2.json")?.results.every((r) => r.answer?.edited)).toBe(true);
  });

  it("refuses results priced at other rates than the client's", async () => {
    const dir = freshSet();
    writeFileSync(
      join(dir, RESULTS),
      JSON.stringify({ fingerprint: fingerprint(manifest), prices: { ...PRICES, output: 1 }, results: [] }),
    );
    const { bodies, context: ctx } = context(async () => reply(answerText(false)));
    const report = await runSet({ dir, context: ctx, guard: guardStub().guard, ledger: ledgerIn(dir), now: instant });
    expect(report.stopped).toMatch(/other rates/);
    expect(bodies).toHaveLength(0);
  });

  it("records an output failure as failed with its kind, never resent", async () => {
    const dir = freshSet();
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, images: manifest.images.slice(0, 1) }));
    const { context: ctx } = context(async () => reply("not json"));
    await runSet({ dir, context: ctx, guard: guardStub().guard, ledger: ledgerIn(dir), now: instant });
    expect(readResults(dir)?.results[0]).toMatchObject({ status: "failed", failure: "output-invalid", attempts: 2 });
    const again = context(async () => reply(answerText(true)));
    await runSet({ dir, context: again.context, guard: guardStub().guard, ledger: ledgerIn(dir), now: instant });
    expect(again.bodies).toHaveLength(0);
  });
});

describe("stored results that do not match", () => {
  const outcome = (file: string) => ({
    file,
    status: "answered" as const,
    answer: { edited: false, confidence: 0.1, regions: [] },
    failure: null,
    ms: 1000,
    usd: 0.01,
    uncertainUsd: 0,
    attempts: 1,
    calls: [],
    at: "2026-10-31T10:00:00Z",
  });
  const complete = (): ResultsFile => ({
    fingerprint: fingerprint(manifest),
    prices: PRICES,
    results: manifest.images.map((e) => outcome(e.file)),
  });
  const cases: [string, (dir: string) => void, RegExp, boolean][] = [
    [
      "another fingerprint",
      (d) => writeFileSync(join(d, "results.json"), JSON.stringify({ ...complete(), fingerprint: "0".repeat(64) })),
      /fingerprint/,
      true,
    ],
    [
      "a duplicate file",
      (d) =>
        writeFileSync(
          join(d, "results.json"),
          JSON.stringify({ ...complete(), results: [...complete().results, outcome("inv-01-twin.jpg")] }),
        ),
      /more than one/,
      true,
    ],
    [
      "an unknown file",
      (d) =>
        writeFileSync(
          join(d, "results.json"),
          JSON.stringify({ ...complete(), results: [...complete().results, outcome("inv-99-twin.jpg")] }),
        ),
      /not in the manifest/,
      true,
    ],
    [
      "a changed image",
      (d) => {
        writeFileSync(join(d, "results.json"), JSON.stringify(complete()));
        writeFileSync(join(d, "inv-01-twin.jpg"), Buffer.from("changed"));
      },
      /hash/,
      true,
    ],
    [
      "a malformed answer",
      (d) =>
        writeFileSync(
          join(d, "results.json"),
          JSON.stringify({ ...complete(), results: [{ ...outcome("inv-01-twin.jpg"), answer: { edited: "yes" } }] }),
        ),
      /malformed/,
      true,
    ],
    [
      "a missing image",
      (d) =>
        writeFileSync(join(d, "results.json"), JSON.stringify({ ...complete(), results: complete().results.slice(1) })),
      /no outcome/,
      false,
    ],
  ];
  for (const [name, plant, problem, byRun] of cases) {
    it(`refuses ${name}${byRun ? " in run and score" : " in score"}`, async () => {
      const dir = freshSet();
      plant(dir);
      const scored = await scoreSet(dir);
      expect("problems" in scored && scored.problems.join("; ")).toMatch(problem);
      if (byRun) {
        const { bodies, context: ctx } = context(async () => reply(answerText(false)));
        const report = await runSet({
          dir,
          context: ctx,
          guard: guardStub().guard,
          ledger: ledgerIn(dir),
          now: instant,
        });
        expect(report.stopped).toMatch(problem);
        expect(bodies).toHaveLength(0);
      }
    });
  }
  it("accepts a complete matching set", () => {
    expect(resultProblems(complete(), manifest, true)).toEqual([]);
  });
});

describe("the baseline", () => {
  it("is error-level analysis against a threshold fixed before the run", async () => {
    expect(BASELINE_Z).toBe(3);
    const twin = await baselineDigits(readFileSync(join(setDir, "inv-01-twin.jpg")));
    const edit = await baselineDigits(readFileSync(join(setDir, "inv-01-edited.jpg")));
    for (const r of [twin, edit]) {
      expect(Number.isFinite(r.z)).toBe(true);
      expect(r.flagged).toBe(r.z > BASELINE_Z);
    }
    expect(twin.level).not.toBe(edit.level); // it reads the box, which differs
  });

  it("measures z against the page's own spread, its floor never swamping it", async () => {
    for (const e of manifest.images) {
      const r = await baselineDigits(readFileSync(join(setDir, e.file)));
      expect(r.spread).toBeGreaterThan(BASELINE_MIN_SPREAD * r.mean);
      expect(r.z).toBeCloseTo((r.level - r.mean) / r.spread, 10);
    }
  });
});

// A fixed set of outcomes: Spark detects the edits of the first 4 pairs (font, spacing, recompress, font), misses the rest, raises
// one false alarm on inv-05's twin, fails on inv-10's edit; the baseline flags 2 edits and no twin.
function fixedResults(): { stored: ResultsFile; baseline: Record<string, boolean> } {
  const results = manifest.images.map((e, i) => {
    const pair = Math.floor(i / 2);
    const edited = e.edited ? pair < 4 : pair === 4;
    const failed = e.file === "inv-10-edited.jpg";
    return {
      file: e.file,
      status: failed ? ("failed" as const) : ("answered" as const),
      answer: failed
        ? null
        : {
            edited,
            confidence: 0.5,
            regions: edited ? [{ field: (pair === 3 ? "amount" : "account_number") as "amount", reason: "r" }] : [],
          },
      failure: failed ? "output-invalid" : null,
      ms: (i + 1) * 1000,
      // One attempt each at 4,000 input tokens (US$0.005); the first left reserved at a US$0.04 estimate.
      usd: i === 0 ? 0 : 0.005,
      uncertainUsd: i === 0 ? 0.04 : 0,
      attempts: 1,
      calls: [
        {
          call: `${e.file}#1`,
          ledgerId: `ledger:${i}`,
          state: i === 0 ? ("reserved" as const) : ("settled" as const),
          estimateUsd: 0.04,
          usd: i === 0 ? null : 0.005,
          inputTokens: i === 0 ? null : 4000,
          cachedTokens: i === 0 ? null : 0,
          outputTokens: i === 0 ? null : 0,
          logId: null,
        },
      ],
      at: "2026-10-31T10:00:00Z",
    };
  });
  const baseline = Object.fromEntries(
    manifest.images.map((e) => [e.file, e.edited && ["inv-01-edited.jpg", "inv-03-edited.jpg"].includes(e.file)]),
  );
  return { stored: { fingerprint: fingerprint(manifest), prices: PRICES, results }, baseline };
}

describe("the score", () => {
  it("counts a fixed set to exact numbers", () => {
    const { stored, baseline } = fixedResults();
    const score = scoreDigits(manifest, stored, baseline);
    expect(score).toMatchObject({
      images: 20,
      answered: 19,
      failed: 1,
      pending: 0,
      detected: 4,
      edited: 10,
      accountNamed: 3,
      falseAlarms: 1,
      twins: 10,
      correct: 4 + 9,
      costUsd: 0.095,
      uncertainUsd: 0.04,
      // inv-04's detection names the amount, and inv-05's false alarm names the account: two unsupported regions.
      unsupportedRegions: 2,
      unsupportedAnswers: 2,
      attempts: 20,
      reconstructed: 19,
      baseline: { detected: 2, falseAlarms: 0 },
    });
    expect(score.accuracy).toBeCloseTo(13 / 20, 10);
    expect(score.detectedByKind).toEqual({ font: [2, 4], spacing: [1, 3], recompress: [1, 3] });
    // 19 answered at 1..20 s with the failed 20th left out: median the 10th, worst the 19th.
    expect([score.medianMs, score.worstMs]).toEqual([10_000, 19_000]);
  });

  it("decides by the rule set before the run", () => {
    const base = scoreDigits(manifest, fixedResults().stored, fixedResults().baseline);
    const at = (change: Partial<Score>): Score => ({ ...base, ...change });
    expect(
      decide(at({ detected: 9, accountNamed: 8, falseAlarms: 1, baseline: { detected: 2, falseAlarms: 0 } })),
    ).toBe("feature");
    expect(decide(at({ detected: 9, accountNamed: 6, falseAlarms: 0 }))).toBe("open question");
    expect(decide(at({ detected: 2, baseline: { detected: 2, falseAlarms: 0 } }))).toBe("cut");
    expect(decide(at({ detected: 9, accountNamed: 9, falseAlarms: 3 }))).toBe("cut");
    expect(decide(at({ detected: 6, accountNamed: 6, falseAlarms: 0 }))).toBe("open question");
  });
});

describe("the log check", () => {
  const score = () => scoreDigits(manifest, fixedResults().stored, fixedResults().baseline);
  const entry = (s: Score, extra = "") =>
    [
      "# Frontier log",
      "",
      "## 2026-10-31: Can Spark see edited invoice digits from the image alone?",
      "",
      "- Instruction: `INSTRUCTION` in `eval/frontier/digits.ts`",
      ...scoreLines(s).map((line) => `- ${line}`),
      `- ${LIMITATION}`,
      extra,
    ].join("\n");

  it("passes an entry carrying every field", () => {
    expect(checkLog(entry(score()), score())).toBeNull();
  });

  it("fails an entry missing or changing any one field, naming it", () => {
    const s = score();
    const full = entry(s);
    for (const line of [...scoreLines(s), LIMITATION, "eval/frontier/digits.ts"]) {
      const without = full.replace(line, "");
      expect(checkLog(without, s), line).toMatch(/lacks|no `## 2026-` entry/);
    }
    expect(checkLog(full.replace("False alarms: 1/10", "False alarms: 0/10"), s)).toMatch(/False alarms/);
    expect(checkLog(full.replace("## 2026-10-31", "## Draft"), s)).toMatch(/no `## 2026-` entry/);
  });

  it("fails an entry that also claims another model or effort", () => {
    const s = score();
    expect(checkLog(entry(s, "- Rerun with muse-spark-1.2 for comparison"), s)).toMatch(/another model/);
    expect(checkLog(entry(s, "- At reasoning effort low it took 4 s"), s)).toMatch(/another model or setting/);
  });

  it("fails an entry whose inputs or settings line is missing", () => {
    const s = score();
    const lines = scoreLines(s);
    for (const prefix of ["Inputs:", "Model and settings:", "Unsupported regions:"]) {
      const line = lines.find((l) => l.startsWith(prefix)) as string;
      expect(checkLog(entry(s).replace(line, ""), s), prefix).toMatch(/lacks/);
    }
  });

  it("fails while an image has no outcome", () => {
    const { stored, baseline } = fixedResults();
    stored.results = stored.results.slice(1);
    const s = scoreDigits(manifest, stored, baseline);
    expect(checkLog(entry(s), s)).toMatch(/19 of 20/);
  });

  it("requires a resolving follow-up section for a feature decision", () => {
    const { stored, baseline } = fixedResults();
    for (const r of stored.results)
      if (r.answer) {
        const e = manifest.images.find((m) => m.file === r.file);
        r.answer = {
          edited: Boolean(e?.edited),
          confidence: 0.9,
          regions: e?.edited ? [{ field: "account_number", reason: "r" }] : [],
        };
      }
    const s = scoreDigits(manifest, stored, baseline);
    expect(decide(s)).toBe("feature");
    expect(checkLog(entry(s), s, () => true)).toMatch(/follow-up/);
    expect(checkLog(entry(s, "- Filed: D06 T01 §9"), s, (ref) => ref === "D06 T01 §9")).toBeNull();
    expect(checkLog(entry(s, "- Filed: D06 T01 §99"), s, () => false)).toMatch(/follow-up/);
  });
});
