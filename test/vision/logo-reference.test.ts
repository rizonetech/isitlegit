import { describe, expect, it } from "vitest";
import { LOGO_INDEX_KEY, referenceLogo, referenceLogos } from "../../src/vision/logo-reference";

// D03 T03 §3: the Worker's reader for the reference logo store, against a stub bucket holding the
// fictional fixture. A missing brand is a typed refusal, and bytes that are not the indexed bytes
// are refused, never handed on as a reference.
const sha256Hex = async (bytes: Uint8Array) => {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

function stubBucket(objects: Map<string, Uint8Array>) {
  return {
    get: async (key: string) => {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return {
        size: bytes.byteLength,
        text: async () => new TextDecoder().decode(bytes),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    },
  } as unknown as R2Bucket;
}

describe("referenceLogo", () => {
  it("loads a stored fixture by brand name and refuses a missing brand with a typed error", async () => {
    const png = new TextEncoder().encode("fictional-protea-bank-logo-fixture-bytes");
    const sha = await sha256Hex(png);
    const key = "ref/logos/20260101T000000Z/protea-bank.png";
    const objects = new Map<string, Uint8Array>([
      [key, png],
      [
        LOGO_INDEX_KEY,
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            generation: "20260101T000000Z",
            generated_at: "2026-01-01T00:00:00Z",
            logos: [
              {
                slug: "protea-bank",
                brand: "Protea Bank",
                key,
                page_url: "https://proteabank.example/",
                source_url: "https://proteabank.example/logo.png",
                source_kind: "fictional",
                use: "detection-reference",
                fetched_at: "2026-01-01T00:00:00Z",
                media_type: "image/png",
                width: 512,
                height: 512,
                sha256: sha,
                fictional: true,
              },
            ],
            missing: [],
          }),
        ),
      ],
    ]);
    const bucket = stubBucket(objects);
    const logo = await referenceLogo(bucket, "Protea Bank");
    expect(logo.brand).toBe("Protea Bank");
    expect(logo.mediaType).toBe("image/png");
    expect(logo.sha256).toBe(sha);
    expect(logo.bytes.byteLength).toBe(png.byteLength);
    await expect(referenceLogo(bucket, "No Such Bank")).rejects.toMatchObject({
      name: "LogoReferenceError",
      kind: "missing-brand",
    });
    // Corrupt the stored image: the indexed hash no longer matches, so the read is refused.
    objects.set(key, new Uint8Array([1, 2, 3]));
    await expect(referenceLogo(bucket, "Protea Bank")).rejects.toMatchObject({
      name: "LogoReferenceError",
      kind: "hash-mismatch",
    });
  });

  it("returns every variant for a brand, wordmark first, and reads an index without variants as one wordmark", async () => {
    const png = new TextEncoder().encode("fictional-protea-bank-logo-fixture-bytes");
    const sha = await sha256Hex(png);
    const entry = (key: string, variant?: string) => ({
      slug: "protea-bank",
      brand: "Protea Bank",
      key,
      page_url: "https://proteabank.example/",
      source_url: "https://proteabank.example/logo.png",
      source_kind: "fictional",
      use: "detection-reference",
      fetched_at: "2026-01-01T00:00:00Z",
      media_type: "image/png",
      width: 512,
      height: 512,
      sha256: sha,
      fictional: true,
      ...(variant ? { variant } : {}),
    });
    const wordmarkKey = "ref/logos/20260101T000000Z/protea-bank.png";
    const iconKey = "ref/logos/20260101T000000Z/protea-bank-icon.png";
    const objects = new Map<string, Uint8Array>([
      [wordmarkKey, png],
      [iconKey, png],
      [
        LOGO_INDEX_KEY,
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            generation: "20260101T000000Z",
            generated_at: "2026-01-01T00:00:00Z",
            logos: [entry(iconKey, "icon"), entry(wordmarkKey)],
            missing: [],
          }),
        ),
      ],
    ]);
    const logos = await referenceLogos(stubBucket(objects), "Protea Bank");
    expect(logos.map((logo) => logo.variant)).toEqual(["wordmark", "icon"]);
    // An older index with no variant field at all still reads as the single wordmark.
    objects.delete(iconKey);
    const first = objects.get(LOGO_INDEX_KEY) as Uint8Array;
    objects.set(
      LOGO_INDEX_KEY,
      new TextEncoder().encode(
        JSON.stringify({ ...JSON.parse(new TextDecoder().decode(first)), logos: [entry(wordmarkKey)] }),
      ),
    );
    expect((await referenceLogo(stubBucket(objects), "Protea Bank")).variant).toBe("wordmark");
  });

  it("refuses a missing index with a typed error", async () => {
    await expect(referenceLogo(stubBucket(new Map()), "Protea Bank")).rejects.toMatchObject({
      name: "LogoReferenceError",
      kind: "missing-index",
    });
  });
});
