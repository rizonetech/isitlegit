import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { d1Budget } from "../../src/meta/budget";
import {
  compareLogo,
  type LogoCompareContext,
  logoCompareRequest,
  logoJudgementSchema,
  logoMatchItem,
  logoNotComparedItem,
} from "../../src/vision/logo-compare";

// D03 T03 §3: Muse Spark logo comparison through a stubbed Meta transport, the real budget on
// migrated D1 and the real CACHE KV. No Meta credit is spent. Each test compares different crop
// bytes, so no test is answered by another's cache entry.
const db = (env as unknown as Env).DB;
const kv = (env as unknown as Env).CACHE;
const META = { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" };

const reply = (body: unknown) =>
  new Response(
    JSON.stringify({
      id: "r",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(body) }] }],
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
    { headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", "x-request-id": "req-1" } },
  );

const SAME = { same_brand: true, brand_seen: "Protea Bank", differences: [], confidence: 0.9 };
const DIFFERENT = {
  same_brand: false,
  brand_seen: "Other Bank",
  differences: ["a different name and mark"],
  confidence: 0.8,
};

function ctx(fetchImpl: typeof fetch, caseId: string): LogoCompareContext {
  return {
    meta: {
      env: META,
      budget: d1Budget(db, { caller: "vision", caseId }),
      owner: { kind: "case", caseId, step: "vision" },
      fetch: fetchImpl,
    },
    kv,
    owner: { kind: "case", caseId, step: "vision" },
    waitUntil: () => {},
  };
}

const image = (marker: string, mediaType = "image/png") => ({
  bytes: new TextEncoder().encode(`logo-bytes-${marker}`),
  mediaType,
  label: marker,
});

describe("compareLogo", () => {
  it("sends the crop and the reference as two input_image parts with a fixed prompt", async () => {
    let seen: unknown;
    const fetchStub = (async (_input: unknown, init?: RequestInit) => {
      seen = JSON.parse(String(init?.body));
      return reply(SAME);
    }) as typeof fetch;
    const request = logoCompareRequest(image("crop-shape"), image("ref-shape", "image/jpeg"));
    const content = (request.input[0] as { content: { type: string }[] }).content;
    expect(content.filter((part) => part.type === "input_image")).toHaveLength(2);
    expect(request.model).toBe("muse-spark-1.3");
    const judgement = await compareLogo(ctx(fetchStub, "logo-shape"), image("crop-shape"), image("ref-shape"));
    expect(judgement).toEqual(SAME);
    const sent = seen as { input: { content: { type: string; image_url?: string }[] }[] };
    const parts = sent.input.flatMap((entry) => entry.content);
    expect(parts.filter((part) => part.type === "input_image")).toHaveLength(2);
    expect(parts.every((part) => part.type !== "input_image" || part.image_url?.startsWith("data:image/"))).toBe(true);
  });

  it("caches by both hashes: a second identical comparison spends nothing, a changed crop spends again", async () => {
    let calls = 0;
    const fetchStub = (async () => {
      calls += 1;
      return reply(SAME);
    }) as typeof fetch;
    const context = ctx(fetchStub, "logo-cache");
    await compareLogo(context, image("crop-cache"), image("ref-cache"));
    await compareLogo(context, image("crop-cache"), image("ref-cache"));
    expect(calls).toBe(1);
    await compareLogo(context, image("crop-cache-changed"), image("ref-cache"));
    expect(calls).toBe(2);
  });

  it("refuses an SVG reference with a typed error before any spend", async () => {
    let calls = 0;
    const fetchStub = (async () => {
      calls += 1;
      return reply(SAME);
    }) as typeof fetch;
    await expect(
      compareLogo(ctx(fetchStub, "logo-svg"), image("crop-svg"), image("ref-svg", "image/svg+xml")),
    ).rejects.toMatchObject({ name: "LogoCompareError", kind: "unsupported-media" });
    expect(calls).toBe(0);
  });

  it("refuses a different-brand judgement that names no difference", () => {
    expect(
      logoJudgementSchema.safeParse({ same_brand: false, brand_seen: "Other", differences: [], confidence: 0.5 })
        .success,
    ).toBe(false);
    expect(logoJudgementSchema.safeParse(DIFFERENT).success).toBe(true);
  });

  it("spends again when the reference image changes, not only the crop", async () => {
    let calls = 0;
    const fetchStub = (async () => {
      calls += 1;
      return reply(SAME);
    }) as typeof fetch;
    const context = ctx(fetchStub, "logo-ref-cache");
    await compareLogo(context, image("crop-refcache"), image("ref-one"));
    await compareLogo(context, image("crop-refcache"), image("ref-two"));
    expect(calls).toBe(2);
  });

  it("compares a registered-style reference absent from the curated index", async () => {
    const fetchStub = (async () => reply(DIFFERENT)) as typeof fetch;
    const judgement = await compareLogo(
      ctx(fetchStub, "logo-registered"),
      image("crop-registered"),
      image("fynbos-registered-logo"),
    );
    expect(judgement.same_brand).toBe(false);
  });
});

describe("logoMatchItem", () => {
  it("is high on an unrelated domain, info on the brand's own or an unjudged domain, and info for a different logo", () => {
    expect(logoMatchItem(SAME, "Protea Bank", "art/c/crop.png", "mismatch").severity).toBe("high");
    expect(logoMatchItem(SAME, "Protea Bank", "art/c/crop.png", "official").severity).toBe("info");
    expect(logoMatchItem(SAME, "Protea Bank", "art/c/crop.png", "unjudged").severity).toBe("info");
    const different = logoMatchItem(DIFFERENT, "Protea Bank", "art/c/crop.png", "mismatch");
    expect(different.severity).toBe("info");
    expect(different.summary).toContain("not Protea Bank's logo");
    expect(different.detail).toMatchObject({ same_brand: false, checked: true });
    expect(logoNotComparedItem("Protea Bank", "art/c/crop.png", "missing-brand").detail).toMatchObject({
      checked: false,
    });
  });
});
