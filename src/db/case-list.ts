// One page of an organisation's cases for the Cases list (D07 T04 §1; design/SPEC.md M1): newest first by arrival then
// id, 25 a page, filtered by verdict, channel and period, with the matching count and the organisation's total. Every
// read is scoped by the organisation. Who checked an email case is its forwarder matched to a member of the
// organisation by address (their name, else the address); an upload stores no uploader yet (D07 T04 §7).
import { CaseFilters, type ListResult, PAGE_SIZE } from "./case-filters";
import {
  type CaseStatus,
  type Channel,
  DEFAULT_DAILY_CASES,
  type SourceKind,
  sastDayStart,
  type Verdict,
} from "./cases";

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
  checker: string | null;
};

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
              `SELECT c.id, c.channel, c.source_kind, c.status, c.verdict, c.created_at, c.forwarded_by,
                ${checkerSql("c.org_id", "lower(c.forwarded_by)", "c.uploaded_by")} AS checker
              FROM cases c WHERE ${clause.replace(/\b(org_id|verdict|channel|created_at)\b/g, "c.$1")}
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
          // The member who sent it in, by name; else a forwarding address (an upload's uploader is an id, never shown).
          checkedBy: r.checker ?? r.forwarded_by,
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

// Who sent a case in, by name: a member of the case's organisation whose email is the forwarding address, or (an upload)
// whose id is the uploader's, with a name that is not blank. One expression, read by the Cases list and the report's
// header alike, so the two never disagree (they did for uploads until 2026-10-31: the list matched the address only).
function checkerSql(org: string, forwardedBy: string, uploadedBy: string): string {
  return `(SELECT NULLIF(trim(u.name), '') FROM "user" u JOIN "member" m ON m."userId" = u.id
    WHERE m."organizationId" = ${org} AND (lower(u.email) = ${forwardedBy} OR u.id = ${uploadedBy}) LIMIT 1)`;
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
    .prepare(`SELECT ${checkerSql("?", "?", "?")} AS name`)
    .bind(orgId, sent.forwardedBy?.toLowerCase() ?? null, sent.uploadedBy ?? null)
    .first<{ name: string | null }>();
  return row?.name ?? null;
}

// How many of today's checks an organisation has used (D01 T03 §6, the upload page's usage line; design/SPEC.md M2):
// its cases since 00:00 SAST against its own daily limit (`org_limits.daily_cases`), or the default, read as the cap
// that admits a case reads them (src/db/cases.ts `admitCase`).
export async function todayUsage(
  db: D1Database,
  orgId: string,
  now = new Date(),
): Promise<{ used: number; limit: number }> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM cases WHERE org_id = ? AND created_at >= ?) AS used,
        COALESCE((SELECT daily_cases FROM org_limits WHERE org_id = ?), ?) AS lim`,
    )
    .bind(orgId, sastDayStart(now), orgId, DEFAULT_DAILY_CASES)
    .first<{ used: number; lim: number }>();
  return { used: row?.used ?? 0, limit: row?.lim ?? DEFAULT_DAILY_CASES };
}
