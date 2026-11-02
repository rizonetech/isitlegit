import { env } from "cloudflare:test";
import puppeteer from "@cloudflare/puppeteer";
import { describe, expect, it } from "vitest";
import { ruleVerdict } from "../../src/agent/rule-verdict";
import { readEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { putAttachment, type Store } from "../../src/intake/store";
import { d1Budget } from "../../src/meta/budget";
import { type VisionDeps, visionStep } from "../../src/vision/step";
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

function deps(caseId: string, fetchImpl: typeof fetch, theStore: Store = store): VisionDeps {
  return {
    db: env.DB,
    store: theStore,
    launch: () => puppeteer.launch(env.BROWSER),
    meta: { env: META, budget: d1Budget(env.DB, { caller: "vision", caseId }), fetch: fetchImpl },
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
    expect(items.map((e) => e.check)).toEqual([
      "vision.claimed_brand",
      "vision.requested_action",
      "vision.urgency",
      "vision.claimed_brand",
      "vision.requested_action",
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
    expect((await readEvidence(env.DB, first)).filter((e) => e.check.startsWith("vision."))).toHaveLength(5);

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
    expect(twin).toHaveLength(5);
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
    // Not cached: a second run spends the model again.
    await visionStep(deps(caseId, fetchStub, theStore), caseId);
    expect(calls).toBe(2);
  }, 300_000);
});
