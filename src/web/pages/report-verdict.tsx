// The report's verdict section (D07 T03 §2; design/SPEC.md M3, boards `Main`, `Report-Safe`, `Report-Invoice`,
// `Report-Voice`, `Report-Mobile`): the band (the verdict and its confidence in words, the headline and what it means),
// then what to do now, then why we say so, in that order. Reasons link to their evidence by the ids the verdict's writer
// cites (D04 T01 §2, §5); a fixed action (src/invoice/fixed-actions.ts) or a voice note puts its first instruction in
// the highlighted "Do this first" block.
import { fixedActionOf } from "../../invoice/fixed-actions";
import { cx } from "../components/attrs";
import type { Severity } from "../components/Evidence";
import { EvidenceRef } from "../components/Evidence";
import { type CheckState, type Confidence, VerdictBand, type VerdictName } from "../components/Verdict";

// A reason as the report draws it (D04 T01 §2): its words and the evidence it cites, the pill from the first.
export type Reason = { text: string; evidenceIds: string[] };
export type ReportVerdict = {
  verdict: VerdictName;
  headline: string;
  confidence: number;
  reasons: readonly (string | Reason)[];
  actions: readonly string[];
};

// The stored reasons as `{ text, evidenceIds }`: an old row's plain string cites nothing and is drawn without a pill.
// WORKAROUND: the checks lane's reader (D04 T01 §2) does this mapping once it lands; until then `case_verdicts.reasons`
// is `string[]` and the report maps it here, accepting both shapes.
export function reasonsOf(reasons: readonly (string | Reason)[]): Reason[] {
  return reasons.map((reason) => (typeof reason === "string" ? { text: reason, evidenceIds: [] } : reason));
}

// Confidence in words (M3's eyebrow): no band is defined upstream, so these are the report's (a Deviation in
// design/SPEC.md M3).
export function confidenceWords(confidence: number): Confidence {
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

// One sentence on what the verdict means, until the verdict stores its own (D07 T03 §10).
const MEANING: Record<VerdictName, string> = {
  malicious: "Treat it as unsafe: do not click its links, open its attachments or pay anything it asks for.",
  suspicious: "Confirm with the sender another way before you act on it.",
  safe: "We found nothing wrong in what we could check.",
};

// The actions in drawing order: a fixed action first, and whether the list is the "Do this first" block (a fixed
// action, or a voice note, whose call-back comes first when the verdict carries it).
// The fixed action is found among every stored action before the list is cut to three, so it is never dropped.
export function orderedActions(actions: readonly string[], voice: boolean) {
  const fixed = actions.findIndex((action) => fixedActionOf(action) !== null);
  if (fixed < 0) return { first: voice, actions: actions.slice(0, 3) };
  return { first: true, actions: [actions[fixed] as string, ...actions.filter((_, i) => i !== fixed)].slice(0, 3) };
}

export function VerdictSection(props: {
  state: Extract<CheckState, "complete" | "partial">;
  stored: ReportVerdict;
  evidence: readonly { id: string; severity: Exclude<Severity, "not-checked"> }[];
  voice: boolean;
}) {
  const { state, stored, voice } = props;
  const severity = new Map(props.evidence.map((item) => [item.id, item.severity]));
  const { first, actions } = orderedActions(stored.actions, voice);
  const fixedKinds = stored.actions.map(fixedActionOf);
  const invoice = fixedKinds.includes("bank-change");
  // A payment document's fixed action stretches across the page with its reasons in three columns
  // (`Report-Invoice`); a voice note's "Do this first" sits beside its listed reasons (`Report-Voice`), as plain
  // actions do (`Main`).
  const wide = invoice || fixedKinds.includes("pop");
  const kind = invoice ? "invoice fraud" : voice ? "voice note" : undefined;
  const reasons = reasonsOf(stored.reasons).slice(0, 3);
  const [lead, ...rest] = actions;
  const actionBlock =
    actions.length === 0 ? null : first ? (
      <section
        aria-labelledby="actions-heading"
        class={cx("flex flex-col gap-8 p-24 border-2 border-ink rounded-card-large", wide && "md:px-28")}
      >
        <h2 id="actions-heading" class="type-eyebrow">
          Do this first
        </h2>
        <p class="font-heading weight-heading text-22 wrap-anywhere">{lead}</p>
        {rest.length > 0 && <p class="text-16 text-muted wrap-anywhere">{rest.join(" ")}</p>}
      </section>
    ) : (
      <section
        aria-labelledby="actions-heading"
        class="flex flex-col gap-16 p-24 bg-surface border border-line rounded-card-large"
      >
        <h2 id="actions-heading" class="type-h3">
          What to do now
        </h2>
        <ol class="flex flex-col gap-12 pl-24 list-decimal wrap-anywhere">
          {actions.map((action) => (
            <li>{action}</li>
          ))}
        </ol>
      </section>
    );
  const reasonBlock =
    reasons.length === 0 ? null : (
      <section
        aria-labelledby="reasons-heading"
        class="flex flex-col gap-16 p-24 bg-surface border border-line rounded-card-large"
      >
        <h2 id="reasons-heading" class="type-h3">
          Why we say so
        </h2>
        <ul class={wide ? "grid gap-16 md:grid-cols-3" : "flex flex-col gap-12"}>
          {reasons.map((reason) => {
            const id = reason.evidenceIds[0];
            const level = id ? severity.get(id) : undefined;
            return (
              <li class="flex items-start gap-8 min-w-0 wrap-anywhere">
                {/* Only a card the page holds is linked: a pill never points at nothing. */}
                {id && level && <EvidenceRef id={id} level={level} />}
                <span class="min-w-0">{reason.text}</span>
              </li>
            );
          })}
        </ul>
      </section>
    );
  return (
    <>
      <VerdictBand
        state={state}
        verdict={stored.verdict}
        confidence={confidenceWords(stored.confidence)}
        headline={stored.headline}
        {...(kind ? { kind } : {})}
      >
        {MEANING[stored.verdict]}
      </VerdictBand>
      {wide ? (
        <>
          {actionBlock}
          {reasonBlock}
        </>
      ) : (
        (actionBlock || reasonBlock) && (
          <div class="grid gap-24 md:grid-cols-2">
            {actionBlock}
            {reasonBlock}
          </div>
        )
      )}
    </>
  );
}
