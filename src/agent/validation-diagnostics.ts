import { ValidationDiagnostic } from "../meta/validation-diagnostics";

export class ValidationDiagnosticError extends Error {
  override name = "ValidationDiagnosticError";
  constructor() {
    super("validation diagnostic persistence refused");
  }
}

// Capture the run once before finalization; every later insert still checks it atomically.
export async function validationRun(db: D1Database, caseId: string): Promise<string | null> {
  const row = await db.prepare("SELECT run_id FROM cases WHERE id = ?").bind(caseId).first<{ run_id: string | null }>();
  if (!row) throw new ValidationDiagnosticError();
  return row.run_id;
}

export async function recordValidationDiagnostic(
  db: D1Database,
  caseId: string,
  runId: string | null,
  value: ValidationDiagnostic,
): Promise<void> {
  const parsed = ValidationDiagnostic.safeParse(value);
  if (!parsed.success) throw new ValidationDiagnosticError();
  const d = parsed.data;
  if (!caseId || caseId.length > 100 || (runId !== null && (!runId || runId.length > 100)))
    throw new ValidationDiagnosticError();
  const encoded = JSON.stringify(d);
  const result = await db
    .prepare(`INSERT INTO model_validation_diagnostics
    (case_id, run_id, call_id, phase, attempt, diagnostic_json)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS
      (SELECT 1 FROM cases WHERE id = ?1 AND COALESCE(run_id, '') = ?2)
    AND EXISTS (SELECT 1 FROM model_spend WHERE call_id = ?3 AND case_id = ?1 AND owner = 'case' AND step = 'verdict')
    ON CONFLICT(case_id, run_id, call_id, phase, attempt) DO UPDATE SET diagnostic_json = excluded.diagnostic_json
    WHERE diagnostic_json = excluded.diagnostic_json
    RETURNING diagnostic_json`)
    .bind(caseId, runId ?? "", d.callId, d.phase, d.attempt, encoded)
    .first<{ diagnostic_json: string }>();
  if (result?.diagnostic_json !== encoded) throw new ValidationDiagnosticError();
}

export async function readValidationDiagnostics(
  db: D1Database,
  caseId: string,
  runId: string | null,
): Promise<ValidationDiagnostic[]> {
  const current = await validationRun(db, caseId);
  if (current !== runId) throw new ValidationDiagnosticError();
  const rows = await db
    .prepare(`SELECT diagnostic_json FROM model_validation_diagnostics
    WHERE case_id = ?1 AND run_id = ?2 AND EXISTS
      (SELECT 1 FROM cases WHERE id = ?1 AND COALESCE(run_id, '') = ?2)
    ORDER BY call_id, phase, attempt`)
    .bind(caseId, runId ?? "")
    .all<{ diagnostic_json: string }>();
  return rows.results.map((row) => ValidationDiagnostic.parse(JSON.parse(row.diagnostic_json)));
}
