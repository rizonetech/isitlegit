// Receiving chains behind a filtering gateway, learned and kept (D02 T02 §6; docs/specs/2026-10-31-receiving-chains-design.md).
// A chain is learned from the organisation's own forwarded originals: the provider's ingress hop records the address it
// received the message from, and when that address is one of the gateway's (its MX hosts' addresses and those its
// sending domain publishes in SPF) the chain is stored for the claim whose receiver the gateway is. A case is read with
// the chains stored before it, never with one its own message proved.
import { type ChainProvider, inAny, ingressOf, parseCidr, type ReceivingChain } from "../checks/receiving-chain";
import { DOH_URL } from "./domains";
import { MX_DEADLINE_MS, RECEIVERS_STALE_MS } from "./receivers";

// The gateway's addresses are used this long before they are looked up again.
export const ADDRESSES_FRESH_MS = 24 * 60 * 60 * 1000;
// At most this many DNS lookups per gateway per case: RFC 7208's limit for one SPF evaluation (section 4.6.4).
export const MAX_CHAIN_LOOKUPS = 10;
const PROVIDERS: readonly ChainProvider[] = ["microsoft", "google"];

// One DNS question over DNS-over-HTTPS: the answers' data (an MX answer's host, a TXT answer's joined strings), an
// empty list when the name has none, null when the lookup failed.
export type Resolve = (name: string, type: "A" | "AAAA" | "TXT" | "MX") => Promise<string[] | null>;
const TYPES = { A: 1, AAAA: 28, TXT: 16, MX: 15 } as const;

export const resolveDoh: Resolve = async (name, type) => {
  const url = `${DOH_URL}?${new URLSearchParams({ name, type })}`;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(MX_DEADLINE_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { Status?: unknown; Answer?: { type?: number; data?: string }[] };
    if (body.Status === 3) return [];
    if (body.Status !== 0) return null;
    return (body.Answer ?? [])
      .filter((a) => a.type === TYPES[type] && typeof a.data === "string")
      .map((a) => {
        const data = (a.data ?? "").trim();
        if (type === "MX") return data.split(/\s+/)[1]?.replace(/\.$/, "").toLowerCase() ?? "";
        if (type === "TXT") return [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("") || data;
        return data;
      })
      .filter((d) => d.length > 0);
  } catch {
    return null;
  }
};

// A gateway as the organisation's receivers name it: its MX hosts, and the sending domain under them (the `*.<site>`
// pattern `receiversOf` adds), from the claim's `other` rows.
type Gateway = { claimId: string; pattern: string; hosts: string[]; site: string | null };

// The gateway's addresses, within MAX_CHAIN_LOOKUPS lookups, each answer validated as an address or CIDR; null when a
// lookup failed (unverified, never "not the gateway"). Lookups past the limit are not made, and what was found is kept.
export async function gatewayAddresses(gateway: Gateway, resolve: Resolve): Promise<string[] | null> {
  const found = new Set<string>();
  let left = MAX_CHAIN_LOOKUPS;
  let failed = false;
  const ask = async (name: string, type: "A" | "AAAA" | "TXT" | "MX") => {
    if (left <= 0) return [];
    left--;
    const answer = await resolve(name, type);
    if (answer === null) failed = true;
    return answer ?? [];
  };
  const keep = (cidr: string) => {
    if (parseCidr(cidr)) found.add(cidr.toLowerCase());
  };
  const hostAddresses = async (host: string, v4 = "", v6 = "") => {
    for (const a of await ask(host, "A")) keep(v4 ? `${a}/${v4}` : a);
    for (const a of await ask(host, "AAAA")) keep(v6 ? `${a}/${v6}` : a);
  };
  for (const host of gateway.hosts) await hostAddresses(host);
  const seen = new Set<string>();
  const spf = async (domain: string): Promise<void> => {
    if (seen.has(domain) || seen.size >= MAX_CHAIN_LOOKUPS) return;
    seen.add(domain);
    const record = (await ask(domain, "TXT")).find((t) => /^v=spf1(?:\s|$)/i.test(t));
    if (!record) return;
    for (const term of record.split(/\s+/).slice(1)) {
      const t = term.replace(/^[+~?]/, "");
      if (t.startsWith("-")) continue;
      const [mech, arg] = [t.split(/[:=]/)[0]?.toLowerCase(), t.slice((t.split(/[:=]/)[0] ?? "").length + 1)];
      if (mech === "ip4" || mech === "ip6") keep(arg);
      else if (mech === "include" || mech === "redirect") await spf(arg.toLowerCase());
      else if (mech === "a" || mech?.startsWith("a/")) {
        const [target, len] = (t.includes(":") ? arg : `${domain}${t.slice(1)}`).split("/");
        await hostAddresses(target || domain, len ?? "", len ?? "");
      } else if (mech === "mx" || mech?.startsWith("mx/")) {
        const [target] = (t.includes(":") ? arg : domain).split("/");
        for (const host of await ask(target || domain, "MX")) await hostAddresses(host);
      }
    }
  };
  if (gateway.site) await spf(gateway.site);
  if (failed) return null;
  return [...found];
}

// The organisation's gateways: each verified claim's `other` receivers, its hosts and its sending domain.
async function gatewaysOf(db: D1Database, orgId: string): Promise<Gateway[]> {
  const rows = await db
    .prepare(
      "SELECT r.claim_id, r.pattern FROM org_receivers r JOIN org_domains d ON d.id = r.claim_id AND d.state = 'verified' WHERE d.org_id = ? AND r.kind = 'other' ORDER BY r.claim_id, r.pattern",
    )
    .bind(orgId)
    .all<{ claim_id: string; pattern: string }>();
  const byClaim = new Map<string, { hosts: string[]; sites: string[] }>();
  for (const row of rows.results) {
    const entry = byClaim.get(row.claim_id) ?? { hosts: [], sites: [] };
    if (row.pattern.startsWith("*.")) entry.sites.push(row.pattern.slice(2));
    else entry.hosts.push(row.pattern);
    byClaim.set(row.claim_id, entry);
  }
  // One gateway per sending domain, named by its `*.<site>` pattern, the hosts under it its MX hosts.
  const gateways: Gateway[] = [];
  for (const [claimId, { hosts, sites }] of byClaim)
    for (const site of sites)
      gateways.push({
        claimId,
        pattern: `*.${site}`,
        hosts: hosts.filter((h) => h === site || h.endsWith(`.${site}`)),
        site,
      });
  return gateways;
}

// One case's lookups, so a gateway's addresses are asked for at most once per case whoever needs them.
export function caseLookups(resolve: Resolve) {
  const memo = new Map<string, Promise<string[] | null>>();
  return (gateway: Gateway) => {
    const key = `${gateway.claimId} ${gateway.pattern}`;
    let pending = memo.get(key);
    if (!pending) {
      pending = gatewayAddresses(gateway, resolve);
      memo.set(key, pending);
    }
    return pending;
  };
}

type Row = {
  claim_id: string;
  gateway: string;
  provider: ChainProvider;
  addresses: string;
  addresses_at: string;
  last_seen: string;
};

// The chains a case is read with: those stored for the organisation's verified claims whose gateway is still among the
// claim's receivers and which were seen within RECEIVERS_STALE_MS; the others are deleted. A chain whose addresses are
// older than ADDRESSES_FRESH_MS is looked up again, and one whose lookup failed is unverified for this case.
export async function chainsForOrg(
  db: D1Database,
  orgId: string,
  addressesOf: ReturnType<typeof caseLookups>,
  now = new Date(),
): Promise<ReceivingChain[]> {
  const stale = new Date(now.getTime() - RECEIVERS_STALE_MS).toISOString();
  await db
    .prepare(
      "DELETE FROM org_receiving_chains WHERE org_id = ?1 AND (last_seen < ?2 OR NOT EXISTS (SELECT 1 FROM org_receivers r JOIN org_domains d ON d.id = r.claim_id AND d.state = 'verified' WHERE r.claim_id = org_receiving_chains.claim_id AND r.kind = 'other' AND r.pattern = org_receiving_chains.gateway))",
    )
    .bind(orgId, stale)
    .run();
  const rows = await db
    .prepare(
      "SELECT claim_id, gateway, provider, addresses, addresses_at, last_seen FROM org_receiving_chains WHERE org_id = ? ORDER BY claim_id, gateway, provider",
    )
    .bind(orgId)
    .all<Row>();
  if (rows.results.length === 0) return [];
  const gateways = await gatewaysOf(db, orgId);
  const fresh = new Date(now.getTime() - ADDRESSES_FRESH_MS).toISOString();
  const chains: ReceivingChain[] = [];
  for (const row of rows.results) {
    const base = { gateway: row.gateway, provider: row.provider };
    if (row.addresses_at >= fresh) {
      chains.push({ ...base, addresses: JSON.parse(row.addresses) as string[] });
      continue;
    }
    const gateway = gateways.find((g) => g.claimId === row.claim_id && g.pattern === row.gateway);
    const addresses = gateway ? await addressesOf(gateway) : null;
    if (addresses === null) {
      chains.push({ ...base, addresses: [], unverified: true });
      continue;
    }
    await db
      .prepare(
        "UPDATE org_receiving_chains SET addresses = ?4, addresses_at = ?5 WHERE claim_id = ?1 AND gateway = ?2 AND provider = ?3",
      )
      .bind(row.claim_id, row.gateway, row.provider, JSON.stringify(addresses.slice(0, 256)), now.toISOString())
      .run();
    chains.push({ ...base, addresses });
  }
  return chains;
}

// Learns from one case's original: for each provider whose ingress hop came from a gateway's addresses, the chain is
// stored (or its addresses and last sighting refreshed) for that gateway's claim, only while the claim is verified.
// `last_seen` moves only forward, to the ingress hop's date, so replaying an old case renews nothing.
export async function learnChains(
  db: D1Database,
  orgId: string,
  headers: readonly { name: string; value: string }[],
  addressesOf: ReturnType<typeof caseLookups>,
  now = new Date(),
): Promise<number> {
  const ingress = PROVIDERS.map((provider) => ({ provider, hop: ingressOf(headers, provider) })).filter(
    (i): i is { provider: ChainProvider; hop: { address: string; date: string | null } } =>
      i.hop !== null && i.hop !== "unprovable",
  );
  if (ingress.length === 0) return 0;
  let learned = 0;
  for (const gateway of await gatewaysOf(db, orgId)) {
    const addresses = await addressesOf(gateway);
    if (addresses === null) continue;
    for (const { provider, hop } of ingress) {
      if (!inAny(hop.address, addresses)) continue;
      const seen = hop.date ?? now.toISOString();
      await db
        .prepare(
          "INSERT INTO org_receiving_chains (claim_id, org_id, gateway, provider, addresses, addresses_at, learned_at, last_seen) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7 WHERE EXISTS (SELECT 1 FROM org_domains WHERE id = ?1 AND org_id = ?2 AND state = 'verified') ON CONFLICT (claim_id, gateway, provider) DO UPDATE SET addresses = excluded.addresses, addresses_at = excluded.addresses_at, last_seen = MAX(org_receiving_chains.last_seen, excluded.last_seen)",
        )
        .bind(
          gateway.claimId,
          orgId,
          gateway.pattern,
          provider,
          JSON.stringify(addresses.slice(0, 256)),
          now.toISOString(),
          seen,
        )
        .run();
      learned++;
    }
  }
  return learned;
}
