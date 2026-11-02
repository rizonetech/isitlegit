import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";
import {
  APP_CSS,
  APP_JS,
  FONTS,
  HTMX,
  LOGO,
  LOGO_MARK,
  LOGO_MARK_ON_DARK,
  LOGO_ON_DARK,
  MOTION,
} from "../../src/web/assets.ts";
import { GALLERY_FRAMES } from "../../src/web/dev/gallery.tsx";

// The Worker as `wrangler dev` runs it, from wrangler.jsonc with its static assets and public/_headers, answers the
// fingerprinted files with the year-long immutable cache and the right types, refuses unhashed or missing ones, and
// still routes everything else to the Worker. (The workerd tests reach the Worker through `exports`, which has no
// assets, so this is the test of the serving configuration itself.)
const ROOT = join(import.meta.dirname, "../..");
const IMMUTABLE = "public, max-age=31536000, immutable";
let worker: Awaited<ReturnType<typeof unstable_startWorker>>;

beforeAll(async () => {
  worker = await unstable_startWorker({
    config: join(ROOT, "wrangler.jsonc"),
    // In-memory bindings: the Worker tests run in parallel, and a shared .wrangler/state would lock D1's SQLite file.
    // Local bindings only (the AI binding has no local simulation and would need a Cloudflare login, which CI lacks).
    dev: { server: { port: 0 }, inspector: false, logLevel: "error", persist: false, remote: false },
  });
  await worker.ready;
}, 120_000);
// Stopping workerd can outlast the default 10 s hook budget on the CI runner while another Worker test shuts down beside
// it (run 40457777968), so teardown gets the same explicit budget as startup.
afterAll(async () => {
  await worker?.dispose();
}, 120_000);

const get = (path: string) => worker.fetch(`http://localhost${path}`);

describe("static assets as wrangler.jsonc serves them", () => {
  it("serves the fingerprinted stylesheet with its type and the immutable cache", async () => {
    const res = await get(APP_CSS);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/css/);
    expect(res.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toContain("--color-ink");
  });

  it("serves both fingerprinted fonts as font/woff2 with the immutable cache", async () => {
    for (const path of Object.values(FONTS)) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toBe("font/woff2");
      expect(res.headers.get("cache-control"), path).toBe(IMMUTABLE);
      expect(new Uint8Array(await res.arrayBuffer()).slice(0, 4)).toEqual(new TextEncoder().encode("wOF2"));
    }
  });

  it("serves the four fingerprinted logos and the verdict art as image/svg+xml with the immutable cache", async () => {
    for (const path of [LOGO, LOGO_ON_DARK, LOGO_MARK, LOGO_MARK_ON_DARK, ...Object.values(MOTION)]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toMatch(/^image\/svg\+xml/);
      expect(res.headers.get("cache-control"), path).toBe(IMMUTABLE);
      expect(await res.text(), path).toContain("<svg");
    }
  });

  it("serves htmx and the app script as JavaScript with the immutable cache (D07 T01 §9)", async () => {
    for (const path of [HTMX, APP_JS]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toMatch(/^(application|text)\/javascript/);
      expect(res.headers.get("cache-control"), path).toBe(IMMUTABLE);
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
    }
    expect(await (await get(HTMX)).text()).toContain("htmx");
  });

  it("answers 404 for an unhashed or missing static file instead of caching anything", async () => {
    for (const path of ["/static/app.css", "/static/fonts/exo.woff2", "/static/app.000000000000.css"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("cache-control") ?? "", path).not.toContain("immutable");
      await res.arrayBuffer();
    }
  });

  it("still routes /health to the Worker", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, commit: "dev" });
  });
});

// The component gallery (D07 T01 §10) answers only under `pnpm dev`, whose `--var ENV:development` this Worker is
// started with; the configuration as committed (the Worker above, as every deploy runs it) answers 404.
describe("the component gallery", () => {
  let dev: Awaited<ReturnType<typeof unstable_startWorker>>;
  beforeAll(async () => {
    dev = await unstable_startWorker({
      config: join(ROOT, "wrangler.jsonc"),
      bindings: { ENV: { type: "plain_text", value: "development" } },
      dev: { server: { port: 0 }, inspector: false, logLevel: "error", persist: false, remote: false },
    });
    await dev.ready;
  }, 120_000);
  afterAll(async () => {
    await dev?.dispose();
  }, 120_000);

  it("answers 404 for the gallery and its frames as committed", async () => {
    for (const path of ["/dev/components", `/dev/components/frame/${GALLERY_FRAMES[0]?.id}`, "/dev/axe.min.js"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      await res.arrayBuffer();
    }
  });

  it("serves the gallery and every frame in development, and 404 for a frame it does not list", async () => {
    const page = await dev.fetch("http://localhost/dev/components");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Component gallery");
    for (const frame of GALLERY_FRAMES) {
      const res = await dev.fetch(`http://localhost/dev/components/frame/${frame.id}`);
      expect(res.status, frame.id).toBe(200);
      await res.arrayBuffer();
    }
    const missing = await dev.fetch("http://localhost/dev/components/frame/no-such-frame");
    expect(missing.status).toBe(404);
    await missing.arrayBuffer();
  });
});
