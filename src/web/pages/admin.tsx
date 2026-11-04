// The admin console's routes (D07 T05 §2; design/SPEC.md X1 and X3, boards `Admin-Overview` and `Admin-Invites`):
// `GET /admin` draws every organisation with its plan, domains, members, cases this week, top threat, feedback and daily
// cap, the four spend bars, the summary tiles and the recent-incident panel; `GET /admin/invites` makes and lists
// invite codes; `GET /admin/organisations.csv` exports the table as filtered. Behind `requireAccess` (D07 T05 §1,
// mounted before every other handler in src/index.ts), so only the operator's Access session reaches these. The
// drawing is ./admin-view.tsx; the numbers below are the section's tested contract.
import { type Context, Hono } from "hono";
import { readSmallForm } from "../../auth/form";
import {
  CLAIM_TIMEOUT_MS,
  csvCell,
  hashInviteCode,
  type InviteDraft,
  type InviteErrors,
  KEY_LIFETIME_MS,
  newCreationKey,
  newInviteCode,
  parseInviteForm,
  sastDayOf,
  sastShort,
} from "../../auth/invite-codes";
import { clearDailyCapOverrideStatement, PLAN_DAILY_CASES, setDailyCapOverrideStatement } from "../../auth/plan-sql";
import { planOf } from "../../auth/plans";
import { weekStart } from "../../db/case-stats";
import { sastDayStart } from "../../db/cases";
import { ablations, latestFull } from "../../eval/results";
import { evalRuns } from "../../eval/runs";
import { type Statement, spentStatement } from "../../meta/budget-sql";
import { DAY_CAP_USD, RESERVE_DAYS, RESERVE_USD, totalLimitFor } from "../../meta/caps";
import { sastDay } from "../../meta/day";
import { abandonLostKeys, bankKeys, rekeyAccounts } from "../../trust/bank";
import { BankKeysMissing, KeyMismatch } from "../../trust/errors";
import { FIREWORKS_DAY_CAP_USD, FIREWORKS_TOTAL_CAP_USD, hourlyRateUsd } from "../../vision/glimmer-caps";
import { ledgerStatement } from "../../vision/glimmer-minutes";
import { CHECK_WORDS } from "../components/evidence/check-words";
import { AdminEvalPage } from "./admin-eval-view";
import {
  type CapDraft,
  type IncidentRow,
  type InviteItem,
  InvitesPage,
  type OrgRow,
  OverviewPage,
  type SpendBar,
} from "./admin-view";
import { errorPage, HEADERS } from "./errors";

type AdminEnv = { Bindings: Env; Variables: { accessEmail: string } };
export const adminRoutes = new Hono<AdminEnv>();

const run = (db: D1Database, s: Statement) => db.prepare(s.sql).bind(...s.params);
const html = (body: unknown, status = 200) => new Response(String(body), { status, headers: HEADERS });
const forbidden = () => new Response("Forbidden", { status: 403, headers: HEADERS });

function outage(why: string) {
  const ref = Math.random().toString(36).slice(2, 10);
  console.log(JSON.stringify({ event: "admin", outcome: "unavailable", reference: ref, error: why }));
  return errorPage(500, "", { ref, retry: "/admin" });
}

const sameOrigin = (c: Context<AdminEnv>) => c.req.header("origin") === new URL(c.env.APP_URL).origin;

// "Mon 27 Oct 2026, 14:02 SAST".
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function sastStamp(now: Date): string {
  const at = new Date(now.getTime() + 2 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} SAST`;
}

// The median and p95 of the verdict durations, read bounded: the ordered seconds are indexed by their row number and
// only the one or two rows each statistic needs are read, never the whole verdict table.
const DURATIONS = `SELECT s FROM (SELECT (julianday(v.created_at) - julianday(c.created_at)) * 86400.0 AS s FROM case_verdicts v JOIN cases c ON c.id = v.case_id) WHERE s >= 0 ORDER BY s`;
async function verdictLatency(db: D1Database): Promise<{ median: number | null; p95: number | null }> {
  const n = (await db.prepare("SELECT COUNT(*) AS n FROM case_verdicts").first<{ n: number }>())?.n ?? 0;
  if (!n) return { median: null, p95: null };
  const at = async (offset: number) =>
    (await db.prepare(`${DURATIONS} LIMIT 1 OFFSET ?`).bind(offset).first<{ s: number }>())?.s ?? null;
  const middle = Math.floor((n - 1) / 2);
  const first = await at(middle);
  const second = n % 2 === 0 ? await at(middle + 1) : first;
  const p95row = await at(Math.min(n - 1, Math.ceil(0.95 * n) - 1));
  if (first === null || second === null || p95row === null) return { median: null, p95: null };
  return { median: (first + second) / 2, p95: p95row };
}

type Org = { id: string; name: string; createdAt: string };

function planWords(state: Awaited<ReturnType<typeof planOf>>): { text: string; cap: number | null } {
  if (state === null) return { text: "Unknown", cap: null };
  if (state.plan === "trial")
    return { text: `Trial, ${state.daysLeft} day${state.daysLeft === 1 ? "" : "s"}`, cap: PLAN_DAILY_CASES.trial };
  if (state.plan === "free") return { text: "Free", cap: PLAN_DAILY_CASES.free };
  return { text: state.plan === "protect" ? "Protect" : "MSP", cap: PLAN_DAILY_CASES[state.plan] };
}

async function orgRow(db: D1Database, org: Org, now: Date, week: string): Promise<OrgRow> {
  const [state, domains, members, weekCases, checks, feedback, cap] = await Promise.all([
    planOf(db, org.id, now).catch(() => null),
    db
      .prepare("SELECT COUNT(*) AS n FROM org_domains WHERE org_id = ? AND state = 'verified'")
      .bind(org.id)
      .first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM "member" WHERE "organizationId" = ?').bind(org.id).first<{ n: number }>(),
    db
      .prepare("SELECT COUNT(*) AS n FROM cases WHERE org_id = ? AND created_at >= ?")
      .bind(org.id, week)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT o.check_name AS check_name, COUNT(*) AS n FROM check_outcomes o
         JOIN cases c ON c.id = o.case_id JOIN case_verdicts v ON v.case_id = c.id
         WHERE c.org_id = ? AND c.created_at >= ? AND v.verdict IN ('suspicious', 'malicious')
           AND o.outcome IN ('ran', 'partial') AND o.findings > 0
         GROUP BY o.check_name ORDER BY n DESC, o.check_name LIMIT 1`,
      )
      .bind(org.id, week)
      .first<{ check_name: string }>(),
    // Open means waiting on the operator: the effective triage state is new, including a complaint the member
    // edited after triage. Notice delivery still reads `notified_at`; it never moves this count.
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM feedback f JOIN cases c ON c.id = f.case_id
         WHERE c.org_id = ? AND (f.triage = 'new' OR (f.triaged_updated_at IS NOT NULL AND f.updated_at != f.triaged_updated_at))`,
      )
      .bind(org.id)
      .first<{ n: number }>(),
    db
      .prepare("SELECT daily_cases_override AS cap FROM org_limits WHERE org_id = ?")
      .bind(org.id)
      .first<{ cap: number | null }>(),
  ]);
  const pending =
    (
      await db
        .prepare("SELECT 1 AS one FROM org_domains WHERE org_id = ? AND state = 'pending' LIMIT 1")
        .bind(org.id)
        .first<{ one: number }>()
    )?.one === 1;
  // An unreadable plan reads Unknown for its row, never a whole-page outage for every other organisation, and
  // never a fabricated cap: with no plan to read from, the cap is Unknown until the operator sets an override.
  const { text: plan, cap: planCap } = planWords(state);
  const override = cap?.cap ?? null;
  return {
    id: org.id,
    name: org.name,
    created: org.createdAt,
    plan,
    domainsVerified: domains?.n ?? 0,
    domainsPending: pending,
    members: members?.n ?? 0,
    casesWeek: weekCases?.n ?? 0,
    topCheck: checks?.check_name ?? null,
    feedbackOpen: feedback?.n ?? 0,
    capOverride: override,
    capEffective: override ?? planCap,
  };
}

async function spendBars(db: D1Database, today: string): Promise<SpendBar[]> {
  const meta = await run(db, spentStatement(today)).first<{ day_usd: number; total_usd: number }>();
  const dayUsd = meta?.day_usd ?? 0;
  const totalUsd = meta?.total_usd ?? 0;
  const ledger = await run(db, ledgerStatement([today])).all<{ day: string; minutes: number }>();
  const minutesToday = ledger.results.find((r) => r.day === today)?.minutes ?? 0;
  const minutesTotal = ledger.results.find((r) => r.day === "*")?.minutes ?? 0;
  const rate = hourlyRateUsd();
  const fireToday = (minutesToday / 60) * rate;
  const fireTotal = (minutesTotal / 60) * rate;
  // The held-back US$30 spends only on the reserve days (src/meta/caps.ts): any other day says when it opens.
  const reserveNote = RESERVE_DAYS.includes(today)
    ? `US$${RESERVE_USD} reserve open today`
    : `US$${RESERVE_USD} reserve opens on ${sastDayOf(`${RESERVE_DAYS[0]}T12:00:00.000Z`)}`;
  return [
    { label: "Meta Model API today", amountUsd: dayUsd, capUsd: DAY_CAP_USD },
    { label: "Meta Model API total", amountUsd: totalUsd, capUsd: totalLimitFor(today), note: reserveNote },
    { label: "Fireworks today", amountUsd: fireToday, capUsd: FIREWORKS_DAY_CAP_USD },
    { label: "Fireworks total", amountUsd: fireTotal, capUsd: FIREWORKS_TOTAL_CAP_USD },
  ];
}

async function overviewRows(db: D1Database, now: Date, query: string): Promise<{ rows: OrgRow[]; total: number }> {
  const week = weekStart(now);
  // Search all three fields literally. EXISTS keeps one row per organisation when several domains match.
  const escaped = query.replace(/[\\%_]/g, (m) => `\\${m}`);
  const orgs = (
    await db
      .prepare(
        query
          ? `SELECT o.id, o.name, o."createdAt" AS createdAt FROM "organization" o
             WHERE o.name LIKE ? ESCAPE '\\' OR o.id LIKE ? ESCAPE '\\'
               OR EXISTS (SELECT 1 FROM org_domains d WHERE d.org_id = o.id
                          AND d.state = 'verified' AND d.domain LIKE ? ESCAPE '\\')
             ORDER BY o.name`
          : `SELECT id, name, "createdAt" AS createdAt FROM "organization" ORDER BY name`,
      )
      .bind(...(query ? Array(3).fill(`%${escaped}%`) : []))
      .all<Org>()
  ).results;
  const total = (await db.prepare('SELECT COUNT(*) AS n FROM "organization"').first<{ n: number }>())?.n ?? 0;
  return { rows: await Promise.all(orgs.map((org) => orgRow(db, org, now, week))), total };
}

async function incidentRows(db: D1Database): Promise<IncidentRow[]> {
  const rows = (
    await db
      .prepare(
        `SELECT e.at AS at, e.kind AS kind, e.outcome AS outcome, o.name AS org
         FROM auth_events e LEFT JOIN "organization" o ON o.id = e.org_id
         WHERE e.kind IN ('sign-in-failed', 'rate-limited') ORDER BY e.at DESC, e.rowid DESC LIMIT 20`,
      )
      .all<{ at: string; kind: string; outcome: string; org: string | null }>()
  ).results;
  return rows.map((r) => ({ at: r.at, kind: r.kind, org: r.org, outcome: r.outcome }));
}

// The navigation badge counts complaints waiting on the operator: the effective triage state `new`, including a
// complaint the member edited after triage. Notice delivery still reads `notified_at`; it never moves this count.
const OPEN_FEEDBACK_SQL =
  "SELECT COUNT(*) AS n FROM feedback WHERE triage = 'new' OR (triaged_updated_at IS NOT NULL AND updated_at != triaged_updated_at)";
async function shellOf(c: Context<AdminEnv>, db: D1Database) {
  const feedback = await db.prepare(OPEN_FEEDBACK_SQL).first<{ n: number }>();
  return { operator: c.get("accessEmail"), feedbackOpen: feedback?.n ?? 0 };
}

async function overviewOf(
  c: Context<AdminEnv>,
  db: D1Database,
  now: Date,
  query: string,
  draft: CapDraft | null = null,
) {
  const [shell, listed, spend, incidents, latency] = await Promise.all([
    shellOf(c, db),
    overviewRows(db, now, query),
    spendBars(db, sastDay(now)),
    incidentRows(db),
    verdictLatency(db),
  ]);
  const day = sastDayStart(now);
  const [todayCases, totalCases] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM cases WHERE created_at >= ?").bind(day).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM cases").first<{ n: number }>(),
  ]);
  const orgsVerified =
    (
      await db
        .prepare("SELECT COUNT(DISTINCT org_id) AS n FROM org_domains WHERE state = 'verified'")
        .first<{ n: number }>()
    )?.n ?? 0;
  // The tiles describe the whole service even while the table is searched; only the rows are filtered.
  const { rows, total } = listed;
  return {
    shell,
    generatedAt: sastStamp(now),
    organisations: total,
    orgsVerified,
    casesToday: todayCases?.n ?? 0,
    casesTotal: totalCases?.n ?? 0,
    medianSeconds: latency.median === null ? null : Math.round(latency.median),
    p95Seconds: latency.p95 === null ? null : Math.round(latency.p95),
    feedbackOpen: shell.feedbackOpen,
    spend,
    rows,
    query,
    incidents,
    capDraft: draft ?? null,
  };
}

const CSV_HEADER = "Organisation,Created,Plan,Domains verified,Members,Cases this week,Top threat,Feedback,Daily cap";
function organisationsCsv(rows: OrgRow[]): string {
  const lines = rows.map((r) =>
    [
      r.name,
      sastShort(r.created),
      r.plan,
      r.domainsVerified > 0 ? `${r.domainsVerified} verified` : r.domainsPending ? "Pending" : "None",
      r.members,
      r.casesWeek,
      r.topCheck === null ? "None yet" : (CHECK_WORDS[r.topCheck] ?? r.topCheck),
      r.feedbackOpen,
      r.capOverride === null
        ? r.capEffective === null
          ? "Unknown"
          : `Plan (${r.capEffective})`
        : `Override (${r.capOverride})`,
    ]
      .map(csvCell)
      .join(","),
  );
  return `${[CSV_HEADER, ...lines].join("\r\n")}\r\n`;
}

async function inviteItems(db: D1Database): Promise<InviteItem[]> {
  const rows = (
    await db
      .prepare(
        "SELECT id, code_hash, label, max_uses, uses, expires_at, revoked_at, created_at FROM invite_codes ORDER BY created_at DESC",
      )
      .all<{
        id: string;
        code_hash: string;
        label: string;
        max_uses: number;
        uses: number;
        expires_at: string;
        revoked_at: string | null;
        created_at: string;
      }>()
  ).results;
  return rows.map((r) => ({
    id: r.id,
    tag: r.code_hash.slice(0, 8),
    label: r.label,
    uses: r.uses,
    max_uses: r.max_uses,
    expires_at: r.expires_at,
    revoked_at: r.revoked_at,
    created: r.created_at,
  }));
}

const EMPTY_DRAFT: InviteDraft = { label: "", uses: "", expires: "" };

adminRoutes.get("/admin", async (c) => {
  try {
    const query = new URL(c.req.url).searchParams.get("q")?.trim() ?? "";
    return html(OverviewPage(await overviewOf(c, c.env.DB, new Date(), query)));
  } catch (error) {
    return outage((error as Error).name);
  }
});

// The operator's eval runs page (D08 T02 §9; design/SPEC.md X5): every run, the latest published report's
// five target tiles and the ablation table, through the same readers the public page uses.
adminRoutes.get("/admin/eval", async (c) => {
  try {
    const db = c.env.DB;
    const [shell, runs, latest] = await Promise.all([shellOf(c, db), evalRuns(db), latestFull(db)]);
    const rows = latest ? await ablations(db, latest.report) : [];
    return html(AdminEvalPage({ shell, runs, latest, ablations: rows }));
  } catch (error) {
    const ref = Math.random().toString(36).slice(2, 10);
    console.log(
      JSON.stringify({ event: "admin-eval", outcome: "unavailable", reference: ref, error: (error as Error).name }),
    );
    return errorPage(500, "", { ref, retry: "/admin/eval" });
  }
});

adminRoutes.get("/admin/organisations.csv", async (c) => {
  try {
    // The export reads only the organisation rows: spend, incidents, verdicts and tiles are the page's, not the file's.
    const query = new URL(c.req.url).searchParams.get("q")?.trim() ?? "";
    const { rows } = await overviewRows(c.env.DB, new Date(), query);
    return new Response(organisationsCsv(rows), {
      headers: {
        ...HEADERS,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="isitlegit-organisations.csv"',
      },
    });
  } catch (error) {
    return outage((error as Error).name);
  }
});

// One form, one code: every rendered form carries a single-use creation key, and the first POST for a key creates
// exactly one invite code. A repeat POST of the same key (a refreshed answer, a resubmission, a retried request)
// renders the already-submitted page naming the label instead of a second code.
async function mintCreationKey(db: D1Database, now: Date): Promise<string> {
  const key = newCreationKey();
  await db
    .prepare("DELETE FROM invite_creation_keys WHERE created_at < ?")
    .bind(new Date(now.getTime() - KEY_LIFETIME_MS).toISOString())
    .run();
  await db
    .prepare(
      "INSERT INTO invite_creation_keys (key_hash, code_id, claim, claimed_at, created_at) VALUES (?, NULL, NULL, NULL, ?)",
    )
    .bind(await hashInviteCode(key), now.toISOString())
    .run();
  return key;
}

async function invitesPage(
  c: Context<AdminEnv>,
  db: D1Database,
  now: Date,
  draft: InviteDraft,
  errors: InviteErrors,
  created: { code: string; label: string } | null,
  extra: { key: string; notice?: string } | null,
) {
  const [shell, items] = await Promise.all([shellOf(c, db), inviteItems(db)]);
  return html(
    InvitesPage({
      shell,
      now: now.toISOString(),
      draft,
      errors,
      created,
      notice: extra?.notice ?? null,
      creationKey: extra?.key ?? "",
      items,
    }),
  );
}

adminRoutes.get("/admin/invites", async (c) => {
  try {
    const db = c.env.DB;
    const now = new Date();
    const key = await mintCreationKey(db, now);
    return invitesPage(c, db, now, EMPTY_DRAFT, {}, null, { key });
  } catch (error) {
    return outage((error as Error).name);
  }
});

adminRoutes.post("/admin/invites", async (c) => {
  try {
    // Only the app's own page posts here: a form on another site, or a post with no origin, changes nothing.
    if (!sameOrigin(c)) return forbidden();
    const db = c.env.DB;
    const now = new Date();
    const form = await readSmallForm(c.req.raw, { key: 64, label: 200, uses: 12, expires: 10 });
    if (form === null) return outage("form-too-large");
    const draft: InviteDraft = { label: form.label ?? "", uses: form.uses ?? "", expires: form.expires ?? "" };
    const submitted = await db
      .prepare("SELECT key_hash, code_id, claim, claimed_at, created_at FROM invite_creation_keys WHERE key_hash = ?")
      .bind(await hashInviteCode((form.key ?? "").trim()))
      .first<{
        key_hash: string;
        code_id: string | null;
        claim: string | null;
        claimed_at: string | null;
        created_at: string;
      }>();
    const fresh = await mintCreationKey(db, now);
    // An unknown or day-old key is a stale form, not a refusal: the typed values are kept and a fresh key is issued.
    if (!submitted || submitted.created_at < new Date(now.getTime() - KEY_LIFETIME_MS).toISOString()) {
      return invitesPage(c, db, now, draft, {}, null, {
        key: fresh,
        notice: "That form had expired, so nothing was stored. Press Create code again.",
      });
    }
    if (submitted.code_id !== null) {
      const made = await db
        .prepare("SELECT label FROM invite_codes WHERE id = ?")
        .bind(submitted.code_id)
        .first<{ label: string }>();
      return invitesPage(c, db, now, EMPTY_DRAFT, {}, null, {
        key: fresh,
        notice: `That form was already submitted: the code for ${made?.label ?? "that label"} is listed below (it was shown once when made).`,
      });
    }
    const parsed = parseInviteForm(draft, sastDay(now));
    if ("errors" in parsed)
      return invitesPage(c, db, now, draft, parsed.errors, null, { key: (form.key ?? "").trim() });
    // One conditional UPDATE wins the key for exactly one request. The code insert and the key completion run
    // in one batch, so they land together or not at all: a failure between them cannot orphan a code the operator
    // never saw. The claim lives in its own column because code_id references invite_codes(id) and a claim token
    // is not a code. A claim older than CLAIM_TIMEOUT_MS with no code is abandoned (its holder failed) and a retry
    // takes the key over; with batch atomicity no orphan can exist for that key, because a code lands only with
    // its key completion.
    const claim = crypto.randomUUID();
    const cutoff = new Date(now.getTime() - CLAIM_TIMEOUT_MS).toISOString();
    for (let attempt = 0; ; attempt++) {
      const won =
        (
          await db
            .prepare(
              "UPDATE invite_creation_keys SET claim = ?, claimed_at = ? WHERE key_hash = ? AND code_id IS NULL AND (claim IS NULL OR claimed_at < ?)",
            )
            .bind(claim, now.toISOString(), submitted.key_hash, cutoff)
            .run()
        ).meta.changes === 1;
      if (won) break;
      // A freed key means the winner failed and released its claim, or abandoned it: take it over, once.
      let freed = false;
      for (let wait = 0; wait < 8; wait++) {
        await new Promise((done) => setTimeout(done, 25));
        const raced = await db
          .prepare("SELECT code_id, claim, claimed_at FROM invite_creation_keys WHERE key_hash = ?")
          .bind(submitted.key_hash)
          .first<{ code_id: string | null; claim: string | null; claimed_at: string | null }>();
        if (raced?.code_id) {
          const made = await db
            .prepare("SELECT label FROM invite_codes WHERE id = ?")
            .bind(raced.code_id)
            .first<{ label: string }>();
          return invitesPage(c, db, now, EMPTY_DRAFT, {}, null, {
            key: fresh,
            notice: `That form was already submitted: the code for ${made?.label ?? "that label"} is listed below (it was shown once when made).`,
          });
        }
        if (!raced || raced.claim === null || (raced.claimed_at !== null && raced.claimed_at < cutoff)) {
          freed = true;
          break;
        }
      }
      if (!freed || attempt > 0) {
        return invitesPage(c, db, now, draft, {}, null, {
          key: fresh,
          notice:
            "That form is still being stored by an earlier press. Check the list below; if no code appeared, press Create code again.",
        });
      }
    }
    const code = newInviteCode();
    const codeId = crypto.randomUUID();
    try {
      await db.batch([
        db
          .prepare(
            "INSERT INTO invite_codes (id, code_hash, label, max_uses, uses, expires_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
          )
          .bind(
            codeId,
            await hashInviteCode(code),
            parsed.value.label,
            parsed.value.maxUses,
            parsed.value.expiresAt,
            now.toISOString(),
          ),
        db
          .prepare(
            "UPDATE invite_creation_keys SET code_id = ?, claim = NULL, claimed_at = NULL WHERE key_hash = ? AND claim = ?",
          )
          .bind(codeId, submitted.key_hash, claim),
      ]);
    } catch (error) {
      await db
        .prepare("UPDATE invite_creation_keys SET claim = NULL, claimed_at = NULL WHERE key_hash = ? AND claim = ?")
        .bind(submitted.key_hash, claim)
        .run();
      throw error;
    }
    // Shown once, on this answer only: a reload (GET) never carries the code.
    return invitesPage(c, db, now, EMPTY_DRAFT, {}, { code, label: parsed.value.label }, { key: fresh });
  } catch (error) {
    return outage((error as Error).name);
  }
});

adminRoutes.post("/admin/invites/revoke", async (c) => {
  try {
    if (!sameOrigin(c)) return forbidden();
    const db = c.env.DB;
    const form = await readSmallForm(c.req.raw, { id: 64 });
    if (form === null) return outage("form-too-large");
    const id = (form.id ?? "").trim();
    if (id) {
      await db
        .prepare("UPDATE invite_codes SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .bind(new Date().toISOString(), id)
        .run();
    }
    return new Response(null, { status: 303, headers: { ...HEADERS, location: "/admin/invites" } });
  } catch (error) {
    return outage((error as Error).name);
  }
});

adminRoutes.post("/admin/orgs/cap", async (c) => {
  try {
    if (!sameOrigin(c)) return forbidden();
    const db = c.env.DB;
    const now = new Date();
    const form = await readSmallForm(c.req.raw, { orgId: 64, action: 8, cap: 12, q: 120 });
    if (form === null) return outage("form-too-large");
    const org = await db
      .prepare('SELECT id, name FROM "organization" WHERE id = ?')
      .bind((form.orgId ?? "").trim())
      .first<Org>();
    if (!org) return errorPage(404, "", {});
    if (form.action !== "set" && form.action !== "clear") return errorPage(404, "", {});
    // The search the operator came from travels with the post, so the answer returns to the same filtered table.
    const query = (form.q ?? "").trim();
    const back = query ? `/admin?q=${encodeURIComponent(query)}` : "/admin";
    if (form.action === "clear") {
      const statement = clearDailyCapOverrideStatement(org.id);
      await db
        .prepare(statement.sql)
        .bind(...statement.params)
        .run();
      return new Response(null, { status: 303, headers: { ...HEADERS, location: back } });
    }
    const raw = (form.cap ?? "").trim();
    const cases = Number(raw);
    // A blank field is not a zero: it refuses with the typed value kept and the stored cap untouched. The page
    // refuses outside the event's 0 to 50 (the operator's script may set up to 500 through
    // `setDailyCapOverrideStatement`, which this check leaves alone).
    if (!raw || !Number.isInteger(cases) || cases < 0 || cases > 50) {
      const props = await overviewOf(c, db, now, query, {
        orgId: org.id,
        cap: raw,
        error: "a daily cap is a whole number from 0 to 50",
      });
      return html(OverviewPage(props));
    }
    const statement = setDailyCapOverrideStatement(org.id, cases);
    await db
      .prepare(statement.sql)
      .bind(...statement.params)
      .run();
    return new Response(null, { status: 303, headers: { ...HEADERS, location: back } });
  } catch (error) {
    return outage((error as Error).name);
  }
});

// The bank key replacement action (D05 T01 §4; docs/operations.md, Bank keys): behind requireAccess and the
// console's same-origin check, it runs one of two operations chosen by the operator, never inferred from which
// secrets happen to be set. `rotate` moves every account from the previous pair (read only when present) to the
// pair the Worker now holds; `recover`, only with its explicit confirmation, abandons a pair lost for good.
// Answers carry counts and guidance only: never a number, a key or a key's fingerprint.
adminRoutes.post("/admin/bank-keys", async (c) => {
  const json = (body: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...HEADERS, "content-type": "application/json" } });
  try {
    if (!sameOrigin(c)) return forbidden();
    const form = await readSmallForm(c.req.raw, { operation: 16, confirm: 16 });
    if (form === null) return outage("form-too-large");
    const db = c.env.DB;
    const actor = c.get("accessEmail");
    let current: Awaited<ReturnType<typeof bankKeys>>;
    try {
      current = await bankKeys(c.env);
    } catch (error) {
      if (error instanceof BankKeysMissing)
        return json({ error: "the current bank keys are not set on this Worker; nothing was changed" }, 503);
      throw error;
    }
    if (form.operation === "rotate") {
      const previousKey = c.env.BANK_KEY_PREVIOUS;
      const previousMatchKey = c.env.BANK_MATCH_KEY_PREVIOUS;
      if (!previousKey || !previousMatchKey)
        return json({ error: "the previous bank keys are not set; rotation refused and nothing was changed" }, 409);
      let from: Awaited<ReturnType<typeof bankKeys>>;
      try {
        from = await bankKeys({ BANK_KEY: previousKey, BANK_MATCH_KEY: previousMatchKey });
      } catch (error) {
        if (error instanceof BankKeysMissing)
          return json({ error: "the previous bank keys are malformed; rotation refused and nothing was changed" }, 422);
        throw error;
      }
      if (from.id === current.id && from.matchId === current.matchId)
        return json({ error: "the previous and current keys are the same pair; nothing was changed" }, 422);
      try {
        const result = await rekeyAccounts(db, from, current, actor);
        // Completion is proven across both tables, not from this run's counts: any row still under other
        // keys (unreadable, or under a pair this run was not given) keeps the rotation unfinished.
        let remaining = 0;
        for (const table of ["bank_accounts", "supplier_accounts"]) {
          const row = await db
            .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE key_id != ? OR match_key_id != ?`)
            .bind(current.id, current.matchId)
            .first<{ n: number }>();
          remaining += row?.n ?? 0;
        }
        return json({
          operation: "rotate",
          moved: result.moved,
          unreadable: result.unreadable,
          organisations: result.byOrg.length,
          remaining,
          note:
            remaining > 0
              ? "Accounts still under other keys remain; they still refuse matches. Resolve them (a row that cannot be decrypted stays refused until its owner registers again), then post rotate again with the same keys."
              : "Every account now matches under the current keys; remove the previous secrets again.",
        });
      } catch (error) {
        if (error instanceof KeyMismatch)
          return json(
            {
              error: "the registry is under neither the previous nor the current keys; nothing was changed by this run",
            },
            409,
          );
        return json(
          {
            error:
              "the rotation did not finish; some organisations may already have moved, each with its audit event. Post the same operation again with the same keys to finish only what is left.",
          },
          500,
        );
      }
    }
    if (form.operation === "recover") {
      if (form.confirm !== "recover")
        return json({ error: "recovery needs its explicit confirmation; nothing was changed" }, 422);
      let result: Awaited<ReturnType<typeof abandonLostKeys>>;
      try {
        result = await abandonLostKeys(db, current, actor);
      } catch {
        return json(
          {
            error:
              "the recovery did not finish; some accounts may already have been deleted, each with its audit event. Post the same operation again with the same confirmation to finish only what is left.",
          },
          500,
        );
      }
      return json({
        operation: "recover",
        deleted: result.deleted,
        kept: result.kept,
        note: "A kept account still refuses matches with KeyMismatch until its owner removes it on the identity page or in the supplier ledger and registers it again.",
      });
    }
    return json({ error: "the operation must be rotate or recover; nothing was changed" }, 422);
  } catch (error) {
    return outage((error as Error).name);
  }
});
