// One coordinator-authorized diagnostic pair, never promotion or production model selection.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  DEPLOYED_GPU,
  DEPLOYED_GPU_COUNT,
  MAX_WARMUP_SECONDS,
  TAIL_MINUTES,
  targetOf,
} from "../../src/vision/glimmer-caps.ts";
import type { Exec } from "../../src/vision/glimmer-minutes.ts";
import { ACCOUNT, API, configureNetwork } from "../fireworks-check.ts";
import {
  checkPriced,
  checkReadBack,
  type Deployment,
  evalDeployment,
  modelOf,
  readKey,
  reserveWake,
  settleWake,
  touchWake,
  wakeEvidenceDir,
} from "./deploy.ts";
import {
  askLoupe,
  COMPLETIONS_URL,
  INFERENCE_KEY_ITEM,
  indexLines,
  readMetas,
  runAnswers,
  StopRun,
} from "./evaluate.ts";
import { wranglerExec } from "./runtime-ledger.ts";

// Published H200 $8/hour with the published 1.5x regional premium. This is a conservative admission
// estimate, not a provider billing guarantee. Unknown shutdown retains the entire reservation and lock.
export const DIAGNOSTIC_RATE = 12;
export const RUN_MS = 20 * 60_000;
export const SHUTDOWN_MS = 2 * 60_000;
export const RESERVE_MINUTES = (RUN_MS + SHUTDOWN_MS) / 60_000 + TAIL_MINUTES;
export const PAIR_RESERVE_USD = (2 * RESERVE_MINUTES * DIAGNOSTIC_RATE) / 60;
const REQUEST_MS = 60_000;
const EXPECTED = [
  ["1.0", "isitlegit-loupe-1-0", "step-6503", "ts-026d14227a0042128f9dd410c648d329"],
  ["1.1", "isitlegit-loupe-1-1", "step-4524", "ts-db85d8de82174aa6824b775ca6e40075"],
] as const;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function diagnosticTarget(version: string): string {
  assert(version === "1.0" || version === "1.1", "unapproved diagnostic version");
  return `accounts/${ACCOUNT}/deployments/${evalDeployment(version)}`;
}
export function diagnosticModel(version: string): string {
  diagnosticTarget(version);
  return targetOf(version, evalDeployment(version)).model;
}
export function verifyTarget(read: Deployment, version: string): void {
  assert.equal(read.name, diagnosticTarget(version), "wrong deployment");
  assert.equal(read.baseModel, modelOf(version), "wrong artifact");
  assert.equal(read.state, "READY", "deployment not ready");
  assert.equal(read.preemptible, true, "diagnostic requires preemptible capacity");
  checkReadBack(read, 1);
  checkPriced(read, evalDeployment(version));
}
function durable(path: string, value: unknown): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function prepareInputs(manifestPath: string, digest: string, output: string): string {
  assert(isAbsolute(manifestPath) && isAbsolute(output), "absolute manifest and result paths required");
  assert.match(digest, /^[a-f0-9]{64}$/);
  const bytes = readFileSync(manifestPath);
  assert.equal(hash(bytes), digest, "manifest digest differs");
  const manifest = JSON.parse(bytes.toString());
  const p = manifest.preflight;
  assert.equal(manifest.promotionEligible, false, "diagnostic only");
  assert.equal(p.rows, 40);
  assert(isAbsolute(p.dataset));
  assert.deepEqual(
    p.models.map((m: Record<string, string>) => [m.version, m.model_id, m.checkpoint, m.job_id]),
    EXPECTED,
  );
  assert(
    !resolve(output).startsWith(`${resolve(p.dataset)}/`) && resolve(output) !== resolve(p.dataset),
    "results must be separate from frozen inputs",
  );
  const files = [
    ["eval.jsonl", p.evaluationSha256],
    ["eval.meta.jsonl", p.metadataSha256],
    ["summary.json", p.summarySha256],
  ];
  const snapshots = files.map(([name, sha]) => {
    const data = readFileSync(join(p.dataset, name));
    assert.equal(hash(data), sha, `input digest differs: ${name}`);
    return { name, data };
  });
  const summarySnapshot = snapshots[2];
  assert(summarySnapshot);
  const summary = JSON.parse(summarySnapshot.data.toString());
  assert.equal(summary.sha256?.evaluation, p.evaluationSha256);
  assert.equal(summary.brandAsTruth, false, "both models require the common brand-free contract");
  const metas = readMetas(join(p.dataset, "eval.meta.jsonl"));
  assert.equal(metas.length, 40);
  assert.equal(new Set(metas.map((m) => m.id)).size, 40);
  assert.deepEqual(
    metas.map((m) => m.id),
    manifest.pages.map((m: { id: string }) => m.id),
  );
  assert.equal(indexLines(join(p.dataset, "eval.jsonl")).spans.length, 40);
  // Exclusive directory prevents accidental resume, mixing or replacement of an earlier result.
  mkdirSync(output, { mode: 0o700 });
  durable(join(output, "admission.json"), {
    manifestSha256: digest,
    diagnosticOnly: true,
    rateUsd: DIAGNOSTIC_RATE,
    reserveMinutesPerTarget: RESERVE_MINUTES,
    pairReserveUsd: PAIR_RESERVE_USD,
    billingGuarantee: false,
  });
  const dataset = join(output, "dataset");
  mkdirSync(dataset, { mode: 0o700 });
  for (const { name, data } of snapshots) writeFileSync(join(dataset, name), data, { flag: "wx", mode: 0o400 });
  writeFileSync(join(output, "manifest.json"), bytes, { flag: "wx", mode: 0o400 });
  return dataset;
}
type Dependencies = {
  ledger: Exec;
  adminKey: string;
  inferenceKey: string;
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  evidenceDir?: string;
  run?: typeof runAnswers;
  smoke?: boolean;
};
export async function executeSlot(version: string, dataset: string, output: string, dependencies: Dependencies) {
  const { ledger, adminKey, inferenceKey } = dependencies;
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
  const target = diagnosticTarget(version);
  const model = diagnosticModel(version);
  const url = `${API}/deployments/${evalDeployment(version)}`;
  const start = now();
  const runUntil = start + RUN_MS;
  const shutdownUntil = runUntil + SHUTDOWN_MS;
  let wake: Awaited<ReturnType<typeof reserveWake>> | undefined;
  let touched = false;
  let closed = false;
  async function request(endpoint: string, method: string, body: unknown, until: number) {
    const ms = Math.min(REQUEST_MS, until - now());
    assert(ms > 0, "diagnostic deadline reached");
    if (wake) touchWake(wake, now() + ms);
    const response = await fetcher(endpoint, {
      method,
      headers: { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(ms),
      redirect: "error",
    });
    if (response.status === 404 && method === "GET") return null;
    // Never propagate management response content into diagnostics or chat.
    if (!response.ok) {
      // An explicit create/undelete conflict never grants ownership of the other caller's capacity.
      // Keep the reservation for reconciliation instead of deleting or claiming zero runtime.
      if (method === "POST" && response.status === 409) touched = false;
      throw new Error(`diagnostic management ${method} status ${response.status}`);
    }
    return JSON.parse((await response.text()) || "{}");
  }
  // Existing live targets belong to another run. Never take them over or delete them.
  const before = await request(url, "GET", undefined, runUntil);
  assert(!before || before.state === "DELETED", "diagnostic target already active");
  if (before) {
    assert.equal(before.name, target);
    assert.equal(before.baseModel, modelOf(version));
    assert.equal(before.preemptible, true);
    checkReadBack(before, 1);
    checkPriced(before);
  }
  // Match is metadata only. Pin an actual validated H200/1 shape before any capacity mutation.
  const matching = await request(
    `${API}/deploymentShapeVersions:match`,
    "POST",
    { createDeploymentRequest: { deployment: { baseModel: modelOf(version) } } },
    runUntil,
  );
  const shape = matching?.deploymentShapeVersions?.find(
    (s: { name?: string; validated?: boolean; snapshot?: { acceleratorType?: string; acceleratorCount?: number } }) =>
      s.validated === true &&
      s.snapshot?.acceleratorType === DEPLOYED_GPU &&
      s.snapshot?.acceleratorCount === DEPLOYED_GPU_COUNT,
  );
  assert(typeof shape?.name === "string", "no validated H200/1 shape for this artifact");
  wake = await reserveWake(
    ledger,
    `diagnostic-${version}`,
    RESERVE_MINUTES,
    new Date(now()),
    dependencies.evidenceDir,
    evalDeployment(version),
    DIAGNOSTIC_RATE,
  );
  // A killed process keeps a full-window durable liability, even before its first inference.
  touchWake(wake, shutdownUntil);
  durable(join(output, `${version}.reservation.json`), {
    id: wake.id,
    target,
    artifact: modelOf(version),
    shape: shape.name,
    runUntil,
    shutdownUntil,
  });
  try {
    touched = true;
    if (before) await request(`${url}:undelete`, "POST", {}, runUntil);
    else
      await request(
        `${API}/deployments?deploymentId=${evalDeployment(version)}`,
        "POST",
        {
          baseModel: modelOf(version),
          deploymentShape: shape.name,
          minReplicaCount: 0,
          maxReplicaCount: 1,
          preemptible: true,
          autoscalingPolicy: { scaleToZeroWindow: "300s" },
        },
        runUntil,
      );
    let read: Deployment;
    for (;;) {
      read = await request(url, "GET", undefined, runUntil);
      assert(
        read && read.state !== "FAILED" && read.state !== "DELETED" && read.state !== "DELETING",
        "target failed readiness",
      );
      if (read.state === "READY") break;
      assert(now() + 5000 < runUntil, "readiness deadline reached");
      await sleep(5000);
    }
    verifyTarget(read, version);
    durable(join(output, `${version}.target.json`), {
      name: read.name,
      baseModel: read.baseModel,
      state: read.state,
      acceleratorType: read.acceleratorType,
      acceleratorCount: read.acceleratorCount,
      minReplicaCount: read.minReplicaCount,
      maxReplicaCount: read.maxReplicaCount,
      replicaCount: read.replicaCount,
      preemptible: read.preemptible,
      autoscalingPolicy: read.autoscalingPolicy,
    });
    const ask = askLoupe(inferenceKey, model, {
      requestMs: REQUEST_MS,
      deadlineAt: runUntil,
      maxWaitMs: MAX_WARMUP_SECONDS * 1000,
      now,
      sleep,
      fetcher: async (endpoint, init) => {
        assert.equal(endpoint, COMPLETIONS_URL);
        assert.equal(JSON.parse(String(init.body)).model, model);
        assert(now() + REQUEST_MS <= runUntil, "inference deadline reached");
        assert(wake);
        touchWake(wake, now() + REQUEST_MS);
        const response = await fetcher(endpoint, { ...init, redirect: "error" });
        if ([400, 401, 403, 404].includes(response.status)) {
          const failure = (await response
            .clone()
            .json()
            .catch(() => ({}))) as { error?: { code?: unknown; type?: unknown; param?: unknown; message?: unknown } };
          const error = failure.error ?? {};
          const safe = (value: unknown) =>
            typeof value === "string"
              ? value.split(adminKey).join("[credential]").split(inferenceKey).join("[credential]").slice(0, 800)
              : null;
          const message = safe(error.message);
          // Only infrastructure messages, never echoed prompt/image content or successful model payloads.
          durable(join(output, `${version}.inference-failure.json`), {
            status: response.status,
            code: safe(error.code),
            type: safe(error.type),
            parameter: safe(error.param),
            message:
              message &&
              /model|deployment|permission|access|route/i.test(message) &&
              !/data:image|base64|image_url|messages|untrusted/i.test(message)
                ? message
                : null,
          });
          throw new StopRun(`diagnostic inference binding refused HTTP ${response.status}; no further pages sent`);
        }
        return response;
      },
    });
    let started = 0;
    const measuredAsk: typeof ask = async (messages) => {
      if (dependencies.smoke && started >= 1) throw new StopRun("SMOKE_COMPLETE");
      started++;
      return ask(messages);
    };
    const result = await (dependencies.run ?? runAnswers)({
      dataset,
      runs: join(output, version),
      screener: "loupe",
      model,
      ask: measuredAsk,
      concurrency: 1,
      retryErrors: false,
      maxMs: Math.max(0, runUntil - now()),
      wall: now,
      preflight: (remaining) => (remaining === 40 ? null : "diagnostic requires exactly 40 fresh pages"),
    });
    durable(join(output, `${version}.result.json`), result);
    assert.equal(result.asked, dependencies.smoke ? 1 : 40, "incomplete diagnostic cohort");
    if (dependencies.smoke) {
      assert.equal(result.answered, 1, "single-page smoke did not return a valid answer");
      assert.equal(result.stopped, "SMOKE_COMPLETE");
    } else assert(!result.stopped, "diagnostic stopped early");
    return result;
  } finally {
    if (touched) {
      try {
        // This exact temporary target only. Unknown deletion is never reported as stopped or settled.
        await request(url, "DELETE", undefined, shutdownUntil);
        for (;;) {
          const after = await request(url, "GET", undefined, shutdownUntil);
          if (!after || after.state === "DELETED") {
            closed = true;
            break;
          }
          assert(now() + 1000 < shutdownUntil, "shutdown deadline reached");
          await sleep(1000);
        }
      } finally {
        durable(join(output, `${version}.shutdown.json`), {
          target,
          confirmedDeleted: closed,
          at: new Date(now()).toISOString(),
          reservationRetainedIfUnsettled: true,
        });
        if (closed) await settleWake(ledger, wake, { zeroAt: new Date(now()) });
      }
    }
  }
}
export async function diagnosticPair(manifest: string, digest: string, output: string, dependencies: Dependencies) {
  assert(PAIR_RESERVE_USD <= 20);
  const dataset = prepareInputs(manifest, digest, output);
  const evidence = dependencies.evidenceDir ?? wakeEvidenceDir();
  mkdirSync(evidence, { recursive: true });
  const lock = join(evidence, "diagnostic-pair.lock");
  durable(lock, { output, manifestSha256: digest, pid: process.pid, at: new Date().toISOString() });
  // Any failure retains this exclusive lock for explicit readback/recovery, never an automatic second cohort.
  durable(join(output, "mode.json"), { mode: dependencies.smoke ? "candidate-single-page-smoke" : "paired40" });
  for (const [version] of dependencies.smoke ? EXPECTED.slice(1) : EXPECTED)
    await executeSlot(version, dataset, output, dependencies);
  rmSync(lock);
}
if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  const smoke = args[0] === "--smoke";
  if (smoke) args.shift();
  const [manifest, digest, output] = args;
  if (!manifest || !digest || !output || args.length !== 3)
    throw new Error("usage: node scripts/glimmer/diagnostic-pair.ts [--smoke] ABS_MANIFEST SHA256 NEW_ABS_RESULTS");
  configureNetwork();
  // The only live entry point owns ledger admission, target lifecycle and inference together.
  diagnosticPair(manifest, digest, output, {
    smoke,
    ledger: wranglerExec(),
    adminKey: readKey(),
    inferenceKey: readKey(INFERENCE_KEY_ITEM),
  }).catch(() => {
    console.error(
      "Diagnostic stopped; inspect bounded result/shutdown evidence and retained reservation. No automatic retry.",
    );
    process.exitCode = 1;
  });
}
