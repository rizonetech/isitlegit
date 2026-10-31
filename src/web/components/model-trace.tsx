// "How Meta's models worked on this case" (D07 T03 §5; design/SPEC.md report page, boards `Main` and `Report-Safe`): the
// case's model calls as a table (step, model, what it did, time, cost) with the run's totals, the walkthrough agent's
// actions in order and the mail the case sent. Pure: the reader (src/db/model-trace.ts) stores nothing typed by hand,
// and "what it did" is derived from the stored verdict and walk, saying so when a result is not stored.
import type { ModelTrace, TraceAction, TraceCall, TraceSend } from "../../db/model-trace-types";

// The recorded steps in the board's plain words; a step this map does not know reads as its recorded name.
const STEP_WORDS: Record<string, string> = {
  walkthrough: "Walked the link like a victim would",
  verdict: "Weighed the evidence and wrote the verdict",
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
export type TraceFacts = { findings: number; cited: string[] | null };

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const dollars = (usd: number) => `US$${usd.toFixed(3)}`;

export function whatItDid(call: TraceCall, facts: TraceFacts, walked: number): string {
  if (call.outcome === "refused") return `Refused${call.errorClass ? `: ${call.errorClass}` : ""}`;
  if (call.outcome === "error") return `Did not finish${call.errorClass ? ` (${call.errorClass})` : ""}`;
  if (call.outcome === null) return "Outcome not recorded";
  if (call.step === "verdict") {
    if (facts.cited === null) return "Result not stored";
    const weighed = `Weighed ${facts.findings} ${facts.findings === 1 ? "finding" : "findings"}`;
    return facts.cited.length ? `${weighed}, cited ${facts.cited.join(", ")}` : weighed;
  }
  if (call.step === "walkthrough")
    return walked > 0 ? `Walked the link: ${walked} ${walked === 1 ? "action" : "actions"}` : "Result not stored";
  return (call.step && STEP_WORDS[call.step]) || "A model call";
}

function Row(props: { call: TraceCall; facts: TraceFacts; walked: number }) {
  const { call } = props;
  return (
    <tr class="align-top border-t border-line">
      <td class="py-8 pr-8 wrap-anywhere">{(call.step && STEP_WORDS[call.step]) || call.step || "A model call"}</td>
      <td class="py-8 pr-8 wrap-anywhere">{call.model}</td>
      <td class="py-8 pr-8 wrap-anywhere">
        {whatItDid(call, props.facts, props.walked)}
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

export function ModelTracePanel(props: { trace: ModelTrace; facts: TraceFacts; open?: boolean }) {
  const { trace } = props;
  const { total } = trace;
  const walked = trace.actions.filter((a) => a.kind === "action").length;
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
                    <Row call={call} facts={props.facts} walked={walked} />
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
                      <li class="wrap-anywhere">{`${(a.tool && TOOL_WORDS[a.tool]) || KIND_WORDS[a.kind]}: ${OUTCOME_WORDS[a.outcome]}`}</li>
                    ))}
                </ol>
              </div>
            ))}
          </section>
        )}
        <section aria-labelledby="trace-mail" class="flex flex-col gap-8">
          <h3 id="trace-mail" class="type-small weight-text-strong">
            Mail sent for this case
          </h3>
          {trace.sends.length === 0 ? (
            <p class="text-14">No mail was sent for this case.</p>
          ) : (
            <ul class="flex flex-col gap-4 text-14">
              {trace.sends.map((m) => (
                <li class="wrap-anywhere">
                  {`${SEND_KIND[m.kind] ?? m.kind}: ${SEND_WORDS[m.status]} · ${m.attempts} ${m.attempts === 1 ? "attempt" : "attempts"}${m.error ? ` · ${m.error}` : ""} · ${m.at.slice(0, 16).replace("T", " ")} UTC`}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </details>
  );
}
