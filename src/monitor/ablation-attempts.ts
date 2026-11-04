// Durable transport claims. An interrupted send remains running/unknown and cannot acquire another attempt.
import { z } from "zod";
import { ulid } from "../db/ulid";
import { Digest, ExperimentId, sha256 } from "./ablation-manifest";

const Time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Context = z.strictObject({
  monitorRunId: ExperimentId,
  operationId: ExperimentId,
  phase: z.enum(["wake", "loupe", "screen", "second-look"]),
  ordinal: z.union([z.literal(1), z.literal(2)]),
  requestDigest: Digest,
  deadline: Time,
});
export type AttemptContext = z.infer<typeof Context>;
const Failure = z.strictObject({
  kind: z.enum(["capacity", "unknown", "failed"]),
  status: z.number().int().min(100).max(599).optional(),
  retryAfterMs: Time.optional(),
});
export class AttemptFailure extends Error {
  readonly failure: z.infer<typeof Failure>;
  constructor(value: z.infer<typeof Failure>) {
    super("monitor transport did not complete");
    this.name = "AttemptFailure";
    this.failure = Failure.parse(value);
  }
}
export class PendingAttempt extends Error {
  constructor(
    readonly state: "running" | "unknown" | "capacity" | "failed" | "expired" | "conflict",
    readonly nextEligibleAt: number | null = null,
  ) {
    super("monitor attempt unavailable");
    this.name = "PendingAttempt";
  }
}
const MINUTES = [2, 5, 10, 20, 30, 60, 120];
export function retryAt(now: number, index: number, retryAfterMs = 0, jitterMs = 1): number {
  Time.parse(now);
  Time.parse(retryAfterMs);
  z.number().int().min(0).max(52).parse(index);
  z.number().int().min(1).max(60_000).parse(jitterMs);
  const minutes = MINUTES[index] ?? 120 * 2 ** (index - 6);
  const eligible = now + Math.max(minutes * 60_000, retryAfterMs) + jitterMs;
  if (!Number.isSafeInteger(eligible)) throw new PendingAttempt("failed");
  return eligible;
}
const Row = z.object({
  attempt_id: ExperimentId,
  request_digest: Digest,
  status: z.enum(["running", "complete", "capacity", "unknown", "failed"]),
  retry_index: z.number().int().min(0).max(52),
  deadline: Time,
  next_eligible_at: Time.nullable(),
  metadata_json: z.string().nullable(),
});
export type AttemptHandle = { attemptId: string };
export async function attempt<S extends z.ZodType>(
  db: D1Database,
  raw: AttemptContext,
  schema: S,
  send: (handle: AttemptHandle) => Promise<z.infer<S>>,
  options: { now?: () => number; jitter?: () => number } = {},
): Promise<z.infer<S>> {
  const context = Context.parse(raw);
  const now = options.now ?? Date.now;
  // Bind validated result shape too, so changing a schema cannot reinterpret an old result as current success.
  const fingerprint = await sha256(
    new TextEncoder().encode(
      JSON.stringify({ request: context.requestDigest, schema: z.toJSONSchema(schema), deadline: context.deadline }),
    ),
  );
  const query = () =>
    db
      .prepare(
        `SELECT attempt_id,request_digest,status,retry_index,deadline,next_eligible_at,metadata_json FROM monitor_experiment_attempts WHERE monitor_run_id=? AND operation_id=? AND phase=? AND answer_ordinal=? ORDER BY retry_index DESC LIMIT 1`,
      )
      .bind(context.monitorRunId, context.operationId, context.phase, context.ordinal)
      .first();
  const latest = await query();
  const prior = latest ? Row.parse(latest) : null;
  if (prior && prior.request_digest !== fingerprint) throw new PendingAttempt("conflict");
  if (prior?.status === "complete") {
    try {
      const cached = z.strictObject({ value: z.unknown() }).parse(JSON.parse(prior.metadata_json ?? "null"));
      return schema.parse(cached.value);
    } catch {
      throw new PendingAttempt("conflict");
    }
  }
  if (prior && prior.status !== "capacity") throw new PendingAttempt(prior.status);
  const at = Time.parse(now());
  if (
    at >= context.deadline ||
    (prior?.next_eligible_at !== null &&
      prior?.next_eligible_at !== undefined &&
      prior.next_eligible_at >= context.deadline)
  )
    throw new PendingAttempt("expired", prior?.next_eligible_at ?? null);
  if (prior && (prior.next_eligible_at === null || at < prior.next_eligible_at))
    throw new PendingAttempt("capacity", prior.next_eligible_at);
  const retryIndex = prior ? prior.retry_index + 1 : 0;
  if (retryIndex > 52) throw new PendingAttempt("failed");
  const attemptId = ulid();
  const claimed = await db
    .prepare(
      `INSERT INTO monitor_experiment_attempts(attempt_id,monitor_run_id,operation_id,phase,answer_ordinal,retry_index,request_digest,status,started_at,deadline) SELECT ?,?,?,?,?,?,?,'running',?,? WHERE NOT EXISTS(SELECT 1 FROM monitor_experiment_attempts WHERE monitor_run_id=? AND operation_id=? AND phase=? AND answer_ordinal=? AND (status!='capacity' OR retry_index>=? OR next_eligible_at IS NULL OR next_eligible_at>?)) ON CONFLICT(monitor_run_id,operation_id,phase,answer_ordinal,retry_index) DO NOTHING`,
    )
    .bind(
      attemptId,
      context.monitorRunId,
      context.operationId,
      context.phase,
      context.ordinal,
      retryIndex,
      fingerprint,
      at,
      context.deadline,
      context.monitorRunId,
      context.operationId,
      context.phase,
      context.ordinal,
      retryIndex,
      at,
    )
    .run();
  if (claimed.meta.changes !== 1) throw new PendingAttempt("running");
  try {
    if (Time.parse(now()) >= context.deadline) throw new AttemptFailure({ kind: "failed" });
    // The immutable claim exists before the callback can reserve or send. Never call it for a cached/uncertain phase.
    const value = schema.parse(await send({ attemptId }));
    const metadata = JSON.stringify({ value });
    if (metadata.length > 16_384) throw new AttemptFailure({ kind: "failed" });
    const saved = await db
      .prepare(
        "UPDATE monitor_experiment_attempts SET status='complete',metadata_json=? WHERE attempt_id=? AND status='running'",
      )
      .bind(metadata, attemptId)
      .run();
    if (saved.meta.changes !== 1) throw new PendingAttempt("unknown");
    return value;
  } catch (error) {
    const failure = error instanceof AttemptFailure ? error.failure : { kind: "unknown" as const };
    const next =
      failure.kind === "capacity"
        ? retryAt(
            Time.parse(now()),
            retryIndex,
            failure.retryAfterMs ?? 0,
            options.jitter?.() ?? 1 + Math.floor(Math.random() * 1000),
          )
        : null;
    // Never persist an exception message, provider body, prompt, credential or caller-controlled property name.
    await db
      .prepare(
        "UPDATE monitor_experiment_attempts SET status=?,next_eligible_at=?,metadata_json=? WHERE attempt_id=? AND status='running'",
      )
      .bind(failure.kind, next, JSON.stringify(failure), attemptId)
      .run();
    throw new PendingAttempt(failure.kind, next);
  }
}
