// The monitor's page screener (D03 T04 §1): Loupe, the fine-tuned Glimmer on its dedicated deployment, first; Muse
// Spark on the Meta Model API when Loupe cannot answer. One page in, one `PageScreen` out (or a typed failure), with
// which screener answered, why Loupe did not, and the Spark call's ids, for the monitor's screening to store
// (D05 T04 §3).
//
// A run opens a Loupe session (`openGlimmer`: §15's wake, the burst reserved in §14's ledger), screens its pages, and
// closes it (`closeGlimmer`: the burst settled). Loupe is asked only inside the burst's reserved window; past it, or
// while it is warming past its limit, missing, refusing or failing, the page goes to Spark.

import { ModelError } from "../meta/client.ts";
import { BudgetExceeded, BudgetUnavailable } from "../meta/guard.ts";
import { ModelOutputError, type StructuredContext, structured } from "../meta/structured.ts";
import { TAIL_MINUTES } from "./glimmer-caps.ts";
import { glimmerBody, readAnswer, sparkRequest } from "./screen-request.ts";

export { glimmerBody, MAX_ANSWER_TOKENS, readAnswer, SPARK_MODEL, sparkRequest } from "./screen-request.ts";

import { burstMinutes } from "./glimmer-minutes.ts";
import {
  type Burst,
  completionsUrl,
  fireworksHeaders,
  probeBody,
  REQUEST_MS,
  retryDelay,
  settleGlimmer,
  untilWarm,
  type WakeCtx,
  wakeGlimmer,
} from "./glimmer-wake.ts";
import {
  buildScreenRequest,
  inEscalationBand,
  PageAnswer,
  type PageScreen,
  type ScreenMode,
  type ScreenRequest,
  screened,
} from "./page-screen.ts";

export { ESCALATION_BAND, inEscalationBand } from "./page-screen.ts";

// Why Loupe did not answer a page.
export type GlimmerReason =
  | "ablated"
  | "not_configured"
  | "refused"
  | "burst_closed"
  | "out_of_window"
  | "warming"
  | "deployment_missing"
  | "unauthorized"
  | "bad_answer"
  | "error"
  | "timeout"
  | "unsure"
  | "schema";

export type Tier = "glimmer" | "spark" | "spark-second";
export type Escalation = "loupe-unsure" | "spark-unsure" | null;

// Why Spark did not answer one.
export type SparkReason =
  | "budget"
  | "budget-unavailable"
  | `output-${"schema" | "invalid" | "incomplete" | "refused" | "failed"}`
  | `model-${string}`
  | "error";

export type GlimmerAnswer =
  | { answer: PageAnswer }
  | { reason: GlimmerReason; failure?: { kind: "capacity" | "unknown"; status?: number; retryAfterMs?: number } };
export type ScreeningExperiment = {
  infer(
    operationId: string,
    body: string,
    deadline: number,
    send: (attemptId: string) => Promise<GlimmerAnswer>,
  ): Promise<GlimmerAnswer>;
  settlementAllowed(): Promise<boolean>;
};

export type GlimmerSession = {
  experiment?: ScreeningExperiment;
  ctx: WakeCtx;
  burst: Burst | null;
  // Loupe's state for the run: not yet asked, ready, or down for the rest of the run with the reason.
  state: "unknown" | "ready" | { down: GlimmerReason };
  // Loupe is asked only while a request fits the burst's reservation: its wake, the warm-up window and the calls.
  reservedUntil: number;
  // When this run's last Loupe request ended (its answer or its deadline), for the settlement.
  lastRequestEnd: number | null;
  // A burst the wake or the warm-up wait settled itself and could not (it stays counted at its reserve): `closeGlimmer`
  // settles it again, to the same cutoff.
  unsettled?: { burst: Burst; until: number };
};

export type SparkCall = { callId: string; logId: string | null };
export type Screened =
  | {
      ok: true;
      screen: PageScreen;
      glimmer_reason: GlimmerReason | null;
      spark_call: SparkCall | null;
      // The tier that settled the page and why it escalated (D03 T04 §45); every Spark call made, in order.
      tier: Tier;
      escalation: Escalation;
      spark_calls: SparkCall[];
      // Set when Loupe was skipped for the `no-screening` ablation arm (D03 T02 §6).
      ablated?: "no-screening";
    }
  | {
      ok: false;
      glimmer_reason: GlimmerReason;
      spark_reason: SparkReason;
      spark_calls: SparkCall[];
      ablated?: "no-screening";
    };

export type Page = { image?: Uint8Array; text: string; host: string | null; mode: ScreenMode; nonce?: string };

// The burst an outcome could not settle, with the cutoff it was to be settled to; none when it settled or had no burst.
const unsettledOf = (outcome: object) => {
  const o = outcome as { settled?: boolean; burst?: Burst; settleUntil?: number };
  return o.settled === false && o.burst && o.settleUntil !== undefined
    ? { unsettled: { burst: o.burst, until: o.settleUntil } }
    : {};
};

// Wakes Loupe for a run (§15). The session says, for every page after, whether Loupe may be asked.
export async function openGlimmer(ctx: WakeCtx, experiment?: ScreeningExperiment): Promise<GlimmerSession> {
  const flag = await ctx.ablateFlag?.().catch(() => null);
  if (flag === "no-screening")
    return {
      ctx,
      ...(experiment ? { experiment } : {}),
      burst: null,
      state: { down: "ablated" },
      reservedUntil: 0,
      lastRequestEnd: null,
    };
  const woken = await wakeGlimmer(ctx);
  if (woken.outcome !== "woken")
    return {
      ctx,
      ...(experiment ? { experiment } : {}),
      burst: null,
      state: { down: woken.outcome },
      reservedUntil: 0,
      lastRequestEnd: null,
      ...unsettledOf(woken),
    };
  const reservedUntil = woken.burst.wakeAt + (burstMinutes(ctx.calls, ctx.callSeconds) - TAIL_MINUTES) * 60_000;
  return {
    ctx,
    ...(experiment ? { experiment } : {}),
    burst: woken.burst,
    state: woken.first?.outcome === "ready" ? "ready" : "unknown",
    reservedUntil,
    lastRequestEnd: null,
  };
}

// Settles the run's burst (§14): to this run's last Loupe request, or, when this instance sent none (a resumed step),
// to the end of the burst's reserved window, plus the tail. Never to the time the run spent elsewhere after its last
// request. The result is returned, so a settlement that failed is reported.
export async function closeGlimmer(session: GlimmerSession) {
  if (session.experiment && !(await session.experiment.settlementAllowed()))
    return { ok: false as const, detail: "unknown experimental Loupe outcome" };
  if (!session.burst && session.unsettled)
    return settleGlimmer(session.ctx, session.unsettled.burst, session.unsettled.until);
  if (!session.burst) return null;
  const until = session.lastRequestEnd ?? Math.max(session.reservedUntil, session.burst.deadline);
  return settleGlimmer(session.ctx, session.burst, until);
}

async function askGlimmer(
  session: GlimmerSession,
  request: ScreenRequest,
  owner: { run: string; host: string },
): Promise<GlimmerAnswer> {
  if (!session.experiment) return requestGlimmer(session, request, owner);
  const body = JSON.stringify(glimmerBody(request));
  const result = await session.experiment.infer(owner.run, body, session.reservedUntil, (attemptId) =>
    requestGlimmer(session, request, owner, attemptId, body),
  );
  if ("reason" in result && (result.reason === "deployment_missing" || result.reason === "unauthorized"))
    session.state = { down: result.reason };
  return result;
}

async function requestGlimmer(
  session: GlimmerSession,
  request: ScreenRequest,
  owner: { run: string; host: string },
  attemptId?: string,
  body?: string,
): Promise<GlimmerAnswer> {
  const { ctx } = session;
  const now = ctx.now ?? (() => Date.now());
  // The ledger reserved this many calls: a request past the reservation is refused, and Spark takes the page.
  if (now() + REQUEST_MS > session.reservedUntil) return { reason: "out_of_window" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("deadline")), REQUEST_MS);
  try {
    const response = await (ctx.fetcher ?? fetch)(completionsUrl(ctx.env), {
      method: "POST",
      headers: fireworksHeaders(ctx.env, {
        caller: "glimmer-screen",
        monitor_run: owner.run,
        host: owner.host,
        ...(attemptId ? { attempt: attemptId } : {}),
      }),
      body: body ?? JSON.stringify(glimmerBody(request)),
      signal: controller.signal,
    });
    const text = session.experiment ? await probeBody(response) : await response.text();
    if (response.status === 404) {
      session.state = { down: "deployment_missing" };
      return { reason: "deployment_missing" };
    }
    if (response.status === 401 || response.status === 403) {
      session.state = { down: "unauthorized" };
      return { reason: "unauthorized" };
    }
    if (!response.ok) {
      if (session.experiment) {
        let scaling = false;
        try {
          scaling = response.status === 503 && JSON.parse(text)?.error?.code === "DEPLOYMENT_SCALING_UP";
        } catch {
          /* A generic server failure is an unknown paid outcome. */
        }
        const retryAfterMs = retryDelay(response.headers.get("retry-after"), now());
        return {
          reason: "error",
          failure: {
            kind: response.status === 429 || scaling ? "capacity" : "unknown",
            status: response.status,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          },
        };
      }
      return { reason: "error" };
    }
    let content: unknown;
    try {
      content = (JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message
        ?.content;
    } catch {
      // A 200 that is not JSON: no answer, and the page goes to Spark.
      return { reason: "bad_answer" };
    }
    const answer = typeof content === "string" ? readAnswer(content) : null;
    return answer ? { answer } : { reason: "schema" };
  } catch {
    // The request's own 10-second deadline, or the network: Spark takes the page, and the next page asks Loupe again.
    return {
      reason: controller.signal.aborted ? "timeout" : "error",
      ...(session.experiment ? { failure: { kind: "unknown" as const } } : {}),
    };
  } finally {
    clearTimeout(timer);
    session.lastRequestEnd = now();
  }
}

export function sparkReason(error: unknown): SparkReason {
  if (error instanceof BudgetExceeded) return "budget";
  if (error instanceof BudgetUnavailable) return "budget-unavailable";
  if (error instanceof ModelOutputError) return `output-${error.kind}`;
  if (error instanceof ModelError) return `model-${error.kind}`;
  return "error";
}

// Screens one page: Loupe when the session allows it, Spark when Loupe cannot answer, a typed failure when neither can.
export async function screenPage(
  page: Page,
  session: GlimmerSession,
  spark: Omit<StructuredContext, "owner">,
  run: string,
): Promise<Screened> {
  const request = buildScreenRequest({
    ...(page.image ? { image: page.image } : {}),
    host: page.host,
    text: page.text,
    mode: page.mode,
    ...(page.nonce ? { nonce: page.nonce } : {}),
  });
  const host = page.host ?? "none";
  let reason: GlimmerReason | null = null;
  if (
    !(typeof session.state === "object" && session.state.down === "ablated") &&
    (await session.ctx?.ablateFlag?.().catch(() => null)) === "no-screening"
  ) {
    session.state = { down: "ablated" };
  }
  if (session.state === "unknown" && session.burst) {
    const warm = await untilWarm(session.ctx, session.burst);
    session.state = warm.outcome === "ready" ? "ready" : { down: warm.outcome };
    const unsettled = unsettledOf(warm);
    if (unsettled.unsettled) {
      session.unsettled = unsettled.unsettled;
      // The burst is no longer this session's to settle by its own cutoff: the retry carries the one that failed.
      session.burst = null;
    }
  }
  let escalation: Escalation = null;
  if (session.state === "ready") {
    const asked = await askGlimmer(session, request, { run, host });
    if ("answer" in asked) {
      // A sure Loupe answer settles the page; an unsure one escalates to Spark (D03 T04 §45).
      if (!inEscalationBand(asked.answer.confidence))
        return {
          ok: true,
          screen: screened(asked.answer, "glimmer"),
          glimmer_reason: null,
          spark_call: null,
          tier: "glimmer",
          escalation: null,
          spark_calls: [],
        };
      reason = "unsure";
      escalation = "loupe-unsure";
    } else reason = asked.reason;
  } else if (session.state !== "unknown") reason = session.state.down;
  else reason = "not_configured";
  const ablatedMark = reason === "ablated" ? ({ ablated: "no-screening" as const } as const) : {};
  // Spark, once, then once more only when its own answer is unsure: at most two Spark calls settle a page.
  const calls: SparkCall[] = [];
  const askSpark = async () => {
    try {
      // One attempt a pass, so the two-pass ceiling is a ceiling on paid calls, schema repairs included (§45).
      const answer = await structured(PageAnswer, sparkRequest(request), {
        ...spark,
        ...(spark.continuation
          ? { continuation: { ...spark.continuation, ordinal: (calls.length + 1) as 1 | 2 } }
          : {}),
        maxAttempts: 1,
        transportAttempts: 1,
        owner: { kind: "monitor", run, host, step: "screen" },
      });
      const call = { callId: answer.callId, logId: answer.logId };
      calls.push(call);
      return answer.value;
    } catch (error) {
      // A failed attempt's references are preserved too, so every paid call is findable from the result.
      if (error instanceof ModelOutputError)
        for (const call of error.calls) if (!calls.some((c) => c.callId === call.callId)) calls.push(call);
      if (error instanceof ModelError && error.details.callId)
        if (!calls.some((c) => c.callId === error.details.callId))
          calls.push({ callId: error.details.callId, logId: error.details.logId ?? null });
      throw error;
    }
  };
  let first: PageAnswer;
  try {
    first = await askSpark();
  } catch (error) {
    if (spark.continuation?.pending(error)) throw error;
    return {
      ok: false,
      glimmer_reason: reason,
      spark_reason: sparkReason(error),
      spark_calls: calls,
      ...ablatedMark,
    };
  }
  if (!inEscalationBand(first.confidence))
    return {
      ok: true,
      screen: screened(first, "spark"),
      glimmer_reason: reason,
      spark_call: calls.at(-1) ?? null,
      tier: "spark",
      escalation,
      spark_calls: calls,
      ...ablatedMark,
    };
  // The second pass settles the page even when it is unsure again: it is the last tier, never a loop.
  let second: PageAnswer;
  try {
    second = await askSpark();
  } catch (error) {
    if (spark.continuation?.pending(error)) throw error;
    return {
      ok: false,
      glimmer_reason: reason,
      spark_reason: sparkReason(error),
      spark_calls: calls,
      ...ablatedMark,
    };
  }
  return {
    ok: true,
    screen: screened(second, "spark"),
    glimmer_reason: reason,
    spark_call: calls.at(-1) ?? null,
    tier: "spark-second",
    escalation: escalation ?? "spark-unsure",
    spark_calls: calls,
    ...ablatedMark,
  };
}
