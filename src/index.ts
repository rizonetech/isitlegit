import { Hono } from "hono";
import { smoke } from "./smoke";

export { AnalysisWorkflow } from "./pipeline/analysis-workflow";

const app = new Hono<{ Bindings: Env }>();

// The deployed commit proves which build is live; deploys set COMMIT_SHA with `wrangler deploy --var`.
app.get("/health", (c) => c.json({ ok: true, commit: c.env.COMMIT_SHA }));
// Every binding exercised on the deployed Worker; 404 without the run's token (D00 T01 §5, scripts/smoke.ts).
app.get("/internal/smoke", (c) => smoke(c.env, c.req.raw, c.executionCtx));

export default app;
