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
  })
  .refine((l) => l.label === "genuine" || l.expected.length > 0, {
    message: "an attack names the evidence it should raise",
    path: ["expected"],
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
