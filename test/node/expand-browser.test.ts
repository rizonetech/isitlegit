import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import puppeteer, { type Browser as PuppeteerBrowser } from "@cloudflare/puppeteer";
import { chromium, type Browser as PlaywrightBrowser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CASE_MS,
  type ExpandDeps,
  expandLink,
  expansionsOf,
  type FollowLink,
  followable,
  isBrowserIconRequest,
  livePolicy,
  MAX_FOLLOWED,
} from "../../src/checks/expand";
import { allowedUrl } from "../../src/walkthrough/url-policy";
import { ALLOWED_URLS, REFUSED_URLS } from "../fixtures/url-policy";
import { chromiumPath } from "./browser";

// Redirect expansion in a real Chromium (D02 T07 §2). The page is driven through @cloudflare/puppeteer exactly as Browser
// Run is; the fixture server is on loopback, which the live URL policy refuses by design (a port, an IP literal), so the
// test's policy allows `127.0.0.1` on the fixture port and nothing else: `localhost` stands for a name the policy
// refuses. Every request not to loopback goes to a proxy nothing listens on.
let server: Server;
let origin = "";
let hostile = "";
let host: PlaywrightBrowser;
let browser: PuppeteerBrowser;
const served: string[] = [];

// The test's policy: the fixture server only.
const policy: ExpandDeps["policy"] = async (raw) => {
  const url = new URL(raw);
  if (url.hostname === "127.0.0.1" && url.port === new URL(origin).port) return { ok: true, url };
  return { ok: false, reason: `${url.hostname} is not the fixture host` };
};
const deps: ExpandDeps = { policy, quietMs: 200, settleMs: 1_000 };

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    served.push(`${req.headers.host}${path}`);
    const html = (body: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>t</title>${body}`);
    };
    if (path === "/policy-reset") return void req.socket.destroy();
    if (path === "/policy-mixed-error")
      return html(`<img src="https://policy-inner.example/image" onerror="location.href='/policy-reset'">`);
    if (path === "/policy-redirect")
      return void res.writeHead(302, { location: "https://policy-inner.example/redirect" }).end();
    if (path === "/policy-subresource") return html('<img src="https://policy-inner.example/image">');
    if (path === "/r1") return void res.writeHead(302, { location: "/r2" }).end();
    if (path === "/r2") return void res.writeHead(301, { location: "/land" }).end();
    if (path === "/land") return html("<h1>Landing</h1>");
    if (path === "/toinner") return void res.writeHead(302, { location: `${hostile}/land` }).end();
    if (path === "/draws") return html(`<img src="${hostile}/pixel.png"><h1>Draws</h1>`);
    if (path === "/refresh") return html('<meta http-equiv="refresh" content="1;url=/land"><h1>Wait</h1>');
    if (path === "/script")
      return html('<h1>Script</h1><script>setTimeout(() => { location.href = "/land"; }, 400);</script>');
    if (path === "/popup")
      return html(
        `<h1>Popup</h1><script>window.open("${hostile}/popup-child"); new Worker(URL.createObjectURL(new Blob(["fetch('${hostile}/worker-child')"])));</script>`,
      );
    if (path === "/long") return void res.writeHead(302, { location: `/land?${"q=x&".repeat(100)}end=1` }).end();
    if (path === "/toslow")
      return html('<h1>Soon</h1><script>setTimeout(() => { location.href = "/stalled"; }, 100);</script>');
    // Never answers at all: the navigation stays in flight.
    if (path === "/stalled") return;
    // Answers with headers and a start of body, then stalls: the document is still arriving.
    if (path === "/halfway") {
      res.writeHead(200, { "content-type": "text/html" });
      return void res.write("<!doctype html><title>half</title>");
    }
    if (path === "/tohalfway")
      return html('<h1>Soon</h1><script>setTimeout(() => { location.href = "/halfway"; }, 100);</script>');
    if (path === "/loops")
      return html('<h1>Loop</h1><script>setTimeout(() => { location.href = "/loops2"; }, 100);</script>');
    if (path === "/loops2")
      return html('<h1>Loop2</h1><script>setTimeout(() => { location.href = "/loops"; }, 100);</script>');
    if (path === "/longlocation") return void res.writeHead(302, { location: `/land?${"q".repeat(3_000)}` }).end();
    // Moves on by itself to an address the policy refuses: the page that stays is not where the link ends.
    if (path === "/tohostile")
      return html(`<h1>Soon</h1><script>setTimeout(() => { location.href = "${hostile}/land"; }, 100);</script>`);
    // More than 20 documents by script, each handing on to the next.
    if (path.startsWith("/hop/")) {
      const n = Number(path.slice(5));
      return html(`<h1>${n}</h1><script>setTimeout(() => { location.href = "/hop/${n + 1}"; }, 20);</script>`);
    }
    if (path === "/ws")
      return html(
        `<h1>Sockets</h1><script>for (const make of [() => new WebSocket("ws://127.0.0.1:${new URL(origin).port}/sock"), () => new EventSource("/sse"), () => new Worker(URL.createObjectURL(new Blob(["new WebSocket('ws://127.0.0.1:${new URL(origin).port}/sock-worker')"])))]) { try { make(); } catch (e) {} }</script><iframe srcdoc="<script>new WebSocket('ws://127.0.0.1:${new URL(origin).port}/sock-frame')</script>"></iframe>`,
      );
    // A page that names an icon: the browser's own request for it is not the page's to report (CI's Chromium asks for /favicon.ico on every page).
    if (path === "/icon") return html('<link rel="icon" href="/favicon.ico"><h1>Icon</h1>');
    if (path === "/pix") return html('<h1>Pixel</h1><img src="/slowpixel.png">');
    if (path === "/slowpixel.png") return void res.writeHead(200, { "content-type": "image/png" }).end();
    if (path === "/toolonglocation") return void res.writeHead(302, { location: `/land?${"q".repeat(9_000)}` }).end();
    if (path === "/attach") {
      res.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="x.txt"' });
      return void res.end("not a page");
    }
    if (path === "/binary") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return void res.end(Buffer.from([0, 1, 2, 3]));
    }
    if (path === "/stall") {
      res.writeHead(200, { "content-type": "text/html" });
      return void res.write("<!doctype html><title>slow</title>");
    }
    res.writeHead(404).end();
  });
  // A WebSocket handshake is an upgrade, never a request the page's fetch interception sees: any that arrives is logged.
  server.on("upgrade", (req, socket) => {
    served.push(`ws:${req.url}`);
    socket.destroy();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  hostile = `http://localhost:${port}`;
  const executablePath = chromiumPath();
  if (!executablePath) throw new Error("no headless Chromium found; set MOCKUP_CHROMIUM");
  const debugging = await new Promise<number>((done) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const free = (probe.address() as AddressInfo).port;
      probe.close(() => done(free));
    });
  });
  host = await chromium.launch({
    executablePath,
    chromiumSandbox: true,
    args: ["--proxy-server=127.0.0.1:9", "--no-first-run", `--remote-debugging-port=${debugging}`],
  });
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugging}` } as never);
}, 60_000);
afterAll(async () => {
  await browser?.disconnect();
  await host?.close();
  await new Promise<void>((done) => server?.close(() => done()));
});

describe("expandLink", () => {
  it("records every hop of a two-redirect chain and its final address", async () => {
    const result = await expandLink(browser, `${origin}/r1`, deps);
    expect(result.outcome).toBe("done");
    expect(
      result.hops.map((h) => [new URL(h.url).pathname, h.status, h.location && new URL(h.location, origin).pathname]),
    ).toEqual([
      ["/r1", 302, "/r2"],
      ["/r2", 301, "/land"],
      ["/land", 200, null],
    ]);
    expect(new URL(result.final ?? "").pathname).toBe("/land");
    expect(result.refused).toEqual([]);
    expect(result.downloads).toEqual([]);
  });

  it("stops a response-triggered download by the browser's own denial and records it", async () => {
    for (const path of ["/attach", "/binary"]) {
      const result = await expandLink(browser, `${origin}${path}`, deps);
      expect(
        result.downloads.map((d) => new URL(d).pathname),
        path,
      ).toEqual([path]);
      // Denied by the browser: nothing completed, so the link is not an error.
      expect([result.outcome, result.reason], path).toEqual(["done", null]);
    }
  });

  it("refuses a redirect to a name the policy refuses, naming the policy's reason", async () => {
    const result = await expandLink(browser, `${origin}/toinner`, deps);
    expect(result.refused.map((r) => r.reason)).toEqual(["localhost is not the fixture host"]);
    expect(served.some((s) => s.startsWith("localhost:"))).toBe(false);
    expect(result.hops.map((h) => new URL(h.url).pathname)).toEqual(["/toinner"]);
  });

  it("refuses a page's own request to a refused address, and the request never leaves the policy check", async () => {
    const before = served.length;
    const result = await expandLink(browser, `${origin}/draws`, deps);
    expect(result.outcome).toBe("done");
    expect(result.refused.map((r) => [new URL(r.url).pathname, r.reason])).toEqual([
      ["/pixel.png", "localhost is not the fixture host"],
    ]);
    expect(served.slice(before).some((s) => s.startsWith("localhost:"))).toBe(false);
  });

  it("follows a page that moves on by itself (a delayed meta refresh, a script) and records the chain as the page's own redirect", async () => {
    const quick = { ...deps, quietMs: 1_500, settleMs: 4_000 };
    for (const path of ["/refresh", "/script"]) {
      const result = await expandLink(browser, `${origin}${path}`, quick);
      expect(result.outcome, path).toBe("done");
      expect(
        result.hops.map((h) => [new URL(h.url).pathname, h.via, h.location && new URL(h.location).pathname]),
        path,
      ).toEqual([
        [path, "page", "/land"],
        ["/land", "server", null],
      ]);
      expect(new URL(result.final ?? "").pathname, path).toBe("/land");
    }
  });

  it("contains a popup and a worker the page makes: neither reaches a refused address", async () => {
    const before = served.length;
    const result = await expandLink(browser, `${origin}/popup`, { ...deps, quietMs: 500, settleMs: 1_500 });
    expect(result.outcome).toBe("done");
    expect(served.slice(before).filter((s) => s.startsWith("localhost:"))).toEqual([]);
    expect(result.refused.length).toBeGreaterThan(0);
  });

  it("keeps a long address whole and reads its host before any cut", async () => {
    const result = await expandLink(browser, `${origin}/long`, deps);
    expect((result.final ?? "").length).toBeGreaterThan(300);
    expect(result.final).toContain("end=1");
    expect(result.finalHost).toBe("127.0.0.1");
    expect(result.hops[0]?.location?.length).toBeGreaterThan(300);
  });

  it("holds the link's whole time to the clock, a slow policy lookup and the clean-up included", async () => {
    const slow: ExpandDeps = {
      policy: async (raw) => {
        await new Promise((done) => setTimeout(done, 4_000));
        return policy(raw);
      },
    };
    const started = Date.now();
    const result = await expandLink(browser, `${origin}/land`, { ...slow, limitMs: 500 });
    expect(result.outcome).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("does not call a page that is still moving on, or still loading its next page, a confirmed end", async () => {
    const quick = { ...deps, quietMs: 300, settleMs: 1_500 };
    for (const path of ["/toslow", "/tohalfway", "/loops"]) {
      const result = await expandLink(browser, `${origin}${path}`, quick);
      expect(result.outcome, path).toBe("timeout");
      expect(result.reason, path).toBe("the page was still moving on when the time was up");
    }
  });

  it("does not call a page whose next navigation was refused or failed a confirmed end, and does not drop hops past the cap", async () => {
    const quick = { ...deps, quietMs: 400, settleMs: 2_500 };
    const refused = await expandLink(browser, `${origin}/tohostile`, quick);
    expect(refused.outcome).toBe("blocked");
    expect(refused.reason).toBe("localhost is not the fixture host");
    const chain = await expandLink(browser, `${origin}/hop/1`, { ...quick, quietMs: 600, settleMs: 6_000 });
    expect(chain.outcome).toBe("error");
    expect(chain.reason).toBe("the chain was longer than 20 hops");
    expect(chain.hops).toHaveLength(20);
  });

  it("keeps a 3,000-character destination whole and calls a destination past the bound an error, never whole", async () => {
    const long = await expandLink(browser, `${origin}/longlocation`, deps);
    expect(long.outcome).toBe("done");
    expect(long.hops[0]?.location?.length).toBeGreaterThan(3_000);
    expect((long.final ?? "").length).toBeGreaterThan(3_000);
    const tooLong = await expandLink(browser, `${origin}/toolonglocation`, deps);
    expect([tooLong.outcome, tooLong.reason]).toEqual(["error", "an address was too long to keep whole"]);
    expect(tooLong.finalHost).toBe("127.0.0.1");
  });

  it("does nothing after its time is up: a page opened late is closed unused, and nothing it asks reaches the network", async () => {
    const real = browser.newPage.bind(browser);
    let late: Awaited<ReturnType<typeof real>> | undefined;
    const slowBrowser = new Proxy(browser, {
      get(target, key) {
        if (key === "newPage")
          return async () => {
            await new Promise((done) => setTimeout(done, 1_200));
            late = await real();
            return late;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const before = served.length;
    const result = await expandLink(slowBrowser, `${origin}/land?late=1`, { ...deps, limitMs: 800 });
    expect(result.outcome).toBe("timeout");
    await new Promise((done) => setTimeout(done, 1_500));
    // The page that opened after the deadline was never navigated and is closed.
    expect(served.slice(before).filter((s) => s.includes("late=1"))).toEqual([]);
    expect(late?.isClosed()).toBe(true);
  });

  it("opens no WebSocket, event stream or worker for a page, from the page, a frame or a worker", async () => {
    const before = served.length;
    const result = await expandLink(browser, `${origin}/ws`, { ...deps, quietMs: 600, settleMs: 2_000 });
    await new Promise((done) => setTimeout(done, 800));
    expect(served.slice(before).filter((s) => s.startsWith("ws:") || s.includes("/sse"))).toEqual([]);
    expect(["done", "blocked"]).toContain(result.outcome);
  });

  it("is not thrown by the browser's other targets: a worker another page makes while a link is followed is no popup of the link's", async () => {
    const context = await browser.createBrowserContext();
    const helper = await context.newPage();
    await helper.goto(`${origin}/land`);
    const following = expandLink(browser, `${origin}/stall?targets=1`, { ...deps, limitMs: 2_500 });
    for (let i = 0; i < 6; i += 1) {
      await helper.evaluate("new Worker(URL.createObjectURL(new Blob(['setTimeout(() => close(), 300)'])))");
      await new Promise((done) => setTimeout(done, 150));
    }
    const result = await following;
    await context.close();
    expect(result.refused.filter((r) => /opened and closed/.test(r.reason))).toEqual([]);
  });

  it("tells the browser's own icon request (type Other, /favicon.ico) from a request the page made", () => {
    expect(isBrowserIconRequest("Other", "http://127.0.0.1:40421/favicon.ico")).toBe(true);
    for (const [type, url] of [
      ["Image", "http://127.0.0.1:1/favicon.ico"],
      ["Other", "http://127.0.0.1:1/beacon"],
      ["Other", "not a url"],
      [undefined, "http://127.0.0.1:1/favicon.ico"],
    ] as const)
      expect(isBrowserIconRequest(type, url), `${type} ${url}`).toBe(false);
  });

  it("makes the browser's own icon request fail quietly: it reaches nothing and is no refusal of the page's", async () => {
    const before = served.length;
    const result = await expandLink(browser, `${origin}/icon`, deps);
    await new Promise((done) => setTimeout(done, 400));
    expect(result.outcome).toBe("done");
    expect(result.refused).toEqual([]);
    expect(served.slice(before).some((s) => s.endsWith("/favicon.ico"))).toBe(false);
  });

  it("fails a request still waiting on its policy check when the link ends, never letting the browser resume it", async () => {
    const slowPixel: ExpandDeps = {
      policy: async (raw) => {
        // The page's own address passes at once; the image's check is slow and would pass.
        if (raw.includes("slowpixel")) await new Promise((done) => setTimeout(done, 2_500));
        return policy(raw);
      },
      quietMs: 100,
      settleMs: 500,
    };
    const before = served.length;
    const result = await expandLink(browser, `${origin}/pix`, slowPixel);
    expect(["done", "timeout"]).toContain(result.outcome);
    await new Promise((done) => setTimeout(done, 3_500));
    expect(served.slice(before).some((s) => s.includes("slowpixel"))).toBe(false);
  });

  it("refuses a start address the policy refuses without opening a page", async () => {
    const result = await expandLink(browser, "http://localhost:1/", deps);
    expect([result.outcome, result.hops, result.final]).toEqual(["blocked", [], null]);
    expect(result.reason).toBe("localhost is not the fixture host");
  });

  it("ends a stalled page at its limit with what it had", async () => {
    const started = Date.now();
    const result = await expandLink(browser, `${origin}/stall`, { ...deps, limitMs: 1_500 });
    expect(result.outcome).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(result.reason).toMatch(/no answer within/);
  });
});

const link = (href: string, kind = "href"): FollowLink => ({ href, kind });

describe("expansionsOf", () => {
  it("follows 5 of 8 addresses, documents before images, counting the rest as skipped", async () => {
    const links = [
      link(`${origin}/land?i=1`, "image"),
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => link(`${origin}/land?n=${n}`)),
    ];
    expect(followable(links).at(-1)).toContain("i=1");
    const result = await expansionsOf(browser, links, deps);
    expect(MAX_FOLLOWED).toBe(5);
    expect(result.items.map((i) => i.link)).toEqual([1, 2, 3, 4, 5].map((n) => `${origin}/land?n=${n}`));
    expect(result.skipped).toEqual([{ count: 3, why: "past-limit" }]);
  });

  it("stops at the case's time, counting the unreached links as skipped for time", async () => {
    let clock = 0;
    const result = await expansionsOf(
      browser,
      [1, 2, 3, 4].map((n) => link(`${origin}/land?t=${n}`)),
      {
        policy,
        // Each read of the clock moves it a third of the case's time: the case runs out before the fourth link.
        now: () => {
          clock += CASE_MS / 3;
          return clock;
        },
      },
    );
    expect(result.items.length).toBeLessThan(4);
    expect(result.skipped.find((s) => s.why === "time")?.count).toBe(4 - result.items.length);
  });

  it("counts the time the case already spent before its first link", async () => {
    const result = await expansionsOf(
      browser,
      [link(`${origin}/land?late=1`), link(`${origin}/land?late=2`)],
      deps,
      Date.now() - CASE_MS - 1,
    );
    expect(result.items).toEqual([]);
    expect(result.skipped).toEqual([{ count: 2, why: "time" }]);
  });

  it("keeps the links of a whole case inside the case's time (the session's own close is followLinks', which needs the Browser Run binding)", async () => {
    const started = Date.now();
    const result = await expansionsOf(browser, [link(`${origin}/stall?c=1`), link(`${origin}/stall?c=2`)], {
      ...deps,
      limitMs: 1_200,
    });
    expect(result.items.map((i) => i.outcome)).toEqual(["timeout", "timeout"]);
    // Two links of 1.2 s each, the clean-up of each link inside it.
    expect(Date.now() - started).toBeLessThan(3_500);
  });

  it("keeps the chains read before a link that failed", async () => {
    const result = await expansionsOf(
      browser,
      [link(`${origin}/r1`), link(`${origin}/land?x=1`), link("http://localhost:1/never")],
      deps,
    );
    expect(result.items.map((i) => i.outcome)).toEqual(["done", "done", "blocked"]);
    expect(result.items[0]?.hops).toHaveLength(3);
  });
});

describe("shared URL policy parity", () => {
  it("refuses every shared URL before the expansion opens a page", async () => {
    const before = served.length;
    const pages = (await browser.pages()).length;
    for (const { url, answers, reason } of REFUSED_URLS) {
      const resolve = async () => answers;
      const expected = await allowedUrl(url, resolve);
      const production = livePolicy(resolve);
      expect(await production(url), url).toEqual(expected);
      expect(expected.ok, url).toBe(false);
      if (expected.ok) throw new Error("refusal fixture was allowed");
      expect(expected.reason, url).toMatch(reason);
      const result = await expandLink(browser, url, { ...deps, policy: production });
      expect([result.outcome, result.hops, result.final], url).toEqual(["blocked", [], null]);
      expect(result.reason, url).toMatch(reason);
    }
    expect(served).toHaveLength(before);
    expect(await browser.pages()).toHaveLength(pages);
  });

  it("agrees on public names, normalization and default ports without navigating", async () => {
    for (const url of ALLOWED_URLS) {
      const names: string[] = [];
      const resolve = async (name: string) => {
        names.push(name);
        return ["1.1.1.1", "2606:4700:4700::1111"];
      };
      const expected = await allowedUrl(url, resolve);
      expect(expected.ok).toBe(true);
      expect(await livePolicy(resolve)(url)).toEqual(expected);
      expect(names).toEqual(["public.example", "public.example"]);
    }
  });

  it("keeps resolution within one expansion policy and refuses fresh private answers", async () => {
    let calls = 0;
    const resolve = async () => {
      calls++;
      return calls === 1 ? ["1.1.1.1"] : ["10.0.0.1"];
    };
    const first = livePolicy(resolve);
    expect((await first("https://cache.example/first")).ok).toBe(true);
    expect((await first("http://cache.example/second")).ok).toBe(true);
    expect(calls).toBe(1);
    expect((await livePolicy(resolve)("https://cache.example/new-case")).ok).toBe(false);
    expect(calls).toBe(2);
  });

  it("does not call an unrelated navigation error a policy refusal", async () => {
    const production = livePolicy(async () => ["10.0.0.1"]);
    const result = await expandLink(browser, `${origin}/policy-mixed-error`, {
      ...deps,
      policy: (raw) => (raw.startsWith(`${origin}/`) ? policy(raw) : production(raw)),
    });
    expect(result.refused.some((item) => item.url === "https://policy-inner.example/image")).toBe(true);
    expect(result.outcome).toBe("error");
    expect(result.reason).not.toContain("non-public");
  });

  it.each(["policy-redirect", "policy-subresource"])(
    "applies the live shared policy to a browser's %s target",
    async (path) => {
      const asked: string[] = [];
      const production = livePolicy(async () => ["10.0.0.1"]);
      const contained: ExpandDeps["policy"] = async (raw) => {
        // Only the local fixture start is exempt; its untrusted target uses the actual shared policy.
        if (raw.startsWith(`${origin}/`)) return policy(raw);
        asked.push(raw);
        return production(raw);
      };
      const result = await expandLink(browser, `${origin}/${path}`, { ...deps, policy: contained });
      expect(asked).toContain(`https://policy-inner.example/${path === "policy-redirect" ? "redirect" : "image"}`);
      expect(result.refused).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reason: "policy-inner.example resolves to a non-public address" }),
        ]),
      );
      expect(result.hops.some((hop) => hop.host === "policy-inner.example")).toBe(false);
      if (path === "policy-redirect") expect(result.outcome).toBe("blocked");
    },
  );
});
