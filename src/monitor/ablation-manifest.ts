// Read-only immutable input boundary for labelled monitor experiments. Registry publication belongs to the coordinator.
import { z } from "zod";
import { DEPLOYED_VERSION, modelNameOf } from "../vision/glimmer-caps";
import { ESCALATION_BAND, HOST, jpegSize, MAX_TEXT_CHARACTERS } from "../vision/page-screen";
import type { Page } from "../vision/screen";
import {
  MAX_ANSWER_TOKENS,
  SPARK_MAX_OUTPUT_TOKENS,
  SPARK_MODEL,
  SPARK_REASONING_EFFORT,
} from "../vision/screen-request";
import {
  EMPTY_MAX_SCREENSHOT,
  EMPTY_MAX_TEXT,
  IMAGE_LED_MAX_TEXT,
  IMAGE_LED_MIN_SCREENSHOT,
  MAX_HIDDEN_TEXT,
  PARKED_MAX_TEXT,
} from "./parked";
import { SCREEN_CALLS_PER_RUN } from "./run";

export const ExperimentId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const Deployment = z.string().regex(/^[a-f0-9]{40}$/);
export const Arm = z.enum(["full", "no-screening"]);
export const Trigger = z.strictObject({
  experimentId: ExperimentId,
  arm: Arm,
  manifestDigest: Digest,
  deployment: Deployment,
  replayRunId: ExperimentId,
});
export const ManifestPage = z.strictObject({
  experimentCaseId: ExperimentId,
  pageId: ExperimentId,
  captureDigest: Digest,
  labelDigest: Digest,
});
export type ManifestPage = z.infer<typeof ManifestPage>;
const Models = z.strictObject({ loupe: z.string().min(1).max(256), spark: z.string().min(1).max(256) });
export const Manifest = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal("monitor-screening"),
    seed: z.string().min(1).max(256),
    deployment: Deployment,
    modelVersions: Models,
    settingsDigest: Digest,
    pages: z.array(ManifestPage).min(1).max(SCREEN_CALLS_PER_RUN),
  })
  .refine(
    (m) =>
      new Set(m.pages.map((p) => p.experimentCaseId)).size === m.pages.length &&
      new Set(m.pages.map((p) => p.pageId)).size === m.pages.length,
    "duplicate page identity",
  );
export type Manifest = z.infer<typeof Manifest>;
const Registry = z
  .strictObject({ version: z.literal(1), deployment: Deployment, manifests: z.array(Digest).min(1).max(64) })
  .refine((r) => new Set(r.manifests).size === r.manifests.length);
const CaptureUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
    } catch {
      return false;
    }
  });
export const Capture = z.strictObject({
  version: z.literal(1),
  pageId: ExperimentId,
  provenanceDigest: Digest,
  capturedAt: z.iso.datetime(),
  originalUrl: CaptureUrl.refine((value) => HOST.test(new URL(value).hostname)),
  finalUrl: CaptureUrl,
  redirects: z.array(CaptureUrl).max(8),
  screenshotSha256: Digest,
  textSha256: Digest,
  signalsSha256: Digest,
});
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Signals = z.strictObject({
  text: z.string().max(200_000),
  inputs: Count,
  passwords: Count,
  forms: Count,
  iframes: Count,
  components: Count,
  hidden: Count,
});
export class MonitorInputError extends Error {
  constructor() {
    super("monitor experiment input unavailable or invalid");
    this.name = "MonitorInputError";
  }
}
function refuse(): never {
  throw new MonitorInputError();
}

// Parse the grammar before JSON.parse can discard duplicate keys. Decoded key equality also catches escaped aliases.
export function parseStrictJson(text: string, maxBytes = 65_536): unknown {
  if (new TextEncoder().encode(text).length > maxBytes) return refuse();
  let at = 0;
  const space = () => {
    while (at < text.length && /[\t\n\r ]/.test(text[at] ?? "")) at++;
  };
  const string = (): string => {
    if (text[at++] !== '"') return refuse();
    const start = at - 1;
    while (at < text.length) {
      const char = text[at++];
      if (char === '"') {
        try {
          return JSON.parse(text.slice(start, at)) as string;
        } catch {
          return refuse();
        }
      }
      if (char === "\\") at++;
    }
    return refuse();
  };
  const value = (depth: number): void => {
    if (depth > 32) refuse();
    space();
    const char = text[at];
    if (char === '"') {
      string();
      return;
    }
    if (char === "{" || char === "[") {
      at++;
      space();
      const end = char === "{" ? "}" : "]";
      const keys = new Set<string>();
      if (text[at] === end) {
        at++;
        return;
      }
      while (at < text.length) {
        space();
        if (char === "{") {
          const key = string();
          if (keys.has(key)) refuse();
          keys.add(key);
          space();
          if (text[at++] !== ":") refuse();
        }
        value(depth + 1);
        space();
        if (text[at] === end) {
          at++;
          return;
        }
        if (text[at++] !== ",") refuse();
      }
      refuse();
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
    if (!token) refuse();
    at += token[0].length;
  };
  value(0);
  space();
  if (at !== text.length) return refuse();
  try {
    return JSON.parse(text);
  } catch {
    return refuse();
  }
}
const encode = (text: string) => new TextEncoder().encode(text);
export async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export function modelVersions() {
  return { loupe: modelNameOf(DEPLOYED_VERSION), spark: SPARK_MODEL };
}
export async function settingsDigest(deployment: string): Promise<string> {
  Deployment.parse(deployment);
  return sha256(
    encode(
      JSON.stringify({
        version: 1,
        deployment,
        mode: "image",
        maxPages: SCREEN_CALLS_PER_RUN,
        maxTextCharacters: MAX_TEXT_CHARACTERS,
        loupeMaxAnswerTokens: MAX_ANSWER_TOKENS,
        sparkMaxOutputTokens: SPARK_MAX_OUTPUT_TOKENS,
        sparkReasoningEffort: SPARK_REASONING_EFFORT,
        escalationBand: { low: ESCALATION_BAND.low, high: ESCALATION_BAND.high },
        parking: {
          maxText: PARKED_MAX_TEXT,
          emptyText: EMPTY_MAX_TEXT,
          emptyScreenshot: EMPTY_MAX_SCREENSHOT,
          maxHidden: MAX_HIDDEN_TEXT,
          imageLedText: IMAGE_LED_MAX_TEXT,
          imageLedScreenshot: IMAGE_LED_MIN_SCREENSHOT,
        },
        secondLook: true,
      }),
    ),
  );
}
export function canonicalManifest(value: unknown): string {
  const m = Manifest.parse(value);
  return JSON.stringify({
    version: m.version,
    kind: m.kind,
    seed: m.seed,
    deployment: m.deployment,
    modelVersions: Object.fromEntries(
      Object.keys(m.modelVersions)
        .sort()
        .map((k) => [k, m.modelVersions[k as keyof typeof m.modelVersions]]),
    ),
    settingsDigest: m.settingsDigest,
    pages: m.pages.map((p) => ({
      experimentCaseId: p.experimentCaseId,
      pageId: p.pageId,
      captureDigest: p.captureDigest,
      labelDigest: p.labelDigest,
    })),
  });
}
export const manifestDigest = (value: unknown) => sha256(encode(canonicalManifest(value)));
export async function captureDigest(value: unknown): Promise<string> {
  const c = Capture.parse(value);
  return sha256(
    encode(
      JSON.stringify({
        version: c.version,
        pageId: c.pageId,
        provenanceDigest: c.provenanceDigest,
        capturedAt: c.capturedAt,
        originalUrl: c.originalUrl,
        finalUrl: c.finalUrl,
        redirects: c.redirects,
        screenshotSha256: c.screenshotSha256,
        textSha256: c.textSha256,
        signalsSha256: c.signalsSha256,
      }),
    ),
  );
}
export type CaptureBucket = { get(key: string): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null> };
async function read(bucket: CaptureBucket, key: string, limit: number): Promise<Uint8Array> {
  const object = await bucket.get(key);
  if (!object) return refuse();
  if (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > limit) {
    await object.body.cancel();
    return refuse();
  }
  const reader = object.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > limit || length > object.size) {
        await reader.cancel();
        return refuse();
      }
      parts.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length !== object.size) return refuse();
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return refuse();
  }
}
async function json(bucket: CaptureBucket, key: string): Promise<unknown> {
  return parseStrictJson(decode(await read(bucket, key, 65_536)));
}
export async function loadManifest(bucket: CaptureBucket, digest: string, deployment: string): Promise<Manifest> {
  Digest.parse(digest);
  Deployment.parse(deployment);
  const registry = Registry.parse(await json(bucket, "eval/monitor-registry.json"));
  if (registry.deployment !== deployment || !registry.manifests.includes(digest)) return refuse();
  const manifest = Manifest.parse(await json(bucket, `eval/monitor-manifests/${digest}.json`));
  const versions = modelVersions();
  if (
    (await manifestDigest(manifest)) !== digest ||
    manifest.deployment !== deployment ||
    manifest.modelVersions.loupe !== versions.loupe ||
    manifest.modelVersions.spark !== versions.spark ||
    manifest.settingsDigest !== (await settingsDigest(deployment))
  )
    return refuse();
  return manifest;
}
async function content(bucket: CaptureBucket, digest: string, suffix: string, limit: number) {
  const bytes = await read(bucket, `eval/monitor-objects/${digest}.${suffix}`, limit);
  if ((await sha256(bytes)) !== digest) return refuse();
  return bytes;
}
export async function loadCapture(
  bucket: CaptureBucket,
  input: ManifestPage,
): Promise<{ page: Page; signals: z.infer<typeof Signals> }> {
  const p = ManifestPage.parse(input);
  const capture = Capture.parse(await json(bucket, `eval/monitor-captures/${p.captureDigest}.json`));
  if (capture.pageId !== p.pageId || (await captureDigest(capture)) !== p.captureDigest) return refuse();
  const image = await content(bucket, capture.screenshotSha256, "jpg", 10 * 1024 * 1024);
  const size = jpegSize(image);
  if (!size || size.width * size.height > 32_000_000) return refuse();
  const text = decode(await content(bucket, capture.textSha256, "txt", 1024 * 1024));
  if (text.length > 200_000) return refuse();
  const signals = Signals.parse(
    parseStrictJson(decode(await content(bucket, capture.signalsSha256, "json", 1024 * 1024)), 1024 * 1024),
  );
  return { page: { image, text, host: new URL(capture.originalUrl).hostname, mode: "image" }, signals };
}
export async function preflightCaptures(bucket: CaptureBucket, manifest: Manifest): Promise<void> {
  for (const page of Manifest.parse(manifest).pages) await loadCapture(bucket, page);
}
