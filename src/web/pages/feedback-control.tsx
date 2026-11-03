// The dispute control (D07 T03 §6, §21, §22; design/SPEC.md M3, board `Report-Dispute`): one press on a button
// naming the opposite verdict sends the dispute; the note is offered after, and Change reopens the choice form.
// Kept apart from its route (./feedback) so the report can be drawn with no storage.
import { cx, FIELD_FOCUS } from "../components/attrs";
import { Button } from "../components/Button";

export type FeedbackKind = "false_alarm" | "missed";
export const MAX_NOTE = 1000;
const KIND_WORDS: Record<FeedbackKind, string> = { false_alarm: "It is safe", missed: "It is a scam" };
// What the saved state says for each kind (board `Report-Dispute`).
const SENT_WORDS: Record<FeedbackKind, string> = {
  false_alarm: "Sent: you said this looks safe.",
  missed: "Sent: you said this looks like a scam.",
};
// The one-press button's words for the verdict it disputes.
const PRESS_WORDS: Record<FeedbackKind, string> = {
  false_alarm: "I think this is safe",
  missed: "I think this is a scam",
};
// A send that may or may not have landed (D07 T03 §22): never "did not reach us" for a stored dispute.
const NOT_REACHED =
  "That did not get an answer, so your dispute may or may not have gone through. Reload this page to see where it stands (it asks you to sign in if your session ended), then send again if it is not there.";

export type FeedbackState = {
  caseId: string;
  verdict: "malicious" | "suspicious" | "safe";
  saved: { kind: FeedbackKind; note: string | null; at?: string } | null;
  // The form shown again: what was typed and what is wrong with it.
  form?: { kind: string; note: string; errors: { kind?: string; note?: string } };
  open?: boolean;
  // The member came to dispute (D07 T03 §22, from the email or the signed link through sign-in): the board's line
  // above the button, and the button focused as the page opens.
  dispute?: boolean;
  // The member took their feedback back (D07 T03 §21): said once, with the closed control offered again.
  withdrawn?: boolean;
  // A withdrawal that did not go through, said beside the saved feedback it left in place.
  failed?: string;
};

export function FeedbackControl(props: FeedbackState) {
  const { caseId, verdict, saved, form } = props;
  // The region a send replaces: its own refusals (400, 503) are drawn in it, not as a page (src/web/client/app.ts).
  const region = { id: "feedback", class: "flex flex-col gap-12", "data-swap-errors": "" };
  const opposite: FeedbackKind = verdict === "safe" ? "missed" : "false_alarm";
  if (saved && !form && !props.open)
    return (
      <div {...region}>
        <div role="status" class="flex flex-col gap-4">
          <p data-saved class="text-14 weight-text-strong">
            {SENT_WORDS[saved.kind]}
          </p>
          <p class="type-small text-muted">Thank you. We use this to check our verdicts.</p>
        </div>
        {props.failed && (
          <p role="alert" class="text-14 text-mal weight-text-strong">
            {props.failed}
          </p>
        )}
        {/* The note, offered after the press (board `Report-Dispute`): sending it replaces the saved dispute. */}
        <form
          method="post"
          action={`/r/${caseId}/feedback`}
          hx-post={`/r/${caseId}/feedback`}
          hx-target="#feedback"
          hx-swap="outerHTML"
          data-busy
          data-not-reached-text={NOT_REACHED}
          hx-request='{"timeout":10000}'
          class="flex flex-col gap-8 self-start"
        >
          <input type="hidden" name="kind" value={saved.kind} />
          {saved.at && <input type="hidden" name="base" value={saved.at} />}
          <label class="flex flex-col gap-8 text-14">
            <span class="weight-text-strong">Add a note (optional)</span>
            <textarea
              name="note"
              rows={3}
              maxlength={MAX_NOTE}
              aria-describedby="feedback-note-hint"
              class={cx("p-12 bg-surface border border-control-border rounded-control text-14", FIELD_FOCUS)}
            >
              {saved.note ?? ""}
            </textarea>
          </label>
          <p id="feedback-note-hint" class="type-small text-muted">
            Please leave out passwords and card numbers.
          </p>
          <Button type="submit" variant="primary" size="small" class="self-start" data-busy-label="Sending…">
            Send the note
          </Button>
        </form>
        <div class="flex flex-wrap gap-16">
          <form
            hx-get={`/r/${caseId}/feedback`}
            hx-target="#feedback"
            hx-swap="outerHTML"
            data-busy
            hx-request='{"timeout":10000}'
            class="self-start"
          >
            <Button
              type="submit"
              variant="ghost"
              size="small"
              data-focus
              {...(props.dispute ? { "data-focus-on-load": "" } : {})}
            >
              Change
            </Button>
          </form>
          {/* Takes the feedback back in one press (§21): busy while it posts, and sent once. */}
          <form
            method="post"
            action={`/r/${caseId}/feedback/withdraw`}
            hx-post={`/r/${caseId}/feedback/withdraw`}
            hx-target="#feedback"
            hx-swap="outerHTML"
            data-busy
            data-not-reached-text="That did not get an answer, so your feedback may or may not be withdrawn. Reload this page to see where it stands (it asks you to sign in if your session ended), then press Withdraw again if it is still there."
            hx-request='{"timeout":10000}'
            class="self-start"
          >
            <Button type="submit" variant="ghost" size="small" data-busy-label="Withdrawing…">
              Withdraw
            </Button>
          </form>
        </div>
      </div>
    );
  // The choice form (Change, or a send shown again with its errors): §6's two kinds, the note and Send.
  if (form || props.open) {
    const first: FeedbackKind = verdict === "safe" ? "missed" : "false_alarm";
    const order: FeedbackKind[] = first === "missed" ? ["missed", "false_alarm"] : ["false_alarm", "missed"];
    const chosen = form?.kind ?? saved?.kind ?? "";
    const note = form?.note ?? saved?.note ?? "";
    const errors = form?.errors ?? {};
    // Where focus goes once this answer is drawn (src/web/client/app.ts): the first field in error, or the choice
    // when the form is reopened; a first, closed draw takes none.
    const focus = errors.kind ? "kind" : errors.note ? "note" : props.open ? "kind" : null;
    const focusKind = order.find((k) => k === chosen) ?? order[0];
    return (
      <div {...region}>
        <form
          method="post"
          action={`/r/${caseId}/feedback`}
          hx-post={`/r/${caseId}/feedback`}
          hx-target="#feedback"
          hx-swap="outerHTML"
          data-busy
          data-not-reached-text={NOT_REACHED}
          hx-request='{"timeout":10000}'
          class="flex flex-col gap-16 p-24 bg-surface border border-line rounded-card-large"
        >
          {saved?.at && <input type="hidden" name="base" value={saved.at} />}
          <fieldset class="flex flex-col gap-8" {...(errors.kind ? { "aria-describedby": "feedback-kind-error" } : {})}>
            <legend class="text-14 weight-text-strong">What is it really?</legend>
            {order.map((kind) => (
              <label class="inline-flex items-center gap-8 text-14">
                <input
                  type="radio"
                  name="kind"
                  value={kind}
                  checked={chosen === kind}
                  required
                  {...(focus === "kind" && kind === focusKind ? { "data-focus": "" } : {})}
                />
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
              class={cx("p-12 bg-surface border border-control-border rounded-control text-14", FIELD_FOCUS)}
              {...(errors.note ? { "aria-invalid": "true", "aria-describedby": "feedback-note-error" } : {})}
              {...(focus === "note" ? { "data-focus": "" } : {})}
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
      </div>
    );
  }
  // The closed control: one press sends the dispute (board `Report-Dispute`).
  const closed = (
    <>
      {props.dispute && <p class="text-14">You came here from the email to say this verdict is wrong.</p>}
      <p class="text-14">Was this verdict wrong?</p>
      <form
        method="post"
        action={`/r/${caseId}/feedback`}
        hx-post={`/r/${caseId}/feedback`}
        hx-target="#feedback"
        hx-swap="outerHTML"
        data-busy
        data-not-reached-text={NOT_REACHED}
        hx-request='{"timeout":10000}'
        class="flex flex-wrap items-center gap-12"
      >
        <input type="hidden" name="kind" value={opposite} />
        <Button
          type="submit"
          variant="ghost"
          data-busy-label="Sending…"
          {...(props.dispute ? { "data-focus-on-load": "" } : {})}
          {...(props.withdrawn ? { "data-focus": "" } : {})}
        >
          {PRESS_WORDS[opposite]}
        </Button>
        <span class="type-small text-muted">One press sends it. You can add a note after.</span>
      </form>
    </>
  );
  // Taken back: said once, then the closed control again, with focus on it where the Withdraw button was.
  return props.withdrawn ? (
    <div {...region}>
      <p role="status" data-withdrawn class="text-14">
        You took your feedback back.
      </p>
      {closed}
    </div>
  ) : (
    <div {...region}>{closed}</div>
  );
}
