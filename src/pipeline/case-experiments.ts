// D01 T03 §17: immutable attribution admitted before raw storage or Workflow creation.
import { CaseExperiment, ExperimentId, ExperimentInput, UPLOAD_EXPERIMENT_ARMS } from "./ablate";

export class ExperimentRefused extends Error {
  override name = "ExperimentRefused";
  constructor(
    readonly status: 400 | 403 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}
type ExperimentEnv = Pick<Env, "DB" | "EVAL_ORG_ID" | "COMMIT_SHA">;
export function requireEval(env: ExperimentEnv, orgId: string): void {
  if (!env.EVAL_ORG_ID) throw new ExperimentRefused(503, "Experimental admission is disabled.");
  if (env.EVAL_ORG_ID !== orgId)
    throw new ExperimentRefused(403, "Experiments are restricted to the eval organisation.");
}
export function validateExperiment(env: ExperimentEnv, orgId: string, input: unknown, replay: unknown): CaseExperiment {
  requireEval(env, orgId);
  const parsed = ExperimentInput.safeParse(input);
  const run = ExperimentId.safeParse(replay);
  if (!parsed.success || !run.success)
    throw new ExperimentRefused(400, "The experiment metadata or replay identity is invalid.");
  if (parsed.data.deployment !== env.COMMIT_SHA)
    throw new ExperimentRefused(409, "The experiment deployment does not match this service.");
  return { ...parsed.data, replayRunId: run.data };
}
const SELECT = `SELECT e.experiment_id AS experimentId, a.arm, e.manifest_digest AS manifestDigest,
 e.deployment, a.replay_run_id AS replayRunId FROM eval_experiments e JOIN eval_experiment_arms a
 ON a.org_id=e.org_id AND a.experiment_id=e.experiment_id`;
export async function reserveExperiment(
  env: ExperimentEnv,
  orgId: string,
  input: unknown,
  replay: unknown,
): Promise<CaseExperiment> {
  const value = validateExperiment(env, orgId, input, replay);
  const prefix = `replay:${value.replayRunId}:`;
  const ordinary = await env.DB.prepare(`SELECT 1 FROM intake_messages WHERE org_id=? AND substr(message_key,1,?)=?
    AND NOT EXISTS (SELECT 1 FROM eval_experiment_arms WHERE org_id=? AND replay_run_id=?) LIMIT 1`)
    .bind(orgId, prefix.length, prefix, orgId, value.replayRunId)
    .first();
  if (ordinary) throw new ExperimentRefused(409, "This replay identity was already used without experiment metadata.");
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO eval_experiments (org_id,experiment_id,manifest_digest,deployment) VALUES (?,?,?,?) ON CONFLICT DO NOTHING",
    ).bind(orgId, value.experimentId, value.manifestDigest, value.deployment),
    env.DB.prepare(`INSERT INTO eval_experiment_arms (org_id,experiment_id,arm,replay_run_id)
      SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM eval_experiments WHERE org_id=? AND experiment_id=? AND manifest_digest=? AND deployment=?)
      AND (NOT EXISTS (SELECT 1 FROM intake_messages WHERE org_id=? AND substr(message_key,1,?)=?)
        OR EXISTS (SELECT 1 FROM eval_experiment_arms WHERE org_id=? AND replay_run_id=?))
      ON CONFLICT DO NOTHING`).bind(
      orgId,
      value.experimentId,
      value.arm,
      value.replayRunId,
      orgId,
      value.experimentId,
      value.manifestDigest,
      value.deployment,
      orgId,
      prefix.length,
      prefix,
      orgId,
      value.replayRunId,
    ),
  ]);
  const stored = await env.DB.prepare(`${SELECT} WHERE a.org_id=? AND a.replay_run_id=?`)
    .bind(orgId, value.replayRunId)
    .first();
  if (!stored || !sameExperiment(CaseExperiment.parse(stored), value))
    throw new ExperimentRefused(409, "This experiment or replay identity is already bound to different metadata.");
  return value;
}
export function sameExperiment(a: CaseExperiment, b: CaseExperiment): boolean {
  return (
    a.experimentId === b.experimentId &&
    a.arm === b.arm &&
    a.manifestDigest === b.manifestDigest &&
    a.deployment === b.deployment &&
    a.replayRunId === b.replayRunId
  );
}
export async function requireOrdinaryReplay(db: D1Database, orgId: string, replay: string): Promise<void> {
  if (
    await db
      .prepare("SELECT 1 FROM eval_experiment_arms WHERE org_id=? AND replay_run_id=?")
      .bind(orgId, replay)
      .first()
  )
    throw new ExperimentRefused(409, "This replay belongs to an experiment and requires its original metadata.");
}
export async function readCaseExperiment(
  db: D1Database,
  caseId: string,
  orgId?: string,
): Promise<CaseExperiment | null> {
  const row = await db
    .prepare(`${SELECT} JOIN case_experiments x ON x.org_id=a.org_id AND x.experiment_id=a.experiment_id AND x.arm=a.arm AND x.replay_run_id=a.replay_run_id
    JOIN cases c ON c.id=x.case_id AND c.org_id=x.org_id WHERE x.case_id=? ${orgId === undefined ? "" : "AND x.org_id=?"}`)
    .bind(...(orgId === undefined ? [caseId] : [caseId, orgId]))
    .first();
  return row ? CaseExperiment.parse(row) : null;
}
export async function activeExperimentCase(
  db: D1Database,
  orgId: string,
  value: CaseExperiment,
  uploadKey: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT x.case_id FROM case_experiments x JOIN cases c ON c.id=x.case_id AND c.org_id=x.org_id WHERE x.org_id=? AND x.replay_run_id=? AND x.active_upload_key=?",
    )
    .bind(orgId, value.replayRunId, uploadKey)
    .first<{ case_id: string }>();
  return row?.case_id ?? null;
}
export async function bindCaseExperiment(
  db: D1Database,
  caseId: string,
  orgId: string,
  value: CaseExperiment,
  uploadKey: string,
): Promise<void> {
  await db
    .prepare(`INSERT INTO case_experiments (case_id,org_id,experiment_id,arm,replay_run_id,upload_key,active_upload_key)
    SELECT id,org_id,?,?,?,?,? FROM cases WHERE id=? AND org_id=? AND status='received' ON CONFLICT DO NOTHING`)
    .bind(value.experimentId, value.arm, value.replayRunId, uploadKey, uploadKey, caseId, orgId)
    .run();
  const stored = await readCaseExperiment(db, caseId, orgId);
  const sample = await db
    .prepare("SELECT upload_key,active_upload_key FROM case_experiments WHERE case_id=? AND org_id=?")
    .bind(caseId, orgId)
    .first<{ upload_key: string; active_upload_key: string | null }>();
  if (
    !stored ||
    !sameExperiment(stored, value) ||
    sample?.upload_key !== uploadKey ||
    sample.active_upload_key !== uploadKey
  )
    throw new ExperimentRefused(409, "The case could not be bound to this experiment.");
}
export async function experimentCapabilities(env: ExperimentEnv, orgId: string) {
  requireEval(env, orgId);
  if (!/^[a-f0-9]{40}$/.test(env.COMMIT_SHA)) throw new ExperimentRefused(503, "The deployed commit is not available.");
  await env.DB.prepare(
    `${SELECT} JOIN case_experiments x ON x.org_id=a.org_id AND x.experiment_id=a.experiment_id AND x.arm=a.arm WHERE 0`,
  ).all();
  return {
    version: 1 as const,
    commit: env.COMMIT_SHA,
    durableContext: true as const,
    uploadArms: [...UPLOAD_EXPERIMENT_ARMS],
    screening: false as const,
  };
}
