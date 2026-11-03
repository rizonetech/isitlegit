// Monitor seeds (D05 T04 §6): demo-only candidate seeds, provisioned with read-back, never
// read for an ordinary organisation, and captured at their page path by the daily run.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { MonitorDeps } from "../../src/monitor/run";
import { monitorOrg } from "../../src/monitor/run";
import { addSeed, isDemoOrg, removeSeed, seedsFor } from "../../src/monitor/seeds";
import { makeOrg } from "../trust/helpers";
import { db } from "./world";

async function demoOrg(demo: unknown) {
  const orgId = await makeOrg("Seed Org");
  await db
    .prepare(`UPDATE "organization" SET metadata = ? WHERE id = ?`)
    .bind(JSON.stringify(demo === undefined ? {} : { demo }), orgId)
    .run();
  return orgId;
}

describe("monitor seeds", () => {
  it("reads seeds only for an organisation flagged demo === true", async () => {
    const demo = await demoOrg(true);
    const ordinary = await demoOrg(false);
    const malformed = await demoOrg("yes");
    expect(await addSeed(db, demo, { host: "fixtures.isitlegit.co.za", path: "fynbos-lookalike/" })).toBe(true);
    expect(await isDemoOrg(db, demo)).toBe(true);
    expect(await isDemoOrg(db, ordinary)).toBe(false);
    expect(await isDemoOrg(db, malformed)).toBe(false);
    expect(await seedsFor(db, demo)).toEqual([{ host: "fixtures.isitlegit.co.za", path: "fynbos-lookalike/" }]);
    // Provisioning the same seed for an ordinary organisation stores a row nobody reads.
    await addSeed(db, ordinary, { host: "fixtures.isitlegit.co.za", path: "fynbos-lookalike/" });
    expect(await seedsFor(db, ordinary)).toEqual([]);
    expect(await removeSeed(db, demo, "fixtures.isitlegit.co.za")).toBe(true);
    expect(await seedsFor(db, demo)).toEqual([]);
  });

  it("captures a seeded host at its page path in the daily run", async () => {
    const { business } = await import("./world");
    const { orgId } = await business();
    await db
      .prepare(`UPDATE "organization" SET metadata = ? WHERE id = ?`)
      .bind(JSON.stringify({ demo: true }), orgId)
      .run();
    await addSeed(db, orgId, { host: "fixtures.isitlegit.co.za", path: "fynbos-lookalike/" });
    const captured: string[] = [];
    const deps = {
      db,
      bucket: env.ARTEFACTS,
      store: { bucket: env.ARTEFACTS, db },
      kv: (env as unknown as { CACHE: KVNamespace }).CACHE,
      meta: {
        env: { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" },
        budget: undefined,
        random: () => 0.5,
        sleep: async () => {},
        fetch: (async () => new Response("x", { status: 500 })) as typeof fetch,
      },
      resolve: async () => ({ status: "resolves" as const, answers: ["192.0.2.1"] }),
      capture: async (host: string) => {
        captured.push(`root:${host}`);
        return { outcome: "failed" as const, error: "root" };
      },
      captureSeed: async (host: string, path: string) => {
        captured.push(`seed:${host}/${path}`);
        return { outcome: "failed" as const, error: "seed" };
      },
      open: async () => ({}) as never,
      close: async () => ({}) as never,
      settle: async () => ({}) as never,
      heldSince: async () => null,
    } as unknown as MonitorDeps;
    await monitorOrg(deps, orgId, `monitor-${orgId}-seed`);
    expect(captured).toContain("seed:fixtures.isitlegit.co.za/fynbos-lookalike/");
  });
});
