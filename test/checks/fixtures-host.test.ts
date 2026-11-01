import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FIXTURES_HOST } from "../../src/fixtures/redirects";
import { verifyFixtures } from "../../src/fixtures/verify";
import worker from "../../src/index";

// The redirect fixtures host (D02 T07 §2), through the Worker's own entry: noindex on every answer, nothing without the
// secret prefix, the chains the link checks are proven against, and the app's own host untouched.
const PREFIX = "fixtures-prefix-0123456789";
const via = (host: string, path: string, prefix: string | undefined = PREFIX, method = "GET") =>
  worker.fetch(
    new Request(`https://${host}${path}`, { method, redirect: "manual" }),
    { ...env, FIXTURES_PREFIX: prefix } as Env,
    createExecutionContext(),
  );
const fixture = (path: string, prefix: string | undefined = PREFIX) => via(FIXTURES_HOST, path, prefix);

describe("the fixtures host", () => {
  it("serves the two-redirect chain to another site and the chain inside the host, noindex on every hop", async () => {
    const hops: [string, number, string | null][] = [];
    let next: string | null = `/${PREFIX}/chain/1`;
    while (next && hops.length < 6) {
      const answer = await fixture(next);
      expect(answer.headers.get("x-robots-tag"), next).toBe("noindex, nofollow");
      hops.push([next, answer.status, answer.headers.get("location")]);
      const location = answer.headers.get("location");
      next = location?.startsWith("/") ? location : null;
    }
    expect(hops).toEqual([
      [`/${PREFIX}/chain/1`, 302, `/${PREFIX}/chain/2`],
      [`/${PREFIX}/chain/2`, 301, "https://example.org/"],
    ]);
    const same = await fixture(`/${PREFIX}/same/1`);
    expect([same.status, same.headers.get("location")]).toEqual([302, `/${PREFIX}/same/2`]);
    const end = await fixture(`/${PREFIX}/same/end`);
    expect(end.status).toBe(200);
    expect(end.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await end.text()).toContain("Test fixture for IsItLegit, not a real service.");
  });

  it("answers 404 without the prefix or with another, and nothing at all while the secret is unset", async () => {
    for (const path of [
      "/",
      "/chain/1",
      `/${PREFIX}x/chain/1`,
      "/wrong-prefix-0123456789/chain/1",
      `/${PREFIX}/nothing`,
    ]) {
      const answer = await fixture(path);
      expect([answer.status, answer.headers.get("x-robots-tag")], path).toEqual([404, "noindex, nofollow"]);
    }
    for (const unset of [undefined, "", "short"]) {
      expect((await fixture(`/${unset ?? ""}/chain/1`, unset)).status, String(unset)).toBe(404);
    }
  });

  it("disallows every crawler in robots.txt, even without the prefix", async () => {
    const answer = await fixture("/robots.txt", undefined);
    expect([answer.status, answer.headers.get("x-robots-tag")]).toEqual([200, "noindex, nofollow"]);
    expect(await answer.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("refuses a method that is not a read, and leaves the app's own host alone", async () => {
    expect((await via(FIXTURES_HOST, `/${PREFIX}/chain/1`, PREFIX, "POST")).status).toBe(405);
    const app = await via("app.isitlegit.co.za", "/health");
    expect(app.status).toBe(200);
    expect(app.headers.get("x-robots-tag")).not.toBe("noindex, nofollow");
    expect((await via("app.isitlegit.co.za", `/${PREFIX}/chain/1`)).headers.get("location")).toBeNull();
  });

  it("passes the deploy script's own verification of a live host, and fails it when a hop loses noindex", async () => {
    const asWorker = ((input: RequestInfo | URL, init?: RequestInit) =>
      worker.fetch(
        new Request(String(input), init),
        { ...env, FIXTURES_PREFIX: PREFIX } as Env,
        createExecutionContext(),
      )) as typeof fetch;
    expect((await verifyFixtures(PREFIX, asWorker)).map((c) => [c.name, c.ok]).filter(([, ok]) => !ok)).toEqual([]);
    const stripped = ((input: RequestInfo | URL, init?: RequestInit) =>
      asWorker(input, init).then((a) => {
        const headers = new Headers(a.headers);
        headers.delete("x-robots-tag");
        return new Response(a.body, { status: a.status, headers });
      })) as typeof fetch;
    expect((await verifyFixtures(PREFIX, stripped)).some((c) => !c.ok)).toBe(true);
    // A prefix the Worker does not hold finds no chain.
    expect((await verifyFixtures("another-prefix-0123456789", asWorker)).filter((c) => !c.ok).length).toBeGreaterThan(
      0,
    );
  });
});
