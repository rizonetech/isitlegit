// The "This verdict is wrong" control (D07 T03 §6; design/SPEC.md M3 footer, board `Main`; the control itself is not
// drawn, so it is built from the shared controls): closed, open with the choice that disputes this verdict first, or
// the member's saved feedback with Change. Kept apart from its route (./feedback) so the report can be drawn with no
// storage.
import { cx, FOCUS } from "../components/attrs";
import { Button } from "../components/Button";

export type FeedbackKind = "false_alarm" | "missed";
export const MAX_NOTE = 1000;
const KIND_WORDS: Record<FeedbackKind, string> = { false_alarm: "It is safe", missed: "It is a scam" };

export type FeedbackState = {
  caseId: string;
  verdict: "malicious" | "suspicious" | "safe";
  saved: { kind: FeedbackKind; note: string | null } | null;
  // The form shown again: what was typed and what is wrong with it.
  form?: { kind: string; note: string; errors: { kind?: string; note?: string } };
  open?: boolean;
};

// The control in the finished report's footer (M3 "This verdict is wrong"; not drawn on a board, built from the
// shared controls): closed, open with the choice first that disputes this verdict, or the saved state with Change.
export function FeedbackControl(props: FeedbackState) {
  const { caseId, verdict, saved, form } = props;
  // The region a send replaces: its own refusals (400, 503) are drawn in it, not as a page (src/web/client/app.ts).
  const region = { id: "feedback", class: "flex flex-col gap-12", "data-swap-errors": "" };
  if (saved && !form && !props.open)
    return (
      <div {...region}>
        <p role="status" class="text-14">
          {`You said this verdict is wrong: ${KIND_WORDS[saved.kind]}.`} Thanks. We will look at this case. Your report
          and its verdict stay as they are.
        </p>
        <form hx-get={`/r/${caseId}/feedback`} hx-target="#feedback" hx-swap="outerHTML" class="self-start">
          <Button type="submit" variant="link">
            Change
          </Button>
        </form>
      </div>
    );
  const first: FeedbackKind = verdict === "safe" ? "missed" : "false_alarm";
  const order: FeedbackKind[] = first === "missed" ? ["missed", "false_alarm"] : ["false_alarm", "missed"];
  const chosen = form?.kind ?? saved?.kind ?? "";
  const note = form?.note ?? saved?.note ?? "";
  const errors = form?.errors ?? {};
  return (
    <details {...region} open={!!(props.open || form || saved)}>
      <summary class={cx("self-start cursor-pointer text-14 text-orange-text underline underline-offset-4", FOCUS)}>
        This verdict is wrong
      </summary>
      <form
        method="post"
        action={`/r/${caseId}/feedback`}
        hx-post={`/r/${caseId}/feedback`}
        hx-target="#feedback"
        hx-swap="outerHTML"
        data-busy
        class="flex flex-col gap-16 mt-12 p-24 bg-surface border border-line rounded-card-large"
      >
        <fieldset class="flex flex-col gap-8" {...(errors.kind ? { "aria-describedby": "feedback-kind-error" } : {})}>
          <legend class="text-14 weight-text-strong">What is it really?</legend>
          {order.map((kind) => (
            <label class="inline-flex items-center gap-8 text-14">
              <input type="radio" name="kind" value={kind} checked={chosen === kind} required />
              {KIND_WORDS[kind]}
            </label>
          ))}
          {errors.kind && (
            <p id="feedback-kind-error" role="alert" class="text-14 text-mal weight-text-strong">
              {errors.kind}
            </p>
          )}
        </fieldset>
        <label class="flex flex-col gap-8 text-14">
          <span class="weight-text-strong">A note for us (optional)</span>
          <textarea
            name="note"
            rows={3}
            maxlength={MAX_NOTE}
            class={cx(
              "p-12 bg-surface border rounded-control text-14",
              errors.note ? "border-mal" : "border-line-strong",
              FOCUS,
            )}
            {...(errors.note ? { "aria-invalid": "true", "aria-describedby": "feedback-note-error" } : {})}
          >
            {note}
          </textarea>
        </label>
        {errors.note && (
          <p id="feedback-note-error" role="alert" class="text-14 text-mal weight-text-strong">
            {errors.note}
          </p>
        )}
        <Button type="submit" variant="dark" class="self-start" data-busy-label="Sending…">
          Send
        </Button>
      </form>
    </details>
  );
}
