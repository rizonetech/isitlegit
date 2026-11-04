import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { StructuredContext } from "../../src/meta/structured";
import { ScreenResult } from "../../src/monitor/ablation-results";
import { secondLook } from "../../src/monitor/second-look";
import { targetOf } from "../../src/vision/glimmer-caps";
import {
  BrandFreePageAnswer,
  buildScreenRequest,
  type PageAnswer,
  SCREENER_SYSTEM_PROMPT_V1_1,
  screened,
} from "../../src/vision/page-screen";
import { type GlimmerSession, screenPage } from "../../src/vision/screen";
import { glimmerBody, readAnswer } from "../../src/vision/screen-request";

// Worker setup imports the workflow first; isolate the selected-version contract.
vi.hoisted(() => vi.resetModules());

vi.mock("../../src/vision/glimmer-caps.ts", async (original) => {
  const actual = await original<typeof import("../../src/vision/glimmer-caps")>();
  return { ...actual, DEPLOYED: actual.targetOf("1.1") };
});
const fallback = vi.hoisted(() => ({ calls: [] as unknown[][], answer: {} as unknown }));
vi.mock("../../src/meta/structured.ts", async (original) => {
  const actual = await original<typeof import("../../src/meta/structured")>();
  return {
    ...actual,
    structured: async (schema: typeof PageAnswer, request: unknown, ctx: unknown) => {
      fallback.calls.push([schema, request, ctx]);
      return { value: schema.parse(fallback.answer), callId: "call1", logId: null };
    },
  };
});
const answer = {
  has_login_form: true,
  has_payment_form: false,
  lure: true,
  lure_type: "credential" as const,
  confidence: 0.9,
};
const request = () =>
  buildScreenRequest({ host: "example.test", text: "Untrusted page", mode: "text-only", brandAsTruth: false });
const legacy = { ...answer, brand: "Example" };

describe("version-bound Loupe 1.1 serving", () => {
  it("uses the exact trained prompt and strict five-field schema", () => {
    expect(createHash("sha256").update(SCREENER_SYSTEM_PROMPT_V1_1).digest("hex")).toBe(
      "c0de39473966340136e2ef543ae4c8141b1b612e32cbae3eb23864e6b38e0232",
    );
    const body = glimmerBody(request(), targetOf("1.1"));
    expect(() => glimmerBody(request(), targetOf("1.0"))).toThrow("prompt does not match");
    expect(() => readAnswer(JSON.stringify(answer), "1.2")).toThrow("Unsupported");
    expect(body.messages[0]?.content).toBe(SCREENER_SYSTEM_PROMPT_V1_1);
    expect(body.response_format.json_schema.schema.required).not.toContain("brand");
    expect(readAnswer(JSON.stringify(answer), "1.1")).toEqual(answer);
    for (const value of [
      legacy,
      { ...answer, brand: null },
      { ...answer, confidence: "0.9" },
      { ...answer, lure_type: "none" },
      { ...answer, screener: "glimmer" },
    ])
      expect(readAnswer(JSON.stringify(value), "1.1")).toBeNull();
    expect(readAnswer(JSON.stringify(legacy), "1.0")).toEqual(legacy);
    expect(readAnswer(JSON.stringify(answer), "1.0")).toBeNull();
  });
  it("persists only runtime-owned version metadata, never an invented brand", () => {
    const s = screened(answer, "glimmer", "1.1");
    expect(s).toEqual({ ...answer, screener: "glimmer", answer_version: "1.1" });
    expect("brand" in s).toBe(false);
    expect(() => screened(legacy, "glimmer", "1.1")).toThrow();
    expect(screened(legacy, "glimmer", "1.0")).toEqual({ ...legacy, screener: "glimmer" });
    const result = {
      ok: true,
      screen: s,
      glimmer_reason: null,
      spark_call: null,
      tier: "glimmer",
      escalation: null,
      spark_calls: [],
    };
    expect(ScreenResult.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(ScreenResult.safeParse({ ...result, screen: { ...s, brand: null } }).success).toBe(false);
  });
  it("screens 1.1 and uses the same strict schema and prompt on fallback", async () => {
    const bodies: Record<string, unknown>[] = [];
    let content: unknown = answer;
    const session: GlimmerSession = {
      ctx: {
        env: {
          FIREWORKS_API_KEY: "fixture",
          CF_AIG_TOKEN: "fixture",
          GLIMMER_GATEWAY_URL: "https://gateway.test/v1/a/test/custom-fireworks/v1",
        },
        ledger: {} as never,
        burstId: "fixture",
        calls: 1,
        callSeconds: 10,
        now: () => 1000,
        fetcher: (async (_url: unknown, init: RequestInit) => {
          bodies.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
        }) as typeof fetch,
      },
      burst: null,
      state: "ready",
      reservedUntil: 100000,
      lastRequestEnd: null,
    };
    const page = { host: "example.test", text: "Untrusted page", mode: "text-only" as const };
    fallback.calls = [];
    fallback.answer = answer;
    const result = await screenPage(page, session, {} as Omit<StructuredContext, "owner">, "fixture-run");
    expect(result).toMatchObject({ ok: true, tier: "glimmer", screen: { answer_version: "1.1" } });
    expect(fallback.calls).toHaveLength(0);
    expect((bodies[0]?.messages as { content: string }[] | undefined)?.[0]?.content).toBe(SCREENER_SYSTEM_PROMPT_V1_1);
    content = { ...answer, brand: null };
    const repaired = await screenPage(page, session, {} as Omit<StructuredContext, "owner">, "fixture-run");
    expect(repaired).toMatchObject({
      ok: true,
      tier: "spark",
      glimmer_reason: "schema",
      screen: { answer_version: "1.1" },
    });
    expect(fallback.calls[0]?.[0]).toBe(BrandFreePageAnswer);
    expect(fallback.calls[0]?.[1]).toMatchObject({ instructions: SCREENER_SYSTEM_PROMPT_V1_1 });
    fallback.answer = { ...answer, brand: null };
    expect(await screenPage(page, session, {} as Omit<StructuredContext, "owner">, "fixture-run")).toMatchObject({
      ok: false,
    });
  });
  it("confirms monitor flags through the version-bound second look and preserves flags on invalid output", async () => {
    const page = { host: "example.test", text: "Untrusted page", mode: "text-only" as const };
    fallback.calls = [];
    fallback.answer = answer;
    expect(await secondLook(page, "fixture-run", {} as Omit<StructuredContext, "owner">)).toMatchObject({
      verdict: "confirmed",
    });
    expect(fallback.calls[0]?.[0]).toBe(BrandFreePageAnswer);
    expect(fallback.calls[0]?.[1]).toMatchObject({ instructions: SCREENER_SYSTEM_PROMPT_V1_1 });
    fallback.answer = { ...answer, brand: null };
    expect(await secondLook(page, "fixture-run", {} as Omit<StructuredContext, "owner">)).toMatchObject({
      verdict: "unavailable",
    });
  });
});
