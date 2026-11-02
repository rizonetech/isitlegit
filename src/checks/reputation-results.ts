// One reputation result per provider per subject, stored with its case and run (D02 T06 §9, migration 0085):
// the report shows each provider's own answer, when it was obtained and whether it came from the cache.
// States are mapped at this store and nowhere else: Web Risk listed/not_listed and Cloudflare blocked/clear
// read as listed and clear; capped and not_checked read as unavailable, never clear and never absent; the
// well-known list keeps its own states (known, unknown, unavailable) and is never renamed a listing.

import type { Reputation } from "./reputation";

export type StoredReputationResult = {
  provider: string;
  subject: string;
  state: string;
  obtainedAt: string;
  cached: boolean;
  note: string | null;
};

const CURRENT_RUN_OF = "(SELECT COALESCE(run_id, id) FROM cases WHERE id = ?)";

export function reputationRows(reputation: Reputation | null, now: Date): StoredReputationResult[] {
  if (!reputation) return [];
  const rows: StoredReputationResult[] = [];
  for (const { url, webRisk } of reputation.links) {
    const base = { provider: "google-web-risk", subject: url };
    if (webRisk.state === "listed")
      rows.push({
        ...base,
        state: "listed",
        obtainedAt: webRisk.obtainedAt ?? now.toISOString(),
        cached: webRisk.cached,
        note: webRisk.threatTypes.join(",") || null,
      });
    else if (webRisk.state === "not_listed")
      rows.push({
        ...base,
        state: "clear",
        obtainedAt: webRisk.obtainedAt ?? now.toISOString(),
        cached: webRisk.cached,
        note: null,
      });
    else if (webRisk.state === "capped")
      rows.push({
        ...base,
        state: "unavailable",
        obtainedAt: now.toISOString(),
        cached: false,
        note: `capped:${webRisk.scope}`,
      });
    else
      rows.push({ ...base, state: "unavailable", obtainedAt: now.toISOString(), cached: false, note: webRisk.reason });
  }
  for (const { domain, cloudflare, wellKnown } of reputation.domains) {
    if (cloudflare.state === "blocked" || cloudflare.state === "clear")
      rows.push({
        provider: "cloudflare",
        subject: domain,
        state: cloudflare.state === "blocked" ? "listed" : "clear",
        obtainedAt: cloudflare.obtainedAt ?? now.toISOString(),
        cached: cloudflare.cached,
        note: null,
      });
    else
      rows.push({
        provider: "cloudflare",
        subject: domain,
        state: "unavailable",
        obtainedAt: now.toISOString(),
        cached: false,
        note: cloudflare.reason,
      });
    rows.push({
      provider: "well-known",
      subject: domain,
      state: wellKnown.state === "known" ? "known" : wellKnown.state === "unknown" ? "unknown" : "unavailable",
      obtainedAt: wellKnown.obtainedAt ?? now.toISOString(),
      cached: false,
      note: null,
    });
  }
  return rows;
}

type ResultRow = {
  provider: string;
  subject: string;
  state: string;
  obtained_at: string;
  cached: number;
  note: string | null;
};

export async function readReputationResults(
  db: D1Database,
  caseId: string,
  runId?: string,
): Promise<StoredReputationResult[] | null> {
  try {
    const { results } = runId
      ? await db
          .prepare(
            "SELECT provider, subject, state, obtained_at, cached, note FROM reputation_results WHERE case_id = ? AND run_id = ? ORDER BY rowid",
          )
          .bind(caseId, runId)
          .all<ResultRow>()
      : await db
          .prepare(
            `SELECT provider, subject, state, obtained_at, cached, note FROM reputation_results WHERE case_id = ? AND run_id = ${CURRENT_RUN_OF} ORDER BY rowid`,
          )
          .bind(caseId, caseId)
          .all<ResultRow>();
    return results.map((r) => ({
      provider: r.provider,
      subject: r.subject,
      state: r.state,
      obtainedAt: r.obtained_at,
      cached: r.cached === 1,
      note: r.note,
    }));
  } catch {
    return null;
  }
}

// The replacement as statements, so the checks step commits it in the same batch as the evidence and
// outcomes it sits beside (D02 T06 §9, round 1): one failed write rolls the whole batch back, so a stored
// result can never disagree with the evidence of its run.
export function reputationResultStatements(
  db: D1Database,
  caseId: string,
  reputation: Reputation | null,
  now = new Date(),
): D1PreparedStatement[] {
  const rows = reputationRows(reputation, now);
  const statements: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM reputation_results WHERE case_id = ? AND run_id = ${CURRENT_RUN_OF}`).bind(caseId, caseId),
  ];
  for (const row of rows)
    statements.push(
      db
        .prepare(
          `INSERT INTO reputation_results (case_id, run_id, provider, subject, state, obtained_at, cached, note) SELECT ?, ${CURRENT_RUN_OF}, ?, ?, ?, ?, ?, ?`,
        )
        .bind(caseId, caseId, row.provider, row.subject, row.state, row.obtainedAt, row.cached ? 1 : 0, row.note),
    );
  return statements;
}

// Replaces the run's rows in one batch: the delete and its inserts commit together, so a failed replacement
// leaves the previous complete set and the step's retry starts from it. A failure propagates and fails the
// step, like every other store in the checks step.
export async function storeReputationResults(
  db: D1Database,
  caseId: string,
  reputation: Reputation | null,
  now = new Date(),
): Promise<void> {
  await db.batch(reputationResultStatements(db, caseId, reputation, now));
}
