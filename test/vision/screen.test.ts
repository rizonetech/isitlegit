import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { d1Budget } from "../../src/meta/budget";
import type { StructuredContext } from "../../src/meta/structured";
import { DEPLOYED_MODEL } from "../../src/vision/glimmer-caps";
import { d1Exec, findBurst, reserveBurst } from "../../src/vision/glimmer-minutes";
import type { WakeCtx } from "../../src/vision/glimmer-wake";
import { buildScreenRequest } from "../../src/vision/page-screen";
import { closeGlimmer, glimmerBody, openGlimmer, type Page, screenPage } from "../../src/vision/screen";
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
    expect(got).toEqual({ ok: true, screen: { ...LURE, screener: "glimmer" }, glimmer_reason: null, spark_call: null });
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
      expect(got).toEqual({ ok: false, glimmer_reason: "deployment_missing", spark_reason: reason });
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
    expect(got).toEqual({ ok: false, glimmer_reason: "deployment_missing", spark_reason: "budget" });
    expect(meta.bodies).toHaveLength(0);
  });
});
