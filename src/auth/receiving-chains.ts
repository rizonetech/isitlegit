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
  // Every node counts toward MAX_RULES, an include as much as a range, and every term that would query DNS (`include`,
  // `a`, `mx`, `redirect`) toward MAX_CHAIN_LOOKUPS, cached or not (RFC 7208 4.6.4 counts terms, not queries): past
  // either, discovery stops at once, incomplete, so repeated includes cannot expand without end (round 3).
  let terms = 0;
  const over = () => count >= MAX_RULES || terms > MAX_CHAIN_LOOKUPS;
  const stop = () => {
    complete = false;
  };
  const rule = (cidr: string, pass: boolean): AddressRule[] => {
    if (!parseCidr(cidr)) {
      complete = false;
      return [];
    }
    if (over()) {
      stop();
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
  // Each domain's record is asked for once per discovery, but evaluated wherever it is included (RFC 7208 5.2: a
  // repeated include is evaluated again, its exclusions with it); an include of a domain already on the path is a loop,
  // which makes the rules incomplete rather than empty.
  const records = new Map<string, Promise<string[]>>();
  const txt = (domain: string) => {
    let pending = records.get(domain);
    if (!pending) {
      pending = answers(domain, "TXT");
      records.set(domain, pending);
    }
    return pending;
  };
  // One SPF record evaluated strictly (RFC 7208 4 to 6): anything this does not fully understand is an error that makes
  // the rules incomplete, never a term skipped (round 4): a domain with two records, an include or redirect whose
  // domain has none, a mechanism or argument outside the grammar, a macro, an `exists` or `ptr` (not evaluated here),
  // `+all`. A domain with no record at the top is no error: the gateway's MX addresses stand alone.
  const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  const fail = (): AddressRule[] => {
    complete = false;
    return [];
  };
  const spf = async (domain: string, path: readonly string[] = [], required = false): Promise<AddressRule[]> => {
    if (path.includes(domain)) return fail();
    if (over()) {
      stop();
      return [];
    }
    const found = (await txt(domain)).filter((t) => /^v=spf1(?:\s|$)/i.test(t));
    if (found.length > 1) return fail();
    const record = found[0];
    if (record === undefined) return required ? fail() : [];
    const out: AddressRule[] = [];
    let redirect: string | null = null;
    let sawAll = false;
    for (const term of record.trim().split(/\s+/).slice(1)) {
      if (over()) {
        stop();
        break;
      }
      if (term.includes("%")) return fail();
      const modifier = /^([a-z][a-z0-9_.-]*)=(.*)$/i.exec(term);
      if (modifier) {
        const [, key = "", value = ""] = modifier;
        if (key.toLowerCase() === "redirect") {
          if (redirect !== null || !DOMAIN.test(value.toLowerCase())) return fail();
          terms++;
          redirect = value.toLowerCase();
        } else if (key.toLowerCase() === "exp") {
          if (!DOMAIN.test(value.toLowerCase())) return fail();
        }
        // Any other modifier is ignored, as RFC 7208 6 says.
        continue;
      }
      const qualifier = /^[+\-~?]/.test(term) ? (term[0] as string) : "+";
      const body = (/^[+\-~?]/.test(term) ? term.slice(1) : term).toLowerCase();
      const pass = qualifier === "+";
      const parts = /^(all|include|a|mx|ptr|ip4|ip6|exists)(?::([^/]*))?((?:\/\d{1,3})?(?:\/\/\d{1,3})?)$/.exec(body);
      if (!parts) return fail();
      const [, mechanism = "", arg, cidrs = ""] = parts;
      if (mechanism === "ip4" || mechanism === "ip6") {
        // The address and its prefix together, validated for its family: a bad one is an error, never a drop.
        const full = `${arg ?? ""}${cidrs}`;
        const parsed = parseCidr(full);
        if (!arg || !parsed || (mechanism === "ip4") !== (parsed.bits === 32) || cidrs.includes("//")) return fail();
        out.push(...rule(full, pass));
      } else if (mechanism === "all") {
        if (arg !== undefined || cidrs) return fail();
        // `+all` passes every address and proves nothing about the gateway.
        if (pass) return fail();
        sawAll = true;
        out.push(...rule("0.0.0.0/0", false), ...rule("::/0", false));
      } else if (mechanism === "include") {
        if (!arg || cidrs || !DOMAIN.test(arg)) return fail();
        terms++;
        count++;
        out.push({ include: await spf(arg, [...path, domain], true), pass });
      } else if (mechanism === "a" || mechanism === "mx") {
        const target = arg ?? domain;
        if (arg === "" || !DOMAIN.test(target)) return fail();
        const v4 = /^\/(\d{1,3})/.exec(cidrs)?.[1] ?? "";
        const v6 = /\/\/(\d{1,3})$/.exec(cidrs)?.[1] ?? "";
        if ((v4 && Number(v4) > 32) || (v6 && Number(v6) > 128)) return fail();
        terms++;
        if (mechanism === "a") out.push(...(await hostRules(target, pass, v4, v6)));
        else for (const host of await answers(target, "MX")) out.push(...(await hostRules(host, pass, v4, v6)));
      } else {
        // `exists` and `ptr`: not evaluated here, so the rules cannot be known complete.
        return fail();
      }
    }
    if (redirect && !sawAll) out.push(...(await spf(redirect, [...path, domain], true)));
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
