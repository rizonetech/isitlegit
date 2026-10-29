import { Hono } from "hono";
import { createAuth } from "./auth/auth";
import { confirmRoutes } from "./auth/confirm";
import { domainRoutes } from "./auth/domains";
import { switchOrganisation } from "./auth/org";
import { signOut } from "./auth/sign-out";
import { handleEmail, sweepIntake } from "./intake/email";
import { uploadRoutes } from "./intake/upload";
import { BOUNDS, reconcileUncertain } from "./mail/reconcile";
import { markUnsettled } from "./meta/budget";
import { sendPendingCapNotices } from "./meta/notice";
import { smoke } from "./smoke";

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
app.route("/api/upload", uploadRoutes);

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
    // The operator's alert for each Meta cap event a refusal recorded, the Worker's or a local script's (D03 T01 §2).
    ctx.waitUntil(sendPendingCapNotices(env).catch(() => 0));
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
