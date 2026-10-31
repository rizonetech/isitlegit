// The supplier ledger's audit trail (D06 T01 §2): one row per change, with who made it and when, its payload an
// allowlist that never carries a number or a key. Its own module so the bank registry's key recovery
// (src/trust/bank.ts `abandonLostKeys`) can audit the supplier accounts it deletes without importing the ledger.
import { ulid } from "../db/ulid";

export type LedgerEventKind =
  | "supplier.added"
  | "supplier.updated"
  | "supplier.removed"
  | "account.added"
  | "account.removed";

export type SupplierDetail = { supplierId: string; name: string };
export type AccountDetail = {
  supplierId: string;
  accountId: string;
  bankName: string;
  last3: string;
  verifiedFromCaseId: string | null;
};

// With `ifChanged`, the event is written only when the statement before it in the batch changed exactly one row, so a
// change that found nothing to change leaves no event.
export function ledgerEventStatement(
  db: D1Database,
  orgId: string,
  actor: string,
  kind: LedgerEventKind,
  detail: SupplierDetail | AccountDetail,
  at: string,
  ifChanged = false,
): D1PreparedStatement {
  const payload: SupplierDetail | AccountDetail =
    "accountId" in detail
      ? {
          supplierId: detail.supplierId,
          accountId: detail.accountId,
          bankName: detail.bankName,
          last3: detail.last3,
          verifiedFromCaseId: detail.verifiedFromCaseId,
        }
      : { supplierId: detail.supplierId, name: detail.name };
  return db
    .prepare(
      `INSERT INTO ledger_events (id, org_id, actor, kind, detail_json, created_at)
       SELECT ?, ?, ?, ?, ?, ?${ifChanged ? " WHERE changes() = 1" : ""}`,
    )
    .bind(ulid(), orgId, actor, kind, JSON.stringify(payload), at);
}
