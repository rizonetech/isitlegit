import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { d1Budget } from "../../src/meta/budget";
import type { StructuredContext } from "../../src/meta/structured";
import { DEPLOYED_MODEL, TAIL_MINUTES } from "../../src/vision/glimmer-caps";
import { d1Exec, dayMinutes, findBurst, reserveBurst } from "../../src/vision/glimmer-minutes";
import type { WakeCtx } from "../../src/vision/glimmer-wake";
import { buildScreenRequest } from "../../src/vision/page-screen";
import {
  closeGlimmer,
  ESCALATION_BAND,
  glimmerBody,
  inEscalationBand,
  openGlimmer,
  type Page,
  screenPage,
} from "../../src/vision/screen";
import { fakeJpeg } from "../fixtures/jpeg";

// The page screener (D03 T04 §1): Loupe through a stand-in Fireworks on the real runtime ledger (§14) and wake (§15),
// Spark through the real Meta client and budget on a stand-in transport.
const db = (env as unknown as Env).DB;
const ledger = d1Exec(db);
const FW = {
  FIREWORKS_API_KEY: "fw-key",
  GLIMMER_GATEWAY_URL: "https://gateway.test/v1/acct/isitlegit/custom-fireworks/v1",
  CF_AIG_TOKEN: "aig-token",
};
const META = { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" };
const NONCE = "0123456789abcdef0123456789abcdef";
const LURE = {
  brand: "Fynbos Freight",
  has_login_form: true,
  has_payment_form: false,
  lure: true,
  lure_type: "credential",
  confidence: 0.92,
};
const BENIGN = {
  brand: null,
  has_login_form: false,
  has_payment_form: false,
  lure: false,
  lure_type: "none",
  confidence: 0.8,
};
const PAGE: Page = {
  image: fakeJpeg(64, 48),
  text: "Sign in to Fynbos Freight",
  host: "fynbos-freight-login.example",
  mode: "image",
  nonce: NONCE,
};

beforeEach(async () => {
  await db.prepare("DELETE FROM glimmer_runtime").run();
  await db.prepare("DELETE FROM model_spend").run();
});

const completion = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), { status: 200 });
const SCALING = () => new Response(JSON.stringify({ error: { code: "DEPLOYMENT_SCALING_UP" } }), { status: 503 });

// Fireworks answering from a script: the first answer is the wake's, then one a request; the last repeats.
function fireworks(script: (() => Response | Promise<Response>)[], seen: (init: RequestInit) => void = () => {}) {
  const sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  let i = 0;
  const fetcher = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    seen(init);
    const next = script[Math.min(i++, script.length - 1)] as () => Response | Promise<Response>;
    return next();
  }) as unknown as typeof fetch;
  let t = Date.parse("2026-11-01T08:00:00Z");
  const ctx = (over: Partial<WakeCtx> = {}): WakeCtx => ({
    env: FW,
    ledger,
    burstId: "monitor-run-7",
    calls: 10,
    callSeconds: 10,
    fetcher,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    ...over,
  });
  return { ctx, sent, advance: (ms: number) => (t += ms) };
}

// Meta answering from a script, through the real client and the D1 budget.
function spark(...script: (() => Response)[]) {
  const bodies: Record<string, unknown>[] = [];
  let i = 0;
  const ctx: Omit<StructuredContext, "owner"> = {
    env: META,
    budget: d1Budget(db, { caller: "monitor" }),
    random: () => 0.5,
    sleep: async () => {},
    waitUntil: () => {},
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const next = script[Math.min(i++, script.length - 1)];
      if (!next) throw new Error("no answer");
      return next();
    }) as typeof fetch,
  };
  return { ctx, bodies };
}
const metaText = (body: string, status = "completed", type = "output_text") =>
  new Response(
    JSON.stringify({
      id: "r",
      object: "response",
      status,
      output: [
        {
          type: "message",
          role: "assistant",
          content: [type === "refusal" ? { type, refusal: body } : { type, text: body }],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
    { headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", "x-request-id": "req-1" } },
  );

describe("screenPage on Loupe", () => {
  it("sends the training request with the schema format, names the run and host, and returns Loupe's answer", async () => {
    const fw = fireworks([SCALING, () => completion(JSON.stringify(LURE))]);
    const session = await openGlimmer(fw.ctx());
    const meta = spark(() => metaText("{}"));
    const got = await screenPage(PAGE, session, meta.ctx, "monitor-run-7");
    expect(got).toEqual({
      ok: true,
      screen: { ...LURE, screener: "glimmer" },
      glimmer_reason: null,
      spark_call: null,
      tier: "glimmer",
      escalation: null,
      spark_calls: [],
    });
    const call = fw.sent.at(-1);
    const expected = buildScreenRequest({
      image: PAGE.image as Uint8Array,
      host: PAGE.host,
      text: PAGE.text,
      mode: "image",
      nonce: NONCE,
    });
    expect(call?.body).toEqual(JSON.parse(JSON.stringify(glimmerBody(expected))));
    expect(call?.body.model).toBe(DEPLOYED_MODEL);
    expect(call?.body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "page_screen" } });
    expect(JSON.parse(call?.headers["cf-aig-metadata"] ?? "{}")).toEqual({
      caller: "glimmer-screen",
      monitor_run: "monitor-run-7",
      host: "fynbos-freight-login.example",
    });
    expect(call?.headers["cf-aig-collect-log-payload"]).toBe("false");
    expect(meta.bodies).toHaveLength(0);
    expect(await closeGlimmer(session)).toMatchObject({ ok: true });
    expect((await findBurst(ledger, "monitor-run-7"))?.settled).toBe(true);
  });
});

describe("failing over to Spark", () => {
  const cases: [string, (() => Response | Promise<Response>)[], string][] = [
    // Warm (the wake answered), then the page's own request fails: a 500 during warm-up would be retried instead (§15).
    ["an error", [() => completion("p"), () => new Response("{}", { status: 500 })], "error"],
    ["an answer outside the schema", [SCALING, () => completion('{"lure": "maybe"}')], "schema"],
    ["a missing deployment", [() => new Response("{}", { status: 404 })], "deployment_missing"],
    ["a warm-up past its limit", [SCALING], "warming"],
  ];
  for (const [what, script, reason] of cases)
    it(`answers with Spark and the reason on ${what}`, async () => {
      const fw = fireworks(script);
      const session = await openGlimmer(fw.ctx());
      const meta = spark(() => metaText(JSON.stringify(BENIGN)));
      const got = await screenPage(PAGE, session, meta.ctx, "monitor-run-7");
      expect(got).toMatchObject({ ok: true, screen: { ...BENIGN, screener: "spark" }, glimmer_reason: reason });
      // Spark got the same host, untrusted text block and screenshot.
      const input = JSON.stringify(meta.bodies[0]?.input);
      expect(input).toContain("Host: fynbos-freight-login.example");
      expect(input).toContain(NONCE);
      expect(input).toContain("data:image/jpeg;base64,");
      expect(meta.bodies[0]?.model).toBe("muse-spark-1.3");
      // Spark answers at low effort with room to reason (completion review gap 1): at its default effort and 600
      // tokens it returned no text in 427 of 500 checks.
      expect(meta.bodies[0]).toMatchObject({ max_output_tokens: 2_000, reasoning: { effort: "low" } });
    });

  it("answers with Spark on a Loupe request that times out once warm", async () => {
    // A request that never answers until its signal aborts, as fetch does.
    let signal: AbortSignal | undefined;
    const hang = () =>
      new Promise<Response>((_d, fail) => signal?.addEventListener("abort", () => fail(signal?.reason)));
    const fw = fireworks([() => completion("p"), hang], (init) => {
      signal = init.signal ?? undefined;
    });
    const session = await openGlimmer(fw.ctx({ now: () => Date.now(), sleep: async () => {} }));
    const meta = spark(() => metaText(JSON.stringify(BENIGN)));
    const started = Date.now();
    const got = await screenPage(PAGE, session, meta.ctx, "monitor-run-7");
    expect(got).toMatchObject({ ok: true, glimmer_reason: "timeout", screen: { screener: "spark" } });
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  it("answers with Spark when the minutes ledger refuses the burst", async () => {
    await reserveBurst(ledger, {
      id: "earlier",
      at: new Date("2026-11-01T07:00:00Z"),
      source: "local",
      caller: "t",
      purpose: "warm-up",
      minutes: 85,
    });
    const fw = fireworks([() => completion(JSON.stringify(LURE))]);
    const session = await openGlimmer(fw.ctx());
    const got = await screenPage(PAGE, session, spark(() => metaText(JSON.stringify(LURE))).ctx, "monitor-run-7");
    expect(got).toMatchObject({ ok: true, glimmer_reason: "refused", screen: { screener: "spark" } });
    expect(fw.sent).toHaveLength(0);
  });

  // D03 T04 §40: a final answer whose settlement failed is settled again when the run closes its session, in both paths
  // that settle it (the wake's own first answer, and the warm-up wait inside the first page), to the answer's moment.
  it.each([
    ["the wake's first answer", [() => new Response("{}", { status: 401 })]],
    ["the warm-up wait inside the first page", [SCALING, () => new Response("{}", { status: 401 })]],
  ] as const)(
    "settles again at close a burst whose settlement failed in %s, to the same cutoff",
    async (_name, script) => {
      const fw = fireworks([...script]);
      let failing = true;
      const failingCtx = fw.ctx({
        ledger: async (statement) => {
          if (failing && statement.sql.includes("ON CONFLICT")) throw new Error("D1 unavailable");
          return ledger(statement);
        },
      });
      const session = await openGlimmer(failingCtx);
      // The warm-up path settles on the first page.
      await screenPage(PAGE, session, spark(() => metaText(JSON.stringify(LURE))).ctx, "monitor-run-7");
      expect(session.state).toEqual({ down: "unauthorized" });
      expect(session.unsettled).toBeDefined();
      expect((await findBurst(ledger, "monitor-run-7"))?.settled).toBe(false);
      const { burst, until } = session.unsettled as { burst: { wakeAt: number }; until: number };
      // The run closes a day later, with the ledger back: the charge is the answer's moment plus the tail, not the idle day.
      failing = false;
      fw.advance(24 * 3_600_000);
      expect(await closeGlimmer(session)).toMatchObject({ ok: true });
      expect((await findBurst(ledger, "monitor-run-7"))?.settled).toBe(true);
      expect(await dayMinutes(ledger, "2026-11-01")).toBeCloseTo((until - burst.wakeAt) / 60_000 + TAIL_MINUTES, 6);
    },
  );

  it("answers with Spark past the burst's reserved calls", async () => {
    const fw = fireworks([() => completion("p"), () => completion(JSON.stringify(LURE))]);
    const session = await openGlimmer(fw.ctx({ calls: 1, callSeconds: 10 }));
    fw.advance(10 * 60_000);
    const got = await screenPage(PAGE, session, spark(() => metaText(JSON.stringify(LURE))).ctx, "monitor-run-7");
    expect(got).toMatchObject({ ok: true, glimmer_reason: "out_of_window", screen: { screener: "spark" } });
  });

  it("returns a typed failure, never a guess, when Spark cannot answer either", async () => {
    for (const [answer, reason] of [
      [() => metaText("I cannot help with that.", "completed", "refusal"), "output-refused"],
      [() => metaText('{"brand":', "incomplete"), "output-incomplete"],
      [() => metaText('{"lure": "maybe"}'), "output-invalid"],
    ] as const) {
      await db.prepare("DELETE FROM glimmer_runtime").run();
      const fw = fireworks([() => new Response("{}", { status: 404 })]);
      const session = await openGlimmer(fw.ctx());
      const got = await screenPage(PAGE, session, spark(answer).ctx, "monitor-run-7");
      expect(got).toMatchObject({ ok: false, glimmer_reason: "deployment_missing", spark_reason: reason });
      expect(!got.ok && got.spark_calls).toHaveLength(1);
    }
  });

  it("returns a typed failure when Spark's budget refuses", async () => {
    await db
      .prepare(
        "INSERT INTO model_spend (id, at, day, source, caller, model, attempt, estimate_usd, state) VALUES ('x', ?1, ?2, 'worker', 't', 'muse-spark-1.3', 1, 1000, 'reserved')",
      )
      .bind(new Date().toISOString(), new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10))
      .run();
    const fw = fireworks([() => new Response("{}", { status: 404 })]);
    const session = await openGlimmer(fw.ctx());
    const meta = spark(() => metaText(JSON.stringify(LURE)));
    const got = await screenPage(PAGE, session, meta.ctx, "monitor-run-7");
    expect(got).toEqual({ ok: false, glimmer_reason: "deployment_missing", spark_reason: "budget", spark_calls: [] });
    expect(meta.bodies).toHaveLength(0);
  });
});

describe("confidence escalation (§45)", () => {
  const UNSURE_LURE = { ...LURE, confidence: 0.5 };
  const UNSURE_BENIGN = { ...BENIGN, confidence: 0.5 };
  const SURE_BENIGN = { ...BENIGN, confidence: 0.1 };
  const loupe = (answer: unknown) => fireworks([() => completion("p"), () => completion(JSON.stringify(answer))]);

  it("reads the band from the one constant, edges included", () => {
    expect(ESCALATION_BAND).toEqual({ low: 0.35, high: 0.65 });
    expect(inEscalationBand(0.35)).toBe(true);
    expect(inEscalationBand(0.65)).toBe(true);
    expect(inEscalationBand(0.9)).toBe(false);
    expect(inEscalationBand(0.1)).toBe(false);
  });

  it("never calls Spark for a sure Loupe answer, lure or benign", async () => {
    for (const answer of [LURE, SURE_BENIGN]) {
      const session = await openGlimmer(loupe(answer).ctx());
      const meta = spark(() => metaText(JSON.stringify(BENIGN)));
      const got = await screenPage(PAGE, session, meta.ctx, "monitor-run-7");
      expect(got).toMatchObject({ ok: true, tier: "glimmer", escalation: null, spark_calls: [] });
      expect(meta.bodies).toHaveLength(0);
    }
  });

  it("escalates an unsure Loupe answer to Spark and records the tier", async () => {
    const session = await openGlimmer(loupe(UNSURE_LURE).ctx());
    const meta = spark(() => metaText(JSON.stringify(LURE)));
    const got = await screenPage(PAGE, session, meta.ctx, "monitor-run-7");
    expect(got.ok && got.screen).toMatchObject({ screener: "spark", confidence: 0.92 });
    expect(got).toMatchObject({ tier: "spark", escalation: "loupe-unsure", glimmer_reason: "unsure" });
    expect(got.ok && got.spark_calls).toHaveLength(1);
    expect(meta.bodies).toHaveLength(1);
  });

  it("takes a second Spark pass when Spark is unsure, and settles on it", async () => {
    const session = await openGlimmer(loupe(UNSURE_LURE).ctx());
    const meta = spark(
      () => metaText(JSON.stringify(UNSURE_BENIGN)),
      () => metaText(JSON.stringify(SURE_BENIGN)),
    );
    const got = await screenPage(PAGE, session, meta.ctx, "monitor-run-7");
    expect(got).toMatchObject({ tier: "spark-second", escalation: "loupe-unsure" });
    expect(got.ok && got.screen.confidence).toBe(0.1);
    expect(got.ok && got.spark_calls).toHaveLength(2);
    expect(meta.bodies).toHaveLength(2);
  });

  it("settles on a second answer that is still unsure, with no third call", async () => {
    const session = await openGlimmer(loupe(UNSURE_LURE).ctx());
    const meta = spark(
      () => metaText(JSON.stringify(UNSURE_BENIGN)),
      () => metaText(JSON.stringify(UNSURE_LURE)),
      () => metaText(JSON.stringify(LURE)),
    );
    const got = await screenPage(PAGE, session, meta.ctx, "monitor-run-7");
    expect(got).toMatchObject({ ok: true, tier: "spark-second" });
    expect(meta.bodies).toHaveLength(2);
  });

  it("preserves every call reference when the second pass fails, the failed attempt included", async () => {
    const session = await openGlimmer(loupe(UNSURE_LURE).ctx());
    const meta = spark(
      () => metaText(JSON.stringify(UNSURE_BENIGN)),
      () => metaText("I cannot help with that.", "completed", "refusal"),
    );
    const got = await screenPage(PAGE, session, meta.ctx, "monitor-run-7");
    expect(got).toMatchObject({ ok: false, glimmer_reason: "unsure", spark_reason: "output-refused" });
    expect(!got.ok && got.spark_calls).toHaveLength(2);
    expect(!got.ok && new Set(got.spark_calls.map((c) => c.callId)).size).toBe(2);
  });

  it("never retries the transport inside a pass either: one 500 ends the pass with its call reference", async () => {
    const session = await openGlimmer(loupe(UNSURE_LURE).ctx());
    const meta = spark(
      () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 }),
      () => metaText(JSON.stringify(LURE)),
    );
    const got = await screenPage(PAGE, session, meta.ctx, "monitor-run-7");
    expect(got).toMatchObject({ ok: false, glimmer_reason: "unsure", spark_reason: "model-server" });
    expect(meta.bodies).toHaveLength(1);
    expect(!got.ok && got.spark_calls).toHaveLength(1);
    expect(!got.ok && got.spark_calls[0]?.callId).toEqual(expect.any(String));
  });

  it("never spends a schema repair inside a pass: the two-call ceiling counts attempts", async () => {
    const session = await openGlimmer(loupe(UNSURE_LURE).ctx());
    const meta = spark(
      () => metaText('{"lure": "maybe"}'),
      () => metaText(JSON.stringify(LURE)),
    );
    const got = await screenPage(PAGE, session, meta.ctx, "monitor-run-7");
    expect(got).toMatchObject({ ok: false, spark_reason: "output-invalid" });
    expect(meta.bodies).toHaveLength(1);
  });

  it("escalates a failover Spark answer that is unsure, recording spark-unsure", async () => {
    const fw = fireworks([() => new Response("{}", { status: 404 })]);
    const session = await openGlimmer(fw.ctx());
    const meta = spark(
      () => metaText(JSON.stringify(UNSURE_BENIGN)),
      () => metaText(JSON.stringify(SURE_BENIGN)),
    );
    const got = await screenPage(PAGE, session, meta.ctx, "monitor-run-7");
    expect(got).toMatchObject({
      ok: true,
      tier: "spark-second",
      escalation: "spark-unsure",
      glimmer_reason: "deployment_missing",
    });
  });
});
