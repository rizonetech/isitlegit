// The organisation detail's routes (D07 T08 §5; design/SPEC.md X2, board `Admin-Org`): `GET /admin/orgs/:id`
// draws the header with Extend trial and Change daily cap, onboarding, domains, members, cases by week, top
// threats, this organisation's feedback and the plan card; the trial and cap posts mutate through `setPlan`'s
// neighbours (`extendTrial`, the cap override statements). Behind `requireAccess` (mounted after `adminRoutes` in
// src/index.ts), so only the operator's Access session reaches these. The drawing is ./admin-org-view.tsx.
import { type Context, Hono } from "hono";
import { readSmallForm } from "../../auth/form";
import { sastShort } from "../../auth/invite-codes";
import { clearDailyCapOverrideStatement, PLAN_DAILY_CASES, setDailyCapOverrideStatement } from "../../auth/plan-sql";
import { extendTrial, planOf, STORED_PLANS, setPlan } from "../../auth/plans";
import { weeklyCounts } from "../../db/case-stats";
import { sastDayStart } from "../../db/cases";
import { triageCounts } from "../../db/feedback-triage";
import { CHECK_WORDS } from "../components/evidence/check-words";
import { stepsOf } from "../pages/welcome-steps";
import { orgFeedbackItems } from "./admin-feedback";
import { type MemberRow, OrgDetailPage, type OrgFeedbackRow, type WeekBar } from "./admin-org-view";
import { errorPage, HEADERS } from "./errors";
import { readInvitations, readMembers } from "./team";

type AdminEnv = { Bindings: Env; Variables: { accessEmail: string } };
export const adminOrgRoutes = new Hono<AdminEnv>();

const html = (body: unknown, status = 200) => new Response(String(body), { status, headers: HEADERS });
const forbidden = () => new Response("Forbidden", { status: 403, headers: HEADERS });

function outage(why: string) {
  const ref = Math.random().toString(36).slice(2, 10);
  console.log(JSON.stringify({ event: "admin-org", outcome: "unavailable", reference: ref, error: why }));
  return errorPage(500, "", { ref, retry: "/admin" });
}

const sameOrigin = (c: Context<AdminEnv>) => c.req.header("origin") === new URL(c.env.APP_URL).origin;

type Org = { id: string; name: string; createdAt: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "Mon 10 Nov 2026", in SAST.
function sastLong(iso: string): string {
  const at = new Date(Date.parse(iso) + 2 * 3_600_000);
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

function roleWord(role: string): string {
  return role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Member";
}

async function drawOrg(
  c: Context<AdminEnv>,
  db: D1Database,
  now: Date,
  orgId: string,
  override?: {
    capValue?: string | null;
    capError?: string | null;
    capNotice?: string | null;
    trialError?: string | null;
    trialNotice?: string | null;
    trialValue?: string | null;
    planError?: string | null;
    planNotice?: string | null;
  },
) {
  const org = await db
    .prepare('SELECT id, name, "createdAt" AS createdAt FROM "organization" WHERE id = ?')
    .bind(orgId)
    .first<Org>();
  if (!org) return c.notFound();
  const [state, steps, members, invitations, capRow, invite, weeks] = await Promise.all([
    planOf(db, org.id, now).catch(() => null),
    stepsOf(db, org.id),
    readMembers(db, org.id),
    readInvitations(db, org.id),
    db
      .prepare("SELECT daily_cases_override AS cap FROM org_limits WHERE org_id = ?")
      .bind(org.id)
      .first<{ cap: number | null }>(),
    db
      .prepare(
        `SELECT c.label AS label FROM invite_redemptions r JOIN invite_codes c ON c.id = r.code_id WHERE r.org_id = ? ORDER BY r.created_at DESC LIMIT 1`,
      )
      .bind(org.id)
      .first<{ label: string }>(),
    weeklyCounts(db, org.id, now, 3),
  ]);
  const planText =
    state === null
      ? "Unknown"
      : state.plan === "trial"
        ? `Trial, ${state.daysLeft} day${state.daysLeft === 1 ? "" : "s"} left`
        : state.plan === "free"
          ? "Free"
          : state.plan === "protect"
            ? "Protect"
            : "MSP";
  const cap = capRow?.cap ?? null;
  const planCap =
    state === null
      ? null
      : state.plan === "trial"
        ? PLAN_DAILY_CASES.trial
        : state.plan === "free"
          ? PLAN_DAILY_CASES.free
          : PLAN_DAILY_CASES[state.plan];
  const effectiveCap = cap ?? planCap;
  const meta = [
    `Joined ${sastLong(org.createdAt)}${invite ? ` with invite ${invite.label}` : ""}`,
    `${members.length + invitations.length} members`,
    effectiveCap === null ? "daily cap unknown" : `daily cap ${effectiveCap} cases`,
  ].join(" · ");
  const domainRows = await db
    .prepare(
      `SELECT domain, state, method, verified_at AS verifiedAt FROM org_domains WHERE org_id = ? ORDER BY domain`,
    )
    .bind(org.id)
    .all<{ domain: string; state: "pending" | "verified"; method: string | null; verifiedAt: string | null }>();
  const memberRows: MemberRow[] = [
    ...members.map((member) => ({ name: member.name || member.email, role: roleWord(member.role) })),
    ...invitations.map((invited) => ({ name: invited.email, role: "Invited" })),
  ];
  const month = (iso: string) => {
    const at = new Date(Date.parse(iso) + 2 * 3_600_000);
    return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
  };
  const weekBars: WeekBar[] = weeks.map((week) => ({
    label: month(week.weekStart),
    total: week.checked,
    bad: week.malicious + week.suspicious,
  }));
  const threatRows = await db
    .prepare(
      `SELECT o.check_name AS check_name, COUNT(*) AS n FROM check_outcomes o
       JOIN cases c ON c.id = o.case_id JOIN case_verdicts v ON v.case_id = c.id
       WHERE c.org_id = ? AND c.created_at >= ? AND v.verdict IN ('suspicious', 'malicious')
         AND o.outcome IN ('ran', 'partial') AND o.findings > 0
       GROUP BY o.check_name ORDER BY n DESC, o.check_name LIMIT 4`,
    )
    .bind(org.id, new Date(now.getTime() - 30 * 86_400_000).toISOString())
    .all<{ check_name: string; n: number }>();
  const top = Math.max(1, ...threatRows.results.map((row) => row.n));
  const todayStart = sastDayStart(now);
  const todayCount =
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM cases WHERE org_id = ? AND created_at >= ?")
        .bind(org.id, todayStart)
        .first<{ n: number }>()
    )?.n ?? 0;
  const feedback = await orgFeedbackItems(db, org.id, 5, c.env.REPORT_LINK_SECRET, now);
  const feedbackRows: OrgFeedbackRow[] = feedback.map((row) => ({
    caseTitle: row.caseTitle,
    caseHref: row.caseHref,
    verdict: row.verdict,
    theySay: row.theySay,
    status: row.status,
  }));
  const planLines = [
    state === null
      ? "Plan unknown"
      : state.plan === "trial"
        ? `Trial, ends ${sastLong(state.trialEndsAt)}`
        : state.plan === "free"
          ? "Free"
          : state.plan === "protect"
            ? "Protect"
            : "MSP",
    effectiveCap === null ? `Today ${todayCount} cases` : `Today ${todayCount} of ${effectiveCap} cases`,
    steps.protectedIdentity ? "Protected identity: set up" : "Protected identity: not set up",
  ];
  return html(
    OrgDetailPage({
      shell: { feedbackOpen: (await triageCounts(db)).new, operator: c.get("accessEmail") },
      orgId: org.id,
      header: { name: org.name, planPill: planText, meta },
      extendTrial: {
        enabled: state?.plan === "trial" || state?.plan === "free",
        reason:
          state?.plan === "trial" || state?.plan === "free"
            ? null
            : state === null
              ? "The plan could not be read."
              : "A paid plan has no trial to extend.",
        min: "",
        value: override?.trialValue ?? "",
        notice: override?.trialNotice ?? null,
        error: override?.trialError ?? null,
      },
      plan: {
        current: state?.plan ?? null,
        error: override?.planError ?? null,
        notice: override?.planNotice ?? null,
      },
      cap: {
        value: override?.capValue ?? (cap === null ? "" : String(cap)),
        error: override?.capError ?? null,
        notice: override?.capNotice ?? null,
      },
      onboarding: {
        done: [
          steps.domain !== null,
          steps.members >= 2,
          steps.emailed,
          steps.suppliers >= 1,
          steps.protectedIdentity,
        ].filter(Boolean).length,
        steps: [
          {
            title: "Verify your domain",
            done: steps.domain !== null,
            detail: steps.domain === null ? "No verified domain." : `${steps.domain} is verified.`,
          },
          {
            title: "Invite your team",
            done: steps.members >= 2,
            detail: `${steps.members} ${steps.members === 1 ? "person" : "people"} joined.`,
          },
          {
            title: "Forward your first email",
            done: steps.emailed,
            detail: steps.reported
              ? "A forwarded email's report is ready."
              : steps.emailed
                ? "An email arrived and is being checked."
                : "No forwarded email yet.",
          },
          {
            title: "Add suppliers",
            done: steps.suppliers >= 1,
            detail: `${steps.suppliers} ${steps.suppliers === 1 ? "supplier" : "suppliers"} added.`,
          },
          {
            title: "Protect your business",
            done: steps.protectedIdentity,
            detail: steps.protectedIdentity ? "Protected identity is set up." : "Protected identity is not set up.",
          },
        ],
      },
      domains: domainRows.results.map((row) => ({
        domain: row.domain,
        state: row.state === "verified" ? ("Verified" as const) : ("Pending" as const),
        detail:
          row.state === "verified"
            ? row.method === "dns"
              ? `TXT record, verified ${sastShort(row.verifiedAt ?? "")}`
              : `Verified ${sastShort(row.verifiedAt ?? "")}`
            : row.method === "email"
              ? "Verification code sent, not used yet."
              : "TXT record not seen yet.",
      })),
      members: memberRows,
      weeks: weekBars,
      threats: threatRows.results.map((row) => ({
        name: CHECK_WORDS[row.check_name] ?? row.check_name,
        count: row.n,
        top,
      })),
      feedback: feedbackRows,
      feedbackHref: "/admin/feedback",
      planLines,
    }),
  );
}

adminOrgRoutes.get("/admin/orgs/:id", async (c) => {
  try {
    return drawOrg(c, c.env.DB, new Date(), c.req.param("id"));
  } catch (error) {
    return outage((error as Error).name);
  }
});

adminOrgRoutes.post("/admin/orgs/:id/trial", async (c) => {
  try {
    if (!sameOrigin(c)) return forbidden();
    const db = c.env.DB;
    const now = new Date();
    const orgId = c.req.param("id");
    const form = await readSmallForm(c.req.raw, { until: 10 });
    if (!form) return outage("form-too-large");
    const raw = (form.until ?? "").trim();
    const render = (error: string | null, notice: string | null) =>
      drawOrg(c, db, now, orgId, { trialError: error, trialNotice: notice, trialValue: raw });
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    // A real calendar day only: JavaScript normalises `2027-02-30` into March, so the parsed day must read back
    // as the day written (the same round trip `parseExtension` demands).
    const probe = parts ? new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))) : null;
    if (
      !parts ||
      !probe ||
      probe.getUTCFullYear() !== Number(parts[1]) ||
      probe.getUTCMonth() !== Number(parts[2]) - 1 ||
      probe.getUTCDate() !== Number(parts[3])
    )
      return render("A trial extends to a real YYYY-MM-DD day.", null);
    const until = new Date(`${raw}T23:59:59+02:00`);
    const state = await planOf(db, orgId, now).catch(() => null);
    // The helper's contract (D07 T02 §8): an extension puts an organisation on trial, including one whose trial
    // lapsed and now reads free; only a paid plan is refused, by the SQL itself and by this guard alike.
    if (state === null || state.plan === "protect" || state.plan === "msp")
      return render("A paid plan has no trial to extend.", null);
    // `extendTrial` refuses a day that is not still to come by throwing, and changes nothing for a paid plan or a
    // shorter extension: both are field refusals, while anything else is a write failure with the day kept.
    let extended: boolean;
    try {
      extended = await extendTrial(db, orgId, until, now);
    } catch (error) {
      if (error instanceof RangeError)
        return render("That day does not extend the trial: pick a day still to come.", null);
      return render("We could not extend the trial just now. Try again.", null);
    }
    if (!extended) return render("That day does not extend the trial: pick a day still to come.", null);
    return new Response(null, { status: 303, headers: { ...HEADERS, location: `/admin/orgs/${orgId}` } });
  } catch (error) {
    return outage((error as Error).name);
  }
});

adminOrgRoutes.post("/admin/orgs/:id/plan", async (c) => {
  try {
    if (!sameOrigin(c)) return forbidden();
    const db = c.env.DB;
    const now = new Date();
    const orgId = c.req.param("id");
    const form = await readSmallForm(c.req.raw, { plan: 12 });
    if (!form) return outage("form-too-large");
    const org = await db.prepare('SELECT id FROM "organization" WHERE id = ?').bind(orgId).first<{ id: string }>();
    if (!org) return c.notFound();
    const plan = (form.plan ?? "").trim();
    if (!(STORED_PLANS as readonly string[]).includes(plan))
      return drawOrg(c, db, now, orgId, { planError: "Pick the plan to move this organisation to." });
    let moved: boolean;
    try {
      moved = await setPlan(db, orgId, plan as (typeof STORED_PLANS)[number]);
    } catch {
      return drawOrg(c, db, now, orgId, { planError: "We could not change the plan just now. Try again." });
    }
    if (!moved) return c.notFound();
    return new Response(null, { status: 303, headers: { ...HEADERS, location: `/admin/orgs/${orgId}` } });
  } catch (error) {
    return outage((error as Error).name);
  }
});

adminOrgRoutes.post("/admin/orgs/:id/cap", async (c) => {
  try {
    if (!sameOrigin(c)) return forbidden();
    const db = c.env.DB;
    const now = new Date();
    const orgId = c.req.param("id");
    const form = await readSmallForm(c.req.raw, { action: 8, cap: 12 });
    if (!form) return outage("form-too-large");
    if (form.action !== "set" && form.action !== "clear") return errorPage(404, "", {});
    const org = await db.prepare('SELECT id FROM "organization" WHERE id = ?').bind(orgId).first<{ id: string }>();
    if (!org) return c.notFound();
    const back = `/admin/orgs/${orgId}`;
    if (form.action === "clear") {
      const statement = clearDailyCapOverrideStatement(org.id);
      try {
        await db
          .prepare(statement.sql)
          .bind(...statement.params)
          .run();
      } catch {
        return drawOrg(c, db, now, orgId, {
          capValue: (form.cap ?? "").trim(),
          capError: "We could not change the daily cap just now. Try again.",
        });
      }
      return new Response(null, { status: 303, headers: { ...HEADERS, location: back } });
    }
    const rawCap = (form.cap ?? "").trim();
    const cases = Number(rawCap);
    // A blank field is not a zero: it refuses with the typed value kept and the stored cap untouched, like §2.
    if (!rawCap || !Number.isInteger(cases) || cases < 0 || cases > 50) {
      return drawOrg(c, db, now, orgId, { capValue: rawCap, capError: "a daily cap is a whole number from 0 to 50" });
    }
    const statement = setDailyCapOverrideStatement(org.id, cases);
    try {
      await db
        .prepare(statement.sql)
        .bind(...statement.params)
        .run();
    } catch {
      return drawOrg(c, db, now, orgId, {
        capValue: rawCap,
        capError: "We could not change the daily cap just now. Try again.",
      });
    }
    return new Response(null, { status: 303, headers: { ...HEADERS, location: back } });
  } catch (error) {
    return outage((error as Error).name);
  }
});
