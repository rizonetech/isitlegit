// One page of an organisation's cases for the Cases list (D07 T04 §1; design/SPEC.md M1): newest first by arrival then
// id, 25 a page, filtered by verdict, channel, period and search, with the matching count and the organisation's total.
// Every read is scoped by the organisation. Who checked an email case is its forwarder matched to a member of the
// organisation by address (their name, else the address); an upload's is its uploader matched by user id (their name,
// else their address), "Former member" once they have left, and nothing for an upload from before the uploader was
// stored (D07 T04 §7). The search is the folded words as a plain substring of the stored folded text (./case-search.ts).
import { CaseFilters, type ListResult, PAGE_SIZE } from "./case-filters";
import {
  type CaseStatus,
  type Channel,
  COUNTS_TOWARD_CAP,
  DEFAULT_DAILY_CASES,
  type SourceKind,
  sastDayStart,
  type Verdict,
} from "./cases";
import { fold } from "./search-fold";

export * from "./case-filters";

// The first moment the period covers: the start of the SAST day `days - 1` days before today, so "Last 7 days" is
// today and the six days before it.
export function periodStart(period: CaseFilters["period"], now: Date): string | null {
  if (period === "all") return null;
  return new Date(Date.parse(sastDayStart(now)) - (Number(period) - 1) * 86_400_000).toISOString();
}

type Row = {
  id: string;
  channel: Channel;
  source_kind: SourceKind;
  status: CaseStatus;
  verdict: Verdict | null;
  created_at: string;
  forwarded_by: string | null;
  uploaded_by: string | null;
  checker: string | null;
  original_subject: string | null;
  original_from_name: string | null;
  original_from_address: string | null;
  upload_name: string | null;
  upload_media_type: string | null;
};

// Shown for an uploader who is no longer a member of the organisation: never their name, which is no longer the
// organisation's to show.
export const FORMER_MEMBER = "Former member";

// The search text of a case: the folded column, else the covered fields lower-cased by SQLite (ASCII only).
const UNFOLDED = `COALESCE(search_text, lower(trim(
  COALESCE(original_subject || char(10), '') || COALESCE(original_from_name || char(10), '') ||
  COALESCE(original_from_address || char(10), '') || COALESCE(upload_name, ''), char(10))))`;

export async function listCases(
  db: D1Database,
  orgId: string,
  filters: CaseFilters,
  now = new Date(),
): Promise<ListResult> {
  const parsed = CaseFilters.safeParse(filters);
  if (!parsed.success || !orgId)
    return { ok: false, error: { code: "invalid", message: parsed.error?.issues[0]?.message ?? "no organisation" } };
  const f = parsed.data;
  const where = ["org_id = ?"];
  const binds: unknown[] = [orgId];
  if (f.verdict !== "all") {
    where.push("verdict = ?");
    binds.push(f.verdict);
  }
  if (f.channel !== "all") {
    where.push("channel = ?");
    binds.push(f.channel);
  }
  const since = periodStart(f.period, now);
  if (since) {
    where.push("created_at >= ?");
    binds.push(since);
  }
  // instr, never LIKE: a `%` or `_` in the words is looked for as itself. A case the schedule has not folded yet
  // (stored before migration 0052) is read through SQLite's lower(), the same fields one a line, so it is found by
  // ASCII words at once and by any words once folded (completion review G3).
  const words = fold(f.q);
  if (words) {
    where.push(`instr(${UNFOLDED}, ?) > 0`);
    binds.push(words);
  }
  const clause = where.join(" AND ");
  try {
    const [matched, all] = await db.batch<{ n: number }>([
      db.prepare(`SELECT COUNT(*) AS n FROM cases WHERE ${clause}`).bind(...binds),
      db.prepare("SELECT COUNT(*) AS n FROM cases WHERE org_id = ?").bind(orgId),
    ]);
    const matching = matched?.results[0]?.n ?? 0;
    const total = all?.results[0]?.n ?? 0;
    const pages = Math.max(1, Math.ceil(matching / PAGE_SIZE));
    const page = Math.min(f.page, pages);
    const rows = matching
      ? (
          await db
            .prepare(
              `SELECT c.id, c.channel, c.source_kind, c.status, c.verdict, c.created_at, c.forwarded_by, c.uploaded_by,
                c.original_subject, c.original_from_name, c.original_from_address, c.upload_name, c.upload_media_type,
                CASE WHEN c.channel = 'upload' THEN
                  (SELECT COALESCE(NULLIF(trim(u.name), ''), u.email) FROM "user" u JOIN "member" m ON m."userId" = u.id
                    WHERE m."organizationId" = c.org_id AND u.id = c.uploaded_by LIMIT 1)
                ELSE
                  (SELECT NULLIF(trim(u.name), '') FROM "user" u JOIN "member" m ON m."userId" = u.id
                    WHERE m."organizationId" = c.org_id AND lower(u.email) = c.forwarded_by LIMIT 1)
                END AS checker
              FROM cases c WHERE ${clause.replace(
                /\b(org_id|verdict|channel|created_at|search_text|original_subject|original_from_name|original_from_address|upload_name)\b/g,
                "c.$1",
              )}
              ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`,
            )
            .bind(...binds, PAGE_SIZE, (page - 1) * PAGE_SIZE)
            .all<Row>()
        ).results
      : [];
    return {
      ok: true,
      value: {
        cases: rows.map((r) => ({
          id: r.id,
          channel: r.channel,
          sourceKind: r.source_kind,
          status: r.status,
          verdict: r.verdict,
          createdAt: r.created_at,
          checkedBy: checkedBy(r),
          subject: r.original_subject,
          senderName: r.original_from_name,
          senderAddress: r.original_from_address,
          uploadName: r.upload_name,
          uploadMediaType: r.upload_media_type,
        })),
        page,
        pages,
        matching,
        total,
      },
    };
  } catch (error) {
    return { ok: false, error: { code: "database", message: (error as Error).message } };
  }
}

function checkedBy(r: Row): string | null {
  if (r.channel === "email") return r.checker ?? r.forwarded_by;
  if (!r.uploaded_by) return null;
  return r.checker ?? FORMER_MEMBER;
}

// Who sent a case in, by name, for the report's header (D07 T03 §9), by the list's own rule: a member of the case's
// organisation whose email is the forwarding address, or (an upload) whose id is the uploader's, with a name that is not
// blank. Null when no member matches: a sender who is no member, a member who has since left, or a user of another
// organisation, whose name is never shown.
export async function checkerName(
  db: D1Database,
  orgId: string,
  sent: { forwardedBy: string | null; uploadedBy: string | null },
): Promise<string | null> {
  if (!sent.forwardedBy && !sent.uploadedBy) return null;
  const row = await db
    .prepare(
      `SELECT NULLIF(trim(u.name), '') AS name FROM "user" u JOIN "member" m ON m."userId" = u.id
        WHERE m."organizationId" = ? AND (lower(u.email) = ? OR u.id = ?) LIMIT 1`,
    )
    .bind(orgId, sent.forwardedBy?.toLowerCase() ?? null, sent.uploadedBy ?? null)
    .first<{ name: string | null }>();
  return row?.name ?? null;
}

// How many of today's checks an organisation has used (D01 T03 §6, the upload page's usage line; design/SPEC.md M2):
// its cases since 00:00 SAST against its own daily limit (`org_limits.daily_cases`), or the default, read as the cap
// that admits a case reads them (src/db/cases.ts `admitCase`), by the cap's own rule (`COUNTS_TOWARD_CAP`: a case whose
// admission failed before its file was stored uses none, D01 T03 §12), so the line and the cap never disagree.
export async function todayUsage(
  db: D1Database,
  orgId: string,
  now = new Date(),
): Promise<{ used: number; limit: number }> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM cases WHERE org_id = ? AND created_at >= ? AND ${COUNTS_TOWARD_CAP}) AS used,
        COALESCE((SELECT daily_cases FROM org_limits WHERE org_id = ?), ?) AS lim`,
    )
    .bind(orgId, sastDayStart(now), orgId, DEFAULT_DAILY_CASES)
    .first<{ used: number; lim: number }>();
  return { used: row?.used ?? 0, limit: row?.lim ?? DEFAULT_DAILY_CASES };
}
