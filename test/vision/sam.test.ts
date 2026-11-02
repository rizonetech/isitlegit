import { env } from "cloudflare:test";
import puppeteer, { type Browser } from "@cloudflare/puppeteer";
import { describe, expect, it } from "vitest";
import { createCase } from "../../src/db/cases";
import { artefactsOf, readArtefact, type Store } from "../../src/intake/store";
import type { MetaContext } from "../../src/meta/client";
import type { Budget } from "../../src/meta/guard";
import {
  type Crop,
  cropBoxes,
  type SegmentBox,
  SegmentError,
  segment,
  segmentImage,
  selectBoxes,
  storeCrops,
} from "../../src/vision/sam";

// D03 T03 §1: SAM 3.1 segmentation through a stubbed streaming transport (recorded SAM output built
// on the parser package's own documented example), crops on the real Browser Run canvas, and the
// artefact store. No Meta credit is spent.
const META = { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" };
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };

// The mask payloads of the parser README's documented example (a 27x60 and a 27x48 raster); the box
// tokens around them are this test's own, so a recorded stream can name its boxes and confidences.
const MASKS = [
  { h: 27, w: 60, payload: "!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(" },
  { h: 27, w: 48, payload: "!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@" },
];
type Spec = { x1: number; y1: number; x2: number; y2: number; c?: number };
const record = (id: number, s: Spec, mask: (typeof MASKS)[number]) =>
  `${id}<|box;x1=${s.x1};y1=${s.y1};x2=${s.x2};y2=${s.y2};w=320;h=334${s.c === undefined ? "" : `;c=${s.c}`}|>` +
  `<|mask;x=0;y=0;data=${mask.h},${mask.w},~${mask.payload}|>`;
const samText = (specs: Spec[]) =>
  `<0f>${specs.map((s, i) => record(i, s, MASKS[i % MASKS.length] as (typeof MASKS)[number])).join(",")}\n`;

const delta = (text: string, at = 0) => ({
  type: "response.output_text.delta",
  item_id: "m1",
  output_index: 0,
  content_index: 0,
  delta: text,
  sequence_number: at,
});
const done = (text: string) => ({
  type: "response.output_text.done",
  item_id: "m1",
  output_index: 0,
  content_index: 0,
  text,
  sequence_number: 98,
});
const completed = {
  type: "response.completed",
  sequence_number: 99,
  response: {
    id: "r1",
    object: "response",
    status: "completed",
    model: "sam-3.1",
    output: [],
    usage: { input_tokens: 10, output_tokens: 5 },
  },
};
const sse = (events: unknown[]) =>
  new Response(`${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream", "cf-aig-log-id": "log-1", "x-request-id": "req-1" },
  });

type Charge = { state: string };
function ctx(fetchImpl: typeof fetch) {
  const charges: Charge[] = [];
  const budget: Budget = {
    reserve: async () => {
      charges.push({ state: "reserved" });
      return `r${charges.length}`;
    },
    refused: async () => {},
    cached: async () => {},
    outputFailed: async () => {},
    settle: async (id) => {
      charges[Number(id.slice(1)) - 1] = { state: "settled" };
    },
    uncertain: async (id) => {
      charges[Number(id.slice(1)) - 1] = { state: "uncertain" };
    },
  };
  const meta: MetaContext = {
    env: META,
    budget,
    owner: { kind: "case", caseId: "case-sam", step: "vision" },
    fetch: fetchImpl,
    sleep: async () => {},
    random: () => 0.5,
  };
  return { meta, charges };
}

const IMAGE = "data:image/png;base64,AAA";

describe("segment", () => {
  it("parses a recorded stream into boxes and sends one concept per request", async () => {
    const bodies: Record<string, unknown>[] = [];
    const text = samText([
      { x1: 211, y1: 228, x2: 270, y2: 254, c: 0.9 },
      { x1: 155, y1: 228, x2: 202, y2: 254 },
    ]);
    const { meta } = ctx((async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      // Fragmented deltas, split inside a mask payload.
      return sse([delta(text.slice(0, 60), 0), delta(text.slice(60), 1), done(text), completed]);
    }) as typeof fetch);
    const boxes = await segment(meta, IMAGE, "logo");
    expect(boxes).toEqual([
      { concept: "logo", left: 211, top: 228, right: 271, bottom: 255, confidence: 0.9 },
      { concept: "logo", left: 155, top: 228, right: 203, bottom: 255, confidence: null },
    ]);
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as {
      model: string;
      stream: boolean;
      store: boolean;
      metadata: Record<string, string>;
      input: { content: { type: string; text?: string }[] }[];
    };
    expect(body.model).toBe("sam-3.1");
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.metadata).toEqual({ include_confidence: "true", mask_encoding: "one_bit" });
    const texts = body.input[0]?.content.filter((p) => p.type === "input_text") ?? [];
    expect(texts).toHaveLength(1);
    expect(texts[0]?.text).toBe("logo");
    expect(body.input[0]?.content.some((p) => p.type === "input_image")).toBe(true);
  });

  it("makes three requests per image, one per concept in order", async () => {
    const concepts: string[] = [];
    const { meta } = ctx((async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: { content: { type: string; text?: string }[] }[] };
      concepts.push(body.input[0]?.content.find((p) => p.type === "input_text")?.text ?? "");
      const one = samText([{ x1: 1, y1: 1, x2: 9, y2: 9, c: 0.9 }]);
      return sse([delta(one), done(one), completed]);
    }) as typeof fetch);
    const { boxes, failures } = await segmentImage(meta, IMAGE);
    expect(concepts).toEqual(["logo", "stamp", "signature"]);
    expect(failures).toEqual([]);
    expect(boxes.map((b) => b.concept)).toEqual(["logo", "stamp", "signature"]);
  });

  it("keeps the successful concepts when another concept fails", async () => {
    const { meta } = ctx((async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: { content: { type: string; text?: string }[] }[] };
      const concept = body.input[0]?.content.find((p) => p.type === "input_text")?.text;
      if (concept === "stamp") throw new Error("provider down");
      const one = samText([{ x1: 1, y1: 1, x2: 9, y2: 9, c: 0.9 }]);
      return sse([delta(one), done(one), completed]);
    }) as typeof fetch);
    const { boxes, failures } = await segmentImage(meta, IMAGE);
    expect(boxes.map((b) => b.concept)).toEqual(["logo", "signature"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(SegmentError);
  });

  it("aborts a later concept's active stream at the absolute deadline", async () => {
    let calls = 0;
    const { meta } = ctx((async (_input: RequestInfo | URL, _init?: RequestInit) => {
      calls++;
      if (calls === 1) {
        const one = samText([{ x1: 1, y1: 1, x2: 9, y2: 9, c: 0.9 }]);
        return sse([delta(one), done(one), completed]);
      }
      // A stream that never yields: only the caller's deadline ends it.
      return new Response(new ReadableStream<Uint8Array>({ start: () => {} }), {
        headers: { "content-type": "text/event-stream", "cf-aig-log-id": "log-1" },
      });
    }) as typeof fetch);
    const started = Date.now();
    const { boxes, failures } = await segmentImage(meta, IMAGE, Date.now() + 150);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(boxes.map((b) => b.concept)).toEqual(["logo"]);
    expect(failures.length).toBeGreaterThanOrEqual(1);
  });

  it("types its outcomes: zero matches, incomplete, refused, malformed and unavailable are distinct", async () => {
    const empty = ctx((async () => sse([done(""), completed])) as typeof fetch);
    await expect(segment(empty.meta, IMAGE, "logo")).resolves.toEqual([]);

    const cut = ctx((async () => sse([delta(samText([{ x1: 1, y1: 1, x2: 9, y2: 9 }]))])) as typeof fetch);
    await expect(segment(cut.meta, IMAGE, "logo")).rejects.toMatchObject({ name: "SegmentError", kind: "incomplete" });

    const refusal = ctx((async () =>
      sse([
        { type: "response.refusal.done", item_id: "m1", output_index: 0, content_index: 0, refusal: "no" },
        completed,
      ])) as typeof fetch);
    await expect(segment(refusal.meta, IMAGE, "logo")).rejects.toMatchObject({ kind: "refused" });

    const malformed = ctx((async () =>
      sse([
        delta("<0f>9<|box;x1=1|><|mask;x=0;y=0;data=27,60,~!!!!|>\n"),
        done("<0f>9<|box;x1=1|><|mask;x=0;y=0;data=27,60,~!!!!|>\n"),
        completed,
      ])) as typeof fetch);
    await expect(segment(malformed.meta, IMAGE, "logo")).rejects.toMatchObject({ kind: "malformed" });

    const down = ctx((async () => {
      throw new Error("socket closed");
    }) as typeof fetch);
    await expect(segment(down.meta, IMAGE, "logo")).rejects.toMatchObject({ kind: "unavailable" });
  });
});

describe("selectBoxes", () => {
  const box = (concept: SegmentBox["concept"], confidence: number | null, left = 0): SegmentBox => ({
    concept,
    left,
    top: 0,
    right: 10,
    bottom: 10,
    confidence,
  });

  it("keeps the 0.4 boundary, keeps an unscored box below every scored one, and caps at 8 per image", () => {
    expect(selectBoxes([box("logo", 0.4), box("logo", 0.399)])).toHaveLength(1);
    const ranked = selectBoxes([box("logo", null), box("logo", 0.5), box("logo", 0.9)]);
    expect(ranked.map((b) => b.confidence)).toEqual([0.9, 0.5, null]);
    const many = [
      ...Array.from({ length: 5 }, (_, i) => box("logo", 0.9, i)),
      ...Array.from({ length: 5 }, (_, i) => box("stamp", 0.95, i)),
      ...Array.from({ length: 5 }, (_, i) => box("signature", 0.99, i)),
    ];
    const capped = selectBoxes(many);
    expect(capped).toHaveLength(8);
    expect(capped.slice(0, 5).every((b) => b.concept === "logo")).toBe(true);
    expect(capped.slice(5).every((b) => b.concept === "stamp")).toBe(true);
  });

  it("drops a box holding no pixel of the decoded picture before ranking, and keeps a partial overlap", () => {
    const outside: SegmentBox = { concept: "logo", left: 500, top: 0, right: 540, bottom: 20, confidence: 0.99 };
    const edge: SegmentBox = { concept: "logo", left: 95, top: 0, right: 140, bottom: 20, confidence: 0.5 };
    const inside: SegmentBox = { concept: "logo", left: 10, top: 10, right: 40, bottom: 30, confidence: 0.6 };
    // The outside box outranks both on confidence: it must not spend the allowance or become a crop.
    expect(selectBoxes([outside, edge, inside], { width: 100, height: 80 })).toEqual([inside, edge]);
  });
});

// A distinctive source picture made in the browser: red on the left, blue on the right.
async function makePng(browser: Browser): Promise<Uint8Array> {
  const page = await browser.newPage();
  try {
    const b64 = await page.evaluate(async () => {
      const g = globalThis as unknown as {
        document: {
          createElement: (tag: string) => {
            width: number;
            height: number;
            getContext: (kind: string) => { fillStyle: string; fillRect: (...a: number[]) => void };
            toBlob: (done: (b: Blob | null) => void, type: string) => void;
          };
        };
      };
      const canvas = g.document.createElement("canvas");
      canvas.width = 100;
      canvas.height = 80;
      const context = canvas.getContext("2d");
      context.fillStyle = "#ff0000";
      context.fillRect(0, 0, 50, 80);
      context.fillStyle = "#0000ff";
      context.fillRect(50, 0, 50, 80);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      const buffer = new Uint8Array(await (blob as Blob).arrayBuffer());
      let text = "";
      for (let i = 0; i < buffer.length; i += 0x8000) text += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
      return btoa(text);
    });
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } finally {
    await page.close();
  }
}

const pngSize = (bytes: Uint8Array) => ({
  width: new DataView(bytes.buffer, bytes.byteOffset).getUint32(16),
  height: new DataView(bytes.buffer, bytes.byteOffset).getUint32(20),
});

async function pixelAt(browser: Browser, png: Uint8Array): Promise<number[]> {
  const page = await browser.newPage();
  try {
    let text = "";
    for (let i = 0; i < png.length; i += 0x8000) text += String.fromCharCode(...png.subarray(i, i + 0x8000));
    return await page.evaluate(async (b64: string) => {
      const g = globalThis as unknown as {
        createImageBitmap: (blob: Blob) => Promise<{ width: number; height: number; close: () => void }>;
        document: {
          createElement: (tag: string) => {
            width: number;
            height: number;
            getContext: (kind: string) => {
              drawImage: (image: unknown, ...a: number[]) => void;
              getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray };
            };
          };
        };
      };
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const image = await g.createImageBitmap(new Blob([bytes.buffer as ArrayBuffer], { type: "image/png" }));
      const canvas = g.document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      image.close();
      return [...context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data];
    }, btoa(text));
  } finally {
    await page.close();
  }
}

describe("cropBoxes and storeCrops", () => {
  it("crops padded, clipped boxes with real pixels, stores them once, and reads them back", async () => {
    const browser = await puppeteer.launch(env.BROWSER);
    try {
      const png = await makePng(browser);
      const boxes: SegmentBox[] = [
        { concept: "logo", left: 10, top: 10, right: 40, bottom: 30, confidence: 0.9 },
        { concept: "logo", left: 95, top: 70, right: 100, bottom: 80, confidence: 0.8 },
        { concept: "stamp", left: 200, top: 0, right: 240, bottom: 20, confidence: 0.9 },
      ];
      const { crops, failures } = await cropBoxes(browser, png, boxes);
      expect(failures.map((f) => f.kind)).toEqual(["malformed"]);
      expect(crops).toHaveLength(2);
      expect(pngSize(crops[0]?.bytes as Uint8Array)).toEqual({ width: 46, height: 36 });
      expect(pngSize(crops[1]?.bytes as Uint8Array)).toEqual({ width: 13, height: 18 });
      // The centre of the first crop is the red half; of the edge crop, the blue half.
      expect(await pixelAt(browser, crops[0]?.bytes as Uint8Array)).toEqual([255, 0, 0, 255]);
      expect(await pixelAt(browser, crops[1]?.bytes as Uint8Array)).toEqual([0, 0, 255, 255]);

      const made = await createCase(env.DB, { orgId: "org-sam", channel: "email", headersAvailable: true });
      if (!made.ok) throw new Error(made.error.message);
      const caseId = made.value.id;
      const source = { name: "desktop-1024.png", key: `art/${caseId}/render/source.png`, sha256: "a".repeat(64) };
      const first = await storeCrops(store, caseId, source, crops);
      // Two crops and the manifest that names the current set, with the source provenance.
      expect(first).toHaveLength(3);
      const again = await storeCrops(store, caseId, source, crops);
      // The crops are the same references; the manifest is the next generation naming them.
      expect(again.slice(0, 2).map((s) => s.key)).toEqual(first.slice(0, 2).map((s) => s.key));
      expect(again[2]?.key).toContain("manifest-2.json");
      const listed = await artefactsOf(store, caseId, "crop");
      expect(listed).toHaveLength(4);
      const pngs = listed.filter((a) => a.mediaType === "image/png");
      expect(pngs).toHaveLength(2);
      const back = await readArtefact(store, caseId, first[0]?.key as string);
      if (!back || !("body" in back)) throw new Error("crop not read back");
      expect(back.body).toEqual(crops[0]?.bytes);
      const manifestBack = await readArtefact(store, caseId, first[2]?.key as string);
      if (!manifestBack || !("body" in manifestBack)) throw new Error("manifest not read back");
      const manifest = JSON.parse(new TextDecoder().decode(manifestBack.body)) as {
        source: { key: string; sha256: string };
        crops: string[];
      };
      expect(manifest.source).toEqual({ name: source.name, key: source.key, sha256: source.sha256 });
      expect(manifest.crops).toEqual(first.slice(0, 2).map((s) => s.key));

      // A changed retry writes a new generation: the consumer's current set is the latest manifest.
      const changed = await storeCrops(store, caseId, source, [crops[0] as Crop]);
      const manifests = (await artefactsOf(store, caseId, "crop")).filter((a) => a.mediaType === "application/json");
      expect(manifests).toHaveLength(3);
      const latestBack = await readArtefact(store, caseId, changed[changed.length - 1]?.key as string);
      if (!latestBack || !("body" in latestBack)) throw new Error("latest manifest not read back");
      const latest = JSON.parse(new TextDecoder().decode(latestBack.body)) as { crops: string[] };
      expect(latest.crops).toEqual([changed[0]?.key]);

      // An attacker-long source name keeps its manifest suffix: the stored manifest key still
      // ends in `-manifest-<generation>.json`, so a reader can find the crop set.
      const longMade = await createCase(env.DB, { orgId: "org-sam", channel: "email", headersAvailable: true });
      if (!longMade.ok) throw new Error(longMade.error.message);
      const longSource = {
        name: `${"a".repeat(110)}.pdf page 1`,
        key: `art/${longMade.value.id}/render/source.png`,
        sha256: "b".repeat(64),
      };
      const longStored = await storeCrops(store, longMade.value.id, longSource, [crops[0] as Crop]);
      expect(longStored[longStored.length - 1]?.key).toMatch(/-manifest-1\.json$/);
    } finally {
      await browser.close();
    }
  }, 300_000);

  it("loses a stalled crop as a typed failure, not the step", async () => {
    const stalled = {
      newPage: async () => ({
        evaluate: () => new Promise(() => {}),
        close: async () => {},
      }),
    } as unknown as Browser;
    const failure = await cropBoxes(
      stalled,
      new Uint8Array([1]),
      [{ concept: "logo", left: 0, top: 0, right: 4, bottom: 4, confidence: 1 }],
      50,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SegmentError);
    expect((failure as SegmentError).kind).toBe("unavailable");

    // The next image is unaffected: the same operation on a working browser crops it.
    const browser = await puppeteer.launch(env.BROWSER);
    try {
      const png = await makePng(browser);
      const { crops, failures } = await cropBoxes(browser, png, [
        { concept: "logo", left: 10, top: 10, right: 40, bottom: 30, confidence: 0.9 },
      ]);
      expect(failures).toEqual([]);
      expect(crops).toHaveLength(1);
    } finally {
      await browser.close();
    }
  }, 300_000);

  it("bounds page creation and closure, and types a decode failure", async () => {
    const box: SegmentBox = { concept: "logo", left: 0, top: 0, right: 4, bottom: 4, confidence: 1 };
    const noPage = { newPage: () => new Promise(() => {}) } as unknown as Browser;
    await expect(cropBoxes(noPage, new Uint8Array([1]), [box], 50)).rejects.toMatchObject({ kind: "unavailable" });

    // A page whose close never answers still returns within the bound.
    const noClose = {
      newPage: async () => ({
        evaluate: async () => [null],
        close: () => new Promise(() => {}),
      }),
    } as unknown as Browser;
    await expect(cropBoxes(noClose, new Uint8Array([1]), [box], 50)).resolves.toEqual({
      crops: [],
      failures: [expect.objectContaining({ kind: "malformed" })],
    });

    const browser = await puppeteer.launch(env.BROWSER);
    try {
      await expect(cropBoxes(browser, new Uint8Array([1, 2, 3]), [box])).rejects.toMatchObject({
        kind: "unavailable",
      });
    } finally {
      await browser.close();
    }
  }, 300_000);

  it("enforces the deadline inside the store and bounds the manifest listing", async () => {
    const crop: Crop = {
      box: { concept: "logo", left: 0, top: 0, right: 4, bottom: 4, confidence: 1 },
      bytes: new Uint8Array([1, 2, 3]),
      width: 4,
      height: 4,
    };
    const slowLookup = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare")
          return (sql: string) => {
            const stmt = (target as D1Database).prepare(sql);
            if (!sql.includes("LEFT JOIN artefacts")) return stmt;
            return {
              bind: (...args: unknown[]) => ({
                first: async () => {
                  await new Promise((r) => setTimeout(r, 200));
                  return stmt.bind(...(args as [])).first();
                },
              }),
            };
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const made = await createCase(env.DB, { orgId: "org-sam", channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    // The write's own lookup releases only after the deadline: no row is ever recorded.
    await expect(
      storeCrops(
        { bucket: env.ARTEFACTS, db: slowLookup },
        made.value.id,
        { name: "z.png", key: `art/${made.value.id}/render/z.png`, sha256: "d".repeat(64) },
        [crop],
        undefined,
        Date.now() + 50,
      ),
    ).rejects.toThrow();
    expect(await artefactsOf(store, made.value.id, "crop")).toEqual([]);

    // A stalled crop listing is bounded like every other storage wait.
    const slowList = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare")
          return (sql: string) => {
            const stmt = (target as D1Database).prepare(sql);
            if (!sql.includes("FROM artefacts")) return stmt;
            return {
              bind: (...args: unknown[]) => ({
                all: async () => {
                  await new Promise((r) => setTimeout(r, 5_000));
                  return stmt.bind(...(args as [])).all();
                },
              }),
            };
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const started = Date.now();
    await expect(
      storeCrops(
        { bucket: env.ARTEFACTS, db: slowList },
        made.value.id,
        { name: "z.png", key: `art/${made.value.id}/render/z.png`, sha256: "d".repeat(64) },
        [],
        undefined,
        undefined,
        50,
      ),
    ).rejects.toMatchObject({ kind: "unavailable" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("fences a locally timed-out write at the same earlier instant in the store", async () => {
    const crop: Crop = {
      box: { concept: "logo", left: 0, top: 0, right: 4, bottom: 4, confidence: 1 },
      bytes: new Uint8Array([1, 2, 3]),
      width: 4,
      height: 4,
    };
    const slowLookup = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare")
          return (sql: string) => {
            const stmt = (target as D1Database).prepare(sql);
            if (!sql.includes("LEFT JOIN artefacts")) return stmt;
            return {
              bind: (...args: unknown[]) => ({
                first: async () => {
                  await new Promise((r) => setTimeout(r, 200));
                  return stmt.bind(...(args as [])).first();
                },
              }),
            };
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const made = await createCase(env.DB, { orgId: "org-sam", channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    // The caller's deadline is an hour away; the operation's own 50 ms timeout is the fence. The
    // wait times out, the lookup then releases, and the resumed write still records nothing.
    await expect(
      storeCrops(
        { bucket: env.ARTEFACTS, db: slowLookup },
        made.value.id,
        { name: "w.png", key: `art/${made.value.id}/render/w.png`, sha256: "e".repeat(64) },
        [crop],
        undefined,
        Date.now() + 3_600_000,
        50,
      ),
    ).rejects.toMatchObject({ kind: "unavailable" });
    await new Promise((r) => setTimeout(r, 300));
    expect(await artefactsOf(store, made.value.id, "crop")).toEqual([]);
  });

  it("keeps page cleanup inside the operation's own bound", async () => {
    const slowPage = {
      newPage: async () => ({
        evaluate: async () => {
          await new Promise((r) => setTimeout(r, 30));
          return [null];
        },
        close: () => new Promise(() => {}),
      }),
    } as unknown as Browser;
    const started = Date.now();
    await cropBoxes(
      slowPage,
      new Uint8Array([1]),
      [{ concept: "logo", left: 0, top: 0, right: 4, bottom: 4, confidence: 1 }],
      80,
    );
    // Evaluation (30 ms) plus cleanup inside the same 80 ms bound, not a second 80 ms.
    expect(Date.now() - started).toBeLessThan(105);
  });

  it("stops storing at the caller's fence, with no manifest for the partial set", async () => {
    const browser = await puppeteer.launch(env.BROWSER);
    try {
      const png = await makePng(browser);
      const { crops } = await cropBoxes(browser, png, [
        { concept: "logo", left: 10, top: 10, right: 40, bottom: 30, confidence: 0.9 },
        { concept: "stamp", left: 60, top: 10, right: 90, bottom: 30, confidence: 0.9 },
      ]);
      const made = await createCase(env.DB, { orgId: "org-sam", channel: "email", headersAvailable: true });
      if (!made.ok) throw new Error(made.error.message);
      let checks = 0;
      const stored = await storeCrops(
        store,
        made.value.id,
        { name: "x.png", key: `art/${made.value.id}/render/x.png`, sha256: "b".repeat(64) },
        crops,
        () => ++checks > 1,
      );
      expect(stored).toHaveLength(1);
      const listed = await artefactsOf(store, made.value.id, "crop");
      expect(listed).toHaveLength(1);
      expect(listed[0]?.mediaType).toBe("image/png");

      // A fence that closes only at the manifest stage, after the listing, publishes no manifest:
      // the crops are stored, the previous current set (none here) is untouched.
      const made2 = await createCase(env.DB, { orgId: "org-sam", channel: "email", headersAvailable: true });
      if (!made2.ok) throw new Error(made2.error.message);
      let checks2 = 0;
      const stored2 = await storeCrops(
        store,
        made2.value.id,
        { name: "y.png", key: `art/${made2.value.id}/render/y.png`, sha256: "c".repeat(64) },
        crops,
        () => ++checks2 > 2,
      );
      expect(stored2).toHaveLength(2);
      const listed2 = await artefactsOf(store, made2.value.id, "crop");
      expect(listed2).toHaveLength(2);
      expect(listed2.every((a) => a.mediaType === "image/png")).toBe(true);
    } finally {
      await browser.close();
    }
  }, 300_000);
});
