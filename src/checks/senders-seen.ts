// Whether an organisation has had a case from this sender before (D02 T02 §5). The Workflow's `checks` step asks before
// the checks run and puts the answer in the view, since a check never reaches the store. Senders are kept as an
// HMAC-SHA-256 of the canonical mailbox (`mailbox` in ./sender) under the organisation's own random salt.
import { addressParser } from "postal-mime";
import type { CaseView } from "./case-view";
import { mailbox } from "./sender";

export type SenderHistory = "first" | "seen";

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

// The organisation's salt: made once, inserted only when absent and read back, so two first uses at once never
// replace a salt already in use.
async function saltFor(db: D1Database, orgId: string): Promise<string> {
  await db
    .prepare("INSERT INTO org_sender_salts (org_id, salt) VALUES (?, ?) ON CONFLICT (org_id) DO NOTHING")
    .bind(orgId, hex(crypto.getRandomValues(new Uint8Array(32))))
    .run();
  const row = await db
    .prepare("SELECT salt FROM org_sender_salts WHERE org_id = ?")
    .bind(orgId)
    .first<{ salt: string }>();
  if (!row) throw new Error("the organisation's sender salt could not be read back");
  return row.salt;
}

export async function senderHash(db: D1Database, orgId: string, canonical: string): Promise<string> {
  const salt = await saltFor(db, orgId);
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(salt.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? []),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical)));
}

// The case's sender classified once, in one statement: `first` unless the organisation has a row for the sender
// already, else `seen`; nothing when the case has its row, which is then read back. D1 runs one write at a time, so
// of two overlapping cases exactly one is first, and a retry reads its own answer.
export async function observeSender(
  db: D1Database,
  orgId: string,
  caseId: string,
  canonical: string,
  now = new Date(),
): Promise<SenderHistory> {
  const hash = await senderHash(db, orgId, canonical);
  await db
    .prepare(
      "INSERT INTO sender_observations (org_id, case_id, sender_hash, classification, observed_at) SELECT ?1, ?2, ?3, CASE WHEN EXISTS (SELECT 1 FROM sender_observations WHERE org_id = ?1 AND sender_hash = ?3) THEN 'seen' ELSE 'first' END, ?4 WHERE 1 ON CONFLICT (org_id, case_id) DO NOTHING",
    )
    .bind(orgId, caseId, hash, now.toISOString())
    .run();
  const row = await db
    .prepare("SELECT classification FROM sender_observations WHERE org_id = ? AND case_id = ?")
    .bind(orgId, caseId)
    .first<{ classification: SenderHistory }>();
  if (!row) throw new Error("the case's sender observation could not be read back");
  return row.classification;
}

// The original's sender as one canonical mailbox: only with the original's own headers (an inline forward's outer From
// is the forwarding member's), one From header naming one valid mailbox; null otherwise.
export function originalSender(view: Pick<CaseView, "headers" | "tenant">): string | null {
  if (!view.tenant.headersAvailable) return null;
  const from = view.headers.filter((h) => h.name.trim().toLowerCase() === "from");
  if (from.length !== 1) return null;
  const parsed = addressParser(from[0]?.value ?? "", { flatten: true }).filter((a) => a.address);
  if (parsed.length !== 1) return null;
  return mailbox(parsed[0]?.address ?? "");
}
