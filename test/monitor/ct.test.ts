// Certificate-transparency search (D05 T04 §7): brand tokens, bounded stubbed answers, a
// failed token stated rather than fatal, owned domains excluded, discoveries joining the
// daily run's candidates before DNS and staying monitored on later days.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { brandTokens, ctCandidates, ctNames } from "../../src/monitor/ct";
import type { MonitorDeps } from "../../src/monitor/run";
import { monitorOrg } from "../../src/monitor/run";
import { business, db } from "./world";

describe("brand tokens and CT names", () => {
  it("derives tokens from names and domain labels, bounded", () => {
    expect(brandTokens(["Fynbos Freight (Pty) Ltd"], ["fynbosfreight.co.za"])).toEqual([
      "fynbosfreight",
      "fynbos",
      "freight",
    ]);
    expect(brandTokens(["A B"], ["x.io"])).toEqual([]);
    expect(ctNames([{ name_value: "*.Fynbos-Pay.example\nfynbos.example\nnot a host" }], "fynbos")).toEqual({
      names: ["fynbos-pay.example", "fynbos.example"],
      truncated: false,
    });
    expect(ctNames("nope", "fynbos")).toEqual({ names: [], truncated: true });
  });

  it("states a failed token and keeps the names that arrived", async () => {
    const asked: string[] = [];
    const fetchFn = (async (url: string | URL) => {
      asked.push(String(url));
      if (String(url).includes("karoo")) return new Response("no", { status: 503 });
      return Response.json([{ name_value: "fynbos-pay.example" }]);
    }) as typeof fetch;
    const got = await ctCandidates(fetchFn, ["fynbos", "karoo"]);
    expect(got.names).toEqual(["fynbos-pay.example"]);
    expect(got.failed).toEqual(["karoo"]);
    // Substring semantics: the token need not sit between dots.
    expect(asked[0]).toContain(encodeURIComponent("%fynbos%"));
    const bad = await ctCandidates(
      (async () => Response.json({ error: "upstream unavailable" })) as unknown as typeof fetch,
      ["fynbos"],
    );
    expect(bad).toEqual({ names: [], failed: ["fynbos"] });
    const malformed = await ctCandidates(
      (async () => Response.json([null, {}, { name_value: 42 }])) as unknown as typeof fetch,
      ["fynbos"],
    );
    expect(malformed.failed).toEqual(["fynbos"]);
  });
});

describe("the daily run with CT", () => {
  it("resolves a CT-only host, excludes owned names, and states a CT failure as partial", async () => {
    const { orgId, domain } = await business();
    const resolved: string[] = [];
    const base = {
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
      resolve: async (host: string) => {
        resolved.push(host);
        return { status: "resolves" as const, answers: ["192.0.2.1"] };
      },
      capture: async () => ({ outcome: "failed" as const, error: "no capture in this test" }),
      open: async () => ({ close: async () => ({}) }) as never,
      close: async () => ({}) as never,
      settle: async () => ({}) as never,
      heldSince: async () => null,
    } as unknown as MonitorDeps;
    const day = new Date().toISOString().slice(0, 10);
    const withCt: MonitorDeps = {
      ...base,
      ct: async () => ({ names: ["fynbos-secure.example", domain, `www.${domain}`], failed: [] }),
    };
    const first = await monitorOrg(withCt, orgId, `monitor-${orgId}-${day}`);
    expect(first.errors.join(" ")).not.toContain("ct:");
    expect(resolved).toContain("fynbos-secure.example");
    expect(resolved).not.toContain(domain);
    expect(resolved).not.toContain(`www.${domain}`);
    const failing: MonitorDeps = { ...base, ct: async () => ({ names: [], failed: ["fynbos"] }) };
    resolved.length = 0;
    const second = await monitorOrg(failing, orgId, `monitor-${orgId}-${day}-2`);
    expect(second.outcome).toBe("partial");
    expect(second.errors.join(" ")).toContain("ct:fynbos");
    // The discovery stays monitored on a later day without any CT answer.
    expect(resolved).toContain("fynbos-secure.example");
  });
});

describe("discovery persistence", () => {
  it("keeps a discovery whose first DNS lookup fails, for the next day", async () => {
    const { orgId } = await business();
    const failing = {
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
      resolve: async () => ({ status: "failed" as const, error: "servfail" }),
      capture: async () => ({ outcome: "failed" as const, error: "none" }),
      open: async () => ({}) as never,
      close: async () => ({}) as never,
      settle: async () => ({}) as never,
      heldSince: async () => null,
      ct: async () => ({ names: ["fynbos-later.example"], failed: [] }),
    } as unknown as MonitorDeps;
    await monitorOrg(failing, orgId, `monitor-${orgId}-ct1`);
    const row = await db
      .prepare("SELECT domain FROM monitor_hosts WHERE org_id = ? AND domain = 'fynbos-later.example'")
      .bind(orgId)
      .first();
    expect(row).not.toBeNull();
  });
});

describe("saturated coverage", () => {
  it("advances the candidate window by a full cap each day", async () => {
    const { orgId } = await business();
    // 305 retained discoveries, all matching the token, none resolving.
    for (let i = 0; i < 305; i++)
      await db
        .prepare(
          `INSERT INTO monitor_hosts (org_id, domain, resolves, first_seen, last_seen) VALUES (?, ?, 0, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
        )
        .bind(orgId, `fynbos-${String(i).padStart(3, "0")}.example`)
        .run();
    const seen: string[][] = [];
    const make = (dayIso: string) =>
      ({
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
        resolve: async (host: string) => {
          (seen.at(-1) as string[]).push(host);
          return { status: "none" as const };
        },
        capture: async () => ({ outcome: "failed" as const, error: "none" }),
        open: async () => ({}) as never,
        close: async () => ({}) as never,
        settle: async () => ({}) as never,
        heldSince: async () => null,
        now: () => new Date(dayIso),
        ct: async () => ({ names: [], failed: [] }),
      }) as unknown as MonitorDeps;
    seen.push([]);
    await monitorOrg(make("2026-11-02T01:00:00.000Z"), orgId, `monitor-${orgId}-sat1`);
    seen.push([]);
    await monitorOrg(make("2026-11-03T01:00:00.000Z"), orgId, `monitor-${orgId}-sat2`);
    const day1 = new Set(seen[0]);
    const day2 = new Set(seen[1]);
    expect(day1.size).toBe(300);
    // The second day covers hosts the first day never reached.
    expect([...day2].some((h) => !day1.has(h))).toBe(true);
  });
});
