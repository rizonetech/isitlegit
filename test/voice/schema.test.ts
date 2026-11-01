import { describe, expect, it } from "vitest";
import { formatSchema } from "../../src/meta/structured";
import { VoiceClaim } from "../../src/voice/schema";

// D01 T03 §4: the claim the voice evidence reads, in the shape `structured()` needs.
const GOOD = {
  request: "pay",
  request_quote: "please pay the supplier today",
  claimed_identity: "Thandi from Karoo Parts",
  identity_quote: "this is Thandi from Karoo Parts",
  urgency: "high",
  urgency_quote: "it must be done today",
  payment_quote: "into account 1234 5678 90 at Kestrel Bank",
};

describe("VoiceClaim", () => {
  it("parses a valid claim, with and without a payment sentence, and one that says nothing", () => {
    expect(VoiceClaim.parse(GOOD)).toEqual(GOOD);
    expect(VoiceClaim.parse({ ...GOOD, payment_quote: null }).payment_quote).toBeNull();
    expect(
      VoiceClaim.parse({
        request: "none",
        request_quote: null,
        claimed_identity: null,
        identity_quote: null,
        urgency: "low",
        urgency_quote: null,
        payment_quote: null,
      }).request,
    ).toBe("none");
  });

  it("refuses every field out of range, a missing one and an extra one", () => {
    const bad: Record<string, unknown>[] = [
      { ...GOOD, request: "send_money" },
      { ...GOOD, urgency: "urgent" },
      { ...GOOD, request_quote: "x".repeat(201) },
      { ...GOOD, claimed_identity: "" },
      { ...GOOD, claimed_identity: "x".repeat(121) },
      { ...GOOD, payment_quote: "x".repeat(201) },
      { ...GOOD, payment_quote: 5 },
      { ...GOOD, extra: true },
    ];
    for (const [i, claim] of bad.entries()) expect(VoiceClaim.safeParse(claim).success, String(i)).toBe(false);
    const { request: _request, ...missing } = GOOD;
    expect(VoiceClaim.safeParse(missing).success).toBe(false);
  });

  it("is a schema `structured()` accepts: every property required, no recursion", () => {
    const json = formatSchema(VoiceClaim) as { required: string[]; properties: Record<string, unknown> };
    expect(json.required.sort()).toEqual(Object.keys(GOOD).sort());
    expect(JSON.stringify(json)).not.toContain("$ref");
  });
});
