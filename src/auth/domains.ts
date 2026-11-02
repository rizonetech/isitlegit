// Domain and sending-address verification (D07 T02 §5; spec 4.1, 4.8); the sender lookup it feeds is in ./senders.
//
// An owner or admin claims a domain (held in its registrable form) or a single sending address for the active
// organisation, then proves control: a domain by a DNS TXT record or a code mailed to admin@ or postmaster@ it, an
// address by a code mailed to it. Every read and change names the active organisation, so another organisation's claim
// reads as missing. A claim's challenge is one live code, stored hashed and bound to its claim and organisation: a new
// code replaces the old, and none is sent while the code is locked. A guess is one transaction that takes one of three
// attempts (the third setting the lock), consumes a right code and verifies the claim, so concurrent guesses cannot pass
// three and a failure loses nothing. The limits (pending claims an organisation; codes a claim an hour; codes an
// organisation an hour and a day) are each checked in the statement that would exceed them. Removing a claim deletes it
// with its code and token, so nothing stale can restore it. Codes go out as mail kind `claim`, which the recipient
// allowlist admits only to a pending claim (src/mail/allowlist.ts). A database failure answers 503 to retry, never as
// another organisation's claim.
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { Checker } from "../db/checker";
import { clientIp, recordAuthEvent } from "./audit";
import { type MailOutcome, sendClaimCode } from "./claim-mail";
import type { AddressClaimView, DomainClaimView } from "./domain-claim";
import { requireSession } from "./gate";
import { type OrgEnv, requireOrg } from "./org";
import { isProtectedAccount, isProtectedOrganisation, PROTECTED_ACCOUNT } from "./protected";
import { learnReceivers } from "./receivers";
import { claimable, findMemberBySender, OWN_DOMAIN, registrable } from "./senders";

export type { AddressClaimView, DomainClaimView };
export { findMemberBySender, registrable };

export const DOH_URL = "https://cloudflare-dns.com/dns-query";
export const DOH_DEADLINE_MS = 10_000;
const CODE_LIFETIME_MS = 30 * 60_000;
const LOCK_MS = 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const MAX_ATTEMPTS = 3;
const CODES_PER_HOUR = 5;
// An organisation's own claim mail, over all its claims (removed ones included): bounds the mail an owner can send to
// addresses they do not control by claiming, removing and claiming again.
const ORG_CODES_PER_HOUR = 20;
const ORG_CODES_PER_DAY = 50;
const DAY_MS = 24 * HOUR_MS;
const SENDING_NOW = "the last code is still being sent; check the inbox before asking for another";
const ORG_LIMIT = `at most ${ORG_CODES_PER_HOUR} codes an hour and ${ORG_CODES_PER_DAY} a day for an organisation; try again later`;
// How long a claim's code may still be on its way: a mail send's whole life, three attempts of 30 seconds and their
// backoff (src/mail/smtp2go.ts), with room. No new code is issued while the last one, issued this recently, has not
// finished being mailed, so a second press cannot replace a code still on its way (D07 T02 §15); a send stuck longer
// (its Worker gone) no longer holds the claim.
export const CODE_SEND_WINDOW_MS = 2 * 60_000;
const PENDING_DOMAINS = 10;
const PENDING_ADDRESSES = 20;

const encoder = new TextEncoder();
const sha256Hex = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const randomHex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const sixDigits = () => String((crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % 1_000_000).padStart(6, "0");

const Address = z.string().trim().toLowerCase().email().max(254);

type Domain = { id: string; org_id: string; domain: string; token: string; state: string };
type AddressRow = { id: string; org_id: string; address: string; state: string };

const problem = (status: 400 | 403 | 404 | 409 | 429 | 502 | 503, error: string) =>
  Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
const unavailable = () => problem(503, "that could not be done just now; try again in a moment");
// The protected live accounts' organisations keep their claims (AGENTS.md, Protected live test accounts): an organisation
// that is protected, or that one of the protected accounts belongs to, has no domain or address removed through any path.
export async function keptForTesting(db: D1Database, orgId: string): Promise<boolean> {
  if (isProtectedOrganisation(orgId)) return true;
  const emails = await db
    .prepare(
      'SELECT lower(u.email) AS email FROM "member" m JOIN "user" u ON u.id = m."userId" WHERE m."organizationId" = ?',
    )
    .bind(orgId)
    .all<{ email: string }>();
  return emails.results.some((row) => isProtectedAccount(row.email));
}
const keptAnswer = () =>
  Response.json(
    {
      error: "this organisation is kept for testing; its domains and addresses are not removed",
      code: PROTECTED_ACCOUNT,
    },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
const isUnique = (error: unknown) => /UNIQUE/i.test(String((error as Error)?.message ?? error));

// A request body's fields: unparsable JSON is null, and any JSON (null, an array, a string) reads every field as
// undefined, which each route refuses with a 400.
const bodyOf = async (c: Context<OrgEnv>) => (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

// The write that verifies a claim, once, if it is still pending, recording the member whose request proved it (D07 T02
// §24). A domain also records its method; an address has none.
const verifySql = (table: "org_domains" | "org_addresses") =>
  table === "org_domains"
    ? "UPDATE org_domains SET state = 'verified', verified_at = ?, method = ?, verified_by = ? WHERE id = ? AND state = 'pending' AND org_id IN (SELECT id FROM \"organization\" WHERE \"closedAt\" IS NULL)"
    : "UPDATE org_addresses SET state = 'verified', verified_at = ?, verified_by = ? WHERE id = ? AND state = 'pending' AND org_id IN (SELECT id FROM \"organization\" WHERE \"closedAt\" IS NULL)";
const verifyBinds = (
  table: "org_domains" | "org_addresses",
  at: string,
  method: "dns" | "email",
  by: string,
  id: string,
) => (table === "org_domains" ? [at, method, by, id] : [at, by, id]);

// The verifier as one SQL expression over a claim's columns (D07 T02 §24): the member's name, else their email, while
// they are still a member of the claim's organisation; an empty string when `verified_by` is set and that user is not
// (a member since gone); null when none was recorded. `verifiedByOf` makes the report header's `Checker` of the two.
export const verifierSql = (by: string, org: string) =>
  `CASE WHEN ${by} IS NULL THEN NULL ELSE COALESCE((SELECT COALESCE(NULLIF(trim(u.name), ''), u.email) FROM "user" u
    JOIN "member" m ON m."userId" = u.id WHERE m."organizationId" = ${org} AND u.id = ${by} LIMIT 1), '') END`;
// The verifier's email as one SQL expression over a claim's columns (D07 T04 §29, read-only): the same join as
// `verifierSql`, so the page can name the verifier's address without ever reading the raw user id. Null when
// `verified_by` is unset or that user is gone from the claim's organisation.
export const verifierEmailSql = (by: string, org: string) =>
  `CASE WHEN ${by} IS NULL THEN NULL ELSE (SELECT u.email FROM "user" u
    JOIN "member" m ON m."userId" = u.id WHERE m."organizationId" = ${org} AND u.id = ${by} LIMIT 1) END`;
// The verifier's display name as one SQL expression (D07 T04 §29, read-only): the same join, the blank name as null.
// Together with `verifierSql` (name, else email, else gone) this preserves the distinction an `@` in a display name
// would erase: a member named "Thandi @ Accounts" is still named, not email-only.
export const verifierNameSql = (by: string, org: string) =>
  `CASE WHEN ${by} IS NULL THEN NULL ELSE (SELECT NULLIF(trim(u.name), '') FROM "user" u
    JOIN "member" m ON m."userId" = u.id WHERE m."organizationId" = ${org} AND u.id = ${by} LIMIT 1) END`;
export const verifiedByOf = (name: string | null): Checker =>
  name === null ? null : name ? { kind: "member", name } : { kind: "former" };

type Verified = "verified" | "gone" | "taken" | "unavailable";
// Verifies a claim found by DNS, if it still exists and is pending; its waiting code goes with it.
async function verifyByDns(db: D1Database, id: string, by: string): Promise<Verified> {
  try {
    const done = await db.batch([
      db.prepare(verifySql("org_domains")).bind(...verifyBinds("org_domains", new Date().toISOString(), "dns", by, id)),
      db.prepare("DELETE FROM verification_codes WHERE claim_id = ?").bind(id),
    ]);
    if ((done[0]?.meta.changes ?? 0) === 1) return "verified";
    // Verified meanwhile by its emailed code: the claim is verified all the same.
    const state = await db.prepare("SELECT state FROM org_domains WHERE id = ?").bind(id).first<{ state: string }>();
    return state?.state === "verified" ? "verified" : "gone";
  } catch (error) {
    return isUnique(error) ? "taken" : "unavailable";
  }
}

// One code's challenge, counted against its allowance: a domain claim's five an hour are shared by admin@ and
// postmaster@ and kept by organisation and domain, so removing and re-adding does not reset them.
const allowanceOf = (claim: { domain?: string; address?: string }) =>
  claim.domain ? `domain:${claim.domain}` : `address:${claim.address}`;

// A new code for a claim, replacing any earlier one; a lock in force stays. The hourly limit is checked in the
// statement that records the send, and the code is written only if that send was recorded.
// Why a code was not issued: the claim is gone, its code is locked (a code sent now would expire before the lock
// ends), its own hourly allowance is spent, or the organisation's is.
type NotIssued = "gone" | "locked" | "limit" | "busy" | "sending";
// A claim's last code still on its way: issued within the window (its expiry is CODE_LIFETIME_MS after issue) and its
// mail not finished, whether the send row is pending or not written yet. Claim mail is keyed `claim:<claim>:<code>`
// (src/auth/claim-mail.ts). The code row is written in the same transaction that records the send, so two presses at
// once cannot both pass: the second sees the first's code (round 3).
const SENDING =
  "SELECT 1 FROM verification_codes vc WHERE vc.claim_id = ? AND vc.expires_at > ? AND NOT EXISTS (SELECT 1 FROM mail_sends ms WHERE ms.send_key = 'claim:' || vc.claim_id || ':' || vc.code_id AND ms.status <> 'pending')";
const PENDING_CLAIM =
  "SELECT 1 FROM org_domains WHERE id = ? AND org_id = ? AND state = 'pending' UNION ALL SELECT 1 FROM org_addresses WHERE id = ? AND org_id = ? AND state = 'pending'";

async function issueCode(
  db: D1Database,
  orgId: string,
  claimId: string,
  allowance: string,
): Promise<{ code: string; codeId: string; expiresAt: Date } | NotIssued> {
  const now = Date.now();
  const at = new Date(now).toISOString();
  const hourAgo = new Date(now - HOUR_MS).toISOString();
  const dayAgo = new Date(now - DAY_MS).toISOString();
  const code = sixDigits();
  const codeId = crypto.randomUUID();
  // The send is recorded only while the claim is still pending (a removal or a verification under way wins), its code
  // is not locked, and every limit has room; the code is written only if the send was.
  const [counted] = await db.batch([
    db
      .prepare(
        `INSERT INTO verification_sends (id, org_id, target, sent_at) SELECT ?, ?, ?, ? WHERE EXISTS (${PENDING_CLAIM}) AND NOT EXISTS (${SENDING}) AND NOT EXISTS (SELECT 1 FROM verification_codes WHERE claim_id = ? AND locked_until > ?) AND (SELECT COUNT(*) FROM verification_sends WHERE org_id = ? AND target = ? AND sent_at > ?) < ? AND (SELECT COUNT(*) FROM verification_sends WHERE org_id = ? AND sent_at > ?) < ? AND (SELECT COUNT(*) FROM verification_sends WHERE org_id = ? AND sent_at > ?) < ?`,
      )
      .bind(
        crypto.randomUUID(),
        orgId,
        allowance,
        at,
        claimId,
        orgId,
        claimId,
        orgId,
        claimId,
        new Date(now + CODE_LIFETIME_MS - CODE_SEND_WINDOW_MS).toISOString(),
        claimId,
        at,
        orgId,
        allowance,
        hourAgo,
        CODES_PER_HOUR,
        orgId,
        hourAgo,
        ORG_CODES_PER_HOUR,
        orgId,
        dayAgo,
        ORG_CODES_PER_DAY,
      ),
    db
      .prepare(
        "INSERT INTO verification_codes (claim_id, org_id, code_id, code_hash, expires_at, attempts, locked_until) SELECT ?, ?, ?, ?, ?, 0, NULL WHERE changes() = 1 ON CONFLICT (claim_id) DO UPDATE SET code_id = excluded.code_id, code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, locked_until = NULL",
      )
      .bind(
        claimId,
        orgId,
        codeId,
        await sha256Hex(`${claimId}:${code}`),
        new Date(now + CODE_LIFETIME_MS).toISOString(),
      ),
  ]);
  if (counted?.meta.changes === 1) return { code, codeId, expiresAt: new Date(now + CODE_LIFETIME_MS) };
  if (!(await db.prepare(PENDING_CLAIM).bind(claimId, orgId, claimId, orgId).first())) return "gone";
  if (
    await db
      .prepare(SENDING)
      .bind(claimId, new Date(now + CODE_LIFETIME_MS - CODE_SEND_WINDOW_MS).toISOString())
      .first()
  )
    return "sending";
  const wait = await nextCodeAt(db, orgId, claimId, allowance);
  return wait.locked ? "locked" : wait.target ? "limit" : "busy";
}

// When the next code may be sent for a claim, and what holds it back: the code's lock, the claim's own hourly
// allowance, or the organisation's hourly and daily ones. Null when one may be sent now.
async function nextCodeAt(db: D1Database, orgId: string, claimId: string, allowance: string) {
  const now = Date.now();
  const at = new Date(now).toISOString();
  const [lock, target, org] = await db.batch<{ until: string | null; n: number }>([
    db
      .prepare("SELECT locked_until AS until, 0 AS n FROM verification_codes WHERE claim_id = ? AND locked_until > ?")
      .bind(claimId, at),
    db
      .prepare(
        "SELECT MIN(sent_at) AS until, COUNT(*) AS n FROM verification_sends WHERE org_id = ? AND target = ? AND sent_at > ?",
      )
      .bind(orgId, allowance, new Date(now - HOUR_MS).toISOString()),
    db
      .prepare(
        "SELECT (SELECT sent_at FROM verification_sends WHERE org_id = ?1 AND sent_at > ?2 ORDER BY sent_at LIMIT 1 OFFSET (SELECT COUNT(*) FROM verification_sends WHERE org_id = ?1 AND sent_at > ?2) - ?3) AS until, (SELECT COUNT(*) FROM verification_sends WHERE org_id = ?1 AND sent_at > ?2) AS n",
      )
      .bind(orgId, new Date(now - HOUR_MS).toISOString(), ORG_CODES_PER_HOUR),
  ]);
  const day = await db
    .prepare(
      "SELECT (SELECT sent_at FROM verification_sends WHERE org_id = ?1 AND sent_at > ?2 ORDER BY sent_at LIMIT 1 OFFSET (SELECT COUNT(*) FROM verification_sends WHERE org_id = ?1 AND sent_at > ?2) - ?3) AS until, (SELECT COUNT(*) FROM verification_sends WHERE org_id = ?1 AND sent_at > ?2) AS n",
    )
    .bind(orgId, new Date(now - DAY_MS).toISOString(), ORG_CODES_PER_DAY)
    .first<{ until: string | null; n: number }>();
  const locked = lock?.results[0]?.until ?? null;
  const targetRow = target?.results[0];
  const orgRow = org?.results[0];
  // Each limit frees a place when the send that filled it ages out of its window.
  const waits = [
    locked,
    targetRow && targetRow.n >= CODES_PER_HOUR && targetRow.until ? plus(targetRow.until, HOUR_MS) : null,
    orgRow && orgRow.n >= ORG_CODES_PER_HOUR && orgRow.until ? plus(orgRow.until, HOUR_MS) : null,
    day && day.n >= ORG_CODES_PER_DAY && day.until ? plus(day.until, DAY_MS) : null,
  ];
  const until =
    waits
      .filter((w): w is string => w !== null)
      .sort()
      .at(-1) ?? null;
  return { until, locked: locked !== null, target: waits[1] !== null };
}
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

// Checks a code and, when right, consumes it and verifies the claim in one batch, so neither happens without the other.
// A code as people type or paste it: six digits, with spaces or hyphens between them allowed ("48 21 07", "482-107"),
// leading zeroes kept; anything else is no code at all, refused without spending an attempt (D07 T02 §15).
export function normaliseClaimCode(input: string): string | null {
  const trimmed = input.trim();
  if (!/^\d(?:[ -]?\d){5}$/.test(trimmed)) return null;
  return trimmed.replace(/[ -]/g, "");
}

async function proveByCode(
  db: D1Database,
  table: "org_domains" | "org_addresses",
  orgId: string,
  claimId: string,
  typed: string,
  by: string,
): Promise<"malformed" | "locked" | "expired" | "none" | "wrong" | Verified> {
  const code = normaliseClaimCode(typed);
  if (code === null) return "malformed";
  const now = new Date().toISOString();
  // One transaction: the guess takes one of the three attempts (the third setting the lock as it is taken), then a right
  // code is consumed and the claim verified. However guesses and resends interleave, at most three are weighed and the
  // lock is never left unset; a failure rolls the whole guess back, its attempt included.
  let reserved: D1Result<{ attempts: number }> | undefined;
  let consumed: D1Result | undefined;
  let verified: D1Result | undefined;
  try {
    [reserved, consumed, verified] = (await db.batch([
      db
        .prepare(
          "UPDATE verification_codes SET attempts = CASE WHEN locked_until IS NOT NULL THEN 1 ELSE attempts + 1 END, locked_until = CASE WHEN (CASE WHEN locked_until IS NOT NULL THEN 1 ELSE attempts + 1 END) >= ? THEN ? ELSE NULL END WHERE claim_id = ? AND org_id = ? AND expires_at > ? AND ((locked_until IS NULL AND attempts < ?) OR locked_until <= ?) RETURNING attempts",
        )
        .bind(MAX_ATTEMPTS, new Date(Date.now() + LOCK_MS).toISOString(), claimId, orgId, now, MAX_ATTEMPTS, now),
      db
        .prepare("DELETE FROM verification_codes WHERE claim_id = ? AND org_id = ? AND code_hash = ? AND changes() = 1")
        .bind(claimId, orgId, await sha256Hex(`${claimId}:${code}`)),
      db.prepare(`${verifySql(table)} AND changes() = 1`).bind(...verifyBinds(table, now, "email", by, claimId)),
    ])) as [D1Result<{ attempts: number }>, D1Result, D1Result];
  } catch (error) {
    return isUnique(error) ? "taken" : "unavailable";
  }
  const taken = reserved?.results[0];
  if (!taken) {
    const row = await db
      .prepare("SELECT expires_at FROM verification_codes WHERE claim_id = ? AND org_id = ?")
      .bind(claimId, orgId)
      .first<{ expires_at: string }>();
    if (!row) return "none";
    return row.expires_at <= now ? "expired" : "locked";
  }
  if (consumed?.meta.changes === 1) return verified?.meta.changes === 1 ? "verified" : "gone";
  return taken.attempts >= MAX_ATTEMPTS ? "locked" : "wrong";
}

const verifiedAnswer = (result: Verified, body: Record<string, unknown>, what: "domain" | "address") =>
  result === "verified"
    ? Response.json({ ...body, verified: true })
    : result === "taken"
      ? problem(409, `that ${what} is verified by another organisation`)
      : result === "gone"
        ? problem(404, `no such ${what} claim`)
        : unavailable();

const codeAnswer = (
  result: Awaited<ReturnType<typeof proveByCode>>,
  body: Record<string, unknown>,
  what: "domain" | "address",
) =>
  result === "malformed"
    ? problem(400, "send the 6 digits you were mailed")
    : result === "locked"
      ? problem(429, "too many wrong codes; try again in an hour")
      : result === "expired"
        ? problem(400, "that code has expired; send another")
        : result === "none"
          ? problem(400, "no code is waiting; send one first")
          : result === "wrong"
            ? problem(400, "that code is not right")
            : verifiedAnswer(result, body, what);

const sendAnswer = (outcome: MailOutcome, body: Record<string, unknown>) =>
  outcome === "sent"
    ? Response.json({ ...body, codeSent: true })
    : outcome === "unknown"
      ? Response.json(
          { ...body, codeSent: null, message: "the code may have gone; check the inbox before sending another" },
          { status: 202 },
        )
      : problem(502, "the code could not be sent; send another");

// Each verification attempt and its outcome in the auth trail (D07 T02 §6): the claim's id, never the domain's code or
// the address itself.
// Who acts, for the shared actions below: the JSON routes and the domain page (D07 T02 §15) each build one.
// `defer` runs work after the answer has gone (the Worker's waitUntil): learning a verified domain's receivers is not
// what the owner waits for, and the checks step learns them again when they are missing (D07 T02 §15).
export type Actor = {
  db: D1Database;
  secret: string;
  orgId: string;
  userId: string;
  ip: string | null;
  defer: (work: Promise<unknown>) => void;
};
const actorOf = (c: Context<OrgEnv>): Actor => ({
  db: c.env.DB,
  secret: c.env.BETTER_AUTH_SECRET ?? "",
  orgId: c.get("org").id,
  userId: c.get("signedIn").user.id,
  ip: clientIp(c.req.raw.headers),
  defer: (work) => c.executionCtx.waitUntil(work),
});
const recordAttempt = (a: Actor, kind: "verify-domain" | "verify-address", claimId: string, outcome: string) =>
  recordAuthEvent(a.db, a.secret, { kind, outcome, orgId: a.orgId, actorId: a.userId, targetId: claimId, ip: a.ip });
const recordRemoval = (a: Actor, kind: "remove-domain" | "remove-address", claimId: string) =>
  recordAuthEvent(a.db, a.secret, {
    kind,
    outcome: "removed",
    orgId: a.orgId,
    actorId: a.userId,
    targetId: claimId,
    ip: a.ip,
  });

// DNS-over-HTTPS: verified, not yet visible, another verification value in its place (the start of the first one it
// saw, for the page to name; D07 T02 §15), or the provider failing (including the deadline).
export type TxtSeen = { state: "found" | "absent" | "failing" } | { state: "different"; seen: string };
async function lookTxt(domain: string, token: string): Promise<TxtSeen> {
  const url = `${DOH_URL}?${new URLSearchParams({ name: `_isitlegit.${domain}`, type: "TXT" })}`;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(DOH_DEADLINE_MS),
    });
    if (!response.ok) return { state: "failing" };
    const body = (await response.json()) as { Status?: unknown; Answer?: { type?: number; data?: string }[] };
    if (body.Status === 3) return { state: "absent" };
    if (body.Status !== 0) return { state: "failing" };
    const want = `isitlegit-verify=${token}`;
    const values = (body.Answer ?? [])
      .filter((a) => a.type === 16)
      .map((a) => (a.data ?? "").replace(/"\s*"/g, "").replace(/"/g, "").trim());
    if (values.includes(want)) return { state: "found" };
    const other = values.find((v) => v.startsWith("isitlegit-verify="));
    return other ? { state: "different", seen: other.slice(0, "isitlegit-verify=".length + 4) } : { state: "absent" };
  } catch {
    return { state: "failing" };
  }
}

// The verified domain's receiving systems, learned from its MX (D02 T02 §1). The verification stands whatever the lookup
// does: a failure leaves the receivers to the checks step, which learns them again when a case needs them.
async function learnedQuietly(db: D1Database, claimId: string): Promise<void> {
  try {
    await learnReceivers(db, claimId);
  } catch {
    // Nothing to undo: the receivers are learned again when missing.
  }
}

// The three actions on a domain claim, shared by the JSON routes below and the domain page (D07 T02 §15), so the two
// cannot disagree. Each names the actor's organisation, records its attempt in the auth trail and answers a typed
// outcome; a database failure throws, which each caller answers as an outage.
export type CheckOutcome =
  | { kind: "gone" }
  | { kind: "verified" | "failing" | "absent" | "taken" | "unavailable"; domain: string }
  | { kind: "different"; domain: string; seen: string };
export async function checkDomain(a: Actor, domain: string): Promise<CheckOutcome> {
  const claim = await claimedDomain(a.db, a.orgId, domain);
  if (!claim) return { kind: "gone" };
  if (claim.state === "verified") return { kind: "verified", domain: claim.domain };
  const seen = await lookTxt(claim.domain, claim.token);
  if (seen.state === "failing") {
    await recordAttempt(a, "verify-domain", claim.id, "dns-lookup-failed");
    return { kind: "failing", domain: claim.domain };
  }
  if (seen.state === "different") {
    await recordAttempt(a, "verify-domain", claim.id, "dns-different");
    return { kind: "different", domain: claim.domain, seen: seen.seen };
  }
  if (seen.state === "absent") {
    await recordAttempt(a, "verify-domain", claim.id, "dns-not-visible");
    return { kind: "absent", domain: claim.domain };
  }
  const verified = await verifyByDns(a.db, claim.id, a.userId);
  await recordAttempt(a, "verify-domain", claim.id, verified === "verified" ? "verified-dns" : verified);
  if (verified === "verified") a.defer(learnedQuietly(a.db, claim.id));
  return { kind: verified, domain: claim.domain };
}

export type SendOutcome =
  | { kind: "gone" | "already" | "bad-local" | "locked" | "limit" | "busy" | "sending" }
  | { kind: MailOutcome; domain: string; to: string };
export async function sendDomainCode(env: Env, a: Actor, domain: string, local: unknown): Promise<SendOutcome> {
  const claim = await claimedDomain(a.db, a.orgId, domain);
  if (!claim) return { kind: "gone" };
  if (claim.state === "verified") return { kind: "already" };
  if (local !== "admin" && local !== "postmaster") return { kind: "bad-local" };
  const issued = await issueCode(a.db, a.orgId, claim.id, allowanceOf({ domain: claim.domain }));
  if (typeof issued === "string") return { kind: issued };
  const to = `${local}@${claim.domain}`;
  const outcome = await sendClaimCode(env, {
    to,
    claimId: claim.id,
    codeId: issued.codeId,
    code: issued.code,
    what: claim.domain,
    kind: "domain",
    lifetimeMs: CODE_LIFETIME_MS,
    expiresAt: issued.expiresAt,
  });
  return { kind: outcome, domain: claim.domain, to };
}

export type VerifyOutcome =
  | { kind: "gone" }
  | { kind: "already" | Awaited<ReturnType<typeof proveByCode>>; domain: string };
export async function verifyDomainCode(a: Actor, domain: string, code: string): Promise<VerifyOutcome> {
  const claim = await claimedDomain(a.db, a.orgId, domain);
  if (!claim) return { kind: "gone" };
  if (claim.state === "verified") return { kind: "already", domain: claim.domain };
  const proved = await proveByCode(a.db, "org_domains", a.orgId, claim.id, code, a.userId);
  // A malformed code spends no attempt, so it is no attempt in the trail either.
  if (proved !== "malformed")
    await recordAttempt(a, "verify-domain", claim.id, proved === "verified" ? "verified-code" : proved);
  if (proved === "verified") a.defer(learnedQuietly(a.db, claim.id));
  return { kind: proved, domain: claim.domain };
}

// One domain claim as its page draws it (D07 T02 §15): its state and, while pending, the record to add, the code's
// life (when it expires, the wrong attempts so far, until when it is locked, when the next code may go) and the latest
// DNS check; never the code or its hash. Null when the organisation has not claimed it.

export async function domainClaimView(db: D1Database, orgId: string, domain: string): Promise<DomainClaimView | null> {
  const claim = await db
    .prepare(
      `SELECT id, domain, token, state, method, verified_at, ${verifierSql("verified_by", "org_id")} AS verifier FROM org_domains WHERE org_id = ? AND domain = ? AND ${claimable()}`,
    )
    .bind(orgId, domain)
    .first<Domain & { method: "dns" | "email" | null; verified_at: string | null; verifier: string | null }>();
  if (!claim) return null;
  const now = new Date().toISOString();
  const [code, check] = await Promise.all([
    db
      .prepare("SELECT expires_at, attempts, locked_until FROM verification_codes WHERE claim_id = ? AND org_id = ?")
      .bind(claim.id, orgId)
      .first<{ expires_at: string; attempts: number; locked_until: string | null }>(),
    db
      .prepare(
        "SELECT at, outcome FROM auth_events WHERE org_id = ? AND target_id = ? AND kind = 'verify-domain' AND outcome LIKE 'dns-%' ORDER BY at DESC LIMIT 1",
      )
      .bind(orgId, claim.id)
      .first<{ at: string; outcome: string }>(),
  ]);
  const locked = code?.locked_until && code.locked_until > now ? code.locked_until : null;
  return {
    domain: claim.domain,
    state: claim.state as "pending" | "verified",
    method: claim.method,
    verifiedAt: claim.verified_at,
    verifiedBy: verifiedByOf(claim.verifier),
    txt: txtFor(claim.domain, claim.token),
    code: {
      expiresAt: code && code.expires_at > now ? code.expires_at : null,
      expired: Boolean(code && code.expires_at <= now && !locked),
      attempts: code && !locked ? code.attempts : 0,
      lockedUntil: locked,
      nextCodeAt:
        claim.state === "pending"
          ? (await nextCodeAt(db, orgId, claim.id, allowanceOf({ domain: claim.domain }))).until
          : null,
    },
    lastCheck: check ?? null,
  };
}

// One of the organisation's own address claims as its page draws it, or null for none (another organisation's address
// reads as none too): the state, and for a pending one the code's challenge (D07 T04 §27).
export async function addressClaimView(
  db: D1Database,
  orgId: string,
  address: string,
): Promise<AddressClaimView | null> {
  const claim = await db
    .prepare("SELECT id, address, state, verified_at FROM org_addresses WHERE org_id = ? AND address = ?")
    .bind(orgId, address)
    .first<{ id: string; address: string; state: "pending" | "verified"; verified_at: string | null }>();
  if (!claim) return null;
  const now = new Date().toISOString();
  const code = await db
    .prepare(
      "SELECT code_id, expires_at, attempts, locked_until FROM verification_codes WHERE claim_id = ? AND org_id = ?",
    )
    .bind(claim.id, orgId)
    .first<{ code_id: string; expires_at: string; attempts: number; locked_until: string | null }>();
  const locked = code?.locked_until && code.locked_until > now ? code.locked_until : null;
  // What became of the live code's mail: its stored send, keyed as src/auth/claim-mail.ts keys it.
  const sent = code
    ? await db
        .prepare("SELECT status FROM mail_sends WHERE send_key = ?")
        .bind(`claim:${claim.id}:${code.code_id}`)
        .first<{ status: string }>()
    : null;
  const delivery: AddressClaimView["code"]["delivery"] =
    sent?.status === "sent"
      ? "sent"
      : sent?.status === "uncertain"
        ? "uncertain"
        : sent?.status === "failed" || sent?.status === "refused"
          ? "failed"
          : sent
            ? "sending"
            : null;
  return {
    address: claim.address,
    state: claim.state,
    verifiedAt: claim.verified_at,
    code: {
      expiresAt: code && code.expires_at > now ? code.expires_at : null,
      expired: Boolean(code && code.expires_at <= now && !locked),
      attempts: code && !locked ? code.attempts : 0,
      lockedUntil: locked,
      nextCodeAt:
        claim.state === "pending"
          ? (await nextCodeAt(db, orgId, claim.id, allowanceOf({ address: claim.address }))).until
          : null,
      delivery,
    },
  };
}

export const domainRoutes = new Hono<OrgEnv>();
domainRoutes.use("*", requireSession, requireOrg, async (c, next) => {
  if (!["owner", "admin"].includes(c.get("org").role)) return problem(403, "only an owner or admin manages domains");
  await next();
});
domainRoutes.onError(() => unavailable());

const txtFor = (domain: string, token: string) => ({
  name: `_isitlegit.${domain}`,
  value: `isitlegit-verify=${token}`,
});

// The challenge as a page needs it after a reload: when the code expires, until when it is locked, and when the next
// code may be sent; never the code or its hash.
async function challengeOf(db: D1Database, orgId: string, claimId: string, allowance: string) {
  const code = await db
    .prepare("SELECT expires_at, locked_until FROM verification_codes WHERE claim_id = ? AND org_id = ?")
    .bind(claimId, orgId)
    .first<{ expires_at: string; locked_until: string | null }>();
  const now = new Date().toISOString();
  return {
    codeExpiresAt: code && code.expires_at > now ? code.expires_at : null,
    lockedUntil: code?.locked_until && code.locked_until > now ? code.locked_until : null,
    nextCodeAt: (await nextCodeAt(db, orgId, claimId, allowance)).until,
  };
}

domainRoutes.get("/domains", async (c) => {
  const db = c.env.DB;
  const org = c.get("org").id;
  const domains = await db
    .prepare(
      `SELECT id, domain, token, state, method, verified_at, ${verifierSql("verified_by", "org_id")} AS verifier FROM org_domains WHERE org_id = ? AND ${claimable()} ORDER BY domain`,
    )
    .bind(org)
    .all<Domain & { method: string | null; verified_at: string | null; verifier: string | null }>();
  const domainResults = await Promise.all(
    domains.results.map(async ({ id, token, verifier, ...d }) => {
      const verifiedBy = verifiedByOf(verifier);
      return d.state === "pending"
        ? {
            ...d,
            verifiedBy,
            txt: txtFor(d.domain, token),
            ...(await challengeOf(db, org, id, allowanceOf({ domain: d.domain }))),
          }
        : { ...d, verifiedBy };
    }),
  );
  if (c.req.query("only") === "domains") return c.json({ domains: domainResults });
  const addresses = await db
    .prepare(
      `SELECT id, address, state, verified_at, ${verifierSql("verified_by", "org_id")} AS verifier FROM org_addresses WHERE org_id = ? ORDER BY address`,
    )
    .bind(org)
    .all<AddressRow & { verified_at: string | null; verifier: string | null }>();
  return c.json({
    domains: domainResults,
    addresses: await Promise.all(
      addresses.results.map(async ({ id, verifier, ...a }) => {
        const verifiedBy = verifiedByOf(verifier);
        return a.state === "pending"
          ? { ...a, verifiedBy, ...(await challengeOf(db, org, id, allowanceOf({ address: a.address }))) }
          : { ...a, verifiedBy };
      }),
    ),
  });
});

const claimedDomain = (db: D1Database, org: string, domain: string) =>
  db
    .prepare(
      `SELECT id, org_id, domain, token, state FROM org_domains WHERE org_id = ? AND domain = ? AND ${claimable()}`,
    )
    .bind(org, domain)
    .first<Domain>();
const claimedAddress = (db: D1Database, org: string, address: string) =>
  db
    .prepare("SELECT id, org_id, address, state FROM org_addresses WHERE org_id = ? AND address = ?")
    .bind(org, address)
    .first<AddressRow>();

domainRoutes.post("/domains", async (c) => {
  const db = c.env.DB;
  const org = c.get("org").id;
  const body = await bodyOf(c);
  const domain = typeof body?.domain === "string" ? registrable(body.domain) : null;
  // IsItLegit's own domain is never an organisation's (a demo organisation's is its own, under the demo suffix).
  if (!domain || domain === OWN_DOMAIN) return problem(400, "that is not a domain an organisation can claim");
  const existing = await claimedDomain(db, org, domain);
  if (existing)
    return c.json({
      domain,
      state: existing.state,
      ...(existing.state === "pending" ? { txt: txtFor(domain, existing.token) } : {}),
    });
  if (await db.prepare("SELECT 1 FROM org_domains WHERE domain = ? AND state = 'verified'").bind(domain).first())
    return problem(409, "that domain is verified by another organisation");
  // The pending limit is checked in the insert itself, so two claims at the limit cannot both get in.
  const token = randomHex(16);
  const inserted = await db
    .prepare(
      "INSERT INTO org_domains (id, org_id, domain, token, state, created_at) SELECT ?, ?, ?, ?, 'pending', ? WHERE (SELECT COUNT(*) FROM org_domains WHERE org_id = ? AND state = 'pending') < ? AND EXISTS (SELECT 1 FROM \"organization\" WHERE id = ? AND \"closedAt\" IS NULL) ON CONFLICT DO NOTHING",
    )
    .bind(crypto.randomUUID(), org, domain, token, new Date().toISOString(), org, PENDING_DOMAINS, org)
    .run();
  const claim = await claimedDomain(db, org, domain);
  if (!claim)
    return inserted.meta.changes === 0
      ? problem(429, `at most ${PENDING_DOMAINS} domains can wait for verification`)
      : unavailable();
  return c.json(
    { domain, state: claim.state, txt: txtFor(domain, claim.token) },
    inserted.meta.changes === 1 ? 201 : 200,
  );
});

domainRoutes.post("/domains/:domain/check", async (c) => {
  const checked = await checkDomain(actorOf(c), c.req.param("domain").toLowerCase());
  if (checked.kind === "gone") return problem(404, "no such domain claim");
  if (checked.kind === "verified") return c.json({ domain: checked.domain, verified: true });
  if (checked.kind === "failing")
    return problem(503, "the DNS check could not be made just now; try again in a moment");
  if (checked.kind === "absent" || checked.kind === "different")
    return c.json({
      domain: checked.domain,
      verified: false,
      message: "the record is not visible yet; DNS can take up to an hour",
    });
  return verifiedAnswer(checked.kind, { domain: checked.domain }, "domain");
});

domainRoutes.post("/domains/:domain/code", async (c) => {
  const body = await bodyOf(c);
  const sent = await sendDomainCode(c.env, actorOf(c), c.req.param("domain").toLowerCase(), body?.local);
  if ("to" in sent) return sendAnswer(sent.kind, { domain: sent.domain, to: sent.to });
  if (sent.kind === "gone") return problem(404, "no such domain claim");
  if (sent.kind === "already") return problem(409, "that domain is already verified");
  if (sent.kind === "bad-local") return problem(400, "the code goes to admin@ or postmaster@");
  if (sent.kind === "locked") return problem(429, "too many wrong codes; a new code can be sent when the lock ends");
  if (sent.kind === "limit") return problem(429, `at most ${CODES_PER_HOUR} codes a domain an hour; try again later`);
  if (sent.kind === "sending") return problem(429, SENDING_NOW);
  return problem(429, ORG_LIMIT);
});

domainRoutes.post("/domains/:domain/verify", async (c) => {
  const body = await bodyOf(c);
  if (typeof body?.code !== "string") return problem(400, "send the code you were mailed");
  const proved = await verifyDomainCode(actorOf(c), c.req.param("domain").toLowerCase(), body.code);
  if (proved.kind === "gone") return problem(404, "no such domain claim");
  if (proved.kind === "already") return c.json({ domain: proved.domain, verified: true });
  return codeAnswer(proved.kind, { domain: proved.domain }, "domain");
});

domainRoutes.delete("/domains/:domain", async (c) => {
  const org = c.get("org").id;
  if (await keptForTesting(c.env.DB, org)) return keptAnswer();
  const claim = await claimedDomain(c.env.DB, org, c.req.param("domain").toLowerCase());
  if (!claim) return problem(404, "no such domain claim");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM org_domains WHERE id = ? AND org_id = ?").bind(claim.id, org),
    c.env.DB.prepare("DELETE FROM verification_codes WHERE claim_id = ?").bind(claim.id),
    // Its receivers go with it (D02 T02 §1): a removed domain's receiving system is no longer trusted.
    c.env.DB.prepare("DELETE FROM org_receivers WHERE claim_id = ?").bind(claim.id),
    c.env.DB.prepare("DELETE FROM receiver_lookups WHERE claim_id = ?").bind(claim.id),
  ]);
  // A removal is on the trail (D07 T04 §4): who, which claim, never the domain's own text.
  await recordRemoval(actorOf(c), "remove-domain", claim.id);
  return c.body(null, 204);
});

// Claiming an address and sending its code, and proving it by the code: one function each, used by the JSON routes below
// and by the address page (src/web/pages/addresses.tsx), as the domain claim's are, so the limits, the audit rows and
// every refusal are the same whichever way a member comes (D07 T04 §27).
export type AddressOutcome =
  | { kind: "gone" | "locked" | "limit" | "busy" | "sending" | "taken-elsewhere" | "pending-limit" | "unavailable" }
  | { kind: "already"; address: string }
  | { kind: MailOutcome; address: string };
// `create`: claim the address first (Add a single address); otherwise it must already be claimed (Send a new code).
export async function sendAddressCode(env: Env, a: Actor, address: string, create: boolean): Promise<AddressOutcome> {
  const db = a.db;
  let claim = await claimedAddress(db, a.orgId, address);
  if (!claim) {
    if (!create) return { kind: "gone" };
    if (await db.prepare("SELECT 1 FROM org_addresses WHERE address = ? AND state = 'verified'").bind(address).first())
      return { kind: "taken-elsewhere" };
    const inserted = await db
      .prepare(
        "INSERT INTO org_addresses (id, org_id, address, state, created_at) SELECT ?, ?, ?, 'pending', ? WHERE (SELECT COUNT(*) FROM org_addresses WHERE org_id = ? AND state = 'pending') < ? AND EXISTS (SELECT 1 FROM \"organization\" WHERE id = ? AND \"closedAt\" IS NULL) ON CONFLICT DO NOTHING",
      )
      .bind(crypto.randomUUID(), a.orgId, address, new Date().toISOString(), a.orgId, PENDING_ADDRESSES, a.orgId)
      .run();
    claim = await claimedAddress(db, a.orgId, address);
    if (!claim) return { kind: inserted.meta.changes === 0 ? "pending-limit" : "unavailable" };
  }
  if (claim.state === "verified") return { kind: "already", address };
  const issued = await issueCode(db, a.orgId, claim.id, allowanceOf({ address }));
  if (typeof issued === "string") return { kind: issued };
  const outcome = await sendClaimCode(env, {
    to: address,
    claimId: claim.id,
    codeId: issued.codeId,
    code: issued.code,
    what: address,
    kind: "address",
    lifetimeMs: CODE_LIFETIME_MS,
    expiresAt: issued.expiresAt,
  });
  return { kind: outcome, address };
}

export type AddressVerifyOutcome =
  | { kind: "gone" }
  | { kind: "already" | Awaited<ReturnType<typeof proveByCode>>; address: string };
export async function verifyAddressCode(a: Actor, address: string, code: string): Promise<AddressVerifyOutcome> {
  const claim = await claimedAddress(a.db, a.orgId, address);
  if (!claim) return { kind: "gone" };
  if (claim.state === "verified") return { kind: "already", address: claim.address };
  const proved = await proveByCode(a.db, "org_addresses", a.orgId, claim.id, code, a.userId);
  // A malformed code spends no attempt, so it is no attempt in the trail either.
  if (proved !== "malformed")
    await recordAttempt(a, "verify-address", claim.id, proved === "verified" ? "verified-code" : proved);
  return { kind: proved, address: claim.address };
}

// Claims an address (or answers its existing claim) and sends its code.
async function addressCode(c: Context<OrgEnv>, create: boolean) {
  const parsed = Address.safeParse((await bodyOf(c))?.address);
  if (!parsed.success) return problem(400, "that is not an email address");
  const address = parsed.data;
  const done = await sendAddressCode(c.env, actorOf(c), address, create);
  switch (done.kind) {
    case "gone":
      return problem(404, "no such address claim");
    case "taken-elsewhere":
      return problem(409, "that address is verified by another organisation");
    case "pending-limit":
      return problem(429, `at most ${PENDING_ADDRESSES} addresses can wait for verification`);
    case "unavailable":
      return unavailable();
    case "already":
      return create ? c.json({ address, state: "verified" }) : problem(409, "that address is already verified");
    case "locked":
      return problem(429, "too many wrong codes; a new code can be sent when the lock ends");
    case "limit":
      return problem(429, `at most ${CODES_PER_HOUR} codes an address an hour; try again later`);
    case "busy":
      return problem(429, ORG_LIMIT);
    case "sending":
      return problem(429, SENDING_NOW);
    default:
      return sendAnswer(done.kind, { address, state: "pending" });
  }
}
domainRoutes.post("/addresses", (c) => addressCode(c, true));
domainRoutes.post("/addresses/code", (c) => addressCode(c, false));

domainRoutes.post("/addresses/verify", async (c) => {
  const body = await bodyOf(c);
  const parsed = Address.safeParse(body?.address);
  if (!parsed.success || typeof body?.code !== "string")
    return problem(400, "send the address and the code you were mailed");
  const proved = await verifyAddressCode(actorOf(c), parsed.data, body.code);
  if (proved.kind === "gone") return problem(404, "no such address claim");
  if (proved.kind === "already") return c.json({ address: proved.address, verified: true });
  return codeAnswer(proved.kind, { address: proved.address }, "address");
});

domainRoutes.delete("/addresses/:address", async (c) => {
  const org = c.get("org").id;
  if (await keptForTesting(c.env.DB, org)) return keptAnswer();
  const claim = await claimedAddress(c.env.DB, org, c.req.param("address").toLowerCase());
  if (!claim) return problem(404, "no such address claim");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM org_addresses WHERE id = ? AND org_id = ?").bind(claim.id, org),
    c.env.DB.prepare("DELETE FROM verification_codes WHERE claim_id = ?").bind(claim.id),
  ]);
  await recordRemoval(actorOf(c), "remove-address", claim.id);
  return c.body(null, 204);
});
