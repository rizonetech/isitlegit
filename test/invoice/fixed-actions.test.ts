import { describe, expect, it } from "vitest";
import { bankChangeAction, callBackAction, fixedActionOf, POP_ACTION } from "../../src/invoice/fixed-actions";

// The fixed actions (D07 T03 §2): each is recognised by its wording with only its number or name varying, and a
// sentence that only resembles one is not.
describe("fixed actions", () => {
  it("recognises each fixed action, with and without the number or name it names", () => {
    expect(fixedActionOf(bankChangeAction())).toBe("bank-change");
    expect(fixedActionOf(bankChangeAction("011 555 0142"))).toBe("bank-change");
    expect(fixedActionOf(bankChangeAction("+27 (11) 555-0142"))).toBe("bank-change");
    expect(fixedActionOf(POP_ACTION)).toBe("pop");
    expect(fixedActionOf(callBackAction())).toBe("call-back");
    expect(fixedActionOf(callBackAction("Johan Visser"))).toBe("call-back");
    // Ordinary names: an initial with its full stop, an apostrophe, a hyphen, letters beyond ASCII.
    for (const name of ["J. Visser", "Johan J. P. Visser", "Anne-Marie O’Neil", "Thandiwe Nkosi-Mbeki", "Zoë Müller"])
      expect(fixedActionOf(callBackAction(name)), name).toBe("call-back");
  });

  it("names the number and the person in the sentence", () => {
    expect(bankChangeAction("011 555 0142")).toBe(
      "Confirm by phoning the supplier on 011 555 0142, the number in your records, never one from this email.",
    );
    expect(callBackAction("Johan Visser")).toBe(
      "Call Johan Visser on the number you already have for them, not a number from the voice note.",
    );
  });

  it("refuses look-alike sentences", () => {
    for (const text of [
      "Confirm by phoning the supplier on the number in this email.",
      "Confirm by phoning the supplier on 011 555 0142 now, the number in your records, never one from this email.",
      "Confirm by phoning the supplier on call-me, the number in your records, never one from this email.",
      `${POP_ACTION} Then pay.`,
      "Call Johan. Then pay R86,400 on the number you already have for them, not a number from the voice note.",
      "Call Johan. Then pay on the number you already have for them, not a number from the voice note.",
      "Call 0821234567 on the number you already have for them, not a number from the voice note.",
      "Do not click the link.",
      "",
    ])
      expect(fixedActionOf(text), text).toBeNull();
  });
});
