import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertListLicence,
  benignCoverage,
  type Capture,
  isPublicAddress,
  type ListEntry,
  majesticList,
  openRenderer,
  RenderTimeout,
  readJournal,
  runBatch,
  saList,
  type UrlList,
  unusable,
} from "../../scripts/glimmer/render.ts";
import { openStore } from "../../scripts/glimmer/store.ts";
import { jpegSize } from "../../src/vision/page-screen.ts";

// scripts/glimmer/render.ts (D03 T04 §6): benign pages rendered by our own browser, isolated per page, kept only when
// usable, and a resumable batch that never stores a page twice.
const words = "Welcome to the example service, where customers manage their accounts and orders every day.";
const pages: Record<string, (res: import("node:http").ServerResponse, origin: string) => void> = {
  "/page": (res) => html(res, `<h1>Example</h1><p>${words}</p><form><input type=password></form>`),
  "/username": (res) => html(res, `<p>${words}</p><label for=u>Username</label><input id=u name=u>`),
  "/email": (res) => html(res, `<p>${words}</p><input type=email>`),
  "/hidden": (res) => html(res, `<p>${words}</p><input type=hidden name=password><input type=password hidden>`),
  "/card": (res) => html(res, `<p>${words}</p><input autocomplete=cc-number>`),
  "/payframe": (res) =>
    html(res, `<p>${words}</p><iframe src="https://js.stripe.com/v3/elements" width=300 height=80></iframe>`),
  "/missing": (res) => {
    res.writeHead(404, { "content-type": "text/html" });
    res.end(`<p>${words}</p>`);
  },
  "/shell": (res) => html(res, "<div id=app>Loading…</div>"),
  "/challenge": (res) => html(res, `<title>Just a moment...</title><p>${words}</p>`),
  "/consent": (res) =>
    html(
      res,
      `<p>${words}</p><div style="position:fixed;inset:0;background:#fff">We use cookies. Accept all cookies to continue.</div>`,
    ),
  "/framed-login": (res) =>
    html(
      res,
      `<div style="position:fixed;inset:0;background:#eef"><h1>Sign in</h1><p>${words}</p><input type=email><a href=#>Terms of use</a> <a href=#>Privacy &amp; cookies</a></div>`,
    ),
  "/to-loopback": (res) => {
    res.writeHead(302, { location: `${secretOrigin}/secret` });
    res.end();
  },
  "/hop": (res) => {
    res.writeHead(302, { location: "/page" });
    res.end();
  },
  "/to-private": (res) => {
    res.writeHead(302, { location: "http://10.0.0.1/" });
    res.end();
  },
  "/download": (res) =>
    html(
      res,
      `<p>${words}</p><a id=d href="/file.bin" download>file</a><script>document.getElementById('d').click()</script>`,
    ),
  "/file.bin": (res) => {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-disposition": "attachment; filename=x.bin",
    });
    res.end("binary");
  },
  "/popup": (res) => html(res, `<p>${words}</p><script>window.open('/page')</script>`),
  "/worker": (res) =>
    html(res, `<p>${words}</p><script>navigator.serviceWorker && navigator.serviceWorker.register('/sw.js')</script>`),
  "/sw.js": (res) => {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end("self.addEventListener('fetch', () => {});");
  },
  "/slow": () => {
    // never answers
  },
};
function html(res: import("node:http").ServerResponse, body: string) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><body>${body}</body></html>`);
}

let server: Server;
let origin: string;
let renderer: Awaited<ReturnType<typeof openRenderer>>;
let serverHits: string[] = [];
// A second local server the renderer is not allowed to reach: a redirect to it must never arrive.
let secret: Server;
let secretOrigin: string;
let secretHits = 0;
let failing503 = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    serverHits.push(path);
    if (path === "/flaky" && failing503-- > 0) {
      res.writeHead(503);
      res.end();
      return;
    }
    if (path === "/flaky") return html(res, `<p>${words}</p>`);
    const page = pages[path];
    if (page) page(res, origin);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  secret = createServer((_req, res) => {
    secretHits++;
    res.end("secret");
  });
  await new Promise<void>((done) => secret.listen(0, "127.0.0.1", done));
  secretOrigin = `http://127.0.0.1:${(secret.address() as AddressInfo).port}`;
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  renderer = await openRenderer({ allowOrigins: [origin], limitMs: 8_000 });
}, 60_000);
afterAll(async () => {
  await renderer?.close();
  server?.closeAllConnections();
  await new Promise((done) => server?.close(done));
  secret?.closeAllConnections();
  await new Promise((done) => secret?.close(done));
});

describe("addresses", () => {
  it("allows only public addresses", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.4.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0"])
      expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ["::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "ff02::1"])
      expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ["8.8.8.8", "196.25.1.1", "2606:4700::1111", "::ffff:8.8.8.8"])
      expect(isPublicAddress(ip), ip).toBe(true);
  });
});

describe("lists", () => {
  it("refuses a list under a non-commercial licence or none", () => {
    expect(() => assertListLicence({ name: "tranco", licence: "CC BY-NC 4.0" })).toThrow(/allowlist/);
    expect(() => assertListLicence({ name: "unknown", licence: "" })).toThrow(/none/);
    expect(() => assertListLicence({ name: "majestic", licence: "CC BY 3.0" })).not.toThrow();
  });

  it("reads Majestic's domains as homepages and the South African list's tagged lines", () => {
    const majestic = majesticList("rank,domain,tld\n1,google.com,com\n2,fnb.co.za,za\n3,not a domain,x\n");
    expect(majestic.entries.map((e) => e.url)).toEqual(["https://google.com/", "https://fnb.co.za/"]);
    const sa = saList(
      "# kind url brand also\nlogin\thttps://www.fnb.co.za/\tFNB\tfirstrand.co.za\nshop\thttps://www.takealot.com/\tTakealot\n",
    );
    expect(sa.entries).toEqual([
      { url: "https://www.fnb.co.za/", kind: "login", brand: "FNB", also: ["firstrand.co.za"] },
      { url: "https://www.takealot.com/", kind: "shop", brand: "Takealot", also: [] },
    ]);
    expect(() => saList("home\thttps://x.co.za/\tX\n")).toThrow(/kind/);
    expect(() => saList("login\thttp://x.co.za/\tX\n")).toThrow(/https/);
  });
});

describe("renderPage", () => {
  it("renders a page with its screenshot, text and form flags", async () => {
    const shot = await renderer.render(`${origin}/page`);
    expect(shot.status).toBe(200);
    expect(shot.text).toContain("Welcome to the example service");
    expect(jpegSize(shot.screenshot)?.width).toBe(1280);
    expect(shot.has_login_form).toBe(true);
    expect(shot.has_payment_form).toBe(false);
  });

  it("sets the form flags from visible fields only", async () => {
    const flags = async (path: string) => {
      const { has_login_form, has_payment_form } = await renderer.render(`${origin}${path}`);
      return [has_login_form, has_payment_form];
    };
    expect(await flags("/username")).toEqual([true, false]);
    expect(await flags("/email")).toEqual([true, false]);
    expect(await flags("/hidden")).toEqual([false, false]);
    expect(await flags("/card")).toEqual([false, true]);
    expect(await flags("/payframe")).toEqual([false, true]);
  });

  it("refuses a redirect to a loopback or private address", async () => {
    serverHits = [];
    await expect(renderer.render(`${origin}/to-loopback`)).rejects.toThrow();
    expect(secretHits).toBe(0);
    await expect(renderer.render(`${origin}/to-private`)).rejects.toThrow(/BLOCKED_BY_CLIENT/);
    expect(renderer.openContexts()).toBe(0);
    // An allowed redirect is still followed, and its target comes back through the guard.
    const followed = await renderer.render(`${origin}/hop`);
    expect([followed.status, new URL(followed.finalUrl).pathname]).toEqual([200, "/page"]);
    expect(serverHits).toEqual(expect.arrayContaining(["/to-loopback", "/hop", "/page"]));
  });

  it("writes no download, closes a pop-up and registers no service worker", async () => {
    expect((await renderer.render(`${origin}/download`)).downloadsWritten).toBe(0);
    expect((await renderer.render(`${origin}/popup`)).popupsClosed).toBeGreaterThanOrEqual(1);
    expect((await renderer.render(`${origin}/worker`)).serviceWorkers).toBe(0);
  });

  it("stops the whole render at its limit and closes the context", async () => {
    const quick = await openRenderer({ allowOrigins: [origin], limitMs: 1_500 });
    const started = Date.now();
    await expect(quick.render(`${origin}/slow`)).rejects.toBeInstanceOf(RenderTimeout);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(quick.openContexts()).toBe(0);
    await quick.close();
  }, 20_000);
});

describe("usable", () => {
  const entry: ListEntry = { url: "https://www.example.co.za/", kind: "home", also: [] };
  const capture = (over: Partial<Capture>): Capture => ({
    listed: entry.url,
    finalUrl: "https://login.example.co.za/",
    status: 200,
    title: "Example",
    text: words,
    screenshot: new Uint8Array(),
    captcha: false,
    consentWall: false,
    downloadsWritten: 0,
    popupsClosed: 0,
    serviceWorkers: 0,
    has_login_form: false,
    has_payment_form: false,
    ...over,
  });

  it("keeps a real page on the listed site", () => {
    expect(unusable(capture({}), entry)).toBeNull();
    expect(
      unusable(capture({ finalUrl: "https://bank.example.com/" }), { ...entry, also: ["example.com"] }),
    ).toBeNull();
  });

  it("excludes an error, a cross-site redirect, a loading shell, a challenge and a consent wall", async () => {
    expect(unusable(capture({ status: 404 }), entry)).toBe("HTTP 404");
    expect(unusable(capture({ finalUrl: "https://parking.example.net/" }), entry)).toMatch(/cross-site/);
    const live = (path: string) => renderer.render(`${origin}${path}`);
    const local = { url: `${origin}/`, kind: "home" as const, also: [] };
    expect(unusable(await live("/missing"), local)).toBe("HTTP 404");
    expect(unusable(await live("/shell"), local)).toMatch(/under 50 characters/);
    expect(unusable(await live("/challenge"), local)).toBe("a challenge page");
    expect(unusable(await live("/consent"), local)).toBe("a cookie wall covering the page");
    expect(unusable(await live("/page"), local)).toBeNull();
    // A sign-in page drawn in a full-screen frame that links its cookie policy is a page, not a wall.
    expect(unusable(await live("/framed-login"), local)).toBeNull();
  });
});

describe("the batch run", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "glimmer-render-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const list = (paths: string[]): UrlList => ({
    name: "benign-sa",
    licence: "own",
    southAfrica: true,
    entries: paths.map((path) => ({ url: `${origin}${path}`, kind: "login", brand: "Example Bank", also: [] })),
  });

  it("stores the usable pages, excludes the rest, and a rerun stores nothing twice", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "store/raw/benign/progress.jsonl");
    const urls = list(["/page", "/email", "/shell"]);
    const first = await runBatch({ list: urls, store, journal, render: renderer.render });
    expect(first).toMatchObject({ stored: 2, excluded: 1 });
    const stored = store.manifest();
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      origin: "benign",
      licence: "benign-sa: own",
      south_africa: true,
      kind: "login",
      labels: { lure: false, lure_type: "none", brand: "Example Bank" },
      label_source: { lure: "ground-truth", brand: "ground-truth", has_login_form: "dom" },
    });
    const again = await runBatch({ list: urls, store, journal, render: renderer.render });
    expect(again).toMatchObject({ stored: 0, skipped: 3 });
    expect(store.manifest()).toHaveLength(2);
  });

  it("finishes a stop between storing and recording with one page", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "store/raw/benign/progress.jsonl");
    const urls = list(["/page"]);
    await expect(
      runBatch({
        list: urls,
        store,
        journal,
        render: renderer.render,
        afterStore: () => {
          throw new Error("stopped");
        },
      }),
    ).rejects.toThrow("stopped");
    expect(readJournal(journal).map((e) => e.event)).toEqual(["started"]);
    let rendered = 0;
    const rerun = await runBatch({
      list: urls,
      store,
      journal,
      render: (url) => {
        rendered++;
        return renderer.render(url);
      },
    });
    expect(rerun.recovered).toBe(1);
    expect(rendered).toBe(0);
    expect(store.manifest()).toHaveLength(1);
    expect(readJournal(journal).at(-1)?.event).toBe("stored");
  });

  it("repairs a truncated journal and retries a 503 once", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    writeFileSync(
      journal,
      `${JSON.stringify({ url: "https://a.example/", event: "excluded", at: "x" })}\n{"url":"https://b.exa`,
    );
    expect(readJournal(journal)).toHaveLength(1);
    expect(readFileSync(journal, "utf-8").endsWith("}\n")).toBe(true);
    failing503 = 1;
    const urls = list(["/flaky"]);
    const first = await runBatch({ list: urls, store, journal, render: renderer.render });
    expect(first, JSON.stringify(readJournal(journal).at(-1))).toMatchObject({ retry: 1 });
    expect(await runBatch({ list: urls, store, journal, render: renderer.render })).toMatchObject({ stored: 1 });
  });
});

describe("benignCoverage", () => {
  it("counts benign renders only, each read back whole", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glimmer-coverage-"));
    try {
      const store = openStore(dir);
      const jpeg = new Uint8Array(
        await sharp({ create: { width: 64, height: 64, channels: 3, background: "#123" } })
          .jpeg()
          .toBuffer(),
      );
      const base = {
        screenshot: jpeg,
        licence: "x",
        host: null,
        template: null,
        redacted: false,
        labels: { lure: false, lure_type: "none" as const },
        label_source: { lure: "ground-truth" as const, lure_type: "ground-truth" as const },
      };
      await store.putPage("benign-majestic", {
        ...base,
        text: "home page",
        origin: "benign",
        south_africa: false,
        kind: "home",
      });
      await store.putPage("benign-sa", {
        ...base,
        text: "bank sign-in",
        origin: "benign",
        south_africa: true,
        kind: "login",
        labels: { ...base.labels, brand: "Bank" },
        label_source: { ...base.label_source, brand: "ground-truth" },
      });
      await store.putPage("phreshphish", {
        ...base,
        text: "benign public page",
        origin: "public",
        south_africa: true,
        kind: "shop",
      });
      const coverage = benignCoverage(store);
      expect(coverage).toMatchObject({ total: 2, southAfrica: 1, signIn: 1, shop: 0, met: false });
      expect(coverage.short).toContain("total 2 of 3000");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
