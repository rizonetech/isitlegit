import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { learnReceivers, RECEIVERS_STALE_MS } from "../../src/auth/receivers";
import {
  ADDRESSES_FRESH_MS,
  caseLookups,
  chainsForOrg,
  gatewayAddresses,
  learnChains,
  MAX_CHAIN_LOOKUPS,
  type Resolve,
} from "../../src/auth/receiving-chains";
import { trustedAuthResults } from "../../src/checks/auth-results";

// D02 T02 §6: receiving chains learned from the organisation's own originals, bound to the verified claim, and kept
// only while the gateway is still its receiver and the chain is seen again. Hosts and addresses are fictional.
const db = (env as unknown as Env).DB;

// Claimed domains are unique across organisations: each claim gets its own label.
async function claim(orgId: string, name: string) {
  const domain = `${crypto.randomUUID().slice(0, 8)}-${name}`;
  const id = `claim-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, ?, ?, ?, 'verified', 'dns', ?, ?)",
    )
    .bind(id, orgId, domain, "t".repeat(16), now, now)
    .run();
  // Its MX is the gateway's.
  await learnReceivers(db, id, async () => ["mx1.gw.filter.example"]);
  return id;
}

// DNS for the gateway: it receives on 192.0.2.10 and sends from 198.51.100.0/24 (its SPF, through an include).
const DNS: Record<string, string[] | null> = {
  "mx1.gw.filter.example A": ["192.0.2.10"],
  "mx1.gw.filter.example AAAA": [],
  "filter.example TXT": ["v=spf1 include:_spf.filter.example -all"],
  "_spf.filter.example TXT": ["v=spf1 ip4:198.51.100.0/24 ip6:2001:db8:5::/48 ip4:999.1.1.1/8 ~all"],
};
const resolving = (answers: Record<string, string[] | null> = DNS): Resolve & { asked: string[] } => {
  const asked: string[] = [];
  return Object.assign(
    async (name: string, type: string) => {
      asked.push(`${name} ${type}`);
      const key = `${name} ${type}`;
      return key in answers ? (answers[key] ?? null) : [];
    },
    { asked },
  );
};

const DATE = "Fri, 31 Oct 2026 09:00:01 +0000";
const original = (from: string, date = DATE) => [
  {
    name: "Received",
    value: `from AM6PR02.eurprd02.prod.outlook.com (2603:10a6:20b:1::12) by DB9PR02.eurprd02.prod.outlook.com with HTTPS; ${date}`,
  },
  { name: "Authentication-Results", value: "spf=pass smtp.mailfrom=sender.example; compauth=pass reason=100" },
  {
    name: "Received",
    value: `${from} by AM5EUR01FT001.mail.protection.outlook.com with Microsoft SMTP Server; ${date}`,
  },
  { name: "Received", value: `from mail.sender.example (203.0.113.5) by mx1.gw.filter.example with ESMTPS; ${date}` },
];
const VIA_GATEWAY = "from relay-out.gw.filter.example (198.51.100.20)";
const rowsOf = async (orgId: string) =>
  (
    await db
      .prepare("SELECT gateway, provider, last_seen FROM org_receiving_chains WHERE org_id = ? ORDER BY gateway")
      .bind(orgId)
      .all<{ gateway: string; provider: string; last_seen: string }>()
  ).results;
const receivers = [
  { kind: "other" as const, pattern: "mx1.gw.filter.example" },
  { kind: "other" as const, pattern: "*.filter.example" },
];
const select = async (orgId: string, headers = original(VIA_GATEWAY), resolve = resolving()) =>
  trustedAuthResults(headers, receivers, true, await chainsForOrg(db, orgId, caseLookups(resolve)));

describe("the gateway's addresses", () => {
  const gateway = {
    claimId: "c",
    pattern: "*.filter.example",
    hosts: ["mx1.gw.filter.example"],
    site: "filter.example",
  };

  it("are its MX hosts' and those its SPF publishes, invalid ones dropped", async () => {
    expect((await gatewayAddresses(gateway, resolving()))?.sort()).toEqual([
      "192.0.2.10",
      "198.51.100.0/24",
      "2001:db8:5::/48",
    ]);
  });

  it("are null when a lookup fails, and stop at MAX_CHAIN_LOOKUPS lookups", async () => {
    expect(await gatewayAddresses(gateway, resolving({ ...DNS, "_spf.filter.example TXT": null }))).toBeNull();
    // An include chain longer than the limit: never more lookups than it allows.
    const chain: Record<string, string[]> = { "mx1.gw.filter.example A": ["192.0.2.10"] };
    for (let i = 0; i < 20; i++)
      chain[`${i ? `s${i}.` : ""}filter.example TXT`] = [`v=spf1 include:s${i + 1}.filter.example`];
    const resolve = resolving(chain);
    expect(await gatewayAddresses(gateway, resolve)).toEqual(["192.0.2.10"]);
    expect(resolve.asked.length).toBe(MAX_CHAIN_LOOKUPS);
  });
});

describe("receiving chains", () => {
  it("are learned from an original the provider received from the gateway, and used from the next case on", async () => {
    const org = `org-${crypto.randomUUID()}`;
    await claim(org, "fynbos.example");
    // The first case is read with no chain.
    expect(await select(org)).toEqual({ untrusted: "no-boundary" });
    expect(await learnChains(db, org, original(VIA_GATEWAY), caseLookups(resolving()))).toBe(1);
    expect(await rowsOf(org)).toEqual([
      { gateway: "*.filter.example", provider: "microsoft", last_seen: "2026-10-31T09:00:01.000Z" },
    ]);
    expect(await select(org)).toMatchObject({ trusted: { kind: "microsoft" } });
  });

  it("are not learned from a direct delivery, a borrowed greeting or an ingress hop without an address", async () => {
    const org = `org-${crypto.randomUUID()}`;
    await claim(org, "fynbos.example");
    for (const from of [
      "from attacker.example (203.0.113.9)",
      "from relay-out.gw.filter.example (203.0.113.9)",
      "from relay-out.gw.filter.example",
    ])
      expect(await learnChains(db, org, original(from), caseLookups(resolving()))).toBe(0);
    expect(await rowsOf(org)).toEqual([]);
  });

  it("renew their last sighting only from a later message, and are dropped past RECEIVERS_STALE_MS", async () => {
    const org = `org-${crypto.randomUUID()}`;
    await claim(org, "fynbos.example");
    const recent = new Date(Date.now() - 60_000).toUTCString();
    await learnChains(db, org, original(VIA_GATEWAY, recent), caseLookups(resolving()));
    const seen = (await rowsOf(org))[0]?.last_seen;
    // An old case replayed renews nothing.
    await learnChains(db, org, original(VIA_GATEWAY, "Mon, 01 Jan 2024 09:00:00 +0000"), caseLookups(resolving()));
    expect((await rowsOf(org))[0]?.last_seen).toBe(seen);
    // Seen last longer ago than RECEIVERS_STALE_MS: dropped, and the next case keeps no boundary.
    const old = new Date(Date.now() - RECEIVERS_STALE_MS - 60_000).toISOString();
    await db.prepare("UPDATE org_receiving_chains SET last_seen = ? WHERE org_id = ?").bind(old, org).run();
    expect(await select(org)).toEqual({ untrusted: "no-boundary" });
    expect(await rowsOf(org)).toEqual([]);
  });

  it("go when the gateway is no longer the claim's receiver, and with the claim itself", async () => {
    const org = `org-${crypto.randomUUID()}`;
    const id = await claim(org, "fynbos.example");
    await learnChains(db, org, original(VIA_GATEWAY), caseLookups(resolving()));
    // The MX moved off the gateway.
    await learnReceivers(db, id, async () => ["fynbos-example.mail.protection.outlook.com"]);
    expect(await select(org)).toEqual({ untrusted: "no-boundary" });
    expect(await rowsOf(org)).toEqual([]);
    // Deleting the claim deletes its chain (the foreign key cascades).
    const second = await claim(`${org}-b`, "fynbos-b.example");
    await learnChains(db, `${org}-b`, original(VIA_GATEWAY), caseLookups(resolving()));
    expect(await rowsOf(`${org}-b`)).toHaveLength(1);
    await db.batch([
      db.prepare("DELETE FROM org_receivers WHERE claim_id = ?").bind(second),
      db.prepare("DELETE FROM org_domains WHERE id = ?").bind(second),
    ]);
    expect(await rowsOf(`${org}-b`)).toEqual([]);
  });

  it("are not stored for a claim removed while learning, nor kept for one added again unverified", async () => {
    const org = `org-${crypto.randomUUID()}`;
    const id = await claim(org, "fynbos.example");
    // The claim goes while its gateway's addresses are being looked up.
    const removing: Resolve = async (name, type) => {
      await db.batch([
        db.prepare("DELETE FROM org_receivers WHERE claim_id = ?").bind(id),
        db.prepare("DELETE FROM org_domains WHERE id = ?").bind(id),
      ]);
      return DNS[`${name} ${type}`] ?? [];
    };
    await learnChains(db, org, original(VIA_GATEWAY), caseLookups(removing));
    expect(await rowsOf(org)).toEqual([]);
    // Added again but not verified: no receivers, no chain, no boundary.
    await db
      .prepare(
        "INSERT INTO org_domains (id, org_id, domain, token, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
      )
      .bind(
        `claim-${crypto.randomUUID()}`,
        org,
        `${crypto.randomUUID().slice(0, 8)}-again.example`,
        "t".repeat(16),
        new Date().toISOString(),
      )
      .run();
    expect(await learnChains(db, org, original(VIA_GATEWAY), caseLookups(resolving()))).toBe(0);
    expect(await select(org)).toEqual({ untrusted: "no-boundary" });
  });

  it("keep one organisation's chain from another's cases", async () => {
    const a = `org-${crypto.randomUUID()}`;
    const b = `org-${crypto.randomUUID()}`;
    await claim(a, "a-fynbos.example");
    await claim(b, "b-fynbos.example");
    await learnChains(db, a, original(VIA_GATEWAY), caseLookups(resolving()));
    expect(await select(a)).toMatchObject({ trusted: { kind: "microsoft" } });
    expect(await select(b)).toEqual({ untrusted: "no-boundary" });
  });

  it("look the addresses up again after ADDRESSES_FRESH_MS: unverified when that fails, trusted again when it works", async () => {
    const org = `org-${crypto.randomUUID()}`;
    await claim(org, "fynbos.example");
    await learnChains(db, org, original(VIA_GATEWAY), caseLookups(resolving()));
    const aged = new Date(Date.now() - ADDRESSES_FRESH_MS - 60_000).toISOString();
    await db.prepare("UPDATE org_receiving_chains SET addresses_at = ? WHERE org_id = ?").bind(aged, org).run();
    expect(await select(org, original(VIA_GATEWAY), resolving({ ...DNS, "filter.example TXT": null }))).toEqual({
      untrusted: "chain-unverified",
    });
    expect(await select(org)).toMatchObject({ trusted: { kind: "microsoft" } });
  });
});
