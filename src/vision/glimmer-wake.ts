// Waking Loupe's dedicated deployment (D03 T04 §15). Scaled to zero, the deployment answers the first request at once
// with `503 DEPLOYMENT_SCALING_UP`, queues nothing, and scales up (https://docs.fireworks.ai/deployments/autoscaling).
// The monitor wakes it as a run starts, so the warm-up runs while the run's DNS work does, and waits for it only when
// the first page needs it.
//
// Every request comes after a reservation in the runtime ledger (§14): the wake reserves the whole retry window (the
// measured maximum warm-up, its margin, the run's calls and the tail) under an id from the monitor run, so a Workflow
// step that runs again finds the same burst and its deadline instead of starting a new wait. Past the deadline the
// answer is `warming` at once, and Muse Spark takes the page (§1).

import type { MailDeps, SendOutcome } from "../mail/smtp2go.ts";
import { sendMail } from "../mail/smtp2go.ts";
import { sastDay } from "../meta/day.ts";
import type { AblateFlag } from "../pipeline/ablate.ts";
import {
  DEPLOYED_MODEL,
  DEPLOYED_VERSION,
  DEPLOYMENT,
  MAX_WARMUP_SECONDS,
  recoveryCommand,
  WARMUP_MARGIN_SECONDS,
} from "./glimmer-caps.ts";
import { burstMinutes, type Exec, findBurst, reserveBurst, settleBurst } from "./glimmer-minutes.ts";
import { completionsUrl, fireworksHeaders, type GatewayEnv, isCompletion, oneTokenRequest } from "./glimmer-request.ts";

export { completionsUrl, fireworksHeaders, isCompletion, oneTokenRequest };

// Each request's own deadline once warm, and the backoff between cold-start answers: 5 seconds doubling, capped at 30.
export const REQUEST_MS = 10_000;
export const FIRST_BACKOFF_MS = 5_000;
export const MAX_BACKOFF_MS = 30_000;
export const WARMUP_LIMIT_MS = (MAX_WARMUP_SECONDS + WARMUP_MARGIN_SECONDS) * 1000;

export type WakeEnv = GatewayEnv & {
  SMTP2GO_API_KEY?: string;
  OPERATOR_EMAIL?: string;
};

export type WakeCtx = {
  env: WakeEnv;
  ledger: Exec;
  // The burst's id: the monitor run's, so a re-entered step finds its own burst.
  burstId: string;
  // The pages the run expects to screen and the seconds each is allowed, for the reservation.
  calls: number;
  callSeconds: number;
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  // The mail the missing-deployment notice goes through (`sendMail`, D1-backed send keys); absent, no notice is sent.
  mail?: MailDeps;
  // Keeps the notice's delivery alive after the answer is returned (a Workflow step's or a request's waitUntil), so
  // the page goes to Spark at once and never waits for the mail.
  waitUntil?: (promise: Promise<unknown>) => void;
  // Eval ablation flag reader (D03 T02 §6): when it returns `"no-screening"`, Loupe is never woken or asked.
  ablateFlag?: () => Promise<AblateFlag | null>;
  experiment?: {
    assertOwner(): Promise<void>;
    probe(burst: Burst, body: string, send: (attemptId: string) => Promise<Answer>): Promise<Answer>;
  };
};

export type Burst = { id: string; wakeAt: number; deadline: number };

// An outcome that settled its own burst (`settled`) carries the burst and the cutoff it was settled to (`settleUntil`), so a
// caller whose settlement failed (the burst stays counted at its reserve) can settle it again, however late, with
// `settleGlimmer(ctx, burst, settleUntil)`: charged to the same moment, never to the time spent waiting to retry.
export type Outcome =
  | { outcome: "ready"; attempts: number }
  | { outcome: "warming"; attempts: number; settled?: boolean; burst?: Burst; settleUntil?: number }
  | { outcome: "refused"; detail: string }
  | {
      outcome: "deployment_missing";
      notice: "queued" | "not_configured";
      settled?: boolean;
      burst?: Burst;
      settleUntil?: number;
    }
  | { outcome: "burst_closed"; detail: string }
  | { outcome: "unauthorized"; status: number; settled?: boolean; burst?: Burst; settleUntil?: number }
  | { outcome: "bad_answer"; status: number; settled?: boolean; burst?: Burst; settleUntil?: number }
  | { outcome: "not_configured"; missing: string[] };

export type Woken =
  | { outcome: "woken"; burst: Burst; reused: boolean; first: Outcome | null }
  | Exclude<Outcome, { outcome: "ready" | "warming" }>;

const clock = (ctx: WakeCtx) => ctx.now ?? (() => Date.now());
const pause = (ctx: WakeCtx) => ctx.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

export function missingConfig(env: WakeEnv): string[] {
  return (["FIREWORKS_API_KEY", "GLIMMER_GATEWAY_URL", "CF_AIG_TOKEN"] as const).filter((name) => !env[name]);
}

export type Answer =
  | { kind: "ready" }
  | { kind: "retry"; why: string; capacity?: boolean; status?: number; retryAfterMs?: number }
  | { kind: "final"; outcome: Extract<Outcome, { outcome: "deployment_missing" | "unauthorized" | "bad_answer" }> };

// One request, cut at `ms`. What it answered decides whether to wait and ask again.
async function ask(ctx: WakeCtx, ms: number, burst: Burst): Promise<Answer> {
  if (ctx.experiment)
    return ctx.experiment.probe(burst, String(oneTokenRequest(ctx.env).init.body), (attemptId) =>
      askOnce(ctx, ms, attemptId),
    );
  return askOnce(ctx, ms);
}

function retryDelay(value: string | null, now: number): number | undefined {
  if (!value || value.length > 128) return undefined;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
  if (seconds !== null) return Math.min(Number.MAX_SAFE_INTEGER, seconds * 1000);
  if (
    !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      value,
    )
  )
    return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, time - now) : undefined;
}

async function probeBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.length;
      if (total > 65536) {
        await reader.cancel();
        throw new Error("probe response limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

async function askOnce(ctx: WakeCtx, ms: number, attemptId?: string): Promise<Answer> {
  const { url, init } = oneTokenRequest(ctx.env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("deadline")), ms);
  try {
    const response = await (ctx.fetcher ?? fetch)(url, {
      ...init,
      ...(attemptId
        ? {
            headers: fireworksHeaders(ctx.env, {
              caller: "glimmer-wake",
              monitor_run: ctx.burstId,
              attempt: attemptId,
            }),
          }
        : {}),
      signal: controller.signal,
    });
    const body = ctx.experiment ? await probeBody(response) : await response.text();
    if (response.status === 200)
      return isCompletion(body)
        ? { kind: "ready" }
        : { kind: "final", outcome: { outcome: "bad_answer", status: 200 } };
    if (response.status === 404)
      return {
        kind: "final",
        outcome: { outcome: "deployment_missing", notice: ctx.experiment ? "not_configured" : queueNotice(ctx) },
      };
    if (response.status === 401 || response.status === 403)
      return { kind: "final", outcome: { outcome: "unauthorized", status: response.status } };
    // A cold start (503 DEPLOYMENT_SCALING_UP), a rate limit, any other 5xx: wait and ask again within the deadline.
    if (response.status === 429 || response.status >= 500) {
      let scaling = false;
      try {
        scaling = response.status === 503 && JSON.parse(body)?.error?.code === "DEPLOYMENT_SCALING_UP";
      } catch {
        /* No evidence of a known cold-start refusal. */
      }
      const retryAfterMs = retryDelay(response.headers.get("retry-after"), clock(ctx)());
      return {
        kind: "retry",
        why: `HTTP ${response.status}`,
        status: response.status,
        capacity: response.status === 429 || scaling,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    }
    return { kind: "final", outcome: { outcome: "bad_answer", status: response.status } };
  } catch (error) {
    // A network error or the request's own deadline: the deployment may still be scaling up, so it is asked again.
    return {
      kind: "retry",
      why: ctx.experiment ? "unknown outcome" : error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

// The notice is sent alongside the answer, never before it: `deployment_missing` returns at once and Spark takes the
// page; the delivery runs on under `waitUntil` (or on its own when the caller gave none).
function queueNotice(ctx: WakeCtx): "queued" | "not_configured" {
  if (!ctx.mail || !ctx.env.OPERATOR_EMAIL) return "not_configured";
  const delivery = missingNotice(ctx).then((outcome) => {
    if (outcome && outcome.status !== "sent" && outcome.status !== "duplicate")
      console.error(JSON.stringify({ event: "glimmer", outcome: "missing-notice-not-sent", status: outcome.status }));
  });
  ctx.waitUntil?.(delivery);
  return "queued";
}

// The operator's notice for a deployment Fireworks has deleted: one per deployment per SAST day, whatever the number
// of calls or Worker instances (the send key is kept in D1 by `sendMail`); a failed send is claimed by the next miss.
export async function missingNotice(ctx: WakeCtx): Promise<SendOutcome | null> {
  const operator = ctx.env.OPERATOR_EMAIL;
  if (!ctx.mail || !operator) return null;
  try {
    return await sendMail(ctx.mail, {
      sendKey: `glimmer-deployment-missing:${DEPLOYMENT}:${sastDay(new Date(clock(ctx)()))}`,
      kind: "alert",
      to: operator,
      from: "IsItLegit <alerts@isitlegit.co.za>",
      subject: `IsItLegit: Loupe's deployment ${DEPLOYMENT} is missing`,
      text: [
        `Fireworks answered 404 for ${DEPLOYED_MODEL}: the deployment is gone (Fireworks deletes deployments idle for 7 days).`,
        "",
        "Muse Spark screens the monitor's pages until it is back. To recreate it, from the repository:",
        "",
        `  ${recoveryCommand(DEPLOYED_VERSION)}`,
      ].join("\n"),
    });
  } catch (error) {
    // The page still goes to Spark; the notice's failure is reported in its place, and the next miss tries again.
    return { status: "failed", reason: error instanceof Error ? error.message : String(error), attempts: 0 };
  }
}

// Reserves the burst and sends one 1-token request, without waiting for the warm-up. A burst already reserved under
// this id (a re-entered step) is returned with its first deadline and no new request.
export async function wakeGlimmer(ctx: WakeCtx): Promise<Woken> {
  const missing = missingConfig(ctx.env);
  if (missing.length) return { outcome: "not_configured", missing };
  const now = clock(ctx);
  await ctx.experiment?.assertOwner();
  let existing: Awaited<ReturnType<typeof findBurst>>;
  try {
    existing = await findBurst(ctx.ledger, ctx.burstId);
  } catch (error) {
    // A ledger that cannot be read refuses (fail closed): nothing is sent.
    return {
      outcome: "refused",
      detail: `the runtime ledger could not be read (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  // A burst already settled is closed: its run is done with the deployment, and a step that runs again sends nothing
  // (settled minutes are final, so a request now would go uncounted). Spark takes any page it still has.
  if (existing?.settled) return { outcome: "burst_closed", detail: `the burst ${ctx.burstId} is settled` };
  if (existing) {
    const wakeAt = Date.parse(existing.wakeAt);
    if (ctx.experiment) return finishWake(ctx, { id: ctx.burstId, wakeAt, deadline: wakeAt + WARMUP_LIMIT_MS }, true);
    return {
      outcome: "woken",
      burst: { id: ctx.burstId, wakeAt, deadline: wakeAt + WARMUP_LIMIT_MS },
      reused: true,
      first: null,
    };
  }
  const at = now();
  const reserved = await reserveBurst(ctx.ledger, {
    id: ctx.burstId,
    at: new Date(at),
    source: "worker",
    caller: "monitor",
    purpose: "monitor",
    minutes: burstMinutes(ctx.calls, ctx.callSeconds),
    deployment: DEPLOYMENT,
  });
  if (!reserved.ok) return { outcome: "refused", detail: reserved.detail };
  const wakeAt = Date.parse(reserved.wakeAt);
  const burst = { id: ctx.burstId, wakeAt, deadline: wakeAt + WARMUP_LIMIT_MS };
  return finishWake(ctx, burst, reserved.repeated);
}

async function finishWake(ctx: WakeCtx, burst: Burst, reused: boolean): Promise<Woken> {
  const answer = await ask(
    ctx,
    ctx.experiment ? Math.max(1, Math.min(REQUEST_MS, burst.deadline - clock(ctx)())) : REQUEST_MS,
    burst,
  );
  if (answer.kind === "final") {
    // The answer ends the run's use of Loupe: the burst is settled, and whether that landed is part of the answer.
    const settleUntil = clock(ctx)();
    const settled = await settleGlimmer(ctx, burst, settleUntil);
    return { ...answer.outcome, settled: settled.ok, burst, settleUntil };
  }
  return {
    outcome: "woken",
    burst,
    reused,
    first: answer.kind === "ready" ? { outcome: "ready", attempts: 1 } : null,
  };
}

// Waits for the deployment to answer, until the burst's deadline. Each request is cut at its own deadline and never
// past the burst's; past the deadline the answer is `warming` at once, with no request.
export async function untilWarm(ctx: WakeCtx, burst: Burst): Promise<Outcome> {
  await ctx.experiment?.assertOwner();
  const now = clock(ctx);
  const sleep = pause(ctx);
  // A burst already settled (a replayed step after a final answer) is closed: nothing more is sent under it.
  try {
    if ((await findBurst(ctx.ledger, burst.id))?.settled)
      return { outcome: "burst_closed", detail: `the burst ${burst.id} is settled` };
  } catch (error) {
    return {
      outcome: "refused",
      detail: `the runtime ledger could not be read (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  // Even after expiry, the journal must refuse an unknown paid probe before anything settles its reservation.
  if (ctx.experiment && now() >= burst.deadline) await ask(ctx, 1, burst);
  let attempts = 0;
  let backoff = FIRST_BACKOFF_MS;
  while (now() < burst.deadline) {
    attempts += 1;
    const answer = await ask(ctx, Math.min(REQUEST_MS, burst.deadline - now()), burst);
    if (answer.kind === "ready") return { outcome: "ready", attempts };
    if (answer.kind === "final") {
      const settleUntil = Math.min(now(), burst.deadline);
      const settled = await settleGlimmer(ctx, burst, settleUntil);
      return { ...answer.outcome, settled: settled.ok, burst, settleUntil };
    }
    if (ctx.experiment) break; // Durable capacity waits are scheduled by the owning Workflow, never slept here.
    const left = burst.deadline - now();
    if (left <= 0) break;
    await sleep(Math.min(backoff, left));
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
  // Past the deadline the run is done with the deployment (every later page goes to Spark), so the burst is settled.
  const settleUntil = Math.min(now(), burst.deadline);
  const settled = await settleGlimmer(ctx, burst, settleUntil);
  return { outcome: "warming", attempts, settled: settled.ok, burst, settleUntil };
}

// Settles the burst once its run is done with the deployment: to now, which no request of the run can be after, plus
// the tail. `untilWarm` settles on every answer that ends the run's use of Loupe (a final failure, or warming past the
// deadline); after a `ready`, the screener (§1) settles when the run's last page is screened. The result is returned,
// so a burst that cannot be settled (it stays counted at its reserve) is reported, never dropped.
// `until` is the latest a request of the burst can have run (the warm-up deadline for `untilWarm`, which sends nothing
// after it; the run's last request for the screener): a step resumed long after its last request is charged to that,
// never to the hours it was idle, which Fireworks spent at 0 replicas.
export async function settleGlimmer(ctx: WakeCtx, burst: Burst, until = Number.POSITIVE_INFINITY) {
  return settleBurst(ctx.ledger, burst.id, { lastDeadlineAt: new Date(Math.min(clock(ctx)(), until)) });
}
