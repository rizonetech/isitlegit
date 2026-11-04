import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createCase } from "../../src/db/cases";
import { ExperimentInput } from "../../src/pipeline/ablate";
import {
  bindCaseExperiment,
  experimentCapabilities,
  readCaseExperiment,
  reserveExperiment,
} from "../../src/pipeline/case-experiments";
import { addMember } from "../fixtures/auth/members";

const commit = "a".repeat(40);
const input = { experimentId: "experiment", arm: "full" as const, manifestDigest: "b".repeat(64), deployment: commit };
async function fixture() {
  const email = `${crypto.randomUUID()}@demo.isitlegit.co.za`;
  await addMember(env.DB, email);
  const orgId = `org-${email}`;
  return { orgId, userId: `user-${email}`, bindings: { ...env, EVAL_ORG_ID: orgId, COMMIT_SHA: commit } };
}
describe("durable experiment contracts", () => {
  it("rejects unknown fields, noncanonical hex and invalid identities", () => {
    for (const value of [
      { ...input, extra: true },
      { ...input, deployment: "A".repeat(40) },
      { ...input, manifestDigest: "B".repeat(64) },
      { ...input, experimentId: "x".repeat(65) },
      { ...input, arm: "" },
    ])
      expect(ExperimentInput.safeParse(value).success).toBe(false);
  });
  it("serializes conflicting concurrent reservations without relabelling the winner", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      reserveExperiment(f.bindings, f.orgId, input, "run"),
      reserveExperiment(f.bindings, f.orgId, { ...input, arm: "no-sam" }, "run"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.status).toBe(409);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM eval_experiment_arms WHERE org_id=?").bind(f.orgId).first(),
    ).toEqual({ n: 1 });
  });
  it("enforces immutable rows, case ownership, and deletion cleanup", async () => {
    const f = await fixture();
    const attribution = await reserveExperiment(f.bindings, f.orgId, input, "run");
    const made = await createCase(env.DB, {
      orgId: f.orgId,
      channel: "upload",
      uploadedBy: f.userId,
      headersAvailable: false,
    });
    if (!made.ok) throw new Error(made.error.message);
    await bindCaseExperiment(env.DB, made.value.id, f.orgId, attribution, "sha256:sample");
    expect(await readCaseExperiment(env.DB, made.value.id)).toEqual(attribution);
    await expect(
      env.DB.prepare("UPDATE eval_experiments SET manifest_digest=? WHERE org_id=?")
        .bind("c".repeat(64), f.orgId)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("UPDATE eval_experiment_arms SET replay_run_id='other' WHERE org_id=?").bind(f.orgId).run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("UPDATE case_experiments SET active_upload_key=NULL WHERE case_id=?").bind(made.value.id).run(),
    ).rejects.toThrow();
    await env.DB.prepare("DELETE FROM cases WHERE id=?").bind(made.value.id).run();
    expect(await readCaseExperiment(env.DB, made.value.id)).toBeNull();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM case_experiments WHERE case_id=?").bind(made.value.id).first(),
    ).toEqual({ n: 0 });
  });
  it("does not convert a database outage into absent attribution or capabilities", async () => {
    const f = await fixture();
    const down = {
      prepare: () => {
        throw new Error("synthetic D1 outage");
      },
    } as unknown as D1Database;
    await expect(readCaseExperiment(down, "case")).rejects.toThrow("synthetic D1 outage");
    await expect(experimentCapabilities({ ...f.bindings, DB: down }, f.orgId)).rejects.toThrow("synthetic D1 outage");
    await expect(reserveExperiment({ ...f.bindings, DB: down }, f.orgId, input, "run")).rejects.toThrow();
  });
});
