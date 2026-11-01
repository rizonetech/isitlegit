import { env } from "cloudflare:workers";
import type { Browser } from "@cloudflare/puppeteer";
import { describe, expect, it } from "vitest";
import { ruleVerdict } from "../../src/agent/rule-verdict";
import type { BrandTable } from "../../src/checks/brand-schema";
import { type EvidenceDraft, readEvidence, saveEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import type { Store } from "../../src/intake/store";
import { BudgetExceeded } from "../../src/meta/guard";
import type { WalkRecord } from "../../src/walkthrough/driver";
import {
  CACHE_TTL_SECONDS,
  type Cache,
  type Cached,
  recordWalkNotRun,
  type StepDeps,
  walkKey,
  walkthroughStep,
} from "../../src/walkthrough/trigger";
import type { WalkResult } from "../../src/walkthrough/wonder";

// D04 T02 §6 (plan review gaps 2, 3 and 5): the cache holds the walk's record, a hit rebuilds the evidence against
// the receiving case, a walk that cannot run is stated, and a failing cache never prevents the walk. The Wonder loop
// is a stub; the cache is an in-memory stub so expiry and outages are exercised directly.
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };

const TABLE = {
  version: 1,
  updated: "2026-10-26",
  community_labels: [],
  brands: [
    {
      name: "NimbusMail",
      display_names: ["NimbusMail"],
      domains: ["nimbusmail.example"],
      user_content: [],
      sources: [{ label: "test", url: "https://example.com/", read: "2026-10-26" }],
    },
  ],
  excluded: [],
} as unknown as BrandTable;

const draft = (check: string, severity: EvidenceDraft["severity"], detail: EvidenceDraft["detail"]): EvidenceDraft => ({
  check,
  severity,
  summary: `${check} said so`,
  detail,
  artefacts: [],
});
async function newCase(items: EvidenceDraft[]) {
  const made = await createCase(env.DB, { orgId: "org-trigger-cache", channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  if (items.length) await saveEvidence(env.DB, made.value.id, items);
  return made.value.id;
}
const urlFor = () => `https://login-${crypto.randomUUID()}.example/signin`;

const record = (url: string): WalkRecord => ({
  pages: [{ seq: 1, url, screenshotKey: "art/other-case/page/shot.png", began: 1, asksPassword: true, failure: null }],
  submissions: [
    {
      seq: 1,
      fromPage: 1,
      url: "https://collect.example/post",
      domain: "collect.example",
      method: "POST",
      fields: ["username", "password"],
      state: "delivered",
      status: 200,
      deliveredAt: 5,
    },
  ],
  hidden: [],
  omitted: { pages: 0, submissions: 0, hidden: 0 },
});

function stubCache() {
  const entries = new Map<string, Cached>();
  const puts: { key: string; ttl: number }[] = [];
  const cache: Cache = {
    get: async (key) => entries.get(key) ?? null,
    put: async (key, value, ttl) => {
      puts.push({ key, ttl });
      entries.set(key, value);
    },
  };
  return { cache, entries, puts };
}

function deps(cache: Cache, extra: Partial<StepDeps> & { outcome?: WalkResult["outcome"] } = {}) {
  const calls = { launch: 0, walk: 0, closed: 0 };
  const { outcome, ...rest } = extra;
  const d: StepDeps = {
    db: env.DB,
    store,
    cache,
    launch: async () => {
      calls.launch += 1;
      return {
        close: async () => {
          calls.closed += 1;
        },
      } as unknown as Browser;
    },
    walk: async (_browser, options) => {
      calls.walk += 1;
      return { outcome: outcome ?? "finished", steps: 3, ms: 10, record: record(options.startUrl) };
    },
    resolve: async () => ["93.184.215.14"],
    meta: { env: {}, budget: {} as never },
    table: TABLE,
    revision: null,
    walkId: () => "w-cache",
    ...rest,
  };
  return { d, calls };
}

describe("walkthroughStep cache", () => {
  it("hands storage the 24 hour TTL, walks again once the entry is gone, and keys pages apart", async () => {
    const { cache, entries, puts } = stubCache();
    const url = urlFor();
    const first = await newCase([draft("link.credential_form", "high", { page: url })]);
    expect(await walkthroughStep(deps(cache).d, first)).toMatchObject({ outcome: "walked", cached: true });
    expect(puts).toEqual([{ key: await walkKey(url), ttl: CACHE_TTL_SECONDS }]);
    expect(CACHE_TTL_SECONDS).toBe(86_400);
    const second = await newCase([draft("link.credential_form", "high", { page: url })]);
    const reuse = deps(cache);
    expect(await walkthroughStep(reuse.d, second)).toMatchObject({ outcome: "reused" });
    expect(reuse.calls.walk).toBe(0);
    entries.clear();
    const third = await newCase([draft("link.credential_form", "high", { page: url })]);
    const fresh = deps(cache);
    expect(await walkthroughStep(fresh.d, third)).toMatchObject({ outcome: "walked" });
    expect(fresh.calls.walk).toBe(1);
    expect(await walkKey(url)).not.toBe(await walkKey(urlFor()));
  });

  it("rebuilds a hit against the receiving case: its brand, its severity, its evidence id, no artefact", async () => {
    const { cache } = stubCache();
    const url = urlFor();
    const host = new URL(url).hostname;
    const first = await newCase([draft("link.credential_form", "high", { page: url })]);
    await walkthroughStep(deps(cache).d, first);
    const firstTarget = (await readEvidence(env.DB, first)).find((e) => e.check === "walkthrough.credential_target");
    expect(firstTarget).toMatchObject({ severity: "high", detail: { brand: null, brandEvidence: null } });
    const second = await newCase([
      draft("link.credential_form", "high", { page: url }),
      draft("domain.lookalike", "medium", { domain: host, targetKind: "brand", brand: "NimbusMail" }),
    ]);
    const lookalikeId = (await readEvidence(env.DB, second)).find((e) => e.check === "domain.lookalike")?.id;
    expect(await walkthroughStep(deps(cache).d, second)).toMatchObject({ outcome: "reused" });
    const rebuilt = (await readEvidence(env.DB, second)).filter((e) => e.check.startsWith("walkthrough."));
    const target = rebuilt.find((e) => e.check === "walkthrough.credential_target");
    expect(target).toMatchObject({ severity: "critical", detail: { brand: "NimbusMail", brandEvidence: lookalikeId } });
    for (const item of rebuilt) {
      expect(item.artefacts).toEqual([]);
      expect(item.detail.reused).toMatchObject({ at: expect.any(String) });
      expect(JSON.stringify(item)).not.toContain("art/other-case");
    }
  });

  it("states the gap beside what a returned failure captured, and alone when it captured nothing", async () => {
    const failed = deps(stubCache().cache, { outcome: "error" });
    const withPages = await newCase([draft("link.lure_button", "medium", { page: urlFor() })]);
    expect(await walkthroughStep(failed.d, withPages)).toMatchObject({
      outcome: "walked",
      walk: "error",
      cached: false,
    });
    const kept = await readEvidence(env.DB, withPages);
    expect(kept.map((e) => e.check)).toContain("walkthrough.chain");
    const gap = kept.find((e) => e.check === "walkthrough.not_checked");
    expect(gap).toMatchObject({ detail: { reason: "error", checked: false } });
    expect(gap?.summary).toContain("did not finish");
    // The captured target still decides this verdict; the gap decides a case nothing else condemns (below).
    expect(ruleVerdict(kept, { headersAvailable: true })).toMatchObject({ verdict: "suspicious" });
    const spent = deps(stubCache().cache, {
      walk: async () => ({
        outcome: "budget" as const,
        steps: 0,
        ms: 1,
        record: { pages: [], submissions: [], hidden: [], omitted: { pages: 0, submissions: 0, hidden: 0 } },
      }),
    });
    const noPages = await newCase([draft("link.lure_button", "medium", { page: urlFor() })]);
    await walkthroughStep(spent.d, noPages);
    const only = await readEvidence(env.DB, noPages);
    expect(only.filter((e) => e.check.startsWith("walkthrough."))).toHaveLength(1);
    expect(only.find((e) => e.check === "walkthrough.not_checked")?.summary).toContain("could not run");
    expect(ruleVerdict(only, { headersAvailable: true })).toMatchObject({ verdict: "safe", confidence: 0.5 });
  });

  it("reuses a record at the driver's own bounds: 65 hidden spans make no second walk", async () => {
    const { cache } = stubCache();
    const wide = deps(cache, {
      walk: async (_browser, options) => ({
        outcome: "finished" as const,
        steps: 3,
        ms: 10,
        record: {
          pages: [{ seq: 1, url: options.startUrl, screenshotKey: null, began: 1, asksPassword: true, failure: null }],
          submissions: [],
          hidden: Array.from({ length: 65 }, (_, i) => ({
            text: `hidden ${i}`,
            reason: "display-none",
            instruction: false,
            page: 1,
            key: "art/x/hidden.json",
          })),
          omitted: { pages: 0, submissions: 0, hidden: 0 },
        },
      }),
    });
    const url = urlFor();
    const first = await newCase([draft("link.credential_form", "high", { page: url })]);
    expect(await walkthroughStep(wide.d, first)).toMatchObject({ outcome: "walked", cached: true });
    const second = await newCase([draft("link.credential_form", "high", { page: url })]);
    const reuse = deps(cache);
    expect(await walkthroughStep(reuse.d, second)).toMatchObject({ outcome: "reused" });
    expect(reuse.calls.walk).toBe(0);
  });

  it("states the gap for a walk its limits stopped, and does not remember it", async () => {
    const { cache, entries } = stubCache();
    // Stopped on the lure, before any form: pages only, nothing submitted.
    const limited = deps(cache, {
      walk: async (_browser, options) => ({
        outcome: "limit" as const,
        steps: 8,
        ms: 60_000,
        record: {
          pages: [{ seq: 1, url: options.startUrl, screenshotKey: null, began: 1, asksPassword: false, failure: null }],
          submissions: [],
          hidden: [],
          omitted: { pages: 0, submissions: 0, hidden: 0 },
        },
      }),
    });
    const id = await newCase([draft("link.lure_button", "medium", { page: urlFor() })]);
    expect(await walkthroughStep(limited.d, id)).toMatchObject({ outcome: "walked", walk: "limit", cached: false });
    const evidence = await readEvidence(env.DB, id);
    expect(evidence.find((e) => e.check === "walkthrough.not_checked")).toMatchObject({
      detail: { reason: "limit", checked: false },
    });
    expect(ruleVerdict(evidence, { headersAvailable: true })).toMatchObject({ verdict: "safe", confidence: 0.5 });
    expect(entries.size).toBe(0);
  });

  it("walks on when the cache cannot be read or written", async () => {
    const url = urlFor();
    const down: Cache = {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {
        throw new Error("kv down");
      },
    };
    const id = await newCase([draft("link.card_form", "high", { page: url })]);
    const run = deps(down);
    expect(await walkthroughStep(run.d, id)).toMatchObject({ outcome: "walked", cached: true });
    expect(run.calls.walk).toBe(1);
  });

  it("states that the walk did not run, for a budget refusal and for a browser that will not launch", async () => {
    const budget = deps(stubCache().cache, {
      walk: async () => {
        throw new BudgetExceeded("day", "muse-wonder-1.0");
      },
    });
    const budgetCase = await newCase([draft("link.credential_form", "high", { page: urlFor() })]);
    expect(await walkthroughStep(budget.d, budgetCase)).toMatchObject({ outcome: "not-run", reason: "budget" });
    const noted = (await readEvidence(env.DB, budgetCase)).find((e) => e.check === "walkthrough.not_checked");
    expect(noted).toMatchObject({ severity: "info", detail: { reason: "budget", checked: false } });
    // The verdict reads that flag: a case whose only other finding is a medium lure is safe but partial, capped,
    // and cites the walkthrough it could not run (D04 T01 §2's coverage wording, completion review gap 1).
    const lureCase = await newCase([draft("link.lure_button", "medium", { page: urlFor() })]);
    await walkthroughStep(
      deps(stubCache().cache, {
        walk: async () => {
          throw new BudgetExceeded("day", "muse-wonder-1.0");
        },
      }).d,
      lureCase,
    );
    const evidence = await readEvidence(env.DB, lureCase);
    const view = ruleVerdict(evidence, { headersAvailable: true });
    expect(view).toMatchObject({
      verdict: "safe",
      headline: "No clear sign of fraud, but some points are worth a look and some checks could not run",
      confidence: 0.5,
    });
    const missed = evidence.find((e) => e.check === "walkthrough.not_checked");
    expect(view.reasons.some((r) => r.evidenceIds.includes(missed?.id ?? ""))).toBe(true);
    const noBrowser = deps(stubCache().cache, {
      launch: async () => {
        throw new Error("browser unavailable");
      },
    });
    const browserCase = await newCase([draft("link.credential_form", "high", { page: urlFor() })]);
    expect(await walkthroughStep(noBrowser.d, browserCase)).toMatchObject({ outcome: "not-run", reason: "Error" });
    expect((await readEvidence(env.DB, browserCase)).some((e) => e.check === "walkthrough.not_checked")).toBe(true);
    // The Workflow's own failure path writes the same statement, and only for a case with a page to walk.
    const past = await newCase([draft("link.credential_form", "high", { page: urlFor() })]);
    expect(await recordWalkNotRun(env.DB, past, null)).toBe(true);
    expect((await readEvidence(env.DB, past)).find((e) => e.check === "walkthrough.not_checked")).toMatchObject({
      detail: { reason: "error", checked: false },
    });
    const plain = await newCase([draft("auth.spf", "info", {})]);
    expect(await recordWalkNotRun(env.DB, plain, null)).toBe(false);
    // A statement written after a walk captured its findings keeps them, and is written once.
    const walkedCase = await newCase([draft("link.credential_form", "high", { page: urlFor() })]);
    await walkthroughStep(deps(stubCache().cache).d, walkedCase);
    expect(await recordWalkNotRun(env.DB, walkedCase, null)).toBe(true);
    const after = await readEvidence(env.DB, walkedCase);
    expect(after.map((e) => e.check)).toContain("walkthrough.credential_target");
    expect(after.filter((e) => e.check === "walkthrough.not_checked")).toHaveLength(1);
    expect(await recordWalkNotRun(env.DB, walkedCase, null)).toBe(true);
    expect((await readEvidence(env.DB, walkedCase)).filter((e) => e.check === "walkthrough.not_checked")).toHaveLength(1);
  });
});
