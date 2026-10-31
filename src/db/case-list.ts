// One page of an organisation's cases for the Cases list (D07 T04 §1; design/SPEC.md M1): newest first by arrival then
// id, 25 a page, filtered by verdict, channel and period, with the matching count and the organisation's total. Every
// read is scoped by the organisation. Who checked an email case is its forwarder matched to a member of the
// organisation by address (their name, else the address); an upload stores no uploader yet (D07 T04 §7).
import { CaseFilters, type ListResult, PAGE_SIZE } from "./case-filters";
import { type CaseStatus, type Channel, type SourceKind, sastDayStart, type Verdict } from "./cases";

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
                (SELECT NULLIF(trim(u.name), '') FROM "user" u JOIN "member" m ON m."userId" = u.id
                  WHERE m."organizationId" = c.org_id AND lower(u.email) = c.forwarded_by LIMIT 1) AS checker
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
          checkedBy: r.channel === "email" ? (r.checker ?? r.forwarded_by) : null,
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
