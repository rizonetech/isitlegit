// The feedback queue's routes (D07 T08 §5; design/SPEC.md X4, board `Admin-Feedback`): `GET /admin/feedback`
// draws the New, Triaged and Closed tabs with counts, the queue table and the selected report's detail panel;
// the note, close and reopen posts mutate through the triage module and re-render with fresh data. Behind
// `requireAccess` (mounted after `adminRoutes` in src/index.ts), so only the operator's Access session reaches these.
// The drawing is ./admin-feedback-view.tsx; the triage state is ../../db/feedback-triage.ts.
import { type Context, Hono } from "hono";
import { readSmallForm } from "../../auth/form";
import { listTriage, moveTriage, saveTriageNote, type Triage, triageCounts } from "../../db/feedback-triage";
import { signReportLink } from "../report-link";
import { FeedbackQueuePage, type OrgFeedbackItem, type QueueDetail, type QueueItem } from "./admin-feedback-view";
import { caseLines, whenText } from "./cases-view";
import { errorPage, HEADERS } from "./errors";

type AdminEnv = { Bindings: Env; Variables: { accessEmail: string } };
export const adminFeedbackRoutes = new Hono<AdminEnv>();

const html = (body: unknown, status = 200) => new Response(String(body), { status, headers: HEADERS });
const forbidden = () => new Response("Forbidden", { status: 403, headers: HEADERS });

function outage(why: string) {
  const ref = Math.random().toString(36).slice(2, 10);
  console.log(JSON.stringify({ event: "admin-feedback", outcome: "unavailable", reference: ref, error: why }));
  return errorPage(500, "", { ref, retry: "/admin/feedback" });
}

const sameOrigin = (c: Context<AdminEnv>) => c.req.header("origin") === new URL(c.env.APP_URL).origin;

type QueueRow = {
  id: string;
  case_id: string;
  user_id: string;
  kind: "false_alarm" | "missed";
  note: string | null;
  providers_json: string;
  created_at: string;
  updated_at: string;
  triage: Triage;
  triage_note: string | null;
  triaged_updated_at: string | null;
  channel: "email" | "upload";
  source_kind: "mail" | "document" | "image" | "audio";
  original_subject: string | null;
  original_from_name: string | null;
  original_from_address: string | null;
  upload_name: string | null;
  upload_media_type: string | null;
  org_id: string;
  org_name: string;
  verdict: "safe" | "suspicious" | "malicious" | null;
  reasons: string | null;
  source: string | null;
};

const QUEUE_SELECT = `SELECT f.id, f.case_id, f.user_id, f.kind, f.note, f.providers_json, f.created_at, f.updated_at,
  f.triage, f.triage_note, f.triaged_updated_at,
  c.channel, c.source_kind, c.original_subject, c.original_from_name, c.original_from_address,
  c.upload_name, c.upload_media_type, c.org_id, o.name AS org_name,
  v.verdict, v.reasons, v.source
  FROM feedback f
  JOIN cases c ON c.id = f.case_id
  JOIN "organization" o ON o.id = c.org_id
  LEFT JOIN case_verdicts v ON v.case_id = f.case_id`;

const providersOf = (row: QueueRow): string[] => {
  try {
    const parsed: unknown = JSON.parse(row.providers_json);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
};

function driversOf(reasons: string | null): string[] {
  if (!reasons) return [];
  try {
    const parsed: unknown = JSON.parse(reasons);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) =>
        typeof item === "string"
          ? item
          : item && typeof item === "object" && "text" in item
            ? String((item as { text: unknown }).text)
            : null,
      )
      .filter((text): text is string => typeof text === "string" && text.length > 0)
      .slice(0, 8);
  } catch {
    return [];
  }
}

// The queue table's rows with the verdict names the top checks gave them: one extra read for the page's cases,
// never one per row.
async function topChecks(db: D1Database, caseIds: string[]): Promise<Map<string, string>> {
  if (caseIds.length === 0) return new Map();
  const marks = caseIds.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT o.case_id AS case_id, o.check_name AS check_name, COUNT(*) AS n FROM check_outcomes o
       JOIN case_verdicts v ON v.case_id = o.case_id
       WHERE o.case_id IN (${marks}) AND o.outcome IN ('ran', 'partial') AND o.findings > 0
         AND v.verdict IN ('suspicious', 'malicious')
       GROUP BY o.case_id, o.check_name`,
    )
    .bind(...caseIds)
    .all<{ case_id: string; check_name: string; n: number }>();
  const best = new Map<string, { name: string; n: number }>();
  for (const row of rows.results) {
    const seen = best.get(row.case_id);
    if (!seen || row.n > seen.n) best.set(row.case_id, { name: row.check_name, n: row.n });
  }
  return new Map([...best].map(([id, top]) => [id, top.name]));
}

function titleOf(row: QueueRow): string {
  return caseLines({
    channel: row.channel,
    sourceKind: row.source_kind,
    status: "done",
    verdict: row.verdict,
    createdAt: row.created_at,
    checkedBy: null,
    subject: row.original_subject,
    senderName: row.original_from_name,
    senderAddress: row.original_from_address,
    uploadName: row.upload_name,
    uploadMediaType: row.upload_media_type,
    hasInvoice: false,
    hasPaymentDocument: false,
    id: row.case_id,
  }).title;
}

async function queueItems(
  db: D1Database,
  rows: QueueRow[],
  secret: string | undefined,
  now: Date,
): Promise<QueueItem[]> {
  const checks = await topChecks(
    db,
    rows.map((row) => row.case_id),
  );
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      caseTitle: titleOf(row),
      caseHref: await signReportLink(secret, row.case_id, row.org_id, now.getTime()),
      orgName: row.org_name,
      verdict:
        row.verdict === "malicious" ? "Malicious" : row.verdict === "suspicious" ? "Suspicious" : ("Safe" as const),
      theySay: row.kind === "false_alarm" ? ("Safe" as const) : ("Unsafe" as const),
      decidedBy: providersOf(row)[0] ?? checks.get(row.case_id) ?? row.source ?? "the verdict",
      when: whenText(row.created_at, now),
    })),
  );
}

// The member's name for the quote's "wrote" line, else null (a former member's words keep no name).
async function quoteName(db: D1Database, userId: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT u.name AS name FROM "user" u JOIN "member" m ON m."userId" = u.id WHERE m."userId" = ? LIMIT 1`)
    .bind(userId)
    .first<{ name: string | null }>();
  return row?.name?.trim() || null;
}

// The selected report's detail, re-read fresh after every mutation; a withdrawn row reads as withdrawn, and the
// operator's typed note survives a refusal.
async function detailOf(
  db: D1Database,
  secret: string | undefined,
  now: Date,
  id: string,
  override?: { note?: string; notice?: string | null; error?: string | null },
): Promise<QueueDetail> {
  const withdrawn: QueueDetail = {
    id,
    title: "Report",
    caseHref: null,
    status: "new",
    quoteName: null,
    quote: null,
    drivers: [],
    note: override?.note ?? "",
    updatedAt: "",
    withdrawn: true,
    notice: override?.notice ?? null,
    error: override?.error ?? null,
  };
  const row = await db.prepare(`${QUEUE_SELECT} WHERE f.id = ?`).bind(id).first<QueueRow>();
  if (!row) return withdrawn;
  // The same effective rule as the triage module: a row changed after it was triaged reads as new.
  const effective =
    row.triage !== "new" && row.triaged_updated_at !== null && row.updated_at !== row.triaged_updated_at
      ? "new"
      : row.triage;
  // A signing failure hides the report action instead of breaking the panel; the signed route still refuses a
  // bad link when one is followed.
  let caseHref: string | null = null;
  try {
    caseHref = await signReportLink(secret, row.case_id, row.org_id, now.getTime());
  } catch {
    caseHref = null;
  }
  return {
    id: row.id,
    title: titleOf(row),
    caseHref,
    status: effective,
    quoteName: await quoteName(db, row.user_id),
    quote: row.note,
    drivers: driversOf(row.reasons),
    note: override?.note ?? row.triage_note ?? "",
    updatedAt: row.updated_at,
    withdrawn: false,
    notice: override?.notice ?? null,
    error: override?.error ?? null,
  };
}

async function drawQueue(
  c: Context<AdminEnv>,
  db: D1Database,
  now: Date,
  tab: Triage,
  page: number,
  detail: QueueDetail | null,
) {
  const counts = await triageCounts(db);
  const listed = await listTriage(db, tab, page);
  const full =
    listed.length > 0
      ? await db
          .prepare(`${QUEUE_SELECT} WHERE f.id IN (${listed.map(() => "?").join(",")}) ORDER BY f.created_at DESC`)
          .bind(...listed.map((row) => row.id))
          .all<QueueRow>()
      : { results: [] as QueueRow[] };
  const pages = Math.max(1, Math.ceil(counts[tab] / 50));
  return html(
    FeedbackQueuePage({
      shell: { feedbackOpen: counts.new, operator: c.get("accessEmail") },
      generatedAt: "",
      tabs: counts,
      tab,
      items: await queueItems(db, full.results, c.env.REPORT_LINK_SECRET, now),
      page,
      pages,
      detail,
    }),
  );
}

const tabOf = (value: string | null): Triage => (value === "triaged" || value === "closed" ? value : "new");

// The organisation detail's feedback card (D07 T08 §5 X2): the most recent reports whatever their tab, each with
// the effective status the queue would show it under.
export async function orgFeedbackItems(
  db: D1Database,
  orgId: string,
  limit: number,
  secret: string | undefined,
  now: Date,
): Promise<OrgFeedbackItem[]> {
  const rows = await db
    .prepare(`${QUEUE_SELECT} WHERE c.org_id = ? ORDER BY f.created_at DESC LIMIT ?`)
    .bind(orgId, limit)
    .all<QueueRow>();
  const items = await queueItems(db, rows.results, secret, now);
  return rows.results.map((row, index) => {
    const item = items[index];
    if (!item) throw new Error("orgFeedbackItems: queue item missing for its row");
    const effective =
      row.triage !== "new" && row.triaged_updated_at !== null && row.updated_at !== row.triaged_updated_at
        ? "new"
        : row.triage;
    return {
      id: item.id,
      caseTitle: item.caseTitle,
      caseHref: item.caseHref,
      verdict: item.verdict,
      theySay: item.theySay,
      status:
        effective === "new" ? ("New" as const) : effective === "triaged" ? ("Triaged" as const) : ("Closed" as const),
    };
  });
}

adminFeedbackRoutes.get("/admin/feedback", async (c) => {
  try {
    const db = c.env.DB;
    const now = new Date();
    const tab = tabOf(c.req.query("triage") ?? null);
    const page = Math.max(0, Number.parseInt(c.req.query("page") ?? "0", 10) || 0);
    const selected = c.req.query("selected") ?? null;
    return drawQueue(
      c,
      db,
      now,
      tab,
      page,
      selected ? await detailOf(db, c.env.REPORT_LINK_SECRET, now, selected) : null,
    );
  } catch (error) {
    return outage((error as Error).name);
  }
});

adminFeedbackRoutes.post("/admin/feedback/action", async (c) => {
  try {
    if (!sameOrigin(c)) return forbidden();
    const db = c.env.DB;
    const now = new Date();
    const secret = c.env.REPORT_LINK_SECRET;
    // The transport bound covers the whole body cap: `readSmallForm` drops a field that exceeds its bound, so a
    // bound below the body cap would turn an overlong note into a silently emptied one that saves as null and
    // acts. With the bound here, every note that parses is measured by the explicit limit below. One form carries
    // the note to every action, so a Close or Reopen never discards words the operator typed.
    const form = await readSmallForm(c.req.raw, {
      id: 64,
      note: 8192,
      updatedAt: 30,
      triage: 8,
      page: 6,
      action: 8,
    });
    if (!form) return outage("form-too-large");
    const action = form.action ?? "";
    if (action !== "note" && action !== "close" && action !== "reopen") return errorPage(404, "", {});
    const tab = tabOf(form.triage ?? null);
    const page = Math.max(0, Number.parseInt(form.page ?? "0", 10) || 0);
    const id = (form.id ?? "").trim();
    const typed = form.note ?? "";
    const refuse = async (error: string, keepNote = true) =>
      drawQueue(c, db, now, tab, page, {
        ...(await detailOf(db, secret, now, id, keepNote ? { note: typed } : {})),
        error,
      });
    if (!id) return refuse("That report is missing.");
    if (typed.length > 1000) return refuse("The note is too long: keep it to 1000 characters.");
    const note = typed.trim() || null;
    try {
      const saved = await saveTriageNote(db, { id, note, knownUpdatedAt: form.updatedAt ?? "" });
      if (!saved)
        return refuse("That report changed while you worked. The fresh words are shown; check them and save again.");
      if (action === "note") {
        return drawQueue(c, db, now, saved.triage, 0, {
          ...(await detailOf(db, secret, now, id)),
          notice: "Note saved.",
        });
      }
      const moved = await moveTriage(db, {
        id,
        to: action === "close" ? "closed" : "triaged",
        knownUpdatedAt: saved.updatedAt,
      });
      if (!moved)
        return refuse("That report changed while you worked. The fresh words are shown; check them and try again.");
      return drawQueue(c, db, now, moved.triage, 0, {
        ...(await detailOf(db, secret, now, id)),
        notice: action === "close" ? "Closed: the verdict was right." : "Reopened for another look.",
      });
    } catch {
      return drawQueue(c, db, now, tab, page, {
        ...(await detailOf(db, secret, now, id, { note: typed })),
        error: "We could not save that just now. Your note is kept here; try again.",
      });
    }
  } catch (error) {
    return outage((error as Error).name);
  }
});
