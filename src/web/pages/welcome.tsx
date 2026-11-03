// The onboarding checklist's routes (D07 T08 §2; design/SPEC.md A4): `GET /welcome` computes the five steps from the
// organisation's stored state (a verified domain, a team, an emailed case, a supplier, a protected identity), each scoped
// to the active organisation, and draws them (./welcome-view.tsx); `POST /welcome` hides or shows the list for this
// browser. Hiding is a preference kept in a first-party cookie (`welcome_hidden`, the organisation ids hidden), never a
// record: nothing about a member or an organisation is stored for it, and the cookie decides only whether /cases offers
// the link.
import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { readSmallForm } from "../../auth/form";
import type { GateEnv } from "../../auth/gate";
import { sessionGate } from "../../auth/gate";
import { activeMembership } from "../../auth/org";
import { hasFeature, planOf } from "../../auth/plans";
import { getIdentity } from "../../trust/identity";
import { errorPage, HEADERS, reference } from "./errors";
import { memberShell } from "./member-shell";
import { COOKIE, hiddenIn, MAX_HIDDEN, stepsOf } from "./welcome-steps";
import { type Protection, WelcomePage, type WelcomePlan } from "./welcome-view";

export const welcomeRoutes = new Hono<GateEnv>();

const PATH = "/welcome";

// The judges' organisation: its metadata names it (`"judge": true`, set by the demo's seed). A classification for showing
// a banner and never proof of anything: an unreadable or foreign value is simply not the judges' organisation.
export function isJudge(metadata: string | null | undefined): boolean {
  if (!metadata) return false;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    return typeof parsed === "object" && parsed !== null && (parsed as { judge?: unknown }).judge === true;
  } catch {
    return false;
  }
}

const planWords = (plan: Awaited<ReturnType<typeof planOf>>): WelcomePlan | null => {
  if (!plan) return null;
  if (plan.plan === "trial") return { plan: "trial", daysLeft: plan.daysLeft, endsAt: plan.trialEndsAt };
  if (plan.plan === "free") return { plan: "free", trialEnded: plan.trialEndedAt !== null };
  return { plan: plan.plan };
};

function outage(why: string) {
  const ref = reference(500);
  console.log(JSON.stringify({ event: "welcome", outcome: "unavailable", reference: ref, error: why }));
  return errorPage(500, "", { ref, retry: PATH });
}

const protectionOf = (identity: Awaited<ReturnType<typeof getIdentity>>): Protection =>
  identity?.effective.on === true
    ? { on: true }
    : {
        on: false,
        reason: identity && !identity.effective.on ? identity.effective.reason : "protection is switched off",
      };
const firstNameOf = (user: { name: string; email: string }) =>
  (user.name || user.email.split("@")[0] || "").trim().split(/\s+/)[0] || "there";
const isSetupRole = (role: string) => role.split(",").some((r) => r.trim() === "owner" || r.trim() === "admin");

welcomeRoutes.get(
  PATH,
  sessionGate(() => outage("session")),
  async (c) => {
    const signedIn = c.get("signedIn");
    const membership = await activeMembership(c.env, signedIn);
    if (!membership.ok)
      return membership.reason === "unavailable"
        ? outage("membership")
        : errorPage(403, "", { email: signedIn.user.email, closed: membership.reason === "closed" });
    const orgId = membership.org.id;
    try {
      const now = new Date();
      const [shell, steps, plan, bankChange, identityIncluded, identity, org] = await Promise.all([
        memberShell(c.env.DB, signedIn.user, orgId, "cases"),
        stepsOf(c.env.DB, orgId),
        planOf(c.env.DB, orgId, now),
        hasFeature(c.env.DB, orgId, "bank-change", now),
        hasFeature(c.env.DB, orgId, "identity", now),
        getIdentity(c.env.DB, orgId),
        c.env.DB.prepare(`SELECT metadata FROM "organization" WHERE id = ?`)
          .bind(orgId)
          .first<{ metadata: string | null }>(),
      ]);
      const words = planWords(plan);
      if (!words || !org) return outage("organisation");
      return new Response(
        String(
          <WelcomePage
            shell={shell}
            firstName={firstNameOf(signedIn.user)}
            steps={steps}
            plan={words}
            now={now}
            protection={protectionOf(identity)}
            access={{ bankChange, identity: identityIncluded }}
            canSetup={isSetupRole(membership.org.role)}
            judge={isJudge(org.metadata)}
            hidden={hiddenIn(getCookie(c, COOKIE)).includes(orgId)}
          />,
        ),
        { headers: HEADERS },
      );
    } catch (error) {
      return outage((error as Error).name);
    }
  },
);

// Hide or show this organisation's list in this browser. Only the app's own pages post here.
welcomeRoutes.post(
  PATH,
  sessionGate(() => outage("session")),
  async (c: Context<GateEnv>) => {
    // Only the app's own pages post here: another origin gets the 403 page and nothing changes.
    if (c.req.header("origin") !== new URL(c.env.APP_URL).origin)
      return errorPage(403, "", { email: c.get("signedIn").user.email });
    const membership = await activeMembership(c.env, c.get("signedIn"));
    if (!membership.ok)
      return membership.reason === "unavailable"
        ? outage("membership")
        : errorPage(403, "", { email: c.get("signedIn").user.email, closed: membership.reason === "closed" });
    // The body is bounded before it is read; a request that is too large, or not one this page sends, changes nothing and
    // leaves the member on the list.
    const form = await readSmallForm(c.req.raw, { action: 10, org: 100 });
    const action = form?.action;
    const stay = new Headers(HEADERS);
    stay.set("location", PATH);
    if (action !== "hide" && action !== "show") return new Response(null, { status: 303, headers: stay });
    // The list the page was drawn for must be the organisation now active (another tab may have switched it): otherwise
    // nothing changes and the member lands on the active organisation's list.
    if (form?.org !== membership.org.id) return new Response(null, { status: 303, headers: stay });
    const orgId = membership.org.id;
    const others = hiddenIn(getCookie(c, COOKIE)).filter((id) => id !== orgId);
    const next = action === "hide" ? [...others, orgId].slice(-MAX_HIDDEN) : others;
    const flags = "Path=/; Secure; HttpOnly; SameSite=Lax";
    const cookie =
      next.length > 0
        ? `${COOKIE}=${next.join(",")}; ${flags}; Max-Age=${365 * 24 * 60 * 60}`
        : `${COOKIE}=; ${flags}; Max-Age=0`;
    const headers = new Headers(HEADERS);
    headers.set("location", action === "hide" ? "/cases" : PATH);
    headers.append("set-cookie", cookie);
    return new Response(null, { status: 303, headers });
  },
);
