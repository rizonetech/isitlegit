// Checks owns the queued/scheduled adapters and atomic publication. The trust service owns
// request eligibility, immutable context and mail delivery; only safe counts leave this adapter.
import { addEvidence } from "../checks/evidence";
import {
  acknowledgeVerificationDelivery,
  refreshVerificationDeliveries,
  requestVerification,
  type VerificationDeps,
} from "../trust/verify-request";

export async function verificationStep(deps: VerificationDeps, caseId: string, orgId: string) {
  const owner = await deps.db
    .prepare("SELECT org_id, COALESCE(run_id,id) AS run_id FROM cases WHERE id = ?")
    .bind(caseId)
    .first<{ org_id: string; run_id: string }>();
  if (!owner || owner.org_id !== orgId) return { outcome: "none" as const, evidence: 0 };
  const result = await requestVerification(deps, caseId, orgId);
  if (result.outcome === "none") return { outcome: "none" as const, evidence: 0 };
  const written = await addEvidence(deps.db, caseId, "verification", result.evidence, deps.now, undefined, undefined, {
    orgId,
    runId: owner.run_id,
    state: result.outcome,
  });
  if (!written.length) return { outcome: "superseded" as const, evidence: 0 };
  if (result.outcome === "requested") await acknowledgeVerificationDelivery(deps.db, caseId, owner.run_id);
  return { outcome: result.outcome, evidence: written.length };
}

export async function refreshVerificationEvidence(db: D1Database) {
  const candidates = await refreshVerificationDeliveries(db, { limit: 25 });
  const counts = { selected: candidates.length, published: 0, skipped: 0, failed: 0 };
  for (const item of candidates) {
    try {
      const written = await addEvidence(
        db,
        item.caseId,
        "verification",
        item.evidence,
        undefined,
        undefined,
        undefined,
        { orgId: item.orgId, runId: item.runId, state: "requested" },
      );
      if (!written.length) {
        counts.skipped++;
        continue;
      }
      await acknowledgeVerificationDelivery(db, item.caseId, item.runId);
      counts.published++;
    } catch {
      // Leave selection eligible for the next bounded refresh. Logs expose only failure counts.
      counts.failed++;
    }
  }
  return counts;
}
