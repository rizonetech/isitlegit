// Durable upload experiment orchestration. Live effects use the same injected clients as the regular eval runner.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inlineLong } from "../src/meta/budget-sql.ts";
import {
  ABLATE_FLAGS,
  type AblationArmReport,
  armContext,
  checkAblationManifest,
  createExperiment,
  type ExperimentManifest,
  loadExperiment,
  parseExperiment,
  requireCapabilities,
  sameExperiment,
  saveExperiment,
  selectAblationPopulation,
  writeAblationResults,
} from "./ablate.ts";
import type { AblateOptions } from "./ablate-run.ts";
import {
  type Api,
  boundedBy,
  type Db,
  type Env,
  liveApi,
  liveDb,
  type ModelUse,
  type ResultRow,
  type RunRow,
  runEval,
  sampleUploadKey,
  sha256,
  verifyRun,
} from "./run.ts";
import { type RunSample, selectSamples } from "./run-core.ts";

const ROOT = join(import.meta.dirname, "..");
type Population = { samples: RunSample[]; setVersions: Record<string, string> };
export type ExperimentDeps = {
  api: Api;
  db: Db;
  env: Env;
  stateDir: string;
  resultsDir: string;
  select: (sets: string[]) => Population;
  save?: typeof saveExperiment;
};
async function exclusive<T>(dir: string, work: () => Promise<T>): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const holder = spawn(
    "flock",
    [
      "-w",
      "2",
      "-E",
      "73",
      join(dir, ".lock"),
      process.execPath,
      "-e",
      'process.stdout.write("ready");process.stdin.resume();',
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = new Promise<void>((resolve) => holder.once("close", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    holder.once("error", reject);
    holder.once("exit", (code) =>
      reject(new Error(code === 73 ? "experiment already running" : `experiment lock failed (${code})`)),
    );
    holder.stdout.once("data", () => resolve());
  });
  try {
    return await work();
  } finally {
    holder.stdin.end();
    await closed;
  }
}
function selected(manifest: ExperimentManifest, population: Population): RunSample[] {
  const byId = new Map(population.samples.map((s) => [s.id, s]));
  return manifest.ids.map((id) => {
    const sample = byId.get(id);
    if (!sample) throw new Error(`selected sample missing: ${id}`);
    return sample;
  });
}
const isUse = (flag: string, use: ModelUse) =>
  use.state === "settled" &&
  use.outcome === "ok" &&
  use.cache === null &&
  (flag === "no-agent-reasoning"
    ? use.model === "muse-spark-1.3" && use.step === "verdict"
    : flag !== "full" &&
      flag !== "no-screening" &&
      ABLATE_FLAGS[flag as keyof typeof ABLATE_FLAGS]?.includes(use.model as never));
function median(values: number[]): number {
  const a = [...values].sort((x, y) => x - y);
  const i = Math.floor(a.length / 2);
  return a.length === 0 ? 0 : a.length % 2 ? (a[i] as number) : ((a[i - 1] as number) + (a[i] as number)) / 2;
}
async function readArm(
  deps: ExperimentDeps,
  m: ExperimentManifest,
  arm: ExperimentManifest["arms"][number],
  samples: RunSample[],
): Promise<{ stored: { run: RunRow; results: ResultRow[] }; uses: Map<string, ModelUse[]> }> {
  const stored = await deps.db.readRun(arm.replayRunId);
  if (!stored) throw new Error(`missing stored arm ${arm.replayRunId}`);
  const verified = await verifyRun(deps.db, arm.replayRunId);
  if (!verified.ok) throw new Error(`stored arm verification failed: ${verified.problems.join("; ")}`);
  const expectedMode = `ablate:${arm.flag}`;
  if (
    stored.run.id !== arm.replayRunId ||
    stored.run.mode !== expectedMode ||
    stored.run.commitSha !== m.deployment ||
    stored.run.setVersion !== m.manifestDigest ||
    stored.run.capUsd !== arm.capUsd ||
    stored.run.selected !== samples.length ||
    stored.run.sets.join() !== m.sets.join()
  )
    throw new Error("stored arm identity/population/cap mismatch");
  const byId = new Map(stored.results.map((r) => [r.sample, r]));
  if (byId.size !== stored.results.length || stored.results.some((r) => !m.ids.includes(r.sample)))
    throw new Error("duplicate or foreign stored sample");
  const uses = new Map<string, ModelUse[]>();
  for (const sample of samples) {
    const row = byId.get(sample.id);
    if (
      !row?.caseId ||
      row.runId !== arm.replayRunId ||
      row.label !== sample.label ||
      row.category !== sample.category ||
      !["done", "partial"].includes(row.outcome) ||
      row.verdict === null
    )
      throw new Error(`unmeasured arm sample: ${sample.id}`);
    const binding = await deps.db.caseExperiment?.(row.caseId);
    if (
      !binding?.active ||
      binding.uploadKey !== sampleUploadKey(sample) ||
      !sameExperiment(binding.context, armContext(m, arm))
    )
      throw new Error(`durable arm attribution mismatch: ${sample.id}`);
    const state = await deps.db.caseState(row.caseId);
    if (!state || state.verdict !== row.verdict || state.status !== row.outcome)
      throw new Error(`stored case changed: ${sample.id}`);
    if (!deps.db.modelUse) throw new Error("model-use reader unavailable");
    uses.set(sample.id, await deps.db.modelUse(row.caseId));
  }
  if (stored.run.status !== "complete" || byId.size !== samples.length)
    throw new Error("arm is incomplete; cannot publish");
  return { stored, uses };
}
function reports(
  m: ExperimentManifest,
  arm: ExperimentManifest["arms"][number],
  samples: RunSample[],
  rows: ResultRow[],
  baselineUses: Map<string, ModelUse[]>,
): AblationArmReport[] {
  return m.sets.map((set) => {
    const ids = new Set(samples.filter((s) => s.set === set).map((s) => s.id));
    const selectedRows = rows.filter((r) => ids.has(r.sample));
    const attacks = selectedRows.filter((r) => r.label === "attack"),
      genuine = selectedRows.filter((r) => r.label === "genuine");
    const measured =
      selectedRows.length === ids.size &&
      selectedRows.every((r) => r.verdict !== null) &&
      (arm.flag === "full" || [...ids].some((id) => (baselineUses.get(id) ?? []).some((u) => isUse(arm.flag, u))));
    return {
      arm: arm.flag,
      set,
      runId: arm.replayRunId,
      metrics: {
        verdictRows: attacks.length,
        detected: attacks.filter((r) => r.verdict === "suspicious" || r.verdict === "malicious").length,
        genuineRows: genuine.length,
        falsePositives: genuine.filter((r) => r.verdict === "suspicious" || r.verdict === "malicious").length,
        medianMs: median(selectedRows.flatMap((r) => (r.ms === null ? [] : [r.ms]))),
        costUsd: selectedRows.reduce((sum, r) => sum + r.costUsd, 0),
        measured,
      },
    };
  });
}
export async function runExperimentCommand(
  options: AblateOptions,
  environment: NodeJS.ProcessEnv,
  deps?: ExperimentDeps,
): Promise<number> {
  let d = deps;
  const log = (message: string) => (d ? d.env.log(message) : console.error(message));
  let manifest: ExperimentManifest | undefined;
  try {
    if (!options.resume && options.flags.includes("no-screening"))
      throw new Error("no-screening is not supported by uploads; monitor screening remains not measured");
    if (!d) {
      const cookie = environment.EVAL_SESSION_COOKIE;
      if (!cookie) throw new Error("EVAL_SESSION_COOKIE is required; retrieve the existing eval session securely");
      const { execute } = await import("../scripts/lib/meta-budget.ts");
      d = {
        api: liveApi(environment.EVAL_BASE_URL ?? "https://app.isitlegit.co.za", cookie),
        db: liveDb(environment.EVAL_ORG_NAME ?? "IsItLegit Eval", (s) => execute({ sql: inlineLong(s), params: [] })),
        env: {
          now: () => Date.now(),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          id: randomUUID,
          journalDir: join(ROOT, "build/eval-runs"),
          bytes: (file) => readFileSync(file),
          log: (line) => console.log(line),
          timeout: boundedBy,
          ticker: (ms, fn) => {
            const timer = setInterval(fn, ms);
            timer.unref();
            return () => clearInterval(timer);
          },
        },
        stateDir: join(ROOT, "build/eval-ablation"),
        resultsDir: join(ROOT, "eval"),
        select: (sets) => {
          const samples: RunSample[] = [];
          const setVersions: Record<string, string> = {};
          for (const set of sets) {
            const loaded = selectSamples(join(ROOT, "eval/sets"), [set]);
            samples.push(...loaded.samples);
            setVersions[set] = loaded.setVersion;
          }
          return { samples, setVersions };
        },
      };
    }
    const depsReady = d;
    const initial = options.resume ? loadExperiment(join(d.stateDir, options.resume, "manifest.json")) : null;
    if (initial && initial.experimentId !== options.resume)
      throw new Error("resume directory/experiment identity mismatch");
    const population = d.select(initial?.sets ?? options.sets);
    const deployment = await d.api.commit();
    if (initial) manifest = initial;
    else {
      const sets = options.sets;
      const ids = selectAblationPopulation(
        sets.map((name) => ({ name, samples: population.samples.filter((s) => s.set === name) })),
        { seed: options.seed, perSetAttacks: 10, perSetGenuine: 10 },
      );
      manifest = createExperiment(
        { seed: options.seed, sets, setVersions: population.setVersions, deployment, ids },
        options.flags,
        options.capUsd as number,
        d.env.id,
      );
    }
    const id = manifest.experimentId;
    log(`eval:ablate: experiment ${id}; recover: node eval/ablate-run.ts --resume ${id}`);
    return await exclusive(join(d.stateDir, id), async () => {
      let m = initial
        ? loadExperiment(join(depsReady.stateDir, id, "manifest.json"))
        : (manifest as ExperimentManifest);
      m = parseExperiment(m);
      checkAblationManifest(m, { setVersions: population.setVersions, deployment });
      if (!depsReady.api.capabilities || !depsReady.db.caseExperiment || !depsReady.db.modelUse)
        throw new Error("missing durable experiment clients");
      requireCapabilities(
        await depsReady.api.capabilities(),
        m.deployment,
        m.arms.map((a) => a.flag),
      );
      const user = await depsReady.api.whoami();
      const org = await depsReady.db.orgId();
      const memberships = user ? await depsReady.db.memberships(user) : [];
      if (!user || memberships.length !== 1 || memberships[0] !== org)
        throw new Error("session must belong to the eval organisation alone");
      const samples = selected(m, population);
      for (const sample of samples)
        if (sha256(depsReady.env.bytes(sample.file)) !== sample.sha256)
          throw new Error(`selected bytes changed: ${sample.id}`);
      const save = depsReady.save ?? saveExperiment;
      const dir = join(depsReady.stateDir, id);
      save(dir, m);
      log(
        `eval:ablate: ${samples.length} samples per arm, ${m.arms.length} arms; sum of stated caps US$${m.arms.reduce((sum, a) => sum + a.capUsd, 0).toFixed(2)}; shared accounting remains enforced`,
      );
      const allReports: AblationArmReport[] = [];
      let baselineUses = new Map<string, ModelUse[]>();
      for (let index = 0; index < m.arms.length; index++) {
        const arm = m.arms[index];
        if (!arm) throw new Error("arm missing");
        const stored = await depsReady.db.readRun(arm.replayRunId);
        if (
          !stored &&
          arm.runId === null &&
          arm.flag !== "full" &&
          ![...baselineUses.values()].some((uses) => uses.some((use) => isUse(arm.flag, use)))
        ) {
          arm.status = "not-measured";
          save(dir, m);
          allReports.push(...reports(m, arm, samples, [], baselineUses).map((report) => ({ ...report, runId: null })));
          log(`eval:ablate: ${arm.flag} not measured: baseline did not exercise this model; no arm upload`);
          continue;
        }
        if (arm.status === "complete" && !stored)
          throw new Error("completed arm record is unavailable; no replacement run authorized");
        if (
          stored &&
          (stored.run.commitSha !== m.deployment ||
            stored.run.setVersion !== m.manifestDigest ||
            stored.run.capUsd !== arm.capUsd ||
            stored.run.mode !== `ablate:${arm.flag}`)
        )
          throw new Error("stored arm identity conflict before resume");
        if (stored?.run.status !== "complete") {
          // The stable ID is persisted before dispatch. An ambiguous insert is read back on the next invocation.
          arm.runId = arm.replayRunId;
          arm.status = "pending";
          save(dir, m);
          const result = await runEval({
            samples,
            setVersion: m.manifestDigest,
            sets: m.sets,
            sampleLimit: null,
            options: { capUsd: arm.capUsd, dry: false },
            api: depsReady.api,
            db: depsReady.db,
            env: depsReady.env,
            ...(stored ? { resume: arm.replayRunId } : {}),
            mode: `ablate:${arm.flag}`,
            experiment: armContext(m, arm),
          });
          arm.status =
            result.status === "complete" ? "complete" : result.status === "aborted" ? "failed" : "incomplete";
          save(dir, m);
          if (result.status !== "complete") {
            for (const problem of result.problems) log(`eval:ablate: ${problem}`);
            return result.exit === 3 ? 3 : 2;
          }
        }
        let checked: Awaited<ReturnType<typeof readArm>>;
        try {
          checked = await readArm(depsReady, m, arm, samples);
        } catch (error) {
          arm.status = "incomplete";
          save(dir, m);
          throw error;
        }
        if (arm.flag === "full") baselineUses = checked.uses;
        else if ([...checked.uses.values()].some((uses) => uses.some((use) => isUse(arm.flag, use))))
          throw new Error(`removed model still executed in ${arm.flag}`);
        arm.runId = arm.replayRunId;
        arm.status = "complete";
        save(dir, m);
        allReports.push(...reports(m, arm, samples, checked.stored.results, baselineUses));
      }
      // Only a complete, comparable set is published; the writer preserves unrelated result sections.
      const path = writeAblationResults(depsReady.resultsDir, allReports, m);
      log(`eval:ablate: complete ${id}; ${path}; Loupe screening not measured by uploads`);
      return 0;
    });
  } catch (error) {
    log(
      `eval:ablate: ${error instanceof Error ? error.message : String(error)}; no later arm started${manifest ? `; recover: node eval/ablate-run.ts --resume ${manifest.experimentId}` : ""}`,
    );
    return 3;
  }
}
