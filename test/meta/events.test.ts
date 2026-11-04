import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { caseCost, d1Budget, markUnsettled } from "../../src/meta/budget";
import { DAY_CAP_USD } from "../../src/meta/caps";
import { type MetaContext, metaRaw, metaResponses } from "../../src/meta/client";
import type { Owner } from "../../src/meta/guard";

// Each Meta call's record (D03 T01 §3): the real client, through a stubbed transport, into the migrated D1's
// model_spend rows. Every path leaves its record; no prompt or response is ever written.
const db = (env as unknown as Env).DB;
const META = { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" };
const MARKER = "MARKER-7f3a-do-not-store";

beforeEach(async () => {
  await db.prepare("DELETE FROM model_spend").run();
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", "x-request-id": "req-1", ...headers },
  });

// A transport answering from a script after a short pause, so a recorded latency is measured, not constant.
function context(owner: Owner, ...script: (() => Response)[]): MetaContext {
  let i = 0;
  return {
    env: META,
    owner,
    budget: d1Budget(db, { caller: "test" }),
    random: () => 0.5,
    sleep: async () => {},
    fetch: (async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const next = script[Math.min(i++, script.length - 1)];
      if (!next) throw new Error("no answer");
      return next();
    }) as typeof fetch,
  };
}

const rows = async () =>
  (await db.prepare("SELECT * FROM model_spend ORDER BY attempt, at").all<Record<string, unknown>>()).results;

const CASE: Owner = { kind: "case", caseId: "01HZCASEAAAAAAAAAAAAAAAAAA", step: "checks" };

describe("the record of each call", () => {
  it("records a Responses call's tokens, ids, owner, latency and measured cost, and no content", async () => {
    const usage = { input_tokens: 120, input_tokens_details: { cached_tokens: 20 }, output_tokens: 30 };
    const ok = () =>
      json(200, {
        id: "r",
        object: "response",
        output: [{ type: "message", content: [{ type: "output_text", text: MARKER }] }],
        usage,
      });
    await metaResponses({ model: "muse-spark-1.3", input: MARKER, max_output_tokens: 64 }, context(CASE, ok));
    const [row] = await rows();
    expect(row).toMatchObject({
      owner: "case",
      case_id: CASE.caseId,
      step: "checks",
      model: "muse-spark-1.3",
      attempt: 1,
      input_tokens: 120,
      cached_tokens: 20,
      output_tokens: 30,
      log_id: "log-1",
      request_id: "req-1",
      outcome: "ok",
      state: "settled",
      cost_certainty: "measured",
      cost_source: "meta-usage",
    });
    expect(row?.ms as number).toBeGreaterThanOrEqual(25);
    expect(row?.actual_usd).toBeCloseTo((100 * 1.25 + 20 * 0.15 + 30 * 4.25) / 1_000_000);
    for (const value of Object.values(row ?? {})) expect(String(value)).not.toContain(MARKER);
  });

  it("marks a missing usage estimated, a lost answer an estimated error, and a 4xx a refusal costing nothing", async () => {
    await metaResponses(
      { model: "muse-spark-1.3", input: "x", max_output_tokens: 16 },
      context(CASE, () => json(200, { id: "r", object: "response", output: [] })),
    );
    await metaResponses(
      { model: "muse-spark-1.3", input: "x", max_output_tokens: 16 },
      context(CASE, () => {
        throw new TypeError("network connection lost");
      }),
    ).catch(() => null);
    await metaResponses(
      { model: "muse-spark-1.3", input: "x", max_output_tokens: 16 },
      context(CASE, () =>
        json(400, { error: { type: "invalid_request_error", code: null, param: null, message: MARKER } }),
      ),
    ).catch(() => null);
    const got = (await rows()).map((r) => [r.outcome, r.state, r.cost_certainty]);
    expect(got).toEqual(
      expect.arrayContaining([
        ["ok", "settled", "estimated"],
        ["error", "uncertain", "estimated"],
        ["refused", "settled", "none"],
      ]),
    );
    for (const row of await rows()) for (const value of Object.values(row)) expect(String(value)).not.toContain(MARKER);
  });

  it("keeps a 503 then a success as two attempts of one call", async () => {
    const busy = () => json(503, { error: { type: "server_error", code: null, param: null, message: "busy" } });
    const ok = () =>
      json(200, { id: "r", object: "response", output: [], usage: { input_tokens: 5, output_tokens: 1 } });
    await metaResponses({ model: "muse-spark-1.3", input: "x", max_output_tokens: 16 }, context(CASE, busy, ok));
    const got = await rows();
    expect(got.map((r) => [r.attempt, r.outcome, r.cost_certainty])).toEqual([
      [1, "error", "estimated"],
      [2, "ok", "measured"],
    ]);
    expect(new Set(got.map((r) => r.call_id)).size).toBe(1);
  });

  it("records a transcription and an image edit through the raw endpoints, and a monitor's call without a case", async () => {
    const monitor: Owner = { kind: "monitor", run: "run-1", host: "pay-portal.example", step: "screen" };
    await metaRaw(
      "/asr/transcribe",
      { request: { model: "muse-voice-transcribe-1.0" }, audio: new Blob([new Uint8Array(1000)]), audioSeconds: 2 },
      context(CASE, () => json(200, { transcript: "x", audioDurationMs: 2_400 })),
    );
    await metaRaw(
      "/images/edits",
      { model: "muse-image-1.0", prompt: "x" },
      context(monitor, () => json(200, { data: [{ b64_json: "AA" }] })),
    );
    const got = await rows();
    const transcription = got.find((r) => r.model === "muse-voice-transcribe-1.0");
    const edit = got.find((r) => r.model === "muse-image-1.0");
    // Each row whole, as the trace reads it (final review): ids, latency, the billable units and the cost's certainty.
    expect(transcription).toMatchObject({
      owner: "case",
      outcome: "ok",
      cost_certainty: "measured",
      log_id: "log-1",
      request_id: "req-1",
      audio_seconds: 2.4,
      images: null,
    });
    expect(edit).toMatchObject({
      owner: "monitor",
      case_id: null,
      monitor_run: "run-1",
      host: "pay-portal.example",
      step: "screen",
      outcome: "ok",
      cost_certainty: "measured",
      log_id: "log-1",
      request_id: "req-1",
      images: 1,
      audio_seconds: null,
    });
    for (const row of [transcription, edit]) expect(row?.ms as number).toBeGreaterThanOrEqual(25);
  });
});

describe("a record whose settlement could not be written", () => {
  it("stays counted at its estimate, and the sweep marks it an unsettled error after an hour", async () => {
    const ctx = context(CASE, () =>
      json(200, { id: "r", object: "response", output: [], usage: { input_tokens: 1, output_tokens: 1 } }),
    );
    const failing = { ...ctx.budget, settle: async () => Promise.reject(new Error("D1 down")) };
    await metaResponses({ model: "muse-spark-1.3", input: "x", max_output_tokens: 16 }, { ...ctx, budget: failing });
    expect((await rows())[0]).toMatchObject({ state: "reserved", cost_certainty: "estimated" });
    expect(await markUnsettled(db, new Date(Date.now() + 2 * 60 * 60_000))).toBe(1);
    expect((await rows())[0]).toMatchObject({ state: "uncertain", outcome: "error", error_class: "unsettled" });
    expect(await markUnsettled(db, new Date(Date.now() + 2 * 60 * 60_000))).toBe(0);
  });
});

describe("caseCost", () => {
  it("totals each case and monitor run apart, and never adds an estimate into the measured", async () => {
    const other: Owner = { kind: "case", caseId: "01HZCASEBBBBBBBBBBBBBBBBBB", step: "checks" };
    const monitor: Owner = { kind: "monitor", run: "run-2", host: "h.example", step: "screen" };
    const measured = () =>
      json(200, { id: "r", object: "response", output: [], usage: { input_tokens: 1000, output_tokens: 0 } });
    const unmeasured = () => json(200, { id: "r", object: "response", output: [] });
    await metaResponses({ model: "muse-spark-1.3", input: "x", max_output_tokens: 16 }, context(CASE, measured));
    await metaResponses({ model: "muse-spark-1.3", input: "x", max_output_tokens: 16 }, context(CASE, unmeasured));
    await metaResponses({ model: "muse-spark-1.3", input: "x", max_output_tokens: 16 }, context(other, measured));
    await metaResponses({ model: "muse-spark-1.3", input: "x", max_output_tokens: 16 }, context(monitor, measured));
    const one = await caseCost(db, { caseId: CASE.caseId });
    expect(one.measuredUsd).toBeCloseTo((1000 * 1.25) / 1_000_000);
    expect([one.estimatedCalls, one.attempts]).toEqual([1, 2]);
    expect(one.estimatedUsd).toBeGreaterThan(0);
    expect((await caseCost(db, { caseId: other.caseId })).attempts).toBe(1);
    expect((await caseCost(db, { monitorRun: "run-2" })).attempts).toBe(1);
  });
});

describe("completion review (2026-10-29)", () => {
  it("keeps a failed attempt's kind and the gateway's and Meta's ids, on every retry", async () => {
    const busy = () =>
      json(
        503,
        { error: { type: "server_error", code: null, param: null, message: "busy" } },
        { "cf-aig-log-id": "log-9" },
      );
    await metaResponses(
      { model: "muse-spark-1.3", input: "x", max_output_tokens: 16 },
      context(CASE, busy, busy, busy),
    ).catch(() => null);
    await metaResponses(
      { model: "muse-spark-1.3", input: "x", max_output_tokens: 16 },
      context(CASE, () =>
        json(400, { error: { type: "invalid_request_error", code: null, param: null, message: "no" } }),
      ),
    ).catch(() => null);
    const got = (await rows()).map((r) => [r.outcome, r.error_class, r.log_id, r.request_id]);
    expect(got.filter((r) => r[0] === "error")).toEqual([
      ["error", "server", "log-9", "req-1"],
      ["error", "server", "log-9", "req-1"],
      ["error", "server", "log-9", "req-1"],
    ]);
    expect(got.filter((r) => r[0] === "refused")).toEqual([["refused", "invalid-request", "log-1", "req-1"]]);
  });

  it("labels a cost derived from the request estimated, never measured, and keeps its units", async () => {
    await metaResponses(
      { model: "sam-3.1", input: "x", max_output_tokens: 16 },
      context(CASE, () => json(200, { id: "r", object: "response", output: [] })),
    );
    await metaRaw(
      "/images/edits",
      { model: "muse-image-1.0", prompt: "x" },
      context(CASE, () => json(200, {})),
    );
    await metaRaw(
      "/asr/transcribe",
      { request: { model: "muse-voice-transcribe-1.0" }, audio: new Blob([new Uint8Array(100)]), audioSeconds: 2 },
      context(CASE, () => json(200, { transcript: "x", audioDurationMs: 2_400 })),
    );
    const byModel = Object.fromEntries((await rows()).map((r) => [r.model, r]));
    expect(byModel["sam-3.1"]).toMatchObject({ cost_certainty: "estimated", images: 1 });
    expect(byModel["muse-image-1.0"]).toMatchObject({ cost_certainty: "estimated", images: 1 });
    expect(byModel["muse-voice-transcribe-1.0"]).toMatchObject({ cost_certainty: "measured", audio_seconds: 2.4 });
  });
});

describe("final review (2026-10-29)", () => {
  it("records a refusal before the network, a cap's and the client's own, each costing nothing", async () => {
    await d1Budget(db, { caller: "earlier" }).reserve("muse-spark-1.3", DAY_CAP_USD, 1);
    await metaResponses({ model: "muse-spark-1.3", input: "x", max_output_tokens: 16 }, context(CASE)).catch(
      () => null,
    );
    await metaResponses({ model: "muse-spark-1.3", input: "x" } as never, context(CASE)).catch(() => null);
    await metaResponses({ model: "gpt-9", input: "x", max_output_tokens: 16 }, context(CASE)).catch(() => null);
    const refused = (await rows()).filter((r) => r.outcome === "refused");
    expect(refused.map((r) => [r.model, r.error_class, r.cost_certainty, r.actual_usd, r.case_id])).toEqual(
      expect.arrayContaining([
        ["muse-spark-1.3", "budget:day", "none", 0, CASE.caseId],
        ["muse-spark-1.3", "invalid-request", "none", 0, CASE.caseId],
        ["gpt-9", "refused-model", "none", 0, CASE.caseId],
      ]),
    );
    expect(refused).toHaveLength(3);
    expect((await caseCost(db, { caseId: CASE.caseId })).measuredUsd).toBe(0);
  });

  it("keeps a script owner's name, and never stores an id that is not identifier-shaped", async () => {
    const script: Owner = { kind: "script", name: "glimmer-teacher-label" };
    const odd = () =>
      json(
        200,
        { id: "r", object: "response", output: [], usage: { input_tokens: 1, output_tokens: 1 } },
        { "cf-aig-log-id": `x${" <>".repeat(200)}` },
      );
    await metaResponses({ model: "muse-spark-1.3", input: "x", max_output_tokens: 16 }, context(script, odd));
    expect((await rows())[0]).toMatchObject({ owner: "script", script: "glimmer-teacher-label", log_id: null });
  });

  it("writes a timed-out attempt's record before the call throws, so it is not left reserved", async () => {
    const stalled = () =>
      new Response(new ReadableStream({ start: () => {} }), {
        headers: { "content-type": "application/json", "cf-aig-log-id": "log-slow", "x-request-id": "req_slow" },
      });
    const ctx = { ...context(CASE, stalled), deadlineMs: 300 };
    await metaResponses({ model: "muse-spark-1.3", input: "x", max_output_tokens: 16 }, ctx).catch(() => null);
    expect((await rows())[0]).toMatchObject({ state: "uncertain", outcome: "error", cost_certainty: "estimated" });
  });
});
