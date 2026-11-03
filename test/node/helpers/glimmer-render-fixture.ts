import { createSocket } from "node:dgram";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll } from "vitest";
import { openRenderer } from "../../../scripts/glimmer/render.ts";

// The local servers, the held frame and the warm renderer the render tests share (D03 T04 §6), registered by
// `useRenderFixture()` in each test file. `fixture` holds what a test sets or resets (hit counters, a held frame, a
// failing endpoint); the servers' origins and the renderer are live bindings.
export const fixture = {
  serverHits: [] as string[],
  stunPackets: 0,
  upgrades: 0,
  failing503: 0,
  // A frame the test holds: its request waits until the test releases it (D00 T01 §14), and says when it has arrived.
  frameHold: undefined as { arrived: () => void; release: Promise<void> } | undefined,
};

export const words = "Welcome to the example service, where customers manage their accounts and orders every day.";
export const pages: Record<string, (res: import("node:http").ServerResponse, origin: string) => void> = {
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
  // §38 replay fidelity: a sign-in form inside a shown frame, a payment form a script builds after load from POST
  // and repeated GET responses, and a picture that carries the page's look.
  "/replay-mix": (res) =>
    html(
      res,
      `<title>Example checkout</title><p>${words}</p><img src="/wall.svg" width=1200 height=900><iframe src="/frame-login" width=400 height=200></iframe><div id=pay></div><script>addEventListener("load", async () => { const a = await (await fetch("/poll")).text(); const b = await (await fetch("/poll")).text(); const c = await (await fetch("/poll", { method: "POST", body: "step=1" })).text(); document.getElementById("pay").innerHTML = '<p>' + a + ' then ' + b + ' (' + c + ')</p><input autocomplete=cc-number name=card>'; })</script>`,
    ),
  "/wall.svg": (res) => {
    res.writeHead(200, { "content-type": "image/svg+xml" });
    res.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><rect width="600" height="900" fill="#000"/><rect x="600" width="600" height="900" fill="#fff"/><rect y="450" width="1200" height="450" fill="#888"/></svg>',
    );
  },
  "/poll": (res) => {
    replayPolls++;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(replayPolls % 2 ? "first answer" : "second answer");
  },
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
  // The text changes on every frame drawn, and the screenshot between the two readings draws one: never on a timer a
  // busy browser may hold back, which let the readings agree on a loaded runner (D00 T01 §14).
  "/text-swap": (res) =>
    html(
      res,
      `<p id=t>My account</p><p>${words}</p><script>let n = 0; requestAnimationFrame(function swap() { t.textContent = 'Account ' + (n++).toString(26).replace(/[0-9]/g, (d) => 'klmnopqrst'[d]); requestAnimationFrame(swap) })</script>`,
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
  "/xframe-held": (res) => html(res, `<p>${words}</p><iframe src="${frameOrigin}/held" width=500 height=400></iframe>`),
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
export const framePages: Record<string, string> = {
  "/inner": `<p>Example Identity</p><iframe src="/nested" width=400 height=300></iframe>`,
  "/nested": `<p>Nested sign-in text for the example service</p><input type=password>`,
};
export function html(res: import("node:http").ServerResponse, body: string) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><body>${body}</body></html>`);
}

export let server: Server;
export let origin: string;
export let renderer: Awaited<ReturnType<typeof openRenderer>>;
// A second local server the renderer is not allowed to reach: a redirect to it must never arrive.
export let secret: Server;
export let secretOrigin: string;
export let secretHits = 0;
export let dripOpen = 0;
export let replayPolls = 0;
export let stunPort = 0;
export let frameServer: Server;
export let stunSocket: ReturnType<typeof createSocket> | undefined;
export let frameOrigin: string;
// Renders the paths four at a time, the batch's own default, each result in the list's order. All at once, a render
// waiting behind the others on a loaded CI runner passes the renderer's 8-second limit (site lane CI, a79e0a1c).
export async function renderAll(paths: readonly string[], size = 4) {
  const results: Awaited<ReturnType<typeof renderer.render>>[] = [];
  for (let start = 0; start < paths.length; start += size)
    results.push(
      ...(await Promise.all(paths.slice(start, start + size).map((path) => renderer.render(`${origin}${path}`)))),
    );
  return results;
}

export function useRenderFixture() {
  beforeAll(async () => {
    const stun = createSocket("udp4");
    stun.on("message", () => {
      fixture.stunPackets++;
    });
    await new Promise<void>((done) => stun.bind(0, "127.0.0.1", done));
    stunPort = stun.address().port;
    stunSocket = stun;
    frameServer = createServer(async (req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (path === "/held" && fixture.frameHold) {
        fixture.frameHold.arrived();
        await fixture.frameHold.release;
        html(res, framePages["/inner"] as string);
        return;
      }
      const body = framePages[path];
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
      fixture.serverHits.push(path);
      if (path === "/flaky" && fixture.failing503-- > 0) {
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
      fixture.upgrades++;
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
}
