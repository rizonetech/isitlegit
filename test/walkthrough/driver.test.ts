import { env } from "cloudflare:workers";
import puppeteer, { type Browser, type Page } from "@cloudflare/puppeteer";
import { afterEach, describe, expect, it } from "vitest";
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
<div style="height:4000px"></div>
<script>window.keys=[];addEventListener("keydown",(e)=>keys.push(e.key));
addEventListener("mousemove",(e)=>{window.mx=e.clientX;window.my=e.clientY});
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
        return html("<p>popup page</p>");
      case "/redirect-inner":
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } });
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

const walkPage = async (b: Browser): Promise<Page> => {
  const pages = await b.pages();
  const page = pages.find((p) => p.url().startsWith("https://fixture.example/"));
  if (!page) throw new Error(`no walk page among ${pages.map((p) => p.url()).join(", ")}`);
  return page;
};
const state = <T>(b: Browser, expression: string) => walkPage(b).then((p) => p.evaluate(expression) as Promise<T>);
// The walk's rows; the refused service worker of the test page adds `popup` rows at its own pace, so they are left out
// unless asked for.
const rows = (caseId: string, withPopups = false) =>
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
    .then((r) => r.results.filter((row) => withPopups || row.kind !== "popup"));
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

    const crossing = await walk({ limits: { steps: 8, ms: 2_500 } });
    const began = Date.now();
    expect(await crossing.driver.execute({ tool: "wait", ms: 3000 })).toMatchObject({
      outcome: "limit",
      reason: "time",
    });
    expect(Date.now() - began).toBeLessThan(3_000);

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
    await driver.execute({ tool: "click", x: 20, y: 370 });
    await driver.execute({ tool: "wait", ms: 800 });
    expect((await walkPage(b)).url()).toBe("https://fixture.example/popup");
    expect((await b.pages()).filter((p) => p.url() !== "about:blank")).toHaveLength(1);
    const popups = (await rows(caseId, true)).filter((r) => r.kind === "popup" && r.action_json.includes("/popup"));
    expect(popups.map((r) => r.outcome)).toEqual(["done"]);
    await driver.close();

    const second = await walk();
    await second.driver.execute({ tool: "click", x: 20, y: 410 });
    await second.driver.execute({ tool: "wait", ms: 800 });
    expect(
      (await rows(second.caseId, true)).some(
        (r) => r.kind === "popup" && r.outcome === "refused" && r.action_json.includes("inner.example"),
      ),
    ).toBe(true);
    expect(second.served.asked.some((u) => u.includes("inner.example"))).toBe(false);
    expect(served.asked.some((u) => u.includes("inner.example"))).toBe(false);
    await second.driver.close();
  });

  it("refuses a start URL the policy refuses, with no navigation", async () => {
    const { driver, caseId, served } = await walk({ startUrl: "http://127.0.0.1/" });
    expect(driver.ended?.outcome).toBe("refused");
    expect(served.asked).toEqual([]);
    expect((await rows(caseId)).map((r) => [r.kind, r.outcome])).toEqual([
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
    const d1 = await walk({ store: brokenDb });
    expect((await d1.driver.execute({ tool: "screenshot" })).outcome).toBe("error");
    expect(d1.browser.connected).toBe(false);

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
