import { z } from "zod";
import { ulid } from "../db/ulid";
import { Arm, Manifest, manifestDigest, Trigger } from "./ablation-manifest";

export class MonitorIdentityConflict extends Error {
  constructor() {
    super("monitor experiment identity conflict");
    this.name = "MonitorIdentityConflict";
  }
}
const Status = z.enum(["pending", "running", "waiting", "unknown", "complete", "failed"]);
const Identity = z.strictObject({
  orgId: z.string(),
  experimentId: z.string(),
  arm: Arm,
  replayRunId: z.string(),
  monitorRunId: z.string(),
  status: Status,
  manifestDigest: z.string(),
  deployment: z.string(),
});
const PageIdentity = z.strictObject({
  experimentCaseId: z.string(),
  pageId: z.string(),
  captureDigest: z.string(),
  labelDigest: z.string(),
  pageOperationId: z.string(),
  status: Status,
});
export type StoredExperiment = z.infer<typeof Identity> & { pages: z.infer<typeof PageIdentity>[] };

export async function readExperiment(
  db: D1Database,
  orgId: string,
  monitorRunId: string,
): Promise<StoredExperiment | null> {
  const row = await db
    .prepare(
      `SELECT a.org_id AS orgId,a.experiment_id AS experimentId,a.arm,a.replay_run_id AS replayRunId,a.monitor_run_id AS monitorRunId,a.status,e.manifest_digest AS manifestDigest,e.deployment FROM monitor_experiment_arms a JOIN monitor_experiments e ON e.org_id=a.org_id AND e.experiment_id=a.experiment_id WHERE a.org_id=? AND a.monitor_run_id=?`,
    )
    .bind(orgId, monitorRunId)
    .first();
  if (!row) return null;
  const identity = Identity.parse(row);
  const result = await db
    .prepare(
      `SELECT r.experiment_case_id AS experimentCaseId,p.page_id AS pageId,p.capture_digest AS captureDigest,p.label_digest AS labelDigest,r.page_operation_id AS pageOperationId,r.status FROM monitor_experiment_results r JOIN monitor_experiment_pages p ON p.org_id=r.org_id AND p.experiment_id=r.experiment_id AND p.experiment_case_id=r.experiment_case_id WHERE r.org_id=? AND r.monitor_run_id=? ORDER BY p.rowid`,
    )
    .bind(orgId, monitorRunId)
    .all();
  return { ...identity, pages: result.results.map((r) => PageIdentity.parse(r)) };
}

// A D1 batch is one transaction. A conflicting immutable identity aborts every insertion, including new experiment rows.
export async function admitExperiment(
  db: D1Database,
  orgId: string,
  input: unknown,
  value: unknown,
): Promise<StoredExperiment> {
  z.string().min(1).max(128).parse(orgId);
  const request = Trigger.parse(input);
  const manifest = Manifest.parse(value);
  if (manifest.deployment !== request.deployment || (await manifestDigest(manifest)) !== request.manifestDigest)
    throw new MonitorIdentityConflict();
  const runId = ulid();
  const batch = [
    db
      .prepare(
        `INSERT INTO monitor_experiments(org_id,experiment_id,manifest_digest,deployment) VALUES(?,?,?,?) ON CONFLICT(org_id,experiment_id) DO UPDATE SET manifest_digest=excluded.manifest_digest,deployment=excluded.deployment WHERE manifest_digest!=excluded.manifest_digest OR deployment!=excluded.deployment`,
      )
      .bind(orgId, request.experimentId, request.manifestDigest, request.deployment),
  ];
  for (const page of manifest.pages)
    batch.push(
      db
        .prepare(
          `INSERT INTO monitor_experiment_pages(org_id,experiment_id,experiment_case_id,page_id,capture_digest,label_digest) VALUES(?,?,?,?,?,?) ON CONFLICT(org_id,experiment_id,experiment_case_id) DO UPDATE SET page_id=excluded.page_id,capture_digest=excluded.capture_digest,label_digest=excluded.label_digest WHERE page_id!=excluded.page_id OR capture_digest!=excluded.capture_digest OR label_digest!=excluded.label_digest`,
        )
        .bind(orgId, request.experimentId, page.experimentCaseId, page.pageId, page.captureDigest, page.labelDigest),
    );
  batch.push(
    db
      .prepare(
        `INSERT INTO monitor_experiment_arms(org_id,experiment_id,arm,replay_run_id,monitor_run_id,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(org_id,experiment_id,arm) DO UPDATE SET replay_run_id=excluded.replay_run_id WHERE replay_run_id!=excluded.replay_run_id`,
      )
      .bind(orgId, request.experimentId, request.arm, request.replayRunId, runId, Date.now()),
  );
  for (const page of manifest.pages)
    batch.push(
      db
        .prepare(
          `INSERT INTO monitor_experiment_results(org_id,experiment_id,arm,monitor_run_id,experiment_case_id,page_operation_id) SELECT org_id,experiment_id,arm,monitor_run_id,?,? FROM monitor_experiment_arms WHERE org_id=? AND experiment_id=? AND arm=? ON CONFLICT(org_id,experiment_id,arm,experiment_case_id) DO NOTHING`,
        )
        .bind(page.experimentCaseId, ulid(), orgId, request.experimentId, request.arm),
    );
  try {
    await db.batch(batch);
  } catch (error) {
    // Only actual immutable/uniqueness violations are conflicts. Outages must remain unavailable, never a false409.
    if (error instanceof Error && /immutable monitor|UNIQUE constraint failed: monitor_experiment/.test(error.message))
      throw new MonitorIdentityConflict();
    throw error;
  }
  const arm = await db
    .prepare("SELECT monitor_run_id FROM monitor_experiment_arms WHERE org_id=? AND experiment_id=? AND arm=?")
    .bind(orgId, request.experimentId, request.arm)
    .first<{ monitor_run_id: string }>();
  if (!arm) throw new Error("monitor experiment admission unavailable");
  const stored = await readExperiment(db, orgId, arm.monitor_run_id);
  if (!stored || stored.pages.length !== manifest.pages.length)
    throw new Error("monitor experiment admission unavailable");
  return stored;
}
