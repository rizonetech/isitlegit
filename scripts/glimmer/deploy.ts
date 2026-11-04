// Loupe's dedicated Fireworks deployment, scaled to zero after 5 idle minutes (D03 T04 §12).
//
//   node scripts/glimmer/deploy.ts ensure <version>   # create it, or find it, for isitlegit-loupe-<version>
//   node scripts/glimmer/deploy.ts stop               # minimum and maximum replicas to 0, the deployment kept
//   node scripts/glimmer/deploy.ts start              # maximum back to 1
//   node scripts/glimmer/deploy.ts status             # replicas, settings, state, last update
//   node scripts/glimmer/deploy.ts eval-up <version>  # a separate preemptible deployment for §13's held-out run, READY
//   node scripts/glimmer/deploy.ts eval-down <version> # delete it once the run is done
//   node scripts/glimmer/deploy.ts key-check <version> # the inference-only key answers the deployment, cannot change it
//   node scripts/glimmer/deploy.ts warmup <version>   # one cold start timed, and scale to zero after it (§13)
//   node scripts/glimmer/deploy.ts warmup-summary     # the warm-ups' median and maximum, from their receipts
//
// Live merge: the fine-tuned model itself is the deployment's `baseModel`, with the `default` deployment shape, so
// Fireworks picks a shape that can merge it (https://docs.fireworks.ai/fine-tuning/deploying-loras); inference then
// names the model with no `#` suffix. The admin key ("IsItLegit Fireworks Admin") comes through conclave-op, is sent only
// in the Authorization header and is never printed. Every change is read back, and a read-back that does not show
// minimum 0, the maximum asked for and a 5-minute scale-to-zero window fails the command.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEPLOYED_GPU, DEPLOYED_GPU_COUNT, DEPLOYMENT, TAIL_MINUTES } from "../../src/vision/glimmer-caps.ts";
import type { Activity } from "../../src/vision/glimmer-minutes.ts";
import {
  type Exec,
  ledgerStatus,
  reconcilePending,
  reserveBurst,
  settleBurst,
} from "../../src/vision/glimmer-minutes.ts";
import { ACCOUNT, API, configureNetwork } from "../fireworks-check.ts";
import { COMPLETIONS_URL, INFERENCE_KEY_ITEM } from "./evaluate.ts";
import { wranglerExec } from "./runtime-ledger.ts";

// The active version's deployment (src/vision/glimmer-active.json, D03 T04 §32): one stored thing, never a literal here.
export { DEPLOYMENT };
// §13's held-out run goes to its own preemptible deployment (borrowed idle GPUs, no charge to hold capacity, preempted
// without warning; https://docs.fireworks.ai/guides/ondemand-deployments), never to the dedicated one or its minutes.
// One per version (`isitlegit-loupe-eval-1-1`): Fireworks keeps a deleted deployment's record and id (soft delete), with
// the model it served, so a later version cannot be created under the id an earlier one used. The same version's own
// deleted record is brought back (`:undelete`). 1.0's run used `isitlegit-loupe-eval`, now deleted.
export const evalDeployment = (version: string) =>
  `isitlegit-loupe-eval-${modelOf(version).split("isitlegit-loupe-")[1]}`;
export const SCALE_TO_ZERO = "300s";
export const ADMIN_ITEM = "IsItLegit Fireworks Admin";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
// Where a long wait says what it is doing: stderr, so a command's JSON on stdout stays the only thing there.
export type Progress = (line: string) => void;
const say: Progress = (line) => console.error(`deploy: ${line}`);
// No management call or response body may take longer than this; a wait's own deadline bounds its calls too.
export const REQUEST_MS = 60_000;
export type Deployment = {
  name?: string;
  baseModel?: string;
  minReplicaCount?: number;
  maxReplicaCount?: number;
  replicaCount?: number;
  state?: string;
  acceleratorType?: string;
  acceleratorCount?: number;
  autoscalingPolicy?: { scaleToZeroWindow?: string };
  updateTime?: string;
  preemptible?: boolean;
};

export const modelOf = (version: string) => {
  if (!/^[1-9]\d?\.\d{1,2}$/.test(version)) throw new TypeError(`version "${version}" is not like 1.0`);
  return `accounts/${ACCOUNT}/models/isitlegit-loupe-${version.replace(".", "-")}`;
};

export function createBody(version: string, preemptible = false) {
  return {
    baseModel: modelOf(version),
    deploymentShape: "default",
    minReplicaCount: 0,
    maxReplicaCount: 1,
    autoscalingPolicy: { scaleToZeroWindow: SCALE_TO_ZERO },
    // The REST body's `preemptible` (https://docs.fireworks.ai/api-reference/create-deployment); `firectl` before
    // 1.7.26 ignores its flag silently, so the read-back below is what proves it took.
    ...(preemptible ? { preemptible: true } : {}),
  };
}

type Settable = Pick<Deployment, "minReplicaCount" | "maxReplicaCount" | "autoscalingPolicy">;
const SETTABLE = ["minReplicaCount", "maxReplicaCount", "autoscalingPolicy"] as const;

// An update's body holds exactly the fields its mask names, never one more: Fireworks' REST PATCH has no update-mask
// parameter (https://docs.fireworks.ai/api-reference/update-deployment) and changes what the body carries, so the mask
// is kept here, where a request is built, and an update without one is refused.
export function updateBody(mask: readonly (typeof SETTABLE)[number][], values: Settable): Settable {
  if (!mask.length) throw new Error("refused: an update needs an explicit mask of the fields it changes");
  const body: Settable = {};
  for (const field of mask) {
    if (!(SETTABLE as readonly string[]).includes(field)) throw new Error(`refused: ${field} is not a settable field`);
    if (values[field] === undefined) throw new Error(`refused: the mask names ${field} but no value is given`);
    (body as Record<string, unknown>)[field] = values[field];
  }
  return body;
}

// A read-back that does not show what was asked fails the command, whatever the request's status said.
export function checkReadBack(read: Deployment, maxReplicas: number): void {
  const window = read.autoscalingPolicy?.scaleToZeroWindow;
  const problems = [
    read.minReplicaCount !== 0 && `minimum ${read.minReplicaCount}, not 0`,
    read.maxReplicaCount !== maxReplicas && `maximum ${read.maxReplicaCount}, not ${maxReplicas}`,
    !(window === "300s" || window === "5m" || window === "300.0s") && `scale-to-zero ${window}, not 5 minutes`,
  ].filter(Boolean);
  if (problems.length) throw new Error(`the deployment read back wrong: ${problems.join("; ")}`);
}

// The runtime ledger prices the deployment as 1 x NVIDIA_H200_141GB (src/vision/glimmer-caps.ts, D03 T04 §14): one read
// back on another accelerator, or none, is refused before any request is sent, so no minute runs on an unchecked price.
export function checkPriced(read: Deployment, deployment: string = DEPLOYMENT): void {
  if (read.acceleratorType !== DEPLOYED_GPU || read.acceleratorCount !== DEPLOYED_GPU_COUNT)
    throw new Error(
      `refused: ${deployment} reads ${read.acceleratorCount ?? "?"} x ${read.acceleratorType ?? "an unknown GPU"}, but the runtime ledger prices ${DEPLOYED_GPU_COUNT} x ${DEPLOYED_GPU} (src/vision/glimmer-caps.ts); check the price and correct the caps first`,
    );
}

export function openDeployments(key: string, fetcher: Fetch = fetch, deployment: string = DEPLOYMENT) {
  const url = `${API}/deployments/${deployment}`;
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  async function call(method: string, target: string, body?: unknown): Promise<Deployment | null> {
    // The signal bounds the request and its body together: a stalled answer fails by name, never hangs a wait.
    const signal = AbortSignal.timeout(REQUEST_MS);
    let response: Response;
    let text: string;
    try {
      response = await fetcher(target, { method, headers, signal, ...(body ? { body: JSON.stringify(body) } : {}) });
      if ((method === "GET" || method === "DELETE") && response.status === 404) return null;
      text = await response.text();
    } catch (error) {
      if (signal.aborted)
        throw new Error(`${method} ${target.replace(API, "")} did not answer within ${REQUEST_MS / 1000} s`);
      throw error;
    }
    if (!response.ok)
      throw new Error(`${method} ${target.replace(API, "")} answered ${response.status}: ${text.slice(0, 300)}`);
    const parsed = text ? JSON.parse(text) : {};
    if (typeof parsed !== "object" || parsed === null) throw new Error(`${method} answered something not a deployment`);
    return parsed as Deployment;
  }
  const status = () => call("GET", url);
  async function update(mask: readonly (typeof SETTABLE)[number][], values: Settable, maxReplicas: number) {
    await call("PATCH", url, updateBody(mask, values));
    const read = await status();
    if (!read) throw new Error("the deployment is gone after the update");
    checkReadBack(read, maxReplicas);
    return read;
  }
  return {
    status,
    async ensure(version: string): Promise<{ created: boolean; deployment: Deployment }> {
      const found = await status();
      if (found) {
        // An existing deployment is accepted only as the contract has it, never repaired by `ensure`: a deployment that
        // is deleted, failed or being deleted, serves no model or another one, or holds other limits is refused by name.
        if (found.state === "DELETED" || found.state === "DELETING" || found.state === "FAILED")
          throw new Error(`${deployment} is ${found.state}; it cannot serve until it is deleted and created again`);
        if (!found.baseModel) throw new Error(`${deployment} reads back no model, so what it serves is unknown`);
        if (found.baseModel !== modelOf(version))
          throw new Error(
            `the deployment serves ${found.baseModel}, not ${modelOf(version)}; promote through §13's gate`,
          );
        // Maximum 1 as created, or 0 while it is stopped (`stop`); any other maximum is drift.
        const max = found.maxReplicaCount;
        if (max !== 0 && max !== 1)
          throw new Error(`the deployment read back wrong: maximum ${max}, not 1 (or 0 stopped)`);
        checkReadBack(found, max);
        return { created: false, deployment: found };
      }
      await call("POST", `${API}/deployments?deploymentId=${deployment}`, createBody(version));
      const read = await status();
      if (!read) throw new Error("the deployment was not found after it was created");
      checkReadBack(read, 1);
      return { created: true, deployment: read };
    },
    // The held-out run's preemptible deployment: created for the version, or found serving it, and refused (deleted)
    // unless it reads back preemptible, so a run never lands on capacity that is held and billed.
    async ensurePreemptible(version: string): Promise<{ created: boolean; deployment: Deployment }> {
      const found = await status();
      if (found) {
        // Reused only as it would be created: preemptible, this version's model, and the same limits and idle window.
        if (found.preemptible !== true || found.baseModel !== modelOf(version))
          throw new Error(
            `${deployment} exists but is not a preemptible deployment of ${modelOf(version)}; delete it with eval-down`,
          );
        checkReadBack(found, 1);
        if (found.state === "DELETING" || found.state === "FAILED")
          throw new Error(`${deployment} is ${found.state}; wait for it to be deleted, then run eval-up again`);
        // This version's own deployment, deleted by an earlier eval-down: brought back, as it was, and read again.
        if (found.state === "DELETED") {
          await call("POST", `${url}:undelete`, {});
          const back = await status();
          if (!back || back.state === "DELETED") throw new Error(`${deployment} is still deleted after the undelete`);
          if (back.preemptible !== true || back.baseModel !== modelOf(version))
            throw new Error(`${deployment} came back as something other than it was; delete it with eval-down`);
          checkReadBack(back, 1);
          return { created: false, deployment: back };
        }
        return { created: false, deployment: found };
      }
      await call("POST", `${API}/deployments?deploymentId=${deployment}`, createBody(version, true));
      const read = await status();
      if (!read) throw new Error("the deployment was not found after it was created");
      if (read.preemptible !== true) {
        await call("DELETE", url);
        throw new Error("refused: the deployment did not read back preemptible, so it was deleted");
      }
      checkReadBack(read, 1);
      return { created: true, deployment: read };
    },
    // Waits until the deployment reads READY: a deployment still CREATING answers inference with 404, so a run started
    // on it records every page as an error (1.0's first held-out run lost 817 pages that way). A deployment that is
    // gone, failed or being deleted, or not READY within the time allowed, is refused by name.
    async waitReady(
      timeoutMs = 45 * 60_000,
      everyMs = 15_000,
      sleep = (ms: number) => new Promise((done) => setTimeout(done, ms)),
      now = () => Date.now(),
      progress: Progress = say,
    ): Promise<Deployment> {
      const started = now();
      const until = started + timeoutMs;
      for (;;) {
        const read = await status();
        if (!read) throw new Error(`${deployment} is gone while waiting for it to be READY`);
        if (read.state === "READY") return read;
        progress(
          `${deployment} is ${read.state ?? "without a state"}, ${Math.round((now() - started) / 1000)} s waited, ${Math.max(0, Math.round((until - now()) / 1000))} s left`,
        );
        if (read.state === "FAILED" || read.state === "DELETING")
          throw new Error(`${deployment} is ${read.state}, not becoming READY`);
        if (now() >= until)
          throw new Error(
            `${deployment} is still ${read.state ?? "without a state"} after ${timeoutMs / 60_000} minutes`,
          );
        await sleep(everyMs);
      }
    },
    // Gone, or what is still there. Fireworks soft-deletes: a deleted deployment still reads back, in state DELETED,
    // and a second DELETE answers 400 ("already soft-deleted"), so DELETED counts as gone and is never deleted again.
    remove: async () => {
      const before = await status();
      if (before && before.state !== "DELETED") await call("DELETE", url);
      const after = await status();
      return after && after.state !== "DELETED" ? after : null;
    },
    // Maximum 0 accepted is not replicas at 0: `stop` returns only once the deployment reads 0 replicas, or fails by
    // name when it still runs some after the time allowed.
    async stop(
      timeoutMs = 10 * 60_000,
      everyMs = 15_000,
      sleep = (ms: number) => new Promise((done) => setTimeout(done, ms)),
      now = () => Date.now(),
      progress: Progress = say,
    ): Promise<Deployment> {
      let read = await update(["minReplicaCount", "maxReplicaCount"], { minReplicaCount: 0, maxReplicaCount: 0 }, 0);
      const started = now();
      const until = started + timeoutMs;
      while ((read.replicaCount ?? 0) > 0) {
        progress(
          `${deployment} has maximum 0 and ${read.replicaCount} replicas left, ${Math.round((now() - started) / 1000)} s waited`,
        );
        if (now() >= until)
          throw new Error(
            `${deployment} has maximum 0 but still runs ${read.replicaCount} replicas after ${timeoutMs / 60_000} minutes; read it again with status`,
          );
        await sleep(everyMs);
        const again = await status();
        if (!again) throw new Error(`${deployment} is gone while stopping`);
        // Each read must still show the stop: a change from elsewhere (a `start`) fails it, never passes for stopped.
        checkReadBack(again, 0);
        read = again;
      }
      return read;
    },
    start: () => update(["maxReplicaCount"], { maxReplicaCount: 1 }, 1),
  };
}

// The dedicated deployment's minutes (the operator's 30 a day) as this script spends them, on the one runtime ledger
// the Worker uses (D03 T04 §14, `glimmer_runtime` in D1, reached through `wrangler d1 execute`): each wake is reserved
// before its first request at its worst case and settled at what it took. A wake the ledger refuses, or a ledger that
// cannot be reached, sends nothing.
export { DAILY_MINUTES, TAIL_MINUTES } from "../../src/vision/glimmer-caps.ts";
export { minutesByDay } from "../../src/vision/glimmer-minutes.ts";
export type Wake = { id: string; at: Date; purpose: string; evidenceDir: string };

// What a local wake leaves behind as it runs (D03 T04 §35): its process (id and start token) and the end of each
// request's window, written before the request is sent, so a wake that is killed leaves the latest moment it could have
// kept the deployment up. `reconcile` settles an abandoned reservation from this and nothing else.
export type Evidence = {
  id: string;
  pid: number;
  start: string | null;
  wake_at: string;
  last_deadline_at: string | null;
};
export const wakeEvidenceDir = () =>
  join(process.env.GLIMMER_DATA_DIR ?? join(homedir(), "isitlegit-data", "glimmer"), "runs", "wakes");
const evidenceFile = (dir: string, id: string) => join(dir, `${id.replaceAll(":", "_")}.json`);
// The process's start time as the kernel counts it (field 22 of /proc/<pid>/stat), which tells a live process from a
// later one that was given the same pid; null where it cannot be read.
export function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    // Not Linux, or the process is gone: there is no start token to compare.
    return null;
  }
}
// Written durably: the file's bytes and then its directory entry are flushed, so after a machine crash the record is either
// this one or the one before it, and a request is never sent on a window that exists only in memory (completion review).
export function writeEvidence(dir: string, evidence: Evidence): void {
  mkdirSync(dir, { recursive: true });
  const file = evidenceFile(dir, evidence.id);
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w");
  try {
    writeSync(fd, `${JSON.stringify(evidence)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  const folder = openSync(dir, "r");
  try {
    fsyncSync(folder);
  } finally {
    closeSync(folder);
  }
}
// The evidence, validated: null when there is none; an Error naming the file when it is damaged or unreadable.
export function readEvidence(dir: string, id: string): Evidence | null {
  const file = evidenceFile(dir, id);
  if (!existsSync(file)) return null;
  let parsed: Partial<Evidence>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<Evidence>;
  } catch (error) {
    throw new Error(`the evidence ${file} cannot be read (${(error as Error).message})`);
  }
  if (
    parsed.id !== id ||
    !Number.isInteger(parsed.pid) ||
    typeof parsed.wake_at !== "string" ||
    !(parsed.start === null || typeof parsed.start === "string") ||
    !(
      parsed.last_deadline_at === null ||
      (typeof parsed.last_deadline_at === "string" && !Number.isNaN(Date.parse(parsed.last_deadline_at)))
    )
  )
    throw new Error(`the evidence ${file} is damaged (it does not describe ${id})`);
  return parsed as Evidence;
}
// Records the end of the request window about to open: written before the request is sent, never lowered.
export function touchWake(wake: Wake, deadlineMs: number): void {
  const evidence = readEvidence(wake.evidenceDir, wake.id);
  if (!evidence) return;
  const later = Math.max(deadlineMs, evidence.last_deadline_at ? Date.parse(evidence.last_deadline_at) : 0);
  writeEvidence(wake.evidenceDir, { ...evidence, last_deadline_at: new Date(later).toISOString() });
}

export async function reserveWake(
  ledger: Exec,
  purpose: string,
  minutes: number,
  at: Date,
  evidenceDir: string = wakeEvidenceDir(),
  deployment: string = DEPLOYMENT,
  rate?: number,
): Promise<Wake> {
  const id = `local:${purpose}:${at.toISOString()}:${randomUUID()}`;
  // The evidence comes first: a reservation then never exists without it, so a failed write (a full disk) reserves nothing,
  // and a stop between the two leaves evidence of a reservation that does not exist, which `reconcile` refuses by name.
  writeEvidence(evidenceDir, {
    id,
    pid: process.pid,
    start: processStart(process.pid),
    wake_at: at.toISOString(),
    last_deadline_at: null,
  });
  const reserved = await reserveBurst(
    ledger,
    {
      id,
      at,
      source: "local",
      caller: "deploy.ts",
      purpose,
      minutes,
      deployment,
    },
    rate,
  );
  if (!reserved.ok) {
    // Evidence goes only with a refusal the ledger made: when it could not be reached, the reservation may have landed
    // anyway (an insert that succeeded and a read-back that did not), and its evidence is what `reconcile` needs.
    if (reserved.reason !== "ledger-unavailable") rmSync(evidenceFile(evidenceDir, id), { force: true });
    throw new Error(`refused: a ${purpose} wake of up to ${Math.round(minutes * 10) / 10} minutes: ${reserved.detail}`);
  }
  return { id, at, purpose, evidenceDir };
}
// A wake closed at what it took: to its last answer (or the last request's deadline) plus the tail, or to the moment
// the deployment was read at 0 replicas when that was measured.
export async function settleWake(ledger: Exec, wake: Wake, activity: Activity): Promise<void> {
  const settled = await settleBurst(ledger, wake.id, activity);
  // The reserve stays counted when the settlement cannot be written, which is never less than the wake used.
  if (!settled.ok) say(`the ${wake.purpose} wake stays counted at its reserve: ${settled.detail}`);
}

// Settles a local reservation whose command is gone (D03 T04 §35), from the wake's own evidence and only when its process
// is provably dead: a command still running, or one whose process cannot be told from a live one, is refused, so headroom
// is never released under a caller that can still spend. With no evidence the full reserve stays counted. The result is
// read back from the ledger, and a second run changes nothing.
export type Reconciled =
  | { outcome: "settled"; before: number; after: number; detail: string }
  | { outcome: "already-settled"; before: number; after: number; detail: string }
  | { outcome: "refused"; detail: string }
  | { outcome: "pending"; before: number; detail: string };
export async function reconcileWake(
  ledger: Exec,
  id: string,
  options: { dir?: string; alive?: (pid: number, start: string | null) => "alive" | "dead" | "unknown" } = {},
): Promise<Reconciled> {
  const dir = options.dir ?? wakeEvidenceDir();
  type Row = { reserved_minutes: number; used_minutes: number | null; settled_at: string | null; reconciled: number };
  const counted = async () =>
    (
      await ledger({
        sql: "SELECT reserved_minutes, used_minutes, settled_at, reconciled FROM glimmer_runtime WHERE reservation_id = ?1",
        params: [id],
      })
    ).rows as Row[];
  const total = (rows: Row[]) =>
    Math.round(rows.reduce((sum, row) => sum + Number(row.used_minutes ?? row.reserved_minutes), 0) * 10) / 10;
  let rows: Row[];
  try {
    rows = await counted();
  } catch (error) {
    return {
      outcome: "refused",
      detail: `the runtime ledger could not be read (${(error as Error).message}); nothing was changed`,
    };
  }
  if (!rows.length) return { outcome: "refused", detail: `no reservation ${id} in the runtime ledger` };
  const before = total(rows);
  // Settled, but its overlap reconciliation may still be owed (an earlier run's second step failed): finish it, then read it back.
  const finish = async (): Promise<Reconciled | Row[]> => {
    try {
      await reconcilePending(ledger);
      const read = await counted();
      if (!read.every((row) => row.settled_at !== null && row.reconciled === 1))
        return {
          outcome: "pending",
          before,
          detail: "the settlement did not read back as reconciled with the runtime it overlaps; run this again",
        };
      return read;
    } catch (error) {
      return {
        outcome: "pending",
        before,
        detail: `the ledger could not be read or written (${(error as Error).message}); the settlement may or may not have landed, run this again`,
      };
    }
  };
  if (rows.every((row) => row.settled_at !== null)) {
    const done = await finish();
    if (!Array.isArray(done)) return done;
    const after = total(done);
    return {
      outcome: "already-settled",
      before: after,
      after,
      detail: "it is settled and reconciled; nothing changed",
    };
  }
  let evidence: Evidence | null;
  try {
    evidence = readEvidence(dir, id);
  } catch (error) {
    return { outcome: "refused", detail: `${(error as Error).message}; ${before} minutes stay counted` };
  }
  if (!evidence)
    return {
      outcome: "refused",
      detail: `no evidence of ${id} in ${dir}; its full ${before} minutes stay counted (age alone releases nothing)`,
    };
  const state = (options.alive ?? livenessOf)(evidence.pid, evidence.start);
  if (state !== "dead")
    return {
      outcome: "refused",
      detail: `its command (pid ${evidence.pid}) ${state === "alive" ? "is still running" : "cannot be shown to have stopped"}; ${before} minutes stay counted`,
    };
  const settled = await settleBurst(ledger, id, {
    lastDeadlineAt: evidence.last_deadline_at ? new Date(evidence.last_deadline_at) : null,
  });
  if (!settled.ok)
    return {
      outcome: "pending",
      before,
      detail: `the ledger could not be written (${settled.detail}); the reservation stays counted at ${before} minutes, run this again`,
    };
  // Verified completion: every row settled and reconciled, read back, never the settlement call's own answer.
  const done = await finish();
  if (!Array.isArray(done)) return done;
  return {
    outcome: "settled",
    before,
    after: total(done),
    detail: `settled from its last request window (${evidence.last_deadline_at ?? "no request was sent"}) plus the ${TAIL_MINUTES}-minute tail`,
  };
}
// Whether the process that wrote evidence is gone: no such pid, or a later process given the pid (another start token).
export function livenessOf(pid: number, start: string | null): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
  const now = processStart(pid);
  if (start !== null && now !== null) return now === start ? "alive" : "dead";
  return "unknown";
}

// The wakes this script recorded in its own file before the D1 ledger (`<store>/runs/deployment-minutes.json`), copied
// once: each wake's id comes from its time, purpose and day, so a second import adds nothing.
export type FileWake = { day: string; at: string; purpose: string; reserved: number; used: number | null };
export const wakeLedgerFile = () =>
  join(process.env.GLIMMER_DATA_DIR ?? join(homedir(), "isitlegit-data", "glimmer"), "runs", "deployment-minutes.json");
export function readWakes(file: string): FileWake[] {
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, "utf-8"));
  if (!Array.isArray(data)) throw new Error(`${file} is not a list of wakes`);
  return data as FileWake[];
}
export async function importWakes(ledger: Exec, file = wakeLedgerFile()): Promise<{ wakes: number; added: number }> {
  const wakes = readWakes(file);
  let added = 0;
  for (const wake of wakes) {
    const reservation = `import:${createHash("sha256").update(`${wake.at}\n${wake.purpose}`).digest("hex").slice(0, 24)}`;
    const answer = await ledger({
      sql:
        "INSERT OR IGNORE INTO glimmer_runtime (id, reservation_id, day, source, caller, purpose, wake_at, reserved_minutes, used_minutes, settled_at) " +
        "VALUES (?1 || ':' || ?2, ?1, ?2, 'import', 'deploy.ts', ?3, ?4, ?5, ?6, ?7)",
      params: [
        reservation,
        wake.day,
        wake.purpose,
        wake.at,
        wake.reserved,
        wake.used,
        wake.used === null ? null : wake.at,
      ],
    });
    added += answer.changes;
  }
  return { wakes: wakes.length, added };
}

// A one-token call's body as a completion: a choice whose message or text is there and which says why it ended. A
// success status with any other body (an empty object, an error page) is no answer.
export function isCompletion(text: string): boolean {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return false;
  }
  const choice = (body as { choices?: unknown[] })?.choices?.[0] as
    | { message?: { content?: unknown }; text?: unknown; finish_reason?: unknown }
    | undefined;
  return (
    !!choice &&
    (typeof choice.message?.content === "string" || typeof choice.text === "string") &&
    typeof choice.finish_reason === "string"
  );
}

// The error code in a Fireworks error body (`{"error": {"code": "..."}}`, or the code named in its text), or null:
// only an upper-case name of at most 64 characters, so nothing else from the body reaches a message.
export function errorCode(text: string): string | null {
  if (text.includes("DEPLOYMENT_SCALING_UP")) return "DEPLOYMENT_SCALING_UP";
  return /"code"\s*:\s*"([A-Z][A-Z0-9_]{0,63})"/.exec(text)?.[1] ?? null;
}

// §12's key proof: the inference-only key ("IsItLegit Fireworks") gets a one-token answer from the dedicated
// deployment, waiting out its cold start (503 while it scales up, 429), and is refused a change to it. The change tried
// is a no-op (maximum replicas 1, as it is), so a key that wrongly holds admin rights changes nothing.
export async function checkInferenceKey(
  version: string,
  key: string,
  fetcher: Fetch = fetch,
  timeoutMs = 15 * 60_000,
  sleep = (ms: number) => new Promise((done) => setTimeout(done, ms)),
  now = () => Date.now(),
  ledger: Exec = wranglerExec(),
  progress: Progress = say,
  evidenceDir: string = wakeEvidenceDir(),
  deployment: string = DEPLOYMENT,
  purpose: "key-check" | "promotion" | "rollback" = "key-check",
): Promise<{ answered: { status: number; attempts: number; waitedMs: number }; change: { status: number } }> {
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  // The wake is the deployment's minutes: reserved at its worst case before the first request, settled after.
  const wake = await reserveWake(
    ledger,
    purpose,
    timeoutMs / 60_000 + TAIL_MINUTES,
    new Date(now()),
    evidenceDir,
    deployment,
  );
  const started = now();
  try {
    return await keyProof(
      version,
      headers,
      fetcher,
      timeoutMs,
      sleep,
      now,
      started,
      progress,
      (deadline) => touchWake(wake, deadline),
      deployment,
    );
  } finally {
    // The last request may have kept the deployment up until now.
    await settleWake(ledger, wake, { lastDeadlineAt: new Date(now()) });
  }
}

// One token from the dedicated deployment with the inference key, waiting out its cold start: each request bounded
// by what is left of the wait, no request after it, and only 503 DEPLOYMENT_SCALING_UP or 429 waited out (any other
// answer fails at once, named by its bounded error code). It says when the first cold-start answer came and when
// the answer did, which the warm-up measurement reads.
export type OneToken = {
  status: number;
  attempts: number;
  waitedMs: number;
  firstScalingAt: number | null;
  answeredAt: number;
};
async function askOneToken(
  version: string,
  headers: Record<string, string>,
  fetcher: Fetch,
  timeoutMs: number,
  sleep: (ms: number) => Promise<unknown>,
  now: () => number,
  started: number,
  progress: Progress,
  pauseMs = 15_000,
  touch: (deadlineMs: number) => void = () => {},
  deployment: string = DEPLOYMENT,
): Promise<OneToken> {
  const until = started + timeoutMs;
  const late = (last: string) =>
    new Error(`the deployment did not answer within ${timeoutMs / 60_000} minutes (last ${last})`);
  let attempts = 0;
  let firstScalingAt: number | null = null;
  progress(`asking ${deployment} for one token with the inference key, up to ${timeoutMs / 60_000} minutes`);
  let last = "no request";
  for (;;) {
    // No request starts once the wait has run out.
    if (now() >= until) throw late(last);
    attempts++;
    const window = Math.max(1_000, Math.min(REQUEST_MS, until - now()));
    const signal = AbortSignal.timeout(window);
    // The end of this request's window is on record before the request is sent (§35).
    touch(now() + window);
    let response: Response;
    let text: string;
    try {
      response = await fetcher(COMPLETIONS_URL, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({
          model: `${modelOf(version)}#accounts/${ACCOUNT}/deployments/${deployment}`,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          temperature: 0,
        }),
      });
      text = await response.text();
    } catch (error) {
      if (!signal.aborted) throw error;
      if (now() >= until) throw late("no answer to its request");
      progress(`the request stalled and was cut off after ${REQUEST_MS / 1000} s; asking again`);
      continue;
    }
    // An answer after the wait ran out is past the minutes reserved for it: it fails like no answer.
    if (now() > until) throw late(String(response.status));
    if (response.ok) {
      if (!isCompletion(text)) throw new Error(`the one-token call answered ${response.status} with no completion`);
      return { status: response.status, attempts, waitedMs: now() - started, firstScalingAt, answeredAt: now() };
    }
    const code = errorCode(text);
    const scaling = response.status === 503 && code === "DEPLOYMENT_SCALING_UP";
    if (!scaling && response.status !== 429)
      throw new Error(`the one-token call answered ${response.status}${code ? ` (${code})` : ""}`);
    if (scaling && firstScalingAt === null) firstScalingAt = now();
    last = `${response.status}${code ? ` ${code}` : ""}`;
    if (now() >= until) throw late(last);
    progress(
      `${scaling ? "the deployment is scaling up" : "rate limited"} (${response.status}), ${Math.round((now() - started) / 1000)} s waited, asking again in ${pauseMs / 1000} s`,
    );
    // The pause is cut to what is left of the wait, so the last request still starts inside it.
    await sleep(Math.max(0, Math.min(pauseMs, until - now())));
  }
}

async function keyProof(
  version: string,
  headers: Record<string, string>,
  fetcher: Fetch,
  timeoutMs: number,
  sleep: (ms: number) => Promise<unknown>,
  now: () => number,
  started: number,
  progress: Progress,
  touch: (deadlineMs: number) => void = () => {},
  deployment: string = DEPLOYMENT,
): Promise<{ answered: { status: number; attempts: number; waitedMs: number }; change: { status: number } }> {
  const until = started + timeoutMs;
  const one = await askOneToken(
    version,
    headers,
    fetcher,
    timeoutMs,
    sleep,
    now,
    started,
    progress,
    15_000,
    touch,
    deployment,
  );
  const answered = { status: one.status, attempts: one.attempts, waitedMs: one.waitedMs };
  // The change, its body included, is bounded by what is left of the wait too.
  const probeWindow = Math.max(1_000, Math.min(REQUEST_MS, until - now()));
  const probe = AbortSignal.timeout(probeWindow);
  touch(now() + probeWindow);
  let change: Response;
  try {
    change = await fetcher(`${API}/deployments/${deployment}`, {
      method: "PATCH",
      headers,
      signal: probe,
      body: JSON.stringify(updateBody(["maxReplicaCount"], { maxReplicaCount: 1 })),
    });
    await change.text();
  } catch (error) {
    if (probe.aborted) throw new Error("the change tried with the inference key did not answer in time");
    throw error;
  }
  if (change.ok) throw new Error(`the inference key was allowed to change ${deployment} (${change.status})`);
  if (change.status !== 401 && change.status !== 403)
    throw new Error(`the change with the inference key answered ${change.status}, not a refusal`);
  return { answered, change: { status: change.status } };
}

// §13's warm-up measurement, one receipt a run (`<store>/runs/warmup/<started>.json`, written whole): the deployment
// must read READY with 0 replicas first (a confirmed scale to zero, so the wake is cold); the wake is reserved in the
// day's minutes at its worst case (the answer's wait plus the wait for scale to zero) and settled at what the
// deployment was up; warm-up is from the first 503 DEPLOYMENT_SCALING_UP to the first answer; then `status` is read
// every 15 s until it shows 0 replicas, which times scale to zero from the last request.
export type WarmupReceipt = {
  version: string;
  started_at: string;
  initial: { state: string | null; replicas: number; updated: string | null };
  attempts: number;
  cold: boolean;
  warmup_ms: number | null;
  answered_ms: number;
  zero_ms_after_last_request: number | null;
  within_7_minutes: boolean | null;
  wake_minutes: number;
};
export const warmupDir = () =>
  join(process.env.GLIMMER_DATA_DIR ?? join(homedir(), "isitlegit-data", "glimmer"), "runs", "warmup");
export async function measureWarmup(
  version: string,
  key: string,
  admin: { status: () => Promise<Deployment | null> },
  options: {
    fetcher?: Fetch;
    sleep?: (ms: number) => Promise<unknown>;
    now?: () => number;
    ledger?: Exec;
    dir?: string;
    progress?: Progress;
    timeoutMs?: number;
    zeroTimeoutMs?: number;
    // Work to run on the warm deployment once it has answered, before the wait for scale to zero (§1's comparison on
    // the monitor pages), and the minutes it is allowed, reserved with the warm-up's. Its requests count as the wake's.
    // The work run on the warm deployment. It is given a function to record the end of each request window before the
    // request is sent (the evidence a killed run is settled from), including a check that runs before its main work.
    whileWarm?: (touch: (deadlineMs: number) => void) => Promise<unknown>;
    whileWarmMinutes?: number;
    // Where the wake's evidence is kept (§35); the store's `runs/wakes` by default.
    evidenceDir?: string;
  } = {},
): Promise<WarmupReceipt> {
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const now = options.now ?? (() => Date.now());
  const progress = options.progress ?? say;
  // Cold starts measured 131, 138 and 195 s (§12's key check, §13's first two warm-ups); 4.5 minutes allows them, and
  // 7.5 minutes for scale to zero covers the 7 the check needs: 12 minutes reserved, so three warm-ups, each settled at
  // about 8 minutes, fit one day's 30.
  const timeoutMs = options.timeoutMs ?? 4.5 * 60_000;
  const zeroTimeoutMs = options.zeroTimeoutMs ?? 7.5 * 60_000;
  const ledger = options.ledger ?? wranglerExec();
  const before = await admin.status();
  if (before?.state !== "READY" || (before.replicaCount ?? 0) !== 0)
    throw new Error(
      `refused: ${DEPLOYMENT} reads ${before?.state ?? "missing"} with ${before?.replicaCount ?? "?"} replicas; a warm-up starts only at READY with 0`,
    );
  checkPriced(before);
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const whileWarmMinutes = options.whileWarm ? (options.whileWarmMinutes ?? 5) : 0;
  const wake = await reserveWake(
    ledger,
    options.whileWarm ? "warm-up and comparison" : "warm-up",
    (timeoutMs + zeroTimeoutMs) / 60_000 + whileWarmMinutes,
    new Date(now()),
    options.evidenceDir ?? wakeEvidenceDir(),
  );
  const started = now();
  let activity: Activity = {};
  try {
    const one = await askOneToken(
      version,
      headers,
      fetcher,
      timeoutMs,
      sleep,
      now,
      started,
      progress,
      5_000,
      (deadline) => touchWake(wake, deadline),
    );
    // The work run on the warm deployment ends its requests; scale to zero is timed from its end. Past its minutes it
    // is stopped by its own time budget, never the ledger's.
    if (options.whileWarm) {
      // Until the work reports its own windows, its declared budget from here is the latest it can run; when it
      // finishes its requests have ended.
      const touch = (deadlineMs: number) => touchWake(wake, deadlineMs);
      touch(now() + whileWarmMinutes * 60_000);
      await options.whileWarm(touch);
      touch(now());
    }
    const lastRequest = options.whileWarm ? now() : one.answeredAt;
    let zeroAt: number | null = null;
    while (now() - lastRequest < zeroTimeoutMs) {
      await sleep(15_000);
      const read = await admin.status();
      progress(
        `${DEPLOYMENT} has ${read?.replicaCount ?? "?"} replicas, ${Math.round((now() - lastRequest) / 1000)} s after the answer`,
      );
      if (read && (read.replicaCount ?? 0) === 0) {
        zeroAt = now();
        break;
      }
      // Seen up: the deployment ran at least until this read, and a run killed from here is charged from it, not from
      // the last request (completion round 2).
      touchWake(wake, now());
    }
    // Read at 0 replicas: used to that moment; otherwise to the answer plus the tail.
    // Still up when the polling stopped: it ran at least until now, and the tail is charged from now, never from the
    // answer (§14 completion review G2).
    activity =
      zeroAt === null
        ? { lastAnswerAt: new Date(lastRequest), lastDeadlineAt: new Date(now()) }
        : { zeroAt: new Date(zeroAt) };
    // The receipt's wake as the ledger charges it: to scale to zero, or to the end of the polling plus the tail.
    const end = zeroAt ?? now() + TAIL_MINUTES * 60_000;
    const receipt: WarmupReceipt = {
      version,
      started_at: new Date(started).toISOString(),
      initial: { state: before.state ?? null, replicas: before.replicaCount ?? 0, updated: before.updateTime ?? null },
      attempts: one.attempts,
      // A first request that answered with no cold-start reply found the deployment warm: no warm-up to measure.
      cold: one.firstScalingAt !== null,
      warmup_ms: one.firstScalingAt === null ? null : one.answeredAt - one.firstScalingAt,
      answered_ms: one.answeredAt - started,
      zero_ms_after_last_request: zeroAt === null ? null : zeroAt - lastRequest,
      within_7_minutes: zeroAt === null ? false : zeroAt - lastRequest <= 7 * 60_000,
      wake_minutes: Math.round(((end - started) / 60_000) * 10) / 10,
    };
    const dir = options.dir ?? warmupDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${receipt.started_at.replace(/[:.]/g, "-")}.json`);
    writeFileSync(`${file}.tmp`, `${JSON.stringify(receipt, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
    return receipt;
  } finally {
    // A wake that failed before its answer may have kept the deployment up until now.
    await settleWake(ledger, wake, Object.keys(activity).length ? activity : { lastDeadlineAt: new Date(now()) });
  }
}

// The warm-ups measured so far, from their receipts: the cold ones' median and maximum, and scale to zero.
export function warmupSummary(dir = warmupDir()) {
  const receipts = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => JSON.parse(readFileSync(join(dir, name), "utf-8")) as WarmupReceipt)
    : [];
  const cold = receipts.filter((r) => r.cold && r.warmup_ms !== null).map((r) => r.warmup_ms as number);
  const sorted = [...cold].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return {
    receipts: receipts.length,
    cold: cold.length,
    median_s: sorted.length
      ? (sorted.length % 2
          ? (sorted[middle] as number)
          : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2) / 1000
      : null,
    max_s: sorted.length ? (sorted.at(-1) as number) / 1000 : null,
    scale_to_zero_s: receipts.map((r) =>
      r.zero_ms_after_last_request === null ? null : r.zero_ms_after_last_request / 1000,
    ),
    all_within_7_minutes: receipts.length > 0 && receipts.every((r) => r.within_7_minutes === true),
  };
}

export function readKey(item: string = ADMIN_ITEM): string {
  let key: string;
  try {
    key = execFileSync("conclave-op", ["read", `op://Conclave/${item}/credential`], {
      encoding: "utf-8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    // Named by its code only: what conclave-op printed stays out of the message.
    const code = (error as NodeJS.ErrnoException).code ?? `exit ${(error as { status?: number }).status ?? "?"}`;
    throw new Error(`reading the vault item "${item}" failed (${code})`);
  }
  if (!key) throw new Error(`the vault item "${item}" has an empty credential`);
  return key;
}

export const USAGE =
  "usage: node scripts/glimmer/deploy.ts ensure <version> | stop | start | status | eval-up <version> | eval-down <version> | key-check <version> | warmup <version> | warmup-summary | minutes | import-wakes | reconcile <reservation id> | promote <version> | rollback | release";
// The command line, read before any key: a command it does not know, or one missing its version, is usage, and no
// credential is read for it.
export function parseCommand(args: string[]): { command: string; version?: string; id?: string } | null {
  const [command, version] = args;
  if (
    command === "reconcile" &&
    args.length === 2 &&
    version &&
    /^local:[a-z -]+:[0-9TZ:.-]+:[0-9a-f-]{36}$/.test(version)
  )
    return { command, id: version };
  const bare = ["stop", "start", "status", "warmup-summary", "minutes", "import-wakes", "rollback", "release"];
  const versioned = ["ensure", "eval-up", "eval-down", "key-check", "warmup", "promote"];
  if (command && bare.includes(command) && version === undefined) return { command };
  if (command && versioned.includes(command) && version && /^[1-9]\d?\.\d{1,2}$/.test(version) && args.length === 2)
    return { command, version };
  return null;
}

if (import.meta.filename === process.argv[1]) {
  const parsed = parseCommand(process.argv.slice(2));
  if (!parsed) {
    console.error(USAGE);
    process.exit(2);
  }
  const { command, version } = parsed;
  configureNetwork();
  const evaluation = command === "eval-up" || command === "eval-down";
  const summary = (d: Deployment | null) =>
    d && {
      name: d.name,
      model: d.baseModel,
      state: d.state,
      replicas: d.replicaCount,
      min: d.minReplicaCount,
      max: d.maxReplicaCount,
      scaleToZero: d.autoscalingPolicy?.scaleToZeroWindow,
      gpu: `${d.acceleratorCount ?? "?"} x ${d.acceleratorType ?? "?"}`,
      preemptible: d.preemptible === true,
      updated: d.updateTime,
    };
  try {
    // The ledger's commands need no Fireworks key.
    if (command === "minutes") {
      console.log(JSON.stringify(await ledgerStatus(wranglerExec(), new Date()), null, 2));
      process.exit(0);
    }
    // Saved warm-up receipts read with no key: a vault that cannot be reached never hides measurements (§13 completion
    // review gap 5).
    if (command === "warmup-summary") {
      console.log(JSON.stringify(warmupSummary(), null, 2));
      process.exit(0);
    }
    if (command === "reconcile") {
      const result = await reconcileWake(wranglerExec(), parsed.id as string);
      console.log(JSON.stringify(result, null, 2));
      // Only a refusal or a pending settlement is a non-zero exit: the reservation then stays counted in full.
      process.exit(result.outcome === "settled" || result.outcome === "already-settled" ? 0 : 1);
    }
    if (command === "release") {
      // The release step (D03 T04 §36): carries the active file this checkout holds into production and proves it
      // there. It needs no Fireworks key; its stages honour the one deadline `release` sets.
      const { release, readActive } = await import("./promote.ts");
      const { activeVersionFromWrangler, runCommand, runSmoke, screenThroughWorker, tokenFromVault } = await import(
        "../smoke.ts"
      );
      const { dirname, join: joinPath } = await import("node:path");
      const root = joinPath(dirname(import.meta.filename), "../..");
      const base = "https://isitlegit.derick-f5a.workers.dev";
      const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
      const result = await release({
        commit,
        activeVersion: readActive(joinPath(root, "src/vision/glimmer-active.json")).version,
        preflight: async () => {
          const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf-8" }).trim();
          if (dirty) throw new Error("the working tree is not clean; commit the release first");
          const migrations = await runCommand(
            "pnpm",
            ["exec", "wrangler", "d1", "migrations", "list", "DB", "--remote"],
            "",
            Date.now() + 60_000,
          );
          if (!migrations.includes("No migrations to apply"))
            throw new Error("remote migrations are pending; apply them before deploying (docs/operations.md)");
        },
        servingState: () => activeVersionFromWrangler(Date.now() + 60_000),
        deployWorker: async (deadline) => {
          await runCommand("pnpm", ["exec", "wrangler", "deploy", "--var", `COMMIT_SHA:${commit}`], "", deadline);
        },
        waitHealth: async (expected, deadline) => {
          for (;;) {
            try {
              const health = (await (await fetch(`${base}/health`)).json()) as { commit?: string };
              if (health.commit === expected) return;
            } catch {
              // Not there yet: keep waiting until the deadline.
            }
            if (Date.now() >= deadline) throw new Error(`/health did not report ${expected} before the deadline`);
            await new Promise((done) => setTimeout(done, 5_000));
          }
        },
        smoke: async (deadline) => {
          const outcome = await runSmoke(base, {
            commit,
            getToken: tokenFromVault,
            activeVersion: activeVersionFromWrangler,
            waitMs: Math.max(1_000, deadline - Date.now()),
          });
          if (!outcome.ok) throw new Error(`the smoke check failed: ${outcome.lines.join("; ")}`);
        },
        screenFixture: async (deadline) => screenThroughWorker(base, await tokenFromVault(deadline)),
      });
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.outcome === "released" ? 0 : 1);
    }
    if (command === "promote" || command === "rollback") {
      // Loaded here, not at the top: promote.ts imports this file.
      const { promote, rollback, runGate, report } = await import("./promote.ts");
      const { dirname, join: joinPath } = await import("node:path");
      const root = joinPath(dirname(import.meta.filename), "../..");
      const adminKey = readKey();
      const deps = {
        activeFile: joinPath(root, "src/vision/glimmer-active.json"),
        stateFile: joinPath(wakeEvidenceDir(), "..", "promotion.json"),
        gate: runGate,
        deployments: (deployment: string) => openDeployments(adminKey, fetch, deployment),
        probe: (v: string, deployment: string, purpose: "promotion" | "rollback") =>
          checkInferenceKey(
            v,
            readKey(INFERENCE_KEY_ITEM),
            fetch,
            undefined,
            undefined,
            undefined,
            wranglerExec(),
            undefined,
            undefined,
            deployment,
            purpose,
          ),
      };
      const result = command === "promote" ? await promote(version as string, deps) : await rollback(deps);
      const { text, code } = report(result, deps.activeFile);
      console.log(text);
      process.exit(code);
    }
    if (command === "import-wakes") {
      console.log(JSON.stringify(await importWakes(wranglerExec())));
      process.exit(0);
    }
    // The key is read inside the command's own error path: a vault that refuses fails as the command, by name.
    const target = evaluation ? evalDeployment(version as string) : DEPLOYMENT;
    const deployments = openDeployments(readKey(), fetch, target);
    if (command === "ensure" && version) {
      const { created, deployment } = await deployments.ensure(version);
      console.log(JSON.stringify({ created, ...summary(deployment) }, null, 2));
    } else if (command === "stop") console.log(JSON.stringify(summary(await deployments.stop()), null, 2));
    else if (command === "start") console.log(JSON.stringify(summary(await deployments.start()), null, 2));
    else if (command === "status") console.log(JSON.stringify(summary(await deployments.status()), null, 2));
    else if (command === "eval-up" && version) {
      const { created } = await deployments.ensurePreemptible(version);
      console.log(JSON.stringify({ created, ...summary(await deployments.waitReady()) }, null, 2));
    } else if (command === "key-check" && version) {
      // A deployment still being created answers inference with 404: the proof starts only once it reads READY.
      checkPriced(await deployments.waitReady());
      console.log(JSON.stringify(await checkInferenceKey(version, readKey(INFERENCE_KEY_ITEM)), null, 2));
    } else if (command === "warmup" && version) {
      console.log(JSON.stringify(await measureWarmup(version, readKey(INFERENCE_KEY_ITEM), deployments), null, 2));
    } else if (command === "eval-down") {
      const left = await deployments.remove();
      if (left) throw new Error(`${target} is still there after the delete (state ${left.state})`);
      console.log(JSON.stringify({ deleted: target }));
    }
  } catch (error) {
    console.error(`deploy: ${(error as Error).message}`);
    process.exit(1);
  }
}
