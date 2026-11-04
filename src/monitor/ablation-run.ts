// Experimental execution consumes only approved immutable captures. It never enters daily discovery or publishes findings.
import { d1Budget } from "../meta/budget";
import { TAIL_MINUTES } from "../vision/glimmer-caps";
import { d1Exec, settleBurst } from "../vision/glimmer-minutes";
import { closeGlimmer, type GlimmerSession, openGlimmer, screenPage } from "../vision/screen";
import { PendingAttempt } from "./ablation-attempts";
import { loupeExperiment } from "./ablation-loupe";
import { loadCapture, loadManifest, preflightCaptures } from "./ablation-manifest";
import { readExperimentReport } from "./ablation-readback";
import { reconciledPageAttempt, reconciledSecondLook } from "./ablation-reconcile";
import { PageCheckpoint, readPageCheckpoint, savePageCheckpoint } from "./ablation-results";
import { MonitorIdentityConflict, readExperiment, requestNonces } from "./ablation-store";
import { structuredContinuation } from "./ablation-structured";
import { wakeExperiment } from "./ablation-wake";
import { parkedPage } from "./parked";
import { secondLook } from "./second-look";

export async function runExperiment(
  env: Env,
  orgId: string,
  monitorRunId: string,
  transports: { loupe?: typeof fetch; spark?: typeof fetch } = {},
) {
  const run = await readExperiment(env.DB, orgId, monitorRunId);
  if (!run) throw new MonitorIdentityConflict();
  if (run.status === "complete" || run.status === "failed") return readExperimentReport(env.DB, orgId, monitorRunId);
  if (!env.EVAL_ORG_ID || env.EVAL_ORG_ID !== orgId || env.COMMIT_SHA !== run.deployment)
    throw new MonitorIdentityConflict();
  const manifest = await loadManifest(env.ARTEFACTS, run.manifestDigest, run.deployment);
  await preflightCaptures(env.ARTEFACTS, manifest);
  if (Date.now() >= run.sparkDeadline) {
    await env.DB.prepare(
      "UPDATE monitor_experiment_arms SET status='failed' WHERE org_id=? AND monitor_run_id=? AND status IN ('pending','waiting')",
    )
      .bind(orgId, monitorRunId)
      .run();
    throw new PendingAttempt("expired");
  }
  const claim = await env.DB.prepare(
    "UPDATE monitor_experiment_arms SET status='running' WHERE org_id=? AND monitor_run_id=? AND status IN ('pending','waiting')",
  )
    .bind(orgId, monitorRunId)
    .run();
  if (claim.meta.changes !== 1) throw new PendingAttempt("running");
  const pending: Promise<unknown>[] = [];
  const keep = (p: Promise<unknown>) => {
    pending.push(p);
  };
  let session: GlimmerSession | null = null;
  const binding = { db: env.DB, monitorRunId, deployment: run.deployment };
  const current = () =>
    env.EVAL_ORG_ID === orgId && env.COMMIT_SHA === run.deployment && Date.now() < run.sparkDeadline;
  const spark = (operationId: string, phase: "screen" | "second-look") => ({
    env,
    budget: d1Budget(env.DB, { caller: "monitor", waitUntil: keep }),
    waitUntil: keep,
    ...(transports.spark ? { fetch: transports.spark } : {}),
    expired: () => !current(),
    continuation: structuredContinuation({ ...binding, operationId, phase, deadline: run.sparkDeadline }),
  });
  try {
    for (const identity of run.pages) {
      let checkpoint = await readPageCheckpoint(env.DB, orgId, monitorRunId, identity.pageOperationId);
      if (checkpoint?.finishedAt !== null && checkpoint !== null) continue;
      if (!current()) throw new PendingAttempt("expired");
      const source = manifest.pages.find((page) => page.experimentCaseId === identity.experimentCaseId);
      if (
        !source ||
        source.pageId !== identity.pageId ||
        source.captureDigest !== identity.captureDigest ||
        source.labelDigest !== identity.labelDigest
      )
        throw new MonitorIdentityConflict();
      const capture = await loadCapture(env.ARTEFACTS, source);
      const nonces = await requestNonces(env.DB, orgId, monitorRunId, identity.pageOperationId);
      if (checkpoint === null) {
        const startedAt = Date.now();
        const unrecoverable = (await reconciledPageAttempt(env.DB, monitorRunId, identity.pageOperationId, "screen"))
          ? "screen"
          : (await reconciledPageAttempt(env.DB, monitorRunId, identity.pageOperationId, "loupe"))
            ? "loupe"
            : null;
        if (unrecoverable) {
          // Ledger reconciliation establishes charges, not a lost answer. Preserve that distinction and continue other pages.
          await savePageCheckpoint(env.DB, orgId, monitorRunId, identity.pageOperationId, {
            version: 1,
            startedAt,
            screenedAt: startedAt,
            parked: null,
            screen: null,
            secondLook: null,
            finishedAt: startedAt,
            unrecoverable,
          });
          continue;
        }
        const parked = parkedPage(capture.signals.text, capture.signals, capture.page.image?.length ?? 0);
        if (parked.parked) {
          checkpoint = {
            version: 1,
            startedAt,
            screenedAt: Date.now(),
            parked: { reason: parked.reason },
            screen: null,
            secondLook: null,
            finishedAt: Date.now(),
          };
          await savePageCheckpoint(env.DB, orgId, monitorRunId, identity.pageOperationId, checkpoint);
          continue;
        }
        if (session === null) {
          if (!current()) throw new PendingAttempt("expired");
          const ctx = {
            env,
            ledger: d1Exec(env.DB),
            burstId: monitorRunId,
            calls: manifest.pages.length,
            callSeconds: 20,
            ...(transports.loupe ? { fetcher: transports.loupe } : {}),
            ...(run.arm === "no-screening"
              ? { ablateFlag: async () => "no-screening" as const }
              : { experiment: wakeExperiment(binding) }),
          };
          session = await openGlimmer(ctx, run.arm === "full" ? loupeExperiment(binding) : undefined);
        }
        const screen = await screenPage(
          { ...capture.page, nonce: nonces.screen },
          session,
          spark(identity.pageOperationId, "screen"),
          identity.pageOperationId,
        );
        const screenedAt = Date.now();
        const needsSecond = screen.ok && screen.screen.screener === "glimmer" && screen.screen.lure;
        checkpoint = {
          version: 1,
          startedAt,
          screenedAt,
          parked: null,
          screen,
          secondLook: null,
          finishedAt: needsSecond ? null : screenedAt,
        };
        // This write precedes second look. On a lost write the durable transport journal still prevents another send.
        await savePageCheckpoint(env.DB, orgId, monitorRunId, identity.pageOperationId, checkpoint);
      }
      if (checkpoint.finishedAt === null) {
        if (!current()) throw new PendingAttempt("expired");
        const second = (await reconciledSecondLook(env.DB, monitorRunId, identity.pageOperationId))
          ? { verdict: "unavailable" as const, reason: "experiment-unrecoverable" }
          : await secondLook(
              { ...capture.page, nonce: nonces.second },
              identity.pageOperationId,
              spark(identity.pageOperationId, "second-look"),
            );
        checkpoint = PageCheckpoint.parse({ ...checkpoint, secondLook: second, finishedAt: Date.now() });
        await savePageCheckpoint(env.DB, orgId, monitorRunId, identity.pageOperationId, checkpoint);
      }
    }
    await Promise.all(pending);
    if (session) {
      const closed = await closeGlimmer(session);
      if (closed?.ok === false) throw new PendingAttempt("unknown");
    }
    // A restart after the screen checkpoint can skip opening a session. Recover its known burst settlement without another probe.
    const held = await env.DB.prepare(
      "SELECT min(wake_at) AS wakeAt,sum(reserved_minutes) AS minutes,sum(CASE WHEN settled_at IS NULL THEN 1 ELSE 0 END) AS held FROM glimmer_runtime WHERE reservation_id=?",
    )
      .bind(monitorRunId)
      .first<{ wakeAt: string | null; minutes: number | null; held: number | null }>();
    if (held?.wakeAt && held.minutes !== null && held.held) {
      if (!(await loupeExperiment(binding).settlementAllowed())) throw new PendingAttempt("unknown");
      // As in closeGlimmer's resumed-session path, the full original reservation window is the conservative upper bound.
      const until = Math.min(Date.now(), Date.parse(held.wakeAt) + (held.minutes - TAIL_MINUTES) * 60000);
      const settled = await settleBurst(d1Exec(env.DB), monitorRunId, { lastDeadlineAt: new Date(until) });
      if (!settled.ok) throw new PendingAttempt("unknown");
    }
    await env.DB.prepare(
      "UPDATE monitor_experiment_arms SET status=CASE WHEN EXISTS(SELECT 1 FROM monitor_experiment_results r WHERE r.monitor_run_id=monitor_experiment_arms.monitor_run_id AND r.status!='complete') THEN 'failed' ELSE 'complete' END WHERE org_id=? AND monitor_run_id=? AND status='running'",
    )
      .bind(orgId, monitorRunId)
      .run();
    return await readExperimentReport(env.DB, orgId, monitorRunId);
  } catch (error) {
    await Promise.allSettled(pending);
    const state = error instanceof PendingAttempt ? error.state : "unknown";
    const status =
      state === "capacity"
        ? "waiting"
        : state === "unknown" || state === "running" || state === "conflict"
          ? "unknown"
          : "failed";
    // No close on capacity/unknown: a resumed burst keeps its original window and uncertain charges remain reserved.
    await env.DB.prepare(
      "UPDATE monitor_experiment_arms SET status=? WHERE org_id=? AND monitor_run_id=? AND status='running'",
    )
      .bind(status, orgId, monitorRunId)
      .run();
    throw error;
  }
}
