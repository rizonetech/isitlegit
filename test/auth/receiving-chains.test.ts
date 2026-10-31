import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { learnReceivers, RECEIVERS_STALE_MS } from "../../src/auth/receivers";
import {
  CHAIN_DEADLINE_MS,
  caseLookups,
  chainsForOrg,
  learnChains,
  MAX_CHAIN_LOOKUPS,
  MAX_RULES,
  type Resolve,
  RULES_FRESH_MS,
} from "../../src/auth/receiving-chains";
import { trustedAuthResults } from "../../src/checks/auth-results";
import { gatewayAddress } from "../../src/checks/receiving-chain";

// D02 T02 §6: receiving chains learned from the organisation's own forwarded originals, bound to the verified claim,
// kept only while the gateway is still its receiver and the chain is seen again. Hosts and addresses are fictional.
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
const original = (from: string, date: string | null = DATE) => {
  const at = date === null ? "" : `; ${date}`;
  return [
    {
      name: "Received",
      value: `from AM6PR02.eurprd02.prod.outlook.com (2603:10a6:20b:1::12) by DB9PR02.eurprd02.prod.outlook.com with HTTPS${at}`,
    },
    { name: "Authentication-Results", value: "spf=pass smtp.mailfrom=sender.example; compauth=pass reason=100" },
    { name: "Received", value: `${from} by AM5EUR01FT001.mail.protection.outlook.com with Microsoft SMTP Server${at}` },
    { name: "Received", value: `from mail.sender.example (203.0.113.5) by mx1.gw.filter.example with ESMTPS${at}` },
  ];
};
const VIA_GATEWAY = "from relay-out.gw.filter.example (198.51.100.20)";
const rowsOf = async (orgId: string) =>
  (
    await db
      .prepare(
        "SELECT gateway, provider, status, last_seen FROM org_receiving_chains WHERE org_id = ? ORDER BY gateway",
      )
      .bind(orgId)
      .all<{ gateway: string; provider: string; status: string; last_seen: string }>()
  ).results;
const receivers = [
  { kind: "other" as const, pattern: "mx1.gw.filter.example" },
  { kind: "other" as const, pattern: "*.filter.example" },
];
const learn = (org: string, headers = original(VIA_GATEWAY), resolve: Resolve = resolving(), caseId = "case-learn") =>
  learnChains(db, org, caseId, "email", headers, caseLookups(resolve));
const select = async (
  orgId: string,
  headers = original(VIA_GATEWAY),
  resolve: Resolve = resolving(),
  caseId = "case-next",
) => trustedAuthResults(headers, receivers, true, await chainsForOrg(db, orgId, caseId, caseLookups(resolve)));
const recent = () => new Date(Date.now() - 60_000).toUTCString();

describe("the gateway's rules", () => {
  const gateway = {
    claimId: "c",
    pattern: "*.filter.example",
    hosts: ["mx1.gw.filter.example"],
    site: "filter.example",
  };
  const discover = (answers: Record<string, string[] | null>, now?: () => number) =>
    caseLookups(resolving(answers), now).discover(gateway);

  it("are its MX hosts' addresses, then its SPF in order, an invalid range dropped", async () => {
    const found = await discover(DNS);
    expect(found.complete).toBe(true);
    expect(["192.0.2.10", "198.51.100.20", "2001:db8:5::1"].map((a) => gatewayAddress(a, found.rules))).toEqual([
      true,
      true,
      true,
    ]);
    expect(gatewayAddress("203.0.113.9", found.rules)).toBe(false);
  });

  it("keep SPF's qualifiers: a neutral, failing or excluded address is never the gateway's (completion review)", async () => {
    const found = await discover({
      "mx1.gw.filter.example A": ["192.0.2.10"],
      "filter.example TXT": ["v=spf1 ?ip4:203.0.113.9 -ip4:203.0.113.10 ~ip4:203.0.113.11 ip4:203.0.113.0/24 -all"],
    });
    expect(
      ["203.0.113.9", "203.0.113.10", "203.0.113.11", "203.0.113.12"].map((a) => gatewayAddress(a, found.rules)),
    ).toEqual([false, false, false, true]);
    // `+all` proves nothing: an address it alone would pass is not the gateway's.
    const open = await discover({ "filter.example TXT": ["v=spf1 +all"] });
    expect(gatewayAddress("203.0.113.9", open.rules)).toBe(false);
  });

  it("are incomplete when a lookup fails, past MAX_CHAIN_LOOKUPS, past the deadline, or past MAX_RULES", async () => {
    expect((await discover({ ...DNS, "_spf.filter.example TXT": null })).complete).toBe(false);
    const chain: Record<string, string[]> = {};
    for (let i = 0; i < 20; i++)
      chain[`${i ? `s${i}.` : ""}filter.example TXT`] = [`v=spf1 include:s${i + 1}.filter.example`];
    const resolve = resolving(chain);
    const long = await caseLookups(resolve).discover(gateway);
    expect([long.complete, resolve.asked.length]).toEqual([false, MAX_CHAIN_LOOKUPS]);
    let clock = 0;
    const late = await discover(DNS, () => {
      clock += CHAIN_DEADLINE_MS;
      return clock;
    });
    expect(late.complete).toBe(false);
    const many = Array.from({ length: MAX_RULES + 1 }, (_, i) => `ip4:10.${i >> 8}.${i & 255}.1`).join(" ");
    expect((await discover({ "filter.example TXT": [`v=spf1 ${many} -all`] })).complete).toBe(false);
  });

  it("share one budget across a case's gateways", async () => {
    const resolve = resolving(DNS);
    const lookups = caseLookups(resolve);
    await lookups.discover(gateway);
    await lookups.discover({ ...gateway, claimId: "d" });
    expect(resolve.asked.length).toBeLessThanOrEqual(MAX_CHAIN_LOOKUPS);
  });
});

describe("receiving chains", () => {
  it("are learned from a forwarded original the provider received from the gateway, used from the next case", async () => {
    const org = `org-${crypto.randomUUID()}`;
    await claim(org, "fynbos.example");
    expect(await select(org)).toEqual({ untrusted: "no-boundary" });
    expect(await learn(org)).toBe(1);
    expect(await rowsOf(org)).toEqual([
      { gateway: "*.filter.example", provider: "microsoft", status: "proven", last_seen: "2026-10-31T09:00:01.000Z" },
    ]);
    expect(await select(org)).toMatchObject({ trusted: { kind: "microsoft" } });
    // The case that learned it reads without it, on a retry as on its first run (completion review).
    expect(await select(org, original(VIA_GATEWAY), resolving(), "case-learn")).toEqual({ untrusted: "no-boundary" });
  });

  it("are not learned from an upload, a direct delivery, a borrowed greeting, or a hop without an address or a date", async () => {
    const org = `org-${crypto.randomUUID()}`;
    await claim(org, "fynbos.example");
    // An uploaded file's headers set no trust for the organisation (completion review).
    expect(await learnChains(db, org, "case-u", "upload", original(VIA_GATEWAY), caseLookups(resolving()))).toBe(0);
    for (const from of [
      "from attacker.example (203.0.113.9)",
      "from relay-out.gw.filter.example (203.0.113.9)",
      "from relay-out.gw.filter.example",
    ])
      expect(await learn(org, original(from))).toBe(0);
    // No date, a malformed one, or one far ahead: nothing learned, nothing renewed (completion review).
    for (const date of [null, "not a date", "Fri, 31 Oct 2036 09:00:01 +0000"])
      expect(await learn(org, original(VIA_GATEWAY, date))).toBe(0);
    expect(await rowsOf(org)).toEqual([]);
  });

  it("reuse fresh rules in reading and learning with no DNS at all (completion review)", async () => {
    const org = `org-${crypto.randomUUID()}`;
    await claim(org, "fynbos.example");
    await learn(org);
    const resolve = resolving();
    await select(org, original(VIA_GATEWAY, recent()), resolve);
    await learn(org, original(VIA_GATEWAY, recent()), resolve);
    expect(resolve.asked).toEqual([]);
  });

  it("are unverified when discovery was incomplete, through storage and the next case's selection", async () => {
    const org = `org-${crypto.randomUUID()}`;
    await claim(org, "fynbos.example");
    // The first sighting's lookups fail: the route cannot be told, which is not a bypass (completion review).
    expect(await learn(org, original(VIA_GATEWAY), resolving({ ...DNS, "_spf.filter.example TXT": null }))).toBe(1);
    expect((await rowsOf(org))[0]?.status).toBe("unverified");
    expect(await select(org)).toEqual({ untrusted: "chain-unverified" });
    // A later complete discovery proves it.
    expect(await learn(org, original(VIA_GATEWAY, recent()))).toBe(1);
    expect((await rowsOf(org))[0]?.status).toBe("proven");
    expect(await select(org)).toMatchObject({ trusted: { kind: "microsoft" } });
  });

  it("renew their last sighting only from a later message, and are dropped past RECEIVERS_STALE_MS", async () => {
    const org = `org-${crypto.randomUUID()}`;
    await claim(org, "fynbos.example");
    await learn(org, original(VIA_GATEWAY, recent()));
    const seen = (await rowsOf(org))[0]?.last_seen;
    await learn(org, original(VIA_GATEWAY, "Mon, 01 Jan 2024 09:00:00 +0000"));
    expect((await rowsOf(org))[0]?.last_seen).toBe(seen);
    const old = new Date(Date.now() - RECEIVERS_STALE_MS - 60_000).toISOString();
    await db.prepare("UPDATE org_receiving_chains SET last_seen = ? WHERE org_id = ?").bind(old, org).run();
    expect(await select(org)).toEqual({ untrusted: "no-boundary" });
    expect(await rowsOf(org)).toEqual([]);
  });

  it("go when the gateway is no longer the claim's receiver, and with the claim itself", async () => {
    const org = `org-${crypto.randomUUID()}`;
    const id = await claim(org, "fynbos.example");
    await learn(org);
    await learnReceivers(db, id, async () => ["fynbos-example.mail.protection.outlook.com"]);
    expect(await select(org)).toEqual({ untrusted: "no-boundary" });
    expect(await rowsOf(org)).toEqual([]);
    const second = await claim(`${org}-b`, "fynbos-b.example");
    await learn(`${org}-b`);
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
    const removing: Resolve = async (name, type) => {
      await db.batch([
        db.prepare("DELETE FROM org_receivers WHERE claim_id = ?").bind(id),
        db.prepare("DELETE FROM org_domains WHERE id = ?").bind(id),
      ]);
      const key = `${name} ${type}`;
      return key in DNS ? (DNS[key] ?? null) : [];
    };
    await learn(org, original(VIA_GATEWAY), removing);
    expect(await rowsOf(org)).toEqual([]);
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
    expect(await learn(org)).toBe(0);
    expect(await select(org)).toEqual({ untrusted: "no-boundary" });
  });

  it("keep one organisation's chain from another's cases", async () => {
    const a = `org-${crypto.randomUUID()}`;
    const b = `org-${crypto.randomUUID()}`;
    await claim(a, "a-fynbos.example");
    await claim(b, "b-fynbos.example");
    await learn(a);
    expect(await select(a)).toMatchObject({ trusted: { kind: "microsoft" } });
    expect(await select(b)).toEqual({ untrusted: "no-boundary" });
  });

  it("look the rules up again after RULES_FRESH_MS: unverified when that fails, trusted again when it works", async () => {
    const org = `org-${crypto.randomUUID()}`;
    await claim(org, "fynbos.example");
    await learn(org);
    const aged = new Date(Date.now() - RULES_FRESH_MS - 60_000).toISOString();
    await db.prepare("UPDATE org_receiving_chains SET rules_at = ? WHERE org_id = ?").bind(aged, org).run();
    expect(await select(org, original(VIA_GATEWAY), resolving({ ...DNS, "filter.example TXT": null }))).toEqual({
      untrusted: "chain-unverified",
    });
    expect(await select(org)).toMatchObject({ trusted: { kind: "microsoft" } });
  });
});
