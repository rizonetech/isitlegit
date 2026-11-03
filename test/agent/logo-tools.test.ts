import { env } from "cloudflare:test";
import type { Browser } from "@cloudflare/puppeteer";
import { describe, expect, it } from "vitest";
import { verdictToolDeps } from "../../src/agent/loop";
import { createToolExecutor, type ToolDeps, toolDefinitions } from "../../src/agent/tools";
import { bundled } from "../../src/checks/brands";
import { addEvidence, readEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { ulid } from "../../src/db/ulid";
import { artefactsOf, putArtefact, type Store } from "../../src/intake/store";
import { LOGO_INDEX_KEY } from "../../src/vision/logo-reference";
import { SEGMENT_CONCEPTS } from "../../src/vision/sam";

// 1x1 PNG raster bytes
const PNG_1X1 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
  (c) => c.charCodeAt(0),
);
const PNG_ALT = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

const sha256Hex = async (bytes: Uint8Array) => {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const toBase64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};

// SAM stream helpers from test/vision/sam.test.ts
const MASK_PAYLOAD = "!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(";
const samStreamResponse = (boxes: { x1: number; y1: number; x2: number; y2: number; c?: number }[]) => {
  const text =
    boxes.length === 0
      ? ""
      : `<0f>${boxes
          .map(
            (s, i) =>
              `${i}<|box;x1=${s.x1};y1=${s.y1};x2=${s.x2};y2=${s.y2};w=320;h=334${s.c === undefined ? "" : `;c=${s.c}`}|><|mask;x=0;y=0;data=27,60,~${MASK_PAYLOAD}|>`,
          )
          .join(",")}\n`;
  const events = [
    ...(text
      ? [
          {
            type: "response.output_text.delta",
            item_id: "m1",
            output_index: 0,
            content_index: 0,
            delta: text,
            sequence_number: 0,
          },
        ]
      : []),
    {
      type: "response.output_text.done",
      item_id: "m1",
      output_index: 0,
      content_index: 0,
      text,
      sequence_number: 1,
    },
    {
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: "r_sam",
        object: "response",
        status: "completed",
        model: "sam-3.1",
        output: [],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  ];
  return new Response(`${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream", "cf-aig-log-id": "log-1", "x-request-id": "req-1" },
  });
};

const logoCompareResponse = (judgement: {
  same_brand: boolean;
  brand_seen: string | null;
  differences: string[];
  confidence: number;
}) =>
  new Response(
    JSON.stringify({
      id: "r_logo",
      object: "response",
      status: "completed",
      model: "muse-spark-1.3",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: JSON.stringify(judgement) }],
        },
      ],
      usage: { input_tokens: 50, output_tokens: 20 },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", "x-request-id": "req-1" },
    },
  );

async function seedCase(): Promise<{ caseId: string; orgId: string }> {
  const orgId = `org_${ulid()}`;
  const created = await createCase(env.DB, {
    orgId,
    channel: "email",
    headersAvailable: true,
  });
  if (!created.ok) throw new Error(created.error.message);
  return { caseId: created.value.id, orgId };
}

function stubBrowser(
  options: {
    cropFail?: boolean;
    partialCropFail?: boolean;
    delayCropMs?: number;
    stallClose?: boolean;
    secondNavUrl?: string;
  } = {},
): () => Promise<Browser> {
  return async () => {
    let pageCount = 0;
    return {
      on: () => undefined,
      off: () => undefined,
      target: () => ({
        createCDPSession: async () => ({
          on: () => undefined,
          send: async () => ({}),
          detach: async () => undefined,
        }),
      }),
      close: async () => {
        if (options.stallClose) {
          await new Promise(() => {});
        }
      },
      newPage: async () => {
        pageCount += 1;
        const isSecondPage = pageCount >= 2;
        let currentUrl = "https://www.fnb.co.za/login";
        const mainFrame = { _id: "f1", url: () => currentUrl };
        const listeners = new Map<string, ((arg: unknown) => void)[]>();
        return {
          setBypassServiceWorker: async () => undefined,
          setViewport: async () => undefined,
          setUserAgent: async () => undefined,
          evaluateOnNewDocument: async () => undefined,
          setRequestInterception: async () => undefined,
          mainFrame: () => mainFrame,
          frames: () => [mainFrame],
          createCDPSession: async () => ({
            on: () => undefined,
            send: async () => ({}),
            detach: async () => undefined,
          }),
          on: (event: string, fn: (arg: unknown) => void) => {
            const list = listeners.get(event) ?? [];
            list.push(fn);
            listeners.set(event, list);
          },
          goto: async (url: string) => {
            currentUrl = isSecondPage && options.secondNavUrl ? options.secondNavUrl : url;
            for (const fn of listeners.get("response") ?? []) {
              fn({
                url: () => currentUrl,
                status: () => 200,
                headers: () => ({}),
                request: () => ({ resourceType: () => "document", frame: () => mainFrame }),
              });
            }
            return { status: () => 200 };
          },
          url: () => currentUrl,
          title: async () => "Login",
          content: async () => "<html><body>Login</body></html>",
          screenshot: async () => PNG_1X1,
          evaluate: async (_fn: unknown, ...args: unknown[]) => {
            if (_fn === "document.readyState") {
              return "complete";
            }
            // imageSize passes 1 argument (b64); cropBoxes passes 3 arguments (b64, boxes, padding).
            if (args.length === 1) {
              return { width: 320, height: 334 };
            }
            if (options.delayCropMs) {
              await new Promise((r) => setTimeout(r, options.delayCropMs));
            }
            const boxes = (args[1] as unknown[]) ?? [];
            if (options.cropFail) {
              return boxes.map(() => null);
            }
            if (options.partialCropFail) {
              return boxes.map((_, idx) => (idx === 0 ? { b64: toBase64(PNG_1X1), width: 60, height: 27 } : null));
            }
            return boxes.map(() => ({ b64: toBase64(PNG_1X1), width: 60, height: 27 }));
          },
          close: async () => undefined,
        };
      },
    } as unknown as Browser;
  };
}

async function seedFnbReferenceLogos(options: { corruptHash?: boolean; withIcon?: boolean } = {}) {
  const wordmarkHash = options.corruptHash ? "0".repeat(64) : await sha256Hex(PNG_1X1);
  const iconHash = await sha256Hex(PNG_ALT);
  await env.ARTEFACTS.put("ref/logos/2026-11-01/fnb.png", PNG_1X1, {
    httpMetadata: { contentType: "image/png" },
  });
  if (options.withIcon) {
    await env.ARTEFACTS.put("ref/logos/2026-11-01/fnb-icon.png", PNG_ALT, {
      httpMetadata: { contentType: "image/png" },
    });
  }
  const logos = [
    {
      slug: "fnb",
      brand: "FNB",
      key: "ref/logos/2026-11-01/fnb.png",
      page_url: "https://www.fnb.co.za/",
      source_url: "https://www.fnb.co.za/logo.png",
      source_kind: "header",
      use: "detection-reference",
      fetched_at: "2026-11-01T00:00:00Z",
      media_type: "image/png",
      width: 200,
      height: 60,
      sha256: wordmarkHash,
      fictional: false,
      variant: "wordmark",
    },
    ...(options.withIcon
      ? [
          {
            slug: "fnb",
            brand: "FNB",
            key: "ref/logos/2026-11-01/fnb-icon.png",
            page_url: "https://www.fnb.co.za/",
            source_url: "https://www.fnb.co.za/icon.png",
            source_kind: "icon",
            use: "detection-reference",
            fetched_at: "2026-11-01T00:00:00Z",
            media_type: "image/png",
            width: 64,
            height: 64,
            sha256: iconHash,
            fictional: false,
            variant: "icon",
          },
        ]
      : []),
  ];
  await env.ARTEFACTS.put(
    LOGO_INDEX_KEY,
    JSON.stringify({
      version: 1,
      generation: "2026-11-01",
      generated_at: "2026-11-01T00:00:00Z",
      logos,
      missing: [],
    }),
  );
}

describe("D04 T01 §10: logo tools for the verdict agent", () => {
  it("defines segment_logos and compare_logo from their zod schemas alongside the first five tools", () => {
    const definitions = toolDefinitions();
    expect(definitions).toHaveLength(7);
    const segmentDef = definitions.find((d) => d.name === "segment_logos");
    const compareDef = definitions.find((d) => d.name === "compare_logo");
    expect(segmentDef).toMatchObject({
      type: "function",
      name: "segment_logos",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["artefact_key", "concept"],
        properties: {
          artefact_key: { type: "string", minLength: 1, maxLength: 1024 },
          concept: { type: "string", enum: [...SEGMENT_CONCEPTS] },
        },
      },
    });
    expect(compareDef).toMatchObject({
      type: "function",
      name: "compare_logo",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["crop_key", "brand"],
        properties: {
          crop_key: { type: "string", minLength: 1, maxLength: 1024 },
          brand: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
    });
  });

  it("refuses an artefact key of another case, a manifest or wrong kind, an unknown brand, and malformed arguments without running", async () => {
    const { caseId } = await seedCase();
    const { caseId: otherCaseId } = await seedCase();
    const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
    const myRender = await putArtefact(store, caseId, "render", "email.png", PNG_1X1, "image/png");
    const myCrop = await putArtefact(store, caseId, "crop", "email-logo-1.png", PNG_1X1, "image/png");
    const myManifest = await putArtefact(
      store,
      caseId,
      "crop",
      "email-manifest-1.json",
      new TextEncoder().encode("{}"),
      "application/json",
    );
    const otherRender = await putArtefact(store, otherCaseId, "render", "email.png", PNG_1X1, "image/png");
    const otherCrop = await putArtefact(store, otherCaseId, "crop", "email-logo-1.png", PNG_1X1, "image/png");

    let called = 0;
    const deps: ToolDeps = {
      expand: async () => [],
      screenshot: async () => [],
      lookupDomain: async () => [],
      ledger: async () => [],
      walk: async () => [],
      segmentLogos: async () => {
        called += 1;
        return [];
      },
      compareLogo: async () => {
        called += 1;
        return [];
      },
    };
    const executor = createToolExecutor({ db: env.DB, caseId, urls: [], brands: bundled }, deps);

    // Another case's render or crop is refused
    expect(await executor.call("segment_logos", { artefact_key: otherRender.key, concept: "logo" })).toEqual({
      status: "refused",
      tool: "segment_logos",
      reason: "artefact_not_in_case",
    });
    expect(await executor.call("compare_logo", { crop_key: otherCrop.key, brand: "Capitec Bank" })).toEqual({
      status: "refused",
      tool: "compare_logo",
      reason: "artefact_not_in_case",
    });
    // Non-existent key with this case's prefix is refused
    expect(
      await executor.call("segment_logos", { artefact_key: `art/${caseId}/render/missing.png`, concept: "logo" }),
    ).toEqual({
      status: "refused",
      tool: "segment_logos",
      reason: "artefact_not_in_case",
    });
    // Crop key passed to segment_logos, or render/manifest key passed to compare_logo, is refused
    expect(await executor.call("segment_logos", { artefact_key: myCrop.key, concept: "logo" })).toEqual({
      status: "refused",
      tool: "segment_logos",
      reason: "artefact_not_in_case",
    });
    expect(await executor.call("compare_logo", { crop_key: myRender.key, brand: "Capitec Bank" })).toEqual({
      status: "refused",
      tool: "compare_logo",
      reason: "artefact_not_in_case",
    });
    expect(await executor.call("compare_logo", { crop_key: myManifest.key, brand: "Capitec Bank" })).toEqual({
      status: "refused",
      tool: "compare_logo",
      reason: "artefact_not_in_case",
    });
    // Unknown brand is refused
    expect(await executor.call("compare_logo", { crop_key: myCrop.key, brand: "NoSuchBankEver" })).toEqual({
      status: "refused",
      tool: "compare_logo",
      reason: "unknown_brand",
    });
    // Invalid concept is refused
    expect(await executor.call("segment_logos", { artefact_key: myRender.key, concept: "face" })).toEqual({
      status: "refused",
      tool: "segment_logos",
      reason: "invalid_arguments",
    });

    expect(called).toBe(0);
    expect(await readEvidence(env.DB, caseId)).toEqual([]);
  });

  it("saves evidence per call and enforces the 8-call and 90-second caps across logo tools", async () => {
    const { caseId } = await seedCase();
    const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
    const render = await putArtefact(store, caseId, "render", "email.png", PNG_1X1, "image/png");
    const crop = await putArtefact(store, caseId, "crop", "email-logo-1.png", PNG_1X1, "image/png");

    const deps: ToolDeps = {
      expand: async () => [],
      screenshot: async () => [],
      lookupDomain: async () => [],
      ledger: async () => [],
      walk: async () => [],
      segmentLogos: async ({ artefactKey, concept }) => [
        {
          check: "agent.segment_logos",
          severity: "info",
          summary: `Segmented 1 ${concept} crop.`,
          detail: { artefactKey, concept, count: 1, crops: [crop.key] },
          artefacts: [crop.key],
        },
      ],
      compareLogo: async ({ cropKey, brand }) => [
        {
          check: "agent.compare_logo",
          severity: "high",
          summary: `A logo crop matches ${brand.name}'s logo on an unrelated domain.`,
          detail: { cropKey, brand: brand.name, same_brand: true },
          artefacts: [cropKey],
        },
      ],
    };

    let clock = 1_000;
    const executor = createToolExecutor({ db: env.DB, caseId, urls: [], brands: bundled }, deps, { now: () => clock });
    for (let i = 0; i < 4; i++) {
      const seg = await executor.call("segment_logos", { artefact_key: render.key, concept: "logo" });
      expect(seg.status).toBe("ok");
      const cmp = await executor.call("compare_logo", { crop_key: crop.key, brand: "First National Bank" });
      expect(cmp.status).toBe("ok");
    }
    const ninth = await executor.call("segment_logos", { artefact_key: render.key, concept: "logo" });
    expect(ninth).toEqual({ status: "refused", tool: "segment_logos", reason: "call_cap" });
    const stored = await readEvidence(env.DB, caseId);
    expect(stored).toHaveLength(8);

    // Time cap refusal
    const timedExecutor = createToolExecutor({ db: env.DB, caseId, urls: [], brands: bundled }, deps, {
      now: () => clock,
    });
    clock += 90_001;
    expect(await timedExecutor.call("compare_logo", { crop_key: crop.key, brand: "First National Bank" })).toEqual({
      status: "refused",
      tool: "compare_logo",
      reason: "time_cap",
    });
  });

  it("chains screenshot_url -> segment_logos -> compare_logo through verdictToolDeps and distinguishes official, mismatch, unjudged, and icon variant fallback", async () => {
    const { caseId, orgId } = await seedCase();
    const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
    await seedFnbReferenceLogos({ withIcon: true });

    let samCalls = 0;
    let compareCalls = 0;
    const metaFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      if (body.model === "sam-3.1") {
        samCalls += 1;
        return samStreamResponse([{ x1: 10, y1: 10, x2: 70, y2: 37, c: 0.92 }]);
      }
      compareCalls += 1;
      // First variant (wordmark) says false; second variant (icon) says true!
      const isIcon = compareCalls % 2 === 0;
      return logoCompareResponse({
        same_brand: isIcon,
        brand_seen: isIcon ? "FNB" : null,
        differences: isIcon ? [] : ["wordmark text absent"],
        confidence: 0.94,
      });
    };

    const metaEnv = {
      ...env,
      META_API_KEY: "test-key",
      CF_AIG_TOKEN: "test-token",
      META_GATEWAY_URL: "https://gateway.test/v1",
    };
    const deps = verdictToolDeps(metaEnv, env.DB, store, caseId, orgId, bundled, null, {
      launch: stubBrowser(),
      policy: async (raw) => ({ ok: true, url: new URL(raw) }),
      metaFetch,
    });
    const phishingUrl = "https://fnb-verify-login.example/signin";
    const officialUrl = "https://www.fnb.co.za/signin";
    const executor = createToolExecutor(
      {
        db: env.DB,
        caseId,
        urls: [phishingUrl, officialUrl],
        brands: bundled,
      },
      deps,
    );

    // 1. screenshot_url on phishing domain -> stores a render artefact row in the case
    const shotRes = await executor.call("screenshot_url", { url: phishingUrl });
    expect(shotRes.status).toBe("ok");
    const renderKey = shotRes.status === "ok" ? shotRes.evidence[0]?.artefacts[0] : undefined;
    expect(renderKey).toMatch(new RegExp(`^art/${caseId}/render/`));

    // 2. segment_logos on that returned renderKey -> segments and stores crop + manifest
    const segRes = await executor.call("segment_logos", { artefact_key: renderKey, concept: "logo" });
    expect(segRes.status).toBe("ok");
    const cropKey = segRes.status === "ok" ? segRes.evidence[0]?.artefacts[0] : undefined;
    expect(cropKey).toMatch(new RegExp(`^art/${caseId}/crop/`));
    expect(samCalls).toBe(1);

    // 3. compare_logo on that returned cropKey with alias "First National Bank" -> canonical "FNB", mismatch domain (high), icon variant matched after wordmark non-match
    const cmpMismatch = await executor.call("compare_logo", { crop_key: cropKey, brand: "First National Bank" });
    expect(cmpMismatch.status).toBe("ok");
    expect(compareCalls).toBe(2);
    const mismatchItem = cmpMismatch.status === "ok" ? cmpMismatch.evidence[0] : undefined;
    expect(mismatchItem).toMatchObject({
      check: "agent.compare_logo",
      severity: "high",
      detail: {
        brand: "FNB",
        same_brand: true,
        domain: "mismatch",
        checked: true,
        reference_key: "ref/logos/2026-11-01/fnb-icon.png",
        reference_sha256: await sha256Hex(PNG_ALT),
      },
      artefacts: [cropKey],
    });

    // 4. Official domain screenshot -> segment -> compare_logo produces info with domain: "official", even when an unrelated FNB mismatch item exists on another image
    await addEvidence(env.DB, caseId, "vision", [
      {
        check: "vision.brand_domain_mismatch",
        severity: "high",
        summary: "An unrelated image claimed FNB on a mismatch domain.",
        detail: { brand: "FNB" },
        artefacts: [`art/${caseId}/render/unrelated.png`],
      },
    ]);
    const officialShot = await executor.call("screenshot_url", { url: officialUrl });
    const officialRenderKey = officialShot.status === "ok" ? officialShot.evidence[0]?.artefacts[0] : undefined;
    const officialSeg = await executor.call("segment_logos", { artefact_key: officialRenderKey, concept: "logo" });
    const officialCropKey = officialSeg.status === "ok" ? officialSeg.evidence[0]?.artefacts[0] : undefined;
    const cmpOfficial = await executor.call("compare_logo", { crop_key: officialCropKey, brand: "FNB" });
    expect(cmpOfficial.status).toBe("ok");
    const officialItem =
      cmpOfficial.status === "ok" ? officialShot.status === "ok" && cmpOfficial.evidence[0] : undefined;
    expect(officialItem).toMatchObject({
      check: "agent.compare_logo",
      severity: "info",
      detail: {
        brand: "FNB",
        same_brand: true,
        domain: "official",
      },
    });

    // 5. Unjudged domain (upload case with no sender or link hosts) -> domain: "unjudged" (info)
    const { caseId: unjudgedCase, orgId: unjudgedOrg } = await seedCase();
    const standaloneCrop = await putArtefact(store, unjudgedCase, "crop", "page-logo-1.png", PNG_1X1, "image/png");
    const unjudgedDeps = verdictToolDeps(metaEnv, env.DB, store, unjudgedCase, unjudgedOrg, bundled, null, {
      launch: stubBrowser(),
      metaFetch,
    });
    const unjudgedExec = createToolExecutor(
      { db: env.DB, caseId: unjudgedCase, urls: [], brands: bundled },
      unjudgedDeps,
    );
    const cmpUnjudged = await unjudgedExec.call("compare_logo", { crop_key: standaloneCrop.key, brand: "FNB" });
    expect(cmpUnjudged.status).toBe("ok");
    const unjudgedItem = cmpUnjudged.status === "ok" ? cmpUnjudged.evidence[0] : undefined;
    expect(unjudgedItem).toMatchObject({
      check: "agent.compare_logo",
      severity: "info",
      detail: {
        brand: "FNB",
        same_brand: true,
        domain: "unjudged",
      },
    });
    const persisted = await readEvidence(env.DB, unjudgedCase);
    expect(persisted[0]?.check).toBe("agent.compare_logo");
    expect(persisted[0]?.detail.reference_key).toBe("ref/logos/2026-11-01/fnb-icon.png");

    // 6. Shared Meta budget accounting in model_spend across segment_logos and compare_logo
    const spendRows = await env.DB.prepare(
      "SELECT caller, model, owner, case_id, step, state FROM model_spend WHERE case_id = ? ORDER BY at",
    )
      .bind(caseId)
      .all<{ caller: string; model: string; owner: string; case_id: string; step: string; state: string }>();
    expect(spendRows.results.length).toBeGreaterThanOrEqual(4);
    expect(
      spendRows.results.every(
        (r) => r.caller === "verdict-agent" && r.owner === "case" && r.step === "verdict" && r.state === "settled",
      ),
    ).toBe(true);
    expect(spendRows.results.some((r) => r.model === "sam-3.1")).toBe(true);
    expect(spendRows.results.some((r) => r.model === "muse-spark-1.3")).toBe(true);
  });

  it("honours no-sam ablation for both segment_logos and compare_logo and restores operation when cleared", async () => {
    const { caseId, orgId } = await seedCase();
    const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
    await seedFnbReferenceLogos();
    const render = await putArtefact(
      store,
      caseId,
      "render",
      "email.png",
      new Uint8Array([...PNG_1X1, 2]),
      "image/png",
    );
    const crop = await putArtefact(
      store,
      caseId,
      "crop",
      "email-logo-1.png",
      new Uint8Array([...PNG_1X1, 3]),
      "image/png",
    );

    let modelCalls = 0;
    const metaFetch: typeof fetch = async (_input, init) => {
      modelCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      if (body.model === "sam-3.1") return samStreamResponse([{ x1: 10, y1: 10, x2: 70, y2: 37, c: 0.92 }]);
      return logoCompareResponse({
        same_brand: false,
        brand_seen: null,
        differences: ["different shape"],
        confidence: 0.9,
      });
    };
    const metaEnv = {
      ...env,
      META_API_KEY: "test-key",
      CF_AIG_TOKEN: "test-token",
      META_GATEWAY_URL: "https://gateway.test/v1",
    };
    const deps = verdictToolDeps(metaEnv, env.DB, store, caseId, orgId, bundled, null, {
      launch: stubBrowser(),
      metaFetch,
    });
    const executor = createToolExecutor(
      {
        db: env.DB,
        caseId,
        urls: [],
        brands: bundled,
        ablateFlag: async () => (await env.CACHE.get(`ablate:${orgId}`)) as "no-sam" | null,
      },
      deps,
    );

    await env.CACHE.put(`ablate:${orgId}`, "no-sam");
    const segAblated = await executor.call("segment_logos", { artefact_key: render.key, concept: "logo" });
    expect(segAblated.status).toBe("ok");
    if (segAblated.status === "ok") {
      expect(segAblated.evidence[0]?.detail).toMatchObject({ checked: false, ablated: "no-sam" });
    }
    const cmpAblated = await executor.call("compare_logo", { crop_key: crop.key, brand: "FNB" });
    expect(cmpAblated.status).toBe("ok");
    if (cmpAblated.status === "ok") {
      expect(cmpAblated.evidence[0]?.detail).toMatchObject({ checked: false, ablated: "no-sam" });
    }
    expect(modelCalls).toBe(0);

    // Clearing the flag restores real SAM and comparison calls
    await env.CACHE.delete(`ablate:${orgId}`);
    const segLive = await executor.call("segment_logos", { artefact_key: render.key, concept: "logo" });
    expect(segLive.status).toBe("ok");
    const cmpLive = await executor.call("compare_logo", { crop_key: crop.key, brand: "FNB" });
    expect(cmpLive.status).toBe("ok");
    expect(modelCalls).toBe(2);
  });

  it("fences late crop writes on timeout and records checked: false on empty/failed crops, corrupt references, missing R2 bytes, budget refusal, and missing optional deps", async () => {
    const { caseId, orgId } = await seedCase();
    const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
    const render = await putArtefact(
      store,
      caseId,
      "render",
      "email.png",
      new Uint8Array([...PNG_1X1, 4]),
      "image/png",
    );
    const crop = await putArtefact(
      store,
      caseId,
      "crop",
      "email-logo-1.png",
      new Uint8Array([...PNG_1X1, 5]),
      "image/png",
    );

    // 1. Delayed crop past deadline publishes no crop manifest and writes no evidence
    const delayedMetaEnv = {
      ...env,
      META_API_KEY: "test-key",
      CF_AIG_TOKEN: "test-token",
      META_GATEWAY_URL: "https://gateway.test/v1",
    };
    const delayedDeps = verdictToolDeps(delayedMetaEnv, env.DB, store, caseId, orgId, bundled, null, {
      launch: stubBrowser({ delayCropMs: 80 }),
      metaFetch: async () => samStreamResponse([{ x1: 10, y1: 10, x2: 70, y2: 37, c: 0.9 }]),
    });
    const tightExecutor = createToolExecutor({ db: env.DB, caseId, urls: [], brands: bundled }, delayedDeps, {
      budgetMs: 25,
    });
    const timedOut = await tightExecutor.call("segment_logos", { artefact_key: render.key, concept: "logo" });
    expect(timedOut).toEqual({ status: "refused", tool: "segment_logos", reason: "time_cap" });
    await new Promise((r) => setTimeout(r, 90));
    const cropsAfterTimeout = await artefactsOf(store, caseId, "crop");
    expect(cropsAfterTimeout.filter((a) => /-manifest-\d+\.json$/.test(a.key))).toEqual([]);
    expect(await readEvidence(env.DB, caseId)).toEqual([]);

    // 2. Crop failure produces status: "failed" with detail.checked: false, never a clearance
    const failCropDeps = verdictToolDeps(delayedMetaEnv, env.DB, store, caseId, orgId, bundled, null, {
      launch: stubBrowser({ cropFail: true }),
      metaFetch: async () => samStreamResponse([{ x1: 10, y1: 10, x2: 70, y2: 37, c: 0.9 }]),
    });
    const failCropExec = createToolExecutor({ db: env.DB, caseId, urls: [], brands: bundled }, failCropDeps);
    const cropFailed = await failCropExec.call("segment_logos", { artefact_key: render.key, concept: "logo" });
    expect(cropFailed.status).toBe("failed");
    if (cropFailed.status === "failed") {
      expect(cropFailed.evidence[0]?.detail).toMatchObject({ checked: false, error: "SegmentError" });
    }

    // 3. Corrupt reference logo hash produces status: "failed" with detail.checked: false
    await seedFnbReferenceLogos({ corruptHash: true });
    const corruptRefExec = createToolExecutor({ db: env.DB, caseId, urls: [], brands: bundled }, failCropDeps);
    const corruptRefRes = await corruptRefExec.call("compare_logo", { crop_key: crop.key, brand: "FNB" });
    expect(corruptRefRes.status).toBe("failed");
    if (corruptRefRes.status === "failed") {
      expect(corruptRefRes.evidence[0]?.detail).toMatchObject({ checked: false, error: "LogoReferenceError" });
    }

    // 4. Malformed model output on compare_logo produces status: "failed" with detail.checked: false
    await seedFnbReferenceLogos({ corruptHash: false });
    const badModelDeps = verdictToolDeps(delayedMetaEnv, env.DB, store, caseId, orgId, bundled, null, {
      launch: stubBrowser(),
      metaFetch: async () =>
        new Response(
          JSON.stringify({
            id: "r_bad",
            model: "muse-spark-1.3",
            output: [{ type: "message", content: [{ type: "output_text", text: "not-json" }] }],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const badModelExec = createToolExecutor({ db: env.DB, caseId, urls: [], brands: bundled }, badModelDeps);
    const badModelRes = await badModelExec.call("compare_logo", { crop_key: crop.key, brand: "FNB" });
    expect(badModelRes.status).toBe("failed");
    if (badModelRes.status === "failed") {
      expect(badModelRes.evidence[0]?.detail.checked).toBe(false);
    }

    // 5. Optional dependencies absent on five-tool ToolDeps stub fails gracefully with checked: false
    const fiveToolExec = createToolExecutor(
      { db: env.DB, caseId, urls: [], brands: bundled },
      {
        expand: async () => [],
        screenshot: async () => [],
        lookupDomain: async () => [],
        ledger: async () => [],
        walk: async () => [],
      },
    );
    const missingDepRes = await fiveToolExec.call("segment_logos", { artefact_key: render.key, concept: "logo" });
    expect(missingDepRes.status).toBe("failed");
    if (missingDepRes.status === "failed") {
      expect(missingDepRes.evidence[0]?.detail).toMatchObject({ checked: false, error: "Error" });
    }

    // 6. Empty segmentation stores empty crop manifest and returns count: 0, crops: []
    const emptySegDeps = verdictToolDeps(delayedMetaEnv, env.DB, store, caseId, orgId, bundled, null, {
      launch: stubBrowser(),
      metaFetch: async () => samStreamResponse([]),
    });
    const emptySegExec = createToolExecutor({ db: env.DB, caseId, urls: [], brands: bundled }, emptySegDeps);
    const emptySegRes = await emptySegExec.call("segment_logos", { artefact_key: render.key, concept: "logo" });
    expect(emptySegRes.status).toBe("ok");
    if (emptySegRes.status === "ok") {
      expect(emptySegRes.evidence[0]?.detail).toMatchObject({
        artefactKey: render.key,
        concept: "logo",
        count: 0,
        crops: [],
      });
    }
    const manifestsAfterEmpty = (await artefactsOf(store, caseId, "crop")).filter((a) =>
      /-manifest-\d+\.json$/.test(a.key),
    );
    expect(manifestsAfterEmpty.length).toBeGreaterThanOrEqual(1);

    // 7. Mixed crop success/failure sets detail.checked: false alongside partialFailures
    const mixedCropDeps = verdictToolDeps(delayedMetaEnv, env.DB, store, caseId, orgId, bundled, null, {
      launch: stubBrowser({ partialCropFail: true }),
      metaFetch: async () =>
        samStreamResponse([
          { x1: 10, y1: 10, x2: 70, y2: 37, c: 0.95 },
          { x1: 100, y1: 100, x2: 180, y2: 140, c: 0.9 },
        ]),
    });
    const mixedCropExec = createToolExecutor({ db: env.DB, caseId, urls: [], brands: bundled }, mixedCropDeps);
    const mixedCropRes = await mixedCropExec.call("segment_logos", { artefact_key: render.key, concept: "logo" });
    expect(mixedCropRes.status).toBe("ok");
    if (mixedCropRes.status === "ok") {
      expect(mixedCropRes.evidence[0]?.detail).toMatchObject({
        count: 1,
        partialFailures: 1,
        checked: false,
      });
    }

    // 8. Variant 1 negative + Variant 2 error in compare_logo fails with checked: false instead of emitting complete negative
    await seedFnbReferenceLogos({ withIcon: true });
    let variantCalls = 0;
    const partialVariantDeps = verdictToolDeps(delayedMetaEnv, env.DB, store, caseId, orgId, bundled, null, {
      launch: stubBrowser(),
      metaFetch: async () => {
        variantCalls += 1;
        if (variantCalls === 1) {
          return logoCompareResponse({
            same_brand: false,
            brand_seen: null,
            differences: ["wordmark does not match"],
            confidence: 0.88,
          });
        }
        return new Response("upstream failure", { status: 502 });
      },
    });
    const partialVariantExec = createToolExecutor(
      { db: env.DB, caseId, urls: [], brands: bundled },
      partialVariantDeps,
    );
    const cropForPartialVariant = await putArtefact(
      store,
      caseId,
      "crop",
      "email-logo-variant-err.png",
      new Uint8Array([...PNG_1X1, 9]),
      "image/png",
    );
    const partialVariantRes = await partialVariantExec.call("compare_logo", {
      crop_key: cropForPartialVariant.key,
      brand: "FNB",
    });
    expect(partialVariantRes.status).toBe("failed");
    if (partialVariantRes.status === "failed") {
      expect(partialVariantRes.evidence[0]?.detail.checked).toBe(false);
    }

    // 9. Missing R2 object bytes for registered render and crop artefacts fails with checked: false
    const missingRender = await putArtefact(
      store,
      caseId,
      "render",
      "missing-render.png",
      new Uint8Array([...PNG_1X1, 10]),
      "image/png",
    );
    const missingCrop = await putArtefact(
      store,
      caseId,
      "crop",
      "missing-crop.png",
      new Uint8Array([...PNG_1X1, 11]),
      "image/png",
    );
    await env.ARTEFACTS.delete(missingRender.key);
    await env.ARTEFACTS.delete(missingCrop.key);
    const missingR2Exec = createToolExecutor({ db: env.DB, caseId, urls: [], brands: bundled }, emptySegDeps);
    const missingRenderRes = await missingR2Exec.call("segment_logos", {
      artefact_key: missingRender.key,
      concept: "logo",
    });
    expect(missingRenderRes.status).toBe("failed");
    if (missingRenderRes.status === "failed") {
      expect(missingRenderRes.evidence[0]?.detail).toMatchObject({ checked: false, error: "SegmentError" });
    }
    const missingCropRes = await missingR2Exec.call("compare_logo", {
      crop_key: missingCrop.key,
      brand: "FNB",
    });
    expect(missingCropRes.status).toBe("failed");
    if (missingCropRes.status === "failed") {
      expect(missingCropRes.evidence[0]?.detail).toMatchObject({ checked: false, error: "Error" });
    }

    // 9b. Stalled browser.close() after successful segmentation and crop storage still returns ok before the tool deadline
    const stalledCloseDeps = verdictToolDeps(delayedMetaEnv, env.DB, store, caseId, orgId, bundled, null, {
      launch: stubBrowser({ stallClose: true }),
      metaFetch: async () => samStreamResponse([{ x1: 10, y1: 10, x2: 70, y2: 37, c: 0.91 }]),
    });
    const stalledCloseExec = createToolExecutor({ db: env.DB, caseId, urls: [], brands: bundled }, stalledCloseDeps, {
      budgetMs: 120,
    });
    const stalledCloseRes = await stalledCloseExec.call("segment_logos", {
      artefact_key: render.key,
      concept: "logo",
    });
    expect(stalledCloseRes.status).toBe("ok");
    if (stalledCloseRes.status === "ok") {
      expect(stalledCloseRes.evidence[0]?.detail.count).toBe(1);
    }

    // 9c. Changed destination host between link expansion and screenshot capture fails with checked: false and stores no render artefact
    const changedHostUrl = "https://fnb-redirect-trap.example/start";
    const changedHostDeps = verdictToolDeps(delayedMetaEnv, env.DB, store, caseId, orgId, bundled, null, {
      launch: stubBrowser({ secondNavUrl: "https://www.fnb.co.za/login" }),
      policy: async (raw) => ({ ok: true, url: new URL(raw) }),
      metaFetch: async () => samStreamResponse([]),
    });
    const changedHostExec = createToolExecutor(
      { db: env.DB, caseId, urls: [changedHostUrl], brands: bundled },
      changedHostDeps,
    );
    const rendersBeforeChangedHost = await artefactsOf(store, caseId, "render");
    const changedHostRes = await changedHostExec.call("screenshot_url", { url: changedHostUrl });
    expect(changedHostRes.status).toBe("failed");
    if (changedHostRes.status === "failed") {
      expect(changedHostRes.evidence[0]?.detail).toMatchObject({ checked: false, error: "Error" });
    }
    const rendersAfterChangedHost = await artefactsOf(store, caseId, "render");
    expect(rendersAfterChangedHost.length).toBe(rendersBeforeChangedHost.length);

    // 10. Exhausted shared Meta budget refuses both segment_logos and compare_logo and records checked: false
    await env.DB.prepare(
      "INSERT INTO model_spend (id, at, day, source, caller, model, attempt, state, estimate_usd, actual_usd, owner, case_id, step) VALUES (?, ?, ?, 'worker', ?, ?, 1, 'settled', 500, 500, 'case', ?, 'verdict')",
    )
      .bind(`spend_${ulid()}`, new Date().toISOString(), "2026-11-04", "verdict-agent", "muse-spark-1.3", caseId)
      .run();
    await env.DB.prepare(
      "INSERT INTO model_spend (id, at, day, source, caller, model, attempt, state, estimate_usd, actual_usd, owner, case_id, step) VALUES (?, ?, ?, 'worker', ?, ?, 1, 'settled', 500, 500, 'case', ?, 'verdict')",
    )
      .bind(`spend_${ulid()}`, new Date().toISOString(), "2026-11-03", "verdict-agent", "muse-spark-1.3", caseId)
      .run();
    const budgetExec = createToolExecutor({ db: env.DB, caseId, urls: [], brands: bundled }, emptySegDeps);
    const budgetSegRes = await budgetExec.call("segment_logos", { artefact_key: render.key, concept: "logo" });
    expect(budgetSegRes.status).toBe("failed");
    if (budgetSegRes.status === "failed") {
      expect(budgetSegRes.evidence[0]?.detail).toMatchObject({ checked: false, error: "SegmentError" });
    }
    const cropForBudget = await putArtefact(
      store,
      caseId,
      "crop",
      "email-logo-budget.png",
      new Uint8Array([...PNG_1X1, 12]),
      "image/png",
    );
    const budgetCmpRes = await budgetExec.call("compare_logo", { crop_key: cropForBudget.key, brand: "FNB" });
    expect(budgetCmpRes.status).toBe("failed");
    if (budgetCmpRes.status === "failed") {
      expect(budgetCmpRes.evidence[0]?.detail).toMatchObject({ checked: false, error: "BudgetExceeded" });
    }
  });
});
