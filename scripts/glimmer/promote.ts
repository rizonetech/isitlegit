// Promote a gate-passing Loupe version onto its own dedicated deployment, and roll back (D03 T04 §32).
//
// Operator, 2026-10-31 23:44 SAST: Loupe 1.0 ships now, 1.1 and 1.2 come later, and replacing the deployed version must
// take minutes. The active version is one stored file (`src/vision/glimmer-active.json`) that `glimmer-caps.ts` derives
// every consumer from, so a promotion is this command plus the Worker deploy that carries the file.
//
//     node scripts/glimmer/deploy.ts promote <version>     the gate, the new deployment, a probe, then the active file
//     node scripts/glimmer/deploy.ts rollback              back to the recorded previous deployment, by the same checks
//
// Nothing changes until every check has passed: the gate (against the previous version read from the verified active
// file), a new deployment that reads back its contract and answers one valid completion through the shared minutes
// ledger. The active file is written last, read back, and restored when that read-back disagrees.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Active, deploymentFor, modelNameOf, targetOf } from "../../src/vision/glimmer-caps.ts";
import { checkPriced, checkReadBack, type Deployment } from "./deploy.ts";

export type Gate = { verdict: "promote" | "keep" | "missing"; detail: string };
export type Client = {
  status(): Promise<Deployment | null>;
  ensure(version: string): Promise<{ created: boolean; deployment: Deployment }>;
  waitReady(): Promise<Deployment>;
};
export type Deps = {
  activeFile: string;
  stateFile: string;
  gate(version: string, previous: string): Gate;
  deployments(deployment: string): Client;
  // One valid completion from the version's deployment, through the shared minutes ledger; throws when it does not get one.
  probe(version: string, deployment: string): Promise<unknown>;
  now?: () => Date;
  // Writes a JSON file; the default replaces it atomically. Injected so a failed or corrupt write can be tested.
  write?: (file: string, value: unknown) => void;
};

export type Promoted =
  | {
      outcome: "promoted";
      version: string;
      deployment: string;
      model: string;
      previous: Active["previous"];
      next: string;
    }
  | { outcome: "refused"; detail: string; serving: string }
  | { outcome: "failed"; detail: string; serving: string }
  | { outcome: "unresolved"; detail: string; recovery: string };

const WORKER_NEXT = "deploy the Worker (pnpm deploy) so it carries src/vision/glimmer-active.json";

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
function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}
// A promotion's own record, written before the first remote change: what was being switched, from what, and how it ended.
type State = {
  status: "promoting" | "failed" | "promoted" | "rolled-back";
  target: Active;
  previous: Active;
  at: string;
  detail?: string;
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
    writeJson(deps.stateFile, { ...earlier, status: "promoted", detail: "completed by a later run" });
  if (version === active.version)
    return { outcome: "refused", detail: `${version} is already the active version`, serving };
  // Every refusal that needs no change comes first: the verified record, then the gate.
  const disagreement = await verifyRecorded(deps, active);
  if (disagreement)
    return { outcome: "refused", detail: `the active record disagrees with the deployment: ${disagreement}`, serving };
  const gate = deps.gate(version, active.version);
  if (gate.verdict !== "promote") return { outcome: "refused", detail: `the gate: ${gate.detail}`, serving };

  const target: Active = {
    version,
    deployment: deploymentFor(version),
    previous: { version: active.version, deployment: active.deployment },
  };
  const at = (deps.now ?? (() => new Date()))().toISOString();
  writeJson(deps.stateFile, { status: "promoting", target, previous: active, at } satisfies State);
  const fail = (outcome: "refused" | "failed", detail: string): Promoted => {
    writeJson(deps.stateFile, { status: "failed", target, previous: active, at, detail });
    return { outcome, detail, serving };
  };
  try {
    const client = deps.deployments(target.deployment);
    await client.ensure(version);
    const ready = await client.waitReady();
    checkReadBack(ready, 1);
    checkPriced(ready, target.deployment);
    await deps.probe(version, target.deployment);
  } catch (error) {
    const detail = (error as Error).message;
    return fail(detail.startsWith("refused:") ? "refused" : "failed", detail);
  }
  const switched = switchActive(deps, target, active);
  if (switched) {
    if (switched.outcome === "failed") return fail("failed", switched.detail);
    return switched;
  }
  writeJson(deps.stateFile, { status: "promoted", target, previous: active, at });
  return {
    outcome: "promoted",
    version,
    deployment: target.deployment,
    model: targetOf(version, target.deployment).model,
    previous: target.previous,
    next: WORKER_NEXT,
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
  const at = (deps.now ?? (() => new Date()))().toISOString();
  writeJson(deps.stateFile, { status: "promoting", target: back, previous: active, at } satisfies State);
  try {
    const client = deps.deployments(previous.deployment);
    const ready = await client.waitReady();
    checkReadBack(ready, 1);
    checkPriced(ready, previous.deployment);
    await deps.probe(previous.version, previous.deployment);
  } catch (error) {
    const detail = (error as Error).message;
    writeJson(deps.stateFile, { status: "failed", target: back, previous: active, at, detail });
    return { outcome: detail.startsWith("refused:") ? "refused" : "failed", detail, serving };
  }
  const switched = switchActive(deps, back, active);
  if (switched) return switched;
  writeJson(deps.stateFile, { status: "rolled-back", target: back, previous: active, at });
  return {
    outcome: "promoted",
    version: back.version,
    deployment: back.deployment,
    model: targetOf(back.version, back.deployment).model,
    previous: null,
    next: WORKER_NEXT,
  };
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
