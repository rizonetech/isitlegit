// The fixed actions (D07 T03 §2): the instructions a verdict always carries for a kind of case, worded once here so
// the checks that attach them (the bank-change rules, D06 T01 §3; the payment document path, D06 T02 §3; a voice
// note's verdict) and the report that draws them first under "Do this first" read the same sentence. A fixed action
// is recognised by its exact wording, with only the number or name it names in it varying, so a look-alike sentence
// from a model is never promoted.
export type FixedAction = "bank-change" | "pop" | "call-back";

// Spec 4.5: never a number from the message itself.
export function bankChangeAction(phone?: string): string {
  return phone
    ? `Confirm by phoning the supplier on ${phone}, the number in your records, never one from this email.`
    : "Confirm by phoning the supplier on the number in your records, never one from this email.";
}

// Spec 4.5a: a payment document can be shown likely altered, never proven paid.
export const POP_ACTION = "Confirm the money has cleared in your own banking app before releasing goods.";

// A voice note claiming to be someone the member knows (M3, `Report-Voice`).
export function callBackAction(name?: string): string {
  return `Call ${name ?? "them"} on the number you already have for them, not a number from the voice note.`;
}

const PHONE = "\\+?[0-9][0-9 ()-]{2,28}[0-9]";
const BANK_CHANGE = new RegExp(
  `^Confirm by phoning the supplier on (?:the number in your records|${PHONE}, the number in your records), never one from this email\\.$`,
);
const CALL_BACK =
  /^Call [^\s.,][^.]{0,119} on the number you already have for them, not a number from the voice note\.$/;

export function fixedActionOf(text: string): FixedAction | null {
  if (text === POP_ACTION) return "pop";
  if (BANK_CHANGE.test(text)) return "bank-change";
  if (CALL_BACK.test(text)) return "call-back";
  return null;
}
