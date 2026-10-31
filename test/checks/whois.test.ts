import { describe, expect, it } from "vitest";
import { rfc3339 } from "../../src/checks/rdap";
import { MAX_WHOIS_BYTES, readWhois, whoisAnswer, whoisServerFor } from "../../src/checks/whois";
import { GOOGLE_CO_ZA, NOT_REGISTERED, ORG_ZA_NO_DATE } from "../fixtures/whois/answers";
import { fakeConnect } from "../fixtures/whois/socket";

describe("whoisServerFor", () => {
  it("names ZACR's server for a name directly under each zone, and nothing else", () => {
    expect(whoisServerFor("google.co.za")).toBe("coza-whois.registry.net.za");
    expect(whoisServerFor("absa.net.za")).toBe("net-whois.registry.net.za");
    expect(whoisServerFor("wikipedia.org.za")).toBe("org-whois.registry.net.za");
    expect(whoisServerFor("example.web.za")).toBe("web-whois.registry.net.za");
    for (const other of ["co.za", "example.com", "gov.za", "x.ac.za", "a.b.co.za"])
      expect(whoisServerFor(other), other).toBeNull();
  });
});

describe("readWhois", () => {
  const read = (domain: string, text: string) => readWhois(domain, text, rfc3339, "coza-whois.registry.net.za");
  it("reads the recorded answer's creation date", () => {
    expect(
      readWhois("google.co.za", GOOGLE_CO_ZA, rfc3339, "coza-whois.registry.net.za", new Date("2026-10-31T02:00:00Z")),
    ).toEqual({
      state: "known",
      registered: "2001-06-25T20:37:59.000Z",
      server: "whois://coza-whois.registry.net.za",
      retrievedAt: "2026-10-31T02:00:00.000Z",
      excerpt: ["Domain Name: google.co.za", "Creation Date: 2001-06-25T20:37:59Z"],
    });
  });
  it("reads a name not registered, a name without a date, and an answer about another name", () => {
    expect(read("gone.co.za", NOT_REGISTERED)).toEqual({ state: "unknown", reason: "not-registered" });
    expect(read("wikipedia.org.za", ORG_ZA_NO_DATE)).toEqual({ state: "unknown", reason: "no-date" });
    expect(read("goog1e.co.za", GOOGLE_CO_ZA)).toEqual({ state: "unknown", reason: "malformed" });
    expect(read("google.co.za", GOOGLE_CO_ZA.replace(/^Domain Name:.*\n/m, ""))).toEqual({
      state: "unknown",
      reason: "malformed",
    });
    expect(read("google.co.za", GOOGLE_CO_ZA.replace("2001-06-25T20:37:59Z", "25 June 2001"))).toEqual({
      state: "unknown",
      reason: "no-date",
    });
  });
});

describe("whoisAnswer", () => {
  it("sends the name on port 43 and reads the whole answer, closing the socket", async () => {
    const { open, seen } = fakeConnect(GOOGLE_CO_ZA);
    expect(await whoisAnswer("google.co.za", "coza-whois.registry.net.za", open, new AbortController().signal)).toBe(
      GOOGLE_CO_ZA,
    );
    expect(seen).toEqual({ queries: ["google.co.za\r\n"], hosts: ["coza-whois.registry.net.za:43"], closed: 1 });
  });
  it("refuses an oversized answer, and reads a refused connection as no answer", async () => {
    const big = fakeConnect(new Uint8Array(MAX_WHOIS_BYTES + 1).fill(0x41));
    expect(await whoisAnswer("x.co.za", "s", big.open, new AbortController().signal)).toBe("oversized");
    expect(big.seen.closed).toBeGreaterThan(0);
    expect(await whoisAnswer("x.co.za", "s", fakeConnect("refuse").open, new AbortController().signal)).toBeNull();
  });
  it("gives up a slow answer when its signal aborts, closing the socket", async () => {
    const { open, seen } = fakeConnect("hang");
    const budget = new AbortController();
    const pending = whoisAnswer("x.co.za", "s", open, budget.signal);
    setTimeout(() => budget.abort(), 20);
    expect(await pending).toBeNull();
    expect(seen.closed).toBeGreaterThan(0);
  });
  it("contains a failed connection, write or read: no answer, the socket closed, nothing unhandled", async () => {
    for (const mode of ["fail-open", "fail-write", "fail-read"] as const) {
      const { open, seen } = fakeConnect(mode);
      expect(await whoisAnswer("x.co.za", "s", open, new AbortController().signal), mode).toBeNull();
      expect(seen.closed, mode).toBeGreaterThan(0);
    }
  });
});
