import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

// The deployed commit proves which build is live; deploys set COMMIT_SHA with `wrangler deploy --var`.
app.get("/health", (c) => c.json({ ok: true, commit: c.env.COMMIT_SHA }));

export default app;
