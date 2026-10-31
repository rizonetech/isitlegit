import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { learnReceivers } from "../../src/auth/receivers";
import {
  CHAIN_DEADLINE_MS,
  caseLookups,
  chainsForOrg,
  MAX_CHAIN_LOOKUPS,
  MAX_RULES,
  providersOf,
  type Resolve,
  RULES_FRESH_MS,
} from "../../src/auth/receiving-chains";
import { trustedAuthResults } from "../../src/checks/auth-results";
import { gatewayAddress } from "../../src/checks/receiving-chain";

// D02 T02 §6: receiving chains read from the organisation's own DNS, never from a message: the verified claim's MX
// names the gateway, its own records name the provider. Hosts and addresses are fictional.
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
  return { id, domain };
}

// DNS for the gateway (it receives on 192.0.2.10 and sends from 198.51.100.0/24, its SPF through an include), and for
// the claimed domain: Microsoft 365's domain verification record and SPF.
const gatewayDns: Record<string, string[] | null> = {
  "mx1.gw.filter.example A": ["192.0.2.10"],
  "mx1.gw.filter.example AAAA": [],
  "filter.example TXT": ["v=spf1 include:_spf.filter.example -all"],
  "_spf.filter.example TXT": ["v=spf1 ip4:198.51.100.0/24 ip6:2001:db8:5::/48 ip4:999.1.1.1/8 ~all"],
};
const withDomain = (
  domain: string,
  records: string[] | null = ["MS=ms12345678", "v=spf1 include:spf.protection.outlook.com -all"],
) => ({
  ...gatewayDns,
  [`${domain} TXT`]: records,
});
const resolving = (answers: Record<string, string[] | null>): Resolve & { asked: string[] } => {
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
const original = (from: string) => [
  {
    name: "Received",
    value: `from AM6PR02.eurprd02.prod.outlook.com (2603:10a6:20b:1::12) by DB9PR02.eurprd02.prod.outlook.com with HTTPS; ${DATE}`,
  },
  { name: "Authentication-Results", value: "spf=pass smtp.mailfrom=sender.example; compauth=pass reason=100" },
  {
    name: "Received",
    value: `${from} by AM5EUR01FT001.mail.protection.outlook.com with Microsoft SMTP Server; ${DATE}`,
  },
  { name: "Received", value: `from mail.sender.example (203.0.113.5) by mx1.gw.filter.example with ESMTPS; ${DATE}` },
];
const VIA_GATEWAY = "from relay-out.gw.filter.example (198.51.100.20)";
const rowsOf = async (orgId: string) =>
  (
    await db
      .prepare("SELECT gateway, provider, status FROM org_receiving_chains WHERE org_id = ? ORDER BY provider")
      .bind(orgId)
      .all<{ gateway: string; provider: string; status: string }>()
  ).results;
const receivers = [
  { kind: "other" as const, pattern: "mx1.gw.filter.example" },
  { kind: "other" as const, pattern: "*.filter.example" },
];
const select = async (orgId: string, resolve: Resolve, headers = original(VIA_GATEWAY)) =>
  trustedAuthResults(headers, receivers, true, await chainsForOrg(db, orgId, caseLookups(resolve)));

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
    const found = await discover(gatewayDns);
    expect(found.complete).toBe(true);
    expect(["192.0.2.10", "198.51.100.20", "2001:db8:5::1"].map((a) => gatewayAddress(a, found.rules))).toEqual([
      true,
      true,
      true,
    ]);
    expect(gatewayAddress("203.0.113.9", found.rules)).toBe(false);
  });

  it("keep SPF's qualifiers, an include's included: a neutral, failing or excluded address is never the gateway's", async () => {
    const found = await discover({
      "mx1.gw.filter.example A": ["192.0.2.10"],
      "filter.example TXT": [
        "v=spf1 ?ip4:203.0.113.9 -ip4:203.0.113.10 ~ip4:203.0.113.11 -include:out.filter.example ip4:203.0.113.0/24 -all",
      ],
      "out.filter.example TXT": ["v=spf1 ip4:203.0.113.12 -all"],
    });
    expect(
      ["203.0.113.9", "203.0.113.10", "203.0.113.11", "203.0.113.12", "203.0.113.13"].map((a) =>
        gatewayAddress(a, found.rules),
      ),
    ).toEqual([false, false, false, false, true]);
    // `+all` proves nothing: an address it alone would pass is not the gateway's.
    const open = await discover({ "filter.example TXT": ["v=spf1 +all"] });
    expect(gatewayAddress("203.0.113.9", open.rules)).toBe(false);
  });

  it("are incomplete when a lookup fails, past MAX_CHAIN_LOOKUPS, past the deadline, or past MAX_RULES", async () => {
    expect((await discover({ ...gatewayDns, "_spf.filter.example TXT": null })).complete).toBe(false);
    const chain: Record<string, string[]> = {};
    for (let i = 0; i < 20; i++)
      chain[`${i ? `s${i}.` : ""}filter.example TXT`] = [`v=spf1 include:s${i + 1}.filter.example`];
    const resolve = resolving(chain);
    const long = await caseLookups(resolve).discover(gateway);
    expect([long.complete, resolve.asked.length]).toEqual([false, MAX_CHAIN_LOOKUPS]);
    let clock = 0;
    const late = await discover(gatewayDns, () => {
      clock += CHAIN_DEADLINE_MS;
      return clock;
    });
    expect(late.complete).toBe(false);
    const many = Array.from({ length: MAX_RULES + 1 }, (_, i) => `ip4:10.${i >> 8}.${i & 255}.1`).join(" ");
    expect((await discover({ "filter.example TXT": [`v=spf1 ${many} -all`] })).complete).toBe(false);
  });
});

describe("a claimed domain's providers", () => {
  const ask = (records: string[] | null) => caseLookups(resolving({ "fynbos.example TXT": records })).ask;
  it("are named by Microsoft 365's verification record or SPF include, and Google Workspace's SPF include", async () => {
    expect(await providersOf("fynbos.example", ask(["MS=ms12345678"]))).toEqual({
      providers: ["microsoft"],
      complete: true,
    });
    expect(
      await providersOf(
        "fynbos.example",
        ask(["v=spf1 include:_spf.google.com include:spf.protection.outlook.com ~all"]),
      ),
    ).toEqual({
      providers: ["microsoft", "google"],
      complete: true,
    });
    // A site verification record, or a lookalike include, names no provider.
    expect(
      await providersOf(
        "fynbos.example",
        ask(["google-site-verification=x", "v=spf1 include:spf.protection.outlook.com.evil.example -all"]),
      ),
    ).toEqual({
      providers: [],
      complete: true,
    });
    expect(await providersOf("fynbos.example", ask(null))).toEqual({ providers: [], complete: false });
  });
});

describe("receiving chains", () => {
  it("are read from the organisation's DNS and trust the first message received through the gateway", async () => {
    const org = `org-${crypto.randomUUID()}`;
    const { domain } = await claim(org, "fynbos.example");
    expect(await select(org, resolving(withDomain(domain)))).toMatchObject({ trusted: { kind: "microsoft" } });
    expect(await rowsOf(org)).toEqual([{ gateway: "*.filter.example", provider: "microsoft", status: "proven" }]);
    // Handed to Microsoft 365 directly, or with the gateway's name from another address: no boundary.
    for (const from of ["from attacker.example (203.0.113.9)", "from relay-out.gw.filter.example (203.0.113.9)"])
      expect(await select(org, resolving(withDomain(domain)), original(from))).toEqual({ untrusted: "no-boundary" });
  });

  it("are not made for a domain whose records name no provider", async () => {
    const org = `org-${crypto.randomUUID()}`;
    const { domain } = await claim(org, "fynbos.example");
    expect(await select(org, resolving(withDomain(domain, ["v=spf1 mx -all"])))).toEqual({ untrusted: "no-boundary" });
    expect(await rowsOf(org)).toEqual([]);
  });

  it("reuse fresh rules with no DNS, and look them up again after RULES_FRESH_MS", async () => {
    const org = `org-${crypto.randomUUID()}`;
    const { domain } = await claim(org, "fynbos.example");
    await select(org, resolving(withDomain(domain)));
    const quiet = resolving(withDomain(domain));
    expect(await select(org, quiet)).toMatchObject({ trusted: { kind: "microsoft" } });
    expect(quiet.asked).toEqual([]);
    const aged = new Date(Date.now() - RULES_FRESH_MS - 60_000).toISOString();
    await db.prepare("UPDATE org_receiving_chains SET rules_at = ? WHERE org_id = ?").bind(aged, org).run();
    // The gateway's relays moved: the old address is no longer trusted.
    const moved = resolving({ ...withDomain(domain), "_spf.filter.example TXT": ["v=spf1 ip4:203.0.113.0/24 -all"] });
    expect(await select(org, moved)).toEqual({ untrusted: "no-boundary" });
    expect(moved.asked.length).toBeGreaterThan(0);
  });

  it("are unverified, never proven, when discovery is incomplete, and proven again once it completes", async () => {
    const org = `org-${crypto.randomUUID()}`;
    const { domain } = await claim(org, "fynbos.example");
    // A failed include before the rule that passes the address: still unverified (round 1).
    const partial = resolving({
      ...withDomain(domain),
      "filter.example TXT": ["v=spf1 include:failed.filter.example ip4:198.51.100.0/24 -all"],
      "failed.filter.example TXT": null,
    });
    expect(await select(org, partial)).toEqual({ untrusted: "chain-unverified" });
    expect((await rowsOf(org)).map((r) => r.status)).toEqual(["unverified"]);
    // The claim's own records could not be read: unverified for either provider, not a bypass.
    const other = `org-${crypto.randomUUID()}`;
    const second = await claim(other, "fynbos-b.example");
    expect(await select(other, resolving(withDomain(second.domain, null)))).toEqual({ untrusted: "chain-unverified" });
    // A later complete discovery proves it.
    expect(await select(org, resolving(withDomain(domain)))).toMatchObject({ trusted: { kind: "microsoft" } });
    expect((await rowsOf(org)).map((r) => r.status)).toEqual(["proven"]);
  });

  it("go when the gateway is no longer the claim's receiver, and with the claim itself", async () => {
    const org = `org-${crypto.randomUUID()}`;
    const { id, domain } = await claim(org, "fynbos.example");
    await select(org, resolving(withDomain(domain)));
    await learnReceivers(db, id, async () => ["fynbos-example.mail.protection.outlook.com"]);
    expect(await select(org, resolving(withDomain(domain)))).toEqual({ untrusted: "no-boundary" });
    expect(await rowsOf(org)).toEqual([]);
    const other = `org-${crypto.randomUUID()}`;
    const second = await claim(other, "fynbos-b.example");
    await select(other, resolving(withDomain(second.domain)));
    expect(await rowsOf(other)).toHaveLength(1);
    await db.batch([
      db.prepare("DELETE FROM org_receivers WHERE claim_id = ?").bind(second.id),
      db.prepare("DELETE FROM org_domains WHERE id = ?").bind(second.id),
    ]);
    expect(await rowsOf(other)).toEqual([]);
  });

  it("are not stored for a claim removed while its DNS is read, and keep one organisation's from another's cases", async () => {
    const org = `org-${crypto.randomUUID()}`;
    const { id, domain } = await claim(org, "fynbos.example");
    const answers = withDomain(domain);
    const removing: Resolve = async (name, type) => {
      await db.batch([
        db.prepare("DELETE FROM org_receivers WHERE claim_id = ?").bind(id),
        db.prepare("DELETE FROM org_domains WHERE id = ?").bind(id),
      ]);
      const key = `${name} ${type}`;
      return key in answers ? (answers[key] ?? null) : [];
    };
    await chainsForOrg(db, org, caseLookups(removing));
    expect(await rowsOf(org)).toEqual([]);
    const a = `org-${crypto.randomUUID()}`;
    const b = `org-${crypto.randomUUID()}`;
    const first = await claim(a, "a-fynbos.example");
    expect(await select(a, resolving(withDomain(first.domain)))).toMatchObject({ trusted: { kind: "microsoft" } });
    expect(await select(b, resolving(withDomain(first.domain)))).toEqual({ untrusted: "no-boundary" });
  });
});
