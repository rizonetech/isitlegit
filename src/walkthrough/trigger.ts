// When the walkthrough runs, and what it remembers (D04 T02 §6; design spec 4.4a). The walkthrough is the expensive step
// (Muse Wonder), so it runs only when the link checks found a page that asks for credentials or a card, or one that is a
// lone prominent button, and at most once per case. The walk's record is cached by the page's address for 24 hours: a
// second case reaching the same page rebuilds the evidence against its own findings and makes no Wonder call. What is
// cached holds no canary value (the driver never stored one) and no artefact key (an artefact belongs to the case that
// made it), so a reuse is the findings alone, marked as reused. A walk that cannot run writes a `not_checked` item, so
// the report never looks complete where the sign-in page was not visited.

import type { BrandTable } from "../checks/brand-schema";
import { addEvidence, type Evidence, type EvidenceDraft } from "../checks/evidence";
import type { Store } from "../intake/store";
import type { MetaContext } from "../meta/client";
import { BudgetExceeded } from "../meta/guard";
import { type Canary, canaryFor } from "./canary";
import type { WalkRecord } from "./driver";
import { impersonatedBrand, recordWalk, type WalkForEvidence, walkthroughEvidence } from "./evidence";
import type { Resolve } from "./url-policy";
import type { WalkResult } from "./wonder";

export const TRIGGER_CHECKS = ["link.credential_form", "link.card_form", "link.lure_button"] as const;
export const CACHE_TTL_SECONDS = 24 * 60 * 60;
const MAX_CACHED_PAGES = 64;
const RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

export type Target = { url: string; evidenceId: string; check: string };

// The page to walk: the strongest finding of the three kinds, its landing address (an http or https URL), or none.
export function walkTarget(evidence: readonly Pick<Evidence, "id" | "check" | "severity" | "detail">[]): Target | null {
  let best: { target: Target; rank: number } | null = null;
  for (const item of evidence) {
    if (!(TRIGGER_CHECKS as readonly string[]).includes(item.check)) continue;
    const page = item.detail.page;
    if (typeof page !== "string" || page.length > 2048) continue;
    let url: URL;
    try {
      url = new URL(page);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const rank = RANK[item.severity] ?? 0;
    if (!best || rank > best.rank) best = { target: { url: url.href, evidenceId: item.id, check: item.check }, rank };
  }
  return best?.target ?? null;
}

// The cache key: the address without its fragment, hashed, so a long or odd address is a fixed-size key.
export async function walkKey(raw: string): Promise<string> {
  const url = new URL(raw);
  url.hash = "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url.href));
  return `walk:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export type Cached = { at: string; outcome: string; record: WalkRecord };
// The record as remembered: no artefact key, so nothing a reuse builds can point at another case's screenshot.
const bareRecord = (record: WalkRecord): WalkRecord => ({
  pages: record.pages.map((p) => ({ ...p, screenshotKey: null })),
  submissions: record.submissions.map((s) => ({ ...s, fields: [...s.fields] })),
  hidden: record.hidden.map((h) => ({ ...h, key: "" })),
  omitted: { ...record.omitted },
});
const isRecord = (value: unknown): value is WalkRecord => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const list = (x: unknown): x is Record<string, unknown>[] =>
    Array.isArray(x) && x.length <= MAX_CACHED_PAGES && x.every((i) => typeof i === "object" && i !== null);
  return (
    list(v.pages) &&
    v.pages.every((p) => typeof p.seq === "number" && typeof p.url === "string") &&
    list(v.submissions) &&
    v.submissions.every(
      (s) =>
        typeof s.url === "string" &&
        Array.isArray(s.fields) &&
        s.fields.every((f: unknown) => typeof f === "string") &&
        (s.state === "blocked" || s.state === "failed" || s.state === "delivered"),
    ) &&
    list(v.hidden) &&
    v.hidden.every((h) => typeof h.text === "string") &&
    typeof v.omitted === "object" &&
    v.omitted !== null
  );
};
const isCached = (value: unknown): value is Cached => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.at === "string" && typeof v.outcome === "string" && isRecord(v.record);
};

export type Cache = {
  get: (key: string) => Promise<unknown>;
  put: (key: string, value: Cached, ttlSeconds: number) => Promise<void>;
};
export const kvCache = (kv: KVNamespace): Cache => ({
  get: async (key) => kv.get(key, "json").catch(() => null),
  put: async (key, value, ttl) => kv.put(key, JSON.stringify(value), { expirationTtl: ttl }),
});

export type StepDeps = {
  db: D1Database;
  store: Store;
  cache: Cache;
  // The browser for one walk; closed by the step.
  launch: () => Promise<import("@cloudflare/puppeteer").Browser>;
  walk: (
    browser: import("@cloudflare/puppeteer").Browser,
    options: Parameters<typeof import("./wonder").walk>[1],
  ) => Promise<WalkResult>;
  fetch?: typeof fetch;
  resolve: Resolve;
  meta: Omit<MetaContext, "owner" | "deadlineMs">;
  table: BrandTable;
  revision: string | null;
  walkId: () => string;
};
export type StepResult =
  | { outcome: "none" }
  | { outcome: "reused"; url: string; items: number }
  | { outcome: "walked"; url: string; walk: string; items: number; cached: boolean }
  | { outcome: "not-run"; url: string; reason: string };

// Only a walk that read the page through to an end its evidence can speak for is worth remembering.
const CACHEABLE = new Set(["finished", "limit"]);

// A walk that did not run, stated on the case: one info item, the reason's class only, so the report shows the gap.
const REASON = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
async function noteNotRun(deps: StepDeps, caseId: string, target: Target, reason: string): Promise<StepResult> {
  const safe = REASON.test(reason) ? reason : "error";
  const item: EvidenceDraft = {
    check: "walkthrough.not_checked",
    severity: "info",
    summary: "The phishing-site walkthrough could not run, so the sign-in page was not visited.",
    detail: { reason: safe, url: target.url, revision: deps.revision },
    artefacts: [],
  };
  await addEvidence(deps.db, caseId, "walkthrough", [item]);
  return { outcome: "not-run", url: target.url, reason: safe };
}

export async function walkthroughStep(deps: StepDeps, caseId: string): Promise<StepResult> {
  const { readEvidence } = await import("../checks/evidence");
  const target = walkTarget(await readEvidence(deps.db, caseId));
  if (!target) return { outcome: "none" };
  const key = await walkKey(target.url);
  const hit = await deps.cache.get(key).catch(() => null);
  if (isCached(hit)) {
    // Rebuilt against this case: its own brand finding and evidence ids, no artefact of the case that walked.
    const walked: WalkForEvidence = { startUrl: target.url, outcome: hit.outcome, record: hit.record };
    const brand = await impersonatedBrand(deps.db, caseId, walked, deps.table);
    const items: EvidenceDraft[] = walkthroughEvidence(walked, brand, deps.revision, deps.table).map((item) => ({
      ...item,
      detail: { ...item.detail, reused: { at: hit.at } },
      artefacts: [],
    }));
    await addEvidence(deps.db, caseId, "walkthrough", items);
    return { outcome: "reused", url: target.url, items: items.length };
  }
  let browser: Awaited<ReturnType<StepDeps["launch"]>> | undefined;
  try {
    const canary = await canaryFor(deps.db, caseId);
    if (!canary.ok) return await noteNotRun(deps, caseId, target, canary.reason);
    const mint: Canary = { username: canary.username, password: canary.password };
    browser = await deps.launch();
    const result = await deps.walk(browser, {
      caseId,
      walkId: deps.walkId(),
      canary: mint,
      startUrl: target.url,
      store: deps.store,
      resolve: deps.resolve,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      meta: deps.meta,
    });
    const walked: WalkForEvidence = { startUrl: target.url, outcome: result.outcome, record: result.record };
    const stored = await recordWalk(deps.db, caseId, walked, { table: deps.table, revision: deps.revision });
    const cached = CACHEABLE.has(result.outcome) && stored.length > 0;
    if (cached)
      await deps.cache
        .put(
          key,
          { at: new Date().toISOString(), outcome: result.outcome, record: bareRecord(result.record) },
          CACHE_TTL_SECONDS,
        )
        .catch(() => undefined);
    return { outcome: "walked", url: target.url, walk: result.outcome, items: stored.length, cached };
  } catch (error) {
    // The walkthrough never fails the case: whatever stops it is stated on the case and is the step's result.
    if (error instanceof BudgetExceeded) return noteNotRun(deps, caseId, target, "budget");
    return noteNotRun(deps, caseId, target, error instanceof Error ? error.name : "error");
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
