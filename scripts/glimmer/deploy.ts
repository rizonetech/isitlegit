// Loupe's dedicated Fireworks deployment, scaled to zero after 5 idle minutes (D03 T04 §12).
//
//   node scripts/glimmer/deploy.ts ensure <version>   # create it, or find it, for isitlegit-loupe-<version>
//   node scripts/glimmer/deploy.ts stop               # minimum and maximum replicas to 0, the deployment kept
//   node scripts/glimmer/deploy.ts start              # maximum back to 1
//   node scripts/glimmer/deploy.ts status             # replicas, settings, state, last update
//   node scripts/glimmer/deploy.ts eval-up <version>  # a separate preemptible deployment for §13's held-out run, READY
//   node scripts/glimmer/deploy.ts eval-down          # delete it once the run is done
//   node scripts/glimmer/deploy.ts key-check <version> # the inference-only key answers the deployment, cannot change it
//
// Live merge: the fine-tuned model itself is the deployment's `baseModel`, with the `default` deployment shape, so
// Fireworks picks a shape that can merge it (https://docs.fireworks.ai/fine-tuning/deploying-loras); inference then
// names the model with no `#` suffix. The admin key ("IsItLegit Fireworks Admin") comes through conclave-op, is sent only
// in the Authorization header and is never printed. Every change is read back, and a read-back that does not show
// minimum 0, the maximum asked for and a 5-minute scale-to-zero window fails the command.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sastDay } from "../../src/meta/day.ts";
import { ACCOUNT, API, configureNetwork } from "../fireworks-check.ts";
import { COMPLETIONS_URL, INFERENCE_KEY_ITEM } from "./evaluate.ts";

export const DEPLOYMENT = "isitlegit-loupe";
// §13's held-out run goes to its own preemptible deployment (borrowed idle GPUs, no charge to hold capacity, preempted
// without warning; https://docs.fireworks.ai/guides/ondemand-deployments), never to the dedicated one or its minutes.
export const EVAL_DEPLOYMENT = "isitlegit-loupe-eval";
export const SCALE_TO_ZERO = "300s";
export const ADMIN_ITEM = "IsItLegit Fireworks Admin";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
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

export function openDeployments(key: string, fetcher: Fetch = fetch, deployment: string = DEPLOYMENT) {
  const url = `${API}/deployments/${deployment}`;
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  async function call(method: string, target: string, body?: unknown): Promise<Deployment | null> {
    const response = await fetcher(target, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    if ((method === "GET" || method === "DELETE") && response.status === 404) return null;
    const text = await response.text();
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
        if (found.preemptible !== true || (found.baseModel && found.baseModel !== modelOf(version)))
          throw new Error(
            `${deployment} exists but is not a preemptible deployment of ${modelOf(version)}; delete it with eval-down`,
          );
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
    ): Promise<Deployment> {
      const until = now() + timeoutMs;
      for (;;) {
        const read = await status();
        if (!read) throw new Error(`${deployment} is gone while waiting for it to be READY`);
        if (read.state === "READY") return read;
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
    ): Promise<Deployment> {
      let read = await update(["minReplicaCount", "maxReplicaCount"], { minReplicaCount: 0, maxReplicaCount: 0 }, 0);
      const until = now() + timeoutMs;
      while ((read.replicaCount ?? 0) > 0) {
        if (now() >= until)
          throw new Error(
            `${deployment} has maximum 0 but still runs ${read.replicaCount} replicas after ${timeoutMs / 60_000} minutes; read it again with status`,
          );
        await sleep(everyMs);
        const again = await status();
        if (!again) throw new Error(`${deployment} is gone while stopping`);
        read = again;
      }
      return read;
    },
    start: () => update(["maxReplicaCount"], { maxReplicaCount: 1 }, 1),
  };
}

// The dedicated deployment's minutes a day (the operator's 30) as this script spends them, until the Worker's ledger
// (§14) holds them: each wake is reserved before its first request at its worst case (the longest wait allowed plus
// the 5 idle minutes before scale to zero) and settled at what it took plus those 5 minutes. A wake that would take
// the SAST day past 30 minutes is refused before anything is sent. Written whole (temp then rename).
export const DAILY_MINUTES = 30;
export const IDLE_MINUTES = 5;
export type Wake = { day: string; at: string; purpose: string; reserved: number; used: number | null };
export const wakeLedgerFile = () =>
  join(process.env.GLIMMER_DATA_DIR ?? join(homedir(), "isitlegit-data", "glimmer"), "runs", "deployment-minutes.json");
export function readWakes(file: string): Wake[] {
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, "utf-8"));
  if (!Array.isArray(data)) throw new Error(`${file} is not a list of wakes`);
  return data as Wake[];
}
function saveWakes(file: string, wakes: Wake[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(wakes, null, 1)}\n`);
  renameSync(tmp, file);
}
export function reserveWake(file: string, purpose: string, minutes: number, at: Date): Wake {
  const wakes = readWakes(file);
  const day = sastDay(at);
  const spent = wakes.filter((w) => w.day === day).reduce((sum, w) => sum + (w.used ?? w.reserved), 0);
  if (spent + minutes > DAILY_MINUTES)
    throw new Error(
      `refused: a ${purpose} wake of up to ${minutes} minutes would take ${day} to ${spent + minutes} of the deployment's ${DAILY_MINUTES} daily minutes`,
    );
  const wake: Wake = { day, at: at.toISOString(), purpose, reserved: minutes, used: null };
  saveWakes(file, [...wakes, wake]);
  return wake;
}
export function settleWake(file: string, wake: Wake, minutes: number): void {
  const wakes = readWakes(file);
  const found = wakes.find((w) => w.at === wake.at && w.purpose === wake.purpose && w.used === null);
  if (!found) throw new Error(`the ${wake.purpose} wake at ${wake.at} is not in ${file}`);
  found.used = Math.round(minutes * 10) / 10;
  saveWakes(file, wakes);
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
  ledgerFile = wakeLedgerFile(),
): Promise<{ answered: { status: number; attempts: number; waitedMs: number }; change: { status: number } }> {
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  // The wake is the deployment's minutes: reserved at its worst case before the first request, settled after.
  const wake = reserveWake(ledgerFile, "key-check", Math.ceil(timeoutMs / 60_000) + IDLE_MINUTES, new Date(now()));
  const started = now();
  try {
    return await keyProof(version, headers, fetcher, timeoutMs, sleep, now, started);
  } finally {
    settleWake(ledgerFile, wake, (now() - started) / 60_000 + IDLE_MINUTES);
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
): Promise<{ answered: { status: number; attempts: number; waitedMs: number }; change: { status: number } }> {
  let attempts = 0;
  for (;;) {
    attempts++;
    const response = await fetcher(COMPLETIONS_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: `${modelOf(version)}#accounts/${ACCOUNT}/deployments/${DEPLOYMENT}`,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0,
      }),
    });
    const text = await response.text();
    if (response.ok) {
      if (!isCompletion(text)) throw new Error(`the one-token call answered ${response.status} with no completion`);
      const answered = { status: response.status, attempts, waitedMs: now() - started };
      const change = await fetcher(`${API}/deployments/${DEPLOYMENT}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(updateBody(["maxReplicaCount"], { maxReplicaCount: 1 })),
      });
      await change.text();
      if (change.ok) throw new Error(`the inference key was allowed to change ${DEPLOYMENT} (${change.status})`);
      if (change.status !== 401 && change.status !== 403)
        throw new Error(`the change with the inference key answered ${change.status}, not a refusal`);
      return { answered, change: { status: change.status } };
    }
    if (response.status !== 503 && response.status !== 429)
      throw new Error(`the one-token call answered ${response.status}`);
    if (now() - started >= timeoutMs)
      throw new Error(`the deployment did not answer within ${timeoutMs / 60_000} minutes (last ${response.status})`);
    await sleep(15_000);
  }
}

function readKey(item: string = ADMIN_ITEM): string {
  const key = execFileSync("conclave-op", ["read", `op://Conclave/${item}/credential`], {
    encoding: "utf-8",
    timeout: 60_000,
  }).trim();
  if (!key) throw new Error(`the vault item "${item}" has an empty credential`);
  return key;
}

if (import.meta.filename === process.argv[1]) {
  const [command, version] = process.argv.slice(2);
  configureNetwork();
  const evaluation = command === "eval-up" || command === "eval-down";
  const deployments = openDeployments(readKey(), fetch, evaluation ? EVAL_DEPLOYMENT : DEPLOYMENT);
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
      await deployments.waitReady();
      console.log(JSON.stringify(await checkInferenceKey(version, readKey(INFERENCE_KEY_ITEM)), null, 2));
    } else if (command === "eval-down") {
      const left = await deployments.remove();
      if (left) throw new Error(`${EVAL_DEPLOYMENT} is still there after the delete (state ${left.state})`);
      console.log(JSON.stringify({ deleted: EVAL_DEPLOYMENT }));
    } else {
      console.error(
        "usage: node scripts/glimmer/deploy.ts ensure <version> | stop | start | status | eval-up <version> | eval-down | key-check <version>",
      );
      process.exit(2);
    }
  } catch (error) {
    console.error(`deploy: ${(error as Error).message}`);
    process.exit(1);
  }
}
