import { env } from "cloudflare:test";
import { ExperimentArm } from "../../src/pipeline/ablate";
import { bindCaseExperiment, reserveExperiment } from "../../src/pipeline/case-experiments";

// Bind through the admission store while the synthetic case is still received.
export async function bindExperiment(caseId: string, arm: string, deployment = env.COMMIT_SHA) {
  const row = await env.DB.prepare("SELECT org_id FROM cases WHERE id=?").bind(caseId).first<{ org_id: string }>();
  if (!row) throw new Error("Synthetic case missing");
  const orgId = row.org_id;
  await env.DB.prepare('INSERT OR IGNORE INTO organization (id,name,slug,"createdAt") VALUES (?,?,?,?)')
    .bind(orgId, "Synthetic experiment", orgId, new Date().toISOString())
    .run();
  const id = crypto.randomUUID();
  const value = await reserveExperiment(
    { ...env, EVAL_ORG_ID: orgId, COMMIT_SHA: deployment },
    orgId,
    {
      experimentId: id,
      arm: ExperimentArm.parse(arm),
      manifestDigest: "b".repeat(64),
      deployment,
    },
    id,
  );
  await bindCaseExperiment(env.DB, caseId, orgId, value, `sha256:${caseId}`);
  return value;
}
