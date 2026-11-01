import { describe, expect, it } from "vitest";
import { allowedUrl, dohResolve, isPublicAddress, type Resolve } from "../../src/walkthrough/url-policy";

// D04 T02 §3: the walkthrough's URL policy, applied to every request the contained browser makes.

describe("isPublicAddress", () => {
  it("refuses every non-public IPv4 range at both ends", () => {
    for (const ip of [
      "0.0.0.0",
      "0.255.255.255",
      "10.0.0.0",
      "10.255.255.255",
      "100.64.0.0",
      "100.127.255.255",
      "127.0.0.0",
      "127.255.255.255",
      "169.254.0.0",
      "169.254.255.255",
      "172.16.0.0",
      "172.31.255.255",
      "192.0.0.0",
      "192.0.0.255",
      "192.168.0.0",
      "192.168.255.255",
      "198.18.0.0",
      "198.19.255.255",
      "224.0.0.0",
      "255.255.255.255",
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
  });

  it("accepts public IPv4 addresses just outside each range", () => {
    for (const ip of [
      "1.1.1.1",
      "9.255.255.255",
      "11.0.0.0",
      "100.63.255.255",
      "100.128.0.0",
      "172.15.255.255",
      "172.32.0.0",
      "192.0.1.0",
      "192.167.255.255",
      "198.17.255.255",
      "198.20.0.0",
      "223.255.255.255",
    ])
      expect(isPublicAddress(ip), ip).toBe(true);
  });

  it("refuses non-public IPv6, and the mapped and NAT64 forms of non-public IPv4", () => {
    for (const ip of [
      "::",
      "::1",
      "[::1]",
      "fc00::",
      "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "fe80::",
      "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "ff00::",
      "ff02::1",
      "::ffff:10.0.0.1",
      "::ffff:127.0.0.1",
      "0:0:0:0:0:ffff:192.168.1.1",
      "::ffff:a00:1",
      "64:ff9b::10.0.0.1",
      "64:ff9b::a9fe:a9fe",
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
  });

  it("accepts public IPv6, and mapped or NAT64 forms of public IPv4", () => {
    for (const ip of [
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "::ffff:1.1.1.1",
      "64:ff9b::1.1.1.1",
      "fbff::1",
      "fec0::1",
    ])
      expect(isPublicAddress(ip), ip).toBe(true);
  });

  it("refuses what is not an address", () => {
    for (const ip of [
      "",
      "example.com",
      "1.2.3",
      "1.2.3.4.5",
      "256.1.1.1",
      "01.1.1.1",
      "1::2::3",
      "12345::",
      "::ffff:999.1.1.1",
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
  });
});

describe("allowedUrl", () => {
  const dns: Record<string, string[]> = {
    "fixture.example": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
    "inner.example": ["10.0.0.5"],
    "mixed.example": ["93.184.215.14", "::1"],
  };
  const resolve: Resolve = async (name) => dns[name] ?? null;

  it("accepts an http(s) URL on a name resolving to public addresses only", async () => {
    for (const url of [
      "https://fixture.example/login",
      "http://fixture.example/a?b=c#d",
      "https://fixture.example:443/",
    ])
      expect((await allowedUrl(url, resolve)).ok, url).toBe(true);
  });

  it("refuses every other scheme, port, credential, IP literal, local name and inner address", async () => {
    for (const [url, reason] of [
      ["file:///etc/passwd", /scheme file:/],
      ["javascript:alert(1)", /scheme javascript:/],
      ["data:text/html,hi", /scheme data:/],
      ["ftp://fixture.example/", /scheme ftp:/],
      ["blob:https://fixture.example/1", /scheme blob:/],
      ["http://127.0.0.1/", /IP address/],
      ["http://[::ffff:10.0.0.1]/", /IP address/],
      ["http://1.1.1.1/", /IP address/],
      ["http://2130706433/", /IP address/],
      ["https://fixture.example:8443/", /port 8443/],
      ["http://fixture.example:443/", /port 443/],
      ["http://user@fixture.example/", /credentials/],
      ["http://user:pw@fixture.example/", /credentials/],
      ["http://localhost/", /local name/],
      ["http://printer.local/", /local name/],
      ["http://db.internal/", /local name/],
      ["http://router.home.arpa/", /local name/],
      ["http://intranet/", /local name/],
      ["https://inner.example/", /non-public/],
      ["https://mixed.example/", /non-public/],
      ["https://unknown.example/", /does not resolve/],
      ["not a url", /not a URL/],
    ] as const) {
      const verdict = await allowedUrl(url, resolve);
      expect(verdict.ok, url).toBe(false);
      if (!verdict.ok) expect(verdict.reason, url).toMatch(reason);
    }
  });
});

describe("dohResolve", () => {
  const answer = (records: { type: number; data: string }[], status = 0) =>
    new Response(JSON.stringify({ Status: status, Answer: records }), {
      headers: { "content-type": "application/dns-json" },
    });

  it("reads A and AAAA answers and asks once per name", async () => {
    const asked: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      asked.push(`${url.searchParams.get("name")} ${url.searchParams.get("type")}`);
      return url.searchParams.get("type") === "A"
        ? answer([
            { type: 5, data: "alias.example." },
            { type: 1, data: "93.184.215.14" },
          ])
        : answer([{ type: 28, data: "2606:2800::1" }]);
    }) as typeof fetch;
    const resolve = dohResolve(fetcher);
    expect(await resolve("Fixture.Example")).toEqual(["93.184.215.14", "2606:2800::1"]);
    expect(await resolve("fixture.example")).toEqual(["93.184.215.14", "2606:2800::1"]);
    expect(asked.sort()).toEqual(["fixture.example A", "fixture.example AAAA"]);
  });

  it("treats a failed answer, a server failure and a timeout as unresolved", async () => {
    expect(await dohResolve((async () => new Response("no", { status: 502 })) as typeof fetch)("a.example")).toBeNull();
    expect(await dohResolve((async () => answer([], 2)) as typeof fetch)("a.example")).toBeNull();
    const stalls = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("timeout"))),
      )) as typeof fetch;
    const started = Date.now();
    expect(await dohResolve(stalls)("a.example")).toBeNull();
    expect(Date.now() - started).toBeLessThan(4_500);
  });
});
