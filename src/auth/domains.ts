// Domain and sending-address verification, and the sender lookup the email handler uses (D07 T02 §5; spec 4.1, 4.8).
//
// An owner or admin claims a domain (held in its registrable form) or a single sending address for the active
// organisation, then proves control: a domain by a DNS TXT record or a code mailed to admin@ or postmaster@ it, an
// address by a code mailed to it. Every read and change names the active organisation, so another organisation's claim
// reads as missing. A claim's challenge is one live code, stored hashed and bound to its claim and organisation: a new
// code replaces the old, a lock survives a resend, and wrong guesses are counted in one statement, so concurrent
// guesses cannot pass three. A right code is consumed in the same batch that verifies the claim, so a failure loses
// neither. The limits (pending claims an organisation, codes a claim an hour) are each checked in the statement that
// would exceed them. Removing a claim deletes it with its code and token, so nothing stale can restore it. Codes go
// out as mail kind `claim`, which the recipient allowlist admits only to a pending claim (src/mail/allowlist.ts). A
// database failure answers 503 to retry, never as another organisation's claim.
import { type Context, Hono } from "hono";
import { getDomain, parse } from "tldts";
import { z } from "zod";
import { type MailOutcome, sendClaimCode } from "./claim-mail";
import { requireSession } from "./gate";
import { type OrgEnv, requireOrg } from "./org";

export const DOH_URL = "https://cloudflare-dns.com/dns-query";
export const DOH_DEADLINE_MS = 10_000;
const CODE_LIFETIME_MS = 30 * 60_000;
const LOCK_MS = 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const MAX_ATTEMPTS = 3;
const CODES_PER_HOUR = 5;
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

// A host name as typed: ASCII letters, digits and hyphens in dot-separated labels of 1 to 63 (an internationalised
// name in its xn-- form), nothing else; so a URL, an address or a path is refused rather than read for a domain in it.
const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

// A domain's registrable form (`mail.example.co.za` is `example.co.za`), or null for an IP address, a public suffix
// or anything that is not a host name.
export function registrable(input: string): string | null {
  const host = input.trim().toLowerCase().replace(/\.$/, "");
  if (!HOST.test(host) || parse(host).isIp) return null;
  return getDomain(host, { allowPrivateDomains: false }) ?? null;
}
const Address = z.string().trim().toLowerCase().email().max(254);

type Domain = { id: string; org_id: string; domain: string; token: string; state: string };
type AddressRow = { id: string; org_id: string; address: string; state: string };

const problem = (status: 400 | 403 | 404 | 409 | 429 | 502 | 503, error: string) =>
  Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
const unavailable = () => problem(503, "that could not be done just now; try again in a moment");
const isUnique = (error: unknown) => /UNIQUE/i.test(String((error as Error)?.message ?? error));

// A request body's fields: unparsable JSON is null, and any JSON (null, an array, a string) reads every field as
// undefined, which each route refuses with a 400.
const bodyOf = async (c: Context<OrgEnv>) => (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

// The organisation a sender belongs to, for the email handler: a verified address, else the verified registrable
// domain of the address, else null.
export async function findMemberBySender(db: D1Database, sender: string): Promise<string | null> {
  const address = sender.trim().toLowerCase();
  const byAddress = await db
    .prepare("SELECT org_id FROM org_addresses WHERE address = ? AND state = 'verified'")
    .bind(address)
    .first<{ org_id: string }>();
  if (byAddress) return byAddress.org_id;
  const domain = registrable(address.slice(address.lastIndexOf("@") + 1));
  if (!domain) return null;
  const byDomain = await db
    .prepare("SELECT org_id FROM org_domains WHERE domain = ? AND state = 'verified'")
    .bind(domain)
    .first<{ org_id: string }>();
  return byDomain?.org_id ?? null;
}

const verifySql = (table: "org_domains" | "org_addresses") =>
  table === "org_domains"
    ? "UPDATE org_domains SET state = 'verified', verified_at = ?, method = ? WHERE id = ? AND state = 'pending'"
    : // An address has no method; the same three parameters are bound, the second only checked present.
      "UPDATE org_addresses SET state = 'verified', verified_at = ? WHERE ? IS NOT NULL AND id = ? AND state = 'pending'";

type Verified = "verified" | "gone" | "taken" | "unavailable";
// Verifies a claim found by DNS, if it still exists and is pending; its waiting code goes with it.
async function verifyByDns(db: D1Database, id: string): Promise<Verified> {
  try {
    const done = await db.batch([
      db.prepare(verifySql("org_domains")).bind(new Date().toISOString(), "dns", id),
      db.prepare("DELETE FROM verification_codes WHERE claim_id = ?").bind(id),
    ]);
    return (done[0]?.meta.changes ?? 0) === 1 ? "verified" : "gone";
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
async function issueCode(db: D1Database, orgId: string, claimId: string, allowance: string) {
  const now = Date.now();
  const at = new Date(now).toISOString();
  const code = sixDigits();
  const codeId = crypto.randomUUID();
  // The send is recorded only while the claim is still pending (a removal or a verification under way wins) and under
  // the hourly limit; the code is written only if the send was.
  const [counted] = await db.batch([
    db
      .prepare(
        "INSERT INTO verification_sends (id, org_id, target, sent_at) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM verification_sends WHERE org_id = ? AND target = ? AND sent_at > ?) < ? AND EXISTS (SELECT 1 FROM org_domains WHERE id = ? AND org_id = ? AND state = 'pending' UNION ALL SELECT 1 FROM org_addresses WHERE id = ? AND org_id = ? AND state = 'pending')",
      )
      .bind(
        crypto.randomUUID(),
        orgId,
        allowance,
        at,
        orgId,
        allowance,
        new Date(now - HOUR_MS).toISOString(),
        CODES_PER_HOUR,
        claimId,
        orgId,
        claimId,
        orgId,
      ),
    db
      .prepare(
        "INSERT INTO verification_codes (claim_id, org_id, code_id, code_hash, expires_at, attempts, locked_until) SELECT ?, ?, ?, ?, ?, 0, NULL WHERE changes() = 1 ON CONFLICT (claim_id) DO UPDATE SET code_id = excluded.code_id, code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = CASE WHEN locked_until > ? THEN attempts ELSE 0 END",
      )
      .bind(
        claimId,
        orgId,
        codeId,
        await sha256Hex(`${claimId}:${code}`),
        new Date(now + CODE_LIFETIME_MS).toISOString(),
        at,
      ),
  ]);
  if (counted?.meta.changes === 1) return { code, codeId };
  const live = await db
    .prepare(
      "SELECT 1 FROM org_domains WHERE id = ? AND org_id = ? AND state = 'pending' UNION ALL SELECT 1 FROM org_addresses WHERE id = ? AND org_id = ? AND state = 'pending'",
    )
    .bind(claimId, orgId, claimId, orgId)
    .first();
  return live ? ("limit" as const) : ("gone" as const);
}

// Checks a code and, when right, consumes it and verifies the claim in one batch, so neither happens without the other.
async function proveByCode(
  db: D1Database,
  table: "org_domains" | "org_addresses",
  orgId: string,
  claimId: string,
  code: string,
): Promise<"locked" | "expired" | "none" | "wrong" | Verified> {
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
        .bind(claimId, orgId, await sha256Hex(`${claimId}:${code.trim()}`)),
      db.prepare(`${verifySql(table)} AND changes() = 1`).bind(now, "email", claimId),
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
  result === "locked"
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

// DNS-over-HTTPS: verified, not yet visible, or the provider failing (including the deadline).
async function lookTxt(domain: string, token: string): Promise<"found" | "absent" | "failing"> {
  const url = `${DOH_URL}?${new URLSearchParams({ name: `_isitlegit.${domain}`, type: "TXT" })}`;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(DOH_DEADLINE_MS),
    });
    if (!response.ok) return "failing";
    const body = (await response.json()) as { Status?: unknown; Answer?: { type?: number; data?: string }[] };
    if (body.Status === 3) return "absent";
    if (body.Status !== 0) return "failing";
    const want = `isitlegit-verify=${token}`;
    const found = (body.Answer ?? []).some(
      (a) => a.type === 16 && (a.data ?? "").replace(/"\s*"/g, "").replace(/"/g, "").trim() === want,
    );
    return found ? "found" : "absent";
  } catch {
    return "failing";
  }
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
  const sends = await db
    .prepare("SELECT sent_at FROM verification_sends WHERE org_id = ? AND target = ? AND sent_at > ? ORDER BY sent_at")
    .bind(orgId, allowance, new Date(Date.now() - HOUR_MS).toISOString())
    .all<{ sent_at: string }>();
  const full = sends.results.length >= CODES_PER_HOUR;
  const now = new Date().toISOString();
  return {
    codeExpiresAt: code && code.expires_at > now ? code.expires_at : null,
    lockedUntil: code?.locked_until && code.locked_until > now ? code.locked_until : null,
    nextCodeAt: full ? new Date(Date.parse(sends.results[0]?.sent_at ?? now) + HOUR_MS).toISOString() : null,
  };
}

domainRoutes.get("/domains", async (c) => {
  const db = c.env.DB;
  const org = c.get("org").id;
  const domains = await db
    .prepare("SELECT id, domain, token, state, method, verified_at FROM org_domains WHERE org_id = ? ORDER BY domain")
    .bind(org)
    .all<Domain & { method: string | null; verified_at: string | null }>();
  const addresses = await db
    .prepare("SELECT id, address, state, verified_at FROM org_addresses WHERE org_id = ? ORDER BY address")
    .bind(org)
    .all<AddressRow & { verified_at: string | null }>();
  return c.json({
    domains: await Promise.all(
      domains.results.map(async ({ id, token, ...d }) =>
        d.state === "pending"
          ? {
              ...d,
              txt: txtFor(d.domain, token),
              ...(await challengeOf(db, org, id, allowanceOf({ domain: d.domain }))),
            }
          : d,
      ),
    ),
    addresses: await Promise.all(
      addresses.results.map(async ({ id, ...a }) =>
        a.state === "pending" ? { ...a, ...(await challengeOf(db, org, id, allowanceOf({ address: a.address }))) } : a,
      ),
    ),
  });
});

const claimedDomain = (db: D1Database, org: string, domain: string) =>
  db
    .prepare("SELECT id, org_id, domain, token, state FROM org_domains WHERE org_id = ? AND domain = ?")
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
  if (!domain) return problem(400, "that is not a domain an organisation can claim");
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
      "INSERT INTO org_domains (id, org_id, domain, token, state, created_at) SELECT ?, ?, ?, ?, 'pending', ? WHERE (SELECT COUNT(*) FROM org_domains WHERE org_id = ? AND state = 'pending') < ? ON CONFLICT DO NOTHING",
    )
    .bind(crypto.randomUUID(), org, domain, token, new Date().toISOString(), org, PENDING_DOMAINS)
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
  const claim = await claimedDomain(c.env.DB, c.get("org").id, c.req.param("domain").toLowerCase());
  if (!claim) return problem(404, "no such domain claim");
  if (claim.state === "verified") return c.json({ domain: claim.domain, verified: true });
  const seen = await lookTxt(claim.domain, claim.token);
  if (seen === "failing") return problem(503, "the DNS check could not be made just now; try again in a moment");
  if (seen === "absent")
    return c.json({
      domain: claim.domain,
      verified: false,
      message: "the record is not visible yet; DNS can take up to an hour",
    });
  return verifiedAnswer(await verifyByDns(c.env.DB, claim.id), { domain: claim.domain }, "domain");
});

domainRoutes.post("/domains/:domain/code", async (c) => {
  const org = c.get("org").id;
  const claim = await claimedDomain(c.env.DB, org, c.req.param("domain").toLowerCase());
  if (!claim) return problem(404, "no such domain claim");
  if (claim.state === "verified") return problem(409, "that domain is already verified");
  const body = await bodyOf(c);
  if (body?.local !== "admin" && body?.local !== "postmaster")
    return problem(400, "the code goes to admin@ or postmaster@");
  const to = `${body.local}@${claim.domain}`;
  const issued = await issueCode(c.env.DB, org, claim.id, allowanceOf({ domain: claim.domain }));
  if (issued === "gone") return problem(404, "no such domain claim");
  if (issued === "limit") return problem(429, `at most ${CODES_PER_HOUR} codes a domain an hour; try again later`);
  const outcome = await sendClaimCode(c.env, {
    to,
    claimId: claim.id,
    codeId: issued.codeId,
    code: issued.code,
    what: claim.domain,
  });
  return sendAnswer(outcome, { domain: claim.domain, to });
});

domainRoutes.post("/domains/:domain/verify", async (c) => {
  const org = c.get("org").id;
  const claim = await claimedDomain(c.env.DB, org, c.req.param("domain").toLowerCase());
  if (!claim) return problem(404, "no such domain claim");
  if (claim.state === "verified") return c.json({ domain: claim.domain, verified: true });
  const body = await bodyOf(c);
  if (typeof body?.code !== "string") return problem(400, "send the code you were mailed");
  return codeAnswer(
    await proveByCode(c.env.DB, "org_domains", org, claim.id, body.code),
    { domain: claim.domain },
    "domain",
  );
});

domainRoutes.delete("/domains/:domain", async (c) => {
  const org = c.get("org").id;
  const claim = await claimedDomain(c.env.DB, org, c.req.param("domain").toLowerCase());
  if (!claim) return problem(404, "no such domain claim");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM org_domains WHERE id = ? AND org_id = ?").bind(claim.id, org),
    c.env.DB.prepare("DELETE FROM verification_codes WHERE claim_id = ?").bind(claim.id),
  ]);
  return c.body(null, 204);
});

// Claims an address (or answers its existing claim) and sends its code.
async function addressCode(c: Context<OrgEnv>, create: boolean) {
  const db = c.env.DB;
  const org = c.get("org").id;
  const parsed = Address.safeParse((await bodyOf(c))?.address);
  if (!parsed.success) return problem(400, "that is not an email address");
  const address = parsed.data;
  let claim = await claimedAddress(db, org, address);
  if (!claim) {
    if (!create) return problem(404, "no such address claim");
    if (await db.prepare("SELECT 1 FROM org_addresses WHERE address = ? AND state = 'verified'").bind(address).first())
      return problem(409, "that address is verified by another organisation");
    const inserted = await db
      .prepare(
        "INSERT INTO org_addresses (id, org_id, address, state, created_at) SELECT ?, ?, ?, 'pending', ? WHERE (SELECT COUNT(*) FROM org_addresses WHERE org_id = ? AND state = 'pending') < ? ON CONFLICT DO NOTHING",
      )
      .bind(crypto.randomUUID(), org, address, new Date().toISOString(), org, PENDING_ADDRESSES)
      .run();
    claim = await claimedAddress(db, org, address);
    if (!claim)
      return inserted.meta.changes === 0
        ? problem(429, `at most ${PENDING_ADDRESSES} addresses can wait for verification`)
        : unavailable();
  }
  if (claim.state === "verified") return c.json({ address, state: "verified" });
  const issued = await issueCode(db, org, claim.id, allowanceOf({ address }));
  if (issued === "gone") return problem(404, "no such address claim");
  if (issued === "limit") return problem(429, `at most ${CODES_PER_HOUR} codes an address an hour; try again later`);
  const outcome = await sendClaimCode(c.env, {
    to: address,
    claimId: claim.id,
    codeId: issued.codeId,
    code: issued.code,
    what: address,
  });
  return sendAnswer(outcome, { address, state: "pending" });
}
domainRoutes.post("/addresses", (c) => addressCode(c, true));
domainRoutes.post("/addresses/code", (c) => addressCode(c, false));

domainRoutes.post("/addresses/verify", async (c) => {
  const org = c.get("org").id;
  const body = await bodyOf(c);
  const parsed = Address.safeParse(body?.address);
  if (!parsed.success || typeof body?.code !== "string")
    return problem(400, "send the address and the code you were mailed");
  const claim = await claimedAddress(c.env.DB, org, parsed.data);
  if (!claim) return problem(404, "no such address claim");
  if (claim.state === "verified") return c.json({ address: claim.address, verified: true });
  return codeAnswer(
    await proveByCode(c.env.DB, "org_addresses", org, claim.id, body.code),
    { address: claim.address },
    "address",
  );
});

domainRoutes.delete("/addresses/:address", async (c) => {
  const org = c.get("org").id;
  const claim = await claimedAddress(c.env.DB, org, c.req.param("address").toLowerCase());
  if (!claim) return problem(404, "no such address claim");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM org_addresses WHERE id = ? AND org_id = ?").bind(claim.id, org),
    c.env.DB.prepare("DELETE FROM verification_codes WHERE claim_id = ?").bind(claim.id),
  ]);
  return c.body(null, 204);
});
