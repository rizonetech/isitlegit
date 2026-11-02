import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { saveEvidence } from "../../src/checks/evidence";
import type { Reputation } from "../../src/checks/reputation";
import {
  readReputationResults,
  reputationResultStatements,
  reputationRows,
  storeReputationResults,
} from "../../src/checks/reputation-results";
import { createCase } from "../../src/db/cases";
import { parsedKey, putParsed, type Store } from "../../src/intake/store";
import { checks } from "../../src/pipeline/analysis-workflow";

// D02 T06 §9: one stored result per provider per subject, read back through the case-scoped reader.

const NOW = new Date("2026-11-02T20:00:00.000Z");
const reputation: Reputation = {
  links: [
    {
      url: "https://evil.example/phish",
      webRisk: {
        state: "listed",
        threatTypes: ["SOCIAL_ENGINEERING"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        cached: true,
        obtainedAt: "2026-11-01T10:00:00.000Z",
      },
    },
    { url: "https://capped.example/x", webRisk: { state: "capped", scope: "global" } },
    { url: "https://down.example/x", webRisk: { state: "not_checked", reason: "unavailable" } },
  ],
  domains: [
    {
      domain: "evil.example",
      cloudflare: { state: "blocked", cached: false, caveat: "c", obtainedAt: "2026-11-02T09:00:00.000Z" },
      wellKnown: { state: "known", date: "2026-11-01", source: "Majestic Million", generation: "g1" },
    },
    {
      domain: "down.example",
      cloudflare: { state: "not_checked", reason: "timeout" },
      wellKnown: { state: "not_loaded" },
    },
  ],
  notLookedUp: 0,
};

async function newCase(org = "org-rep-results") {
  const made = await createCase(env.DB, { orgId: org, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  return made.value.id;
}

describe("reputationRows", () => {
  it("maps every provider answer to its stored state, time and cache flag", () => {
    expect(reputationRows(reputation, NOW)).toEqual([
      {
        provider: "google-web-risk",
        subject: "https://evil.example/phish",
        state: "listed",
        obtainedAt: "2026-11-01T10:00:00.000Z",
        cached: true,
        note: "SOCIAL_ENGINEERING",
      },
      {
        provider: "google-web-risk",
        subject: "https://capped.example/x",
        state: "unavailable",
        obtainedAt: NOW.toISOString(),
        cached: false,
        note: "capped:global",
      },
      {
        provider: "google-web-risk",
        subject: "https://down.example/x",
        state: "unavailable",
        obtainedAt: NOW.toISOString(),
        cached: false,
        note: "unavailable",
      },
      {
        provider: "cloudflare",
        subject: "evil.example",
        state: "listed",
        obtainedAt: "2026-11-02T09:00:00.000Z",
        cached: false,
        note: null,
      },
      {
        provider: "well-known",
        subject: "evil.example",
        state: "known",
        obtainedAt: NOW.toISOString(),
        cached: false,
        note: null,
      },
      {
        provider: "cloudflare",
        subject: "down.example",
        state: "unavailable",
        obtainedAt: NOW.toISOString(),
        cached: false,
        note: "timeout",
      },
      {
        provider: "well-known",
        subject: "down.example",
        state: "unavailable",
        obtainedAt: NOW.toISOString(),
        cached: false,
        note: null,
      },
    ]);
    expect(reputationRows(null, NOW)).toEqual([]);
  });
});

describe("storeReputationResults and readReputationResults", () => {
  it("stores, replaces per run, clears on empty, and goes with its case", async () => {
    const id = await newCase();
    const other = await newCase();
    await storeReputationResults(env.DB, id, reputation, NOW);
    await storeReputationResults(env.DB, other, reputation, NOW);
    expect(await readReputationResults(env.DB, id)).toEqual(reputationRows(reputation, NOW));

    const smaller: Reputation = { links: [], domains: [reputation.domains[0]!], notLookedUp: 0 };
    await storeReputationResults(env.DB, id, smaller, NOW);
    expect(await readReputationResults(env.DB, id)).toEqual(reputationRows(smaller, NOW));
    expect(await readReputationResults(env.DB, other)).toEqual(reputationRows(reputation, NOW));

    await storeReputationResults(env.DB, id, null, NOW);
    expect(await readReputationResults(env.DB, id)).toEqual([]);

    await storeReputationResults(env.DB, id, reputation, NOW);
    await env.DB.prepare("DELETE FROM cases WHERE id = ?").bind(id).run();
    expect(await readReputationResults(env.DB, id)).toEqual([]);
    expect(await readReputationResults(env.DB, other)).toEqual(reputationRows(reputation, NOW));
  });

  it("keeps a historical run's rows when a later run replaces its own", async () => {
    const id = await newCase();
    await env.DB.prepare("UPDATE cases SET run_id = 'run-old' WHERE id = ?").bind(id).run();
    await storeReputationResults(env.DB, id, reputation, NOW);
    await env.DB.prepare("UPDATE cases SET run_id = 'run-new' WHERE id = ?").bind(id).run();
    await storeReputationResults(env.DB, id, null, NOW);
    expect(await readReputationResults(env.DB, id, "run-old")).toEqual(reputationRows(reputation, NOW));
    expect(await readReputationResults(env.DB, id, "run-new")).toEqual([]);
    expect(await readReputationResults(env.DB, id)).toEqual([]);
  });

  it("persists clear, unknown and not-checked answers without reading an outage as clear", async () => {
    const id = await newCase();
    const other = await newCase();
    const mixed: Reputation = {
      links: [
        {
          url: "https://clean.example/x",
          webRisk: { state: "not_listed", cached: true, obtainedAt: "2026-11-01T09:00:00.000Z" },
        },
      ],
      domains: [
        {
          domain: "clean.example",
          cloudflare: { state: "clear", cached: true, caveat: "c", obtainedAt: "2026-11-01T09:01:00.000Z" },
          wellKnown: {
            state: "unknown",
            date: "2026-11-01",
            source: "Majestic Million",
            generation: "g1",
            obtainedAt: "2026-11-01T09:02:00.000Z",
          },
        },
        {
          domain: "mystery.example",
          cloudflare: { state: "clear", cached: false, caveat: "c", obtainedAt: "2026-11-01T09:03:00.000Z" },
          wellKnown: { state: "not_checked", reason: "unavailable", obtainedAt: "2026-11-01T09:04:00.000Z" },
        },
      ],
      notLookedUp: 0,
    };
    await env.DB.prepare("UPDATE cases SET run_id = 'run-a' WHERE id = ?").bind(id).run();
    await env.DB.prepare("UPDATE cases SET run_id = 'run-a' WHERE id = ?").bind(other).run();
    await storeReputationResults(env.DB, id, mixed, NOW);
    await storeReputationResults(env.DB, other, reputation, NOW);
    expect(await readReputationResults(env.DB, id, "run-a")).toEqual(reputationRows(mixed, NOW));
    // An explicit run read never answers another case's rows for that run.
    expect(await readReputationResults(env.DB, id, "run-other")).toEqual([]);
    const rows = (await readReputationResults(env.DB, id, "run-a")) ?? [];
    expect(rows.find((r) => r.provider === "well-known" && r.subject === "mystery.example")?.state).toBe("unavailable");
    expect(rows.find((r) => r.provider === "google-web-risk")?.state).toBe("clear");
  });

  it("answers null, never a result, when the reader's database fails", async () => {
    const id = await newCase();
    const failing = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") throw new Error("D1 down");
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    expect(await readReputationResults(failing, id)).toBeNull();
  });

  it("commits evidence and results together, or neither (round 1)", async () => {
    const id = await newCase();
    await saveEvidence(
      env.DB,
      id,
      [],
      undefined,
      undefined,
      [],
      null,
      null,
      reputationResultStatements(env.DB, id, reputation, NOW),
    );
    expect(await readReputationResults(env.DB, id)).toEqual(reputationRows(reputation, NOW));
    const clashing: Reputation = {
      links: [reputation.links[0]!, reputation.links[0]!],
      domains: [],
      notLookedUp: 0,
    };
    await expect(
      saveEvidence(
        env.DB,
        id,
        [],
        undefined,
        undefined,
        [],
        null,
        null,
        reputationResultStatements(env.DB, id, clashing, NOW),
      ),
    ).rejects.toThrow();
    expect(await readReputationResults(env.DB, id)).toEqual(reputationRows(reputation, NOW));
  });

  it("leaves the previous set whole when a replacement batch fails", async () => {
    const id = await newCase();
    await storeReputationResults(env.DB, id, reputation, NOW);
    const clashing: Reputation = {
      links: [reputation.links[0]!, reputation.links[0]!],
      domains: [],
      notLookedUp: 0,
    };
    await expect(storeReputationResults(env.DB, id, clashing, NOW)).rejects.toThrow();
    expect(await readReputationResults(env.DB, id)).toEqual(reputationRows(reputation, NOW));
  });
});

describe("the checks step's wiring", () => {
  it("stores each provider's answer beside the evidence (D02 T06 §9)", async () => {
    const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
    const id = await newCase("org-rep-wiring");
    await putParsed(store, id, {
      headers: [{ name: "From", value: "billing@sender.example" }],
      text: "Pay here: https://evil.example/phish",
      html: null,
      attachments: [],
      truncated: [],
      omitted: 0,
      forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
    });
    await checks(
      store,
      id,
      parsedKey(id),
      { orgId: "org-rep-wiring", channel: "email" },
      async () => [],
      undefined,
      null,
      null,
      null,
      undefined,
      null,
      {
        webRisk: async () => ({
          state: "listed",
          threatTypes: ["SOCIAL_ENGINEERING"],
          expiresAt: "2099-01-01T00:00:00.000Z",
          cached: false,
          obtainedAt: "2026-11-02T09:30:00.000Z",
        }),
        cloudflare: async () => ({
          state: "blocked",
          cached: false,
          caveat: "c",
          obtainedAt: "2026-11-02T09:31:00.000Z",
        }),
        wellKnown: async () => ({ state: "known", date: "2026-11-01", source: "Majestic Million", generation: "g1" }),
      },
    );
    const rows = await readReputationResults(env.DB, id);
    expect(rows).toContainEqual(
      expect.objectContaining({
        provider: "google-web-risk",
        subject: "https://evil.example/phish",
        state: "listed",
        obtainedAt: "2026-11-02T09:30:00.000Z",
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        provider: "cloudflare",
        subject: "evil.example",
        state: "listed",
        obtainedAt: "2026-11-02T09:31:00.000Z",
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ provider: "well-known", subject: "evil.example", state: "known" }),
    );
  });

  it("fails the checks step when storing the results fails, so the step retries", async () => {
    const failing = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (/reputation_results/.test(sql)) throw new Error("D1 down");
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const store: Store = { bucket: env.ARTEFACTS, db: failing };
    const good: Store = { bucket: env.ARTEFACTS, db: env.DB };
    const id = await newCase("org-rep-failing");
    const parsed = {
      headers: [{ name: "From", value: "billing@sender.example" }],
      text: "Pay here: https://evil.example/phish",
      html: null,
      attachments: [],
      truncated: [],
      omitted: 0,
      forward: { path: "rfc822" as const, headersAvailable: true, otherOriginals: 0 },
    };
    const deps = {
      webRisk: async () => ({
        state: "listed" as const,
        threatTypes: ["SOCIAL_ENGINEERING" as const],
        expiresAt: "2099-01-01T00:00:00.000Z",
        cached: false,
        obtainedAt: "2026-11-02T09:30:00.000Z",
      }),
      cloudflare: async () => ({
        state: "blocked" as const,
        cached: false,
        caveat: "c",
        obtainedAt: "2026-11-02T09:31:00.000Z",
      }),
      wellKnown: async () => ({
        state: "known" as const,
        date: "2026-11-01",
        source: "Majestic Million",
        generation: "g1",
      }),
    };
    await putParsed(good, id, parsed);
    await checks(
      good,
      id,
      parsedKey(id),
      { orgId: "org-rep-failing", channel: "email" },
      async () => [],
      undefined,
      null,
      null,
      null,
      undefined,
      null,
      deps,
    );
    const countEvidence = async () =>
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM evidence WHERE case_id = ?").bind(id).first<{ n: number }>())?.n;
    const evidenceBefore = await countEvidence();
    const rowsBefore = await readReputationResults(env.DB, id);
    expect(rowsBefore?.length).toBeGreaterThan(0);
    await putParsed(good, id, parsed);
    await expect(
      checks(
        store,
        id,
        parsedKey(id),
        { orgId: "org-rep-failing", channel: "email" },
        async () => [],
        undefined,
        null,
        null,
        null,
        undefined,
        null,
        deps,
      ),
    ).rejects.toThrow("D1 down");
    // The previous complete set stands whole: the failed write happens before any batch commits, so
    // neither the evidence nor its provider results are half replaced (round 3).
    expect(await countEvidence()).toBe(evidenceBefore);
    expect(await readReputationResults(env.DB, id)).toEqual(rowsBefore);
  });
});
