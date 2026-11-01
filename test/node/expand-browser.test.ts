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
  MAX_FOLLOWED,
} from "../../src/checks/expand";
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
const deps: ExpandDeps = { policy };

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    served.push(`${req.headers.host}${path}`);
    const html = (body: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>t</title>${body}`);
    };
    if (path === "/r1") return void res.writeHead(302, { location: "/r2" }).end();
    if (path === "/r2") return void res.writeHead(301, { location: "/land" }).end();
    if (path === "/land") return html("<h1>Landing</h1>");
    if (path === "/toinner") return void res.writeHead(302, { location: `${hostile}/land` }).end();
    if (path === "/draws") return html(`<img src="${hostile}/pixel.png"><h1>Draws</h1>`);
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
