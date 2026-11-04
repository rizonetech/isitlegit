import { z } from "zod";

// Static vocabulary only. None of these fields may be derived from a URL, request, model or page value.
export const DriverDiagnostic = z.strictObject({
  operation: z.enum([
    "setup.browser-session",
    "setup.discover-targets",
    "setup.interception",
    "setup.download-denial",
    "setup.new-page",
    "setup.viewport",
    "setup.service-worker-bypass",
    "setup.worker-guard",
    "setup.page-session",
    "setup.dom",
    "policy.start",
    "policy.request",
    "navigation.goto",
    "frames.read",
    "interception.request",
    "interception.fetch",
    "interception.body",
    "interception.fulfill",
    "containment.target",
    "containment.session",
    "containment.terminate",
    "containment.detach",
    "record.refusal",
    "view.screenshot",
    "view.read",
    "action",
  ]),
  category: z.enum(["error", "type", "timeout", "abort", "protocol", "target-closed", "unknown"]),
  networkCode: z
    .enum([
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ERR_CONNECTION_RESET",
      "ERR_CONNECTION_REFUSED",
      "ERR_NAME_NOT_RESOLVED",
      "ERR_TIMED_OUT",
      "ERR_CERT_AUTHORITY_INVALID",
      "ERR_FAILED",
      "ERR_BLOCKED_BY_CLIENT",
    ])
    .optional(),
});
export type DriverDiagnostic = z.infer<typeof DriverDiagnostic>;
export type DriverOperation = DriverDiagnostic["operation"];

const categories = new Map<string, DriverDiagnostic["category"]>([
  ["Error", "error"],
  ["TypeError", "type"],
  ["TimeoutError", "timeout"],
  ["AbortError", "abort"],
  ["ProtocolError", "protocol"],
  ["TargetCloseError", "target-closed"],
]);
function property(error: unknown, key: "name" | "code" | "message"): unknown {
  try {
    return typeof error === "object" && error !== null ? Reflect.get(error, key) : undefined;
  } catch {
    return undefined;
  }
}
export function driverDiagnostic(operation: DriverOperation, error: unknown): DriverDiagnostic {
  const name = property(error, "name");
  const category = typeof name === "string" ? (categories.get(name) ?? "unknown") : "unknown";
  const code = property(error, "code");
  const parsed = DriverDiagnostic.shape.networkCode.safeParse(code);
  let networkCode = parsed.success ? parsed.data : undefined;
  // Puppeteer reports Chromium navigation codes at the start of Error.message. Keep only a finite code, never the suffix.
  if (!networkCode && error instanceof Error) {
    const message = property(error, "message");
    const match = typeof message === "string" ? /^net::(ERR_[A-Z_]+)(?:\s|$)/.exec(message.slice(0, 80)) : null;
    const network = DriverDiagnostic.shape.networkCode.safeParse(match?.[1]);
    if (network.success) networkCode = network.data;
  }
  return DriverDiagnostic.parse({ operation, category, ...(networkCode ? { networkCode } : {}) });
}

export class DriverFailure extends Error {
  readonly diagnostic: DriverDiagnostic;
  constructor(operation: DriverOperation, error: unknown) {
    super("driver operation failed");
    this.diagnostic = driverDiagnostic(operation, error);
  }
}
// The closure owns attribution even when another browser callback fails concurrently. Never retain the raw cause.
export async function atOperation<T>(operation: DriverOperation, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw error instanceof DriverFailure ? error : new DriverFailure(operation, error);
  }
}
