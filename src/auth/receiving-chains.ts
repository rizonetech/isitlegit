// Receiving chains behind a filtering gateway, learned and kept (D02 T02 §6; docs/specs/2026-10-31-receiving-chains-design.md).
// A chain is learned from the organisation's own forwarded originals: the provider's ingress hop records the address it
// received the message from, and when the gateway's rules (its MX hosts' addresses, then its sending domain's SPF, in
// order) pass that address, the chain is stored for the claim whose receiver the gateway is. A case is read with the
// chains stored before it, never with one its own message proved, on its first run or a retry.
import {
  type AddressRule,
  type ChainProvider,
  gatewayAddress,
  ingressOf,
  parseCidr,
  type ReceivingChain,
} from "../checks/receiving-chain";
import { DOH_URL } from "./domains";
import { MX_DEADLINE_MS, RECEIVERS_STALE_MS } from "./receivers";

// The gateway's rules are used this long before they are looked up again, in reading and in learning alike.
export const RULES_FRESH_MS = 24 * 60 * 60 * 1000;
// At most this many DNS lookups per case, all gateways together (RFC 7208's limit for one SPF evaluation, 4.6.4), and
// no lookup started after CHAIN_DEADLINE_MS: two lookups' worth, as receivers are learned, so the checks keep their time.
export const MAX_CHAIN_LOOKUPS = 10;
export const CHAIN_DEADLINE_MS = 2 * MX_DEADLINE_MS;
// At most this many rules are kept for a gateway; more makes its discovery incomplete.
export const MAX_RULES = 256;
// An ingress date more than this far ahead of the clock is not believed.
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;
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

// A gateway as the organisation's receivers name it: its MX hosts, and the sending domain under them (the `*.<site>`
// pattern `receiversOf` adds), from the claim's `other` rows.
export type Gateway = { claimId: string; pattern: string; hosts: string[]; site: string | null };
// What discovery found: the rules, and whether they are all of them (no lookup failed, none was cut by a limit).
export type Discovered = { rules: AddressRule[]; complete: boolean };

// One case's lookups: every gateway's discovery shares MAX_CHAIN_LOOKUPS and CHAIN_DEADLINE_MS, and a gateway is
// discovered at most once per case, whoever asks.
export function caseLookups(resolve: Resolve, now: () => number = Date.now) {
  const started = now();
  let left = MAX_CHAIN_LOOKUPS;
  const ask = async (name: string, type: "A" | "AAAA" | "TXT" | "MX"): Promise<string[] | "cut" | null> => {
    if (left <= 0 || now() - started >= CHAIN_DEADLINE_MS) return "cut";
    left--;
    return resolve(name, type);
  };
  const memo = new Map<string, Promise<Discovered>>();
  const discover = (gateway: Gateway) => {
    const key = `${gateway.claimId} ${gateway.pattern}`;
    let pending = memo.get(key);
    if (!pending) {
      pending = gatewayRules(gateway, ask);
      memo.set(key, pending);
    }
    return pending;
  };
  return { discover, lookupsLeft: () => left };
}
export type CaseLookups = ReturnType<typeof caseLookups>;

// The gateway's rules in evaluation order: its MX hosts' addresses (its own, so passing), then its sending domain's SPF
// read as RFC 7208 orders it: each term's qualifier kept (only `+` passes), an `include` as nested rules that match only
// when they pass, `redirect` followed when nothing else is given, `+all` refused as proving nothing. Incomplete when a
// lookup failed, was cut by the case's limits, or the rules passed MAX_RULES.
async function gatewayRules(
  gateway: Gateway,
  ask: (name: string, type: "A" | "AAAA" | "TXT" | "MX") => Promise<string[] | "cut" | null>,
): Promise<Discovered> {
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
      else if (name === "include") out.push({ include: await spf(arg.toLowerCase()) });
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

type Row = {
  claim_id: string;
  gateway: string;
  provider: ChainProvider;
  status: "proven" | "unverified";
  rules: string;
  rules_at: string;
  learned_case: string;
};
const stored = async (db: D1Database, orgId: string) =>
  (
    await db
      .prepare(
        "SELECT claim_id, gateway, provider, status, rules, rules_at, learned_case FROM org_receiving_chains WHERE org_id = ? ORDER BY claim_id, gateway, provider",
      )
      .bind(orgId)
      .all<Row>()
  ).results;
const keyOf = (claimId: string, gateway: string) => `${claimId} ${gateway}`;

// A gateway's rules for this case: a stored row's while fresh (no DNS), else discovered under the case's limits.
async function rulesFor(gateway: Gateway, rows: Row[], lookups: CaseLookups, now: Date): Promise<Discovered> {
  const fresh = new Date(now.getTime() - RULES_FRESH_MS).toISOString();
  const cached = rows.find(
    (r) =>
      keyOf(r.claim_id, r.gateway) === keyOf(gateway.claimId, gateway.pattern) &&
      r.status === "proven" &&
      r.rules_at >= fresh,
  );
  if (cached) return { rules: JSON.parse(cached.rules) as AddressRule[], complete: true };
  return lookups.discover(gateway);
}

// The chains a case is read with: those stored for the organisation's verified claims whose gateway is still among the
// claim's receivers, seen within RECEIVERS_STALE_MS, and not learned by this same case (so a retry reads what its first
// run read); the others are deleted. A proven chain whose rules are older than RULES_FRESH_MS is looked up again, and
// is unverified for this case when that is incomplete; an unverified row says the last discovery was incomplete.
export async function chainsForOrg(
  db: D1Database,
  orgId: string,
  caseId: string,
  lookups: CaseLookups,
  now = new Date(),
): Promise<ReceivingChain[]> {
  const stale = new Date(now.getTime() - RECEIVERS_STALE_MS).toISOString();
  await db
    .prepare(
      "DELETE FROM org_receiving_chains WHERE org_id = ?1 AND (last_seen < ?2 OR NOT EXISTS (SELECT 1 FROM org_receivers r JOIN org_domains d ON d.id = r.claim_id AND d.state = 'verified' WHERE r.claim_id = org_receiving_chains.claim_id AND r.kind = 'other' AND r.pattern = org_receiving_chains.gateway))",
    )
    .bind(orgId, stale)
    .run();
  const rows = (await stored(db, orgId)).filter((r) => r.learned_case !== caseId);
  if (rows.length === 0) return [];
  const gateways = await gatewaysOf(db, orgId);
  const chains: ReceivingChain[] = [];
  for (const row of rows) {
    const base = { gateway: row.gateway, provider: row.provider };
    if (row.status === "unverified") {
      chains.push({ ...base, rules: [], unverified: true });
      continue;
    }
    const gateway = gateways.find((g) => g.claimId === row.claim_id && g.pattern === row.gateway);
    const found = gateway ? await rulesFor(gateway, [row], lookups, now) : { rules: [], complete: false };
    if (!found.complete) {
      chains.push({ ...base, rules: [], unverified: true });
      continue;
    }
    if (found.rules !== undefined && JSON.stringify(found.rules) !== row.rules)
      await db
        .prepare(
          "UPDATE org_receiving_chains SET rules = ?4, rules_at = ?5 WHERE claim_id = ?1 AND gateway = ?2 AND provider = ?3 AND status = 'proven'",
        )
        .bind(row.claim_id, row.gateway, row.provider, JSON.stringify(found.rules), now.toISOString())
        .run();
    chains.push({ ...base, rules: found.rules });
  }
  return chains;
}

// Learns from one case's original, only one a member forwarded by email (an uploaded file's headers are the file's,
// and set no trust for the organisation), and only from an ingress hop with a valid date no later than a day ahead.
// For each provider whose ingress hop the gateway's rules pass, the chain is proven for that gateway's claim; when
// they do not pass and its discovery was incomplete, an unverified row records that the route could not be told.
// `last_seen` moves only forward, to the ingress hop's date, so a replayed case renews nothing.
export async function learnChains(
  db: D1Database,
  orgId: string,
  caseId: string,
  channel: "email" | "upload",
  headers: readonly { name: string; value: string }[],
  lookups: CaseLookups,
  now = new Date(),
): Promise<number> {
  if (channel !== "email") return 0;
  const ingress = PROVIDERS.flatMap((provider) => {
    const hop = ingressOf(headers, provider);
    if (hop === null || hop === "unprovable" || hop.date === null) return [];
    if (Date.parse(hop.date) > now.getTime() + FUTURE_SLACK_MS) return [];
    return [{ provider, address: hop.address, date: hop.date }];
  });
  if (ingress.length === 0) return 0;
  const rows = await stored(db, orgId);
  let written = 0;
  for (const gateway of await gatewaysOf(db, orgId)) {
    const found = await rulesFor(gateway, rows, lookups, now);
    for (const { provider, address, date } of ingress) {
      const passes = gatewayAddress(address, found.rules) === true;
      if (!passes && found.complete) continue;
      const status = passes ? "proven" : "unverified";
      await db
        .prepare(
          `INSERT INTO org_receiving_chains (claim_id, org_id, gateway, provider, status, rules, rules_at, learned_at, learned_case, last_seen)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9 WHERE EXISTS (SELECT 1 FROM org_domains WHERE id = ?1 AND org_id = ?2 AND state = 'verified')
           ON CONFLICT (claim_id, gateway, provider) DO UPDATE SET
             status = CASE WHEN excluded.status = 'proven' OR org_receiving_chains.status = 'unverified' THEN excluded.status ELSE org_receiving_chains.status END,
             rules = CASE WHEN excluded.status = 'proven' THEN excluded.rules ELSE org_receiving_chains.rules END,
             rules_at = CASE WHEN excluded.status = 'proven' THEN excluded.rules_at ELSE org_receiving_chains.rules_at END,
             last_seen = MAX(org_receiving_chains.last_seen, excluded.last_seen)`,
        )
        .bind(
          gateway.claimId,
          orgId,
          gateway.pattern,
          provider,
          status,
          JSON.stringify(passes ? found.rules : []),
          now.toISOString(),
          caseId,
          date,
        )
        .run();
      written++;
    }
  }
  return written;
}
