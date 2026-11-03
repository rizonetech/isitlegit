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
    expect(ctNames([{ name_value: "*.Fynbos-Pay.example\nfynbos.example\nnot a host" }], "fynbos")).toEqual([
      "fynbos-pay.example",
      "fynbos.example",
    ]);
    expect(ctNames("nope", "fynbos")).toEqual([]);
  });

  it("states a failed token and keeps the names that arrived", async () => {
    const fetchFn = (async (url: string | URL) => {
      if (String(url).includes("karoo")) return new Response("no", { status: 503 });
      return Response.json([{ name_value: "fynbos-pay.example" }]);
    }) as typeof fetch;
    const got = await ctCandidates(fetchFn, ["fynbos", "karoo"]);
    expect(got.names).toEqual(["fynbos-pay.example"]);
    expect(got.failed).toEqual(["karoo"]);
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
