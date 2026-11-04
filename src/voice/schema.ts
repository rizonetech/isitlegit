// What the voice evidence reads out of a transcript (D01 T03 §4; spec 4.2a): the request, who the speaker says they are,
// how urgently, and any payment details, each with the words of the transcript it rests on. Written as `structured()`
// needs it (every property required, an absence a null), so Meta's strict schema subset takes it.
import { z } from "zod";
import { figuresOf, type PaymentFigures } from "./figures";

export const REQUESTS = ["pay", "change_bank_details", "share_code", "click_link", "other", "none"] as const;
export type Request = (typeof REQUESTS)[number];
export const URGENCIES = ["low", "medium", "high"] as const;
export const MAX_QUOTE = 200;
const Quote = z.string().max(MAX_QUOTE).nullable();

export const VoiceClaim = z.strictObject({
  request: z.enum(REQUESTS),
  request_quote: Quote,
  claimed_identity: z.string().min(1).max(120).nullable(),
  identity_quote: Quote,
  urgency: z.enum(URGENCIES),
  urgency_quote: Quote,
  // The sentence in which the speaker gives an amount, an account or a beneficiary, copied from the transcript, or null. The
  // figures themselves are not read out: the member reads them in the speaker's own words (D01 T03 §4's round 4).
  payment_quote: Quote,
});
export type VoiceClaim = z.infer<typeof VoiceClaim>;

// The claim as kept: each part only with support in the transcript's own words (./extract.ts).
export type VerifiedClaim = {
  request: Request;
  requestQuote: string | null;
  claimedIdentity: string | null;
  identityQuote: string | null;
  urgency: (typeof URGENCIES)[number];
  urgencyQuote: string | null;
  paymentQuote: string | null;
  paymentFigures?: PaymentFigures | undefined;
};

// What the checks step stores as `voice-claim.json` and the case view carries.
export type VoiceRead =
  // `cut`: the transcript was longer than the part the model was given (D01 T03 §4), so a request near its end may be missed.
  | {
      state: "read";
      claim: VerifiedClaim;
      dropped: number;
      complete: boolean;
      cut?: boolean | undefined;
      // Each recording's outcome, for a case with several (D01 T03 §5): the evidence names the ones not read.
      recordings?: { filename: string; outcome: string }[] | undefined;
    }
  | { state: "silent" }
  | {
      state: "not_checked";
      reason: string;
      // Each recording's outcome, when the case's recordings were named but none could be read (D01 T03 §5).
      recordings?: { filename: string; outcome: string }[] | undefined;
    };

// Derived fields never enter VoiceClaim's model-output schema. Validate their exact numeric
// reading again on storage read-back, including offsets, ordering and quote containment.
const FigureSchema = z
  .strictObject({
    kind: z.enum(["amount", "account"]),
    raw: z.string().min(1).max(2048),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    value: z.string().min(1).max(160),
    currency: z.string().max(10).nullable(),
  })
  .superRefine((f, ctx) => {
    const parsed = figuresOf(f.raw);
    if (
      f.end - f.start !== f.raw.length ||
      parsed.length !== 1 ||
      parsed[0]?.start !== 0 ||
      parsed[0]?.end !== f.raw.length ||
      parsed[0]?.kind !== f.kind ||
      parsed[0]?.value !== f.value ||
      parsed[0]?.currency !== f.currency
    )
      ctx.addIssue({ code: "custom", message: "An exact whole-source figure" });
  });
const PaymentFiguresSchema = z
  .strictObject({
    quoteStart: z.number().int().nonnegative(),
    quoteEnd: z.number().int().nonnegative(),
    items: z.array(FigureSchema).max(100),
  })
  .superRefine((p, ctx) => {
    let end = p.quoteStart;
    if (p.quoteEnd <= p.quoteStart) ctx.addIssue({ code: "custom", message: "A nonempty quote span" });
    for (const f of p.items) {
      if (f.start < end || f.end > p.quoteEnd)
        ctx.addIssue({ code: "custom", message: "Ordered whole figures inside the quote span" });
      end = f.end;
    }
  });
const normalizedQuote = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// The stored form, checked when it is read back: a file that is not this is no result (the step reads the case again).
const Verified = z
  .strictObject({
    request: z.enum(REQUESTS),
    requestQuote: z.string().nullable(),
    claimedIdentity: z.string().nullable(),
    identityQuote: z.string().nullable(),
    urgency: z.enum(URGENCIES),
    urgencyQuote: z.string().nullable(),
    paymentQuote: z.string().nullable(),
    paymentFigures: PaymentFiguresSchema.optional(),
  })
  .superRefine((claim, ctx) => {
    if (
      claim.paymentFigures &&
      (!claim.paymentQuote ||
        claim.paymentFigures.items.some(
          (f) => !normalizedQuote(claim.paymentQuote ?? "").includes(normalizedQuote(f.raw)),
        ))
    )
      ctx.addIssue({ code: "custom", message: "Derived figures require their supported payment quote" });
  });
export const StoredVoice = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("read"),
    claim: Verified,
    dropped: z.number().int().nonnegative(),
    complete: z.boolean(),
    cut: z.boolean().optional(),
    recordings: z.array(z.strictObject({ filename: z.string().max(200), outcome: z.string().max(40) })).optional(),
  }),
  z.strictObject({ state: z.literal("silent") }),
  z.strictObject({
    state: z.literal("not_checked"),
    reason: z.string().min(1).max(200),
    recordings: z.array(z.strictObject({ filename: z.string().max(200), outcome: z.string().max(40) })).optional(),
  }),
]);
