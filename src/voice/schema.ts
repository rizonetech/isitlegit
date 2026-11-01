// What the voice evidence reads out of a transcript (D01 T03 §4; spec 4.2a): the request, who the speaker says they are,
// how urgently, and any payment details, each with the words of the transcript it rests on. Written as `structured()`
// needs it (every property required, an absence a null), so Meta's strict schema subset takes it.
import { z } from "zod";

export const REQUESTS = ["pay", "change_bank_details", "share_code", "click_link", "other", "none"] as const;
export type Request = (typeof REQUESTS)[number];
export const URGENCIES = ["low", "medium", "high"] as const;
export const MAX_QUOTE = 200;
const Quote = z.string().max(MAX_QUOTE).nullable();
const Detail = (max: number) => z.string().min(1).max(max).nullable();

export const VoiceClaim = z.strictObject({
  request: z.enum(REQUESTS),
  request_quote: Quote,
  claimed_identity: z.string().min(1).max(120).nullable(),
  identity_quote: Quote,
  urgency: z.enum(URGENCIES),
  urgency_quote: Quote,
  payment_details: z
    .strictObject({
      amount: Detail(40),
      currency: Detail(20),
      account: Detail(40),
      beneficiary: Detail(80),
    })
    .nullable(),
});
export type VoiceClaim = z.infer<typeof VoiceClaim>;

// The claim as kept: each part only with support in the transcript's own words (./extract.ts).
export type PaymentDetails = {
  amount: string | null;
  currency: string | null;
  account: string | null;
  beneficiary: string | null;
};
export type VerifiedClaim = {
  request: Request;
  requestQuote: string | null;
  claimedIdentity: string | null;
  identityQuote: string | null;
  urgency: (typeof URGENCIES)[number];
  urgencyQuote: string | null;
  paymentDetails: PaymentDetails | null;
};

// What the checks step stores as `voice-claim.json` and the case view carries.
export type VoiceRead =
  | { state: "read"; claim: VerifiedClaim; dropped: number; complete: boolean }
  | { state: "silent" }
  | { state: "not_checked"; reason: string };

// The stored form, checked when it is read back: a file that is not this is no result (the step reads the case again).
const Details = z.strictObject({
  amount: z.string().nullable(),
  currency: z.string().nullable(),
  account: z.string().nullable(),
  beneficiary: z.string().nullable(),
});
const Verified = z.strictObject({
  request: z.enum(REQUESTS),
  requestQuote: z.string().nullable(),
  claimedIdentity: z.string().nullable(),
  identityQuote: z.string().nullable(),
  urgency: z.enum(URGENCIES),
  urgencyQuote: z.string().nullable(),
  paymentDetails: Details.nullable(),
});
export const StoredVoice = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("read"),
    claim: Verified,
    dropped: z.number().int().nonnegative(),
    complete: z.boolean(),
  }),
  z.strictObject({ state: z.literal("silent") }),
  z.strictObject({ state: z.literal("not_checked"), reason: z.string().min(1).max(200) }),
]);
