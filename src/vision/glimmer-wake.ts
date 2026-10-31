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
import {
  DEPLOYED_MODEL,
  DEPLOYED_VERSION,
  DEPLOYMENT,
  MAX_WARMUP_SECONDS,
  recoveryCommand,
  WARMUP_MARGIN_SECONDS,
} from "./glimmer-caps.ts";
import { burstMinutes, type Exec, findBurst, reserveBurst, settleBurst } from "./glimmer-minutes.ts";

// Each request's own deadline once warm, and the backoff between cold-start answers: 5 seconds doubling, capped at 30.
export const REQUEST_MS = 10_000;
export const FIRST_BACKOFF_MS = 5_000;
export const MAX_BACKOFF_MS = 30_000;
export const WARMUP_LIMIT_MS = (MAX_WARMUP_SECONDS + WARMUP_MARGIN_SECONDS) * 1000;

export type WakeEnv = {
  FIREWORKS_API_KEY?: string;
  // The AI Gateway's `custom-fireworks` route, ending in `/v1` (e.g. .../isitlegit/custom-fireworks/v1).
  GLIMMER_GATEWAY_URL?: string;
  CF_AIG_TOKEN?: string;
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
};

export type Burst = { id: string; wakeAt: number; deadline: number };

export type Outcome =
  | { outcome: "ready"; attempts: number }
  | { outcome: "warming"; attempts: number }
  | { outcome: "refused"; detail: string }
  | { outcome: "deployment_missing"; notice: SendOutcome | null }
  | { outcome: "unauthorized"; status: number }
  | { outcome: "bad_answer"; status: number }
  | { outcome: "not_configured"; missing: string[] };

export type Woken =
  | { outcome: "woken"; burst: Burst; reused: boolean; first: Outcome | null }
  | Exclude<Outcome, { outcome: "ready" | "warming" }>;

const clock = (ctx: WakeCtx) => ctx.now ?? (() => Date.now());
const pause = (ctx: WakeCtx) => ctx.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

function missingConfig(env: WakeEnv): string[] {
  return (["FIREWORKS_API_KEY", "GLIMMER_GATEWAY_URL", "CF_AIG_TOKEN"] as const).filter((name) => !env[name]);
}

// The request as every call sends it: through the gateway, logging metadata only, never the payload (as
// `metaResponses` does), with the deployment's key.
export function oneTokenRequest(env: WakeEnv): { url: string; init: RequestInit } {
  return {
    url: `${env.GLIMMER_GATEWAY_URL}/chat/completions`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.FIREWORKS_API_KEY}`,
        "Content-Type": "application/json",
        "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
        "cf-aig-collect-log": "true",
        "cf-aig-collect-log-payload": "false",
        "cf-aig-metadata": JSON.stringify({ caller: "glimmer-wake" }),
      },
      body: JSON.stringify({
        model: DEPLOYED_MODEL,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0,
      }),
    },
  };
}

// A completion is a 200 whose body holds `choices[0].message`; anything else is no answer.
export function isCompletion(body: string): boolean {
  try {
    const data = JSON.parse(body) as { choices?: { message?: unknown }[] };
    return (
      Array.isArray(data.choices) && typeof data.choices[0]?.message === "object" && data.choices[0]?.message !== null
    );
  } catch {
    // Not JSON: not a completion. This is the answer, not a lost error.
    return false;
  }
}

type Answer =
  | { kind: "ready" }
  | { kind: "retry"; why: string }
  | { kind: "final"; outcome: Exclude<Outcome, { outcome: "ready" | "warming" | "refused" | "not_configured" }> };

// One request, cut at `ms`. What it answered decides whether to wait and ask again.
async function ask(ctx: WakeCtx, ms: number): Promise<Answer> {
  const { url, init } = oneTokenRequest(ctx.env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("deadline")), ms);
  try {
    const response = await (ctx.fetcher ?? fetch)(url, { ...init, signal: controller.signal });
    const body = await response.text();
    if (response.status === 200)
      return isCompletion(body)
        ? { kind: "ready" }
        : { kind: "final", outcome: { outcome: "bad_answer", status: 200 } };
    if (response.status === 404)
      return { kind: "final", outcome: { outcome: "deployment_missing", notice: await missingNotice(ctx) } };
    if (response.status === 401 || response.status === 403)
      return { kind: "final", outcome: { outcome: "unauthorized", status: response.status } };
    // A cold start (503 DEPLOYMENT_SCALING_UP), a rate limit, any other 5xx: wait and ask again within the deadline.
    if (response.status === 429 || response.status >= 500) return { kind: "retry", why: `HTTP ${response.status}` };
    return { kind: "final", outcome: { outcome: "bad_answer", status: response.status } };
  } catch (error) {
    // A network error or the request's own deadline: the deployment may still be scaling up, so it is asked again.
    return { kind: "retry", why: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
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
  if (existing && !existing.settled) {
    const wakeAt = Date.parse(existing.wakeAt);
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
  });
  if (!reserved.ok) return { outcome: "refused", detail: reserved.detail };
  const wakeAt = Date.parse(reserved.wakeAt);
  const burst = { id: ctx.burstId, wakeAt, deadline: wakeAt + WARMUP_LIMIT_MS };
  const answer = await ask(ctx, REQUEST_MS);
  if (answer.kind === "final") {
    await settleGlimmer(ctx, burst);
    return answer.outcome;
  }
  return {
    outcome: "woken",
    burst,
    reused: reserved.repeated,
    first: answer.kind === "ready" ? { outcome: "ready", attempts: 1 } : null,
  };
}

// Waits for the deployment to answer, until the burst's deadline. Each request is cut at its own deadline and never
// past the burst's; past the deadline the answer is `warming` at once, with no request.
export async function untilWarm(ctx: WakeCtx, burst: Burst): Promise<Outcome> {
  const now = clock(ctx);
  const sleep = pause(ctx);
  let attempts = 0;
  let backoff = FIRST_BACKOFF_MS;
  while (now() < burst.deadline) {
    attempts += 1;
    const answer = await ask(ctx, Math.min(REQUEST_MS, burst.deadline - now()));
    if (answer.kind === "ready") return { outcome: "ready", attempts };
    if (answer.kind === "final") {
      await settleGlimmer(ctx, burst);
      return answer.outcome;
    }
    const left = burst.deadline - now();
    if (left <= 0) break;
    await sleep(Math.min(backoff, left));
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
  return { outcome: "warming", attempts };
}

// Settles the burst once its run is done with the deployment: to now, which no request of the run can be after, plus
// the tail. A burst that cannot be settled stays counted at its reserve.
export async function settleGlimmer(ctx: WakeCtx, burst: Burst) {
  return settleBurst(ctx.ledger, burst.id, { lastDeadlineAt: new Date(clock(ctx)()) }, new Date(clock(ctx)()));
}
