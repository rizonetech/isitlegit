// The judge demo organisation's five cases, read back (D07 T07 §2). Read-only: the cases are produced by the live
// pipeline on the synthetic fixtures in data/demo/judge/, never inserted here; this only proves they exist, finished,
// and carry the verdict each fixture must produce.

// The invite code label that makes a fresh organisation a judge demo organisation (coordinator, 2026-11-02).
export const JUDGE_CODE_LABEL = "meta-hackathon-2026";

// Marks the organisation a judge signup just created: merges the judgeDemo flag into its metadata, keeping
// what is already there (the demo flag included). Returns false when the organisation does not exist.
export async function markJudgeOrg(db: D1Database, orgId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT metadata FROM "organization" WHERE id = ?')
    .bind(orgId)
    .first<{ metadata: string | null }>();
  if (!row) return false;
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(row.metadata ?? "{}") as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  await db
    .prepare('UPDATE "organization" SET metadata = ? WHERE id = ?')
    .bind(JSON.stringify({ ...parsed, judgeDemo: true }), orgId)
    .run();
  return true;
}

export type JudgeCaseSpec = {
  name: string;
  kind: "mail" | "upload";
  subject?: string;
  uploadName?: string;
  expectedVerdict: string;
};

export type JudgeCheck = {
  name: string;
  caseId: string | null;
  status: string | null;
  verdict: string | null;
  problems: string[];
};

type CaseRow = { id: string; status: string; verdict: string | null };

// Matches one manifest case to the organisation's own rows only: mail by its subject, an upload by its file name.
export async function checkJudges(
  db: D1Database,
  orgId: string,
  specs: readonly JudgeCaseSpec[],
): Promise<JudgeCheck[]> {
  const out: JudgeCheck[] = [];
  for (const spec of specs) {
    const row =
      spec.kind === "mail"
        ? await db
            .prepare(
              "SELECT id, status, verdict FROM cases WHERE org_id = ? AND original_subject = ? ORDER BY created_at DESC",
            )
            .bind(orgId, spec.subject ?? "")
            .first<CaseRow>()
        : await db
            .prepare(
              "SELECT id, status, verdict FROM cases WHERE org_id = ? AND upload_name = ? ORDER BY created_at DESC",
            )
            .bind(orgId, spec.uploadName ?? "")
            .first<CaseRow>();
    if (!row) {
      out.push({ name: spec.name, caseId: null, status: null, verdict: null, problems: ["the case is missing"] });
      continue;
    }
    const problems: string[] = [];
    if (row.status !== "done") problems.push(`the case is ${row.status}, not done`);
    if (row.verdict !== spec.expectedVerdict)
      problems.push(`the verdict is ${row.verdict ?? "none"}, not ${spec.expectedVerdict}`);
    out.push({ name: spec.name, caseId: row.id, status: row.status, verdict: row.verdict, problems });
  }
  return out;
}
