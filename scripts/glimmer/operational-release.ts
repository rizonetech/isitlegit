// Exact operator-authorized submission rollout. Statistical promotion remains a separate, unchanged gate.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_WARMUP_SECONDS, targetOf } from "../../src/vision/glimmer-caps.ts";
import type { Exec } from "../../src/vision/glimmer-minutes.ts";
import { BrandFreePageAnswer, SCREENER_SYSTEM_PROMPT_V1_1 } from "../../src/vision/page-screen.ts";
import { API, configureNetwork } from "../fireworks-check.ts";
import {
  type Fetch,
  openDeployments,
  readKey,
  reserveWake,
  settleWake,
  touchWake,
  type Wake,
  wakeEvidenceDir,
} from "./deploy.ts";
import { askLoupe, INFERENCE_KEY_ITEM, requestOf } from "./evaluate.ts";
import { type Gate, OPERATIONAL_RELEASE_AUTHORIZATION, promote, runGate } from "./promote.ts";
import { wranglerExec } from "./runtime-ledger.ts";

const MANIFEST_SHA = "5722055c70fb41c9bb43db9d04f10115b85f79857cebd9b2d3797e609c19ad67";
const RATE = 12;
const WINDOW_MS = 20 * 60_000;
const ZERO_MS = 8 * 60_000;
export function operationalMessages(path: string) {
  const bytes = readFileSync(path);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), MANIFEST_SHA, "wrong frozen diagnostic manifest");
  const manifest = JSON.parse(bytes.toString());
  const data = readFileSync(join(manifest.preflight.dataset, "eval.jsonl"));
  assert.equal(createHash("sha256").update(data).digest("hex"), manifest.preflight.evaluationSha256);
  const messages = requestOf(data.toString().split("\n")[0] as string);
  assert.equal(messages[0]?.content, SCREENER_SYSTEM_PROMPT_V1_1, "wrong trained prompt");
  return messages;
}
export async function operationalRelease(options: {
  root: string;
  artifactRecord: string;
  messages: ReturnType<typeof requestOf>;
  adminKey: string;
  inferenceKey: string;
  ledger: Exec;
  fetcher?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  evidenceDir?: string;
  gate?: (version: string, previous: string) => Gate;
}) {
  // This digest binds the training output-model.json record, not a downloaded weight-file digest.
  // Provider registration and deployment baseModel are verified separately before inference.
  const artifactBytes = readFileSync(options.artifactRecord);
  assert.equal(
    createHash("sha256").update(artifactBytes).digest("hex"),
    OPERATIONAL_RELEASE_AUTHORIZATION.outputModelSha256,
    "output model record hash differs",
  );
  const artifact = JSON.parse(artifactBytes.toString());
  assert.equal(artifact.model_id, "isitlegit-loupe-1-1");
  assert.equal(artifact.job_id, OPERATIONAL_RELEASE_AUTHORIZATION.trainingJob);
  assert.equal(artifact.checkpoint, "step-4524");
  const messages = options.messages;
  assert.equal(messages[0]?.content, SCREENER_SYSTEM_PROMPT_V1_1, "wrong trained prompt");
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const fetcher = options.fetcher ?? fetch;
  const until = now() + WINDOW_MS;
  let wake: Wake | undefined;
  let shape: string | undefined;
  let providerRequestId: string | undefined;
  const deployment = OPERATIONAL_RELEASE_AUTHORIZATION.deployment;
  const bounded: Fetch = async (url, init) => {
    const remaining = until - now();
    assert(remaining > 0, "operational release deadline reached");
    if (wake) touchWake(wake, until + ZERO_MS);
    const response = await fetcher(url, {
      ...init,
      signal: AbortSignal.any([
        ...(init.signal ? [init.signal] : []),
        AbortSignal.timeout(Math.min(60_000, remaining)),
      ]),
      redirect: "error",
    });
    if (url.includes("chat/completions") && response.ok) {
      const body = (await response.clone().json()) as { id?: unknown };
      providerRequestId = response.headers.get("x-request-id") ?? (typeof body.id === "string" ? body.id : undefined);
    }
    return response;
  };
  const clients = (id: string) => {
    const client = openDeployments(options.adminKey, bounded, id);
    return {
      ...client,
      ensure: async (version: string) => {
        assert.equal(id, deployment);
        const found = await client.status();
        assert(!found, "operational candidate must be a fresh dedicated deployment");
        const registered = await bounded(`${API}/models/${artifact.model_id}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${options.adminKey}` },
        });
        assert(registered.ok, "candidate model registration lookup failed");
        const registration = (await registered.json()) as {
          name?: string;
          state?: string;
          peftDetails?: { baseModel?: string; r?: number };
          kind?: string;
        };
        assert.equal(registration.name, targetOf(version, id).model.split("#")[0]);
        assert.equal(registration.state, "READY");
        assert.equal(registration.kind, "HF_PEFT_ADDON");
        assert.equal(registration.peftDetails?.baseModel, "accounts/fireworks/models/muse-glimmer-30b");
        assert.equal(registration.peftDetails?.r, 8);
        const match = await bounded(`${API}/deploymentShapeVersions:match`, {
          method: "POST",
          headers: { Authorization: `Bearer ${options.adminKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            createDeploymentRequest: { deployment: { baseModel: targetOf(version, id).model.split("#")[0] } },
          }),
        });
        assert(match.ok, "deployment shape lookup failed");
        const body = (await match.json()) as {
          deploymentShapeVersions?: {
            name: string;
            validated?: boolean;
            snapshot?: { acceleratorType?: string; acceleratorCount?: number };
          }[];
        };
        shape = body.deploymentShapeVersions?.find(
          (s) =>
            s.validated === true &&
            s.snapshot?.acceleratorType === "NVIDIA_H200_141GB" &&
            s.snapshot.acceleratorCount === 1,
        )?.name;
        assert(shape, "no validated H200/1 shape");
        wake = await reserveWake(
          options.ledger,
          "operational promotion",
          34,
          new Date(now()),
          options.evidenceDir,
          id,
          RATE,
        );
        touchWake(wake, until + ZERO_MS);
        const pinned: Fetch = (url, init) =>
          bounded(
            url,
            init.method === "POST" && url.includes("?deploymentId=")
              ? { ...init, body: JSON.stringify({ ...JSON.parse(String(init.body)), deploymentShape: shape }) }
              : init,
          );
        return openDeployments(options.adminKey, pinned, id).ensure(version);
      },
      waitReady: () => client.waitReady(Math.max(1, until - now()), 5000, sleep, now),
    };
  };
  const result = await promote("1.1", {
    activeFile: join(options.root, "src/vision/glimmer-active.json"),
    stateFile: join(options.evidenceDir ?? wakeEvidenceDir(), "operational-promotion.json"),
    gate: options.gate ?? runGate,
    deployments: clients,
    now: () => new Date(now()),
    probe: async () => {
      throw new Error("ordinary permission probe is not an operational smoke");
    },
    operationalRelease: {
      authorization: OPERATIONAL_RELEASE_AUTHORIZATION,
      smoke: async (version, id) => {
        assert(wake, "missing accounted wake");
        const model = targetOf(version, id).model;
        const reply = await askLoupe(options.inferenceKey, model, {
          fetcher: bounded,
          requestMs: 60_000,
          maxWaitMs: MAX_WARMUP_SECONDS * 1000,
          deadlineAt: until,
          now,
          sleep,
        })(messages);
        assert(!reply.incomplete, "incomplete operational smoke");
        const answer = BrandFreePageAnswer.parse(JSON.parse(reply.text));
        assert(providerRequestId, "provider omitted request identity");
        return {
          version,
          deployment: id,
          model,
          outputModelSha256: OPERATIONAL_RELEASE_AUTHORIZATION.outputModelSha256,
          promptSha256: createHash("sha256").update(SCREENER_SYSTEM_PROMPT_V1_1).digest("hex"),
          providerRequestId,
          reservationId: wake.id,
          observedAt: new Date(now()).toISOString(),
          answer,
        };
      },
    },
  });
  // Keep the reservation while the dedicated target is still running or its state is unknown. No deletion of rollback resources.
  if (wake) {
    const zeroUntil = now() + ZERO_MS;
    const readClient = openDeployments(
      options.adminKey,
      (url, init) => {
        const remaining = zeroUntil - now();
        assert(remaining > 0, "zero-replica readback deadline reached");
        return fetcher(url, {
          ...init,
          signal: AbortSignal.any([
            ...(init.signal ? [init.signal] : []),
            AbortSignal.timeout(Math.min(60_000, remaining)),
          ]),
          redirect: "error",
        });
      },
      deployment,
    );
    while (now() < zeroUntil) {
      const read = await readClient.status();
      if (read?.state === "READY" && read.replicaCount === 0) {
        await settleWake(options.ledger, wake, { zeroAt: new Date(now()) });
        return { result, accounting: "settled", reservationId: wake.id };
      }
      touchWake(wake, zeroUntil);
      await sleep(15_000);
    }
    return { result, accounting: "reservation retained, zero replicas unverified", reservationId: wake.id };
  }
  return { result, accounting: "no capacity requested" };
}
if (import.meta.filename === process.argv[1]) {
  configureNetwork();
  const manifest = process.argv[2];
  const artifactRecord = process.argv[3];
  assert(
    manifest && artifactRecord && process.argv.length === 4,
    "usage: operational-release.ts ABS_FROZEN_V2_MANIFEST ABS_OUTPUT_MODEL_RECORD",
  );
  const result = await operationalRelease({
    root: join(import.meta.dirname, "../.."),
    artifactRecord,
    messages: operationalMessages(manifest),
    adminKey: readKey(),
    inferenceKey: readKey(INFERENCE_KEY_ITEM),
    ledger: wranglerExec(),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.result.outcome === "promoted" ? 0 : 1;
}
