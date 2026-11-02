import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addEvidence, readEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { d1Budget } from "../../src/meta/budget";
import { cacheKey } from "../../src/meta/cache";
import { coverageItem, type ReadingContext, readingItems, readMail } from "../../src/vision/reading";
import {
  type MailReading,
  mailReadingSchema,
  READING_PROMPT_VERSION,
  READING_SCHEMA_VERSION,
} from "../../src/vision/reading-schema";

// D03 T02 §3: the Muse Spark reading of a message's pictures, through a stubbed Meta transport, the real
// budget on migrated D1 and the real CACHE KV. No Meta credit is spent.
const db = (env as unknown as Env).DB;
const kv = (env as unknown as Env).CACHE;
const META = { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" };
const TEXT = "Pay invoice 77 today or the account closes.";
// The CACHE KV is shared across this file, so each call test reads a different message text: its cache
// key differs and no test is answered by another's entry.
const text = (marker: string) => `${TEXT} [${marker}]`;

const PNG_A = "a".repeat(64);
const PNG_B = "b".repeat(64);
const images = (shaA = PNG_A, shaB = PNG_B) => [
  {
    id: "image-1",
    promptLabel: "the rendered email as the recipient saw it",
    key: "art/c/render-a.png",
    name: "desktop-1024.png",
    sha256: shaA,
    dataUrl: "data:image/png;base64,AAA",
  },
  {
    id: "image-2",
    promptLabel: "page 1 of a PDF attachment",
    key: "art/c/page-b.png",
    name: "invoice.pdf page 1",
    sha256: shaB,
    dataUrl: "data:image/png;base64,BBB",
  },
];

const READING: MailReading = {
  readings: [
    {
      image: "image-1",
      claimed_brand: "Protea Bank",
      requested_action: "log_in",
      urgency_cues: ["Act within 24 hours"],
      visible_sender: "alerts@proteabank.example",
      payment_request: false,
      confidence: 0.9,
    },
    {
      image: "image-2",
      claimed_brand: "Fictional Supplier",
      requested_action: "pay",
      urgency_cues: [],
      visible_sender: null,
      payment_request: true,
      confidence: 0.8,
    },
  ],
};

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

function harness(script: (() => Response)[], caseId = "01HZREADCASE00000000000001") {
  const bodies: string[] = [];
  let calls = 0;
  const ctx: ReadingContext = {
    meta: {
      env: META,
      budget: d1Budget(db, { caller: "vision", caseId }),
      owner: { kind: "case", caseId, step: "vision" },
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(String(init?.body));
        calls += 1;
        const next = script[calls - 1];
        if (!next) throw new Error("the script has no more answers");
        return next();
      }) as typeof fetch,
    },
    kv,
    owner: { kind: "case", caseId, step: "vision" },
    waitUntil: () => {},
  };
  return { ctx, bodies, calls: () => calls };
}

beforeEach(async () => {
  await db.prepare("DELETE FROM model_spend").run();
});

describe("mailReadingSchema", () => {
  it("is non-recursive and refuses out-of-range values and unsent images", () => {
    const schema = mailReadingSchema(["image-1", "image-2"]);
    expect(JSON.stringify(schema.toJSONSchema())).not.toContain('"$ref"');
    const good = { ...READING.readings[0] };
    expect(schema.safeParse(READING).success).toBe(true);
    expect(schema.safeParse({ readings: [{ ...good, confidence: 1.4 }] }).success).toBe(false);
    expect(schema.safeParse({ readings: [{ ...good, image: "image-9" }] }).success).toBe(false);
    expect(schema.safeParse({ readings: [{ ...good, claimed_brand: "x".repeat(121) }] }).success).toBe(false);
  });
});

describe("readMail", () => {
  it("sends the images and the visible text only inside its untrusted block, store false", async () => {
    const h = harness([() => reply(READING)]);
    const value = await readMail(h.ctx, images(), text("request"), true);
    expect(value).toEqual(READING);
    const body = JSON.parse(h.bodies[0] ?? "");
    expect(body.model).toBe("muse-spark-1.3");
    expect(body.store).toBe(false);
    const raw = h.bodies[0] ?? "";
    expect(raw).toContain("data:image/png;base64,AAA");
    expect(raw).toContain("<<UNTRUSTED:email:");
    expect(raw.split(text("request")).length - 1).toBe(1);
    expect(raw.indexOf(text("request"))).toBeGreaterThan(raw.indexOf("<<UNTRUSTED:email:"));
  });

  it("refuses a reading that does not name each image once, and a refused answer", async () => {
    const doubled = { readings: [READING.readings[0], READING.readings[0]] };
    await expect(readMail(harness([() => reply(doubled)]).ctx, images(), text("doubled"), true)).rejects.toThrow();
    const refusal = new Response(
      JSON.stringify({
        id: "r",
        object: "response",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", "x-request-id": "req-1" } },
    );
    await expect(readMail(harness([() => refusal]).ctx, images(), text("refused"), true)).rejects.toThrow();
  });

  it("serves an identical second case from the cache and misses on changed text or image", async () => {
    const first = harness([() => reply(READING)], "01HZREADCASE0000000000000A");
    await readMail(first.ctx, images(), text("cache"), true);
    expect(first.calls()).toBe(1);
    const second = harness([], "01HZREADCASE0000000000000B");
    expect(await readMail(second.ctx, images(), text("cache"), true)).toEqual(READING);
    expect(second.calls()).toBe(0);
    const changedText = harness([() => reply(READING)], "01HZREADCASE0000000000000C");
    await readMail(changedText.ctx, images(), `${text("cache")} Now.`, true);
    expect(changedText.calls()).toBe(1);
    const changedImage = harness([() => reply(READING)], "01HZREADCASE0000000000000D");
    await readMail(changedImage.ctx, images("c".repeat(64)), text("cache"), true);
    expect(changedImage.calls()).toBe(1);
    // The prompt version is part of the key: a new version can never read the old answer.
    const inputs = {
      task: "vision.mail-reading",
      model: "muse-spark-1.3" as const,
      promptVersion: READING_PROMPT_VERSION,
      schemaVersion: READING_SCHEMA_VERSION,
      artefacts: [PNG_A],
    };
    expect(await cacheKey({ ...inputs, promptVersion: "mail-reading-0" })).not.toBe(await cacheKey(inputs));
  });

  it("starts no model call when the caller's deadline passes during the cache lookup", async () => {
    // The cache lookup is awaited before the produce function runs: expiry inside it must refuse the
    // spend, not start the request with a fresh minute.
    const slowKv = {
      get: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return null;
      },
      put: async () => {},
    } as unknown as KVNamespace;
    let calls = 0;
    const h = harness([
      () => {
        calls += 1;
        return reply(READING);
      },
    ]);
    const at = Date.now() + 30;
    await expect(
      readMail({ ...h.ctx, kv: slowKv }, images(), text("deadline"), true, { at, expired: () => Date.now() > at }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("never caches an incomplete picture", async () => {
    const h = harness([() => reply(READING), () => reply(READING)]);
    await readMail(h.ctx, images(), text("partial"), false);
    await readMail(h.ctx, images(), text("partial"), false);
    expect(h.calls()).toBe(2);
  });
});

describe("readingItems persistence", () => {
  it("persists a formatted sender and a full-length quote through the evidence store", async () => {
    // Ordinary and hostile model text must survive the store's plain-summary contract: markup is
    // stripped and the summary cut, the full values kept in the detail.
    const hostile: MailReading = {
      readings: [
        {
          image: "image-1",
          claimed_brand: "Protea Bank",
          requested_action: "pay",
          urgency_cues: ["x".repeat(200)],
          visible_sender: "Accounts <billing@fictional.example>",
          payment_request: true,
          confidence: 0.7,
        },
      ],
    };
    const items = readingItems(hostile, images());
    const made = await createCase(db, { orgId: "org-reading", channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const stored = await addEvidence(db, made.value.id, "vision", items);
    expect(stored).toHaveLength(3);
    for (const item of stored) {
      expect(Array.from(item.summary).length).toBeLessThanOrEqual(200);
      expect(item.summary).not.toContain("<");
    }
    const brand = stored.find((i) => i.check === "vision.claimed_brand");
    expect(brand?.detail.visible_sender).toBe("Accounts <billing@fictional.example>");
    const urgency = stored.find((i) => i.check === "vision.urgency");
    if (!urgency) throw new Error("vision.urgency item missing");
    expect((urgency.detail.quotes as string[])[0]).toHaveLength(200);
  });

  it("writes nothing when the caller's fence closes during the sequence read", async () => {
    // The fence is re-read after the awaited sequence read, immediately before the batch: a write
    // whose caller expired while the store was answering must not land over the caller's statement.
    const made = await createCase(db, { orgId: "org-reading", channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    let fenced = false;
    setTimeout(() => {
      fenced = true;
    }, 20);
    const slowDb = new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare")
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!sql.includes("SELECT seq FROM evidence")) return stmt;
            return {
              bind: (...args: unknown[]) => ({
                all: async () => {
                  await new Promise((r) => setTimeout(r, 200));
                  return stmt.bind(...(args as [])).all();
                },
              }),
            };
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const stored = await addEvidence(
      slowDb,
      made.value.id,
      "vision",
      [coverageItem(["listed late"])],
      undefined,
      () => fenced,
    );
    expect(stored).toEqual([]);
    expect(await readEvidence(db, made.value.id)).toEqual([]);
  });

  it("writes nothing when its batch only executes after the caller's deadline", async () => {
    // The deadline is enforced inside the batch's own SQL, not only before it: a batch delayed in
    // flight past the deadline deletes and inserts nothing when it finally executes.
    const made = await createCase(db, { orgId: "org-reading", channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const slowDb = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch")
          return async (statements: unknown[]) => {
            await new Promise((r) => setTimeout(r, 200));
            return target.batch(statements as Parameters<D1Database["batch"]>[0]);
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const stored = await addEvidence(
      slowDb,
      made.value.id,
      "vision",
      [coverageItem(["too late"])],
      undefined,
      undefined,
      Date.now() + 50,
    );
    expect(stored).toEqual([]);
    expect(await readEvidence(db, made.value.id)).toEqual([]);
  });
});

describe("readingItems", () => {
  it("maps each image's reading to its own items with the fixed severity map", () => {
    const items = readingItems(READING, images());
    const brand = items.filter((i) => i.check === "vision.claimed_brand");
    expect(brand).toHaveLength(2);
    expect(brand[0]?.detail.source_key).toBe("art/c/render-a.png");
    expect(brand[1]?.detail.source_key).toBe("art/c/page-b.png");
    expect(brand[1]?.summary).toContain("Fictional Supplier");
    const actions = Object.fromEntries(
      items.filter((i) => i.check === "vision.requested_action").map((i) => [i.detail.source_key, i.severity]),
    );
    expect(actions["art/c/render-a.png"]).toBe("high");
    expect(actions["art/c/page-b.png"]).toBe("medium");
    expect(items.filter((i) => i.check === "vision.urgency")).toHaveLength(1);
    // Nothing shown, nothing asked, no cues: no items are invented.
    const empty: MailReading = {
      readings: [
        {
          image: "image-1",
          claimed_brand: null,
          requested_action: "none" as const,
          urgency_cues: [],
          visible_sender: null,
          payment_request: false,
          confidence: 0.5,
        },
      ],
    };
    expect(readingItems(empty, images())).toEqual([]);
  });
});
