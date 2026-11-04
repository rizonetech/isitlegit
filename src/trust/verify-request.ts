// Closed-loop requests (D05 T03 §1): only persisted registry mismatches may start one, and only the
// registered finance contact may receive it. The mail layer owns its allowlist and atomic send claim.
// This service returns safe evidence drafts; checks' workflow/scheduled adapters own addEvidence.
import { z } from "zod";
import { hasFeature } from "../auth/plans";
import { type Evidence, type EvidenceDraft, readEvidence, StoredEvidence } from "../checks/evidence";
import { InvoiceFields } from "../invoice/schema";
import { type MailDeps, recipientHash, sendMail } from "../mail/smtp2go";
import { getIdentity, identityContact } from "./identity";

export type VerificationDeps = {
  db: D1Database;
  mail: Omit<MailDeps, "db">;
  secret: string | undefined;
  now?: () => Date;
};
export type VerificationResult = { outcome: "none" | "requested" | "unavailable"; evidence: EvidenceDraft[] };
export const VERIFICATION_TTL_MS = 72 * 3600_000;
const none: VerificationResult = { outcome: "none", evidence: [] };
const encoder = new TextEncoder();
const digest = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const Draft = StoredEvidence.omit({ id: true });
const Context = z.object({
  against: z.literal("registry"),
  registry_match: z.literal(false),
  protected_org_id: z.string().min(1).max(200),
  amount_cents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  currency: InvoiceFields.shape.currency.unwrap(),
  account_last3: z.string().regex(/^\d{3}$/),
  attachment: z.string().min(1).max(1024),
});
type Context = z.infer<typeof Context>;
type Source = { item: Evidence; context: Context; hash: string };
type RequestRow = {
  case_id: string;
  org_id: string;
  supplier_org_id: string;
  source_run: string;
  source_evidence: string;
  source_hash: string;
  attachment: string;
  amount_cents: number;
  currency: string;
  account_last3: string;
  recipient_hash: string;
  nonce: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  sent_at: string | null;
  answer: string | null;
  answered_at: string | null;
  delivery_evidence_run: string | null;
};
const requestOf = (db: D1Database, caseId: string) =>
  db.prepare("SELECT * FROM verifications WHERE case_id = ?").bind(caseId).first<RequestRow>();
const caseOf = (db: D1Database, caseId: string) =>
  db
    .prepare("SELECT org_id, COALESCE(run_id, id) AS run_id FROM cases WHERE id = ?")
    .bind(caseId)
    .first<{ org_id: string; run_id: string }>();
export const verificationSendKey = (caseId: string) => `verification:${caseId}`;

function unavailable(reason: string): VerificationResult {
  return {
    outcome: "unavailable",
    evidence: [
      Draft.parse({
        check: "verification.not_requested",
        severity: "info",
        summary:
          "A verification request for these invoice details could not be confirmed. Phone the supplier on a known number before paying.",
        detail: { reason },
        artefacts: [],
      }),
    ],
  };
}

async function sourceOf(db: D1Database, caseId: string): Promise<Source | string | null> {
  const matches = (await readEvidence(db, caseId)).filter(
    (e) => e.check === "invoice.bank_changed" && e.detail.against === "registry",
  );
  if (!matches.length) return null;
  if (matches.length !== 1) return "ambiguous-invoices";
  const item = matches[0];
  if (!item) return null;
  const parsed = Context.safeParse(item.detail);
  if (item.severity !== "critical" || !parsed.success) return "incomplete-evidence";
  const context = parsed.data;
  if (!item.artefacts.includes(context.attachment)) return "invalid-attachment";
  const attachment = await db
    .prepare("SELECT 1 FROM artefacts WHERE r2_key = ? AND case_id = ? AND kind = 'attachment'")
    .bind(context.attachment, caseId)
    .first();
  if (!attachment) return "invalid-attachment";
  return { item, context, hash: await digest(JSON.stringify(item)) };
}

// Full-strength, versioned and domain-separated HMAC. Only the outbound Reply-To carries this token.
async function tokenFor(secret: string, row: RequestRow): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const context = [
    "isitlegit verification reply v1",
    row.case_id,
    row.org_id,
    row.supplier_org_id,
    row.source_run,
    row.source_evidence,
    row.source_hash,
    row.attachment,
    row.amount_cents,
    row.currency,
    row.account_last3,
    row.recipient_hash,
    row.nonce,
    row.created_at,
    row.expires_at,
  ];
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(context))));
  return btoa(String.fromCharCode(...mac))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function matchesSource(row: RequestRow, source: Source, runId: string): boolean {
  const c = source.context;
  return (
    row.source_run === runId &&
    row.source_hash === source.hash &&
    row.source_evidence === source.item.id &&
    row.supplier_org_id === c.protected_org_id &&
    row.attachment === c.attachment &&
    row.amount_cents === c.amount_cents &&
    row.currency === c.currency &&
    row.account_last3 === c.account_last3
  );
}
function requested(row: RequestRow): VerificationResult {
  return {
    outcome: "requested",
    evidence: [
      Draft.parse({
        check: "verification.requested",
        severity: "info",
        summary:
          "A request to confirm these invoice payment details was sent to the supplier's registered finance contact. This is not confirmation that the invoice is genuine.",
        detail: {
          supplier_org_id: row.supplier_org_id,
          amount_cents: row.amount_cents,
          currency: row.currency,
          account_last3: row.account_last3,
          attachment: row.attachment,
          source_evidence: row.source_evidence,
          expires_at: row.expires_at,
          sent_at: row.sent_at,
        },
        artefacts: [row.attachment],
      }),
    ],
  };
}
// sent_at records when delivery was first confirmed, not an invented provider acceptance timestamp.
async function confirmed(db: D1Database, row: RequestRow): Promise<RequestRow | null> {
  const mail = await db
    .prepare(
      "SELECT updated_at FROM mail_sends WHERE send_key = ? AND case_id = ? AND kind = 'verify' AND to_hash = ? AND status = 'sent'",
    )
    .bind(verificationSendKey(row.case_id), row.case_id, row.recipient_hash)
    .first<{ updated_at: string }>();
  if (!mail) return null;
  await db
    .prepare("UPDATE verifications SET sent_at = COALESCE(sent_at, ?) WHERE case_id = ?")
    .bind(mail.updated_at, row.case_id)
    .run();
  return { ...row, sent_at: row.sent_at ?? mail.updated_at };
}

export async function requestVerification(
  deps: VerificationDeps,
  caseId: string,
  orgId: string,
): Promise<VerificationResult> {
  const { db } = deps;
  const owner = await caseOf(db, caseId);
  if (!owner || owner.org_id !== orgId) return none;
  const source = await sourceOf(db, caseId);
  if (source === null) return none;
  if (typeof source === "string") return unavailable(source);
  let row = await requestOf(db, caseId);
  if (row && (row.org_id !== orgId || !matchesSource(row, source, owner.run_id))) return unavailable("context-changed");
  if (row) {
    const sent = await confirmed(db, row);
    if (sent) return requested(sent); // Historical delivery does not send again, even after entitlement expires.
  }
  const now = (deps.now ?? (() => new Date()))();
  if (!(await hasFeature(db, orgId, "closed-loop", now))) return unavailable("plan-required");
  const identity = await getIdentity(db, source.context.protected_org_id);
  const contact = identity?.effective.on ? await identityContact(db, source.context.protected_org_id) : null;
  if (!contact) return unavailable("contact-unavailable");
  const contactHash = await recipientHash(contact);
  if (row && row.recipient_hash !== contactHash) return unavailable("contact-changed");
  if (!deps.secret || deps.secret.length < 32) return unavailable("signing-unavailable");
  if (!row) {
    const proposed: RequestRow = {
      case_id: caseId,
      org_id: orgId,
      supplier_org_id: source.context.protected_org_id,
      source_run: owner.run_id,
      source_evidence: source.item.id,
      source_hash: source.hash,
      attachment: source.context.attachment,
      amount_cents: source.context.amount_cents,
      currency: source.context.currency,
      account_last3: source.context.account_last3,
      recipient_hash: contactHash,
      nonce: crypto.randomUUID(),
      token_hash: "",
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + VERIFICATION_TTL_MS).toISOString(),
      sent_at: null,
      answer: null,
      answered_at: null,
      delivery_evidence_run: null,
    };
    proposed.token_hash = await digest(await tokenFor(deps.secret, proposed));
    await db
      .prepare(`INSERT INTO verifications (case_id, org_id, supplier_org_id, source_run, source_evidence, source_hash,
      attachment, amount_cents, currency, account_last3, recipient_hash, nonce, token_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(case_id) DO NOTHING`)
      .bind(
        caseId,
        orgId,
        proposed.supplier_org_id,
        proposed.source_run,
        proposed.source_evidence,
        proposed.source_hash,
        proposed.attachment,
        proposed.amount_cents,
        proposed.currency,
        proposed.account_last3,
        proposed.recipient_hash,
        proposed.nonce,
        proposed.token_hash,
        proposed.created_at,
        proposed.expires_at,
      )
      .run();
    row = await requestOf(db, caseId);
    if (!row) throw new Error("verification request could not be read back");
  }
  if (row.org_id !== orgId || !matchesSource(row, source, owner.run_id) || row.recipient_hash !== contactHash)
    return unavailable("context-changed");
  if (!Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= now.getTime())
    return unavailable("expired");
  const token = await tokenFor(deps.secret, row);
  if ((await digest(token)) !== row.token_hash) return unavailable("signing-context-changed");
  // Recheck after asynchronous persistence/crypto, immediately before mail's own allowlist and claim.
  const currentOwner = await caseOf(db, caseId);
  const currentSource = await sourceOf(db, caseId);
  const currentIdentity = await getIdentity(db, row.supplier_org_id);
  if (
    !currentOwner ||
    currentOwner.org_id !== orgId ||
    !currentSource ||
    typeof currentSource === "string" ||
    !matchesSource(row, currentSource, currentOwner.run_id)
  )
    return unavailable("context-changed");
  if (!(await hasFeature(db, orgId, "closed-loop", (deps.now ?? (() => new Date()))())))
    return unavailable("plan-required");
  if (!currentIdentity?.effective.on || (await identityContact(db, row.supplier_org_id)) !== contact)
    return unavailable("contact-changed");
  if (Date.parse(row.expires_at) <= (deps.now ?? (() => new Date()))().getTime()) return unavailable("expired");
  const deadline = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Johannesburg",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(row.expires_at));
  const cents = BigInt(row.amount_cents);
  const amount = `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  const result = await sendMail(
    { ...deps.mail, db, ...(deps.now ? { now: deps.now } : {}) },
    {
      sendKey: verificationSendKey(caseId),
      kind: "verify",
      caseId,
      to: contact,
      from: "verify@isitlegit.co.za",
      subject: "Please confirm these invoice payment details",
      headers: { "Reply-To": `verify+${token}@isitlegit.co.za` },
      text: `An invoice claims to be from your business and asks for ${row.currency} ${amount} to an account ending ${row.account_last3}. These details do not match the account registered with IsItLegit.\n\nAre these the payment details your business authorised for this invoice? Reply yes or no by ${deadline} SAST. Do not send your bank account number.\n\nThis request does not confirm that the invoice is genuine. The checker should still phone you on a known number before paying.`,
    },
  );
  if (result.status === "failed" && result.storageFailure)
    throw new Error(`verification mail ${result.storageFailure} storage failed`);
  if (result.status === "sent" || (result.status === "duplicate" && result.previous === "sent")) {
    const sent = await confirmed(db, row);
    if (!sent) throw new Error("verification delivery could not be read back");
    return requested(sent);
  }
  return unavailable(result.status === "duplicate" ? result.previous : result.status);
}

export type VerificationDelivery = { caseId: string; orgId: string; runId: string; evidence: EvidenceDraft[] };
// Called after mail reconciliation. Never sends mail; failed publication remains eligible until ACK.
export async function refreshVerificationDeliveries(
  db: D1Database,
  options: { limit: number },
): Promise<VerificationDelivery[]> {
  const limit = z.number().int().min(1).max(25).parse(options.limit);
  const rows = (
    await db
      .prepare(`SELECT v.* FROM verifications v JOIN cases c ON c.id = v.case_id
    JOIN mail_sends m ON m.send_key = 'verification:' || v.case_id AND m.case_id = v.case_id
    AND m.kind = 'verify' AND m.to_hash = v.recipient_hash AND m.status = 'sent'
    WHERE v.answer IS NULL AND v.source_run = COALESCE(c.run_id, c.id) AND v.org_id = c.org_id
    AND (v.delivery_evidence_run IS NULL OR v.delivery_evidence_run != v.source_run)
    ORDER BY v.refresh_checked_at IS NOT NULL, v.refresh_checked_at, v.case_id LIMIT ?`)
      .bind(limit)
      .all<RequestRow>()
  ).results;
  const result: VerificationDelivery[] = [];
  for (const row of rows) {
    // Rotate invalid/stale rows behind other work without acknowledging an unpublished result.
    await db
      .prepare("UPDATE verifications SET refresh_checked_at = ? WHERE case_id = ?")
      .bind(new Date().toISOString(), row.case_id)
      .run();
    const source = await sourceOf(db, row.case_id);
    if (!source || typeof source === "string" || !matchesSource(row, source, row.source_run)) continue;
    const sent = await confirmed(db, row);
    if (sent)
      result.push({
        caseId: row.case_id,
        orgId: row.org_id,
        runId: row.source_run,
        evidence: requested(sent).evidence,
      });
  }
  return result;
}
// The caller ACKs only after validated evidence publication succeeds for the exact current run.
export async function acknowledgeVerificationDelivery(db: D1Database, caseId: string, runId: string): Promise<void> {
  await db
    .prepare(`UPDATE verifications SET delivery_evidence_run = ? WHERE case_id = ? AND source_run = ?
    AND source_run = (SELECT COALESCE(run_id, id) FROM cases WHERE id = ?)`)
    .bind(runId, caseId, runId, caseId)
    .run();
}
