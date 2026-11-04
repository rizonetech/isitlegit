// Read-only scoring of the runner's existing durable population and arm identities.
import { ABLATE_FLAGS, armContext, type ExperimentManifest, loadExperiment, sameExperiment } from "./ablate.ts";
import type { Db, ModelUse, ResultRow, RunRow } from "./run.ts";
import { sampleUploadKey } from "./run.ts";
import { type RunSample, selectSamples } from "./run-core.ts";

export type ExperimentReader = Pick<Db, "readRun" | "caseExperiment" | "modelUse">;
type Stored = { run: RunRow; results: ResultRow[] };
export function experimentSelection(file: string, dir: string, stored: Stored) {
  const manifest = loadExperiment(file);
  const pools = manifest.sets.map((set) => {
    const pool = selectSamples(dir, [set]);
    if (pool.setVersion !== manifest.setVersions[set]) throw new Error(`experiment dataset changed: ${set}`);
    return pool.samples;
  });
  const byId = new Map(pools.flat().map((sample) => [sample.id, sample]));
  const samples = manifest.ids.map((id) => {
    const sample = byId.get(id);
    if (!sample) throw new Error(`experiment sample missing: ${id}`);
    return sample;
  });
  checkIdentity(manifest, stored, samples);
  return { manifest, samples, setVersion: manifest.manifestDigest };
}
function checkIdentity(m: ExperimentManifest, stored: Stored, samples: RunSample[]) {
  const { run, results } = stored;
  const arm = m.arms.find((a) => a.replayRunId === run.id);
  if (
    !arm ||
    run.mode !== `ablate:${arm.flag}` ||
    run.setVersion !== m.manifestDigest ||
    run.commitSha !== m.deployment ||
    run.capUsd !== arm.capUsd ||
    run.selected !== m.ids.length ||
    run.sampleLimit !== null ||
    run.sets.join() !== m.sets.join()
  )
    throw new Error("experiment arm identity/population/cap mismatch");
  const byId = new Map(samples.map((s) => [s.id, s]));
  if (new Set(results.map((r) => r.sample)).size !== results.length) throw new Error("duplicate experiment result");
  for (const row of results) {
    const sample = byId.get(row.sample);
    if (!sample || row.runId !== run.id || row.label !== sample.label || row.category !== sample.category)
      throw new Error("experiment result population/label mismatch");
  }
  return arm;
}
const exercised = (flag: string, use: ModelUse) =>
  use.state === "settled" &&
  use.outcome === "ok" &&
  use.cache === null &&
  (flag === "no-agent-reasoning"
    ? use.model === "muse-spark-1.3" && use.step === "verdict"
    : ABLATE_FLAGS[flag as keyof typeof ABLATE_FLAGS]?.includes(use.model as never));

export async function verifyExperimentPublication(
  m: ExperimentManifest,
  samples: RunSample[],
  stored: Stored,
  db: ExperimentReader,
  verify: (id: string) => Promise<{ ok: boolean; problems: string[] }>,
) {
  if (!db.caseExperiment || !db.modelUse)
    throw new Error("experiment publication needs durable attribution and model-use readers");
  const readAttribution = db.caseExperiment;
  const readUses = db.modelUse;
  const check = async (value: Stored) => {
    const arm = checkIdentity(m, value, samples);
    if (
      value.run.status !== "complete" ||
      value.results.length !== samples.length ||
      value.results.some((r) => !r.caseId || !["done", "partial"].includes(r.outcome) || r.verdict === null)
    )
      throw new Error("experiment arm incomplete or not measured");
    const verified = await verify(value.run.id);
    if (!verified.ok) throw new Error(`experiment cases do not reconcile: ${verified.problems.join("; ")}`);
    const uses: ModelUse[] = [];
    for (const row of value.results) {
      const sample = samples.find((s) => s.id === row.sample);
      if (!sample || !row.caseId) throw new Error("experiment sample not measured");
      const binding = await readAttribution(row.caseId);
      if (
        !binding?.active ||
        binding.uploadKey !== sampleUploadKey(sample) ||
        !sameExperiment(binding.context, armContext(m, arm))
      )
        throw new Error("durable experiment attribution mismatch");
      uses.push(...(await readUses(row.caseId)));
    }
    return { arm, uses };
  };
  const current = await check(stored);
  const full = m.arms.find((a) => a.flag === "full");
  if (!full) throw new Error("experiment full baseline missing");
  if (current.arm.flag !== "full") {
    const baseline = await db.readRun(full.replayRunId);
    if (!baseline) throw new Error("experiment baseline not measured");
    const original = await check(baseline);
    if (!original.uses.some((u) => exercised(current.arm.flag, u)))
      throw new Error("removed model not measured in experiment baseline");
    if (current.uses.some((u) => exercised(current.arm.flag, u)))
      throw new Error("removed model still exercised in experiment arm");
  }
  return { baselineRunId: full.replayRunId };
}
