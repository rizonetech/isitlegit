// Promote a gate-passing Loupe version onto its own dedicated deployment, and roll back (D03 T04 §32).
//
// Operator, 2026-10-31 23:44 SAST: Loupe 1.0 ships now, 1.1 and 1.2 come later, and replacing the deployed version must
// take minutes. The active version is one stored file (`src/vision/glimmer-active.json`) that `glimmer-caps.ts` derives
// every consumer from, so a promotion is this command plus the Worker deploy that carries the file.
//
//     node scripts/glimmer/deploy.ts promote <version>     the gate, the new deployment, a probe, then the active file
//     node scripts/glimmer/deploy.ts rollback              back to the recorded previous deployment, by the same checks
//
// Normal promotion requires the statistical gate against the verified active version. The exact operator-authorized
// submission/demo release below records that gate separately and requires a strict page smoke instead of a permission
// probe. Both paths verify deployment settings and preserve rollback. The active file is written last and read back.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { type Active, deploymentFor, modelNameOf, targetOf } from "../../src/vision/glimmer-caps.ts";
import { BrandFreePageAnswer } from "../../src/vision/page-screen.ts";
import { checkPriced, checkReadBack, type Deployment } from "./deploy.ts";

// Explicit operator release authorization is operational only. It never qualifies the independent-held-out gate.
export const OPERATIONAL_RELEASE_AUTHORIZATION = Object.freeze({
  decision: "OPERATOR-LOUPE11-OPERATIONAL-20261104",
  purpose: "submission-demo",
  version: "1.1",
  deployment: "isitlegit-loupe-1-1",
  previousVersion: "1.0",
  previousDeployment: "isitlegit-loupe",
  trainingJob: "ts-db85d8de82174aa6824b775ca6e40075",
  finalStep: 4524,
  outputModelSha256: "3a3d2ecf8ee9330cbe3b674bf848803712c7d4240a37053dfa8ae8a3b7f5935c",
} as const);
const OperationalAuthorization = z.strictObject(
  Object.fromEntries(Object.entries(OPERATIONAL_RELEASE_AUTHORIZATION).map(([key, value]) => [key, z.literal(value)])),
);
const OperationalSmokeSchema = z.strictObject({
  version: z.literal("1.1"),
  deployment: z.literal("isitlegit-loupe-1-1"),
  model: z.literal(
    "accounts/rizonetech/models/isitlegit-loupe-1-1#accounts/rizonetech/deployments/isitlegit-loupe-1-1",
  ),
  outputModelSha256: z.literal(OPERATIONAL_RELEASE_AUTHORIZATION.outputModelSha256),
  promptSha256: z.literal("c0de39473966340136e2ef543ae4c8141b1b612e32cbae3eb23864e6b38e0232"),
  providerRequestId: z
    .string()
    .min(1)
    .max(300)
    .refine((value) => value.trim() === value && value.trim().length > 0),
  reservationId: z
    .string()
    .min(1)
    .max(300)
    .refine((value) => value.trim() === value && value.trim().length > 0),
  observedAt: z.iso.datetime(),
  answer: BrandFreePageAnswer,
});
export type OperationalSmoke = z.infer<typeof OperationalSmokeSchema>;
export type OperationalRelease = {
  authorization: unknown;
  // The caller performs a genuine strict synthetic-page inference, with accounted provider/ledger identities.
  // A one-token permission completion is not a page-screening answer and cannot pass this contract.
  smoke(version: string, deployment: string): Promise<unknown>;
};
export type OperationalReleaseEvidence = {
  mode: "operator-authorized-operational";
  authorization: typeof OPERATIONAL_RELEASE_AUTHORIZATION;
  statisticalGate: Gate;
  statisticalQualification: false;
  smoke?: OperationalSmoke;
};

export type Gate = { verdict: "promote" | "keep" | "missing"; detail: string };
export type Client = {
  status(): Promise<Deployment | null>;
  ensure(version: string): Promise<{ created: boolean; deployment: Deployment }>;
  waitReady(): Promise<Deployment>;
};
export type Purpose = "promotion" | "rollback";
export type Deps = {
  operationalRelease?: OperationalRelease;
  activeFile: string;
  stateFile: string;
  gate(version: string, previous: string): Gate;
  deployments(deployment: string): Client;
  // One valid completion from the version's deployment, through the shared minutes ledger; throws when it does not get
  // one. Its minutes are charged in full beside any serving deployment's (the purpose says so to the ledger).
  probe(version: string, deployment: string, purpose: Purpose): Promise<unknown>;
  now?: () => Date;
  // Writes a JSON file; the default replaces it atomically and durably. Injected so a failed or corrupt write can be tested.
  write?: (file: string, value: unknown) => void;
};

// The budget the operator set for replacing a version: minutes. Recorded with the time each stage took; a provider that is
// slow fails no check and raises no cap, it shows as `within_budget: false`.
export const BUDGET_MINUTES = 7;
export type Timings = {
  prepare_ms: number;
  probe_ms: number;
  switch_ms: number;
  total_ms: number;
  budget_minutes: number;
  within_budget: boolean;
};
export type Promoted =
  | {
      outcome: "promoted";
      version: string;
      deployment: string;
      model: string;
      previous: Active["previous"];
      // What is switched here is the file in this checkout; the live Worker serves the previous version until a Worker
      // that carries the file is deployed.
      production: "not switched until the Worker is deployed";
      next: string;
      timings: Timings;
      releaseEvidence?: OperationalReleaseEvidence;
      journal?: string;
    }
  | { outcome: "refused"; detail: string; serving: string; next?: string }
  | { outcome: "failed"; detail: string; serving: string; journal?: string }
  | { outcome: "unresolved"; detail: string; recovery: string };

// The approved way to put the file into production (docs/operations.md): this lane cannot deploy the Worker.
export const WORKER_NEXT =
  "commit src/vision/glimmer-active.json and merge it to main; the build session deploys the Worker (docs/operations.md), " +
  "then `node scripts/smoke.ts https://isitlegit.derick-f5a.workers.dev --commit <deployed commit>`. Until that deploy " +
  "the live Worker still serves the previous version, so its deployment must stay up";

export function readActive(file: string): Active {
  let parsed: Partial<Active>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<Active>;
  } catch (error) {
    throw new Error(`the active-version file ${file} cannot be read (${(error as Error).message})`);
  }
  const link = (value: unknown) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { version?: unknown }).version === "string" &&
    typeof (value as { deployment?: unknown }).deployment === "string";
  if (!link(parsed) || !(parsed.previous === null || link(parsed.previous)))
    throw new Error(`the active-version file ${file} is damaged`);
  return parsed as Active;
}
// Replaced atomically and durably: the bytes and then the directory entry are flushed, so after a crash the file is the
// old one or the new one.
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w");
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  const folder = openSync(dirname(file), "r");
  try {
    fsyncSync(folder);
  } finally {
    closeSync(folder);
  }
}
// A promotion's own record, written before the first remote change: what was being switched, from what, and how it ended.
type State = {
  status: "promoting" | "failed" | "promoted" | "rolled-back";
  target: Active;
  previous: Active;
  at: string;
  detail?: string;
  releaseEvidence?: OperationalReleaseEvidence;
};
const readState = (file: string): State | null => {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as State;
  } catch {
    // A damaged record of a past attempt is not trusted and blocks nothing: the active file is the truth.
    return null;
  }
};
// The record before the first remote change must land (else nothing has changed and the promotion is refused); the
// records after it are best effort, and a failure to write one is reported, never allowed to hide what was switched.
const journal = (deps: Deps, state: State): string | null => {
  try {
    (deps.write ?? writeJson)(deps.stateFile, state);
    return null;
  } catch (error) {
    return `the promotion record ${deps.stateFile} could not be written (${(error as Error).message})`;
  }
};

const same = (a: Active, b: Active) => JSON.stringify(a) === JSON.stringify(b);
const recoveryFor = (file: string, active: Active) => `write ${JSON.stringify(active)} to ${file}`;

// Writes the active file, reads it back, and restores the previous one when the read-back does not show what was written.
// Never says the previous version is serving unless that was read back too.
function switchActive(deps: Deps, next: Active, previous: Active): Promoted | null {
  const write = deps.write ?? writeJson;
  try {
    write(deps.activeFile, next);
    if (same(readActive(deps.activeFile), next)) return null;
  } catch {
    // Fall through to the restore: whatever is on disk is not known to be `next`.
  }
  try {
    write(deps.activeFile, previous);
    if (same(readActive(deps.activeFile), previous))
      return {
        outcome: "failed",
        detail: "the active file did not read back as written, so the previous one was restored",
        serving: previous.version,
      };
  } catch {
    // Fall through: not restored.
  }
  return {
    outcome: "unresolved",
    detail: `the active file did not read back as written and the previous one could not be restored; which version is active is not known`,
    recovery: recoveryFor(deps.activeFile, previous),
  };
}

// The deployment a record names, read back: it exists, is not deleted or failed, and serves the version recorded for it.
async function verifyRecorded(deps: Deps, link: { version: string; deployment: string }): Promise<string | null> {
  const read = await deps.deployments(link.deployment).status();
  if (!read) return `${link.deployment} is not there`;
  if (read.state === "DELETED" || read.state === "DELETING" || read.state === "FAILED")
    return `${link.deployment} is ${read.state}`;
  if (read.baseModel !== modelNameOf(link.version))
    return `${link.deployment} serves ${read.baseModel ?? "an unknown model"}, but the record says ${modelNameOf(link.version)}`;
  return null;
}

const clock = (deps: { now?: () => Date }) => () => (deps.now ?? (() => new Date()))().getTime();
function timings(marks: { start: number; prepared: number; probed: number; switched: number }): Timings {
  const total = marks.switched - marks.start;
  return {
    prepare_ms: marks.prepared - marks.start,
    probe_ms: marks.probed - marks.prepared,
    switch_ms: marks.switched - marks.probed,
    total_ms: total,
    budget_minutes: BUDGET_MINUTES,
    within_budget: total <= BUDGET_MINUTES * 60_000,
  };
}

export async function promote(version: string, deps: Deps): Promise<Promoted> {
  try {
    modelNameOf(version);
    if (!/^[1-9]\d?\.\d{1,2}$/.test(version)) throw new TypeError(`version "${version}" is not like 1.1`);
  } catch (error) {
    return { outcome: "refused", detail: (error as Error).message, serving: "unknown" };
  }
  let active: Active;
  try {
    active = readActive(deps.activeFile);
  } catch (error) {
    return { outcome: "refused", detail: (error as Error).message, serving: "unknown" };
  }
  const serving = active.version;
  // An earlier attempt that was cut off after the active file was written: it is finished, and the target is active.
  const earlier = readState(deps.stateFile);
  if (earlier?.status === "promoting" && same(active, earlier.target))
    journal(deps, { ...earlier, status: "promoted", detail: "completed by a later run" });
  if (version === active.version)
    return {
      outcome: "refused",
      detail: `${version} is already the active version in this checkout`,
      serving,
      next: WORKER_NEXT,
    };
  if (deps.operationalRelease) {
    if (
      !OperationalAuthorization.safeParse(deps.operationalRelease.authorization).success ||
      typeof deps.operationalRelease.smoke !== "function" ||
      version !== "1.1" ||
      active.version !== "1.0" ||
      active.deployment !== "isitlegit-loupe"
    ) {
      return {
        outcome: "refused",
        detail: "operational release authorization does not match the exact allowed artifact and previous deployment",
        serving,
      };
    }
  }
  // Every refusal that needs no change comes first: the verified record, then the gate.
  const disagreement = await verifyRecorded(deps, active);
  if (disagreement)
    return { outcome: "refused", detail: `the active record disagrees with the deployment: ${disagreement}`, serving };
  const gate = deps.gate(version, active.version);
  if (!deps.operationalRelease && gate.verdict !== "promote")
    return { outcome: "refused", detail: `the gate: ${gate.detail}`, serving };

  const releaseEvidence: OperationalReleaseEvidence | undefined = deps.operationalRelease
    ? {
        mode: "operator-authorized-operational",
        authorization: OPERATIONAL_RELEASE_AUTHORIZATION,
        statisticalGate: gate,
        statisticalQualification: false,
      }
    : undefined;
  const evidence = () => (releaseEvidence ? { releaseEvidence } : {});
  const target: Active = {
    version,
    deployment: deploymentFor(version),
    previous: { version: active.version, deployment: active.deployment },
  };
  const now = clock(deps);
  const start = now();
  const at = new Date(start).toISOString();
  const opened = journal(deps, { status: "promoting", target, previous: active, at, ...evidence() });
  if (opened) return { outcome: "refused", detail: `${opened}; nothing was changed`, serving };
  const fail = (outcome: "refused" | "failed", detail: string): Promoted => {
    const lost = journal(deps, { status: "failed", target, previous: active, at, detail, ...evidence() });
    return outcome === "failed"
      ? { outcome, detail, serving, ...(lost ? { journal: lost } : {}) }
      : { outcome, detail: lost ? `${detail}; ${lost}` : detail, serving };
  };
  let prepared = start;
  let probed = start;
  try {
    const client = deps.deployments(target.deployment);
    await client.ensure(version);
    const ready = await client.waitReady();
    checkReadBack(ready, 1);
    checkPriced(ready, target.deployment);
    if (deps.operationalRelease && (ready.state !== "READY" || ready.baseModel !== modelNameOf(version))) {
      throw new Error("refused: operational deployment does not serve the exact authorized model in READY state");
    }
    prepared = now();
    if (deps.operationalRelease && releaseEvidence) {
      const smoke = OperationalSmokeSchema.parse(await deps.operationalRelease.smoke(version, target.deployment));
      const observedAt = Date.parse(smoke.observedAt);
      if (observedAt < start || observedAt > now())
        throw new Error("operational smoke is not from this promotion attempt");
      releaseEvidence.smoke = smoke;
      // Persist the genuine smoke and unresolved statistical qualification before changing the selector.
      const lost = journal(deps, { status: "promoting", target, previous: active, at, ...evidence() });
      if (lost) throw new Error(lost);
    } else {
      await deps.probe(version, target.deployment, "promotion");
    }
    probed = now();
  } catch (error) {
    const detail = (error as Error).message;
    return fail(detail.startsWith("refused:") ? "refused" : "failed", detail);
  }
  const switched = switchActive(deps, target, active);
  if (switched) {
    if (switched.outcome === "failed") return fail("failed", switched.detail);
    return switched;
  }
  // The switch has happened: a record that cannot be written is reported alongside it, never instead of it.
  const lost = journal(deps, { status: "promoted", target, previous: active, at, ...evidence() });
  return {
    outcome: "promoted",
    version,
    deployment: target.deployment,
    model: targetOf(version, target.deployment).model,
    previous: target.previous,
    production: "not switched until the Worker is deployed",
    next: WORKER_NEXT,
    timings: timings({ start, prepared, probed, switched: now() }),
    ...evidence(),
    ...(lost ? { journal: lost } : {}),
  };
}

// Back to the recorded previous deployment, which must still read back as that version and answer a completion. The
// forward gate does not apply: the operator found a problem with the active version and is returning to one that was
// verified.
export async function rollback(deps: Deps): Promise<Promoted> {
  let active: Active;
  try {
    active = readActive(deps.activeFile);
  } catch (error) {
    return { outcome: "refused", detail: (error as Error).message, serving: "unknown" };
  }
  const serving = active.version;
  const previous = active.previous;
  if (!previous) return { outcome: "refused", detail: "there is no recorded previous version to return to", serving };
  const problem = await verifyRecorded(deps, previous);
  if (problem)
    return { outcome: "refused", detail: `the previous deployment cannot be returned to: ${problem}`, serving };
  const back: Active = { version: previous.version, deployment: previous.deployment, previous: null };
  const now = clock(deps);
  const start = now();
  const at = new Date(start).toISOString();
  const opened = journal(deps, { status: "promoting", target: back, previous: active, at });
  if (opened) return { outcome: "refused", detail: `${opened}; nothing was changed`, serving };
  let prepared = start;
  let probed = start;
  try {
    const client = deps.deployments(previous.deployment);
    const ready = await client.waitReady();
    checkReadBack(ready, 1);
    checkPriced(ready, previous.deployment);
    prepared = now();
    await deps.probe(previous.version, previous.deployment, "rollback");
    probed = now();
  } catch (error) {
    const detail = (error as Error).message;
    const lost = journal(deps, { status: "failed", target: back, previous: active, at, detail });
    return detail.startsWith("refused:")
      ? { outcome: "refused", detail: lost ? `${detail}; ${lost}` : detail, serving }
      : { outcome: "failed", detail, serving, ...(lost ? { journal: lost } : {}) };
  }
  const switched = switchActive(deps, back, active);
  if (switched) return switched;
  const lost = journal(deps, { status: "rolled-back", target: back, previous: active, at });
  return {
    outcome: "promoted",
    version: back.version,
    deployment: back.deployment,
    model: targetOf(back.version, back.deployment).model,
    previous: null,
    production: "not switched until the Worker is deployed",
    next: WORKER_NEXT,
    timings: timings({ start, prepared, probed, switched: now() }),
    ...(lost ? { journal: lost } : {}),
  };
}

// The release step that carries a promotion or a rollback into production (D03 T04 §36): preflight, deploy, health,
// smoke, and one fixture page screened through the deployed Worker, each timed against the same 7-minute budget.
// Every stage is injected, so each failure, hang and refusal is testable without a deploy.
export type ReleaseDeps = {
  commit: string;
  activeVersion: string;
  preflight(): Promise<void>;
  servingState(): Promise<string>;
  deployWorker(deadline: number): Promise<void>;
  waitHealth(commit: string, deadline: number): Promise<void>;
  smoke(deadline: number): Promise<void>;
  screenFixture(deadline: number): Promise<{ screener: string; version: string }>;
  now?: () => Date;
};
export type ReleaseTimings = {
  prepare_ms: number;
  activation_ms: number;
  probe_ms: number;
  screen_ms: number;
  total_ms: number;
  budget_minutes: number;
  within_budget: boolean;
};
export type Released =
  | {
      outcome: "released";
      commit: string;
      version: string;
      serving_before: string;
      serving_after: string;
      timings: ReleaseTimings;
    }
  | {
      outcome: "refused" | "failed";
      stage: string;
      detail: string;
      serving: "changed" | "unchanged" | "uncertain";
      recovery: string;
    };

const RECOVERY =
  "read `wrangler deployments status`, then redeploy the previous known-good commit from docs/operations.md " +
  "(Redeploy a known-good commit) and run `node scripts/glimmer/deploy.ts release` again";

export async function release(deps: ReleaseDeps): Promise<Released> {
  const now = clock(deps);
  const start = now();
  const deadline = start + BUDGET_MINUTES * 60_000;
  let before: string | null = null;
  const servingAfterFailure = async (): Promise<"changed" | "unchanged" | "uncertain"> => {
    if (before === null) return "uncertain";
    try {
      return (await deps.servingState()) === before ? "unchanged" : "changed";
    } catch {
      return "uncertain";
    }
  };
  const fail = async (outcome: "refused" | "failed", stage: string, detail: string): Promise<Released> => ({
    outcome,
    stage,
    detail,
    serving: await servingAfterFailure(),
    recovery: RECOVERY,
  });
  try {
    await deps.preflight();
  } catch (error) {
    return {
      outcome: "refused",
      stage: "preflight",
      detail: (error as Error).message,
      serving: "unchanged",
      recovery: "fix the preflight refusal, then run the release again; nothing was deployed",
    };
  }
  try {
    before = await deps.servingState();
  } catch {
    before = null;
  }
  const stages: [string, (deadline: number) => Promise<void>][] = [
    ["prepare", (d) => deps.deployWorker(d)],
    ["activation", (d) => deps.waitHealth(deps.commit, d)],
    ["probe", (d) => deps.smoke(d)],
  ];
  const marks: number[] = [start];
  for (const [stage, run] of stages) {
    if (now() >= deadline) return fail("failed", stage, `the ${BUDGET_MINUTES}-minute budget expired before ${stage}`);
    try {
      await run(deadline);
    } catch (error) {
      const detail = (error as Error).message;
      return fail("failed", stage, detail);
    }
    marks.push(now());
    if (now() > deadline) return fail("failed", stage, `the ${BUDGET_MINUTES}-minute budget expired during ${stage}`);
  }
  if (now() >= deadline) return fail("failed", "screen", `the ${BUDGET_MINUTES}-minute budget expired before screen`);
  let screened: { screener: string; version: string };
  try {
    screened = await deps.screenFixture(deadline);
  } catch (error) {
    return fail("failed", "screen", (error as Error).message);
  }
  marks.push(now());
  if (screened.screener !== "glimmer")
    return fail("failed", "screen", `the fixture page was served by ${screened.screener}, not glimmer`);
  if (screened.version !== deps.activeVersion)
    return fail(
      "failed",
      "screen",
      `the fixture page was served by version ${screened.version}, not ${deps.activeVersion}`,
    );
  let after = "uncertain";
  try {
    after = await deps.servingState();
  } catch {
    // The release itself passed every read-back; an unreadable serving state is reported, not hidden.
  }
  const [t0, t1, t2, t3, t4] = marks as [number, number, number, number, number];
  return {
    outcome: "released",
    commit: deps.commit,
    version: deps.activeVersion,
    serving_before: before ?? "uncertain",
    serving_after: after,
    timings: {
      prepare_ms: t1 - t0,
      activation_ms: t2 - t1,
      probe_ms: t3 - t2,
      screen_ms: t4 - t3,
      total_ms: t4 - t0,
      budget_minutes: BUDGET_MINUTES,
      within_budget: t4 - t0 <= BUDGET_MINUTES * 60_000,
    },
  };
}

// What the command prints and its exit code: the outcome as it is, with the active file read for the report only when it
// can be, so an unreadable file never swallows the recovery instructions.
export function report(result: Promoted, activeFile: string): { text: string; code: number } {
  let active: Active | string;
  try {
    active = readActive(activeFile);
  } catch (error) {
    active = (error as Error).message;
  }
  return { text: JSON.stringify({ ...result, active }, null, 2), code: result.outcome === "promoted" ? 0 : 1 };
}

// The gate as the operator runs it: version-gate.py prints `promote` (exit 0), `keep <previous>: <reason>` (exit 1), or
// names a missing record (exit 2).
export function runGate(version: string, previous: string): Gate {
  const run = spawnSync("python3", ["scripts/glimmer/version-gate.py", version, previous], { encoding: "utf-8" });
  const text = `${run.stdout}${run.stderr}`.trim().slice(0, 400);
  if (run.status === 0) return { verdict: "promote", detail: text };
  if (run.status === 1) return { verdict: "keep", detail: text };
  return { verdict: "missing", detail: text || "version-gate.py could not run" };
}
