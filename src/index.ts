import { Hono } from "hono";
import { sweepAuthTables } from "./auth/audit";
import { createAuth } from "./auth/auth";
import { confirmRoutes } from "./auth/confirm";
import { domainRoutes } from "./auth/domains";
import { invitationRoutes } from "./auth/invitation";
import { switchOrganisation } from "./auth/org";
import { signOut } from "./auth/sign-out";
import { teamHistoryRoutes } from "./auth/team-history";
import { handleEmail, sweepIntake } from "./intake/email";
import { uploadRoutes } from "./intake/upload";
import { checkForwarding, type ForwardingOutcome } from "./mail/forwarding";
import { BOUNDS, reconcileUncertain } from "./mail/reconcile";
import { resendRequested } from "./mail/resend";
import { markUnsettled } from "./meta/budget";
import { sendPendingCapNotices } from "./meta/notice";
import { smoke } from "./smoke";
import { GalleryFrame, GalleryPage } from "./web/dev/gallery";
import { artefactRoutes } from "./web/pages/artefacts";
import { casesRoutes } from "./web/pages/cases";
import { domainPageRoutes } from "./web/pages/domains";
import { reportRoutes } from "./web/pages/report";

export { AnalysisWorkflow } from "./pipeline/analysis-workflow";

const app = new Hono<{ Bindings: Env }>();

// The deployed commit proves which build is live; deploys set COMMIT_SHA with `wrangler deploy --var`.
app.get("/health", (c) => c.json({ ok: true, commit: c.env.COMMIT_SHA }));
// Every binding exercised on the deployed Worker; 404 without the run's token (D00 T01 §5, scripts/smoke.ts).
app.get("/internal/smoke", (c) => smoke(c.env, c.req.raw, c.executionCtx));
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
// The Cases list, a member's home (D07 T04 §1), src/web/pages/cases.tsx.
app.route("/", casesRoutes);
// The domain verification page (D07 T02 §15), src/web/pages/domains.tsx.
app.route("/", domainPageRoutes);
// The invitation page (D07 T02 §14), src/auth/invitation.tsx.
app.route("/", invitationRoutes);
// The component gallery and its frames (D07 T01 §10, src/web/dev/gallery.tsx), only under `pnpm dev`: ENV is
// "production" in wrangler.jsonc, so every deploy answers them 404.
app.get("/dev/components", (c) => (c.env.ENV === "development" ? c.html(GalleryPage()) : c.notFound()));
app.get("/dev/components/frame/:id", (c) => {
  const frame = c.env.ENV === "development" ? GalleryFrame(c.req.param("id")) : null;
  return frame ? c.html(frame) : c.notFound();
});

// The Worker: HTTP through the app; forwards to check@ through Email Routing (D01 T01 §3, src/intake/email.ts); and the
// cron trigger in wrangler.jsonc (every 15 minutes) settling uncertain mail sends from SMTP2GO's record (D01 T02 §5)
// and sweeping the intake claims.
export default {
  fetch: app.fetch,
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleEmail(message, env);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(scheduledReconcile(env));
    ctx.waitUntil(scheduledIntakeSweep(env));
    // Forwarded mail a destination refused, and member mail the Worker could not take (D01 T02 §6).
    ctx.waitUntil(scheduledForwarding(env));
    // The operator's alert for each Meta cap event a refusal recorded, the Worker's or a local script's (D03 T01 §2).
    ctx.waitUntil(sendPendingCapNotices(env).catch(() => 0));
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
