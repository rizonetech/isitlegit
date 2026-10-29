import { createSocket } from "node:dgram";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertListLicence,
  benignCoverage,
  brandShown,
  type Capture,
  capturedKind,
  HttpStatus,
  isPublicAddress,
  type ListEntry,
  majesticList,
  openRenderer,
  publicLookup,
  RefusedAddress,
  RenderTimeout,
  readJournal,
  recheckStored,
  reopenExcluded,
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
  "/hop-chain": (res) => {
    res.writeHead(302, { location: "/to-loopback" });
    res.end();
  },
  // A response that keeps sending a byte a second and never ends: its connection must not outlive the render.
  "/drip": (res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.write(`<p>${words}</p>`);
    dripOpen++;
    const timer = setInterval(() => res.write(" "), 1000);
    res.on("close", () => {
      clearInterval(timer);
      dripOpen--;
    });
  },
  // A blank page whose only text and sign-in form sit in a frame no one can see.
  "/hidden-frame": (res) => html(res, `<iframe src="/frame-login" style="opacity:0" width=400 height=300></iframe>`),
  "/offscreen-frame": (res) =>
    html(res, `<iframe src="/frame-login" style="position:absolute;left:-10000px" width=400 height=300></iframe>`),
  "/far-frame": (res) =>
    html(
      res,
      `<iframe src="/frame-login" style="position:absolute;left:10000px" width=400 height=300></iframe><iframe src="/frame-login" style="position:absolute;top:10000px" width=400 height=300></iframe>`,
    ),
  // A consent manager's full-screen banner drawn inside an open shadow root.
  "/shadow-consent": (res) =>
    html(
      res,
      `<p>${words}</p><div id=host></div><script>host.attachShadow({ mode: 'open' }).innerHTML = '<div style="position:fixed;inset:0;background:#fff">We use cookies. Accept all cookies to continue.</div>'</script>`,
    ),
  "/frame-login": (res) => html(res, `<p>${words}</p><input type=password>`),
  // A bot-detection script's trick (Game, Makro, Nexstar, 2026-10-29): a hidden frame, and a hidden element, whose own
  // DOM methods and inline style return nothing.
  "/masked": (res) =>
    html(
      res,
      `<p>${words}</p><form><input type=password></form><iframe id=f style="display:none"></iframe><div id=d style="opacity:0">unseen</div><script>for (const el of [f, d]) { for (const name of ['getBoundingClientRect', 'checkVisibility', 'contains']) Object.defineProperty(el, name, { value: () => undefined }); for (const name of ['style', 'tagName', 'src']) Object.defineProperty(el, name, { get: () => undefined }) }</script>`,
    ),
  // Bot walls as the render meets them (§26, plan review gaps 3 and 4).
  "/wall-split": (res) => html(res, `<p>${words}</p><p>Press<br>&amp;<br>Hold to confirm</p>`),
  "/wall-late": (res) =>
    html(
      res,
      `<p>${words.repeat(30)}</p><div style="position:fixed;bottom:0;left:0;width:300px;height:80px;background:#fff">Access denied</div>`,
    ),
  "/wall-frame": (res) =>
    html(
      res,
      `<p>${words}</p><iframe width=600 height=400 srcdoc="<iframe src='https://challenge.invalid/recaptcha/api2/anchor' width=320 height=200></iframe>"></iframe>`,
    ),
  "/wall-shadow": (res) =>
    html(
      res,
      `<p>${words}</p><div id=host></div><script>host.attachShadow({ mode: 'open' }).innerHTML = '<div style="position:fixed;top:0;left:0;width:400px;height:100px;background:#fff">Access denied</div>'</script>`,
    ),
  "/wall-cover": (res) =>
    html(
      res,
      `<p>${words}</p><div style="position:fixed;inset:0;background:#fff"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width=200 height=200></div><script src="https://client.px-cdn.net/main.min.js"></script>`,
    ),
  // A page that removes its own root element.
  "/no-root": (res) => html(res, `<p>${words}</p><script>document.documentElement.remove()</script>`),
  // A server that drops the connection before it answers.
  "/reset": (res) => res.socket?.destroy(),
  // A page that, while it settles, moves on to a same-site page that does not exist.
  "/moves-on": (res) =>
    html(res, `<p>${words}</p><script>setTimeout(() => { location.href = '/missing' }, 100)</script>`),
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
  // A sign-in form two frames down, the first from another origin: the identity provider's frame is the page's form.
  "/xframe-login": (res) =>
    html(res, `<p>${words}</p><iframe src="${frameOrigin}/inner" width=500 height=400></iframe>`),
  // A small consent dialog over a full-screen backdrop, and a consent provider's frame over the page.
  "/backdrop-consent": (res) =>
    html(
      res,
      `<p>${words}</p><div style="position:fixed;inset:0;background:rgba(0,0,0,.5)"></div><div style="position:fixed;left:20px;bottom:20px;width:320px;height:140px;background:#fff">We use cookies. Accept all cookies?</div>`,
    ),
  "/cmp-frame": (res) =>
    html(
      res,
      `<p>${words}</p><iframe src="/consent-manager/notice.html" style="position:fixed;left:0;top:0;width:900px;height:500px;border:0"></iframe>`,
    ),
  "/consent-manager/notice.html": (res) => html(res, "<p>Your privacy choices</p>"),
  "/captcha-badge": (res) =>
    html(
      res,
      `<p>${words}</p><iframe src="/recaptcha/badge" style="position:fixed;right:0;bottom:0;width:70px;height:60px"></iframe>`,
    ),
  "/captcha-challenge": (res) =>
    html(res, `<p>${words}</p><iframe src="/recaptcha/challenge" width=400 height=500></iframe>`),
  "/opacity-body": (res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><body style="opacity:0"><p>${words}</p></body></html>`);
  },
  "/geo": (res) =>
    html(
      res,
      `<p>${words}</p><p id=g>GEO-WAITING</p><script>navigator.geolocation.getCurrentPosition(() => { g.textContent = 'GEO-ALLOWED' }, (e) => { g.textContent = 'GEO-DENIED-' + e.code })</script>`,
    ),
  "/ws": (res) =>
    html(
      res,
      `<p>${words}</p><p id=w>WS-WAITING</p><script>const s = new WebSocket('ws://' + location.host + '/socket'); s.onmessage = () => { w.textContent = 'WS-MESSAGE' }; s.onclose = () => { if (w.textContent === 'WS-WAITING') w.textContent = 'WS-CLOSED' }</script>`,
    ),
  "/storage-set": (res) =>
    html(res, `<p>${words}</p><script>localStorage.setItem('k', 'kept'); document.cookie = 'c=kept'</script>`),
  "/storage-get": (res) =>
    html(
      res,
      `<p>${words}</p><p id=s></p><script>s.textContent = 'STORED-' + localStorage.getItem('k') + '-' + (document.cookie || 'none')</script>`,
    ),
  // A page that gathers WebRTC candidates against a STUN server on loopback: UDP that would leave outside the proxy.
  "/webrtc": (res) =>
    html(
      res,
      `<p>${words}</p><script>const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${stunPort}' }] }); pc.createDataChannel('x'); pc.createOffer().then((offer) => pc.setLocalDescription(offer))</script>`,
    ),
  // A server that compresses although asked not to.
  "/gzip": (res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
    res.end(gzipSync(`<!doctype html><html><body><p>Compressed: ${words}</p></body></html>`));
  },
  // A page whose script never yields once it has loaded: nothing can be read from it.
  "/hang": (res) => html(res, `<p>${words}</p><script>setTimeout(() => { for (;;) {} }, 50)</script>`),
};
const framePages: Record<string, string> = {
  "/inner": `<p>Example Identity</p><iframe src="/nested" width=400 height=300></iframe>`,
  "/nested": `<p>Nested sign-in text for the example service</p><input type=password>`,
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
let upgrades = 0;
let dripOpen = 0;
let stunPort = 0;
let stunPackets = 0;
let frameServer: Server;
let stunSocket: ReturnType<typeof createSocket> | undefined;
let frameOrigin: string;
beforeAll(async () => {
  const stun = createSocket("udp4");
  stun.on("message", () => {
    stunPackets++;
  });
  await new Promise<void>((done) => stun.bind(0, "127.0.0.1", done));
  stunPort = stun.address().port;
  stunSocket = stun;
  frameServer = createServer((req, res) => {
    const body = framePages[new URL(req.url ?? "/", "http://x").pathname];
    if (body) html(res, body);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((done) => frameServer.listen(0, "127.0.0.1", done));
  frameOrigin = `http://127.0.0.1:${(frameServer.address() as AddressInfo).port}`;
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
  server.on("upgrade", (_req, socket) => {
    upgrades++;
    socket.destroy();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  secret = createServer((_req, res) => {
    secretHits++;
    res.end("secret");
  });
  await new Promise<void>((done) => secret.listen(0, "127.0.0.1", done));
  secretOrigin = `http://127.0.0.1:${(secret.address() as AddressInfo).port}`;
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  renderer = await openRenderer({ allowOrigins: [origin, frameOrigin], limitMs: 8_000 });
  // The browser starts lazily on the first page; it starts here, inside the hook's 60 seconds, so no test pays
  // Chromium's start-up on a slow CI runner (three runs on 2026-10-28 timed out at 15 seconds that way).
  await renderer.render(`${origin}/page`);
}, 60_000);
afterAll(async () => {
  await renderer?.close();
  server?.closeAllConnections();
  await new Promise((done) => server?.close(done));
  secret?.closeAllConnections();
  await new Promise((done) => secret?.close(done));
  stunSocket?.close();
  frameServer?.closeAllConnections();
  await new Promise((done) => frameServer?.close(done));
});

describe("start-up", () => {
  it("pays a fresh browser's first context at launch, outside every render's deadline", () => {
    // beforeAll's first render started the browser: its first context was made and closed while it started.
    expect(renderer.launches()).toBe(1);
    expect(renderer.warmups()).toBe(1);
    expect(renderer.openContexts()).toBe(0);
  });
});

describe("addresses", () => {
  it("checks a name's addresses at every connection, so a name that turns private is refused", async () => {
    const answers = [[{ address: "93.184.216.34", family: 4 }], [{ address: "127.0.0.1", family: 4 }]];
    const lookup = publicLookup(async () => answers.shift() ?? []);
    const connect = () =>
      new Promise<string>((done) =>
        lookup("rebind.example", {}, (error, address) =>
          done(error ? ((error as { code?: string }).code ?? "") : String(address)),
        ),
      );
    expect(await connect()).toBe("93.184.216.34");
    expect(await connect()).toBe("EPRIVATE");
  });

  it("refuses a page whose name resolves to a private address when the browser connects", async () => {
    const rebinding = await openRenderer({
      limitMs: 5_000,
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    serverHits = [];
    const port = new URL(origin).port;
    await expect(rebinding.render(`http://rebind.example:${port}/page`)).rejects.toBeInstanceOf(RefusedAddress);
    // An https page goes through the proxy's CONNECT tunnel, which checks the same way.
    await expect(rebinding.render(`https://rebind.example:${port}/page`)).rejects.toBeInstanceOf(RefusedAddress);
    expect(serverHits).toEqual([]);
    await rebinding.close();
  }, 30_000);

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
    expect(() => saList("blog\thttps://x.co.za/\tX\n")).toThrow(/kind/);
    expect(saList("home\thttps://x.co.za/\tX\n").entries[0]?.kind).toBe("home");
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

  it("reads a page whose elements carry DOM methods of their own that return nothing", async () => {
    const shot = await renderer.render(`${origin}/masked`);
    expect(shot.text).toContain("Welcome to the example service");
    expect(shot.text).not.toContain("unseen");
    expect([shot.has_login_form, shot.consentWall, shot.captcha]).toEqual([true, false, false]);
  });

  it("reads a page with no root element left as a short page, not a failed capture", async () => {
    const empty = await renderer.render(`${origin}/no-root`);
    expect(empty.text.trim()).toBe("");
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
    await expect(renderer.render(`${origin}/to-private`)).rejects.toBeInstanceOf(RefusedAddress);
    // The second hop of a chain is checked as the first is.
    await expect(renderer.render(`${origin}/hop-chain`)).rejects.toThrow();
    expect(secretHits).toBe(0);
    expect(renderer.openContexts()).toBe(0);
    // An allowed redirect is still followed, and its target comes back through the guard.
    const followed = await renderer.render(`${origin}/hop`);
    expect([followed.status, new URL(followed.finalUrl).pathname]).toEqual([200, "/page"]);
    expect(serverHits).toEqual(expect.arrayContaining(["/to-loopback", "/hop", "/page"]));
  });

  it("hands the browser a compressed body decoded", async () => {
    expect((await renderer.render(`${origin}/gzip`)).text).toContain(`Compressed: ${words}`);
  });

  it("reads a sign-in form and its text from a cross-origin frame and the frame inside it", async () => {
    const shot = await renderer.render(`${origin}/xframe-login`);
    expect(shot.has_login_form).toBe(true);
    expect(shot.text).toContain("Nested sign-in text for the example service");
  });

  it("sends no WebRTC traffic outside the proxy", async () => {
    stunPackets = 0;
    await renderer.render(`${origin}/webrtc`);
    expect(stunPackets).toBe(0);
  });

  it("denies permissions, refuses WebSockets and keeps nothing between pages", async () => {
    expect((await renderer.render(`${origin}/geo`)).text).toMatch(/GEO-DENIED-1/);
    upgrades = 0;
    expect((await renderer.render(`${origin}/ws`)).text).toContain("WS-CLOSED");
    expect(upgrades).toBe(0);
    await renderer.render(`${origin}/storage-set`);
    expect((await renderer.render(`${origin}/storage-get`)).text).toContain("STORED-null-none");
  });

  it("writes no download, closes a pop-up and registers no service worker", async () => {
    expect((await renderer.render(`${origin}/download`)).downloadsWritten).toBe(0);
    expect((await renderer.render(`${origin}/popup`)).popupsClosed).toBeGreaterThanOrEqual(1);
    expect((await renderer.render(`${origin}/worker`)).serviceWorkers).toBe(0);
  });

  it("stops the whole render at its limit and closes the context", async () => {
    const quick = await openRenderer({ allowOrigins: [origin], limitMs: 1_500 });
    // The browser starts first, under its own bound, so the clock below times the render alone.
    await quick.render(`${origin}/page`).catch(() => undefined);
    const started = Date.now();
    await expect(quick.render(`${origin}/slow`)).rejects.toBeInstanceOf(RenderTimeout);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(quick.openContexts()).toBe(0);
    await quick.close();
  }, 20_000);

  it("ends a render's outbound connections with the render", async () => {
    const quick = await openRenderer({ allowOrigins: [origin], limitMs: 2_500 });
    await quick.render(`${origin}/page`);
    await expect(quick.render(`${origin}/drip`)).rejects.toBeInstanceOf(RenderTimeout);
    await new Promise((done) => setTimeout(done, 300));
    expect(dripOpen).toBe(0);
    await quick.close();
  }, 30_000);

  it("reads nothing from a frame no one can see", async () => {
    const shot = await renderer.render(`${origin}/hidden-frame`);
    expect(shot.has_login_form).toBe(false);
    expect(shot.text).not.toContain("Welcome");
    const away = await renderer.render(`${origin}/offscreen-frame`);
    expect(away.has_login_form).toBe(false);
    expect(away.text).not.toContain("Welcome");
    // Past the 1280 by 2000 pixels the screenshot keeps, to the right or below.
    const far = await renderer.render(`${origin}/far-frame`);
    expect(far.has_login_form).toBe(false);
    expect(far.text).not.toContain("Welcome");
  });

  it("judges a page that moves on by the document captured", async () => {
    const shot = await renderer.render(`${origin}/moves-on`);
    expect([shot.status, new URL(shot.finalUrl).pathname]).toEqual([404, "/missing"]);
  });

  it("gives up on a page that stops answering and goes on with the next", async () => {
    const quick = await openRenderer({ allowOrigins: [origin], limitMs: 3_000 });
    // The browser starts first, under its own bound, so the clock below times the render alone.
    await quick.render(`${origin}/page`).catch(() => undefined);
    const started = Date.now();
    await expect(quick.render(`${origin}/hang`)).rejects.toBeInstanceOf(RenderTimeout);
    // The render's 3 seconds and at most 5 more for the context's close.
    expect(Date.now() - started).toBeLessThan(9_000);
    expect(quick.openContexts()).toBe(0);
    expect((await quick.render(`${origin}/page`)).status).toBe(200);
    await quick.close();
  }, 40_000);
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
    overlays: "",
    challengeCover: false,
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
    // HUMAN's and Imperva's walls, as South African retailers and journals served them.
    for (const wall of [
      "Are you a human? Press and hold the button below to confirm.",
      "Additional security check is required. Just click the checkbox above to pass the security check.",
    ])
      expect(unusable(capture({ text: `${wall} ${words}` }), entry)).toBe("a challenge page");
    expect(unusable(await live("/consent"), local)).toBe("a cookie wall covering the page");
    expect(unusable(await live("/page"), local)).toBeNull();
    // A sign-in page drawn in a full-screen frame that links its cookie policy is a page, not a wall.
    expect(unusable(await live("/framed-login"), local)).toBeNull();
    expect(unusable(await live("/backdrop-consent"), local)).toBe("a cookie wall covering the page");
    expect(unusable(await live("/cmp-frame"), local)).toBe("a cookie wall covering the page");
    expect(unusable(await live("/shadow-consent"), local)).toBe("a cookie wall covering the page");
    expect(unusable(await live("/captcha-challenge"), local)).toBe("a CAPTCHA frame");
    // A protection badge in a corner is not a challenge the viewer must solve.
    expect(unusable(await live("/captcha-badge"), local)).toBeNull();
    // Text under a body that opacity 0 hides is not shown.
    expect(unusable(await live("/opacity-body"), local)).toMatch(/under 50 characters/);
  });

  it("excludes a site's not-found page answered with 200", () => {
    const cart = { url: "https://www.checkers.co.za/cart", kind: "checkout" as const, brand: "Checkers", also: [] };
    const fallback = capture({ finalUrl: cart.url, title: "Checkers | Page not found", text: `Sorry. ${words}` });
    expect(unusable(fallback, cart)).toBe("an error page answered with 200");
    // Its message after a long header of navigation and a cart subtotal.
    const header = `Checkers Home Shop Specials Recipes Stores Sixty60 Cart Subtotal R 0.00 ${"Departments ".repeat(40)}`;
    const late = capture({
      finalUrl: cart.url,
      title: "Checkers",
      text: `${header}Sorry, this page could not be found.`,
    });
    expect(unusable(late, cart)).toBe("an error page answered with 200");
  });

  it("excludes a listed page that lands on a sign-in page or does not show its brand", () => {
    const profile = { url: "https://www.facebook.com/FNBSA", kind: "social" as const, brand: "FNB", also: [] };
    const generic = capture({ finalUrl: "https://www.facebook.com/login/?next=x", title: "Log in to Facebook" });
    expect(unusable(generic, profile)).toBe("redirected to a sign-in page, not the social page listed");
    const other = capture({ finalUrl: "https://www.facebook.com/somebody", title: "Somebody" });
    expect(unusable(other, profile)).toBe("the listed brand (FNB) is not on the page");
    expect(
      unusable(capture({ finalUrl: "https://www.facebook.com/FNBSA", title: "FNB | Facebook" }), profile),
    ).toBeNull();
    // A word every bank shares does not show a brand.
    expect(brandShown("Standard Bank", { title: "Bank", text: words, finalUrl: "https://example.com/" })).toBe(false);
  });

  it("keeps a listed kind only when the page shows it", () => {
    const said = (text: string) => ({ text });
    const at = (path: string, over: Partial<Capture> = {}) =>
      capture({ finalUrl: `https://www.example.co.za${path}`, ...over });
    expect(capturedKind({ kind: "login" }, at("/login", { has_login_form: true }))).toBe("login");
    expect(capturedKind({ kind: "login" }, at("/"))).toBe("home");
    expect(capturedKind({ kind: "checkout" }, at("/cart", said("Your cart is empty. Subtotal R 0.00")))).toBe(
      "checkout",
    );
    // A path is not enough: the page must say what it is.
    expect(capturedKind({ kind: "checkout" }, at("/cart"))).toBe("home");
    expect(capturedKind({ kind: "shop" }, at("/products/kettle-2l", said("Kettle 2 l. R 499.00. Add to cart")))).toBe(
      "shop",
    );
    expect(capturedKind({ kind: "shop" }, at("/products/kettle-2l"))).toBe("home");
    expect(capturedKind({ kind: "shop" }, at("/en-za/", said("Add to cart")))).toBe("home");
    expect(capturedKind({ kind: "company" }, at("/about-us/", said("About us: our story since 1910")))).toBe("company");
    expect(capturedKind({ kind: "company" }, at("/"))).toBe("home");
    expect(capturedKind({ kind: "social" }, at("/FNBSA"))).toBe("social");
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

  it("retries a server error however Chromium reports it, and excludes a client error", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    // Some Chromium builds fail the navigation of an empty 5xx (net::ERR_HTTP_RESPONSE_CODE_FAILURE) instead of
    // answering it; the renderer reports that as the status.
    const failing = (status: number) => async () => {
      throw new HttpStatus(status);
    };
    expect(await runBatch({ list: list(["/a"]), store, journal, render: failing(503) })).toMatchObject({ retry: 1 });
    expect(await runBatch({ list: list(["/b"]), store, journal, render: failing(404) })).toMatchObject({ excluded: 1 });
    expect(readJournal(journal).at(-1)?.reason).toBe("HTTP 404");
  });

  it("takes out a stored page a later challenge check refuses, and records it excluded", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    const page = await renderer.render(`${origin}/page`);
    const wall = { ...page, text: `Are you a human? Press & Hold. ${words}` };
    await runBatch({ list: list(["/wall"]), store, journal, render: async () => wall, concurrency: 1 });
    // A run now refuses the wall; one stored before the check knew it is put in directly.
    expect(store.manifest()).toHaveLength(0);
    const id = await store.putPage("benign-test", {
      screenshot: wall.screenshot,
      text: wall.text,
      origin: "benign",
      licence: "test",
      host: null,
      template: null,
      south_africa: false,
      labels: { lure: false, lure_type: "none", has_login_form: false, has_payment_form: false },
      label_source: { lure: "ground-truth", lure_type: "ground-truth", has_login_form: "dom", has_payment_form: "dom" },
      redacted: false,
      url: `${origin}/old-wall`,
      kind: "home",
    });
    await runBatch({ list: list(["/page"]), store, journal, render: renderer.render });
    expect(recheckStored(store, journal)).toMatchObject({ removed: [id], damaged: [], unassessed: [] });
    expect(store.manifest().map((p) => p.url)).toEqual([`${origin}/page`]);
    expect(readJournal(journal).at(-1)).toMatchObject({ url: `${origin}/old-wall`, event: "excluded" });
    expect(recheckStored(store, journal).removed).toEqual([]);
  });

  it("stores no bot wall, however it is drawn", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    const walls = ["/wall-split", "/wall-late", "/wall-frame", "/wall-shadow", "/wall-cover"];
    const result = await runBatch({ list: list(walls), store, journal, render: renderer.render, concurrency: 1 });
    expect(result).toMatchObject({ stored: 0, excluded: walls.length });
    const reasons = readJournal(journal)
      .filter((e) => e.event === "excluded")
      .map((e) => e.reason);
    expect(
      reasons.every((r) => /challenge|CAPTCHA/.test(r ?? "")),
      reasons.join("; "),
    ).toBe(true);
  });

  it("audits a stored page by its kept evidence, and a legacy page by OCR, unassessed when OCR cannot read it", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    const shot = await renderer.render(`${origin}/page`);
    const put = (text: string, evidence?: { title: string; overlays: string }) =>
      store.putPage("benign-test", {
        screenshot: shot.screenshot,
        text,
        origin: "benign",
        licence: "test",
        host: null,
        template: null,
        south_africa: false,
        labels: { lure: false, lure_type: "none", has_login_form: false, has_payment_form: false },
        label_source: {
          lure: "ground-truth",
          lure_type: "ground-truth",
          has_login_form: "dom",
          has_payment_form: "dom",
        },
        redacted: false,
        url: `${origin}/${text.length}`,
        ...(evidence ? { evidence } : {}),
      });
    const overlaid = await put(`${words} one`, { title: "Shop", overlays: "Access denied" });
    const clean = await put(`${words} two`, { title: "Shop", overlays: "" });
    const legacyWall = await put(`${words} three`);
    const legacyUnread = await put(`${words} four`);
    const audit = recheckStored(store, journal, new Map([[legacyWall, "Press & Hold"]]));
    expect(audit.removed.sort()).toEqual([overlaid, legacyWall].sort());
    expect(audit.unassessed).toEqual([legacyUnread]);
    expect(store.manifest().map((p) => p.id)).toContain(clean);
  });

  it("lists a damaged page instead of passing it, and finishes a removal a stop interrupted", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    await runBatch({ list: list(["/page", "/frame-login"]), store, journal, render: renderer.render, concurrency: 1 });
    const [first, second] = store.manifest().map((p) => p.id) as [string, string];
    const shot = await renderer.render(`${origin}/page`);
    const third = await store.putPage("benign-test", {
      screenshot: shot.screenshot,
      text: "a third benign page",
      origin: "benign",
      licence: "test",
      host: null,
      template: null,
      south_africa: false,
      labels: { lure: false, lure_type: "none", has_login_form: false, has_payment_form: false },
      label_source: { lure: "ground-truth", lure_type: "ground-truth", has_login_form: "dom", has_payment_form: "dom" },
      redacted: false,
    });
    writeFileSync(join(dir, "store", "pages", first, "text.txt"), "altered");
    writeFileSync(join(dir, "store", "pages", third, "meta.json"), "{ not json");
    const audit = recheckStored(store, journal);
    expect(audit.damaged.sort()).toEqual([first, third].sort());
    expect(audit.checked).toBe(1);
    // A stop after the page went but before its exclusion was written: the next recheck writes it, once.
    const url = store.manifest({ tolerant: true }).find((p) => p.id === second)?.url as string;
    writeFileSync(
      `${journal}.removing.json`,
      JSON.stringify({ id: second, url, reason: "a challenge page (found on a recheck)" }),
    );
    store.removePage(second);
    recheckStored(store, journal);
    recheckStored(store, journal);
    const lines = readJournal(journal).filter((e) => e.url === url && e.event === "excluded");
    expect(lines).toHaveLength(1);
    expect(existsSync(`${journal}.removing.json`)).toBe(false);
  });

  it("renders an exclusion a renderer fault made again once it is reopened, and nothing else", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    const fault = async () => {
      throw new Error("page.evaluate: TypeError: Cannot read properties of undefined (reading 'width')");
    };
    await runBatch({ list: list(["/page"]), store, journal, render: fault });
    await runBatch({
      list: list(["/b"]),
      store,
      journal,
      render: async () => {
        throw new HttpStatus(404);
      },
    });
    // Skipped while excluded; the fault's exclusion alone is reopened, its record kept.
    expect(await runBatch({ list: list(["/page"]), store, journal, render: renderer.render })).toMatchObject({
      skipped: 1,
    });
    expect(reopenExcluded(journal, /page\.evaluate: TypeError/)).toEqual([`${origin}/page`]);
    expect(readJournal(journal).filter((e) => e.event === "excluded")).toHaveLength(2);
    expect(await runBatch({ list: list(["/page", "/b"]), store, journal, render: renderer.render })).toMatchObject({
      stored: 1,
      skipped: 1,
    });
    // A stored page is never reopened.
    expect(reopenExcluded(journal, /./)).toEqual([`${origin}/b`]);
  });

  it("records a second URL that renders the same page as excluded, not stored twice", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    const same = await renderer.render(`${origin}/page`);
    const result = await runBatch({
      list: list(["/one", "/two"]),
      store,
      journal,
      render: async () => same,
      concurrency: 1,
    });
    expect(result).toMatchObject({ stored: 1, excluded: 1 });
    expect(readJournal(journal).at(-1)?.reason).toBe(`the same page as ${origin}/one`);
    expect(store.manifest()).toHaveLength(1);
  });

  it("retries a connection the server dropped, through the real renderer", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    expect(await runBatch({ list: list(["/reset"]), store, journal, render: renderer.render })).toMatchObject({
      retry: 1,
    });
  });

  it("retries a passing network failure and a 429, and excludes a page after its third try", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    const throwing = (error: Error) => async () => {
      throw error;
    };
    const reset = throwing(new Error("page.goto: net::ERR_CONNECTION_RESET at https://x/"));
    expect(await runBatch({ list: list(["/r"]), store, journal, render: reset })).toMatchObject({ retry: 1 });
    expect(await runBatch({ list: list(["/q"]), store, journal, render: throwing(new HttpStatus(429)) })).toMatchObject(
      {
        retry: 1,
      },
    );
    const timeout = throwing(new RenderTimeout("the render passed 20 seconds"));
    const urls = list(["/t"]);
    expect(await runBatch({ list: urls, store, journal, render: timeout })).toMatchObject({ retry: 1 });
    expect(await runBatch({ list: urls, store, journal, render: timeout })).toMatchObject({ retry: 1 });
    expect(await runBatch({ list: urls, store, journal, render: timeout })).toMatchObject({ excluded: 1 });
    expect(readJournal(journal).at(-1)?.reason).toBe("the render passed 20 seconds (3 tries)");
    expect(await runBatch({ list: urls, store, journal, render: timeout })).toMatchObject({ skipped: 1 });
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
        labels: { lure: false, lure_type: "none" as const, has_login_form: false, has_payment_form: false },
        label_source: {
          lure: "ground-truth" as const,
          lure_type: "ground-truth" as const,
          has_login_form: "dom" as const,
          has_payment_form: "dom" as const,
        },
        url: "https://www.example.co.za/",
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
      // A benign render read back without its DOM form flags or its listed URL is a problem, not a page.
      const { has_login_form: _flag, ...noFlags } = base.labels;
      const { has_login_form: _source, ...noFlagSources } = base.label_source;
      await store.putPage("benign-sa", {
        ...base,
        text: "a page without its flags",
        origin: "benign",
        south_africa: true,
        kind: "home",
        labels: noFlags,
        label_source: noFlagSources,
      });
      await store.putPage("benign-sa", {
        ...base,
        text: "a page without its URL",
        origin: "benign",
        south_africa: true,
        kind: "home",
        url: undefined,
      });
      // A page whose text went missing, and one whose record does not read, are problems; the count goes on.
      const lost = await store.putPage("benign-sa", {
        ...base,
        text: "a page whose text goes",
        origin: "benign",
        south_africa: true,
        kind: "home",
      });
      rmSync(join(dir, "pages", lost, "text.txt"));
      const broken = await store.putPage("benign-sa", {
        ...base,
        text: "a page whose record breaks",
        origin: "benign",
        south_africa: true,
        kind: "home",
      });
      writeFileSync(join(dir, "pages", broken, "meta.json"), "{ not json");
      const coverage = benignCoverage(store);
      expect(coverage.problems).toEqual(
        expect.arrayContaining([`${lost}: its files do not read`, `${broken}: damaged`]),
      );
      expect(coverage).toMatchObject({ total: 2, southAfrica: 1, signIn: 1, shop: 0, met: false });
      expect(coverage.short).toContain("total 2 of 3000");
      expect(coverage.problems.map((line) => line.split(": ")[1])).toEqual(
        expect.arrayContaining(["no DOM-read has_login_form", "no listed URL"]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
