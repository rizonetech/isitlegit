import { Hono } from "hono";
import { createAuth } from "./auth/auth";
import { switchOrganisation } from "./auth/org";
import { signOut } from "./auth/sign-out";
import { BOUNDS, reconcileUncertain } from "./mail/reconcile";
import { smoke } from "./smoke";

export { AnalysisWorkflow } from "./pipeline/analysis-workflow";

const app = new Hono<{ Bindings: Env }>();

// The deployed commit proves which build is live; deploys set COMMIT_SHA with `wrangler deploy --var`.
app.get("/health", (c) => c.json({ ok: true, commit: c.env.COMMIT_SHA }));
// Every binding exercised on the deployed Worker; 404 without the run's token (D00 T01 §5, scripts/smoke.ts).
app.get("/internal/smoke", (c) => smoke(c.env, c.req.raw, c.executionCtx));
// Better Auth's endpoints: magic links, sessions, its health check (D07 T02 §1, src/auth/auth.ts).
app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));
// The app shell's Sign out form (D07 T01 §3), src/auth/sign-out.ts.
app.post("/auth/sign-out", (c) => signOut(c.env, c.req.raw));
// The app shell's organisation switcher (D07 T01 §3), src/auth/org.ts.
app.post("/orgs/switch", (c) => switchOrganisation(c.env, c.req.raw));

// The Worker: HTTP through the app, and the cron trigger in wrangler.jsonc (every 15 minutes) settling uncertain mail
// sends from SMTP2GO's record (D01 T02 §5).
export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(scheduledReconcile(env));
  },
} satisfies ExportedHandler<Env>;

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
