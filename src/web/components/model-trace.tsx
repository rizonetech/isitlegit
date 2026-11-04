// "How Meta's models worked on this case" (D07 T03 §5; design/SPEC.md report page, boards `Main` and `Report-Safe`): the
// case's model calls as a table (step, model, what it did, time, cost) with the run's totals, the walkthrough agent's
// actions in order and the mail the case sent. Pure: the reader (src/db/model-trace.ts) stores nothing typed by hand,
// and "what it did" is derived from the stored verdict and walk, saying so when a result is not stored.
import type { ModelTrace, TraceAction, TraceCall, TraceSend } from "../../db/model-trace-types";
import { admissionFailed, type Progress } from "../pages/report-progress";

// The recorded steps in the board's plain words; a step this map does not know reads as its recorded name.
const STEP_WORDS: Record<string, string> = {
  walkthrough: "Walked the link like a victim would",
  verdict: "Verdict investigation",
  transcribe: "Transcribed the voice note",
};
const TOOL_WORDS: Record<string, string> = {
  click: "Clicked",
  double_click: "Double-clicked",
  move: "Moved the pointer",
  scroll: "Scrolled",
  type: "Typed into a field (the text is never kept)",
  keypress: "Pressed a key",
  wait: "Waited",
  screenshot: "Took a screenshot",
};
const KIND_WORDS: Record<TraceAction["kind"], string> = {
  action: "An action",
  request: "A page request",
  popup: "A popup",
  end: "The walk ended",
};
const OUTCOME_WORDS: Record<TraceAction["outcome"], string> = {
  done: "done",
  refused: "refused",
  limit: "stopped at a limit",
  error: "failed",
};
const SEND_WORDS: Record<TraceSend["status"], string> = {
  sent: "sent",
  failed: "failed",
  uncertain: "may have been sent",
  refused: "refused",
  pending: "waiting",
};
const SEND_KIND: Record<string, string> = {
  reply: "Reply",
  signin: "Sign-in link",
  verify: "Verification code",
  alert: "Alert",
  notice: "Notice",
  renewal: "Renewal notice",
};

// What the verdict and the walk stored for this case, which the descriptions are derived from.
export type TraceFacts = { findings: number; cited: string[] | null; verdictSource: "stub" | "rules" | "agent" | null };

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const dollars = (usd: number) => `US$${usd.toFixed(3)}`;

// Why a model call failed or was refused, in words (the classes the Meta client and the budget record); a class this does
// not know reads as a plain error, its name shown only when it is a short word.
export function failureWords(errorClass: string | null): string {
  if (errorClass === "Timeout") return "the model did not answer in time";
  if (errorClass === "NotSent") return "the request was not sent";
  if (errorClass?.startsWith("budget:day")) return "today's model limit was reached";
  if (errorClass?.startsWith("budget:")) return "the overall model budget was reached";
  return errorClass && /^[A-Za-z]{1,40}$/.test(errorClass) ? `an error (${errorClass})` : "an error";
}

// What the walkthrough stored as the reason an action was refused, stopped at a limit or failed, in words; its own short
// codes are mapped, and anything else reads as a plain kind of stop, never the raw text.
function actionReason(a: TraceAction): string | null {
  if (a.outcome === "done") return null;
  if (a.reason === "steps") return "the step limit was reached";
  if (a.reason === "time") return "the time limit was reached";
  if (a.outcome === "refused") return "stopped by the walkthrough's safety rules";
  if (a.outcome === "limit") return "stopped at a limit";
  return "the walk met an error";
}

// `chosen`: the actions this call led to (the ones after it, until the next call of its step), or null when no walk was
// stored. A trace attributes work to the call that produced it and never repeats a run-wide total on every call.
export function whatItDid(call: TraceCall, chosen: number | null): string {
  if (call.outcome === "refused") return `Refused: ${failureWords(call.errorClass)}`;
  if (call.outcome === "error") return `Did not finish: ${failureWords(call.errorClass)}`;
  if (call.outcome === null) return "Outcome not recorded";
  if (call.step === "verdict") return "Returned a response to the verdict investigation";
  if (call.step === "walkthrough") {
    if (chosen === null) return "Result not stored";
    return chosen === 0 ? "Concluded the walk" : `Chose ${chosen} ${chosen === 1 ? "action" : "actions"}`;
  }
  return (call.step && STEP_WORDS[call.step]) || "A model call";
}

// The final verdict is a case result, never proof that every exploratory response cited its evidence.
export function finalVerdictSummary(facts: TraceFacts): string {
  if (facts.verdictSource === "rules") return "Rule-based verdict used; no model verdict accepted.";
  if (facts.verdictSource !== "agent" || facts.cited === null) return "No accepted model verdict recorded.";
  return `The final verdict used an accepted model assessment with deterministic safety checks${facts.cited.length ? `, citing ${facts.cited.join(", ")}` : ""}.`;
}

// The actions each walkthrough call led to: those made from the call until the next walkthrough call. Null for every call
// when the walk stored nothing.
function chosenBy(trace: ModelTrace): Map<string, number | null> {
  const acts = trace.actions.filter((a) => a.kind === "action");
  const calls = trace.calls.filter((c) => c.step === "walkthrough").sort((a, b) => a.at.localeCompare(b.at));
  const out = new Map<string, number | null>();
  calls.forEach((call, i) => {
    const next = calls[i + 1]?.at;
    out.set(
      call.id,
      trace.actions.length === 0 ? null : acts.filter((a) => a.at >= call.at && (!next || a.at < next)).length,
    );
  });
  return out;
}

function Row(props: { call: TraceCall; chosen: number | null }) {
  const { call } = props;
  return (
    <tr class="align-top border-t border-line">
      <td class="py-8 pr-8 wrap-anywhere">{(call.step && STEP_WORDS[call.step]) || call.step || "A model call"}</td>
      <td class="py-8 pr-8 wrap-anywhere">{call.model}</td>
      <td class="py-8 pr-8 wrap-anywhere">
        {whatItDid(call, props.chosen)}
        {call.cached ? " · cached" : ""}
      </td>
      <td class="py-8 pr-8 wrap-anywhere">{call.ms === null ? "not recorded" : seconds(call.ms)}</td>
      <td class="py-8 wrap-anywhere">
        {dollars(call.usd)}
        {call.certainty === "estimated" ? " (estimated)" : ""}
      </td>
    </tr>
  );
}

// Whether the case's reply is still to come: a failed (`partial`) emailed case whose reply step has not ended and that
// moved lately (its reply row does not exist until that step starts, and a Workflow that stopped must not keep a page
// asking for ever). A `done` case has finished its reply, so awaits nothing.
const AWAIT_MS = 10 * 60_000;
export function replyAwaited(
  channel: "email" | "upload",
  status: "received" | "running" | "done" | "partial",
  progress: Progress,
  now: Date,
): boolean {
  if (channel !== "email" || status !== "partial" || admissionFailed(progress)) return false;
  const reply = progress.steps.find((s) => s.step === "reply")?.state ?? "waiting";
  if (reply === "done" || reply === "failed") return false;
  const last = Math.max(...progress.steps.map((s) => (s.at ? Date.parse(s.at) : 0)));
  return last > 0 && now.getTime() - last < AWAIT_MS;
}

// The case's mail (from `mail_sends`, never an address). While a send is unsettled (waiting, or may have been sent), or
// the reply is still to come, the section asks for itself again every 15 seconds and swaps only itself, so the open
// panel settles without a reload and without losing its disclosure state; it names the run it was drawn for, and the
// answer is refused for any other (a retry in another tab), so two runs never mix; once every send is settled and no
// reply is awaited it stops (D07 T03 §5, completion review).
const UNSETTLED = new Set(["pending", "uncertain"]);
export function TraceMail(props: { sends: readonly TraceSend[]; caseId: string; run: string; awaiting: boolean }) {
  const settling = props.awaiting || props.sends.some((m) => UNSETTLED.has(m.status));
  return (
    <section
      id="trace-mail"
      aria-labelledby="trace-mail-heading"
      class="flex flex-col gap-8"
      {...(settling
        ? {
            "hx-get": `/r/${props.caseId}/trace-mail?run=${encodeURIComponent(props.run)}`,
            "hx-trigger": "every 15s",
            "hx-swap": "outerHTML",
            "data-quiet-poll": "",
          }
        : {})}
    >
      <h3 id="trace-mail-heading" class="type-small weight-text-strong">
        Mail sent for this case
      </h3>
      {props.sends.length === 0 ? (
        <p class="text-14">{props.awaiting ? "The reply has not been sent yet." : "No mail was sent for this case."}</p>
      ) : (
        <ul class="flex flex-col gap-4 text-14">
          {props.sends.map((m) => (
            <li class="wrap-anywhere">
              {`${SEND_KIND[m.kind] ?? m.kind}: ${SEND_WORDS[m.status]} · ${m.attempts} ${m.attempts === 1 ? "attempt" : "attempts"}${m.error ? ` · ${m.error}` : ""} · ${m.at.slice(0, 16).replace("T", " ")} UTC`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ModelTracePanel(props: {
  trace: ModelTrace;
  facts: TraceFacts;
  caseId: string;
  run: string;
  awaiting: boolean;
  open?: boolean;
}) {
  const { trace } = props;
  const { total } = trace;
  const chosen = chosenBy(trace);
  const walks = [...new Set(trace.actions.map((a) => a.walk))];
  const totals = [
    // Only the times that were recorded add up; none recorded is not a measured zero.
    trace.calls.length === total.unknownTime
      ? "Total time not recorded"
      : `Total ${seconds(total.ms)}${total.unknownTime ? ` (time not recorded for ${total.unknownTime})` : ""}`,
    dollars(total.measuredUsd),
    ...(total.estimatedCalls
      ? [
          `${dollars(total.estimatedUsd)} estimated for ${total.estimatedCalls} ${total.estimatedCalls === 1 ? "call" : "calls"}`,
        ]
      : []),
  ].join(" · ");
  return (
    <details
      id="model-trace"
      open={props.open}
      class="p-24 bg-surface border border-line rounded-card-large"
      data-model-trace
    >
      <summary class="cursor-pointer font-heading weight-heading type-h3">
        How Meta's models worked on this case
      </summary>
      <div class="flex flex-col gap-16 mt-16">
        {trace.calls.length === 0 ? (
          <p class="text-14">No model was used for this case.</p>
        ) : (
          <>
            <p class="text-14 weight-text-strong">{totals}</p>
            {trace.calls.some((call) => call.step === "verdict") && (
              <p class="text-14">{finalVerdictSummary(props.facts)}</p>
            )}
            <div>
              <table class="w-full table-fixed text-14 text-left">
                <caption class="sr-only">The model calls made for this case</caption>
                <thead>
                  <tr class="text-muted">
                    <th scope="col" class="w-[19%] pb-8 pr-8 weight-text-strong">
                      Step
                    </th>
                    <th scope="col" class="w-[23%] pb-8 pr-8 weight-text-strong">
                      Model
                    </th>
                    <th scope="col" class="w-[30%] pb-8 pr-8 weight-text-strong">
                      What it did
                    </th>
                    <th scope="col" class="w-[12%] pb-8 pr-8 weight-text-strong">
                      Time
                    </th>
                    <th scope="col" class="w-[16%] pb-8 weight-text-strong">
                      Cost
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {trace.calls.map((call) => (
                    <Row call={call} chosen={chosen.get(call.id) ?? null} />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {trace.actions.length > 0 && (
          <section aria-labelledby="trace-actions" class="flex flex-col gap-8">
            <h3 id="trace-actions" class="type-small weight-text-strong">
              The agent's actions, in order
            </h3>
            {walks.map((walk, i) => (
              <div class="flex flex-col gap-4">
                {walks.length > 1 && <p class="type-small text-muted">{`Walk ${i + 1}`}</p>}
                <ol class="list-decimal pl-24 text-14">
                  {trace.actions
                    .filter((a) => a.walk === walk)
                    .map((a) => (
                      <li class="wrap-anywhere">{`${(a.tool && TOOL_WORDS[a.tool]) || KIND_WORDS[a.kind]}: ${OUTCOME_WORDS[a.outcome]}${actionReason(a) ? ` (${actionReason(a)})` : ""}`}</li>
                    ))}
                </ol>
              </div>
            ))}
          </section>
        )}
        <TraceMail sends={trace.sends} caseId={props.caseId} run={props.run} awaiting={props.awaiting} />
      </div>
    </details>
  );
}
