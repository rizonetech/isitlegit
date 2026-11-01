import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { CaseView } from "../../src/checks/case-view";
import type { CfResult } from "../../src/checks/cf-block";
import { cloudflareBlocked } from "../../src/checks/cf-block";
import { type Link, type Links, MAX_LINKS } from "../../src/checks/links";
import { registerCheck } from "../../src/checks/registry";
import { type Reputation, type ReputationDeps, reputationOf } from "../../src/checks/reputation";
import type { WellKnown } from "../../src/checks/top-sites";
import { type WebRiskResult, webRiskSearch } from "../../src/checks/webrisk";
import { createCase } from "../../src/db/cases";
import { parsedKey, putParsed, type Store } from "../../src/intake/store";
import { checks, reputationDeps } from "../../src/pipeline/analysis-workflow";

// D02 T06 §5: the checks step reads each link's and the sender domain's reputation onto the view. A probe check
// captures the view the step actually hands the checks, so the test fails if the filler works but the step never
// attaches its result.
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const ORG = "org-reputation";
const captured: (Reputation | null | undefined)[] = [];
registerCheck({
  name: "probe.reputation",
  needs: [],
  timeoutMs: 1_000,
  run: (view: Readonly<CaseView>) => {
    captured.push(view.reputation);
    return [];
  },
});

const link = (href: string, host: string): Link => ({
  raw: href,
  href,
  host,
  display: host,
  kind: "text",
  part: "summary",
  anchor: null,
});
const linksOf = (items: Link[], more = 0): Links => ({ items, more, unread: [] });

const listed: WebRiskResult = {
  state: "listed",
  threatTypes: ["SOCIAL_ENGINEERING"],
  expiresAt: "2099-01-01T00:00:00.000Z",
  cached: false,
};
const blocked: CfResult = { state: "blocked", cached: false, caveat: "caveat" };
const known: WellKnown = { state: "known", date: "2026-11-01", source: "Majestic Million", generation: "abc123" };

function stubDeps(over: Partial<ReputationDeps> = {}): ReputationDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    webRisk: async (url) => {
      asked.push(`web:${url}`);
      return listed;
    },
    cloudflare: async (domain) => {
      asked.push(`cf:${domain}`);
      return blocked;
    },
    wellKnown: async (host) => {
      asked.push(`top:${host}`);
      return known;
    },
    ...over,
  };
}

describe("reputationOf", () => {
  it("reads a listed link, a blocked domain and a well-known one, with the sender domain beside them", async () => {
    const deps = stubDeps();
    const reputation = await reputationOf(
      linksOf([link("https://evil.example/phish?amount=1", "evil.example")]),
      deps,
      "sender.example",
    );
    expect(reputation?.links).toEqual([{ url: "https://evil.example/phish", webRisk: listed }]);
    expect(reputation?.domains.map((d) => d.domain)).toEqual(["evil.example", "sender.example"]);
    expect(reputation?.domains[0]).toMatchObject({ cloudflare: blocked, wellKnown: known });
    expect(reputation?.notLookedUp).toBe(0);
  });

  it("deduplicates by stripped URL and registrable domain, and counts what it does not look up", async () => {
    const deps = stubDeps();
    const reputation = await reputationOf(
      linksOf(
        [
          link("https://www.evil.example/a?x=1", "www.evil.example"),
          link("https://www.evil.example/a?x=2", "www.evil.example"),
          link("https://evil.example/a", "evil.example"),
          link("mailto:someone@evil.example", "evil.example"),
        ],
        3,
      ),
      deps,
    );
    // The query variants strip to one URL; the www and bare hosts stay two URLs but one registrable domain; the
    // mailto link does not strip and the 3 past MAX_LINKS count.
    expect(reputation?.links).toEqual([
      { url: "https://www.evil.example/a", webRisk: listed },
      { url: "https://evil.example/a", webRisk: listed },
    ]);
    expect(reputation?.domains.map((d) => d.domain)).toEqual(["evil.example"]);
    expect(reputation?.notLookedUp).toBe(4);
    expect(deps.asked.filter((a) => a.startsWith("web:"))).toHaveLength(2);
  });

  it("counts the links past MAX_LINKS and asks nothing for an empty case", async () => {
    const deps = stubDeps();
    const many = Array.from({ length: MAX_LINKS }, (_, i) => link(`https://d${i}.example/x`, `d${i}.example`));
    const reputation = await reputationOf(linksOf(many, 7), deps);
    expect(reputation?.links).toHaveLength(MAX_LINKS);
    expect(reputation?.notLookedUp).toBe(7);
    expect(await reputationOf(null, deps)).toBeNull();
    expect(await reputationOf(linksOf([]), deps)).toBeNull();
  });

  it("reads capped and no-key answers as themselves, and the well-known states beside them", async () => {
    const reputation = await reputationOf(
      linksOf([link("https://evil.example/a", "evil.example")]),
      stubDeps({
        webRisk: async () => ({ state: "capped", scope: "organisation" }),
        wellKnown: async () => ({ state: "not_loaded" }),
      }),
    );
    expect(reputation?.links[0]?.webRisk).toEqual({ state: "capped", scope: "organisation" });
    expect(reputation?.domains[0]?.wellKnown).toEqual({ state: "not_loaded" });
    const noKey = await reputationOf(
      linksOf([link("https://evil.example/a", "evil.example")]),
      stubDeps({
        webRisk: async () => ({ state: "not_checked", reason: "no_key" }),
        wellKnown: async () => ({ state: "not_checked", reason: "unavailable" }),
      }),
    );
    expect(noKey?.links[0]?.webRisk).toEqual({ state: "not_checked", reason: "no_key" });
    expect(noKey?.domains[0]?.wellKnown).toEqual({ state: "not_checked", reason: "unavailable" });
  });

  it("reads an outage as not checked, never as not listed, clear or unknown", async () => {
    const reputation = await reputationOf(
      linksOf([link("https://evil.example/a", "evil.example")]),
      stubDeps({
        webRisk: async () => ({ state: "not_checked", reason: "unavailable" }),
        cloudflare: async () => ({ state: "not_checked", reason: "unavailable" }),
      }),
    );
    expect(reputation?.links[0]?.webRisk.state).toBe("not_checked");
    expect(reputation?.domains[0]?.cloudflare.state).toBe("not_checked");
  });

  it("leaves a stalled provider not checked within the budget while a fast one answers", async () => {
    const reputation = await reputationOf(
      linksOf([link("https://evil.example/a", "evil.example")]),
      stubDeps({
        budgetMs: 20,
        webRisk: () => new Promise<WebRiskResult>(() => {}),
        cloudflare: async () => blocked,
      }),
    );
    expect(reputation?.links[0]?.webRisk).toEqual({ state: "not_checked", reason: "timeout" });
    expect(reputation?.domains[0]?.cloudflare).toEqual(blocked);
  });

  it("never converts a provider's refusal: an audit-write failure fails the filler", async () => {
    await expect(
      reputationOf(
        linksOf([link("https://evil.example/a", "evil.example")]),
        stubDeps({
          webRisk: async () => {
            throw new Error("recording reputation: database");
          },
        }),
      ),
    ).rejects.toThrow("recording reputation: database");
  });
});

async function caseWith(text: string, from = "billing@sender.example") {
  const made = await createCase(env.DB, { orgId: ORG, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  const id = made.value.id;
  await putParsed(store, id, {
    headers: [{ name: "From", value: from }],
    text,
    html: null,
    attachments: [],
    truncated: [],
    omitted: 0,
    forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
  });
  return id;
}

const runChecks = (id: string, reputation: ReputationDeps | null) =>
  checks(
    store,
    id,
    parsedKey(id),
    { orgId: ORG, channel: "email" },
    async () => [],
    undefined,
    null,
    null,
    null,
    undefined,
    null,
    reputation,
  );

describe("the checks step's reputation", () => {
  it("hands the checks a listed link, a blocked domain and a well-known one", async () => {
    captured.length = 0;
    const id = await caseWith("Pay here: https://evil.example/phish?amount=1 and https://www.microsoft.com/");
    await runChecks(id, stubDeps());
    const reputation = captured.at(-1);
    expect(reputation?.links).toContainEqual({ url: "https://evil.example/phish", webRisk: listed });
    expect(reputation?.domains).toContainEqual(
      expect.objectContaining({ domain: "evil.example", cloudflare: blocked, wellKnown: known }),
    );
    expect(reputation?.domains.map((d) => d.domain)).toContain("sender.example");
    expect(reputation?.domains.map((d) => d.domain)).toContain("microsoft.com");
  });

  it("finishes with not-checked answers when a provider stalls, never hanging or guessing", async () => {
    captured.length = 0;
    const id = await caseWith("Pay here: https://evil.example/phish");
    await runChecks(id, stubDeps({ budgetMs: 20, webRisk: () => new Promise<WebRiskResult>(() => {}) }));
    expect(captured.at(-1)?.links[0]?.webRisk).toEqual({ state: "not_checked", reason: "timeout" });
  });

  it("makes no second provider call on a replay, and asks again after an outage", async () => {
    const id = await caseWith("Pay here: https://evil.example/phish");
    let calls = 0;
    let down = false;
    const fetchStub = async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls++;
      if (down) return new Response("down", { status: 503 });
      if (url.startsWith("https://webrisk.googleapis.com"))
        return Response.json({
          threat: { threatTypes: ["SOCIAL_ENGINEERING"], expireTime: "2099-01-01T00:00:00.000Z" },
        });
      return Response.json({ Status: 0, Answer: [{ name: "evil.example", type: 1, TTL: 60, data: "0.0.0.0" }] });
    };
    const real = (caseId: string): ReputationDeps => ({
      webRisk: (url) =>
        webRiskSearch(url, {
          fetch: fetchStub as typeof fetch,
          cache: env.CACHE,
          db: env.DB,
          key: "test-key",
          orgId: ORG,
          caseId,
        }),
      cloudflare: (domain) =>
        cloudflareBlocked(domain, { fetch: fetchStub as typeof fetch, cache: env.CACHE, db: env.DB, caseId }),
      wellKnown: async () => ({ state: "not_loaded" }),
    });
    captured.length = 0;
    await runChecks(id, real(id));
    expect(captured.at(-1)?.links[0]?.webRisk.state).toBe("listed");
    const afterFirst = calls;
    expect(afterFirst).toBeGreaterThan(0);
    // The successful answers are cached: a replay asks no provider again.
    await runChecks(id, real(id));
    expect(calls).toBe(afterFirst);
    // An outage is not cached: the next case's lookup asks again and recovers.
    down = true;
    const id2 = await caseWith("Pay here: https://other.example/phish");
    await runChecks(id2, real(id2));
    expect(calls).toBeGreaterThan(afterFirst);
    expect(captured.at(-1)?.links[0]?.webRisk.state).toBe("not_checked");
    down = false;
    const callsWhenDown = calls;
    const id3 = await caseWith("Pay here: https://other.example/phish");
    await runChecks(id3, real(id3));
    expect(calls).toBeGreaterThan(callsWhenDown);
    expect(captured.at(-1)?.links[0]?.webRisk.state).toBe("listed");
  });
});

describe("reputationDeps, the production wiring", () => {
  it("answers not checked with no fetch when the key is absent, and asks Web Risk when it is set", async () => {
    const id = await caseWith("x");
    const absent = reputationDeps({ CACHE: env.CACHE, DB: env.DB }, id, ORG);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      expect(await absent.webRisk("https://evil.example/phish")).toEqual({ state: "not_checked", reason: "no_key" });
      expect(fetchSpy).not.toHaveBeenCalled();
      const present = reputationDeps({ CACHE: env.CACHE, DB: env.DB, WEB_RISK_API_KEY: "test-key" }, id, ORG);
      fetchSpy.mockImplementation(async () => Response.json({}));
      expect(await present.webRisk("https://clean.example/")).toEqual({ state: "not_listed", cached: false });
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
