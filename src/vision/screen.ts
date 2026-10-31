// The monitor's page screener (D03 T04 §1): Loupe, the fine-tuned Glimmer on its dedicated deployment, first; Muse
// Spark on the Meta Model API when Loupe cannot answer. One page in, one `PageScreen` out (or a typed failure), with
// which screener answered, why Loupe did not, and the Spark call's ids, for the monitor's screening to store
// (D05 T04 §3).
//
// A run opens a Loupe session (`openGlimmer`: §15's wake, the burst reserved in §14's ledger), screens its pages, and
// closes it (`closeGlimmer`: the burst settled). Loupe is asked only inside the burst's reserved window; past it, or
// while it is warming past its limit, missing, refusing or failing, the page goes to Spark.

import { ModelError } from "../meta/client.ts";
import type { BudgetExceeded as BudgetExceededType } from "../meta/guard.ts";
import { BudgetExceeded, BudgetUnavailable } from "../meta/guard.ts";
import { formatSchema, ModelOutputError, type StructuredContext, structured } from "../meta/structured.ts";
import { DEPLOYED_MODEL, TAIL_MINUTES } from "./glimmer-caps.ts";
import { burstMinutes } from "./glimmer-minutes.ts";
import {
  type Burst,
  completionsUrl,
  fireworksHeaders,
  REQUEST_MS,
  settleGlimmer,
  untilWarm,
  type WakeCtx,
  wakeGlimmer,
} from "./glimmer-wake.ts";
import {
  buildScreenRequest,
  PageAnswer,
  type PageScreen,
  type ScreenMode,
  type ScreenRequest,
  screened,
} from "./page-screen.ts";

export const SPARK_MODEL = "muse-spark-1.3";
// The answer's output limit, as the held-out evaluation ran it (scripts/glimmer/evaluate.ts).
export const MAX_ANSWER_TOKENS = 500;

// Why Loupe did not answer a page.
export type GlimmerReason =
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
  | "schema";

// Why Spark did not answer one.
export type SparkReason =
  | "budget"
  | "budget-unavailable"
  | `output-${"schema" | "invalid" | "incomplete" | "refused" | "failed"}`
  | `model-${string}`
  | "error";

export type GlimmerSession = {
  ctx: WakeCtx;
  burst: Burst | null;
  // Loupe's state for the run: not yet asked, ready, or down for the rest of the run with the reason.
  state: "unknown" | "ready" | { down: GlimmerReason };
  // Loupe is asked only while a request fits the burst's reservation: its wake, the warm-up window and the calls.
  reservedUntil: number;
  // When this run's last Loupe request ended (its answer or its deadline), for the settlement.
  lastRequestEnd: number | null;
};

export type Screened =
  | {
      ok: true;
      screen: PageScreen;
      glimmer_reason: GlimmerReason | null;
      spark_call: { callId: string; logId: string | null } | null;
    }
  | { ok: false; glimmer_reason: GlimmerReason; spark_reason: SparkReason };

export type Page = { image?: Uint8Array; text: string; host: string | null; mode: ScreenMode; nonce?: string };

// Wakes Loupe for a run (§15). The session says, for every page after, whether Loupe may be asked.
export async function openGlimmer(ctx: WakeCtx): Promise<GlimmerSession> {
  const woken = await wakeGlimmer(ctx);
  if (woken.outcome !== "woken")
    return { ctx, burst: null, state: { down: woken.outcome }, reservedUntil: 0, lastRequestEnd: null };
  const reservedUntil = woken.burst.wakeAt + (burstMinutes(ctx.calls, ctx.callSeconds) - TAIL_MINUTES) * 60_000;
  return {
    ctx,
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
  if (!session.burst) return null;
  const until = session.lastRequestEnd ?? Math.max(session.reservedUntil, session.burst.deadline);
  return settleGlimmer(session.ctx, session.burst, until);
}

// The request Loupe gets: exactly the training request (`buildScreenRequest`), the deployment's model, and the answer
// constrained to `PageAnswer`'s JSON schema.
export function glimmerBody(request: ScreenRequest) {
  return {
    model: DEPLOYED_MODEL,
    messages: request.messages,
    temperature: 0,
    max_tokens: MAX_ANSWER_TOKENS,
    response_format: { type: "json_schema", json_schema: { name: "page_screen", schema: formatSchema(PageAnswer) } },
  };
}

// The answer text as a PageAnswer, strictly: JSON (a fenced block allowed, as the model was trained), then the schema.
export function readAnswer(text: string): PageAnswer | null {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    // Not JSON: no answer. This is the outcome, not a lost error.
    return null;
  }
  const parsed = PageAnswer.safeParse(data);
  return parsed.success ? parsed.data : null;
}

async function askGlimmer(
  session: GlimmerSession,
  request: ScreenRequest,
  owner: { run: string; host: string },
): Promise<{ answer: PageAnswer } | { reason: GlimmerReason }> {
  const { ctx } = session;
  const now = ctx.now ?? (() => Date.now());
  // The ledger reserved this many calls: a request past the reservation is refused, and Spark takes the page.
  if (now() + REQUEST_MS > session.reservedUntil) return { reason: "out_of_window" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("deadline")), REQUEST_MS);
  try {
    const response = await (ctx.fetcher ?? fetch)(completionsUrl(ctx.env), {
      method: "POST",
      headers: fireworksHeaders(ctx.env, { caller: "glimmer-screen", monitor_run: owner.run, host: owner.host }),
      body: JSON.stringify(glimmerBody(request)),
      signal: controller.signal,
    });
    const text = await response.text();
    if (response.status === 404) {
      session.state = { down: "deployment_missing" };
      return { reason: "deployment_missing" };
    }
    if (response.status === 401 || response.status === 403) {
      session.state = { down: "unauthorized" };
      return { reason: "unauthorized" };
    }
    if (!response.ok) return { reason: "error" };
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
    return { reason: controller.signal.aborted ? "timeout" : "error" };
  } finally {
    clearTimeout(timer);
    session.lastRequestEnd = now();
  }
}

// Spark's request: the same screenshot, host and untrusted text block, the screener's prompt as instructions, through
// `structured()`, so the answer is validated as a PageAnswer too.
export function sparkRequest(request: ScreenRequest) {
  const [system, user] = request.messages;
  const parts = user && Array.isArray(user.content) ? user.content : [];
  return {
    name: "page_screen",
    model: SPARK_MODEL,
    instructions: String(system?.content ?? ""),
    max_output_tokens: MAX_ANSWER_TOKENS,
    input: [
      {
        role: "user" as const,
        content: parts.map((part) =>
          part.type === "text"
            ? { type: "input_text" as const, text: part.text }
            : { type: "input_image" as const, image_url: part.image_url.url, detail: "auto" as const },
        ),
      },
    ],
  };
}

function sparkReason(error: unknown): SparkReason {
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
  if (session.state === "unknown" && session.burst) {
    const warm = await untilWarm(session.ctx, session.burst);
    session.state = warm.outcome === "ready" ? "ready" : { down: warm.outcome };
  }
  if (session.state === "ready") {
    const asked = await askGlimmer(session, request, { run, host });
    if ("answer" in asked)
      return { ok: true, screen: screened(asked.answer, "glimmer"), glimmer_reason: null, spark_call: null };
    reason = asked.reason;
  } else if (session.state !== "unknown") reason = session.state.down;
  else reason = "not_configured";
  try {
    const answer = await structured(PageAnswer, sparkRequest(request), {
      ...spark,
      owner: { kind: "monitor", run, host, step: "screen" },
    });
    return {
      ok: true,
      screen: screened(answer.value, "spark"),
      glimmer_reason: reason,
      spark_call: { callId: answer.callId, logId: answer.logId },
    };
  } catch (error) {
    return { ok: false, glimmer_reason: reason, spark_reason: sparkReason(error) };
  }
}

export type { BudgetExceededType };
