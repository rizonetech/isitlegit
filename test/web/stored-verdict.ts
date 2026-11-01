// A verdict row exactly as the database may hold it, written beside the validated entry points (D04 T01 §2): rows from
// before a reason cited evidence hold plain strings, and the report must still read them. `saveVerdict` refuses that
// shape now, so a test of the read path puts its row here.
export async function putStoredVerdict(
  db: D1Database,
  caseId: string,
  view: {
    verdict: "safe" | "suspicious" | "malicious";
    headline: string;
    confidence: number;
    reasons: readonly (string | { text: string; evidenceIds: string[] })[];
    actions: readonly string[];
    meaning?: string | null;
    source?: "stub" | "rules" | "agent";
  },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO case_verdicts (case_id, verdict, headline, confidence, reasons, actions, meaning, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (case_id) DO NOTHING",
    )
    .bind(
      caseId,
      view.verdict,
      view.headline,
      view.confidence,
      JSON.stringify(view.reasons),
      JSON.stringify(view.actions),
      view.meaning ?? null,
      view.source ?? "rules",
      new Date().toISOString(),
    )
    .run();
}
