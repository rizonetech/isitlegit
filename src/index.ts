import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAccess } from "./auth/access";
import { sweepAuthTables } from "./auth/audit";
import { createAuth } from "./auth/auth";
import { scheduledClosurePurge } from "./auth/closure";
import { confirmRoutes } from "./auth/confirm";
import { domainRoutes } from "./auth/domains";
import { invitationRoutes } from "./auth/invitation";
import { switchOrganisation } from "./auth/org";
import { sameSitePath } from "./auth/paths";
import { signOut } from "./auth/sign-out";
import { teamHistoryRoutes } from "./auth/team-history";
import { scheduledSearchRefresh } from "./db/case-search";
import { fixturesResponse } from "./fixtures/redirects";
import { handleEmail, sweepIntake } from "./intake/email";
import { uploadRoutes } from "./intake/upload";
import { checkForwarding, type ForwardingOutcome } from "./mail/forwarding";
import { BOUNDS, reconcileUncertain } from "./mail/reconcile";
import { resendRequested } from "./mail/resend";
import { sendTrialNotices } from "./mail/trial-notices";
import { markUnsettled } from "./meta/budget";
import { sendPendingCapNotices } from "./meta/notice";
import { scheduledMonitor } from "./monitor/workflow";
import { sweepRetries } from "./pipeline/retry";
import { FORWARD_CRON, MAIN_CRON, MONITOR_CRON, RETRY_CRON } from "./schedules";
import { smoke } from "./smoke";
import { backfillPublicSlugs } from "./trust/public-slug";
import { screenSmokePage } from "./vision/smoke-screen.ts";
import { AXE_SOURCE } from "./web/dev/axe-source";
import { GalleryFrame, GalleryPage, GalleryState } from "./web/dev/gallery";
import { addressPageRoutes } from "./web/pages/addresses";
import { adminRoutes } from "./web/pages/admin";
import { adminFeedbackRoutes } from "./web/pages/admin-feedback";
import { adminOrgRoutes } from "./web/pages/admin-org";
import { artefactRoutes } from "./web/pages/artefacts";
import { badgeRoutes } from "./web/pages/badge";
import { casesRoutes } from "./web/pages/cases";
import { domainPageRoutes } from "./web/pages/domains";
import { domainsListRoutes } from "./web/pages/domains-list";
import { errorPage, maintenanceFrom, maintenancePage, reference } from "./web/pages/errors";
import { evalRoutes } from "./web/pages/eval";
import { feedbackRoutes, sendPendingFeedbackNotices } from "./web/pages/feedback";
import { identityRoutes } from "./web/pages/identity";
import { reportRoutes } from "./web/pages/report";
import { retryRoutes } from "./web/pages/report-retry";
import { accountRoutes } from "./web/pages/settings-account";
import { planRoutes } from "./web/pages/settings-plan";
import { supplierRoutes } from "./web/pages/suppliers";
import { teamRoutes } from "./web/pages/team";
import { uploadPageRoutes } from "./web/pages/upload";
import { verifyRoutes } from "./web/pages/verify";
import { welcomeRoutes } from "./web/pages/welcome";

export { MonitorWorkflow } from "./monitor/workflow";
export { AnalysisWorkflow } from "./pipeline/analysis-workflow";

const app = new Hono<{ Bindings: Env }>();

// Planned downtime (D07 T08 §1, src/web/pages/errors.tsx): while `MAINTENANCE` in wrangler.jsonc `vars` is set, every
// request but the static files answers the maintenance page; Email Routing is the `email` handler below, which mail
// keeps using (held by the routing, never refused). Empty or unset leaves the app as it is.
app.use("*", async (c, next) => {
  const maintenance = maintenanceFrom(c.env.MAINTENANCE);
  // The signature badge (D05 T02 §7) is an image already in other people's mail, so it keeps answering as one: its handler
  // reads the identity as always and falls to the Not verified badge only if that read fails, never a maintenance page.
  if (!maintenance.on || c.req.path.startsWith("/static/") || c.req.path.startsWith("/b/")) return next();
  // Reload returns to the same address with its query: a signed report link or a search is not lost to it.
  return bodyFor(c.req.raw, maintenancePage({ ...maintenance, reload: ownAddress(c.req.url) }));
});

// The admin console's second lock (D07 T05 §1, src/auth/access.ts): every /admin request, on any hostname and
// before any handler that could answer it (the fixtures dispatcher included), first proves its Cloudflare Access
// JWT; the admin pages themselves are D07 T05 §2, mounted behind this guard.
app.use("/admin", requireAccess);
app.use("/admin/*", requireAccess);

// The www host (D07 T06 §20): a permanent redirect to the apex, path and query kept. The custom domain in
// wrangler.jsonc makes its DNS record and certificate; the wrangler login has no zone rulesets scope, so the
// redirect is answered here instead of by a zone Redirect Rule.
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname === "www.isitlegit.co.za")
    return c.redirect(`https://isitlegit.co.za${url.pathname}${url.search}`, 301);
  return next();
});

// The redirect fixtures on their own host (D02 T07 §2): answered here, before the app, and only on that host.
app.use(
  "*",
  async (c, next) =>
    (await fixturesResponse(c.req.raw, c.env.FIXTURES_PREFIX, { db: c.env.DB, kv: c.env.CACHE })) ?? next(),
);

// The deployed commit proves which build is live; deploys set COMMIT_SHA with `wrangler deploy --var`.
app.get("/health", (c) => c.json({ ok: true, commit: c.env.COMMIT_SHA }));
// Every binding exercised on the deployed Worker; 404 without the run's token (D00 T01 §5, scripts/smoke.ts).
app.get("/internal/smoke", (c) =>
  smoke(c.env, c.req.raw, c.executionCtx, 30_000, (runId) => screenSmokePage(c.env, runId)),
);
// The sign-in link's confirm page, and the old verify URL sent to it (D07 T02 §10, src/auth/confirm.tsx): before
// Better Auth's routes, so a GET of its verify URL never signs in.
app.route("/", confirmRoutes);
// Better Auth's endpoints: magic links, sessions, its health check (D07 T02 §1, src/auth/auth.ts).
app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));
// The app shell's Sign out form (D07 T01 §3), src/auth/sign-out.ts.
app.post("/auth/sign-out", (c) => signOut(c.env, c.req.raw));
// The app shell's organisation switcher (D07 T01 §3), src/auth/org.ts.
app.post("/orgs/switch", (c) => switchOrganisation(c.env, c.req.raw));
// Domain and sending-address verification for owners and admins (D07 T02 §5), src/auth/domains.ts.
app.route("/api/org", domainRoutes);
app.route("/api/team", teamHistoryRoutes);
app.route("/api/upload", uploadRoutes);
// The report, to a member of the case's organisation or a signed link (D07 T03 §1), src/web/pages/report.tsx.
app.route("/", reportRoutes);
app.route("/", artefactRoutes);
app.route("/", feedbackRoutes);
app.route("/", retryRoutes);
// The Cases list, a member's home (D07 T04 §1), src/web/pages/cases.tsx.
app.route("/", casesRoutes);
// The Team page, its members, roles and removals (D07 T04 §3), src/web/pages/team.tsx.
app.route("/", teamRoutes);
// The Domains and addresses page, its lists, adding and removing (D07 T04 §4), src/web/pages/domains-list.tsx.
app.route("/", domainsListRoutes);
// The Plan page, the plan and the day's usage (D07 T08 §4), src/web/pages/settings-plan.tsx.
app.route("/", planRoutes);
// The Account page, the member's own sign-in details (D07 T08 §3), src/web/pages/settings-account.tsx.
app.route("/", accountRoutes);
// The onboarding checklist (D07 T08 §2), src/web/pages/welcome.tsx.
app.route("/", welcomeRoutes);
// The single-address verification page (D07 T04 §27), src/web/pages/addresses.tsx.
app.route("/", addressPageRoutes);
app.route("/", uploadPageRoutes);
// The domain verification page (D07 T02 §15), src/web/pages/domains.tsx.
app.route("/", domainPageRoutes);
// The protected identity page (D05 T01 §3), src/web/pages/identity.tsx.
app.route("/", identityRoutes);
app.route("/", supplierRoutes);
app.route("/", verifyRoutes);
app.route("/", badgeRoutes);
// The results page, the latest published eval run and real-use counts (D08 T02 §4), src/web/pages/eval.tsx.
app.route("/", evalRoutes);
// The invitation page (D07 T02 §14), src/auth/invitation.tsx.
app.route("/", invitationRoutes);
// The admin console (D07 T05 §2), src/web/pages/admin.tsx: behind `requireAccess` above.
app.route("/", adminRoutes);
// The feedback queue (D07 T08 §5), src/web/pages/admin-feedback.tsx: behind `requireAccess` above.
app.route("/", adminFeedbackRoutes);
// The organisation detail (D07 T08 §5), src/web/pages/admin-org.tsx: behind `requireAccess` above.
app.route("/", adminOrgRoutes);
// The component gallery and its frames (D07 T01 §10, src/web/dev/gallery.tsx), only under `pnpm dev`: ENV is
// "production" in wrangler.jsonc, so every deploy answers them 404.
app.get("/dev/components", (c) => (c.env.ENV === "development" ? c.html(GalleryPage()) : c.notFound()));
app.get("/dev/components/frame/:id", (c) => {
  const frame = c.env.ENV === "development" ? GalleryFrame(c.req.param("id")) : null;
  return frame ? c.html(frame) : c.notFound();
});
app.get("/dev/components/state/:slug", (c) => {
  const state = c.env.ENV === "development" ? GalleryState(c.req.param("slug")) : null;
  return state ? c.html(state) : c.notFound();
});
// axe-core for the gallery's on-demand checks (§15), only in development: every deploy answers it 404.
app.get("/dev/axe.min.js", (c) =>
  c.env.ENV === "development"
    ? c.body(AXE_SOURCE, 200, { "Content-Type": "text/javascript; charset=utf-8" })
    : c.notFound(),
);

// An unmatched path is the 404 page, which says nothing of whether the page exists or is someone else's (E1); an
// uncaught throw is the 500 page with a reference, the error's class and that reference logged as JSON and nothing of its
// message shown or logged (E5). A HEAD or a request that does not accept HTML gets the same status and no body.
app.notFound((c) => bodyFor(c.req.raw, errorPage(404, "")));
app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  const ref = reference(500);
  console.error(JSON.stringify({ event: "unhandled-error", reference: ref, error: error.name }));
  // Try again repeats a page that only reads; a failed submission is never sent twice, so it goes to the Cases list.
  const retry = c.req.method === "GET" ? ownAddress(c.req.url) : "/cases";
  return bodyFor(c.req.raw, errorPage(500, "", { ref, retry }));
});

// The address asked for, as a link back to it: a path on this site, or the front page for one that is not (a `//host/`
// path would otherwise open another site from our own page).
function ownAddress(requested: string): string {
  const url = new URL(requested);
  const own = `${url.pathname}${url.search}`;
  return sameSitePath(own) ? own : "/";
}

// The page's status and headers; its body only for a request that can show it.
function bodyFor(request: Request, response: Response): Response {
  const accept = request.headers.get("accept");
  const html = !accept || accept.includes("text/html") || accept.includes("*/*");
  if (request.method !== "HEAD" && html) return response;
  return new Response(null, { status: response.status, headers: response.headers });
}

// The Worker: HTTP through the app; forwards to check@ through Email Routing (D01 T01 §3, src/intake/email.ts); and the
// cron trigger in wrangler.jsonc (every 15 minutes) settling uncertain mail sends from SMTP2GO's record (D01 T02 §5)
// and sweeping the intake claims.
export default {
  fetch: app.fetch,
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleEmail(message, env);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Each schedule its own work (D01 T01 §17): the minute tick settles retries and stranded deliveries, so a stuck retry is back with the
    // member within a minute of its safety threshold; the five-minute tick between quarter-hours checks forwarding only;
    // the quarter-hour tick runs everything, retries and forwarding included; any other schedule runs nothing and says so.
    if (controller.cron === RETRY_CRON) {
      ctx.waitUntil(scheduledRetrySweep(env));
      // Each minute too, so a delivery stopped before its Workflow started is taken up within a minute of its lease
      // running out, not up to a quarter-hour after (D01 T03 §12's completion review). A sweep is one indexed query
      // when nothing is stranded.
      ctx.waitUntil(scheduledIntakeSweep(env));
      return;
    }
    // Between the quarter-hours, the forwarding check alone (D01 T02 §12).
    if (controller.cron === FORWARD_CRON) {
      ctx.waitUntil(scheduledForwarding(env));
      return;
    }
    // The impersonation monitor's daily dispatch (D05 T04 §2).
    if (controller.cron === MONITOR_CRON) {
      ctx.waitUntil(scheduledMonitor(env));
      return;
    }
    if (controller.cron !== MAIN_CRON) {
      console.error(
        JSON.stringify({ event: "scheduled", outcome: "unknown-cron", cron: controller.cron.slice(0, 40) }),
      );
      return;
    }
    ctx.waitUntil(scheduledReconcile(env));
    // The verify page's address for identities protected before it existed (D05 T02 §6), by the same rule as a save.
    ctx.waitUntil(
      backfillPublicSlugs(env.DB).catch((error: unknown) =>
        console.log(JSON.stringify({ event: "public-slug", outcome: "backfill-failed", error: (error as Error).name })),
      ),
    );
    ctx.waitUntil(scheduledIntakeSweep(env));
    ctx.waitUntil(scheduledRetrySweep(env));
    // Forwarded mail a destination refused, and member mail the Worker could not take (D01 T02 §6).
    ctx.waitUntil(scheduledForwarding(env));
    // The operator's alert for each Meta cap event a refusal recorded, the Worker's or a local script's (D03 T01 §2).
    ctx.waitUntil(sendPendingCapNotices(env).catch(() => 0));
    // The owners' trial-end notices (D07 T08 §11): three days before and after the Protect trial ends, once each.
    ctx.waitUntil(sendTrialNotices(env).catch(() => null));
    // The Cases list's search text for cases stored before it was kept (D07 T04 §7), 200 a pass.
    ctx.waitUntil(scheduledSearchRefresh(env));
    // The closed organisations' purge (D07 T02 §9): their artefacts and rows, 25 days after closure.
    ctx.waitUntil(
      scheduledClosurePurge(env, new Date(controller.scheduledTime)).then((report) =>
        console.log(JSON.stringify({ event: "scheduled", outcome: "closure-purge", ...report })),
      ),
    );
    // The operator's notice for each "this verdict is wrong" still waiting (D07 T03 §6, N9).
    ctx.waitUntil(sendPendingFeedbackNotices(env).catch(() => 0));
    // Replies the operator settled failed and asked to send again (D01 T02 §8).
    ctx.waitUntil(
      resendRequested(env).then(
        (report) => {
          if (report.done || report.retried || report.exhausted || report.errors.length)
            console.log(JSON.stringify({ event: "mail-resend", ...report }));
        },
        (error: unknown) =>
          console.error(JSON.stringify({ event: "mail-resend", outcome: "run-failed", error: (error as Error).name })),
      ),
    );
    // Expired rate-limit buckets and audit rows past their 12 months (D07 T02 §6).
    ctx.waitUntil(
      sweepAuthTables(env.DB).catch((error: unknown) => {
        console.error(JSON.stringify({ event: "auth-audit", outcome: "sweep-failed", error: (error as Error).name }));
      }),
    );
    // A model call whose settlement was never written, marked so its record shows (D03 T01 §3).
    ctx.waitUntil(
      markUnsettled(env.DB).catch((error: unknown) => {
        // Said, so an abandoned reservation is never mistaken for one in flight (completion review, C5).
        console.error(JSON.stringify({ event: "budget", outcome: "sweep-failed", error: (error as Error).name }));
        return 0;
      }),
    );
  },
} satisfies ExportedHandler<Env>;

// The forwarding check's outcome as one log line (counts and error classes only): `disabled` when the analytics token
// or the zone is not set, never silent (D01 T02 §6).
export async function scheduledForwarding(
  env: Env,
  log: (line: string) => void = console.log,
  fetcher: typeof fetch = fetch,
): Promise<ForwardingOutcome> {
  let outcome: ForwardingOutcome;
  try {
    outcome = await checkForwarding({
      db: env.DB,
      token: env.CF_ANALYTICS_TOKEN,
      zone: env.EMAIL_ZONE_ID,
      mail: { db: env.DB, apiKey: env.SMTP2GO_API_KEY },
      operators: [env.OPERATOR_EMAIL, env.OPERATOR_FALLBACK_EMAIL].filter((o): o is string => !!o),
      fetch: fetcher,
    });
  } catch (error) {
    outcome = { state: "degraded", events: 0, incidents: 0, folded: 0, alerted: 0, errors: [(error as Error).name] };
  }
  log(JSON.stringify({ event: "forwarding", ...outcome }));
  return outcome;
}

// The intake sweep's outcome as one log line (counts only: no address, key or Message-ID).
export async function scheduledIntakeSweep(env: Env, log: (line: string) => void = console.log) {
  try {
    log(JSON.stringify({ event: "intake-sweep", state: "ok", ...(await sweepIntake(env)) }));
  } catch (error) {
    log(JSON.stringify({ event: "intake-sweep", state: "degraded", error: (error as Error).name }));
  }
}

// Retries whose start was never confirmed, settled on the same schedule (D01 T01 §17); counts only.
export async function scheduledRetrySweep(env: Env, log: (line: string) => void = console.log) {
  try {
    log(JSON.stringify({ event: "retry-sweep", state: "ok", ...(await sweepRetries(env.DB, env)) }));
  } catch (error) {
    log(JSON.stringify({ event: "retry-sweep", state: "degraded", error: (error as Error).name }));
  }
}

// One run's outcome, logged as one line for Workers Logs (no key, address or body): `disabled` when the SMTP2GO key is
// not set, `degraded` when a search failed or a send could not be handed over, `ok` otherwise, with the counts.
export type ScheduledOutcome = {
  state: "disabled" | "ok" | "degraded";
  settled: number;
  unresolved: number;
  handedOver: number;
  errors: string[];
  requests: number;
};

export async function scheduledReconcile(
  env: Env,
  log: (line: string) => void = console.log,
): Promise<ScheduledOutcome> {
  let outcome: ScheduledOutcome;
  if (!env.SMTP2GO_API_KEY)
    outcome = {
      state: "disabled",
      settled: 0,
      unresolved: 0,
      handedOver: 0,
      errors: ["SMTP2GO_API_KEY is not set"],
      requests: 0,
    };
  else {
    try {
      const report = await reconcileUncertain(
        { db: env.DB, apiKey: env.SMTP2GO_API_KEY, operator: env.OPERATOR_EMAIL },
        { olderThanMinutes: BOUNDS.olderThanMinutes, youngerThanDays: BOUNDS.youngerThanDays },
      );
      outcome = {
        state: report.state,
        settled: report.settled.length,
        unresolved: report.unresolved.length,
        handedOver: report.handedOver.length,
        errors: report.errors,
        requests: report.requests,
      };
    } catch (error) {
      outcome = {
        state: "degraded",
        settled: 0,
        unresolved: 0,
        handedOver: 0,
        errors: [`the run stopped: ${(error as Error).name}`],
        requests: 0,
      };
    }
  }
  log(JSON.stringify({ event: "mail-reconcile", ...outcome }));
  return outcome;
}
