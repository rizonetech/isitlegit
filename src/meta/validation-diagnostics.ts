import { z } from "zod";

export const DiagnosticSegment = z.enum([
  "verdict",
  "confidence",
  "headline",
  "explanation",
  "cited_evidence_ids",
  "recommended_actions",
  "meaning",
  "*",
]);
export const ValidationIssue = z.strictObject({
  category: z.enum([
    "json_invalid",
    "unknown_property",
    "schema_invalid",
    "no_citations",
    "unknown_evidence_id",
    "undeclared_marker",
    "unused_declared_id",
    "sentence_without_marker",
  ]),
  path: z.array(DiagnosticSegment).max(6),
});
export const ValidationDiagnostic = z
  .strictObject({
    phase: z.enum(["structured", "citation"]),
    callId: z.uuid(),
    attempt: z.number().int().min(1).max(2),
    remaining: z.number().int().min(0).max(1),
    issues: z.array(ValidationIssue).min(1).max(4),
  })
  .superRefine((d, ctx) => {
    if (d.remaining !== 2 - d.attempt) ctx.addIssue({ code: "custom", message: "invalid budget" });
    const structured = new Set(["json_invalid", "unknown_property", "schema_invalid"]);
    if (d.issues.some((i) => structured.has(i.category) !== (d.phase === "structured")))
      ctx.addIssue({ code: "custom", message: "invalid phase" });
  });
export type ValidationDiagnostic = z.infer<typeof ValidationDiagnostic>;
export type ValidationIssue = z.infer<typeof ValidationIssue>;
export type DiagnosticCallback = (diagnostic: ValidationDiagnostic) => Promise<unknown>;

// Diagnostics never throw into verdict selection. No exception text or payload is logged.
export async function deliverValidationDiagnostic(
  callback: DiagnosticCallback | undefined,
  diagnostic: ValidationDiagnostic,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<void> {
  if (!callback) return;
  const written = Promise.resolve()
    .then(() => callback(ValidationDiagnostic.parse(diagnostic)))
    .then(
      () => true,
      () => {
        console.error("diagnostic-write-failed");
        return true;
      },
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), 25);
  });
  if (!(await Promise.race([written, late]).finally(() => clearTimeout(timer)))) {
    try {
      waitUntil(written);
    } catch {
      console.error("diagnostic-write-failed");
    }
    console.error("diagnostic-write-late");
  }
}
