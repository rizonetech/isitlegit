// Domain Connect discovery, template support and the signed hand-off (D07 T04 §5), against a stubbed DNS provider:
// discovery alone never offers Connect, only the provider's own answer for IsItLegit's exact template does, and
// the hand-off is signed so a changed claim token fails a provider-side verification.
import { describe, expect, it } from "vitest";
import { buildApplyUrl, type ConnectDiscovery, discoverConnect, templateSupport } from "../../src/auth/domain-connect";

const SETTINGS = {
  providerName: "Registrar Example",
  urlSyncUX: "https://registrar.example/connect/sync",
  urlAsyncUX: "https://registrar.example/connect/async",
};

const route = (table: Record<string, () => Response>) => {
  const calls: string[] = [];
  const fetchImpl = async (input: string) => {
    calls.push(input);
    for (const [prefix, answer] of Object.entries(table)) {
      if (input.startsWith(prefix)) return answer();
    }
    return new Response("not stubbed", { status: 404 });
  };
  return { calls, fetchImpl };
};

const dohTxt = (values: string[] | null) => () =>
  Response.json(values === null ? { Status: 3 } : { Status: 0, Answer: values.map((data) => ({ type: 16, data })) });

const provider = (overrides: Record<string, () => Response> = {}) =>
  route({
    "https://cloudflare-dns.com/dns-query?name=_domainconnect.supported.example": dohTxt([
      '"domainconnect.registrar.example"',
    ]),
    "https://cloudflare-dns.com/dns-query?name=_domainconnect.plain.example": dohTxt(null),
    "https://cloudflare-dns.com/dns-query": dohTxt(null),
    "https://domainconnect.registrar.example/v2/supported.example/settings": () => Response.json(SETTINGS),
    "https://domainconnect.registrar.example/v2/domainTemplates?providerId=isitlegit.co.za&serviceId=verify": () =>
      new Response("{}", { status: 200 }),
    "https://domainconnect.registrar.example/v2/domainTemplates": () => new Response("", { status: 404 }),
    ...overrides,
  });

const supported = async (): Promise<Extract<ConnectDiscovery, { state: "supported" }>> => {
  const { fetchImpl } = provider();
  const found = await discoverConnect("supported.example", { fetchImpl });
  if (found.state !== "supported") throw new Error(`expected supported, got ${found.state}`);
  return found;
};

describe("Domain Connect discovery", () => {
  it("finds the provider and its sync address from the _domainconnect record", async () => {
    const { fetchImpl, calls } = provider();
    const found = await discoverConnect("supported.example", { fetchImpl });
    expect(found).toEqual({
      state: "supported",
      providerName: "Registrar Example",
      apiBase: "https://domainconnect.registrar.example",
      syncUrl: "https://registrar.example/connect/sync",
      asyncUrl: "https://registrar.example/connect/async",
    });
    expect(calls.some((url) => url.includes("_domainconnect.supported.example"))).toBe(true);
  });

  it("reads no record as unsupported, never as an offer", async () => {
    const { fetchImpl } = provider();
    expect(await discoverConnect("plain.example", { fetchImpl })).toEqual({ state: "unsupported" });
  });

  it("reads a failing DNS or provider answer as unavailable", async () => {
    const down = provider({
      "https://cloudflare-dns.com/dns-query?name=_domainconnect.supported.example": () =>
        new Response("", { status: 500 }),
    });
    expect((await discoverConnect("supported.example", { fetchImpl: down.fetchImpl })).state).toBe("unavailable");
    const odd = provider({
      "https://domainconnect.registrar.example/v2/supported.example/settings": () =>
        Response.json({ providerName: "Half a settings answer" }),
    });
    expect((await discoverConnect("supported.example", { fetchImpl: odd.fetchImpl })).state).toBe("unavailable");
  });
});

describe("the provider's answer for IsItLegit's template", () => {
  it("offers Connect only when the provider supports the exact template", async () => {
    const { fetchImpl } = provider();
    const found = await supported();
    expect(await templateSupport(found, "isitlegit.co.za", "verify", { fetchImpl })).toEqual({ state: "yes" });
    expect(await templateSupport(found, "isitlegit.co.za", "other", { fetchImpl })).toEqual({ state: "no" });
  });

  it("reads a provider failure as unavailable, not as a no", async () => {
    const { fetchImpl } = provider({
      "https://domainconnect.registrar.example/v2/domainTemplates": () => new Response("", { status: 503 }),
    });
    const found = await supported();
    // The settings are stubbed per provider; the template endpoint fails instead.
    const broken = provider({
      "https://domainconnect.registrar.example/v2/domainTemplates?providerId=isitlegit.co.za&serviceId=verify": () =>
        new Response("", { status: 503 }),
    });
    expect((await templateSupport(found, "isitlegit.co.za", "verify", { fetchImpl: broken.fetchImpl })).state).toBe(
      "unavailable",
    );
    void fetchImpl;
  });
});

describe("the signed hand-off", () => {
  const keyPair = async () =>
    crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    ) as Promise<CryptoKeyPair>;

  it("builds the apply URL a provider accepts, carrying the claim value whole", async () => {
    const pair = await keyPair();
    const found = await supported();
    const url = new URL(
      await buildApplyUrl({
        discovery: found,
        providerId: "isitlegit.co.za",
        serviceId: "verify",
        domain: "supported.example",
        txtValue: "isitlegit-verify=TOKEN123",
        redirectUri: "https://app.isitlegit.co.za/settings/domains/supported.example?connect=return",
        privateKey: pair.privateKey,
        keyHost: "_domainconnect.isitlegit.co.za",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://registrar.example/connect/sync/v2/domainTemplates/providers/isitlegit.co.za/services/verify/apply",
    );
    expect(url.searchParams.get("domain")).toBe("supported.example");
    expect(url.searchParams.get("txtValue")).toBe("isitlegit-verify=TOKEN123");
    expect(url.searchParams.get("key")).toBe("_domainconnect.isitlegit.co.za");
    // The provider verifies the query ahead of `sig` with the published key.
    const raw = url.search.slice(1);
    const signedPart = raw.slice(0, raw.indexOf("&sig="));
    const sig = url.searchParams.get("sig") ?? "";
    const bytes = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    expect(
      await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, bytes, new TextEncoder().encode(signedPart)),
    ).toBe(true);
  });

  it("refuses the same URL with a changed claim token", async () => {
    const pair = await keyPair();
    const found = await supported();
    const built = await buildApplyUrl({
      discovery: found,
      providerId: "isitlegit.co.za",
      serviceId: "verify",
      domain: "supported.example",
      txtValue: "isitlegit-verify=TOKEN123",
      redirectUri: "https://app.isitlegit.co.za/settings/domains/supported.example?connect=return",
      privateKey: pair.privateKey,
      keyHost: "_domainconnect.isitlegit.co.za",
    });
    const tampered = built.replace("TOKEN123", "FORGED99");
    const url = new URL(tampered);
    const raw = url.search.slice(1);
    const sig = url.searchParams.get("sig") ?? "";
    const bytes = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        pair.publicKey,
        bytes,
        new TextEncoder().encode(raw.slice(0, raw.indexOf("&sig="))),
      ),
    ).toBe(false);
  });
});
