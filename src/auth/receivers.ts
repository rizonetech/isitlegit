// An organisation's receiving systems (D02 T02 §1; spec 4.3): only the Authentication-Results headers its own receiver
// wrote are evidence, so the receivers are learned from each verified domain's MX records, over DNS-over-HTTPS, when the
// domain is verified and again when they are missing or stale. Each row is bound to its verified claim: removing the
// domain removes them, and a lookup that finishes after the claim went writes nothing.
import { DOH_URL } from "./domains";
import { registrable } from "./senders";

export type ReceiverKind = "microsoft" | "google" | "other";
export type Receiver = { kind: ReceiverKind; pattern: string };

// Receivers older than this are learned again by the checks step, so a domain that moved its mail is followed.
export const RECEIVERS_STALE_MS = 30 * 24 * 60 * 60 * 1000;
// One MX lookup's deadline: the checks step spends at most this per domain it learns again.
export const MX_DEADLINE_MS = 3_000;
// The most domains the checks step learns again in one case: two lookups of MX_DEADLINE_MS leave the step's 30-second
// attempt its time for the checks (MAX_CHECK_MS in src/checks/registry.ts).
export const RELEARN_DOMAINS = 2;

// The MX hosts of a domain, lowercased without the trailing dot: an empty list when it has none, null when the lookup
// failed (the provider failing, the deadline, an answer that is not DNS JSON).
export type LookupMx = (domain: string) => Promise<string[] | null>;

export const lookupMx: LookupMx = async (domain) => {
  const url = `${DOH_URL}?${new URLSearchParams({ name: domain, type: "MX" })}`;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(MX_DEADLINE_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { Status?: unknown; Answer?: { type?: number; data?: string }[] };
    if (body.Status === 3) return [];
    if (body.Status !== 0) return null;
    // An MX answer's data is `<preference> <host>.`.
    return (body.Answer ?? [])
      .filter((a) => a.type === 15 && typeof a.data === "string")
      .map((a) => (a.data ?? "").trim().split(/\s+/)[1]?.replace(/\.$/, "").toLowerCase() ?? "")
      .filter((host) => host.length > 0 && host !== ".");
  } catch {
    return null;
  }
};

// What a receiving host is: Microsoft 365 (`<tenant>.mail.protection.outlook.com`), Google (`aspmx.l.google.com`, its
// alternates, `smtp.google.com`), or another system, known by its host and the registrable domain under it.
export function receiversOf(mx: string[]): Receiver[] {
  const found = new Map<string, Receiver>();
  const add = (kind: ReceiverKind, pattern: string) => found.set(`${kind} ${pattern}`, { kind, pattern });
  for (const host of mx) {
    if (host.endsWith(".mail.protection.outlook.com")) add("microsoft", "*.outlook.com");
    else if (
      /^(?:alt\d+\.)?aspmx\.l\.google\.com$/.test(host) ||
      host === "smtp.google.com" ||
      /^aspmx\d+\.googlemail\.com$/.test(host)
    )
      add("google", "*.google.com");
    else {
      add("other", host);
      const site = registrable(host);
      if (site) add("other", `*.${site}`);
    }
  }
  return [...found.values()];
}

// Learns a verified claim's receivers and replaces its rows in one batch that writes only while the claim is still
// verified. A failed lookup keeps the rows already there; a domain with no MX keeps none. Returns what was stored, or
// null when nothing could be learned.
export async function learnReceivers(db: D1Database, claimId: string, lookup: LookupMx = lookupMx) {
  const claim = await db
    .prepare("SELECT org_id, domain FROM org_domains WHERE id = ? AND state = 'verified'")
    .bind(claimId)
    .first<{ org_id: string; domain: string }>();
  if (!claim) return null;
  const mx = await lookup(claim.domain);
  if (mx === null) return null;
  const receivers = receiversOf(mx);
  const now = new Date().toISOString();
  const verified = "EXISTS (SELECT 1 FROM org_domains WHERE id = ?1 AND state = 'verified')";
  await db.batch([
    db.prepare(`DELETE FROM org_receivers WHERE claim_id = ?1 AND ${verified}`).bind(claimId),
    ...receivers.map((r) =>
      db
        .prepare(
          `INSERT INTO org_receivers (claim_id, org_id, domain, kind, pattern, learned_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE ${verified}`,
        )
        .bind(claimId, claim.org_id, claim.domain, r.kind, r.pattern, now),
    ),
  ]);
  return receivers;
}

// The receivers of an organisation's verified claims, learning again (within RELEARN_DOMAINS lookups) the claims that
// have none or whose receivers are older than RECEIVERS_STALE_MS. A lookup that fails keeps what was there.
export async function receiversForOrg(db: D1Database, orgId: string, lookup: LookupMx = lookupMx): Promise<Receiver[]> {
  const claims = await db
    .prepare(
      "SELECT d.id, MIN(r.learned_at) AS learned FROM org_domains d LEFT JOIN org_receivers r ON r.claim_id = d.id WHERE d.org_id = ? AND d.state = 'verified' GROUP BY d.id ORDER BY learned IS NOT NULL, learned",
    )
    .bind(orgId)
    .all<{ id: string; learned: string | null }>();
  const stale = new Date(Date.now() - RECEIVERS_STALE_MS).toISOString();
  const due = claims.results.filter((c) => c.learned === null || c.learned < stale).slice(0, RELEARN_DOMAINS);
  for (const claim of due) await learnReceivers(db, claim.id, lookup);
  const rows = await db
    .prepare(
      "SELECT DISTINCT r.kind, r.pattern FROM org_receivers r JOIN org_domains d ON d.id = r.claim_id AND d.state = 'verified' WHERE d.org_id = ? ORDER BY r.kind, r.pattern",
    )
    .bind(orgId)
    .all<Receiver>();
  return rows.results;
}
