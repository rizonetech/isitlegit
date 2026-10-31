import { connect } from "cloudflare:sockets";
import { describe, expect, it } from "vitest";
import { rfc3339 } from "../../src/checks/rdap";
import { readWhois, whoisAnswer, whoisServerFor } from "../../src/checks/whois";

// The live check of D02 T03 §9: workerd's own `connect()` asks ZACR's WHOIS for long-registered `.za` names. It reaches
// the internet, so it runs only when asked: `VITE_LIVE_WHOIS=1 pnpm exec vitest run test/checks/whois-live.test.ts`.
const live = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_LIVE_WHOIS === "1";

describe.skipIf(!live)("ZACR's WHOIS from the Workers runtime", () => {
  it("reads google.co.za's and standardbank.co.za's creation dates, and a name not registered", async () => {
    const ask = async (domain: string) => {
      const server = whoisServerFor(domain) as string;
      const text = await whoisAnswer(domain, server, connect, AbortSignal.timeout(10_000));
      return typeof text === "string" ? readWhois(domain, text, rfc3339, server) : text;
    };
    expect(await ask("google.co.za")).toMatchObject({
      state: "known",
      registered: "2001-06-25T20:37:59.000Z",
      server: "whois://coza-whois.registry.net.za",
    });
    expect(await ask("standardbank.co.za")).toMatchObject({ state: "known", registered: "1996-11-23T22:00:00.000Z" });
    expect(await ask("isitlegit-not-registered-zz9q.co.za")).toEqual({ state: "unknown", reason: "not-registered" });
  }, 40_000);
});
