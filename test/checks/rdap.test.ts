import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { CaseView } from "../../src/checks/case-view";
import { domainAgeEvidence } from "../../src/checks/domain-age";
import { readEvidence } from "../../src/checks/evidence";
import {
  BOOTSTRAP_URL,
  type DomainAges,
  domainAgesOf,
  LOOKUP_BUDGET_MS,
  MAX_RDAP_BYTES,
  type RdapDeps,
  rdapLookup,
  rfc3339,
  serviceFor,
} from "../../src/checks/rdap";
import { runChecks } from "../../src/checks/runner";
import { createCase } from "../../src/db/cases";
import { parsedKey, putParsed, putRaw, rawKey, type Store } from "../../src/intake/store";
import { checks } from "../../src/pipeline/analysis-workflow";
import BOOTSTRAP from "../fixtures/rdap/dns.json";
import EXAMPLE_COM from "../fixtures/rdap/example-com.json";

// D02 T03 §4: registration dates from RDAP, cached, and the domain.age check over them.
const cache = env.CACHE;
beforeEach(async () => {
  for (const key of (await cache.list({ prefix: "rdap:" })).keys) await cache.delete(key.name);
});

type Answer = { status: number; body: unknown };
function stub(answers: Record<string, Answer>) {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const answer = answers[url] ?? { status: 404, body: { errorCode: 404 } };
    const text = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
    return new Response(text, { status: answer.status, headers: { "content-type": "application/rdap+json" } });
  }) as typeof fetch;
  return { calls, deps: { fetch: fetcher, cache } satisfies RdapDeps };
}
const ok = (body: unknown): Answer => ({ status: 200, body });
const VERISIGN = "https://rdap.verisign.com/com/v1/";
const registered = (date: string) => ({ ...EXAMPLE_COM, events: [{ eventAction: "registration", eventDate: date }] });

describe("rdapLookup", () => {
  it("reads the recorded .com answer's registration date through the bootstrap, then from the cache", async () => {
    const { calls, deps } = stub({
      [BOOTSTRAP_URL]: ok(BOOTSTRAP),
      [`${VERISIGN}domain/example.com`]: ok(EXAMPLE_COM),
    });
    expect(await rdapLookup("example.com", deps)).toEqual({
      state: "known",
      registered: "1995-08-14T04:00:00.000Z",
      server: VERISIGN,
    });
    expect(calls).toHaveLength(2);
    await rdapLookup("example.com", deps);
    expect(calls).toHaveLength(2);
  });

  it("reads a .co.za domain as having no RDAP service, without asking anyone but the bootstrap", async () => {
    const { calls, deps } = stub({ [BOOTSTRAP_URL]: ok(BOOTSTRAP) });
    expect(await rdapLookup("fynbosfreight.co.za", deps)).toEqual({ state: "unknown", reason: "no-service" });
    expect(calls).toEqual([BOOTSTRAP_URL]);
  });

  it("reads a 503, an oversized answer or one with no date as unknown, and caches none of them", async () => {
    const answers: [Answer, string][] = [
      [{ status: 503, body: "busy" }, "unavailable"],
      [ok("x".repeat(MAX_RDAP_BYTES + 1)), "malformed"],
      [ok({ ...EXAMPLE_COM, events: [] }), "no-date"],
    ];
    for (const [answer, reason] of answers) {
      const { calls, deps } = stub({ [BOOTSTRAP_URL]: ok(BOOTSTRAP), [`${VERISIGN}domain/new.com`]: answer });
      expect(await rdapLookup("new.com", deps)).toEqual({ state: "unknown", reason });
      const before = calls.length;
      await rdapLookup("new.com", deps);
      expect(calls.length).toBeGreaterThan(before);
    }
  });

  it("reads malformed JSON, an invalid date or a missing registration event as unknown, never another event's date", async () => {
    const cases: [Answer, string][] = [
      [ok("{not json"), "malformed"],
      [ok({ ...EXAMPLE_COM, events: [{ eventAction: "registration", eventDate: "yesterday" }] }), "no-date"],
      [ok({ ...EXAMPLE_COM, events: [{ eventAction: "last changed", eventDate: "2026-10-01T00:00:00Z" }] }), "no-date"],
    ];
    for (const [answer, reason] of cases) {
      const { deps } = stub({ [BOOTSTRAP_URL]: ok(BOOTSTRAP), [`${VERISIGN}domain/odd.com`]: answer });
      expect(await rdapLookup("odd.com", deps)).toEqual({ state: "unknown", reason });
    }
  });

  it("is unavailable, in bounded time, when the network rejects or a body stalls", async () => {
    const rejecting = { fetch: (async () => Promise.reject(new TypeError("network"))) as typeof fetch, cache: null };
    expect(await rdapLookup("x.com", rejecting)).toEqual({ state: "unknown", reason: "unavailable" });
    const stalled = {
      fetch: (async (input: RequestInfo | URL) =>
        String(input) === BOOTSTRAP_URL
          ? new Response(JSON.stringify(BOOTSTRAP), { status: 200 })
          : new Response(new ReadableStream({ start() {} }), { status: 200 })) as typeof fetch,
      cache: null,
    };
    const started = Date.now();
    expect(await rdapLookup("x.com", stalled)).toEqual({ state: "unknown", reason: "unavailable" });
    expect(Date.now() - started).toBeLessThan(LOOKUP_BUDGET_MS + 1_000);
  });

  it("still answers when KV fails to read or write", async () => {
    const broken = {
      get: async () => {
        throw new Error("KV down");
      },
      put: async () => {
        throw new Error("KV down");
      },
    } as unknown as KVNamespace;
    const { deps } = stub({ [BOOTSTRAP_URL]: ok(BOOTSTRAP), [`${VERISIGN}domain/example.com`]: ok(EXAMPLE_COM) });
    expect(await rdapLookup("example.com", { ...deps, cache: broken })).toMatchObject({ state: "known" });
  });

  it("keeps the bootstrap a day and a date seven days in KV, under exact keys, for a fresh client", async () => {
    const first = stub({ [BOOTSTRAP_URL]: ok(BOOTSTRAP), [`${VERISIGN}domain/example.com`]: ok(EXAMPLE_COM) });
    await rdapLookup("example.com", first.deps);
    const keys = (await cache.list({ prefix: "rdap:" })).keys;
    const now = Date.now() / 1000;
    const expiry = (name: string) => keys.find((k) => k.name === name)?.expiration ?? 0;
    expect(expiry("rdap:bootstrap") - now).toBeGreaterThan(86_400 - 120);
    expect(expiry("rdap:bootstrap") - now).toBeLessThanOrEqual(86_400);
    expect(expiry("rdap:domain:example.com") - now).toBeGreaterThan(7 * 86_400 - 120);
    expect(expiry("rdap:domain:example.com") - now).toBeLessThanOrEqual(7 * 86_400);
    const fresh = stub({});
    expect(await rdapLookup("example.com", fresh.deps)).toMatchObject({ state: "known" });
    expect(fresh.calls).toEqual([]);
  });

  it("keeps a good date when the cache write stalls (completion review)", async () => {
    const stalling = {
      get: async () => null,
      put: () => new Promise(() => {}),
    } as unknown as KVNamespace;
    const { deps } = stub({ [BOOTSTRAP_URL]: ok(BOOTSTRAP), [`${VERISIGN}domain/example.com`]: ok(EXAMPLE_COM) });
    const started = Date.now();
    expect(await rdapLookup("example.com", { ...deps, cache: stalling })).toMatchObject({ state: "known" });
    expect(Date.now() - started).toBeLessThan(LOOKUP_BUDGET_MS);
  });

  it("keeps a date found late in its budget when the cache write is slow too (round 1)", async () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const slowCache = {
      get: async () => null,
      put: () => wait(700),
    } as unknown as KVNamespace;
    const slow = {
      fetch: (async (input: RequestInfo | URL) => {
        if (String(input) === BOOTSTRAP_URL) {
          await wait(1_400);
          return new Response(JSON.stringify(BOOTSTRAP), { status: 200 });
        }
        await wait(3_350);
        return new Response(JSON.stringify(registered("2026-10-25T00:00:00Z")), { status: 200 });
      }) as typeof fetch,
      cache: slowCache,
    };
    expect(await rdapLookup("brand-new-supplier.com", slow)).toMatchObject({ state: "known" });
  });

  it("reads a body cut off by the request's own deadline as unavailable, not malformed (completion review)", async () => {
    const slow = {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === BOOTSTRAP_URL) return new Response(JSON.stringify(BOOTSTRAP), { status: 200 });
        const signal = init?.signal;
        const body = new ReadableStream({
          start(controller) {
            signal?.addEventListener("abort", () => controller.error(signal.reason));
          },
        });
        return new Response(body, { status: 200 });
      }) as typeof fetch,
      cache: null,
    };
    expect(await rdapLookup("x.com", slow)).toEqual({ state: "unknown", reason: "unavailable" });
  });

  it("rejects impossible dates rather than normalising them (completion review)", async () => {
    for (const date of ["2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-01T25:00:00Z", "2026-01-01"]) {
      const { deps } = stub({
        [BOOTSTRAP_URL]: ok(BOOTSTRAP),
        [`${VERISIGN}domain/odd.com`]: ok(registered(date)),
      });
      expect(await rdapLookup("odd.com", deps), date).toEqual({ state: "unknown", reason: "no-date" });
    }
    expect(rfc3339("2024-02-29T12:00:00+02:00")?.toISOString()).toBe("2024-02-29T10:00:00.000Z");
  });

  it("picks the longest bootstrap suffix", () => {
    const services: [string[], string[]][] = [
      [["za"], ["https://za.example/rdap/"]],
      [["co.za"], ["https://coza.example/rdap"]],
    ];
    expect(serviceFor("shop.co.za", services)).toBe("https://coza.example/rdap/");
    expect(serviceFor("shop.za", services)).toBe("https://za.example/rdap/");
    expect(serviceFor("shop.example", services)).toBeNull();
  });
});

const NOW = "2026-10-30T12:00:00.000Z";
const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
function view(domainAges: DomainAges | null): CaseView {
  return {
    tenant: {
      orgId: "org-age",
      channel: "email",
      receivers: [],
      headersAvailable: true,
      trusted: { own: [], suppliers: [] },
    },
    raw: "raw/case-age/message.eml",
    brands: {
      version: 1,
      revision: "t",
      community_labels: [],
      brands: [],
      excluded: [],
    } as unknown as CaseView["brands"],
    senderHistory: null,
    domainAges,
    attachmentHeads: null,
    source: { kind: "message", path: "rfc822", otherOriginals: 0 },
    headers: [],
    text: null,
    html: null,
    attachments: [],
    truncated: [],
    omitted: 0,
  };
}
const known = (domain: string, days: number) => ({
  domain,
  fields: ["From"],
  age: { state: "known" as const, registered: daysAgo(days), server: VERISIGN },
});
const unknown = (domain: string, reason: "no-service" | "unavailable" | "no-date") => ({
  domain,
  fields: ["Reply-To"],
  age: { state: "unknown" as const, reason },
});

describe("domain.age", () => {
  it("is high under 30 days, medium under 90 and info otherwise, with the date and server", () => {
    const items = domainAgeEvidence(
      view({ checkedAt: NOW, ages: [known("a.com", 10), known("b.com", 60), known("c.com", 200)], unread: [] }),
    );
    expect(items.map((i) => [i.detail.domain, i.severity, i.detail.days])).toEqual([
      ["a.com", "high", 10],
      ["b.com", "medium", 60],
      ["c.com", "info", 200],
    ]);
    expect(items[0]).toMatchObject({
      artefacts: ["raw/case-age/message.eml"],
      detail: { registered: daysAgo(10), server: VERISIGN, fields: ["From"] },
    });
  });

  it("is not_checked, through the runner, when every lookup failed: an outage is never a new domain", async () => {
    const v = view({ checkedAt: NOW, ages: [unknown("new.com", "unavailable")], unread: [] });
    const items = (await runChecks(v)).filter((e) => e.check === "domain.age" || e.detail.check === "domain.age");
    expect(items).toMatchObject([
      { check: "not_checked", detail: { check: "domain.age", errorClass: "RdapUnavailable" } },
    ]);
  });

  it("keeps the ages it found and names the domains not checked", () => {
    const items = domainAgeEvidence(
      view({
        checkedAt: NOW,
        ages: [known("a.com", 10), unknown("b.com", "unavailable"), unknown("c.co.za", "no-service")],
        unread: ["d.com"],
      }),
    );
    expect(items.map((i) => i.severity)).toEqual(["high", "info"]);
    expect(items[1]?.detail).toMatchObject({
      checked: false,
      unchecked: [
        { domain: "b.com", reason: "unavailable" },
        { domain: "c.co.za", reason: "no-service" },
      ],
      unreadCount: 1,
    });
  });

  it("gives each domain its own reason in a mixed summary (completion review)", () => {
    const items = domainAgeEvidence(
      view({ checkedAt: NOW, ages: [unknown("a.co.za", "no-service"), unknown("b.com", "unavailable")], unread: [] }),
    );
    expect(items[0]?.summary).toContain("a.co.za (no registration service (RDAP) answers for this ending)");
    expect(items[0]?.summary).toContain("b.com (the registration service did not answer)");
  });

  it("says a .za domain's age was not checked rather than failing the check", () => {
    const items = domainAgeEvidence(view({ checkedAt: NOW, ages: [unknown("x.co.za", "no-service")], unread: [] }));
    expect(items).toMatchObject([{ severity: "info", detail: { checked: false } }]);
  });

  it("says nothing without ages", () => {
    expect(domainAgeEvidence(view(null))).toEqual([]);
    expect(domainAgeEvidence(view({ checkedAt: NOW, ages: [], unread: [] }))).toEqual([]);
  });
});

describe("which domains are looked up (plan review)", () => {
  const withHeaders = (headers: { name: string; value: string }[], headersAvailable = true, own: string[] = []) => {
    const v = view(null);
    return {
      ...v,
      headers,
      tenant: { ...v.tenant, headersAvailable, trusted: { own, suppliers: [] } },
    } as CaseView;
  };

  it("looks nothing up without the original's headers, without a usable domain, or when every domain is trusted", async () => {
    for (const v of [
      withHeaders([{ name: "From", value: "a@new.com" }], false),
      withHeaders([{ name: "From", value: "not an address" }]),
      withHeaders([{ name: "From", value: "a@mine.com" }], true, ["mine.com"]),
    ]) {
      const { calls, deps } = stub({ [BOOTSTRAP_URL]: ok(BOOTSTRAP) });
      const ages = await domainAgesOf(v, deps);
      expect(calls).toEqual([]);
      expect(domainAgeEvidence({ ...v, domainAges: ages })).toEqual([]);
    }
  });

  it("looks up no reserved name (.example, .test, .invalid, .localhost), which cannot be registered", async () => {
    const v = withHeaders([
      { name: "From", value: "a@shop.example" },
      { name: "Reply-To", value: "b@x.test, c@y.invalid, d@z.localhost" },
    ]);
    const { calls, deps } = stub({ [BOOTSTRAP_URL]: ok(BOOTSTRAP) });
    expect(await domainAgesOf(v, deps)).toMatchObject({ ages: [], unread: [] });
    expect(calls).toEqual([]);
  });

  it("looks up the From first and at most five, the trusted ones left out before the cap", async () => {
    const replyTo = ["a@mine.com", ...Array.from({ length: 7 }, (_, i) => `r@d${i}.com`)].join(", ");
    const v = withHeaders(
      [
        { name: "Reply-To", value: replyTo },
        { name: "From", value: "f@from.com" },
      ],
      true,
      ["mine.com"],
    );
    const { calls, deps } = stub({ [BOOTSTRAP_URL]: ok(BOOTSTRAP) });
    const ages = await domainAgesOf(v, deps);
    expect(ages.ages.map((a) => a.domain)).toEqual(["from.com", "d0.com", "d1.com", "d2.com", "d3.com"]);
    expect(ages.unread).toEqual(["d4.com", "d5.com", "d6.com"]);
    expect(calls.filter((c) => c !== BOOTSTRAP_URL)).toHaveLength(5);
  });

  it("recomputes the band from a cached date as days pass", async () => {
    const v = withHeaders([{ name: "From", value: "a@young.com" }]);
    const registeredAt = Date.parse("2026-10-01T00:00:00Z");
    const { deps } = stub({
      [BOOTSTRAP_URL]: ok(BOOTSTRAP),
      [`${VERISIGN}domain/young.com`]: ok(registered(new Date(registeredAt).toISOString())),
    });
    const at = (days: number) => new Date(registeredAt + days * 86_400_000);
    const band = async (days: number) =>
      domainAgeEvidence({ ...v, domainAges: await domainAgesOf(v, deps, at(days)) })[0]?.severity;
    expect(await band(29)).toBe("high");
    expect(await band(30)).toBe("medium");
    expect(await band(89)).toBe("medium");
    expect(await band(90)).toBe("info");
  });

  it("names at most ten domains not checked, with exact counts, keeping the ages found", () => {
    const items = domainAgeEvidence(
      view({
        checkedAt: NOW,
        ages: [known("a.com", 10), unknown("b.co.za", "no-service")],
        unread: Array.from({ length: 4000 }, (_, i) => `d${i}.example`),
      }),
    );
    expect(items[0]).toMatchObject({ severity: "high" });
    expect(items[1]?.detail).toMatchObject({ uncheckedCount: 1, unreadCount: 4000 });
    expect((items[1]?.detail.unread as string[] | undefined)?.length).toBe(10);
  });
});

describe("domain.age through the checks step", () => {
  it("stores a new domain's age as high, from a stubbed registry", async () => {
    const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
    const made = await createCase(env.DB, { orgId: "org-age-step", channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    await putRaw(store, id, new TextEncoder().encode("From: x@y.example\r\n\r\nPay.\r\n"));
    await putParsed(store, id, {
      headers: [{ name: "From", value: "Accounts <billing@brand-new-supplier.com>" }],
      text: "Pay.",
      html: null,
      attachments: [],
      truncated: [],
      omitted: 0,
      forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
    });
    const { deps } = stub({
      [BOOTSTRAP_URL]: ok(BOOTSTRAP),
      [`${VERISIGN}domain/brand-new-supplier.com`]: ok(registered(new Date(Date.now() - 5 * 86_400_000).toISOString())),
    });
    await checks(
      store,
      id,
      parsedKey(id),
      { orgId: "org-age-step", channel: "email" },
      async () => [],
      undefined,
      deps,
    );
    const items = (await readEvidence(env.DB, id)).filter((e) => e.check === "domain.age");
    expect(items).toMatchObject([
      { severity: "high", artefacts: [rawKey(id)], detail: { domain: "brand-new-supplier.com", days: 5 } },
    ]);
  });

  it("stores the reasons when no age could be read, and not_checked only when no registry answered", async () => {
    const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
    const run = async (from: string, answers: Record<string, Answer>) => {
      const made = await createCase(env.DB, { orgId: "org-age-step", channel: "email", headersAvailable: true });
      if (!made.ok) throw new Error(made.error.message);
      const id = made.value.id;
      await putRaw(store, id, new TextEncoder().encode("From: x@y.example\r\n\r\nPay.\r\n"));
      await putParsed(store, id, {
        headers: [{ name: "From", value: from }],
        text: "Pay.",
        html: null,
        attachments: [],
        truncated: [],
        omitted: 0,
        forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
      });
      const { deps } = stub({ [BOOTSTRAP_URL]: ok(BOOTSTRAP), ...answers });
      await checks(
        store,
        id,
        parsedKey(id),
        { orgId: "org-age-step", channel: "email" },
        async () => [],
        undefined,
        deps,
      );
      return (await readEvidence(env.DB, id)).filter(
        (e) => e.check === "domain.age" || e.detail.check === "domain.age",
      );
    };
    expect(await run("a@local.co.za", {})).toMatchObject([
      {
        check: "domain.age",
        severity: "info",
        detail: { unchecked: [{ domain: "local.co.za", reason: "no-service" }] },
      },
    ]);
    expect(await run("a@odd.com", { [`${VERISIGN}domain/odd.com`]: ok("{bad") })).toMatchObject([
      { check: "domain.age", severity: "info", detail: { unchecked: [{ domain: "odd.com", reason: "malformed" }] } },
    ]);
    expect(await run("a@down.com", { [`${VERISIGN}domain/down.com`]: { status: 503, body: "busy" } })).toMatchObject([
      { check: "not_checked", detail: { check: "domain.age", errorClass: "RdapUnavailable" } },
    ]);
  });
});
