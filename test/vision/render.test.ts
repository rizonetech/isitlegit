import { env } from "cloudflare:workers";
import puppeteer, { type Browser } from "@cloudflare/puppeteer";
import { afterEach, describe, expect, it } from "vitest";
import { createCase } from "../../src/db/cases";
import { readArtefact, type Store } from "../../src/intake/store";
import { MAX_HEIGHT, type RenderDeps, type RenderResult, renderEmail } from "../../src/vision/render";
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
const pageCount = async (b: Browser) => (await b.pages()).length;

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
});
