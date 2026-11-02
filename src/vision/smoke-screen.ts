// The deployed Worker's own screening probe for the release step (D03 T04 §36): screens one built-in fixture page
// through the Worker's `screenPage` session, with the Worker's bindings, secrets and minutes ledger, so a release
// proves production screening rather than a local call beside it. Only the token-protected smoke route runs it, and
// only when a release asks (`?screen=1`), so no other deploy pays Loupe or Spark spend.
import { d1Budget } from "../meta/budget.ts";
import { DEPLOYED_VERSION } from "./glimmer-caps.ts";
import { d1Exec } from "./glimmer-minutes.ts";
import { closeGlimmer, openGlimmer, screenPage } from "./screen.ts";

export async function screenSmokePage(env: Env, runId: string): Promise<{ screener: string; version: string }> {
  const pending: Promise<unknown>[] = [];
  const keep = (p: Promise<unknown>) => void pending.push(p);
  const session = await openGlimmer({
    env,
    ledger: d1Exec(env.DB),
    burstId: `smoke-${runId}`,
    calls: 1,
    callSeconds: 20,
  });
  try {
    const result = await screenPage(
      {
        text: "Welcome. Sign in with your email and password to continue to your account.",
        host: "smoke.example",
        mode: "text-only",
      },
      session,
      { env, budget: d1Budget(env.DB, { caller: "smoke", waitUntil: keep }), waitUntil: keep },
      `smoke-${runId}`,
    );
    if (!result.ok) throw new Error(`screening failed: ${result.glimmer_reason}/${result.spark_reason}`);
    return { screener: result.screen.screener, version: DEPLOYED_VERSION };
  } finally {
    await closeGlimmer(session);
    await Promise.allSettled(pending);
  }
}
