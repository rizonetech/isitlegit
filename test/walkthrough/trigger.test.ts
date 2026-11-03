import { env } from "cloudflare:workers";
import type { Browser } from "@cloudflare/puppeteer";
import { describe, expect, it } from "vitest";
import { bundled } from "../../src/checks/brands";
import { type EvidenceDraft, readEvidence, saveEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import type { Store } from "../../src/intake/store";
import { BudgetExceeded } from "../../src/meta/guard";
import type { WalkRecord } from "../../src/walkthrough/driver";
import {
  CACHE_TTL_SECONDS,
  kvCache,
  type StepDeps,
  TRIGGER_CHECKS,
  walkKey,
  walkTarget,
  walkthroughStep,
} from "../../src/walkthrough/trigger";
import type { WalkResult } from "../../src/walkthrough/wonder";

// D04 T02 §6: when the walkthrough runs, and what it remembers. The Wonder loop is a stub; the cache is the real KV.
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const cache = kvCache(env.CACHE);

const draft = (check: string, severity: EvidenceDraft["severity"], page?: string | number): EvidenceDraft => ({
  check,
  severity,
  summary: `${check} said so`,
  detail: page === undefined ? {} : { page },
  artefacts: [],
});
async function newCase(items: EvidenceDraft[]) {
  const made = await createCase(env.DB, { orgId: "org-trigger", channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  if (items.length) await saveEvidence(env.DB, made.value.id, items);
  return made.value.id;
}
const urlFor = () => `https://phish-${crypto.randomUUID()}.example/signin`;

// A walk that found a credential form posting to another site, as the driver would record it.
const record = (url: string): WalkRecord => ({
  pages: [{ seq: 1, url, screenshotKey: null, began: 1, asksPassword: true, failure: null }],
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
function deps(extra: Partial<StepDeps> & { outcome?: WalkResult["outcome"] } = {}) {
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
    table: bundled,
    revision: null,
    walkId: () => "w-test",
    ...rest,
  };
  return { d, calls };
}

describe("walkTarget", () => {
  it("picks the strongest finding of the three kinds, by its landing page, and nothing else", () => {
    const url = urlFor();
    const ev = (id: string, check: string, severity: "high" | "medium" | "info", page?: string | number) => ({
      id,
      check,
      severity,
      detail: page === undefined ? {} : { page },
    });
    expect(walkTarget([])).toBeNull();
    expect(walkTarget([ev("E1", "link.text_mismatch", "high", url)])).toBeNull();
    expect(walkTarget([ev("E1", "link.lure_button", "medium", url)])).toMatchObject({
      url,
      evidenceId: "E1",
      check: "link.lure_button",
    });
    expect(
      walkTarget([
        ev("E1", "link.lure_button", "medium", "https://a.example/"),
        ev("E2", "link.credential_form", "high", url),
      ]),
    ).toMatchObject({ url, evidenceId: "E2" });
    expect(
      walkTarget([ev("E1", "link.card_form", "high", "javascript:alert(1)"), ev("E2", "link.card_form", "medium", 7)]),
    ).toBeNull();
    expect(walkTarget([ev("E1", "link.credential_form", "high")])).toBeNull();
    expect(TRIGGER_CHECKS).toEqual(["link.credential_form", "link.card_form", "link.lure_button"]);
  });

  it("keys a page by its address without the fragment", async () => {
    expect(await walkKey("https://a.example/x#top")).toBe(await walkKey("https://a.example/x"));
    expect(await walkKey("https://a.example/x")).not.toBe(await walkKey("https://a.example/y"));
    expect(await walkKey("https://a.example/x")).toMatch(/^walk:[0-9a-f]{64}$/);
  });
});

describe("walkthroughStep", () => {
  it("walks a case with a form, records the evidence once and remembers it", async () => {
    const url = urlFor();
    const id = await newCase([draft("link.credential_form", "high", url)]);
    const { d, calls } = deps();
    const result = await walkthroughStep(d, id);
    expect(result).toMatchObject({ outcome: "walked", url, cached: true });
    expect(calls).toEqual({ launch: 1, walk: 1, closed: 1 });
    const checksSeen = (await readEvidence(env.DB, id)).map((e) => e.check);
    expect(checksSeen).toContain("walkthrough.chain");
    expect(checksSeen).toContain("walkthrough.credential_target");
    expect(await cache.get(await walkKey(url))).toMatchObject({ outcome: "finished" });
  });

  it("makes no browser or model call for a case with no form or lure", async () => {
    const id = await newCase([draft("link.text_mismatch", "medium", urlFor()), draft("auth.spf", "info")]);
    const { d, calls } = deps();
    expect(await walkthroughStep(d, id)).toEqual({ outcome: "none" });
    expect(calls).toEqual({ launch: 0, walk: 0, closed: 0 });
    expect((await readEvidence(env.DB, id)).some((e) => e.check.startsWith("walkthrough."))).toBe(false);
  });

  it("reuses a second case's page from the cache with no Wonder call, no artefact and no canary", async () => {
    const url = urlFor();
    const first = await newCase([draft("link.credential_form", "high", url)]);
    await walkthroughStep(deps().d, first);
    const second = await newCase([draft("link.lure_button", "medium", `${url}#again`)]);
    const { d, calls } = deps();
    const result = await walkthroughStep(d, second);
    expect(result).toMatchObject({ outcome: "reused", url: `${url}#again` });
    expect(calls).toEqual({ launch: 0, walk: 0, closed: 0 });
    const reused = (await readEvidence(env.DB, second)).filter((e) => e.check.startsWith("walkthrough."));
    expect(reused.length).toBeGreaterThan(0);
    for (const e of reused) {
      expect(e.artefacts).toEqual([]);
      expect(e.detail.reused).toMatchObject({ at: expect.any(String) });
      expect(JSON.stringify(e)).not.toMatch(/canary/i);
    }
  });

  it("does not remember a walk that failed or was refused, and the case is not failed by it", async () => {
    for (const outcome of ["error", "budget", "refused", "incomplete"] as const) {
      const url = urlFor();
      const id = await newCase([draft("link.card_form", "high", url)]);
      const { d } = deps({ outcome });
      await walkthroughStep(d, id);
      expect(await cache.get(await walkKey(url)), outcome).toBeNull();
    }
    const url = urlFor();
    const id = await newCase([draft("link.credential_form", "high", url)]);
    const throwing = deps({
      walk: async () => {
        throw new BudgetExceeded("day", "muse-wonder-1.0");
      },
    });
    expect(await walkthroughStep(throwing.d, id)).toEqual({ outcome: "not-run", url, reason: "budget" });
    expect(throwing.calls.closed).toBe(1);
    const other = deps({
      walk: async () => {
        throw new TypeError("x");
      },
    });
    expect(
      await walkthroughStep(other.d, await newCase([draft("link.credential_form", "high", urlFor())])),
    ).toMatchObject({ outcome: "not-run", reason: "TypeError" });
  });

  it("ignores a cache entry that is not a walk's, and keeps entries for a day", async () => {
    const url = urlFor();
    await env.CACHE.put(
      await walkKey(url),
      JSON.stringify({
        at: "x",
        outcome: "finished",
        items: [{ check: "auth.spf", summary: "s", severity: "info", detail: {} }],
      }),
    );
    const id = await newCase([draft("link.credential_form", "high", url)]);
    const { d, calls } = deps();
    expect((await walkthroughStep(d, id)).outcome).toBe("walked");
    expect(calls.walk).toBe(1);
    expect(CACHE_TTL_SECONDS).toBe(86_400);
  });
});

describe("the ablated walk (D04 T02 §9)", () => {
  it("stores the ablation marker and starts no browser, model or cache read", async () => {
    const url = urlFor();
    const id = await newCase([draft("link.credential_form", "high", url)]);
    // A populated cache for the same page: an ablated case must not reuse the walk it removes.
    const first = deps();
    await walkthroughStep(first.d, await newCase([draft("link.credential_form", "high", url)]));
    let cacheReads = 0;
    let cacheWrites = 0;
    const counting = {
      get: async (key: string) => {
        cacheReads += 1;
        return cache.get(key);
      },
      put: async (key: string, value: never, ttl: number) => {
        cacheWrites += 1;
        return cache.put(key, value, ttl);
      },
    };
    const flagged = deps({ cache: counting as never, ablateFlag: async () => "no-walkthrough" });
    expect(await walkthroughStep(flagged.d, id)).toEqual({ outcome: "ablated", url, items: 1 });
    expect(flagged.calls).toEqual({ launch: 0, walk: 0, closed: 0 });
    expect(cacheReads).toBe(0);
    expect(cacheWrites).toBe(0);
    const items = (await readEvidence(env.DB, id)).filter((e) => e.check.startsWith("walkthrough."));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      check: "walkthrough.ablated",
      severity: "info",
      detail: { ablated: "no-walkthrough", url },
      artefacts: [],
    });
    expect(items[0]?.summary).toContain("ablated");
    expect(items[0]?.detail).not.toHaveProperty("checked");
    // A retry replaces the marker, never duplicates it.
    await walkthroughStep(flagged.d, id);
    expect((await readEvidence(env.DB, id)).filter((e) => e.check === "walkthrough.ablated")).toHaveLength(1);
  });

  it("reads no flag without a target, and walks as today for any other flag state", async () => {
    let flagReads = 0;
    const reader = (value: "no-walkthrough" | "no-sam" | null) => async () => {
      flagReads += 1;
      return value;
    };
    const none = deps({ ablateFlag: reader("no-walkthrough") });
    expect(await walkthroughStep(none.d, await newCase([]))).toEqual({ outcome: "none" });
    expect(flagReads).toBe(0);
    for (const value of ["no-sam", null] as const) {
      const { d, calls } = deps({ ablateFlag: reader(value) });
      const result = await walkthroughStep(d, await newCase([draft("link.credential_form", "high", urlFor())]));
      expect(result.outcome).toBe("walked");
      expect(calls.launch).toBe(1);
    }
    // No reader at all walks as today.
    const plain = deps();
    expect(
      (await walkthroughStep(plain.d, await newCase([draft("link.credential_form", "high", urlFor())]))).outcome,
    ).toBe("walked");
  });
});
