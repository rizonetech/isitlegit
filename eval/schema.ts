// One label for every evaluation set (D08 T01 §1; spec 4.9): the file a case is made from, whether it is an attack or
// genuine mail, its category, the checks whose evidence an attack should raise, and where it came from.
import { z } from "zod";

export const CATEGORIES = [
  "credential-phishing",
  "bec-payment",
  "invoice-bank-change",
  "impersonation",
  "malware-attachment",
  "voice-lure",
  "genuine-business",
  "genuine-newsletter",
] as const;

// A path inside its set: relative, forward slashes, no `..` segment.
const SetPath = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (p) => !p.startsWith("/") && !/^[A-Za-z]:/.test(p) && !p.includes("\\"),
    "the path must be relative to its set",
  )
  .refine((p) => !p.split("/").includes(".."), "the path must stay inside its set")
  // One spelling per file: no empty or `.` segment, so `./a.eml` and `a//b.eml` cannot alias `a.eml` and `a/b.eml`.
  .refine(
    (p) => p.split("/").every((segment) => segment !== "" && segment !== "."),
    "the path must be written plainly",
  );

export const Label = z
  .strictObject({
    path: SetPath,
    label: z.enum(["attack", "genuine"]),
    category: z.enum(CATEGORIES),
    // The check names (e.g. `attachment.executable`) whose evidence an attack should raise.
    expected: z.array(z.string().regex(/^[a-z_]+\.[a-z_]+$/, "a check name")).max(20),
    source: z.string().min(1).max(200),
    // What finds the attack (D08 T01 §4): `checks`, the deterministic checks named in `expected` (the reading when
    // absent, which is never written into a loaded record); or `model`, a model reading the text, page or image, whose
    // evidence no check names yet, scored on the verdict alone (D08 T02 §2).
    basis: z.enum(["checks", "model"]).optional(),
  })
  .refine((l) => l.label === "genuine" || l.basis === "model" || l.expected.length > 0, {
    message: "an attack names the evidence it should raise",
    path: ["expected"],
  })
  .refine((l) => l.label === "attack" || l.basis !== "model", {
    message: "only an attack can rest on a model",
    path: ["basis"],
  })
  .refine((l) => l.label === "attack" || l.expected.length === 0, {
    message: "genuine mail raises no expected evidence",
    path: ["expected"],
  })
  .refine((l) => (l.label === "genuine") === l.category.startsWith("genuine-"), {
    message: "the category agrees with the label",
    path: ["category"],
  });
export type Label = z.infer<typeof Label>;

// One label's reading (D08 T01 §5): why it is what it is, from the message's own content, who read it and when, and
// the second reading by the pinned reviewer of another model family (`null` while awaited). A disputed reading keeps
// its resolution; a label whose dispute is not resolved leaves the set for `eval/pending/` with this record.
export const SecondReading = z.strictObject({
  reviewer: z.string().min(1).max(40),
  // `<findings file>#<heading>`: the review whose verdict this records.
  review: z.string().regex(/^docs\/reviews\/[\w./-]+\.md#.+$/, "a findings file and its heading"),
  verdict: z.enum(["agree", "disagree"]),
  note: z.string().max(400),
});
export const Annotation = z.strictObject({
  path: SetPath,
  rationale: z.string().min(20).max(400),
  reader: z.string().min(1).max(40),
  date: z.string().regex(/^\d{4}-\d\d-\d\d$/, "an ISO date"),
  second_reading: SecondReading.nullable(),
  // How a `disagree` was settled when the label stayed in its set (the label corrected, and why).
  resolution: z.string().min(20).max(400).nullable(),
});
export type Annotation = z.infer<typeof Annotation>;
