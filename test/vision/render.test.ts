import { env } from "cloudflare:workers";
import puppeteer, { type Browser } from "@cloudflare/puppeteer";
import { afterEach, describe, expect, it } from "vitest";
import { createCase } from "../../src/db/cases";
import { readArtefact, type Store } from "../../src/intake/store";
import { MAX_HEIGHT, type RenderDeps, type RenderResult, renderEmail, wholeImage } from "../../src/vision/render";
import type { Verdict } from "../../src/walkthrough/url-policy";
import { BLUE_PNG, LAYOUT_HTML, PHISHING_HTML, RED_PNG, storeMail, TALL_HTML } from "../fixtures/vision/emails";

// D03 T02 §1: an email rendered to a screenshot on a real (local) Browser Run session. The Worker's fetch is a stub that
// records what reached it, and the URL policy a fixed table: a request the browser made any other way is never answered.
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const ORG = "org-render";

let browser: Browser | undefined;
afterEach(async () => {
  await browser?.close().catch(() => undefined);
  browser = undefined;
});

async function newCase() {
  const made = await createCase(env.DB, { orgId: ORG, channel: "email", headersAvailable: false });
  if (!made.ok) throw new Error(made.error.message);
  return made.value.id;
}

const policy = async (raw: string): Promise<Verdict> => {
  const url = new URL(raw);
  return url.hostname === "inner.example" ? { ok: false, reason: "private address" } : { ok: true, url };
};
function served(
  images: Record<string, Uint8Array | "stall" | 404> = { "https://logos.example/protea-bank.png": RED_PNG },
) {
  const seen: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(href);
    const hit = images[href];
    if (hit === "stall")
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    if (hit === undefined || hit === 404) return new Response("no", { status: 404 });
    return new Response(hit, { headers: { "content-type": "image/png" } });
  }) as typeof fetch;
  return { fetch: fetcher, seen };
}
const deps = (s: ReturnType<typeof served>, extra: Partial<RenderDeps> = {}): RenderDeps => ({
  policy,
  fetch: s.fetch,
  ...extra,
});

// The pixels of a stored PNG, decoded by the browser itself in a page the test owns.
async function pixels(b: Browser, key: string, caseId: string, at: [number, number][]) {
  const art = await readArtefact(store, caseId, key);
  if (!art || !("body" in art)) throw new Error(`no artefact ${key}`);
  const page = await b.newPage();
  try {
    const base64 = btoa(String.fromCharCode(...art.body));
    const script = `(async () => {
      const img = new Image();
      img.src = "data:image/png;base64,${base64}";
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return ${JSON.stringify(at)}.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3));
    })()`;
    return (await page.evaluate(script)) as number[][];
  } finally {
    await page.close();
  }
}
const near = (got: number[] | undefined, want: number[]) =>
  expect(
    got?.every((v, i) => Math.abs(v - (want[i] ?? 0)) <= 12),
    `${got} vs ${want}`,
  ).toBe(true);
const rendered = (r: RenderResult) => {
  if (r.outcome !== "rendered") throw new Error(`render failed: ${r.reason}`);
  return r;
};
// A valid PNG padded with a text chunk to about `size` bytes (every chunk's CRC is real).
function pngOf(size: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = (crcTable[(c ^ x) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(name), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const text = chunk("tEXt", new Uint8Array(Math.max(0, size - RED_PNG.length)).fill(0x61));
  // RED_PNG is signature + IHDR + IDAT + IEND: the padding goes before IEND.
  const iend = RED_PNG.subarray(RED_PNG.length - 12);
  const out = new Uint8Array(RED_PNG.length - 12 + text.length + 12);
  out.set(RED_PNG.subarray(0, RED_PNG.length - 12));
  out.set(text, RED_PNG.length - 12);
  out.set(iend, RED_PNG.length - 12 + text.length);
  return out;
}
const pageCount = async (b: Browser) => (await b.pages()).length;
// The count once a closing page has gone from the browser's list (closing is asynchronous), up to two seconds.
const pagesSettled = async (b: Browser, want: number) => {
  for (let i = 0; i < 20; i++) {
    if ((await pageCount(b)) === want) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pageCount(b);
};

describe("renderEmail", () => {
  it("renders the message at both widths: layout, remote image and cid image visible, the script's block absent", async () => {
    browser = await puppeteer.launch(env.BROWSER);
    const id = await newCase();
    await storeMail(store, id, { html: LAYOUT_HTML, cid: { id: "badge@protea", body: BLUE_PNG } });
    const s = served();
    const out = rendered(await renderEmail(browser, store, id, deps(s)));
    expect(out.kind).toBe("html");
    expect(out.shots.map((x) => [x.width, x.name, x.cut])).toEqual([
      [1024, "desktop-1024.png", false],
      [390, "phone-390.png", false],
    ]);
    const [desktop, phone] = out.shots;
    expect(desktop?.pixelWidth).toBe(1024);
    expect(phone?.pixelWidth).toBe(390);
    // Stored: the artefacts read back with the bytes and the sizes recorded.
    for (const shot of out.shots) {
      const art = await readArtefact(store, id, shot.key);
      expect(art && "body" in art ? art.body.byteLength : 0).toBe(shot.bytes);
      expect(art?.stored).toMatchObject({ kind: "render", mediaType: "image/png", sha256: shot.sha256 });
    }
    const points: [number, number][] = [
      [200, 25], // the bar
      [30, 90], // the remote logo
      [30, 150], // the cid badge
      [330, 90], // where the script's block would be
      [600, 300], // the page's background
    ];
    const [d, p] = await Promise.all([
      pixels(browser, desktop?.key ?? "", id, points),
      pixels(
        browser,
        phone?.key ?? "",
        id,
        points.map(([x, y]) => [Math.min(x, 380), y] as [number, number]),
      ),
    ]);
    near(d[0], [204, 0, 0]); // desktop bar red
    near(p[0], [0, 170, 0]); // phone bar green: the layout differs
    near(d[1], [255, 0, 0]);
    near(d[2], [0, 0, 255]);
    near(d[3], [255, 255, 255]); // the script did not run
    near(d[4], [255, 255, 255]);
    expect(out.images).toEqual({ loaded: 2, refused: 0, failed: 0, skipped: 0 });
    expect(out.complete).toBe(true);
    // Each image was fetched once, though the page was captured twice.
    expect(s.seen).toEqual(["https://logos.example/protea-bank.png"]);
  });

  it("contains a hostile message: no script, no form, frame, style sheet or private address reaches the network", async () => {
    browser = await puppeteer.launch(env.BROWSER);
    const before = await pageCount(browser);
    const id = await newCase();
    await storeMail(store, id, { html: PHISHING_HTML, cid: { id: "badge@protea", body: BLUE_PNG } });
    const s = served();
    const out = rendered(await renderEmail(browser, store, id, deps(s)));
    // Only the allowed logo reached the Worker's fetch: not the script's image, the style sheet, the frame or the form.
    expect(s.seen).toEqual(["https://logos.example/protea-bank.png"]);
    expect(out.images.loaded).toBe(2);
    expect(out.images.refused).toBeGreaterThanOrEqual(3); // pixel to a private address, style sheet, frame
    expect(out.complete).toBe(false);
    // No extra target survives, and the page is closed.
    expect(await pageCount(browser)).toBe(before);
    const cdp = await browser.target().createCDPSession();
    const { targetInfos } = (await cdp.send("Target.getTargets")) as { targetInfos: { type: string }[] };
    expect(targetInfos.filter((x) => x.type === "page").length).toBe(before);
  });

  it("renders a mail with no HTML as a monospace page, and an empty one as a page saying so", async () => {
    browser = await puppeteer.launch(env.BROWSER);
    const id = await newCase();
    await storeMail(store, id, { text: "Dear member,\nPlease pay R 4 200 to the new account." });
    const out = rendered(await renderEmail(browser, store, id, deps(served())));
    expect(out.kind).toBe("text");
    expect(out.shots).toHaveLength(2);
    const empty = await newCase();
    await storeMail(store, empty, { text: "" });
    const none = rendered(await renderEmail(browser, store, empty, deps(served())));
    expect(none.kind).toBe("text");
    expect(none.shots[0]?.pixelHeight).toBeGreaterThan(0);
  });

  it("caps a tall page at 6000 pixels and says it was cut, and a short one is not cut", async () => {
    browser = await puppeteer.launch(env.BROWSER);
    const id = await newCase();
    await storeMail(store, id, { html: TALL_HTML });
    const out = rendered(await renderEmail(browser, store, id, deps(served())));
    for (const shot of out.shots) {
      expect(shot.cut).toBe(true);
      expect(shot.pixelHeight).toBe(MAX_HEIGHT);
    }
    // What lies below the cap is not in the picture, so the render is not complete.
    expect(out.complete).toBe(false);
    const short = await newCase();
    await storeMail(store, short, { html: LAYOUT_HTML, cid: { id: "badge@protea", body: BLUE_PNG } });
    const small = rendered(await renderEmail(browser, store, short, deps(served())));
    for (const shot of small.shots) {
      expect(shot.cut).toBe(false);
      expect(shot.pixelHeight).toBeLessThan(MAX_HEIGHT);
    }
  });

  it("tells an unavailable remote image, a missing cid part and an exhausted budget apart from a complete render", async () => {
    browser = await puppeteer.launch(env.BROWSER);
    const id = await newCase();
    // No cid attachment stored: the cid image cannot be read. The remote logo answers 404.
    await storeMail(store, id, { html: LAYOUT_HTML });
    const out = rendered(
      await renderEmail(browser, store, id, deps(served({ "https://logos.example/protea-bank.png": 404 }))),
    );
    expect(out.images).toMatchObject({ loaded: 0, failed: 2 });
    expect(out.complete).toBe(false);
    // A budget of one resource leaves the second remote image out.
    const two = await newCase();
    const html = `<img src="https://a.example/1.png"><img src="https://a.example/2.png">`;
    await storeMail(store, two, { html });
    const budget = rendered(
      await renderEmail(
        browser,
        store,
        two,
        deps(served({ "https://a.example/1.png": RED_PNG, "https://a.example/2.png": BLUE_PNG }), {
          limits: { resources: 1 },
        }),
      ),
    );
    expect(budget.images).toMatchObject({ loaded: 1, skipped: 1 });
    expect(budget.complete).toBe(false);
  });

  it("separates a message whose stored parts are missing from an empty one, and a storage failure from both", async () => {
    browser = await puppeteer.launch(env.BROWSER);
    const never = await newCase();
    expect(await renderEmail(browser, store, never, deps(served()))).toEqual({
      outcome: "failed",
      reason: "input-missing",
    });
    const broken = await newCase();
    await storeMail(store, broken, { html: LAYOUT_HTML, cid: { id: "badge@protea", body: BLUE_PNG } });
    const failing = {
      bucket: env.ARTEFACTS,
      db: new Proxy(env.DB, {
        get: (t, k) =>
          k === "prepare"
            ? () => {
                throw new Error("D1 down");
              }
            : Reflect.get(t, k),
      }),
    } as Store;
    expect(await renderEmail(browser, failing, broken, deps(served()))).toEqual({
      outcome: "failed",
      reason: "storage",
    });
  });

  it("stops at its deadline on a stalled image, releases the page and renders the next message in the same browser", async () => {
    browser = await puppeteer.launch(env.BROWSER);
    const before = await pageCount(browser);
    const id = await newCase();
    await storeMail(store, id, { html: `<img src="https://slow.example/a.png">` });
    const slow = served({ "https://slow.example/a.png": "stall" });
    const settled = rendered(
      await renderEmail(browser, store, id, deps(slow, { limits: { resourceMs: 400, pageMs: 20_000 } })),
    );
    expect(settled.images.failed).toBe(1);
    // A deadline shorter than the page can load in: a timeout result, nothing left open.
    const late = await newCase();
    await storeMail(store, late, { html: `<img src="https://slow.example/a.png">` });
    const cut = await renderEmail(browser, store, late, deps(slow, { limits: { resourceMs: 5_000, pageMs: 300 } }));
    expect(cut).toEqual({ outcome: "failed", reason: "timeout" });
    expect(await pageCount(browser)).toBe(before);
    // The same browser renders again.
    const ok = await newCase();
    await storeMail(store, ok, { html: LAYOUT_HTML, cid: { id: "badge@protea", body: BLUE_PNG } });
    expect(rendered(await renderEmail(browser, store, ok, deps(served()))).complete).toBe(true);
    expect(await pageCount(browser)).toBe(before);
  });

  it("counts an image as loaded only when it is whole: truncated remote and cid images fail, data images are refused", async () => {
    browser = await puppeteer.launch(env.BROWSER);
    const id = await newCase();
    const broken = RED_PNG.slice(0, RED_PNG.length - 6);
    const dataBroken = `data:image/png;base64,${btoa(String.fromCharCode(...broken))}`;
    const dataGood = `data:image/png;base64,${btoa(String.fromCharCode(...RED_PNG))}`;
    await storeMail(store, id, {
      html: `<img src="https://logos.example/cut.png"><img src="cid:cut@x"><img src="${dataBroken}"><img src="${dataGood}">`,
      cid: { id: "cut@x", body: broken },
    });
    const out = rendered(
      await renderEmail(browser, store, id, deps(served({ "https://logos.example/cut.png": broken }))),
    );
    expect(out.images).toEqual({ loaded: 0, refused: 2, failed: 2, skipped: 0 });
    expect(out.complete).toBe(false);
  });

  it("stops reading an endless image body at the byte bound, and counts it", async () => {
    browser = await puppeteer.launch(env.BROWSER);
    const id = await newCase();
    await storeMail(store, id, { html: `<img src="https://big.example/endless.png">` });
    let pulled = 0;
    const endless = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(64 * 1024));
        },
      });
      return new Response(stream, { headers: { "content-type": "image/png" } });
    }) as typeof fetch;
    const out = rendered(
      await renderEmail(browser, store, id, { policy, fetch: endless, limits: { perResourceBytes: 200 * 1024 } }),
    );
    expect(out.images.refused + out.images.skipped).toBe(1);
    expect(out.images.loaded).toBe(0);
    expect(pulled).toBeLessThan(8);
  });

  it("follows a bounded redirect chain under the URL policy at every hop", async () => {
    browser = await puppeteer.launch(env.BROWSER);
    const id = await newCase();
    await storeMail(store, id, {
      html: `<img src="https://logos.example/a"><img src="https://logos.example/private"><img src="https://logos.example/loop1">`,
    });
    const seen: string[] = [];
    const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
    const fetcher = (async (input: RequestInfo | URL) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push(href);
      if (href === "https://logos.example/a") return redirect("https://cdn.example/a.png");
      if (href === "https://cdn.example/a.png")
        return new Response(RED_PNG, { headers: { "content-type": "image/png" } });
      if (href === "https://logos.example/private") return redirect("https://inner.example/x.png");
      if (href === "https://logos.example/loop1") return redirect("https://logos.example/loop2");
      if (href === "https://logos.example/loop2") return redirect("https://logos.example/loop1");
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    const out = rendered(await renderEmail(browser, store, id, { policy, fetch: fetcher }));
    expect(out.images).toMatchObject({ loaded: 1, refused: 2 });
    expect(seen).toContain("https://cdn.example/a.png");
    expect(seen).not.toContain("https://inner.example/x.png");
    expect(seen.filter((u) => u.startsWith("https://logos.example/loop")).length).toBeLessThanOrEqual(4);
  });

  it("says when the message itself was cut before it was drawn", async () => {
    browser = await puppeteer.launch(env.BROWSER);
    const id = await newCase();
    await storeMail(store, id, { html: "<p>short</p>", truncated: [{ mediaType: "text/html" }], omitted: 2 });
    const out = rendered(await renderEmail(browser, store, id, deps(served())));
    expect(out.source).toEqual({ parts: 1, omitted: 2, text: false });
    expect(out.complete).toBe(false);
    expect(out.shots.every((x) => !x.cut)).toBe(true);
  });

  it("reports a missing visible text, a failing capture, a failing write and a late setup, then renders again", async () => {
    browser = await puppeteer.launch(env.BROWSER);
    const before = await pageCount(browser);
    const bare = await newCase();
    await storeMail(store, bare, {});
    expect(await renderEmail(browser, store, bare, deps(served()))).toEqual({
      outcome: "failed",
      reason: "input-missing",
    });
    const id = await newCase();
    await storeMail(store, id, { html: LAYOUT_HTML, cid: { id: "badge@protea", body: BLUE_PNG } });
    // The second capture fails.
    let shots = 0;
    const b1 = browser;
    const flaky = new Proxy(b1, {
      get(target, key) {
        if (key !== "newPage") {
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async () => {
          const page = await target.newPage();
          return new Proxy(page, {
            get(p, k) {
              if (k !== "screenshot") {
                const value = Reflect.get(p, k);
                return typeof value === "function" ? value.bind(p) : value;
              }
              return async (...args: unknown[]) => {
                shots += 1;
                if (shots === 2) throw new Error("capture failed");
                return (p.screenshot as (...a: unknown[]) => unknown).apply(p, args);
              };
            },
          });
        };
      },
    }) as Browser;
    expect(await renderEmail(flaky, store, id, deps(served()))).toEqual({ outcome: "failed", reason: "browser" });
    expect(await pagesSettled(browser, before)).toBe(before);
    // A write fails.
    const failingWrite = {
      db: env.DB,
      bucket: new Proxy(env.ARTEFACTS, {
        get(target, key) {
          if (key === "put")
            return async () => {
              throw new Error("R2 down");
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as Store;
    expect(await renderEmail(browser, failingWrite, id, deps(served()))).toEqual({
      outcome: "failed",
      reason: "storage",
    });
    // Setup that finishes after the deadline leaves nothing behind.
    const slow = new Proxy(browser, {
      get(target, key) {
        if (key !== "newPage") {
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async () => {
          await new Promise((r) => setTimeout(r, 700));
          return target.newPage();
        };
      },
    }) as Browser;
    expect(await renderEmail(slow, store, id, deps(served(), { limits: { pageMs: 250 } }))).toEqual({
      outcome: "failed",
      reason: "timeout",
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect(await pageCount(browser)).toBe(before);
    // The same browser renders the message after all of it.
    expect(rendered(await renderEmail(browser, store, id, deps(served()))).complete).toBe(true);
    expect(await pageCount(browser)).toBe(before);
  });

  it("refuses a data image however the markup spells it, and treats malformed bytes as failed", async () => {
    browser = await puppeteer.launch(env.BROWSER);
    const id = await newCase();
    const uri = `data:image/png;base64,${btoa(String.fromCharCode(...RED_PNG))}`;
    const spelled = `data:image/png;base64,${btoa(String.fromCharCode(...BLUE_PNG))}`.replace("data:", "d&#97;ta:");
    // Twelve bytes that end like a PNG, and an SVG that never closes.
    const fake = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><broken");
    await storeMail(store, id, {
      html: `<body style="margin:0;background:#fff"><img src="${spelled}" style="position:absolute;left:100px;top:10px;width:60px;height:40px"><img src="${uri}" style="position:absolute;left:10px;top:10px;width:60px;height:40px"><img src="https://a.example/fake.png"><img src="https://a.example/cut.svg"></body>`,
    });
    const fetcher = (async (input: RequestInfo | URL) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(href.endsWith(".svg") ? svg : fake, {
        headers: { "content-type": href.endsWith(".svg") ? "image/svg+xml" : "image/png" },
      });
    }) as typeof fetch;
    const out = rendered(await renderEmail(browser, store, id, { policy, fetch: fetcher }));
    expect(out.images).toEqual({ loaded: 0, refused: 2, failed: 2, skipped: 0 });
    expect(out.complete).toBe(false);
    // And they are not drawn: both places are still the page's white.
    const [px] = await pixels(browser, out.shots[0]?.key ?? "", id, [
      [30, 30],
      [130, 30],
    ]);
    near(px, [255, 255, 255]);
    const [, other] = await pixels(browser, out.shots[0]?.key ?? "", id, [
      [30, 30],
      [130, 30],
    ]);
    near(other, [255, 255, 255]);
  });

  it("reserves the byte budget before reading, so concurrent bodies cannot together exceed it, and counts cid images against the limit", async () => {
    browser = await puppeteer.launch(env.BROWSER);
    const id = await newCase();
    const big = pngOf(60_000);
    const html = [1, 2, 3, 4, 5, 6].map((n) => `<img src="https://a.example/${n}.png">`).join("");
    await storeMail(store, id, { html });
    let open = 0;
    let peak = 0;
    const fetcher = (async () => {
      open += 1;
      peak = Math.max(peak, open);
      await new Promise((r) => setTimeout(r, 200));
      open -= 1;
      return new Response(big, { headers: { "content-type": "image/png" } });
    }) as typeof fetch;
    const out = rendered(
      await renderEmail(browser, store, id, {
        policy,
        fetch: fetcher,
        limits: { perResourceBytes: 80_000, totalBytes: 200_000 },
      }),
    );
    // The budget is 200,000 bytes and each image 60,000: never more than three are kept, whatever the order the reads
    // overlapped in, and every other one is counted as skipped.
    expect(out.images.loaded).toBeLessThanOrEqual(3);
    expect(out.images.loaded).toBeGreaterThanOrEqual(2);
    expect(out.images.loaded + out.images.skipped).toBe(6);
    expect(peak).toBeGreaterThan(1);
    // Five cid images against a limit of three resources.
    const inline = await newCase();
    await storeMail(store, inline, {
      html: [1, 2, 3, 4, 5].map((n) => `<img src="cid:c${n}@x">`).join(""),
      cids: [1, 2, 3, 4, 5].map((n) => ({ id: `c${n}@x`, body: RED_PNG })),
    });
    const small = rendered(
      await renderEmail(browser, store, inline, { policy, fetch: served().fetch, limits: { resources: 3 } }),
    );
    expect(small.images).toMatchObject({ loaded: 3, skipped: 2 });
  });

  it("returns within its deadline plus a bounded clean-up when the browser stops answering on close", async () => {
    browser = await puppeteer.launch(env.BROWSER);
    const id = await newCase();
    await storeMail(store, id, { html: LAYOUT_HTML, cid: { id: "badge@protea", body: BLUE_PNG } });
    const real = browser;
    const hanging = new Proxy(real, {
      get(target, key) {
        if (key !== "newPage") {
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async () => {
          const page = await target.newPage();
          return new Proxy(page, {
            get(p, k) {
              if (k === "close") return () => new Promise(() => undefined);
              const value = Reflect.get(p, k);
              return typeof value === "function" ? value.bind(p) : value;
            },
          });
        };
      },
    }) as Browser;
    const began = Date.now();
    const out = await renderEmail(hanging, store, id, deps(served(), { limits: { pageMs: 300 } }));
    expect(out).toEqual({ outcome: "failed", reason: "timeout" });
    expect(Date.now() - began).toBeLessThan(6_000);
  });

  it("accepts whole images of each format and refuses the ones that only look like them", () => {
    const hex = (s: string) => Uint8Array.from(s.match(/../g)?.map((h) => Number.parseInt(h, 16)) ?? []);
    const gif = hex("47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b");
    expect(wholeImage("image/gif", gif)).toBe(true);
    // A header and a trailer with nothing between them.
    expect(wholeImage("image/gif", hex("474946383961010001000000003b"))).toBe(false);
    expect(wholeImage("image/gif", gif.slice(0, gif.length - 3))).toBe(false);
    const box = (name: string, payload: number[]) => [
      0,
      0,
      0,
      8 + payload.length,
      ...[...name].map((c) => c.charCodeAt(0)),
      ...payload,
    ];
    const avif = Uint8Array.from([
      ...box("ftyp", [
        ...[..."avif"].map((c) => c.charCodeAt(0)),
        0,
        0,
        0,
        0,
        ...[..."avif"].map((c) => c.charCodeAt(0)),
      ]),
      ...box("meta", [0, 0, 0, 0]),
      ...box("mdat", [1, 2, 3, 4]),
    ]);
    expect(wholeImage("image/avif", avif)).toBe(true);
    // Only the first box: a type word and nothing else.
    expect(wholeImage("image/avif", hex("0000000c6674797061766966"))).toBe(false);
    expect(wholeImage("image/avif", avif.slice(0, avif.length - 2))).toBe(false);
    expect(wholeImage("image/png", RED_PNG)).toBe(true);
    expect(wholeImage("image/png", BLUE_PNG.slice(0, 40))).toBe(false);
    expect(
      wholeImage("image/svg+xml", new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>")),
    ).toBe(true);
    expect(wholeImage("image/svg+xml", new TextEncoder().encode("<svg><broken"))).toBe(false);
  });

  it("refuses a data image carried in a srcset, a style attribute or a style element, not only in src", async () => {
    browser = await puppeteer.launch(env.BROWSER);
    const id = await newCase();
    const a = `data:image/png;base64,${btoa(String.fromCharCode(...RED_PNG))}`;
    const b = `data:image/png;base64,${btoa(String.fromCharCode(...BLUE_PNG))}`;
    const c = `data:image/gif;base64,R0lGODlhAQABAAAAACw=`;
    await storeMail(store, id, {
      html: `<style>.x{background:url(${c})}</style><img srcset="${a} 1x"><div style="background-image:url(${b})"></div><div class="x"></div>`,
    });
    const out = rendered(await renderEmail(browser, store, id, deps(served())));
    expect(out.images.refused).toBe(3);
    expect(out.complete).toBe(false);
  });
});
