// One page of an organisation's cases for the Cases list (D07 T04 §1; design/SPEC.md M1): newest first by arrival then
// id, 25 a page, filtered by verdict, channel, period and search, with the matching count and the organisation's total.
// Every read is scoped by the organisation. Who checked an email case is its forwarder matched to a member of the
// organisation by address (their name, else the address); an upload's is its uploader matched by user id (their name,
// else their address), "Former member" once they have left, and nothing for an upload from before the uploader was
// stored (D07 T04 §7). The search is each folded term (a word, or a quoted run) as a plain substring of the stored folded text, all of them required (./search-fold.ts `searchTerms`).

import { dailyCapBinds, dailyCapSql } from "../auth/plan-sql";
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
import type { Checker } from "./checker";
import { searchTerms } from "./search-fold";

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
  // Every term of the query must be in the case's text, in any order (D07 T04 §14): one instr each, ANDed.
  const { terms, cut } = searchTerms(f.q);
  for (const term of terms) {
    where.push(`instr(${UNFOLDED}, ?) > 0`);
    binds.push(term);
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
                ${checkerSql("c.org_id", "c.channel", "c.forwarded_by", "c.uploaded_by")} AS checker
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
        searchCut: cut,
      },
    };
  } catch (error) {
    return { ok: false, error: { code: "database", message: (error as Error).message } };
  }
}

// The list's words for who checked a case: the member's name (an upload's uploader by email when their name is blank),
// Former member once an upload's uploader left, an unmatched forwarder's own address, or none recorded.
function checkedBy(r: Row): string | null {
  const who = checkerOf(r.channel, r.checker, r.uploaded_by);
  if (who?.kind === "member") return who.name;
  if (who?.kind === "former") return FORMER_MEMBER;
  return r.forwarded_by;
}

export type { Checker };

// The member's name as one SQL expression over a case's columns (matched by forwarding address or by uploader id),
// read by both views.
function checkerSql(org: string, channel: string, forwardedBy: string, uploadedBy: string): string {
  return `CASE WHEN ${channel} = 'upload' THEN
    (SELECT COALESCE(NULLIF(trim(u.name), ''), u.email) FROM "user" u JOIN "member" m ON m."userId" = u.id
      WHERE m."organizationId" = ${org} AND u.id = ${uploadedBy} LIMIT 1)
  ELSE
    (SELECT NULLIF(trim(u.name), '') FROM "user" u JOIN "member" m ON m."userId" = u.id
      WHERE m."organizationId" = ${org} AND lower(u.email) = lower(${forwardedBy}) LIMIT 1)
  END`;
}
function checkerOf(channel: string, name: string | null, uploadedBy: string | null): Checker {
  if (name) return { kind: "member", name };
  if (channel === "upload" && uploadedBy) return { kind: "former" };
  return null;
}

// Who brought a case in, for the report's header (D07 T03 §9), by the same expression and rule as the list.
export async function checkerName(
  db: D1Database,
  orgId: string,
  sent: { channel: string; forwardedBy: string | null; uploadedBy: string | null },
): Promise<Checker> {
  if (!sent.forwardedBy && !sent.uploadedBy) return null;
  const row = await db
    .prepare(`SELECT ${checkerSql("?1", "?2", "?3", "?4")} AS name`)
    .bind(orgId, sent.channel, sent.forwardedBy ?? null, sent.uploadedBy ?? null)
    .first<{ name: string | null }>();
  return checkerOf(sent.channel, row?.name ?? null, sent.uploadedBy);
}

// How many of today's checks an organisation has used (D01 T03 §6, the upload page's usage line; design/SPEC.md M2):
// its cases since 00:00 SAST against its daily cap by plan (`dailyCapSql`, D07 T08 §8), read as the cap that admits a
// case reads it (src/db/cases.ts `admitCase`), by the cap's own rule (`COUNTS_TOWARD_CAP`: a case whose admission
// failed before its file was stored uses none, D01 T03 §12), so the line and the cap never disagree.
export async function todayUsage(
  db: D1Database,
  orgId: string,
  now = new Date(),
): Promise<{ used: number; limit: number }> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM cases WHERE org_id = ? AND created_at >= ? AND ${COUNTS_TOWARD_CAP}) AS used, ${dailyCapSql()} AS lim`,
    )
    .bind(orgId, sastDayStart(now), ...dailyCapBinds(orgId, now))
    .first<{ used: number; lim: number }>();
  return { used: row?.used ?? 0, limit: row?.lim ?? DEFAULT_DAILY_CASES };
}
