// The admin console's routes (D07 T05 §2; design/SPEC.md X1 and X3, boards `Admin-Overview` and `Admin-Invites`):
// `GET /admin` draws every organisation with its plan, domains, members, cases this week, top threat, feedback and daily
// cap, the four spend bars, the summary tiles and the recent-incident panel; `GET /admin/invites` makes and lists
// invite codes; `GET /admin/organisations.csv` exports the table as filtered. Behind `requireAccess` (D07 T05 §1,
// mounted before every other handler in src/index.ts), so only the operator's Access session reaches these. The
// drawing is ./admin-view.tsx; the numbers below are the section's tested contract.
import { type Context, Hono } from "hono";
import { readSmallForm } from "../../auth/form";
import {
  csvCell,
  hashInviteCode,
  type InviteDraft,
  type InviteErrors,
  newInviteCode,
  parseInviteForm,
  sastDayOf,
} from "../../auth/invite-codes";
import { clearDailyCapOverrideStatement, PLAN_DAILY_CASES, setDailyCapOverrideStatement } from "../../auth/plan-sql";
import { planOf } from "../../auth/plans";
import { median, weekStart } from "../../db/case-stats";
import { sastDayStart } from "../../db/cases";
import { type Statement, spentStatement } from "../../meta/budget-sql";
import { DAY_CAP_USD, RESERVE_DAYS, RESERVE_USD, totalLimitFor } from "../../meta/caps";
import { sastDay } from "../../meta/day";
import { FIREWORKS_DAY_CAP_USD, FIREWORKS_TOTAL_CAP_USD, hourlyRateUsd } from "../../vision/glimmer-caps";
import { ledgerStatement } from "../../vision/glimmer-minutes";
import { CHECK_WORDS } from "../components/evidence/check-words";
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

// The p95 of whole seconds, nearest-rank; null when nothing was decided.
function p95(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] as number;
}

type Org = { id: string; name: string; createdAt: string };

function planWords(state: Awaited<ReturnType<typeof planOf>>): { text: string; cap: number } {
  if (state === null) return { text: "Unknown", cap: 50 };
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
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM feedback f JOIN cases c ON c.id = f.case_id WHERE c.org_id = ? AND f.notified_at IS NULL",
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
  // An unreadable plan reads Unknown for its row, never a whole-page outage for every other organisation.
  const { text: plan, cap: planCap } = planWords(state);
  const override = cap?.cap ?? null;
  return {
    id: org.id,
    name: org.name,
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
  // A search matches the name literally: its wildcards are escaped, so an organisation named "100%" is found.
  const escaped = query.replace(/[\\%_]/g, (m) => `\\${m}`);
  const orgs = (
    await db
      .prepare(
        query
          ? `SELECT id, name, "createdAt" AS createdAt FROM "organization" WHERE name LIKE ? ESCAPE '\\' ORDER BY name`
          : `SELECT id, name, "createdAt" AS createdAt FROM "organization" ORDER BY name`,
      )
      .bind(...(query ? [`%${escaped}%`] : []))
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

async function shellOf(c: Context<AdminEnv>, db: D1Database) {
  const feedback = await db
    .prepare("SELECT COUNT(*) AS n FROM feedback WHERE notified_at IS NULL")
    .first<{ n: number }>();
  return { operator: c.get("accessEmail"), feedbackOpen: feedback?.n ?? 0 };
}

async function overviewOf(
  c: Context<AdminEnv>,
  db: D1Database,
  now: Date,
  query: string,
  draft: CapDraft | null = null,
) {
  const [shell, listed, spend, incidents, verdicts] = await Promise.all([
    shellOf(c, db),
    overviewRows(db, now, query),
    spendBars(db, sastDay(now)),
    incidentRows(db),
    db
      .prepare(
        `SELECT c.created_at AS arrived, v.created_at AS decided FROM case_verdicts v JOIN cases c ON c.id = v.case_id`,
      )
      .all<{ arrived: string; decided: string }>(),
  ]);
  const seconds = verdicts.results
    .map((v) => (Date.parse(v.decided) - Date.parse(v.arrived)) / 1000)
    .filter((s) => Number.isFinite(s) && s >= 0);
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
  const med = median(seconds);
  // The tiles describe the whole service even while the table is searched; only the rows are filtered.
  const { rows, total } = listed;
  return {
    shell,
    generatedAt: sastStamp(now),
    organisations: total,
    orgsVerified,
    casesToday: todayCases?.n ?? 0,
    casesTotal: totalCases?.n ?? 0,
    medianSeconds: med === null ? null : Math.round(med),
    p95Seconds: p95(seconds) === null ? null : Math.round(p95(seconds) as number),
    feedbackOpen: shell.feedbackOpen,
    spend,
    rows,
    query,
    incidents,
    capDraft: draft ?? null,
  };
}

const CSV_HEADER = "Organisation,Plan,Domains verified,Members,Cases this week,Top threat,Feedback,Daily cap";
function organisationsCsv(rows: OrgRow[]): string {
  const lines = rows.map((r) =>
    [
      r.name,
      r.plan,
      r.domainsVerified > 0 ? `${r.domainsVerified} verified` : r.domainsPending ? "Pending" : "None",
      r.members,
      r.casesWeek,
      r.topCheck === null ? "None yet" : (CHECK_WORDS[r.topCheck] ?? r.topCheck),
      r.feedbackOpen,
      r.capOverride === null ? `Plan (${r.capEffective})` : `Override (${r.capOverride})`,
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

adminRoutes.get("/admin/organisations.csv", async (c) => {
  try {
    const query = new URL(c.req.url).searchParams.get("q")?.trim() ?? "";
    const { rows } = await overviewOf(c, c.env.DB, new Date(), query);
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

adminRoutes.get("/admin/invites", async (c) => {
  try {
    const db = c.env.DB;
    const now = new Date();
    const [shell, items] = await Promise.all([shellOf(c, db), inviteItems(db)]);
    return html(InvitesPage({ shell, now: now.toISOString(), draft: EMPTY_DRAFT, errors: {}, created: null, items }));
  } catch (error) {
    return outage((error as Error).name);
  }
});

async function invitesPage(
  c: Context<AdminEnv>,
  db: D1Database,
  now: Date,
  draft: InviteDraft,
  errors: InviteErrors,
  created: { code: string; label: string } | null,
) {
  const [shell, items] = await Promise.all([shellOf(c, db), inviteItems(db)]);
  return html(InvitesPage({ shell, now: now.toISOString(), draft, errors, created, items }));
}

adminRoutes.post("/admin/invites", async (c) => {
  try {
    // Only the app's own page posts here: a form on another site, or a post with no origin, changes nothing.
    if (!sameOrigin(c)) return forbidden();
    const db = c.env.DB;
    const now = new Date();
    const form = await readSmallForm(c.req.raw, { label: 200, uses: 12, expires: 10 });
    if (form === null) return outage("form-too-large");
    const draft: InviteDraft = { label: form.label ?? "", uses: form.uses ?? "", expires: form.expires ?? "" };
    const parsed = parseInviteForm(draft, sastDay(now));
    if ("errors" in parsed) return invitesPage(c, db, now, draft, parsed.errors, null);
    const code = newInviteCode();
    await db
      .prepare(
        "INSERT INTO invite_codes (id, code_hash, label, max_uses, uses, expires_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
      )
      .bind(
        crypto.randomUUID(),
        await hashInviteCode(code),
        parsed.value.label,
        parsed.value.maxUses,
        parsed.value.expiresAt,
        now.toISOString(),
      )
      .run();
    // Shown once, on this answer only: a reload (GET) never carries the code.
    return invitesPage(c, db, now, EMPTY_DRAFT, {}, { code, label: parsed.value.label });
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
    const form = await readSmallForm(c.req.raw, { orgId: 64, action: 8, cap: 12 });
    if (form === null) return outage("form-too-large");
    const org = await db
      .prepare('SELECT id, name FROM "organization" WHERE id = ?')
      .bind((form.orgId ?? "").trim())
      .first<Org>();
    if (!org) return errorPage(404, "", {});
    if (form.action === "clear") {
      const statement = clearDailyCapOverrideStatement(org.id);
      await db
        .prepare(statement.sql)
        .bind(...statement.params)
        .run();
      return new Response(null, { status: 303, headers: { ...HEADERS, location: "/admin" } });
    }
    if (form.action !== "set") return errorPage(404, "", {});
    const raw = (form.cap ?? "").trim();
    const cases = Number(raw);
    // The page refuses outside the event's 0 to 50 (the operator's script may set up to 500 through
    // `setDailyCapOverrideStatement`, which this check leaves alone).
    if (!Number.isInteger(cases) || cases < 0 || cases > 50) {
      const query = "";
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
    return new Response(null, { status: 303, headers: { ...HEADERS, location: "/admin" } });
  } catch (error) {
    return outage((error as Error).name);
  }
});
