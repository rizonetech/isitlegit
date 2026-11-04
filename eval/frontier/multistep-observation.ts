// Experiment diagnostics retain only finite categories, never content or arbitrary error text.
import { z } from "zod";
import { DriverDiagnostic } from "../../src/walkthrough/diagnostics.ts";

export const StageSchema = z.enum([
  "unknown",
  "case-creation",
  "canary",
  "browser-launch",
  "walk",
  "evidence-read",
  "browser-close",
]);
export const DiagnosticSchema = z.strictObject({
  stage: StageSchema,
  category: z.enum([
    "unknown",
    "none",
    "protocol-error",
    "timeout",
    "aborted",
    "runtime-error",
    "unclassified",
    "step-limit",
    "time-limit",
    "budget",
    "model-error",
    "model-refusal",
    "invalid-model-output",
    "empty-model-output",
    "policy-refusal",
  ]),
  source: z.enum(["unknown", "result", "exception"]),
});
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
export type ExecutionStage = z.infer<typeof StageSchema>;
export const UNKNOWN_DIAGNOSTIC: Diagnostic = { stage: "unknown", category: "unknown", source: "unknown" };

export function reasonCategory(reason: unknown): Diagnostic["category"] {
  // Exact allowlist only: even a plausible error name can contain a secret.
  const allowed: Record<string, Diagnostic["category"]> = {
    ProtocolError: "protocol-error",
    TimeoutError: "timeout",
    AbortError: "aborted",
    Error: "runtime-error",
    TypeError: "runtime-error",
    RangeError: "runtime-error",
    time: "time-limit",
    steps: "step-limit",
    cap: "budget",
    unavailable: "budget",
    "model: timeout": "timeout",
    "model: capacity": "model-error",
    "model: Error": "model-error",
    "model: network": "model-error",
    "model: http": "model-error",
    "the model refused": "model-refusal",
    "the response could not be read": "invalid-model-output",
    "a function call could not be read": "invalid-model-output",
    "a message could not be read": "invalid-model-output",
    "no text": "empty-model-output",
    "the model's final message": "none",
  };
  return typeof reason === "string" && Object.hasOwn(allowed, reason)
    ? (allowed[reason] ?? "unclassified")
    : "unclassified";
}
export function exceptionDiagnostic(stage: ExecutionStage, error: unknown): Diagnostic {
  let category: Diagnostic["category"] = "unclassified";
  try {
    if (error instanceof Error) category = reasonCategory(error.name);
  } catch {
    /* No unsafe getter output. */
  }
  return DiagnosticSchema.parse({ stage, category, source: "exception" });
}
export function resultDiagnostic(stage: ExecutionStage, result: { outcome: string; reason?: string }): Diagnostic {
  const category = result.outcome === "finished" ? "none" : reasonCategory(result.reason);
  return DiagnosticSchema.parse({ stage, category, source: "result" });
}
export async function captureExecution<T extends { outcome: string; reason?: string }>(
  run: (at: <U>(stage: ExecutionStage, operation: () => Promise<U>) => Promise<U>) => Promise<T>,
): Promise<{ result?: T; diagnostic: Diagnostic }> {
  let stage: ExecutionStage = "unknown";
  try {
    const result = await run(async (next, operation) => {
      stage = next;
      return operation();
    });
    return { result, diagnostic: resultDiagnostic(stage, result) };
  } catch (error) {
    return { diagnostic: exceptionDiagnostic(stage, error) };
  }
}

// Read only the producer-selected terminal metadata, never raw reasons or later action rows.
export function terminalDriverDiagnostic(result: { diagnostic?: unknown } | undefined): DriverDiagnostic | undefined {
  try {
    if (result?.diagnostic === undefined) return undefined;
    return DriverDiagnostic.parse(result.diagnostic);
  } catch {
    throw new Error("invalid driver diagnostic");
  }
}
