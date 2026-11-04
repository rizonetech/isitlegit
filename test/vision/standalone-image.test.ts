import { env } from "cloudflare:test";
import puppeteer from "@cloudflare/puppeteer";
import { describe, expect, it } from "vitest";
import { readEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { putAttachment, putParsed, type Store } from "../../src/intake/store";
import { d1Budget } from "../../src/meta/budget";
import { LIMITS } from "../../src/vision/render";
import { type VisionDeps, visionStep } from "../../src/vision/step";
import { RED_PNG } from "../fixtures/vision/emails";

const store: Store = { db: env.DB, bucket: env.ARTEFACTS };
async function source(bytes: Uint8Array = RED_PNG, mediaType = "image/png", sourceKey?: string) {
  const made = await createCase(env.DB, {
    orgId: "org-image-bounds",
    channel: "upload",
    sourceKind: "image",
    headersAvailable: false,
    uploadedBy: "user-image",
  });
  if (!made.ok) throw new Error(made.error.message);
  const id = made.value.id;
  const file = await putAttachment(store, id, "picture", bytes, mediaType);
  const parsed = {
    source: { kind: "image", key: sourceKey ?? file.key, mediaType, bytes: bytes.length },
    forward: { headersAvailable: false },
  };
  await putParsed(store, id, parsed);
  return { id, file, parsed };
}
function deps(id: string) {
  const calls = { launch: 0, model: 0 };
  const d: VisionDeps = {
    db: env.DB,
    store,
    kv: env.CACHE,
    waitUntil: () => {},
    policy: async () => ({ ok: false, reason: "refused" }),
    launch: async () => {
      calls.launch++;
      return puppeteer.launch(env.BROWSER);
    },
    meta: {
      env: { ...env, META_API_KEY: "fake", CF_AIG_TOKEN: "fake", META_GATEWAY_URL: "https://gateway.test/v1" },
      budget: d1Budget(env.DB, { caller: "vision", caseId: id }),
      fetch: async () => {
        calls.model++;
        return new Response(
          JSON.stringify({
            id: "r",
            object: "response",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      readings: [
                        {
                          image: "image-1",
                          claimed_brand: null,
                          requested_action: "none",
                          urgency_cues: [],
                          visible_sender: null,
                          payment_request: false,
                          confidence: 0.9,
                        },
                      ],
                    }),
                  },
                ],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 10 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    },
    ablateFlag: async () => "no-sam",
  };
  return { d, calls };
}
function crc(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
describe("standalone image selection bounds", () => {
  // Synthetic two-pixel solids generated with Pillow, no external image assets.
  it.each([
    {
      mime: "image/png",
      base64:
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==",
    },
    {
      mime: "image/jpeg",
      base64:
        "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z",
    },
    {
      mime: "image/webp",
      base64: "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=",
    },
  ])("reads a bounded $mime source and ignores unrelated attachments", async ({ mime, base64 }) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const f = await source(bytes, mime);
    await putAttachment(store, f.id, "unrelated.png", RED_PNG, "image/png");
    const { d, calls } = deps(f.id);
    await visionStep(d, f.id);
    expect(calls).toEqual({ launch: 1, model: 1 });
    const items = await readEvidence(env.DB, f.id);
    expect(items.find((e) => e.check === "vision.coverage")?.detail).toMatchObject({
      ablated: "no-sam",
      complete: true,
    });
    expect(items.some((e) => e.check === "vision.not_checked")).toBe(false);
  });
  it("states a structurally intact but undecodable image without a model call", async () => {
    const bytes = RED_PNG.slice();
    const view = new DataView(bytes.buffer);
    bytes[41] = 0;
    view.setUint32(57, crc(bytes.subarray(37, 57)));
    const f = await source(bytes);
    const { d, calls } = deps(f.id);
    expect(await visionStep(d, f.id)).toEqual({ outcome: "not_checked", reason: "image-decode-failed" });
    expect(calls).toEqual({ launch: 1, model: 0 });
  });

  it.each(["foreign", "missing", "mime", "size", "pixels", "webp-inner-pixels"])(
    "states %s coverage before decoding or model calls",
    async (kind) => {
      let bytes: Uint8Array = RED_PNG;
      let mime = "image/png";
      if (kind === "mime") mime = "image/jpeg";
      if (kind === "size") bytes = new Uint8Array(LIMITS.perResourceBytes + 1);
      if (kind === "pixels") {
        bytes = RED_PNG.slice();
        const view = new DataView(bytes.buffer);
        view.setUint32(16, 10000);
        view.setUint32(20, 10000);
        view.setUint32(29, crc(bytes.subarray(12, 29)));
      }
      if (kind === "webp-inner-pixels") {
        mime = "image/webp";
        bytes = new Uint8Array(48);
        const view = new DataView(bytes.buffer);
        const tag = (at: number, value: string) => bytes.set(new TextEncoder().encode(value), at);
        tag(0, "RIFF");
        view.setUint32(4, 40, true);
        tag(8, "WEBP");
        tag(12, "VP8X");
        view.setUint32(16, 10, true);
        bytes[24] = 1;
        bytes[27] = 1;
        tag(30, "VP8 ");
        view.setUint32(34, 10, true);
        bytes.set([0x9d, 1, 0x2a], 41);
        view.setUint16(44, 10000, true);
        view.setUint16(46, 10000, true);
      }
      const foreignKey = kind === "foreign" ? (await source()).file.key : undefined;
      const f = await source(bytes, mime, foreignKey);
      if (kind === "missing") await env.ARTEFACTS.delete(f.file.key);
      const { d, calls } = deps(f.id);
      const result = await visionStep(d, f.id);
      expect(result.outcome).toBe("not_checked");
      expect(calls).toEqual({ launch: 0, model: 0 });
      expect((await readEvidence(env.DB, f.id)).find((e) => e.check === "vision.not_checked")?.detail).toMatchObject({
        checked: false,
      });
    },
  );
});
