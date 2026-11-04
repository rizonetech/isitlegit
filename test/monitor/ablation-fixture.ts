import { env } from "cloudflare:test";
import {
  captureDigest,
  manifestDigest,
  modelVersions,
  settingsDigest,
  sha256,
} from "../../src/monitor/ablation-manifest";
import { admitExperiment } from "../../src/monitor/ablation-store";
import { fakeJpeg } from "../fixtures/jpeg";
import { makeOrg } from "../trust/helpers";

const bytes = (s: string) => new TextEncoder().encode(s);
export async function monitorFixture(parked = false, ownerOrg?: string, pageCount = 1) {
  const org = ownerOrg ?? (await makeOrg());
  const deployment = "a".repeat(40);
  const image = fakeJpeg(640, 480),
    text = bytes(parked ? "" : "A fictional login page");
  const signals = bytes(
    JSON.stringify({
      text: parked ? "" : "A fictional login page",
      inputs: parked ? 0 : 1,
      passwords: parked ? 0 : 1,
      forms: parked ? 0 : 1,
      iframes: 0,
      components: 0,
      hidden: 0,
    }),
  );
  const capture = {
    version: 1,
    pageId: "p1",
    provenanceDigest: "3".repeat(64),
    capturedAt: "2026-11-04T00:00:00.000Z",
    originalUrl: "https://candidate.example/start",
    finalUrl: "https://landing.example/",
    redirects: ["https://landing.example/"],
    screenshotSha256: await sha256(image),
    textSha256: await sha256(text),
    signalsSha256: await sha256(signals),
  };
  const captures = await Promise.all(
    Array.from({ length: pageCount }, async (_, index) => {
      const value = { ...capture, pageId: `p${index + 1}` };
      return { value, digest: await captureDigest(value) };
    }),
  );
  const manifest = {
    version: 1,
    kind: "monitor-screening",
    seed: "runner",
    deployment,
    modelVersions: modelVersions(),
    settingsDigest: await settingsDigest(deployment),
    pages: captures.map(({ value, digest }, index) => ({
      experimentCaseId: `e${index + 1}`,
      pageId: value.pageId,
      captureDigest: digest,
      labelDigest: "2".repeat(64),
    })),
  };
  const md = await manifestDigest(manifest);
  const objects: Record<string, Uint8Array> = {
    ...Object.fromEntries(
      captures.map(({ value, digest }) => [`eval/monitor-captures/${digest}.json`, bytes(JSON.stringify(value))]),
    ),
    [`eval/monitor-objects/${capture.screenshotSha256}.jpg`]: image,
    [`eval/monitor-objects/${capture.textSha256}.txt`]: text,
    [`eval/monitor-objects/${capture.signalsSha256}.json`]: signals,
    [`eval/monitor-manifests/${md}.json`]: bytes(JSON.stringify(manifest)),
    "eval/monitor-registry.json": bytes(JSON.stringify({ version: 1, deployment, manifests: [md] })),
  };
  for (const [key, value] of Object.entries(objects)) await env.ARTEFACTS.put(key, value);
  const admitted = async (arm: "full" | "no-screening") =>
    admitExperiment(
      env.DB,
      org,
      { experimentId: "runner", arm, manifestDigest: md, deployment, replayRunId: arm },
      manifest,
    );
  return {
    org,
    manifestDigest: md,
    deployment,
    admitted,
    runtime: {
      ...env,
      COMMIT_SHA: deployment,
      EVAL_ORG_ID: org,
      META_API_KEY: "test",
      CF_AIG_TOKEN: "test",
      META_GATEWAY_URL: "https://gateway.test/v1",
      FIREWORKS_API_KEY: "test",
      GLIMMER_GATEWAY_URL: "https://gateway.test/v1",
    },
  };
}
