import { env } from "cloudflare:test";
import puppeteer, { type Browser, type Page } from "@cloudflare/puppeteer";
import { describe, expect, it } from "vitest";
import { ruleVerdict } from "../../src/agent/rule-verdict";
import { readEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { artefactsOf, putAttachment, readArtefact, type Store } from "../../src/intake/store";
import { d1Budget } from "../../src/meta/budget";
import { landingHostsFrom, type VisionDeps, visionStep } from "../../src/vision/step";
import { storeMail } from "../fixtures/vision/emails";

// D03 T02 §3 integration: the vision step with a real Browser Run render and rasterisation and a
// stubbed Meta transport. Successful readings persist with their artefacts, a replay replaces them,
// a second identical case is served from the cache, the rules verdict cites them, and a page body
// that cannot be read back is stated coverage, never a cached complete reading. No Meta credit spent.
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const META = { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" };
const TEXT = "Pay invoice 77 today or the account closes.";

function makePdf(texts: string[]): Uint8Array {
  const objects: string[] = [];
  const kids = texts.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${texts.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  texts.forEach((text, i) => {
    const page = 4 + i * 2;
    const content = 5 + i * 2;
    objects[page] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    const stream = `BT /F1 48 Tf 72 700 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
    objects[content] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = pdf.length;
    pdf += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++) pdf += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

const reading = (brand: string) => ({
  readings: [
    {
      image: "image-1",
      claimed_brand: brand,
      requested_action: "pay",
      urgency_cues: ["Pay today"],
      visible_sender: "billing@fictional.example",
      payment_request: true,
      confidence: 0.9,
    },
    {
      image: "image-2",
      claimed_brand: brand,
      requested_action: "pay",
      urgency_cues: [],
      visible_sender: null,
      payment_request: true,
      confidence: 0.8,
    },
  ],
});

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

// SAM answers its own streamed shape beside the reading's JSON: the wrapper routes by model, so a
// test's reading stub never sees a segmentation request. `samResponder` lets one test answer with
// boxes (or a failure) instead of the default completed, zero-match stream.
const samSse = (events: unknown[]) =>
  new Response(`${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream", "cf-aig-log-id": "log-1", "x-request-id": "req-1" },
  });
const samEmpty = () =>
  samSse([
    { type: "response.output_text.done", item_id: "m1", output_index: 0, content_index: 0, text: "" },
    {
      type: "response.completed",
      response: { id: "r", object: "response", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } },
    },
  ]);
let samResponder: () => Response | Promise<Response> = samEmpty;

function deps(caseId: string, fetchImpl: typeof fetch, theStore: Store = store): VisionDeps {
  const routed = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {};
    if (body.model === "sam-3.1") return samResponder();
    return fetchImpl(input, init);
  }) as typeof fetch;
  return {
    db: env.DB,
    store: theStore,
    launch: () => puppeteer.launch(env.BROWSER),
    meta: { env: META, budget: d1Budget(env.DB, { caller: "vision", caseId }), fetch: routed },
    kv: (env as unknown as Env).CACHE,
    waitUntil: () => {},
    policy: async () => ({ ok: false, reason: "refused" }),
  };
}

async function seededCase(marker: string) {
  const made = await createCase(env.DB, { orgId: "org-vision-read", channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  const caseId = made.value.id;
  await storeMail(store, caseId, { text: `${TEXT} [${marker}]` });
  await putAttachment(store, caseId, "invoice-77.pdf", makePdf(["Invoice 77"]), "application/pdf");
  return caseId;
}

describe("visionStep with a stubbed model", () => {
  it("persists a reading the rules verdict cites, replaces the failure statement on retry, and serves a twin case from cache", async () => {
    let calls = 0;
    const fetchStub = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("the model is down");
      return reply(reading("Protea Bank"));
    }) as typeof fetch;

    const first = await seededCase("persist");
    const failed = await visionStep(deps(first, fetchStub), first);
    expect(failed.outcome).toBe("not_checked");
    expect((await readEvidence(env.DB, first)).map((e) => e.check)).toEqual(["vision.not_checked"]);

    const out = await visionStep(deps(first, fetchStub), first);
    expect(out.outcome).toBe("read");
    const items = (await readEvidence(env.DB, first)).filter((e) => e.check.startsWith("vision."));
    // The claimed brand's domain outcome rides with the reading (D03 T02 §4): the stub's grounded
    // answer cites nothing, so each picture's claim is stated unconfirmed, never a mismatch.
    expect(items.map((e) => e.check)).toEqual([
      "vision.claimed_brand",
      "vision.requested_action",
      "vision.urgency",
      "vision.claimed_brand",
      "vision.requested_action",
      "vision.brand_domain_mismatch",
      "vision.brand_domain_mismatch",
    ]);
    expect(items.every((e) => e.artefacts.length === 1 && e.artefacts[0]?.includes(first))).toBe(true);
    const view = ruleVerdict(await readEvidence(env.DB, first), { headersAvailable: true });
    expect(view.verdict).not.toBe("safe");
    expect(view.reasons.some((r) => items.some((i) => i.severity === "high" && r.evidenceIds.includes(i.id)))).toBe(
      true,
    );

    // A replay (the step's completion record failed after the evidence committed) is answered from
    // the cache and replaces the attempt's items instead of accumulating them.
    const replay = await visionStep(
      deps(first, (async () => {
        throw new Error("the cache must answer");
      }) as typeof fetch),
      first,
    );
    expect(replay.outcome).toBe("read");
    expect((await readEvidence(env.DB, first)).filter((e) => e.check.startsWith("vision."))).toHaveLength(7);

    // A twin case (the same message and attachment) is served from the cache too, with its own
    // artefact keys in the rebuilt evidence.
    const second = await seededCase("persist");
    const out2 = await visionStep(
      deps(second, (async () => {
        throw new Error("the cache must answer");
      }) as typeof fetch),
      second,
    );
    expect(out2.outcome).toBe("read");
    const twin = (await readEvidence(env.DB, second)).filter((e) => e.check.startsWith("vision."));
    expect(twin).toHaveLength(7);
    expect(twin.every((e) => e.artefacts[0]?.includes(second))).toBe(true);
  }, 300_000);

  it("keeps the email reading when a PDF body stalls past the phase budget and when a page read rejects", async () => {
    // A stalled attachment body consumes the shared PDF phase, so the document is stated not rendered
    // and the email is still read; a rejected page read loses only that image.
    const real = env.ARTEFACTS;
    const stalling = {
      put: (key: string, value: unknown, options?: unknown) =>
        (real.put as (...a: unknown[]) => unknown)(key, value, options),
      head: (key: string) => real.head(key),
      get: async (key: string, options?: unknown) => {
        // A body read that never answers inside any test budget: the phase, not the wait, must end it.
        if (key.includes("/attachments/")) await new Promise((r) => setTimeout(r, 30_000));
        return (real.get as (...a: unknown[]) => unknown)(key, options);
      },
    } as unknown as R2Bucket;
    const stalledStore: Store = { bucket: stalling, db: env.DB };
    const stalledCase = await seededCase("stall");
    const began = Date.now();
    const read = await visionStep(
      {
        ...deps(
          stalledCase,
          (async () => reply({ readings: [reading("Protea Bank").readings[0]] })) as typeof fetch,
          stalledStore,
        ),
        pdfPhaseMs: 40,
      },
      stalledCase,
    );
    expect(read.outcome).toBe("read");
    expect(Date.now() - began).toBeLessThan(20_000);
    const stalledItems = (await readEvidence(env.DB, stalledCase)).filter((e) => e.check.startsWith("vision."));
    expect(stalledItems.some((e) => e.check === "vision.pdf_unreadable" && e.detail.kind === "operational")).toBe(true);
    expect(stalledItems.some((e) => e.check === "vision.claimed_brand")).toBe(true);

    const rejecting = {
      put: (key: string, value: unknown, options?: unknown) =>
        (real.put as (...a: unknown[]) => unknown)(key, value, options),
      head: (key: string) => real.head(key),
      get: async (key: string, options?: unknown) => {
        if (key.includes("/page/")) throw new Error("r2 transfer failed");
        return (real.get as (...a: unknown[]) => unknown)(key, options);
      },
    } as unknown as R2Bucket;
    const rejectedCase = await seededCase("reject");
    const out = await visionStep(
      deps(rejectedCase, (async () => reply({ readings: [reading("Protea Bank").readings[0]] })) as typeof fetch, {
        bucket: rejecting,
        db: env.DB,
      }),
      rejectedCase,
    );
    expect(out.outcome).toBe("read");
    const items = (await readEvidence(env.DB, rejectedCase)).filter((e) => e.check.startsWith("vision."));
    expect(items.some((e) => e.check === "vision.claimed_brand")).toBe(true);
    expect(items.some((e) => e.check === "vision.coverage")).toBe(true);
  }, 300_000);

  it("starts no model call and writes nothing further after the deadline fires mid-step", async () => {
    const real = env.ARTEFACTS;
    const slow = {
      put: (key: string, value: unknown, options?: unknown) =>
        (real.put as (...a: unknown[]) => unknown)(key, value, options),
      head: (key: string) => real.head(key),
      get: async (key: string, options?: unknown) => {
        if (key.endsWith("/visible.txt")) await new Promise((r) => setTimeout(r, 150));
        return (real.get as (...a: unknown[]) => unknown)(key, options);
      },
    } as unknown as R2Bucket;
    let calls = 0;
    const caseId = await seededCase("late-visible");
    const out = await visionStep(
      {
        ...deps(
          caseId,
          (async () => {
            calls += 1;
            return reply(reading("Protea Bank"));
          }) as typeof fetch,
          { bucket: slow, db: env.DB },
        ),
        deadlineMs: 40,
      },
      caseId,
    );
    expect(out).toEqual({ outcome: "not_checked", reason: "timeout" });
    await new Promise((r) => setTimeout(r, 250));
    expect(calls).toBe(0);
    const items = (await readEvidence(env.DB, caseId)).filter((e) => e.check.startsWith("vision."));
    expect(items.map((e) => e.check)).toEqual(["vision.not_checked"]);
  }, 300_000);

  it("keeps the email reading when attachment discovery stalls past the PDF phase", async () => {
    // Discovery is a store wait inside the phase budget: listing the attachments slowly must not
    // hold the step; the email is still read and the unread documents are stated as coverage.
    const slowDb = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare")
          return (sql: string) => {
            const stmt = (target as D1Database).prepare(sql);
            if (!sql.includes("FROM artefacts")) return stmt;
            return {
              bind: (...args: unknown[]) => ({
                all: async () => {
                  await new Promise((r) => setTimeout(r, 250));
                  return stmt.bind(...(args as [])).all();
                },
                first: (...rest: unknown[]) => stmt.bind(...(args as [])).first(...(rest as [])),
              }),
            };
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const caseId = await seededCase("slow-discovery");
    const out = await visionStep(
      {
        ...deps(caseId, (async () => reply({ readings: [reading("Protea Bank").readings[0]] })) as typeof fetch, {
          bucket: env.ARTEFACTS,
          db: slowDb,
        }),
        pdfPhaseMs: 40,
      },
      caseId,
    );
    expect(out.outcome).toBe("read");
    const items = (await readEvidence(env.DB, caseId)).filter((e) => e.check.startsWith("vision."));
    expect(items.some((e) => e.check === "vision.claimed_brand")).toBe(true);
    expect(items.some((e) => e.check === "vision.coverage")).toBe(true);
  }, 300_000);

  it("segments the render and the PDF page into stored crops, and states a SAM failure as coverage", async () => {
    // The recorded stream of sam.test.ts (the parser README's masks), one confident box per concept.
    const mask = "!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(";
    const text = `<0f>0<|box;x1=10;y1=10;x2=60;y2=40;w=320;h=334;c=0.9|><|mask;x=0;y=0;data=27,60,~${mask}|>\n`;
    samResponder = () =>
      samSse([
        {
          type: "response.output_text.delta",
          item_id: "m1",
          output_index: 0,
          content_index: 0,
          delta: text,
        },
        { type: "response.output_text.done", item_id: "m1", output_index: 0, content_index: 0, text },
        {
          type: "response.completed",
          response: { id: "r", object: "response", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } },
        },
      ]);
    try {
      const caseId = await seededCase("segmented");
      const out = await visionStep(deps(caseId, (async () => reply(reading("Protea Bank"))) as typeof fetch), caseId);
      expect(out.outcome).toBe("read");
      // Three concepts on each of the render and the page: one crop each, plus one manifest per
      // source naming its current set.
      const crops = await artefactsOf(store, caseId, "crop");
      expect(crops.filter((c) => c.mediaType === "image/png")).toHaveLength(6);
      expect(crops.filter((c) => c.mediaType === "application/json")).toHaveLength(2);

      samResponder = () => {
        throw new Error("sam down");
      };
      const failedCase = await seededCase("segmented-down");
      const out2 = await visionStep(
        deps(failedCase, (async () => reply(reading("Protea Bank"))) as typeof fetch),
        failedCase,
      );
      expect(out2.outcome).toBe("read");
      const items = (await readEvidence(env.DB, failedCase)).filter((e) => e.check.startsWith("vision."));
      expect(items.some((e) => e.check === "vision.claimed_brand")).toBe(true);
      const coverage = items.find((e) => e.check === "vision.coverage");
      expect(JSON.stringify(coverage?.detail)).toContain("segmentation was unavailable");
      expect(await artefactsOf(store, failedCase, "crop")).toHaveLength(0);
    } finally {
      samResponder = samEmpty;
    }
  }, 300_000);

  it("compares each logo crop with the claimed brand's reference and reads the judgement back (D03 T03 §3)", async () => {
    const mask = "!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(";
    const text = `<0f>0<|box;x1=10;y1=10;x2=60;y2=40;w=320;h=334;c=0.9|><|mask;x=0;y=0;data=27,60,~${mask}|>\n`;
    samResponder = () =>
      samSse([
        { type: "response.output_text.delta", item_id: "m1", output_index: 0, content_index: 0, delta: text },
        { type: "response.output_text.done", item_id: "m1", output_index: 0, content_index: 0, text },
        {
          type: "response.completed",
          response: { id: "r", object: "response", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } },
        },
      ]);
    // The claimed brand's reference, in the store the Worker reads, under its indexed hash.
    const referenceBytes = new TextEncoder().encode("protea-bank-reference-logo-for-step-test");
    const digest = await crypto.subtle.digest("SHA-256", referenceBytes.buffer as ArrayBuffer);
    const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const referenceKey = "ref/logos/20260101T000000Z/protea-bank.png";
    await env.ARTEFACTS.put(referenceKey, referenceBytes);
    await env.ARTEFACTS.put(
      "ref/logos/index.json",
      JSON.stringify({
        version: 1,
        generation: "20260101T000000Z",
        generated_at: "2026-01-01T00:00:00Z",
        logos: [
          {
            slug: "protea-bank",
            brand: "Protea Bank",
            key: referenceKey,
            page_url: "https://proteabank.example/",
            source_url: "https://proteabank.example/logo.png",
            source_kind: "fictional",
            use: "detection-reference",
            fetched_at: "2026-01-01T00:00:00Z",
            media_type: "image/png",
            width: 512,
            height: 512,
            sha256: sha,
            fictional: true,
          },
        ],
        missing: [],
      }),
    );
    const fetchStub = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { text?: { format?: { name?: string } } };
      if (body.text?.format?.name === "logo_comparison")
        return reply({ same_brand: true, brand_seen: "Protea Bank", differences: [], confidence: 0.9 });
      return reply(reading("Protea Bank"));
    }) as typeof fetch;
    try {
      const caseId = await seededCase("logo-compared");
      const out = await visionStep(deps(caseId, fetchStub), caseId);
      expect(out.outcome).toBe("read");
      const matches = (await readEvidence(env.DB, caseId)).filter((e) => e.check === "vision.logo_match");
      // One logo crop per picture (the render and the PDF page), each compared and read back.
      expect(matches).toHaveLength(2);
      expect(matches.every((e) => e.detail.same_brand === true && e.detail.checked === true)).toBe(true);
      expect(matches.every((e) => e.artefacts.some((key) => key.includes("-logo-")))).toBe(true);

      // A replay with a different judgement replaces the logo results instead of accumulating
      // them, and the negative judgement reads back as a statement, never a clearance. The
      // reference changed first, so the replay's comparisons are not the cached ones.
      const changedReference = new TextEncoder().encode("protea-bank-reference-logo-changed-for-replay");
      const changedDigest = await crypto.subtle.digest("SHA-256", changedReference.buffer as ArrayBuffer);
      const changedSha = [...new Uint8Array(changedDigest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      await env.ARTEFACTS.put(referenceKey, changedReference);
      await env.ARTEFACTS.put(
        "ref/logos/index.json",
        JSON.stringify({
          version: 1,
          generation: "20260101T000000Z",
          generated_at: "2026-01-01T00:00:00Z",
          logos: [
            {
              slug: "protea-bank",
              brand: "Protea Bank",
              key: referenceKey,
              page_url: "https://proteabank.example/",
              source_url: "https://proteabank.example/logo.png",
              source_kind: "fictional",
              use: "detection-reference",
              fetched_at: "2026-01-01T00:00:00Z",
              media_type: "image/png",
              width: 512,
              height: 512,
              sha256: changedSha,
              fictional: true,
            },
          ],
          missing: [],
        }),
      );
      const differentStub = (async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { text?: { format?: { name?: string } } };
        if (body.text?.format?.name === "logo_comparison")
          return reply({
            same_brand: false,
            brand_seen: "Other Bank",
            differences: ["a different name and mark"],
            confidence: 0.8,
          });
        return reply(reading("Protea Bank"));
      }) as typeof fetch;
      const replay = await visionStep(deps(caseId, differentStub), caseId);
      expect(replay.outcome).toBe("read");
      const replaced = (await readEvidence(env.DB, caseId)).filter((e) => e.check === "vision.logo_match");
      expect(replaced).toHaveLength(2);
      expect(replaced.every((e) => e.detail.same_brand === false && e.severity === "info")).toBe(true);
    } finally {
      samResponder = samEmpty;
    }
  }, 300_000);

  it("clears the current crop set on a zero-match retry and leaves a stalled provider to the reading", async () => {
    const mask = "!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(";
    const text = `<0f>0<|box;x1=10;y1=10;x2=60;y2=40;w=320;h=334;c=0.9|><|mask;x=0;y=0;data=27,60,~${mask}|>\n`;
    const boxed = () =>
      samSse([
        { type: "response.output_text.delta", item_id: "m1", output_index: 0, content_index: 0, delta: text },
        { type: "response.output_text.done", item_id: "m1", output_index: 0, content_index: 0, text },
        {
          type: "response.completed",
          response: { id: "r", object: "response", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } },
        },
      ]);
    try {
      samResponder = boxed;
      const caseId = await seededCase("zero-match");
      await visionStep(deps(caseId, (async () => reply(reading("Protea Bank"))) as typeof fetch), caseId);
      expect((await artefactsOf(store, caseId, "crop")).filter((c) => c.mediaType === "image/png")).toHaveLength(6);

      // The retry finds nothing: each source's latest manifest now names an empty set.
      samResponder = samEmpty;
      await visionStep(deps(caseId, (async () => reply(reading("Protea Bank"))) as typeof fetch), caseId);
      const manifests = (await artefactsOf(store, caseId, "crop")).filter((c) => c.mediaType === "application/json");
      expect(manifests).toHaveLength(4);
      // The latest generation per source (its number is in the key) is the current set.
      const latest = new Map<string, { gen: number; crops: string[] }>();
      for (const manifest of manifests) {
        const back = await readArtefact(store, caseId, manifest.key);
        if (!back || !("body" in back)) throw new Error("manifest not read back");
        const parsed = JSON.parse(new TextDecoder().decode(back.body)) as {
          source: { name: string };
          crops: string[];
        };
        const gen = Number(/-manifest-(\d+)\.json$/.exec(manifest.key)?.[1] ?? 0);
        if (gen > (latest.get(parsed.source.name)?.gen ?? 0))
          latest.set(parsed.source.name, { gen, crops: parsed.crops });
      }
      expect(latest.size).toBe(2);
      for (const { crops } of latest.values()) expect(crops).toEqual([]);

      // A provider that never answers loses only segmentation: the reading still lands, with the
      // unfinished segmentation stated, inside the step's own deadline.
      samResponder = () =>
        new Response(new ReadableStream<Uint8Array>({ start: () => {} }), {
          headers: { "content-type": "text/event-stream", "cf-aig-log-id": "log-1" },
        });
      const stalledCase = await seededCase("sam-stalled");
      const started = Date.now();
      const out = await visionStep(
        {
          ...deps(stalledCase, (async () => reply(reading("Protea Bank"))) as typeof fetch),
          deadlineMs: 65_000,
        },
        stalledCase,
      );
      expect(out.outcome).toBe("read");
      expect(Date.now() - started).toBeLessThan(65_000);
      const items = (await readEvidence(env.DB, stalledCase)).filter((e) => e.check.startsWith("vision."));
      expect(items.some((e) => e.check === "vision.claimed_brand")).toBe(true);
      const coverage = items.find((e) => e.check === "vision.coverage");
      expect(JSON.stringify(coverage?.detail)).toContain("segmentation");
      expect(await artefactsOf(store, stalledCase, "crop")).toHaveLength(0);
    } finally {
      samResponder = samEmpty;
    }
  }, 300_000);

  it("loses one image to a stalled crop operation and still segments the next", async () => {
    const mask = "!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(";
    const text = `<0f>0<|box;x1=10;y1=10;x2=60;y2=40;w=320;h=334;c=0.9|><|mask;x=0;y=0;data=27,60,~${mask}|>\n`;
    samResponder = () =>
      samSse([
        { type: "response.output_text.delta", item_id: "m1", output_index: 0, content_index: 0, delta: text },
        { type: "response.output_text.done", item_id: "m1", output_index: 0, content_index: 0, text },
        {
          type: "response.completed",
          response: { id: "r", object: "response", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } },
        },
      ]);
    try {
      const caseId = await seededCase("stall-one-image");
      const base = deps(caseId, (async () => reply(reading("Protea Bank"))) as typeof fetch);
      let stalled = false;
      const launch = async () => {
        const browser = await puppeteer.launch(env.BROWSER);
        return new Proxy(browser, {
          get(target, prop) {
            if (prop === "newPage")
              return async (...args: unknown[]) => {
                const page = await (target.newPage as (...a: unknown[]) => Promise<Page>)(...args);
                const original = page.evaluate.bind(page) as (...a: unknown[]) => Promise<unknown>;
                (page as { evaluate: unknown }).evaluate = (...a: unknown[]) => {
                  // The first segmentation sizing evaluation (sam.ts alone uses createImageBitmap)
                  // never answers: its own operation bound, not the phase's remainder, ends it.
                  if (!stalled && typeof a[0] === "function" && String(a[0]).includes("createImageBitmap")) {
                    stalled = true;
                    return new Promise(() => {});
                  }
                  return original(...a);
                };
                return page;
              };
            const value = Reflect.get(target, prop);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as Browser;
      };
      const started = Date.now();
      const out = await visionStep({ ...base, launch }, caseId);
      expect(out.outcome).toBe("read");
      // The second image's three crops landed; the first image's loss is stated.
      expect((await artefactsOf(store, caseId, "crop")).filter((c) => c.mediaType === "image/png")).toHaveLength(3);
      const items = (await readEvidence(env.DB, caseId)).filter((e) => e.check.startsWith("vision."));
      const coverage = items.find((e) => e.check === "vision.coverage");
      expect(JSON.stringify(coverage?.detail)).toContain("segmentation was unavailable");
      expect(Date.now() - started).toBeLessThan(120_000);
    } finally {
      samResponder = samEmpty;
    }
  }, 300_000);

  it("states a page body that cannot be read back as coverage and does not cache the partial reading", async () => {
    const real = env.ARTEFACTS;
    const dropping = {
      put: (key: string, value: unknown, options?: unknown) =>
        (real.put as (...a: unknown[]) => unknown)(key, value, options),
      head: (key: string) => real.head(key),
      get: (key: string, options?: unknown) =>
        key.includes("/page/") ? Promise.resolve(null) : (real.get as (...a: unknown[]) => unknown)(key, options),
    } as unknown as R2Bucket;
    const theStore: Store = { bucket: dropping, db: env.DB };
    let calls = 0;
    // Only the rendered email is sent (the page body cannot be read back), so the answer names it alone.
    const fetchStub = (async () => {
      calls += 1;
      return reply({ readings: [reading("Protea Bank").readings[0]] });
    }) as typeof fetch;
    const caseId = await seededCase("missing-page");
    const out = await visionStep(deps(caseId, fetchStub, theStore), caseId);
    expect(out.outcome).toBe("read");
    const items = (await readEvidence(env.DB, caseId)).filter((e) => e.check.startsWith("vision."));
    const coverage = items.find((e) => e.check === "vision.coverage");
    expect(coverage?.detail).toMatchObject({ checked: false, complete: false });
    expect(JSON.stringify(coverage?.detail)).toContain("could not be read back");
    // Not cached: a second run spends the model again (each run is the reading call plus the
    // claimed brand's grounded call, D03 T02 §4, which the same stub answers).
    await visionStep(deps(caseId, fetchStub, theStore), caseId);
    expect(calls).toBe(4);
  }, 300_000);
});

// D03 T02 §4 at the step: claimed brands compared with the domains the case holds, isolated from
// the reading, replaced on replay, and fenced by the step deadline.
describe("visionStep brand domains (D03 T02 §4)", () => {
  const groundedReply = (text: string, url: string, title: string) =>
    new Response(
      JSON.stringify({
        id: "r",
        object: "response",
        status: "completed",
        output: [
          { type: "web_search_call", id: "ws_1", status: "completed" },
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text,
                annotations: [{ type: "url_citation", url, title, start_index: 0, end_index: 8 }],
              },
            ],
          },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
      { headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", "x-request-id": "req-1" } },
    );

  const readingFor = (brand: string, shownSender = "billing@evil.example") => ({
    readings: [
      {
        image: "image-1",
        claimed_brand: brand,
        requested_action: "pay",
        urgency_cues: [],
        visible_sender: shownSender,
        payment_request: true,
        confidence: 0.9,
      },
      {
        image: "image-2",
        claimed_brand: brand,
        requested_action: "pay",
        urgency_cues: [],
        visible_sender: null,
        payment_request: true,
        confidence: 0.8,
      },
    ],
  });
  const lanternReading = readingFor("Lantern Bank");

  const routed = (
    groundedImpl: (body: string) => Response | Promise<Response>,
    readingBody: unknown = lanternReading,
  ) =>
    (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      if (body.includes("web_search")) return groundedImpl(body);
      return reply(readingBody);
    }) as typeof fetch;

  it("replaces brand outcomes on replay: unconfirmed, then a cited mismatch, then unjudged, with PDF items kept", async () => {
    const caseId = await seededCase("brand-transitions");
    await putAttachment(store, caseId, "broken.pdf", new TextEncoder().encode("%PDF-1.4 damaged"), "application/pdf");
    let cited = false;
    const fetchStub = routed(() =>
      cited
        ? groundedReply("DOMAIN: lanternbank.example", "https://lanternbank.example/about", "Lantern Bank official")
        : reply({}),
    );
    const brandItems = async () =>
      (await readEvidence(env.DB, caseId)).filter((e) => e.check === "vision.brand_domain_mismatch");

    await visionStep(deps(caseId, fetchStub), caseId);
    let items = await brandItems();
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((e) => e.detail.confirmed === false)).toBe(true);
    expect((await readEvidence(env.DB, caseId)).some((e) => e.check === "vision.pdf_unreadable")).toBe(true);

    cited = true;
    await visionStep(deps(caseId, fetchStub), caseId);
    items = await brandItems();
    expect(
      items.some((e) => e.severity === "high" && e.detail.source_url === "https://lanternbank.example/about"),
    ).toBe(true);
    expect((await readEvidence(env.DB, caseId)).some((e) => e.check === "vision.claimed_brand")).toBe(true);
    expect((await readEvidence(env.DB, caseId)).some((e) => e.check === "vision.pdf_unreadable")).toBe(true);
    const afterMismatch = items.length;

    // The resolution the next case would reuse now also proposes the shown domain: for this
    // picture it is unjudged (grounding never clears a domain it is judging), so the high item
    // is replaced by an unconfirmed one, not kept beside it.
    await (env as unknown as Env).CACHE.put(
      "vision:brand:v2:brand-domains-1:lanternbank",
      JSON.stringify({
        domains: ["lanternbank.example", "evil.example"],
        proposed: ["lanternbank.example", "evil.example"],
        source_url: "https://lanternbank.example/about",
        expires_at: Date.now() + 60_000,
      }),
    );
    await visionStep(deps(caseId, fetchStub), caseId);
    items = await brandItems();
    expect(items.some((e) => e.severity === "high")).toBe(false);
    expect(items.length).toBeLessThanOrEqual(afterMismatch);
    expect(items.every((e) => e.detail.confirmed === false)).toBe(true);
    expect((await readEvidence(env.DB, caseId)).some((e) => e.check === "vision.pdf_unreadable")).toBe(true);
  }, 300_000);

  it("writes no brand item when every compared domain is the table brand's own", async () => {
    const caseId = await seededCase("brand-match");
    const fetchStub = routed(
      () => {
        throw new Error("a table brand needs no grounded call");
      },
      readingFor("Standard Bank", "alerts@standardbank.co.za"),
    );
    const out = await visionStep(deps(caseId, fetchStub), caseId);
    expect(out.outcome).toBe("read");
    const items = (await readEvidence(env.DB, caseId)).filter((e) => e.check.startsWith("vision."));
    expect(items.some((e) => e.check === "vision.claimed_brand")).toBe(true);
    // The email picture's shown domain is the bank's own; the PDF picture holds no domain to
    // compare, which is stated, and nothing is accused.
    expect(items.filter((e) => e.severity === "high" && e.check === "vision.brand_domain_mismatch")).toEqual([]);
    expect(
      items
        .filter((e) => e.check === "vision.brand_domain_mismatch")
        .every((e) => e.detail.reason === "no-domain" || e.detail.domain === "standardbank.co.za"),
    ).toBe(true);
  }, 300_000);

  it("compares a direct link in the message itself, which no link finding named (round 1)", async () => {
    const made = await createCase(env.DB, { orgId: "org-vision-read", channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const caseId = made.value.id;
    await storeMail(store, caseId, { text: `${TEXT} [direct-link] Verify at https://evil.example/login today.` });
    await putAttachment(store, caseId, "invoice-77.pdf", makePdf(["Invoice 77"]), "application/pdf");
    const fetchStub = routed(
      () => {
        throw new Error("a table brand needs no grounded call");
      },
      readingFor("Standard Bank", "alerts@standardbank.co.za"),
    );
    const out = await visionStep(deps(caseId, fetchStub), caseId);
    expect(out.outcome).toBe("read");
    const items = (await readEvidence(env.DB, caseId)).filter((e) => e.check === "vision.brand_domain_mismatch");
    const mismatch = items.find((e) => e.severity === "high");
    expect(mismatch?.detail).toMatchObject({ confirmed: true, source: "table" });
    expect(JSON.stringify(mismatch?.detail)).toContain('"kind":"landing"');
    expect(JSON.stringify(mismatch?.detail)).toContain("evil.example");
  }, 300_000);

  it("bounds the brand stage's setup reads by its deadline (round 1)", async () => {
    const caseId = await seededCase("brand-setup-stall");
    const real = env.ARTEFACTS;
    let parsedReads = 0;
    const stalling = {
      put: (key: string, value: unknown, options?: unknown) =>
        (real.put as (...a: unknown[]) => unknown)(key, value, options),
      head: (key: string) => real.head(key),
      get: async (key: string, options?: unknown) => {
        // The render reads the summary first; only the brand stage's later read stalls.
        if (key.endsWith("/parsed.json")) {
          parsedReads += 1;
          if (parsedReads > 1) await new Promise((r) => setTimeout(r, 30_000));
        }
        return (real.get as (...a: unknown[]) => unknown)(key, options);
      },
    } as unknown as R2Bucket;
    const fetchStub = routed(() =>
      groundedReply("DOMAIN: lanternbank.example", "https://lanternbank.example/about", "Lantern Bank official"),
    );
    const began = Date.now();
    const out = await visionStep(
      { ...deps(caseId, fetchStub, { bucket: stalling, db: env.DB }), brandPhaseMs: 100 },
      caseId,
    );
    expect(out.outcome).toBe("read");
    expect(Date.now() - began).toBeLessThan(25_000);
    const items = (await readEvidence(env.DB, caseId)).filter((e) => e.check.startsWith("vision."));
    expect(items.some((e) => e.check === "vision.claimed_brand")).toBe(true);
  }, 300_000);

  it("states a grounded outage unconfirmed and leaves the reading standing", async () => {
    const caseId = await seededCase("brand-outage");
    const fetchStub = routed(() => {
      throw new Error("search is down");
    });
    const out = await visionStep(deps(caseId, fetchStub), caseId);
    expect(out.outcome).toBe("read");
    const items = (await readEvidence(env.DB, caseId)).filter((e) => e.check.startsWith("vision."));
    expect(items.some((e) => e.check === "vision.claimed_brand")).toBe(true);
    expect(items.some((e) => e.check === "vision.brand_domain_mismatch" && e.detail.confirmed === false)).toBe(true);
  }, 300_000);

  it("states a stalled lookup unconfirmed, keeps the committed reading, and publishes no cache entry (G6)", async () => {
    const caseId = await seededCase("brand-stalled");
    let groundedStarted = 0;
    const fetchStub = routed(async () => {
      groundedStarted += 1;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return groundedReply("DOMAIN: stallbank.example", "https://stallbank.example/about", "Stall Bank official");
    }, readingFor("Stall Bank"));
    const out = await visionStep({ ...deps(caseId, fetchStub), brandPhaseMs: 100 }, caseId);
    expect(groundedStarted).toBeGreaterThan(0);
    expect(out.outcome).toBe("read");
    const items = (await readEvidence(env.DB, caseId)).filter((e) => e.check.startsWith("vision."));
    expect(items.some((e) => e.check === "vision.claimed_brand")).toBe(true);
    expect(
      items.some(
        (e) => e.check === "vision.brand_domain_mismatch" && e.detail.confirmed === false && e.detail.checked === false,
      ),
    ).toBe(true);
    // No accepted resolution was published by the late answer for this brand.
    const cachedEntry = await (env as unknown as Env).CACHE.get("vision:brand:v2:brand-domains-1:stallbank", "json");
    expect(cachedEntry).toBeNull();
  }, 300_000);
});

describe("landingHostsFrom (D03 T02 §4, G1)", () => {
  it("takes only link destination fields, never provider references or vision sources", () => {
    const hosts = landingHostsFrom([
      {
        check: "link.redirects",
        detail: {
          link: "https://shop.example/start",
          final: "https://landing.example/end",
          hops: [{ url: "https://hop.example/mid", status: 302 }],
        },
      },
      {
        check: "reputation.listing",
        detail: { source_url: "https://delist.provider.example/protea", url: "https://provider.example/x" },
      },
      { check: "vision.brand_domain_mismatch", detail: { source_url: "https://lanternbank.example/about" } },
      { check: "link.text_mismatch", detail: { href: "https://written.example/click", shown: "proteabank.example" } },
    ]);
    expect(hosts.sort()).toEqual(["hop.example", "landing.example", "shop.example", "written.example"]);
  });
});
