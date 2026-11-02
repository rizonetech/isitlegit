// The Worker's reader for the reference logo store (D03 T03 §3; the store itself is D03 T03 §2):
// the live index at `ref/logos/index.json` in the ARTEFACTS bucket names each brand's logo under
// its generation. Reads are bounded and typed: a missing index, brand or image, an index that
// fails its schema, an oversized object, or bytes whose hash is not the indexed hash are a
// LogoReferenceError, never an empty image handed to a model.
import { z } from "zod";
import { normaliseBrand } from "./brand";

export const LOGO_INDEX_KEY = "ref/logos/index.json";
export const MAX_LOGO_INDEX_BYTES = 256 * 1024;
export const MAX_LOGO_IMAGE_BYTES = 5 * 1024 * 1024;

export type LogoReferenceErrorKind =
  | "missing-index"
  | "invalid-index"
  | "missing-brand"
  | "missing-image"
  | "too-large"
  | "hash-mismatch";
export class LogoReferenceError extends Error {
  readonly kind: LogoReferenceErrorKind;
  constructor(kind: LogoReferenceErrorKind, message: string) {
    super(message);
    this.name = "LogoReferenceError";
    this.kind = kind;
  }
}

const logoEntry = z.strictObject({
  slug: z.string().min(1).max(120),
  brand: z.string().min(1).max(200),
  key: z.string().startsWith("ref/logos/").max(300),
  // The publisher's full entry (scripts/load-reference-logos.ts, D03 T03 §2): provenance beside
  // the fields this reader uses, all required so a different shape is refused, not half-read.
  page_url: z.string().min(1).max(2000),
  source_url: z.string().min(1).max(2000),
  source_kind: z.enum(["header", "icon", "og", "fictional"]),
  use: z.literal("detection-reference"),
  fetched_at: z.iso.datetime(),
  media_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
  width: z.int().positive(),
  height: z.int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  fictional: z.boolean(),
});
const logoIndex = z.strictObject({
  version: z.literal(1),
  generation: z.string().min(1).max(40),
  generated_at: z.string().min(1).max(40),
  logos: z.array(logoEntry).max(500),
  missing: z.array(z.strictObject({ slug: z.string(), brand: z.string(), reason: z.string() })).max(500),
});

export type ReferenceLogo = {
  brand: string;
  slug: string;
  key: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  bytes: Uint8Array;
  sha256: string;
  fictional: boolean;
};

const sha256Hex = async (bytes: Uint8Array) => {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const slugOf = (name: string) =>
  name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");

// One brand's reference logo from the store, by the brand's name as the reading states it (the
// index's brand name or its slug). The image's bytes are checked against the indexed hash before
// they are returned, so a replaced or corrupt object is a typed failure, not a wrong reference.
export async function referenceLogo(bucket: R2Bucket, brand: string): Promise<ReferenceLogo> {
  const indexObject = await bucket.get(LOGO_INDEX_KEY);
  if (!indexObject) throw new LogoReferenceError("missing-index", "the reference logo index is not stored");
  if (indexObject.size > MAX_LOGO_INDEX_BYTES)
    throw new LogoReferenceError("too-large", "the reference logo index is oversized");
  let raw: unknown;
  try {
    raw = JSON.parse(await indexObject.text());
  } catch {
    throw new LogoReferenceError("invalid-index", "the reference logo index is not JSON");
  }
  const parsed = logoIndex.safeParse(raw);
  if (!parsed.success) throw new LogoReferenceError("invalid-index", "the reference logo index fails its schema");
  const wanted = normaliseBrand(brand);
  const entry = parsed.data.logos.find((logo) => normaliseBrand(logo.brand) === wanted || logo.slug === slugOf(brand));
  if (!entry) throw new LogoReferenceError("missing-brand", `no reference logo is stored for ${brand}`);
  const image = await bucket.get(entry.key);
  if (!image) throw new LogoReferenceError("missing-image", `the reference logo at ${entry.key} is not stored`);
  if (image.size > MAX_LOGO_IMAGE_BYTES)
    throw new LogoReferenceError("too-large", `the reference logo at ${entry.key} is oversized`);
  const bytes = new Uint8Array(await image.arrayBuffer());
  if (bytes.byteLength > MAX_LOGO_IMAGE_BYTES)
    throw new LogoReferenceError("too-large", `the reference logo at ${entry.key} is oversized`);
  const sha256 = await sha256Hex(bytes);
  if (sha256 !== entry.sha256)
    throw new LogoReferenceError("hash-mismatch", `the reference logo at ${entry.key} does not match its indexed hash`);
  return {
    brand: entry.brand,
    slug: entry.slug,
    key: entry.key,
    mediaType: entry.media_type,
    bytes,
    sha256,
    fictional: entry.fictional,
  };
}
