import { Hono } from "hono";
import { BOUNDS, reconcileUncertain } from "./mail/reconcile";
import { smoke } from "./smoke";

export { AnalysisWorkflow } from "./pipeline/analysis-workflow";

const app = new Hono<{ Bindings: Env }>();

// The deployed commit proves which build is live; deploys set COMMIT_SHA with `wrangler deploy --var`.
app.get("/health", (c) => c.json({ ok: true, commit: c.env.COMMIT_SHA }));
// Every binding exercised on the deployed Worker; 404 without the run's token (D00 T01 §5, scripts/smoke.ts).
app.get("/internal/smoke", (c) => smoke(c.env, c.req.raw, c.executionCtx));

// The Worker: HTTP through the app, and the cron trigger in wrangler.jsonc (every 15 minutes) settling uncertain mail
// sends from SMTP2GO's record (D01 T02 §5).
export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(scheduledReconcile(env));
  },
} satisfies ExportedHandler<Env>;

export async function scheduledReconcile(env: Env) {
  if (!env.SMTP2GO_API_KEY) return null;
  return reconcileUncertain(
    { db: env.DB, apiKey: env.SMTP2GO_API_KEY, operator: env.OPERATOR_EMAIL },
    { olderThanMinutes: BOUNDS.olderThanMinutes, youngerThanDays: BOUNDS.youngerThanDays },
  );
}
