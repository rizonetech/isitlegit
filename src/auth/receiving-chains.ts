// Receiving chains behind a filtering gateway (D02 T02 §6; docs/specs/2026-10-31-receiving-chains-design.md). A chain
// is read from the organisation's own DNS, never from a message: the verified claim's MX names the gateway, and the
// claim's own records name the provider it hands mail to (Microsoft 365's `MS=ms…` domain verification record or SPF
// `include:spf.protection.outlook.com`; Google Workspace's SPF `include:_spf.google.com`). The gateway's addresses are
// its MX hosts' and its sending domain's SPF, read in order. Each message is then judged by its own provider ingress
// hop (src/checks/receiving-chain.ts): a chain trusts nothing a message did not come through the gateway for.
import { type AddressRule, type ChainProvider, parseCidr, type ReceivingChain } from "../checks/receiving-chain";
import { DOH_URL } from "./domains";
import { MX_DEADLINE_MS } from "./receivers";

// A proven chain's rules are used this long before they are looked up again; an unverified one is looked up again on
// the next case.
export const RULES_FRESH_MS = 24 * 60 * 60 * 1000;
// At most this many DNS lookups per case, all gateways together (RFC 7208's limit for one SPF evaluation, 4.6.4), and
// no lookup started after CHAIN_DEADLINE_MS: two lookups' worth, as receivers are learned, so the checks keep their time.
export const MAX_CHAIN_LOOKUPS = 10;
export const CHAIN_DEADLINE_MS = 2 * MX_DEADLINE_MS;
// At most this many rules are kept for a gateway; more makes its discovery incomplete.
export const MAX_RULES = 256;
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

// A gateway as the organisation's receivers name it: its MX hosts, the sending domain under them (the `*.<site>`
// pattern `receiversOf` adds), and the claimed domain whose MX it is.
export type Gateway = { claimId: string; domain: string; pattern: string; hosts: string[]; site: string | null };
// What discovery found: the rules, and whether they are all of them (no lookup failed, none was cut by a limit).
export type Discovered = { rules: AddressRule[]; complete: boolean };
type Ask = (name: string, type: "A" | "AAAA" | "TXT" | "MX") => Promise<string[] | "cut" | null>;

// One case's lookups: every gateway's discovery shares MAX_CHAIN_LOOKUPS and CHAIN_DEADLINE_MS, and a gateway is
// discovered at most once per case.
export function caseLookups(resolve: Resolve, now: () => number = Date.now) {
  const started = now();
  let left = MAX_CHAIN_LOOKUPS;
  const ask: Ask = async (name, type) => {
    if (left <= 0 || now() - started >= CHAIN_DEADLINE_MS) return "cut";
    left--;
    return resolve(name, type);
  };
  const memo = new Map<string, Promise<Discovered>>();
  const discover = (gateway: Pick<Gateway, "claimId" | "pattern" | "hosts" | "site">) => {
    const key = `${gateway.claimId} ${gateway.pattern}`;
    let pending = memo.get(key);
    if (!pending) {
      pending = gatewayRules(gateway, ask);
      memo.set(key, pending);
    }
    return pending;
  };
  return { ask, discover };
}
export type CaseLookups = ReturnType<typeof caseLookups>;

// The providers a claimed domain's own DNS names: Microsoft 365's domain verification record (`MS=ms` and digits) or
// its SPF include, Google Workspace's SPF include. Incomplete when the lookup failed or was cut.
export async function providersOf(
  domain: string,
  ask: Ask,
): Promise<{ providers: ChainProvider[]; complete: boolean }> {
  const txt = await ask(domain, "TXT");
  if (txt === null || txt === "cut") return { providers: [], complete: false };
  const found = new Set<ChainProvider>();
  for (const record of txt) {
    if (/^MS=ms\d+$/i.test(record.trim())) found.add("microsoft");
    if (!/^v=spf1(?:\s|$)/i.test(record)) continue;
    const terms = record.toLowerCase().split(/\s+/);
    if (terms.some((t) => /^\+?include:spf\.protection\.outlook\.com$/.test(t))) found.add("microsoft");
    if (terms.some((t) => /^\+?include:_spf\.google\.com$/.test(t))) found.add("google");
  }
  return { providers: PROVIDERS.filter((p) => found.has(p)), complete: true };
}

async function gatewayRules(gateway: Pick<Gateway, "hosts" | "site">, ask: Ask): Promise<Discovered> {
  let complete = true;
  let count = 0;
  const answers = async (name: string, type: "A" | "AAAA" | "TXT" | "MX") => {
    const answer = await ask(name, type);
    if (answer === null || answer === "cut") {
      complete = false;
      return [];
    }
    return answer;
  };
  const rule = (cidr: string, pass: boolean): AddressRule[] => {
    if (!parseCidr(cidr) || count >= MAX_RULES) {
      if (count >= MAX_RULES) complete = false;
      return [];
    }
    count++;
    return [{ cidr: cidr.toLowerCase(), pass }];
  };
  const hostRules = async (host: string, pass: boolean, v4 = "", v6 = "") => [
    ...(await answers(host, "A")).flatMap((a) => rule(v4 ? `${a}/${v4}` : a, pass)),
    ...(await answers(host, "AAAA")).flatMap((a) => rule(v6 ? `${a}/${v6}` : a, pass)),
  ];
  const rules: AddressRule[] = [];
  for (const host of gateway.hosts) rules.push(...(await hostRules(host, true)));
  const seen = new Set<string>();
  const spf = async (domain: string): Promise<AddressRule[]> => {
    if (seen.has(domain)) return [];
    seen.add(domain);
    const record = (await answers(domain, "TXT")).find((t) => /^v=spf1(?:\s|$)/i.test(t));
    if (!record) return [];
    const out: AddressRule[] = [];
    let redirect: string | null = null;
    for (const term of record.split(/\s+/).slice(1)) {
      const qualifier = /^[+\-~?]/.test(term) ? term[0] : "+";
      const body = /^[+\-~?]/.test(term) ? term.slice(1) : term;
      const pass = qualifier === "+";
      const name = (body.split(/[:=/]/)[0] ?? "").toLowerCase();
      const arg = body.includes(":") ? body.slice(body.indexOf(":") + 1) : "";
      if (name === "ip4" || name === "ip6") out.push(...rule(arg, pass));
      else if (name === "include") out.push({ include: await spf(arg.toLowerCase()), pass });
      else if (name === "a" || name === "mx") {
        const [target, len4, len6] = (arg || domain).split("/");
        const cidr4 = body.includes(":") ? (len4 ?? "") : (body.split("/")[1] ?? "");
        const cidr6 = body.includes(":") ? (len6 ?? "") : (body.split("/")[2] ?? "");
        if (name === "a") out.push(...(await hostRules(target || domain, pass, cidr4, cidr6)));
        else
          for (const host of await answers(target || domain, "MX"))
            out.push(...(await hostRules(host, pass, cidr4, cidr6)));
      } else if (name === "all") {
        // `+all` passes every address, so it proves nothing about the gateway; any other `all` passes none.
        out.push(...rule("0.0.0.0/0", false), ...rule("::/0", false));
      } else if (body.toLowerCase().startsWith("redirect=")) redirect = body.slice(9).toLowerCase();
      else if (name === "exists" || name === "ptr") {
        // Not evaluated here: a term that could match an address unseen makes the rules incomplete.
        complete = false;
      }
    }
    if (redirect && !record.split(/\s+/).some((t) => /^[+\-~?]?all$/i.test(t))) out.push(...(await spf(redirect)));
    return out;
  };
  if (gateway.site) rules.push(...(await spf(gateway.site)));
  return { rules, complete };
}

// The organisation's gateways: each verified claim's `other` receivers, its hosts, its sending domain and the claimed
// domain itself.
async function gatewaysOf(db: D1Database, orgId: string): Promise<Gateway[]> {
  const rows = await db
    .prepare(
      "SELECT r.claim_id, d.domain, r.pattern FROM org_receivers r JOIN org_domains d ON d.id = r.claim_id AND d.state = 'verified' WHERE d.org_id = ? AND r.kind = 'other' ORDER BY r.claim_id, r.pattern",
    )
    .bind(orgId)
    .all<{ claim_id: string; domain: string; pattern: string }>();
  const byClaim = new Map<string, { domain: string; hosts: string[]; sites: string[] }>();
  for (const row of rows.results) {
    const entry = byClaim.get(row.claim_id) ?? { domain: row.domain, hosts: [], sites: [] };
    if (row.pattern.startsWith("*.")) entry.sites.push(row.pattern.slice(2));
    else entry.hosts.push(row.pattern);
    byClaim.set(row.claim_id, entry);
  }
  // One gateway per sending domain, named by its `*.<site>` pattern, the hosts under it its MX hosts.
  const gateways: Gateway[] = [];
  for (const [claimId, { domain, hosts, sites }] of byClaim)
    for (const site of sites)
      gateways.push({
        claimId,
        domain,
        pattern: `*.${site}`,
        hosts: hosts.filter((h) => h === site || h.endsWith(`.${site}`)),
        site,
      });
  return gateways;
}

type Row = { provider: ChainProvider; status: "proven" | "unverified"; rules: string; rules_at: string };

// The chains a case is read with, for each gateway of the organisation's verified claims: a proven chain's stored rules
// while fresh (no DNS), otherwise the claim's providers and the gateway's rules discovered again under the case's
// limits and stored. A chain is proven only from complete discovery; an incomplete one is `unverified` for each
// provider the claim names (or both, when even that could not be read), so a lookup failure is never a bypass. A
// gateway that is no longer the claim's receiver, or a provider the claim no longer names, keeps no chain.
export async function chainsForOrg(
  db: D1Database,
  orgId: string,
  lookups: CaseLookups,
  now = new Date(),
): Promise<ReceivingChain[]> {
  await db
    .prepare(
      "DELETE FROM org_receiving_chains WHERE org_id = ?1 AND NOT EXISTS (SELECT 1 FROM org_receivers r JOIN org_domains d ON d.id = r.claim_id AND d.state = 'verified' WHERE r.claim_id = org_receiving_chains.claim_id AND r.kind = 'other' AND r.pattern = org_receiving_chains.gateway)",
    )
    .bind(orgId)
    .run();
  const fresh = new Date(now.getTime() - RULES_FRESH_MS).toISOString();
  const chains: ReceivingChain[] = [];
  for (const gateway of await gatewaysOf(db, orgId)) {
    const rows = (
      await db
        .prepare(
          "SELECT provider, status, rules, rules_at FROM org_receiving_chains WHERE claim_id = ? AND gateway = ? ORDER BY provider",
        )
        .bind(gateway.claimId, gateway.pattern)
        .all<Row>()
    ).results;
    const base = (provider: ChainProvider) => ({ gateway: gateway.pattern, provider });
    if (rows.length > 0 && rows.every((r) => r.status === "proven" && r.rules_at >= fresh)) {
      for (const r of rows) chains.push({ ...base(r.provider), rules: JSON.parse(r.rules) as AddressRule[] });
      continue;
    }
    const named = await providersOf(gateway.domain, lookups.ask);
    const found = await lookups.discover(gateway);
    const complete = named.complete && found.complete;
    const providers = named.complete ? named.providers : PROVIDERS;
    const status = complete ? "proven" : "unverified";
    const at = now.toISOString();
    await db.batch([
      db
        .prepare("DELETE FROM org_receiving_chains WHERE claim_id = ? AND gateway = ?")
        .bind(gateway.claimId, gateway.pattern),
      ...providers.map((provider) =>
        db
          .prepare(
            "INSERT INTO org_receiving_chains (claim_id, org_id, gateway, provider, status, rules, rules_at, learned_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7 WHERE EXISTS (SELECT 1 FROM org_domains WHERE id = ?1 AND org_id = ?2 AND state = 'verified')",
          )
          .bind(
            gateway.claimId,
            orgId,
            gateway.pattern,
            provider,
            status,
            JSON.stringify(complete ? found.rules : []),
            at,
          ),
      ),
    ]);
    for (const provider of providers)
      chains.push(
        complete ? { ...base(provider), rules: found.rules } : { ...base(provider), rules: [], unverified: true },
      );
  }
  return chains;
}
