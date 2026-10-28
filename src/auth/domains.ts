// Domain and sending-address verification, and the sender lookup the email handler uses (D07 T02 §5; spec 4.1, 4.8).
//
// An owner or admin claims a domain (held in its registrable form) or a single sending address for the active
// organisation, then proves control: a domain by a DNS TXT record or a code mailed to admin@ or postmaster@ it, an
// address by a code mailed to it. Every read and change names the active organisation, so another organisation's claim
// reads as missing. A claim's challenge is one live code, stored hashed and bound to its claim and organisation: a new
// code replaces the old, a lock survives a resend, a right code is consumed, and wrong guesses are counted in one
// statement, so concurrent guesses cannot pass three. Removing a claim deletes it with its code and token, so nothing
// stale can restore it. Codes go out as mail kind `claim`, which the recipient allowlist admits only to a pending claim
// (src/mail/allowlist.ts).
import { type Context, Hono } from "hono";
import { getDomain, parse } from "tldts";
import { z } from "zod";
import { type MailOutcome, sendClaimCode } from "./claim-mail";
import { requireSession } from "./gate";
import { type OrgEnv, requireOrg } from "./org";

export const DOH_URL = "https://cloudflare-dns.com/dns-query";
const DOH_DEADLINE_MS = 10_000;
const CODE_LIFETIME_MS = 30 * 60_000;
const LOCK_MS = 60 * 60_000;
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

// A domain's registrable form (`mail.example.co.za` is `example.co.za`), or null for an IP address, a public suffix
// or anything that is not a domain.
export function registrable(input: string): string | null {
  const host = input.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253 || parse(host).isIp) return null;
  return getDomain(host, { allowPrivateDomains: false }) ?? null;
}
const Address = z.string().trim().toLowerCase().email().max(254);

type Domain = {
  id: string;
  org_id: string;
  domain: string;
  token: string;
  state: string;
  method: string | null;
  verified_at: string | null;
};
type AddressRow = { id: string; org_id: string; address: string; state: string; verified_at: string | null };

const problem = (status: 400 | 403 | 404 | 409 | 429 | 502 | 503, error: string) =>
  Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

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

// Marks a claim verified, if it still exists and is pending; a unique index refuses a second organisation (409).
async function markVerified(db: D1Database, table: "org_domains" | "org_addresses", id: string, method?: string) {
  const at = new Date().toISOString();
  try {
    const set =
      table === "org_domains"
        ? "state = 'verified', verified_at = ?, method = ?"
        : "state = 'verified', verified_at = ?";
    const values = table === "org_domains" ? [at, method, id] : [at, id];
    const done = await db.batch([
      db.prepare(`UPDATE ${table} SET ${set} WHERE id = ? AND state = 'pending'`).bind(...values),
      db.prepare("DELETE FROM verification_codes WHERE claim_id = ?").bind(id),
    ]);
    return (done[0]?.meta.changes ?? 0) === 1 ? "verified" : "gone";
  } catch {
    return "taken";
  }
}

// A new code for a claim, replacing any earlier one; a lock in force stays. Five a target an hour.
async function issueCode(db: D1Database, orgId: string, claimId: string, target: string) {
  const now = Date.now();
  const recent = await db
    .prepare("SELECT COUNT(*) AS n FROM verification_sends WHERE org_id = ? AND target = ? AND sent_at > ?")
    .bind(orgId, target, new Date(now - 60 * 60_000).toISOString())
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= CODES_PER_HOUR) return null;
  const code = sixDigits();
  const codeId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        "INSERT INTO verification_codes (claim_id, org_id, code_id, code_hash, expires_at, attempts, locked_until) VALUES (?, ?, ?, ?, ?, 0, NULL) ON CONFLICT (claim_id) DO UPDATE SET code_id = excluded.code_id, code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = CASE WHEN locked_until > ? THEN attempts ELSE 0 END",
      )
      .bind(
        claimId,
        orgId,
        codeId,
        await sha256Hex(`${claimId}:${code}`),
        new Date(now + CODE_LIFETIME_MS).toISOString(),
        new Date(now).toISOString(),
      ),
    db
      .prepare("INSERT INTO verification_sends (id, org_id, target, sent_at) VALUES (?, ?, ?, ?)")
      .bind(crypto.randomUUID(), orgId, target, new Date(now).toISOString()),
  ]);
  return { code, codeId };
}

// Checks a code for a claim: a right one is consumed, a wrong one counted (locking at three), all in single statements.
async function checkCode(db: D1Database, orgId: string, claimId: string, code: string) {
  const now = new Date().toISOString();
  const row = await db
    .prepare("SELECT expires_at, locked_until FROM verification_codes WHERE claim_id = ? AND org_id = ?")
    .bind(claimId, orgId)
    .first<{ expires_at: string; locked_until: string | null }>();
  if (!row) return "none" as const;
  if (row.locked_until && row.locked_until > now) return "locked" as const;
  if (row.expires_at <= now) return "expired" as const;
  const consumed = await db
    .prepare(
      "DELETE FROM verification_codes WHERE claim_id = ? AND org_id = ? AND code_hash = ? AND expires_at > ? AND (locked_until IS NULL OR locked_until <= ?)",
    )
    .bind(claimId, orgId, await sha256Hex(`${claimId}:${code.trim()}`), now, now)
    .run();
  if (consumed.meta.changes === 1) return "right" as const;
  const counted = await db
    .prepare(
      "UPDATE verification_codes SET attempts = CASE WHEN locked_until IS NOT NULL THEN 1 ELSE attempts + 1 END, locked_until = CASE WHEN (CASE WHEN locked_until IS NOT NULL THEN 1 ELSE attempts + 1 END) >= ? THEN ? ELSE NULL END WHERE claim_id = ? AND org_id = ? AND (locked_until IS NULL OR locked_until <= ?) RETURNING locked_until",
    )
    .bind(MAX_ATTEMPTS, new Date(Date.now() + LOCK_MS).toISOString(), claimId, orgId, now)
    .first<{ locked_until: string | null }>();
  return !counted || counted.locked_until ? ("locked" as const) : ("wrong" as const);
}

const codeAnswer = (result: Awaited<ReturnType<typeof checkCode>>) =>
  result === "locked"
    ? problem(429, "too many wrong codes; try again in an hour")
    : result === "expired"
      ? problem(400, "that code has expired; send another")
      : result === "none"
        ? problem(400, "no code is waiting; send one first")
        : problem(400, "that code is not right");

const sendAnswer = (outcome: MailOutcome, body: Record<string, unknown>) =>
  outcome === "sent"
    ? Response.json({ ...body, codeSent: true })
    : outcome === "unknown"
      ? Response.json(
          { ...body, codeSent: null, message: "the code may have gone; check the inbox before sending another" },
          { status: 202 },
        )
      : problem(502, "the code could not be sent; send another");

// DNS-over-HTTPS: verified, not yet visible, or the provider failing.
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

domainRoutes.get("/domains", async (c) => {
  const org = c.get("org").id;
  const domains = await c.env.DB.prepare(
    "SELECT domain, token, state, method, verified_at FROM org_domains WHERE org_id = ? ORDER BY domain",
  )
    .bind(org)
    .all<Omit<Domain, "id" | "org_id">>();
  const addresses = await c.env.DB.prepare(
    "SELECT address, state, verified_at FROM org_addresses WHERE org_id = ? ORDER BY address",
  )
    .bind(org)
    .all<Omit<AddressRow, "id" | "org_id">>();
  return c.json({
    domains: domains.results.map(({ token, ...d }) => ({
      ...d,
      ...(d.state === "pending" ? { txt: txtFor(d.domain, token) } : {}),
    })),
    addresses: addresses.results,
  });
});
const txtFor = (domain: string, token: string) => ({
  name: `_isitlegit.${domain}`,
  value: `isitlegit-verify=${token}`,
});

const claimedDomain = (db: D1Database, org: string, domain: string) =>
  db.prepare("SELECT * FROM org_domains WHERE org_id = ? AND domain = ?").bind(org, domain).first<Domain>();
const claimedAddress = (db: D1Database, org: string, address: string) =>
  db.prepare("SELECT * FROM org_addresses WHERE org_id = ? AND address = ?").bind(org, address).first<AddressRow>();

domainRoutes.post("/domains", async (c) => {
  const db = c.env.DB;
  const org = c.get("org").id;
  const body = (await c.req.json().catch(() => ({}))) as { domain?: unknown };
  const domain = typeof body.domain === "string" ? registrable(body.domain) : null;
  if (!domain) return problem(400, "that is not a domain an organisation can claim");
  const existing = await claimedDomain(db, org, domain);
  if (existing)
    return c.json({
      domain,
      state: existing.state,
      ...(existing.state === "pending" ? { txt: txtFor(domain, existing.token) } : {}),
    });
  const elsewhere = await db
    .prepare("SELECT 1 FROM org_domains WHERE domain = ? AND state = 'verified'")
    .bind(domain)
    .first();
  if (elsewhere) return problem(409, "that domain is verified by another organisation");
  const pending = await db
    .prepare("SELECT COUNT(*) AS n FROM org_domains WHERE org_id = ? AND state = 'pending'")
    .bind(org)
    .first<{ n: number }>();
  if ((pending?.n ?? 0) >= PENDING_DOMAINS)
    return problem(429, `at most ${PENDING_DOMAINS} domains can wait for verification`);
  const token = randomHex(16);
  await db
    .prepare(
      "INSERT INTO org_domains (id, org_id, domain, token, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?) ON CONFLICT DO NOTHING",
    )
    .bind(crypto.randomUUID(), org, domain, token, new Date().toISOString())
    .run();
  const claim = await claimedDomain(db, org, domain);
  return c.json({ domain, state: claim?.state ?? "pending", txt: txtFor(domain, claim?.token ?? token) }, 201);
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
  const marked = await markVerified(c.env.DB, "org_domains", claim.id, "dns");
  if (marked === "taken") return problem(409, "that domain is verified by another organisation");
  if (marked === "gone") return problem(404, "no such domain claim");
  return c.json({ domain: claim.domain, verified: true });
});

domainRoutes.post("/domains/:domain/code", async (c) => {
  const org = c.get("org").id;
  const claim = await claimedDomain(c.env.DB, org, c.req.param("domain").toLowerCase());
  if (!claim) return problem(404, "no such domain claim");
  if (claim.state === "verified") return problem(409, "that domain is already verified");
  const body = (await c.req.json().catch(() => ({}))) as { local?: unknown };
  if (body.local !== "admin" && body.local !== "postmaster")
    return problem(400, "the code goes to admin@ or postmaster@");
  const to = `${body.local}@${claim.domain}`;
  const issued = await issueCode(c.env.DB, org, claim.id, to);
  if (!issued) return problem(429, `at most ${CODES_PER_HOUR} codes an hour; try again later`);
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
  const body = (await c.req.json().catch(() => ({}))) as { code?: unknown };
  const result = await checkCode(c.env.DB, org, claim.id, typeof body.code === "string" ? body.code : "");
  if (result !== "right") return codeAnswer(result);
  const marked = await markVerified(c.env.DB, "org_domains", claim.id, "email");
  if (marked === "taken") return problem(409, "that domain is verified by another organisation");
  if (marked === "gone") return problem(404, "no such domain claim");
  return c.json({ domain: claim.domain, verified: true });
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
  const body = (await c.req.json().catch(() => ({}))) as { address?: unknown };
  const parsed = Address.safeParse(body.address);
  if (!parsed.success) return problem(400, "that is not an email address");
  const address = parsed.data;
  let claim = await claimedAddress(db, org, address);
  if (!claim) {
    if (!create) return problem(404, "no such address claim");
    const elsewhere = await db
      .prepare("SELECT 1 FROM org_addresses WHERE address = ? AND state = 'verified'")
      .bind(address)
      .first();
    if (elsewhere) return problem(409, "that address is verified by another organisation");
    const pending = await db
      .prepare("SELECT COUNT(*) AS n FROM org_addresses WHERE org_id = ? AND state = 'pending'")
      .bind(org)
      .first<{ n: number }>();
    if ((pending?.n ?? 0) >= PENDING_ADDRESSES)
      return problem(429, `at most ${PENDING_ADDRESSES} addresses can wait for verification`);
    await db
      .prepare(
        "INSERT INTO org_addresses (id, org_id, address, state, created_at) VALUES (?, ?, ?, 'pending', ?) ON CONFLICT DO NOTHING",
      )
      .bind(crypto.randomUUID(), org, address, new Date().toISOString())
      .run();
    claim = await claimedAddress(db, org, address);
  }
  if (!claim) return problem(404, "no such address claim");
  if (claim.state === "verified") return c.json({ address, state: "verified" });
  const issued = await issueCode(db, org, claim.id, address);
  if (!issued) return problem(429, `at most ${CODES_PER_HOUR} codes an hour; try again later`);
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
  const body = (await c.req.json().catch(() => ({}))) as { address?: unknown; code?: unknown };
  const parsed = Address.safeParse(body.address);
  if (!parsed.success) return problem(400, "that is not an email address");
  const claim = await claimedAddress(c.env.DB, org, parsed.data);
  if (!claim) return problem(404, "no such address claim");
  if (claim.state === "verified") return c.json({ address: claim.address, verified: true });
  const result = await checkCode(c.env.DB, org, claim.id, typeof body.code === "string" ? body.code : "");
  if (result !== "right") return codeAnswer(result);
  const marked = await markVerified(c.env.DB, "org_addresses", claim.id);
  if (marked === "taken") return problem(409, "that address is verified by another organisation");
  if (marked === "gone") return problem(404, "no such address claim");
  return c.json({ address: claim.address, verified: true });
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
