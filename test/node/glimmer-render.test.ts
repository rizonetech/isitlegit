import { createSocket } from "node:dgram";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertListLicence,
  assessCapture,
  BrowserFault,
  benignCoverage,
  brandShown,
  type Capture,
  capturedKind,
  evidenceOf,
  HttpStatus,
  isPublicAddress,
  type ListEntry,
  majesticList,
  openRenderer,
  publicLookup,
  type Reading,
  RefusedAddress,
  RenderTimeout,
  readingsAgree,
  readJournal,
  recheckStored,
  renderReceipt,
  reopenExcluded,
  runBatch,
  saList,
  type UrlList,
  unusable,
} from "../../scripts/glimmer/render.ts";
import { openStore, type StoredPage } from "../../scripts/glimmer/store.ts";
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
  // A page that never holds still (§26, plan review gap 5).
  "/title-ticker": (res) =>
    html(res, `<p>${words}</p><script>let n = 0; setInterval(() => { document.title = 'Shop ' + n++ }, 20)</script>`),
  // The same trick on the prototypes and globals every reader uses (§26, plan review gap 1).
  "/masked-proto": (res) =>
    html(
      res,
      `<p>${words}</p><form><input type=password></form><div style="opacity:0">unseen</div><div style="position:fixed;bottom:0;left:0;width:300px;height:60px">Are you a human?</div><script>
        for (const proto of [Element.prototype, Node.prototype]) for (const name of ['getBoundingClientRect', 'checkVisibility', 'contains']) if (name in proto) Object.defineProperty(proto, name, { value: () => undefined });
        Document.prototype.querySelectorAll = () => [];
        Element.prototype.querySelectorAll = () => [];
        Object.defineProperty(HTMLElement.prototype, 'innerText', { get: () => '' });
        Array.prototype.some = () => false;
        window.getComputedStyle = () => undefined;
      </script>`,
    ),
  // §26's completion review: text that changes during capture, a form below its frame's visible area, a shadow
  // root's form and text, a small wall panel, a consent wall inside a frame, and covers drawn as one image.
  "/text-swap": (res) =>
    html(
      res,
      `<p id=t>My account</p><p>${words}</p><script>let n = 0; setInterval(() => { t.textContent = 'Account ' + (n++).toString(26).replace(/[0-9]/g, (d) => 'klmnopqrst'[d]) }, 10)</script>`,
    ),
  "/frame-clipped": (res) =>
    html(
      res,
      `<p>${words}</p><iframe width=400 height=300 srcdoc="<p>inside</p><div style='height:1000px'></div><input type=password>"></iframe>`,
    ),
  "/shadow-form": (res) =>
    html(
      res,
      `<p>${words}</p><div id=h></div><script>h.attachShadow({ mode: 'open' }).innerHTML = '<p>Shadow sign-in words</p><input type=password>'</script>`,
    ),
  "/wall-panel": (res) =>
    html(
      res,
      `<p>${words.repeat(30)}</p><div style="position:absolute;top:10px;right:10px;width:200px;height:40px;background:#fff">Access denied</div>`,
    ),
  "/consent-frame": (res) =>
    html(
      res,
      `<p>${words}</p><iframe width=1200 height=700 srcdoc="<p>framed</p><div style='position:fixed;inset:0;background:#fff'>We use cookies. Accept all cookies to continue.</div>"></iframe>`,
    ),
  "/wall-img": (res) =>
    html(
      res,
      `<p>${words}</p><img style="position:fixed;inset:0;width:100%;height:100%" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><script src="https://client.px-cdn.net/main.min.js"></script>`,
    ),
  "/wall-css": (res) =>
    html(
      res,
      `<p>${words}</p><div style="position:fixed;inset:0;background-image:url(data:image/gif;base64,R0lGODlhAQABAAAAACw=)"></div><script src="https://client.px-cdn.net/main.min.js"></script>`,
    ),
  // §26 round 1: a shadow root's own text, a pseudo-element cover, overflow clipping, and a field below the crop.
  "/wall-shadow-text": (res) =>
    html(
      res,
      `<p>${words}</p><div id=h style="position:fixed;top:0;left:0;width:400px;height:100px;background:#fff"></div><script>h.attachShadow({ mode: 'open' }).textContent = 'Press & Hold'</script>`,
    ),
  "/wall-pseudo": (res) =>
    html(
      res,
      `<style>.c::before { content: ""; position: fixed; inset: 0; background-image: url(data:image/gif;base64,R0lGODlhAQABAAAAACw=) }</style><p>${words}</p><div class=c></div><script src="https://client.px-cdn.net/main.min.js"></script>`,
    ),
  "/wall-pseudo-text": (res) =>
    html(
      res,
      `<style>.c::before { content: "Press & Hold"; position: fixed; inset: 0; background: white; z-index: 9999 }</style><p>${words}</p><div class=c></div>`,
    ),
  "/form-covered": (res) =>
    html(
      res,
      `<p>${words}</p><form><input type=password></form><div style="position:fixed;inset:0;background:#fff;z-index:9999"><p>Scheduled maintenance: we will be back shortly. Thank you for your patience while we work.</p></div>`,
    ),
  "/wall-pseudo-hidden": (res) =>
    html(
      res,
      `<style>.c { display: none } .c::before { content: "Press & Hold"; position: fixed; inset: 0 }</style><p>${words}</p><div class=c></div>`,
    ),
  "/frame-overflow": (res) =>
    html(
      res,
      `<p>${words}</p><div style="height:0;overflow:hidden"><iframe src="/frame-login" width=400 height=300></iframe><input type=password></div>`,
    ),
  "/form-below": (res) => html(res, `<p>${words}</p><div style="height:2500px"></div><input type=password>`),
  // §26 round 2: a closed shadow root, a clipping shadow host, and a scaled frame.
  "/wall-closed": (res) =>
    html(
      res,
      `<p>${words}</p><div id=h style="position:fixed;top:0;left:0;width:400px;height:100px;background:#fff"></div><script>h.attachShadow({ mode: 'closed' }).textContent = 'Press & Hold'</script>`,
    ),
  "/shadow-clipped": (res) =>
    html(
      res,
      `<p>${words}</p><div id=h style="display:block;height:0;overflow:hidden"></div><script>h.attachShadow({ mode: 'open' }).innerHTML = '<input type=password>'</script>`,
    ),
  "/frame-scaled": (res) =>
    html(
      res,
      `<p>${words}</p><iframe style="position:absolute;top:1800px;left:0;border:0;transform:scale(.5);transform-origin:top left" width=400 height=400 srcdoc="<div style='height:300px'></div><input type=password>"></iframe>`,
    ),
  // §26's final review: a wall drawn as a picture in the page's flow, text clipped away, a CAPTCHA checkbox widget,
  // and a hidden closed-root widget.
  "/wall-flow-image": (res) =>
    html(
      res,
      `<div style="height:100vh;background-image:url(data:image/gif;base64,R0lGODlhAQABAAAAACw=)"></div><p>${words}</p>`,
    ),
  "/clipped-text": (res) =>
    html(res, `<p>A short visible line.</p><div style="height:0;overflow:hidden"><p>${words}</p></div>`),
  "/captcha-widget": (res) =>
    html(res, `<p>${words}</p><iframe src="https://challenges.invalid/captcha/checkbox" width=300 height=65></iframe>`),
  "/closed-hidden": (res) =>
    html(
      res,
      `<p>${words}</p><div id=h style="display:none"></div><script>h.attachShadow({ mode: 'closed' }).textContent = 'hidden'</script>`,
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
  // OCR is §7's engine in production; here a picture's words are none unless a test says otherwise.
  renderer = await openRenderer({ allowOrigins: [origin, frameOrigin], limitMs: 8_000, ocr: async () => "" });
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
  it("starts a slow browser outside the page's deadline and warms the browser that replaces it", async () => {
    // A start longer than the page's whole deadline: the page still meets its own.
    const slow = await openRenderer({
      allowOrigins: [origin],
      limitMs: 3_000,
      launch: async (launchOptions) => {
        await new Promise((done) => setTimeout(done, 3_500));
        return chromium.launch(launchOptions);
      },
    });
    try {
      expect((await slow.render(`${origin}/page`)).status).toBe(200);
      await slow.close();
      expect((await slow.render(`${origin}/page`)).status).toBe(200);
      expect([slow.launches(), slow.warmups()]).toEqual([2, 2]);
    } finally {
      await slow.close();
    }
  }, 40_000);

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

  it("reads every page through methods the page cannot replace, its prototypes and globals included", async () => {
    // Its text, its form, and the wall drawn over it are all read, whatever the page did to the built-ins.
    const shot = await renderer.render(`${origin}/masked-proto`);
    expect(shot.text).toContain("Welcome to the example service");
    expect(shot.text).not.toContain("unseen");
    expect(shot.has_login_form).toBe(true);
    expect(shot.overlays).toContain("Are you a human?");
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
    imageCover: false,
    imageText: "",
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

  it("never excludes a page for three failed starts in a row, and stores it once the browser starts", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    for (let i = 0; i < 3; i++) {
      const broken = await openRenderer({
        launch: async () => {
          throw new Error("no browser");
        },
      });
      expect(await runBatch({ list: list(["/page"]), store, journal, render: broken.render })).toMatchObject({
        retry: 1,
        excluded: 0,
      });
      await broken.close();
    }
    expect(await runBatch({ list: list(["/page"]), store, journal, render: renderer.render })).toMatchObject({
      stored: 1,
    });
    expect(readJournal(journal).some((e) => e.event === "excluded")).toBe(false);
  });

  it("retries a page whose browser could not start, never excluding it for the browser's fault", async () => {
    const broken = await openRenderer({
      launch: async () =>
        ({
          newContext: async () => {
            throw new Error("no context");
          },
          close: async () => undefined,
          on: () => undefined,
          isConnected: () => true,
        }) as never,
    });
    try {
      const store = openStore(join(dir, "store"));
      const journal = join(dir, "progress.jsonl");
      const result = await runBatch({ list: list(["/page"]), store, journal, render: broken.render });
      expect(result).toMatchObject({ retry: 1, excluded: 0, stored: 0 });
      expect(readJournal(journal).at(-1)?.reason).toMatch(/browser did not start/);
    } finally {
      await broken.close();
    }
  });

  it("runs as many renders at once as asked, 4 by default, and finishes every URL", async () => {
    const page = await renderer.render(`${origin}/page`);
    for (const width of [undefined, 2]) {
      const store = openStore(join(dir, `store-${width ?? "default"}`));
      const journal = join(dir, `progress-${width ?? "default"}.jsonl`);
      let inFlight = 0;
      let most = 0;
      const paths = Array.from({ length: 10 }, (_, n) => `/n${n}`);
      const result = await runBatch({
        list: list(paths),
        store,
        journal,
        ...(width ? { concurrency: width } : {}),
        render: async (url) => {
          inFlight++;
          most = Math.max(most, inFlight);
          await new Promise((done) => setTimeout(done, 30));
          inFlight--;
          // Each a different page, so none is the same page as another.
          return { ...page, listed: url, text: `${page.text} ${url}` };
        },
      });
      expect(most, String(width)).toBe(width ?? 4);
      expect(result.stored + result.excluded, String(width)).toBe(paths.length);
    }
  });

  it("writes a render receipt: every listed URL's terminal outcome, its runs' concurrency, unfinished ones named", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    // Two runs of this list (a restart), at two widths, and another list's run between them in the same journal.
    await runBatch({ list: list(["/page"]), store, journal, render: renderer.render, concurrency: 2 });
    await runBatch({
      list: { ...list(["/other"]), name: "majestic" },
      store,
      journal,
      render: async () => {
        throw new HttpStatus(404);
      },
    });
    await runBatch({
      list: list(["/missing", "/flaky"]),
      store,
      journal,
      concurrency: 3,
      render: async (url) => {
        throw url.endsWith("/flaky") ? new HttpStatus(503) : new HttpStatus(404);
      },
    });
    const receipt = renderReceipt(list(["/page", "/missing", "/flaky", "/never"]), journal, store);
    expect(receipt).toMatchObject({ urls: 4, stored: 1, excluded: { "HTTP 404": 1 }, concurrency: [2, 3] });
    // A URL at retry, and one no run reached, are unfinished; the other list's URL is not counted.
    expect(receipt.unfinished).toEqual([`${origin}/flaky`, `${origin}/never`]);
    expect(receipt.missing_pages).toEqual([]);
    // Each URL's outcome, the retries it took, and one entry per run of this list (the other list's run between them
    // is no part of either).
    const id = store.manifest()[0]?.id as string;
    expect(receipt.outcomes).toEqual({
      [`${origin}/page`]: { stored: id },
      [`${origin}/missing`]: { excluded: "HTTP 404" },
    });
    expect(receipt.retries).toEqual({ page: 1, browser: 0 });
    expect(receipt.runs.map((run) => run.concurrency)).toEqual([2, 3]);
    expect(receipt.active_seconds).toBe(receipt.runs.reduce((sum, run) => sum + run.seconds, 0));
    // A stored page whose text no longer matches its hash is not whole: missing, not stored.
    writeFileSync(join(dir, "store", "pages", id, "text.txt"), "altered");
    expect(renderReceipt(list(["/page"]), journal, store).missing_pages).toEqual([`${origin}/page`]);
    rmSync(join(dir, "store", "pages", id), { recursive: true });
    // A stored page that has gone from the store is reported.
    expect(renderReceipt(list(["/page"]), journal, store).missing_pages).toEqual([`${origin}/page`]);
  });

  it("judges a stored capture one way for the recheck and the freeze: clear, wall or unassessed", () => {
    const page = (evidence?: Record<string, unknown>) => ({ evidence }) as unknown as StoredPage;
    const full = {
      title: "Bank",
      overlays: "",
      captcha: false,
      consentWall: false,
      challengeCover: false,
      wall: false,
    };
    expect(assessCapture(page(full), "Welcome to the bank")).toBe("clear");
    expect(assessCapture(page({ ...full, consentWall: true }), "Welcome to the bank")).toBe("wall");
    expect(assessCapture(page(), "Are you a human? Press & Hold")).toBe("wall");
    // Stored before its structural readings were kept: no words show a CAPTCHA or an image cover.
    expect(assessCapture(page({ title: "Bank", overlays: "" }), "Welcome to the bank")).toBe("unassessed");
  });

  it("ends a run's time at the next run's start, a recheck's included, not at a later event", () => {
    const journal = join(dir, "progress.jsonl");
    const line = (event: Record<string, unknown>) => `${JSON.stringify(event)}\n`;
    writeFileSync(
      journal,
      [
        line({ url: "", event: "run", list: "benign-sa", concurrency: 2, at: "2026-10-29T08:00:00.000Z" }),
        line({ url: `${origin}/page`, event: "started", at: "2026-10-29T08:00:01.000Z" }),
        line({ url: `${origin}/page`, event: "excluded", reason: "HTTP 404", at: "2026-10-29T08:00:10.000Z" }),
        // Two hours idle, then a recheck that records an outcome for the same URL.
        line({ url: "", event: "run", list: "recheck", at: "2026-10-29T10:00:00.000Z" }),
        line({ url: `${origin}/page`, event: "excluded", reason: "HTTP 404", at: "2026-10-29T10:00:01.000Z" }),
      ].join(""),
    );
    const receipt = renderReceipt(list(["/page"]), journal, openStore(join(dir, "store")));
    expect(receipt.runs).toEqual([
      { started: "2026-10-29T08:00:00.000Z", ended: "2026-10-29T08:00:10.000Z", seconds: 10, concurrency: 2 },
    ]);
    expect(receipt.active_seconds).toBe(10);
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
    expect(readJournal(journal).map((e) => e.event)).toEqual(["run", "started"]);
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

  it("refuses a capture that moved between its readings, never pairing earlier labels with a later picture", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    const result = await runBatch({ list: list(["/title-ticker"]), store, journal, render: renderer.render });
    expect(result).toMatchObject({ stored: 0, excluded: 1 });
    expect(readJournal(journal).at(-1)?.reason).toBe("the page kept changing while it was captured");
  });

  it("refuses a capture whose shown frame could not be read, never reading it as an empty frame", async () => {
    const faulty = await openRenderer({
      allowOrigins: [origin, frameOrigin],
      readFault: (frame) => (frame.main ? null : new Error("Execution context was destroyed")),
    });
    try {
      const store = openStore(join(dir, "store"));
      const journal = join(dir, "progress.jsonl");
      const result = await runBatch({ list: list(["/xframe-login"]), store, journal, render: faulty.render });
      expect(result).toMatchObject({ stored: 0, excluded: 1 });
      expect(readJournal(journal).at(-1)?.reason).toBe(
        "part of the page (a frame or a closed shadow root) could not be read",
      );
    } finally {
      await faulty.close();
    }
  });

  it("stores no bot wall, however it is drawn", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    const walls = [
      "/wall-split",
      "/wall-late",
      "/wall-frame",
      "/wall-shadow",
      "/wall-cover",
      "/wall-panel",
      "/consent-frame",
      "/wall-img",
      "/wall-css",
      "/wall-shadow-text",
      "/wall-pseudo",
      "/wall-pseudo-text",
    ];
    const result = await runBatch({ list: list(walls), store, journal, render: renderer.render, concurrency: 1 });
    expect(result).toMatchObject({ stored: 0, excluded: walls.length });
    const reasons = readJournal(journal)
      .filter((e) => e.event === "excluded")
      .map((e) => e.reason);
    expect(
      reasons.every((r) => /challenge|CAPTCHA|cookie wall/.test(r ?? "")),
      reasons.join("; "),
    ).toBe(true);
    // The same walls, stored directly with the evidence admission read, are each taken out by the audit.
    const audited = openStore(join(dir, "audited"));
    for (const wall of walls) {
      const capture = await renderer.render(`${origin}${wall}`);
      await audited.putPage("benign-test", {
        screenshot: capture.screenshot,
        text: `${capture.text} ${wall}`,
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
        url: `${origin}${wall}`,
        evidence: evidenceOf(capture),
      });
    }
    const audit = recheckStored(audited, join(dir, "audited.jsonl"));
    expect(audit.removed).toHaveLength(walls.length);
  }, 60_000);

  it("pairs no reading with a picture when what admission reads off it changed, digits included", () => {
    const reading = (text: string): Reading => ({
      url: "https://x.example/",
      title: "Shop",
      text,
      has_login_form: false,
      has_payment_form: false,
      walls: { captcha: false, consentWall: false, overlays: "", challengeCover: false, imageCover: false },
      unreadable: 0,
      height: 900,
    });
    // A clock may move; an error page appearing may not.
    expect(readingsAgree(reading(`${words} 10:41`), reading(`${words} 10:42`))).toBe(true);
    expect(readingsAgree(reading(`Error 0 ${words}`), reading(`Error 404 ${words}`))).toBe(false);
    expect(readingsAgree(reading(words), reading("short"))).toBe(false);
  });

  it("reads no wall into a page from a hidden element's pseudo-element", async () => {
    const shot = await renderer.render(`${origin}/wall-pseudo-hidden`);
    expect(shot.overlays).not.toContain("Press & Hold");
  });

  it("reads a picture covering the page by OCR: a wall's words refuse it, an unreadable one leaves it unstored", async () => {
    const walled = await openRenderer({ allowOrigins: [origin], ocr: async () => "Press & Hold to confirm" });
    const blind = await openRenderer({
      allowOrigins: [origin],
      ocr: async () => {
        throw new Error("no OCR engine");
      },
    });
    const hero = await openRenderer({ allowOrigins: [origin], ocr: async () => "Summer collection" });
    try {
      const run = async (render: typeof renderer.render, name: string) => {
        const store = openStore(join(dir, name));
        const journal = join(dir, `${name}.jsonl`);
        const result = await runBatch({ list: list(["/wall-flow-image"]), store, journal, render });
        return { result, reason: readJournal(journal).at(-1)?.reason };
      };
      expect(await run(walled.render, "walled")).toMatchObject({ result: { stored: 0 }, reason: "a challenge page" });
      expect((await run(blind.render, "blind")).reason).toMatch(/picture covering the page could not be read/);
      expect((await run(hero.render, "hero")).result.stored).toBe(1);
    } finally {
      await Promise.all([walled.close(), blind.close(), hero.close()]);
    }
  }, 60_000);

  it("leaves text clipped away out, sees a CAPTCHA checkbox, and passes a hidden closed widget", async () => {
    expect((await renderer.render(`${origin}/clipped-text`)).text).not.toContain("Welcome to the example service");
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    await runBatch({
      list: list(["/captcha-widget", "/closed-hidden"]),
      store,
      journal,
      render: renderer.render,
      concurrency: 1,
    });
    const outcome = (path: string) =>
      readJournal(journal)
        .filter((e) => e.url === `${origin}${path}`)
        .at(-1);
    expect(outcome("/captcha-widget")?.reason).toBe("a CAPTCHA frame");
    expect(outcome("/closed-hidden")?.event).toBe("stored");
  });

  it("calls a browser that died under a page the browser's fault, never the page's", async () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const dying = await openRenderer({
      allowOrigins: [origin],
      launch: async (launchOptions) => {
        browser = await chromium.launch(launchOptions);
        return browser;
      },
    });
    try {
      const rendering = dying.render(`${origin}/slow`);
      setTimeout(() => void browser?.close(), 1_000);
      await expect(rendering).rejects.toBeInstanceOf(BrowserFault);
    } finally {
      await dying.close();
    }
  }, 40_000);

  it("refuses a page with a closed shadow root, whose contents no reader can see", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    const result = await runBatch({ list: list(["/wall-closed"]), store, journal, render: renderer.render });
    expect(result).toMatchObject({ stored: 0, excluded: 1 });
    expect(readJournal(journal).at(-1)?.reason).toMatch(/closed shadow root/);
  });

  it("refuses a capture whose text changed between its readings though its title held", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    const result = await runBatch({ list: list(["/text-swap"]), store, journal, render: renderer.render });
    expect(result).toMatchObject({ stored: 0, excluded: 1 });
    expect(readJournal(journal).at(-1)?.reason).toBe("the page kept changing while it was captured");
  });

  it("counts a frame's fields only where the screenshot shows them, and reads shadow roots", async () => {
    for (const path of ["/frame-clipped", "/frame-overflow", "/form-below", "/shadow-clipped", "/form-covered"])
      expect((await renderer.render(`${origin}${path}`)).has_login_form, path).toBe(false);
    // A frame drawn at half size still shows the field its own coordinates place below the scaled-down box's end.
    expect((await renderer.render(`${origin}/frame-scaled`)).has_login_form).toBe(true);
    const shadow = await renderer.render(`${origin}/shadow-form`);
    expect(shadow.has_login_form).toBe(true);
    expect(shadow.text).toContain("Shadow sign-in words");
  });

  it("finishes a removal whose intent was written before the page went", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    await runBatch({ list: list(["/page"]), store, journal, render: renderer.render });
    const page = store.manifest()[0] as StoredPage;
    writeFileSync(
      `${journal}.removing.json`,
      JSON.stringify({ id: page.id, url: page.url, reason: "a challenge page (found on a recheck)" }),
    );
    recheckStored(store, journal);
    expect(store.manifest()).toHaveLength(0);
    expect(readJournal(journal).filter((e) => e.event === "excluded")).toHaveLength(1);
  });

  it("leaves a legacy page unassessed, and renders it again when asked", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    const shot = await renderer.render(`${origin}/page`);
    const legacy = await store.putPage("benign-test", {
      screenshot: shot.screenshot,
      text: shot.text,
      origin: "benign",
      licence: "test",
      host: null,
      template: null,
      south_africa: false,
      labels: { lure: false, lure_type: "none", has_login_form: true, has_payment_form: false },
      label_source: { lure: "ground-truth", lure_type: "ground-truth", has_login_form: "dom", has_payment_form: "dom" },
      redacted: false,
      url: `${origin}/page`,
    });
    expect(recheckStored(store, journal).unassessed).toEqual([legacy]);
    const again = recheckStored(store, journal, { rerenderLegacy: true });
    expect(again.rerendered).toEqual([legacy]);
    // Each recheck is a run of its own in the journal, so its events never extend a render run's time.
    expect(readJournal(journal).map((e) => e.event)).toEqual(["run", "run", "excluded", "reopened"]);
    // The next run renders it again, now with its evidence.
    const result = await runBatch({ list: list(["/page"]), store, journal, render: renderer.render });
    expect(result.stored).toBe(1);
    expect(store.manifest()[0]?.evidence).toBeDefined();
  });

  it("audits a stored page by its complete evidence, and leaves a legacy or partial record unassessed", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    const shot = await renderer.render(`${origin}/page`);
    const full = { captcha: false, consentWall: false, challengeCover: false, wall: false };
    const put = (text: string, evidence?: Record<string, unknown>) =>
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
        ...(evidence ? { evidence: evidence as never } : {}),
      });
    const overlaid = await put(`${words} one`, { title: "Shop", overlays: "Access denied", ...full });
    const consent = await put(`${words} two`, { title: "Shop", overlays: "", ...full, consentWall: true });
    const clean = await put(`${words} three`, { title: "Shop", overlays: "", ...full });
    const legacyWall = await put(`${words} Press & Hold`);
    const legacy = await put(`${words} four`);
    const partial = await put(`${words} five`, { title: "Shop", overlays: "" });
    const audit = recheckStored(store, journal);
    expect(audit.removed.sort()).toEqual([overlaid, consent, legacyWall].sort());
    expect(audit.unassessed.sort()).toEqual([legacy, partial].sort());
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
