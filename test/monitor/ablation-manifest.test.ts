import { describe, expect, it } from "vitest";
import {
  canonicalManifest,
  captureDigest,
  loadCapture,
  loadManifest,
  manifestDigest,
  modelVersions,
  parseStrictJson,
  settingsDigest,
} from "../../src/monitor/ablation-manifest";
import { fakeJpeg } from "../fixtures/jpeg";

const stream = (value: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(value);
      c.close();
    },
  });

const deployment = "a".repeat(40);
const hash = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
const bytes = (text: string) => new TextEncoder().encode(text);
const manifest = async () => ({
  version: 1,
  kind: "monitor-screening",
  seed: "contract-v1",
  deployment,
  modelVersions: modelVersions(),
  settingsDigest: await settingsDigest(deployment),
  pages: [
    { experimentCaseId: "labelled-1", pageId: "capture-1", captureDigest: "1".repeat(64), labelDigest: "2".repeat(64) },
  ],
});

async function fixture() {
  const screenshot = fakeJpeg(640, 480);
  const text = bytes("A fictional login page");
  const signals = bytes(
    JSON.stringify({
      text: "A fictional login page",
      inputs: 1,
      passwords: 1,
      forms: 1,
      iframes: 0,
      components: 0,
      hidden: 0,
    }),
  );
  const capture = {
    version: 1,
    pageId: "capture-1",
    provenanceDigest: "3".repeat(64),
    capturedAt: "2026-11-04T00:00:00.000Z",
    originalUrl: "https://candidate.example/start",
    finalUrl: "https://landing.example/",
    redirects: ["https://landing.example/"],
    screenshotSha256: await hash(screenshot),
    textSha256: await hash(text),
    signalsSha256: await hash(signals),
  };
  const digest = await captureDigest(capture);
  const objects: Record<string, Uint8Array> = {
    [`eval/monitor-captures/${digest}.json`]: bytes(JSON.stringify(capture)),
    [`eval/monitor-objects/${capture.screenshotSha256}.jpg`]: screenshot,
    [`eval/monitor-objects/${capture.textSha256}.txt`]: text,
    [`eval/monitor-objects/${capture.signalsSha256}.json`]: signals,
  };
  const bucket = {
    get: async (key: string) => {
      const value = objects[key];
      return value
        ? {
            size: value.length,
            body: new ReadableStream({
              start(c) {
                c.enqueue(value);
                c.close();
              },
            }),
          }
        : null;
    },
  };
  return { capture, digest, objects, bucket };
}

describe("immutable monitor input boundary", () => {
  it("rejects duplicate decoded keys at every depth without rejecting key-like text", () => {
    for (const input of ['{"arm":"full","arm":"no-screening"}', '{"a":{"x":1,"\\u0078":2}}', '{"a":1,"\\u0061":2}'])
      expect(() => parseStrictJson(input)).toThrow();
    expect(parseStrictJson('{"a":"\\"a\\":1", "b":[1,true,null]}')).toEqual({ a: '"a":1', b: [1, true, null] });
    for (const input of ['{"a":1,}', "[1,]", '{"a":01}', "true false", `${"[".repeat(40)}0${"]".repeat(40)}`])
      expect(() => parseStrictJson(input)).toThrow();
  });
  it("preserves canonical ordering and supplied strings, rejects extras and duplicate page IDs", async () => {
    const m = await manifest();
    const canonical = canonicalManifest(m);
    expect(canonical.startsWith('{"version":1,"kind":"monitor-screening","seed":"contract-v1","deployment":')).toBe(
      true,
    );
    expect(await manifestDigest(m)).toBe(await hash(bytes(canonical)));
    expect(() => canonicalManifest({ ...m, privateLabel: "malicious" })).toThrow();
    expect(() => canonicalManifest({ ...m, pages: [m.pages[0], m.pages[0]] })).toThrow();
    expect(() =>
      canonicalManifest({
        ...m,
        pages: Array.from({ length: 16 }, (_, i) => ({ ...m.pages[0], pageId: `p${i}`, experimentCaseId: `e${i}` })),
      }),
    ).toThrow();
  });
  it("requires root registry approval and exact deployment/model/settings fingerprints", async () => {
    const m = await manifest();
    const digest = await manifestDigest(m);
    const objects = new Map<string, string>([
      ["eval/monitor-registry.json", JSON.stringify({ version: 1, deployment, manifests: [digest] })],
      [`eval/monitor-manifests/${digest}.json`, JSON.stringify(m)],
    ]);
    const bucket = {
      get: async (key: string) => {
        const text = objects.get(key);
        return text === undefined ? null : { size: bytes(text).length, body: stream(bytes(text)) };
      },
    };
    expect((await loadManifest(bucket, digest, deployment)).pages).toEqual(m.pages);
    await expect(loadManifest(bucket, digest, "b".repeat(40))).rejects.toThrow();
    objects.set("eval/monitor-registry.json", JSON.stringify({ version: 1, deployment, manifests: ["f".repeat(64)] }));
    await expect(loadManifest(bucket, digest, deployment)).rejects.toThrow();
    objects.set("eval/monitor-registry.json", JSON.stringify({ version: 1, deployment, manifests: [digest] }));
    objects.set(
      `eval/monitor-manifests/${digest}.json`,
      JSON.stringify({ ...m, modelVersions: { ...m.modelVersions, spark: "forged" } }),
    );
    await expect(loadManifest(bucket, digest, deployment)).rejects.toThrow();
  });
  it("keeps original candidate host and exact frozen bytes across a cross-host redirect", async () => {
    const f = await fixture();
    const p = {
      experimentCaseId: "labelled-1",
      pageId: f.capture.pageId,
      captureDigest: f.digest,
      labelDigest: "2".repeat(64),
    };
    const result = await loadCapture(f.bucket, p);
    expect(result.page.host).toBe("candidate.example");
    expect(result.page.text).toBe("A fictional login page");
    expect(result.page.image).toEqual(fakeJpeg(640, 480));
    expect(result.signals.passwords).toBe(1);
    expect(result).not.toHaveProperty("labelDigest");
    f.objects[`eval/monitor-objects/${f.capture.textSha256}.txt`] = bytes("substituted");
    await expect(loadCapture(f.bucket, p)).rejects.toThrow();
  });
  it("rejects missing, oversized and corrupt objects before returning a model input", async () => {
    const f = await fixture();
    const p = {
      experimentCaseId: "labelled-1",
      pageId: f.capture.pageId,
      captureDigest: f.digest,
      labelDigest: "2".repeat(64),
    };
    const missing = { get: async () => null };
    await expect(loadCapture(missing, p)).rejects.toThrow();
    const oversized = { get: async () => ({ size: 65537, body: stream(bytes("{}")) }) };
    await expect(loadCapture(oversized, p)).rejects.toThrow();
    f.objects[`eval/monitor-captures/${f.digest}.json`] = bytes(
      JSON.stringify({ ...f.capture, originalUrl: "https://user:secret@candidate.example/" }),
    );
    await expect(loadCapture(f.bucket, p)).rejects.toThrow();
  });
});

describe("capture encoding and physical bounds", () => {
  it("rejects a JSON BOM rather than silently normalizing its bytes", async () => {
    const f = await fixture();
    const key = `eval/monitor-captures/${f.digest}.json`;
    f.objects[key] = bytes(`\ufeff${JSON.stringify(f.capture)}`);
    await expect(
      loadCapture(f.bucket, {
        experimentCaseId: "labelled-1",
        pageId: f.capture.pageId,
        captureDigest: f.digest,
        labelDigest: "2".repeat(64),
      }),
    ).rejects.toThrow();
  });
  it.each(["utf8", "characters", "pixels", "jpeg", "signals", "duplicate-signals"])(
    "rejects hash-valid but invalid %s capture content",
    async (kind) => {
      const f = await fixture();
      if (kind === "utf8" || kind === "characters") {
        const value = kind === "utf8" ? new Uint8Array([0xc3, 0x28]) : bytes("x".repeat(200001));
        f.capture.textSha256 = await hash(value);
        f.objects[`eval/monitor-objects/${f.capture.textSha256}.txt`] = value;
      } else if (kind === "pixels" || kind === "jpeg") {
        const value = kind === "pixels" ? fakeJpeg(8000, 8000) : new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
        f.capture.screenshotSha256 = await hash(value);
        f.objects[`eval/monitor-objects/${f.capture.screenshotSha256}.jpg`] = value;
      } else {
        const value = bytes(
          kind === "signals"
            ? JSON.stringify({
                text: "test",
                inputs: 1,
                passwords: 1,
                forms: 0,
                iframes: 0,
                components: 0,
                hidden: 0,
                label: "malicious",
              })
            : '{"text":"test","inputs":0,"inputs":1,"passwords":1,"forms":0,"iframes":0,"components":0,"hidden":0}',
        );
        f.capture.signalsSha256 = await hash(value);
        f.objects[`eval/monitor-objects/${f.capture.signalsSha256}.json`] = value;
      }
      const digest = await captureDigest(f.capture);
      f.objects[`eval/monitor-captures/${digest}.json`] = bytes(JSON.stringify(f.capture));
      await expect(
        loadCapture(f.bucket, {
          experimentCaseId: "labelled-1",
          pageId: f.capture.pageId,
          captureDigest: digest,
          labelDigest: "2".repeat(64),
        }),
      ).rejects.toThrow();
    },
  );
  it("enforces streamed length even when declared size lies", async () => {
    const bucket = { get: async () => ({ size: 2, body: stream(bytes("x".repeat(65537))) }) };
    await expect(loadManifest(bucket, "1".repeat(64), deployment)).rejects.toThrow();
  });
});

it("keeps final URL evidence independent of the original candidate HOST constraint", async () => {
  const f = await fixture();
  f.capture.finalUrl = "https://192.0.2.1/landing";
  f.capture.redirects = [f.capture.finalUrl];
  const digest = await captureDigest(f.capture);
  f.objects[`eval/monitor-captures/${digest}.json`] = bytes(JSON.stringify(f.capture));
  const loaded = await loadCapture(f.bucket, {
    experimentCaseId: "labelled-1",
    pageId: f.capture.pageId,
    captureDigest: digest,
    labelDigest: "2".repeat(64),
  });
  expect(loaded.page.host).toBe("candidate.example");
});

it("matches an independently computed canonical serialization digest", async () => {
  const m = await manifest();
  m.modelVersions = { loupe: "revision-1", spark: "spark-1" };
  m.settingsDigest = "0".repeat(64);
  expect(await manifestDigest(m)).toBe("8cd1b3589e311dcd915a6a2bcd536ef70c7ea9c7c4d8b13dcb362bbaea74811b");
});
