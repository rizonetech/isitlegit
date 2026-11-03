// The reference logo store (D03 T03 §2; design spec 4.4, 11 Fixtures). Real brands' logos are detection references
// only: each is its owner's mark, taken from the owner's own site, held privately in R2 to recognise impersonation of
// that owner, and never committed, served or imitated (NOTICE.md). Two fictional references (Protea Bank, NimbusMail)
// are IsItLegit's own drawings, committed under test/fixtures/brands/.
//
// Three steps, each its own command:
//   capture: renders each brand's header logo from its home page in headless Chromium (`data/reference-logos.json`
//     names the page and the element) into a new generation folder of the local store, outside the repository
//     (`~/isitlegit-data/reference-logos/<generation>/`, `REFERENCE_LOGOS_DIR` moves it). A brand that fails is listed
//     under `missing` with its reason; the run goes on.
//   load: verifies every file against the generation's index, puts the logos under `ref/logos/<generation>/`, keeps the
//     live index as `ref/logos/index.previous.json`, puts `ref/logos/index.json` last and reads it back. Earlier
//     generations' objects are never overwritten, so `--restore` (the previous index made live again) is always whole.
//   check: reads the live index, downloads every logo it lists and compares hash, type and dimensions.
//
//   node scripts/load-reference-logos.ts capture
//   node scripts/load-reference-logos.ts load --local|--remote [--generation <stamp>] [--dry-run] [--restore]
//   node scripts/load-reference-logos.ts --check --local|--remote
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { getDomain } from "tldts";
import { z } from "zod";

export const BUCKET = "isitlegit-artefacts";
export const PREFIX = "ref/logos/";
export const INDEX_KEY = `${PREFIX}index.json`;
export const PREVIOUS_KEY = `${PREFIX}index.previous.json`;
export const MIN_SIDE = 256;
// The largest side a reference may have: a logo needs no more, and a larger image is not decoded.
export const MAX_SIDE = 8192;
export const MIN_REAL_BRANDS = 20;
export const GRAB_MS = 45_000;
const DEVICE_SCALE = 4;
// The least share of a logo's pixels that must stand apart from its background (an empty or faint shot fails).
const MIN_INK = 0.02;
const GENERATION = /^\d{8}T\d{6}Z$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MISSING_OBJECT = /specified key does not exist|\b404\b/i;

export class LoadRefused extends Error {
  override name = "LoadRefused";
}

// --- Images -----------------------------------------------------------------------------------------------------------

export type MediaType = "image/png" | "image/jpeg" | "image/webp";
export type ImageInfo = { type: MediaType; width: number; height: number };
const EXTENSION: Record<MediaType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number) => u16le(b, i) | ((b[i + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, i: number) => u16be(b, i) * 65536 + u16be(b, i + 2);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

// The media type and size read from the bytes themselves, never from a server's Content-Type: PNG, JPEG and WebP only
// (types the Meta Model API accepts that hold a raster logo); anything else, SVG and HTML included, is null.
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  const ok = (type: MediaType, width: number, height: number) =>
    width > 0 && height > 0 ? { type, width, height } : null;
  if (bytes.length >= 24 && u32be(bytes, 0) === 0x89504e47 && u32be(bytes, 4) === 0x0d0a1a0a) {
    if (ascii(bytes, 12, 4) !== "IHDR") return null;
    return ok("image/png", u32be(bytes, 16), u32be(bytes, 20));
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // Walk the segments to the first start-of-frame marker.
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1] ?? 0;
      if (marker === 0xff) {
        i++;
        continue;
      }
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) return ok("image/jpeg", u16be(bytes, i + 7), u16be(bytes, i + 5));
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      i += 2 + u16be(bytes, i + 2);
    }
    return null;
  }
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === "VP8X") return ok("image/webp", u24le(bytes, 24) + 1, u24le(bytes, 27) + 1);
    if (chunk === "VP8 ") return ok("image/webp", u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const bits = (bytes[21] ?? 0) | ((bytes[22] ?? 0) << 8) | ((bytes[23] ?? 0) << 16) | ((bytes[24] ?? 0) << 24);
      return ok("image/webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    return null;
  }
  return null;
}

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function logoKey(
  generation: string,
  slug: string,
  type: MediaType,
  variant: "wordmark" | "icon" = "wordmark",
): string {
  if (!GENERATION.test(generation)) throw new LoadRefused(`not a generation stamp: ${JSON.stringify(generation)}`);
  if (!SLUG.test(slug)) throw new LoadRefused(`not a slug: ${JSON.stringify(slug)}`);
  // The wordmark keeps the first generations' key shape; a second variant is named beside it.
  return `${PREFIX}${generation}/${slug}${variant === "icon" ? "-icon" : ""}.${EXTENSION[type]}`;
}

export const generationOf = (date: Date) =>
  date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

// --- The selector table and the index --------------------------------------------------------------------------------

export const SelectorTable = z.strictObject({
  version: z.literal(1),
  logos: z.array(
    z.strictObject({
      slug: z.string().regex(SLUG),
      brand: z.string().min(1),
      url: z.url({ protocol: /^https$/ }),
      // `header`: a CSS selector of the logo element on the page; `icon` or `og`: an image URL on the page's site.
      kind: z.enum(["header", "icon", "og"]),
      selector: z.string().min(1),
      // Scales a small vector logo up (CSS transform) so it reaches the 256 px floor without upscaling pixels.
      zoom: z.number().min(1).max(4).optional(),
      // Which reference this row captures (D03 T03 §5): absent is the wordmark; a brand may add an icon row.
      variant: z.enum(["wordmark", "icon"]).optional(),
    }),
  ),
});
export type SelectorTable = z.infer<typeof SelectorTable>;
export type SelectorEntry = SelectorTable["logos"][number];

const Logo = z.strictObject({
  slug: z.string().regex(SLUG),
  brand: z.string().min(1),
  key: z.string().startsWith(PREFIX),
  page_url: z.string().min(1),
  source_url: z.string().min(1),
  source_kind: z.enum(["header", "icon", "og", "fictional"]),
  use: z.literal("detection-reference"),
  fetched_at: z.iso.datetime(),
  media_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
  width: z.int().positive(),
  height: z.int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  fictional: z.boolean(),
  // The reference's variant (D03 T03 §5); absent on generations published before variants, read as wordmark.
  variant: z.enum(["wordmark", "icon"]).optional(),
});
export type Logo = z.infer<typeof Logo>;

export const LogoIndex = z
  .strictObject({
    version: z.literal(1),
    generation: z.string().regex(GENERATION),
    generated_at: z.iso.datetime(),
    logos: z.array(Logo),
    missing: z.array(z.strictObject({ slug: z.string().regex(SLUG), brand: z.string().min(1), reason: z.string() })),
  })
  .superRefine((index, ctx) => {
    const seen = new Set<string>();
    for (const logo of index.logos) {
      if (Math.max(logo.width, logo.height) < MIN_SIDE)
        ctx.addIssue({ code: "custom", message: `${logo.slug} is under ${MIN_SIDE} px on its longer side` });
      const identity = `${logo.slug}:${logo.variant ?? "wordmark"}`;
      if (seen.has(identity)) ctx.addIssue({ code: "custom", message: `${identity} is listed twice` });
      seen.add(identity);
      if (logo.key !== logoKey(index.generation, logo.slug, logo.media_type, logo.variant ?? "wordmark"))
        ctx.addIssue({ code: "custom", message: `${logo.slug}'s key is not in generation ${index.generation}` });
    }
    const storedSlugs = new Set(index.logos.map((logo) => logo.slug));
    for (const gone of index.missing) {
      if (storedSlugs.has(gone.slug))
        ctx.addIssue({ code: "custom", message: `${gone.slug} is both stored and missing` });
    }
  });
export type LogoIndex = z.infer<typeof LogoIndex>;

// The brand table's names, read without depending on the Worker's own schema.
export const brandNames = (table: { brands: { name: string }[] }) => table.brands.map((b) => b.name);
export const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// Every real brand exactly once across `logos` and `missing`; the real logos counted apart from the fictional ones.
export function coverage(index: LogoIndex, brands: string[]): { real: number; fictional: number; missing: number } {
  const real = index.logos.filter((l) => !l.fictional);
  // A brand counts once however many variants it holds (D03 T03 §5); it is missing only with no logo at all.
  const withLogo = new Set(real.map((l) => l.brand));
  const storedSlugs = new Set(real.map((l) => l.slug));
  // A variant's missing entry (its slug is a stored logo's slug) does not make its brand missing.
  const listed = [...withLogo, ...index.missing.filter((m) => !storedSlugs.has(m.slug)).map((m) => m.brand)];
  for (const brand of brands) {
    const n = listed.filter((b) => b === brand).length;
    if (n !== 1) throw new LoadRefused(`${brand} is listed ${n} times across logos and missing`);
  }
  const unknown = listed.filter((b) => !brands.includes(b));
  if (unknown.length > 0) throw new LoadRefused(`not in the brand table: ${unknown.join(", ")}`);
  return {
    real: withLogo.size,
    fictional: index.logos.filter((l) => l.fictional).length,
    missing: index.missing.filter((m) => !storedSlugs.has(m.slug)).length,
  };
}

// What a store must hold before it is published or passes its check: every real brand accounted for, at least
// MIN_REAL_BRANDS of them with a logo, and both fictional references. A `--only` capture never passes.
export function publishable(index: LogoIndex, brands: string[]) {
  const counts = coverage(index, brands);
  for (const f of FICTIONAL)
    if (!index.logos.some((l) => l.fictional && l.slug === f.slug))
      throw new LoadRefused(`the fictional reference ${f.slug} is missing`);
  if (counts.real < MIN_REAL_BRANDS)
    throw new LoadRefused(`only ${counts.real} real brands have a logo; at least ${MIN_REAL_BRANDS} must`);
  return counts;
}

// --- Capture ---------------------------------------------------------------------------------------------------------

export type Grabbed = { bytes: Uint8Array; pageUrl: string; sourceUrl: string };
// One brand's logo, from its page; it must give up once `signal` aborts.
export type Grab = (entry: SelectorEntry, signal: AbortSignal) => Promise<Grabbed>;
export type Fictional = { slug: string; brand: string; path: string; variant?: "wordmark" | "icon" };

export const FICTIONAL: Fictional[] = [
  { slug: "protea-bank", brand: "Protea Bank", path: "test/fixtures/brands/protea-bank.png" },
  { slug: "nimbusmail", brand: "NimbusMail", path: "test/fixtures/brands/nimbusmail.png" },
  { slug: "protea-bank", brand: "Protea Bank", path: "test/fixtures/brands/protea-bank-icon.png", variant: "icon" },
  { slug: "nimbusmail", brand: "NimbusMail", path: "test/fixtures/brands/nimbusmail-icon.png", variant: "icon" },
];

export const storeRoot = () => process.env.REFERENCE_LOGOS_DIR ?? join(homedir(), "isitlegit-data", "reference-logos");

function writeAtomic(path: string, bytes: Uint8Array | string) {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, bytes);
  renameSync(temp, path);
}

function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no logo within ${ms / 1000} s`));
    }, ms);
  });
  return Promise.race([work(controller.signal), late]).finally(() => clearTimeout(timer));
}

export async function capture(options: {
  table: SelectorTable;
  brands: { name: string; domains: string[] }[];
  grab: Grab;
  store?: string;
  now?: Date;
  grabMs?: number;
  fictional?: Fictional[];
  // One line per step as it happens (the brand, its position, each try and its outcome).
  log?: (line: string) => void;
  // An existing complete generation to finish: only its missing brands are tried again, and any logo they yield is
  // added. Logos it already holds are never touched, so a generation already loaded stays consistent with R2.
  into?: string;
}): Promise<{ dir: string; index: LogoIndex }> {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? new Date();
  const earlier = options.into
    ? parseIndex(
        new Uint8Array(readFileSync(join(options.store ?? storeRoot(), options.into, "index.json"))),
        options.into,
      )
    : null;
  const generation = earlier?.generation ?? generationOf(now);
  const dir = join(options.store ?? storeRoot(), generation);
  mkdirSync(dir, { recursive: true });
  const logos: Logo[] = earlier ? [...earlier.logos] : [];
  const missing: LogoIndex["missing"] = [];
  const brands = earlier
    ? options.brands.filter((b) => earlier.missing.some((m) => m.brand === b.name))
    : options.brands;
  if (earlier) missing.push(...earlier.missing.filter((m) => !brands.some((b) => b.name === m.brand)));
  const store = (
    slug: string,
    brand: string,
    grabbed: Grabbed,
    kind: Logo["source_kind"],
    fictional: boolean,
    variant: "wordmark" | "icon" = "wordmark",
  ) => {
    const info = imageInfo(grabbed.bytes);
    if (!info) throw new Error("not a PNG, JPEG or WebP image");
    if (Math.max(info.width, info.height) < MIN_SIDE)
      throw new Error(`${info.width} by ${info.height} px is under ${MIN_SIDE} px`);
    if (Math.max(info.width, info.height) > MAX_SIDE)
      throw new Error(`${info.width} by ${info.height} px is over ${MAX_SIDE} px`);
    const key = logoKey(generation, slug, info.type, variant);
    writeAtomic(join(dir, key.slice(key.lastIndexOf("/") + 1)), grabbed.bytes);
    logos.push({
      slug,
      brand,
      key,
      page_url: grabbed.pageUrl,
      source_url: grabbed.sourceUrl,
      source_kind: kind,
      use: "detection-reference",
      fetched_at: new Date().toISOString(),
      media_type: info.type,
      width: info.width,
      height: info.height,
      sha256: sha256(grabbed.bytes),
      fictional,
      variant,
    });
    return info;
  };
  for (const [i, brand] of brands.entries()) {
    const slug = slugOf(brand.name);
    const at = `[${i + 1}/${brands.length}] ${brand.name}`;
    const entries = options.table.logos.filter((e) => e.brand === brand.name);
    if (!entries.length) {
      missing.push({ slug, brand: brand.name, reason: "no entry in data/reference-logos.json" });
      log(`${at}: missing, no entry in data/reference-logos.json`);
      continue;
    }
    for (const entry of entries) {
      const variant = entry.variant ?? "wordmark";
      try {
        // A second try for a page that answers a bot check or a slow script once and the logo the next time, inside
        // the same per-brand deadline: a brand never takes longer than GRAB_MS, however its tries go.
        log(`${at}: try 1`);
        const grabbed = await withDeadline(
          (signal) =>
            options.grab(entry, signal).catch((error) => {
              if (signal.aborted) throw error;
              log(`${at}: try 2 (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
              return options.grab(entry, signal);
            }),
          options.grabMs ?? GRAB_MS,
        );
        // The page that showed the logo must be the brand's own, after every redirect.
        const domain = getDomain(grabbed.pageUrl);
        if (!domain || !brand.domains.includes(domain))
          throw new Error(`the page ended on ${new URL(grabbed.pageUrl).hostname}, not one of the brand's domains`);
        const stored = store(entry.slug, brand.name, grabbed, entry.kind, false, variant);
        log(`${at}: stored ${variant} ${stored.width} by ${stored.height} px`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // A missing variant is recorded only when the brand ends with no logo at all; coverage decides.
        missing.push({ slug: entry.slug, brand: brand.name, reason: `${variant}: ${reason}` });
        log(`${at}: missing ${variant}, ${reason.split("\n")[0]}`);
      }
    }
  }
  // The fictional references go into a new generation; one being finished already holds them.
  if (!earlier)
    for (const f of options.fictional ?? FICTIONAL) {
      const bytes = new Uint8Array(readFileSync(f.path));
      store(
        f.slug,
        f.brand,
        { bytes, pageUrl: `repo:${f.path}`, sourceUrl: `repo:${f.path}` },
        "fictional",
        true,
        f.variant ?? "wordmark",
      );
    }
  const index = LogoIndex.parse({
    version: 1,
    generation,
    generated_at: earlier?.generated_at ?? now.toISOString(),
    logos,
    missing,
  });
  writeAtomic(join(dir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  return { dir, index };
}

// A fallback image is read as it arrives and given up past `max` bytes, before it can fill memory.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export async function readCapped(answer: Response, max: number): Promise<Uint8Array> {
  const declared = Number(answer.headers.get("content-length") ?? "0");
  if (declared > max) throw new Error(`the image is ${declared} bytes, over the ${max}-byte limit`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = answer.body?.getReader();
  if (!reader) return new Uint8Array();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error(`the image passed the ${max}-byte limit`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

// The live grab: the page in headless Chromium at 1440 by 900 and device scale 4, so a logo of 64 CSS px or more
// reaches 256 px. Everything but the logo and the boxes that hold it is made invisible, so the screenshot holds the
// logo on its own header background (no hero image, cookie banner or neighbouring link).
// How long a grab waits for the page and its logo, each wait ended by the page's own events where it has them: the
// page settles on `load` and then network idle (bounded by `settleMs`), and a logo that has painted next to nothing is
// shot again every `gapMs` until `lateMs` have passed. The live load keeps the defaults; a test of refusals can bound
// them tighter so its cases fit well inside its own limit under load.
export type GrabTiming = { settleMs: number; lateMs: number; gapMs: number };
export const GRAB_TIMING: GrabTiming = { settleMs: 5_000, lateMs: 8_000, gapMs: 1_000 };

export async function chromiumGrab(
  timing: GrabTiming = GRAB_TIMING,
): Promise<{ grab: Grab; close: () => Promise<void> }> {
  const { chromium } = await import("playwright-core");
  const { chromiumPath } = await import("./lib/chromium.ts");
  const executablePath = chromiumPath();
  if (!executablePath) throw new LoadRefused("no headless Chromium found; set MOCKUP_CHROMIUM");
  const browser = await chromium.launch({ executablePath, args: ["--disable-http2"] });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: DEVICE_SCALE,
    locale: "en-ZA",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  });
  // A blank page of our own decodes screenshots: a brand's page may forbid `data:` images by its security policy.
  const decoder = await context.newPage();
  // The size an image decodes at in Chromium, or null when it does not decode.
  const decodedSize = (bytes: Uint8Array, type: string) =>
    decoder.evaluate(
      async ([b64, mime]) => {
        const image = new Image();
        image.src = `data:${mime};base64,${b64}`;
        try {
          await image.decode();
        } catch {
          return null;
        }
        return { width: image.naturalWidth, height: image.naturalHeight };
      },
      [Buffer.from(bytes).toString("base64"), type] as const,
    );
  // The share of pixels that differ clearly between two shots of the same clip (with and without the logo).
  const inkShare = (withLogo: Buffer, without: Buffer) =>
    decoder.evaluate(
      async ([a, b]) => {
        const pixels = async (b64: string) => {
          const image = new Image();
          image.src = `data:image/png;base64,${b64}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const draw = canvas.getContext("2d");
          draw?.drawImage(image, 0, 0);
          return draw?.getImageData(0, 0, canvas.width, canvas.height).data ?? new Uint8ClampedArray();
        };
        const [p, q] = [await pixels(a), await pixels(b)];
        if (p.length !== q.length || p.length === 0) return 0;
        let inked = 0;
        for (let i = 0; i < p.length; i += 4) {
          const d =
            Math.abs((p[i] ?? 0) - (q[i] ?? 0)) +
            Math.abs((p[i + 1] ?? 0) - (q[i + 1] ?? 0)) +
            Math.abs((p[i + 2] ?? 0) - (q[i + 2] ?? 0));
          if (d > 48) inked++;
        }
        return inked / (p.length / 4);
      },
      [withLogo.toString("base64"), without.toString("base64")] as const,
    );
  const grab: Grab = async (entry, signal) => {
    const page = await context.newPage();
    const close = () => page.close().catch(() => undefined);
    signal.addEventListener("abort", close, { once: true });
    try {
      await page.goto(entry.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      // Settled on the page's own events (its `load`, then no request for half a second), not a fixed pause: a quick
      // page goes on at once, and a page that keeps fetching is waited for no longer than `settleMs` each.
      await page.waitForLoadState("load", { timeout: timing.settleMs }).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: timing.settleMs }).catch(() => undefined);
      const startUrl = page.url();
      if (entry.kind !== "header") {
        const source = new URL(entry.selector, startUrl).href;
        const answer = await fetch(source, {
          redirect: "follow",
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        if (!answer.ok) throw new Error(`${source} answered ${answer.status}`);
        const bytes = await readCapped(answer, MAX_IMAGE_BYTES);
        // A header can promise an image the bytes do not hold (a truncated or corrupt file): it must decode, at the
        // size its header claims.
        const info = imageInfo(bytes);
        if (!info) throw new Error("not a PNG, JPEG or WebP image");
        if (Math.max(info.width, info.height) > MAX_SIDE)
          throw new Error(`${info.width} by ${info.height} px is over ${MAX_SIDE} px`);
        const decoded = await decodedSize(bytes, info.type);
        if (decoded?.width !== info.width || decoded.height !== info.height)
          throw new Error("the image does not decode (truncated or corrupt)");
        return { bytes, pageUrl: startUrl, sourceUrl: answer.url || source };
      }
      // The first visible match: a page often carries hidden copies of its logo (a mobile menu, a sticky header).
      const logo = page.locator(entry.selector).filter({ visible: true }).first();
      const lazy = page.locator(entry.selector).first();
      // A lazily loaded logo loads only once scrolled into view.
      await lazy.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
      await logo.waitFor({ state: "visible", timeout: 20_000 });
      // Held as a handle: once the page is hidden below, a visible-only locator would no longer find it.
      const element = await logo.elementHandle({ timeout: 10_000 });
      if (!element) throw new Error("the logo element went away");
      // Isolate the logo: every element that is neither the logo, inside it, nor one of its ancestors is made
      // invisible. Ancestors keep painting their own backgrounds, so a white logo stays on its header colour, while
      // hero images, banners and neighbouring links disappear.
      await page.addStyleTag({
        content: "body * { visibility: hidden !important; animation: none !important; transition: none !important; }",
      });
      await element.evaluate((element, zoom) => {
        const show = (e: Element) => (e as HTMLElement).style.setProperty("visibility", "visible", "important");
        for (const e of [element, ...element.querySelectorAll("*")]) show(e);
        // Up through the ancestors, crossing out of a shadow root to its host (a logo inside a web component).
        // Crossing out of a shadow root, the page's hiding rule does not reach inside it: the root gets its own.
        const parent = (e: Element) => {
          if (e.parentElement) return e.parentElement;
          const root = e.getRootNode();
          if (!(root instanceof ShadowRoot)) return null;
          const style = document.createElement("style");
          style.textContent = "* { visibility: hidden !important; }";
          root.append(style);
          return root.host;
        };
        for (let up = parent(element); up && up !== document.body; up = parent(up)) show(up);
        // A header that fades in by script (an opacity animation the stylesheet cannot stop) is shown at full strength,
        // or the shot may catch it nearly transparent.
        for (let up: Element | null = element; up && up !== document.body; up = parent(up))
          (up as HTMLElement).style.setProperty("opacity", "1", "important");
        // A small vector logo is scaled up by transform, which the element's box (and so the screenshot) follows
        // without reflowing the header around it.
        if (zoom > 1) {
          const box = element as HTMLElement;
          // Scaled, the logo spills past the header that painted its background: it carries that colour itself.
          for (let up: Element | null = element; up && up !== document.documentElement; up = parent(up)) {
            const colour = getComputedStyle(up).backgroundColor;
            if (colour !== "rgba(0, 0, 0, 0)" && colour !== "transparent") {
              box.style.setProperty("background-color", colour, "important");
              break;
            }
          }
          box.style.setProperty("transform", `scale(${zoom})`, "important");
          box.style.setProperty("transform-origin", "top left", "important");
        }
      }, entry.zoom ?? 1);
      // Every image in the logo decoded and two frames painted before the shot, so a slow image is not taken blank.
      await element.evaluate(async (e) => {
        const images = [e, ...e.querySelectorAll("img")].filter(
          (i): i is HTMLImageElement => i instanceof HTMLImageElement,
        );
        await Promise.all(images.map((i) => i.decode().catch(() => undefined)));
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      });
      // Chrome's own capture of the page at the element's box: Playwright's screenshots first wait for the element to
      // stop moving and for every web font, which a page with a script-driven header or a stalled font never allows,
      // and a clip outside the viewport is taken as well (`captureBeyondViewport`).
      const box = await element.boundingBox();
      if (!box || box.width < 1 || box.height < 1) throw new Error("the logo has no size on the page");
      // Bounded before any shot: a box larger than a reference may be is refused, never rendered at device scale.
      const side = Math.ceil(Math.max(box.width, box.height) * DEVICE_SCALE);
      if (side > MAX_SIDE) throw new Error(`the logo's box is ${side} px at device scale, over ${MAX_SIDE} px`);
      const cdp = await page.context().newCDPSession(page);
      const take = async () => {
        const shot = (await cdp.send("Page.captureScreenshot", {
          format: "png",
          // The clip is in CSS pixels; `scale` renders it at the context's device scale.
          clip: { ...box, scale: DEVICE_SCALE },
          captureBeyondViewport: true,
        })) as { data: string };
        return Buffer.from(shot.data, "base64");
      };
      // A logo that painted nothing, or next to nothing (an image still loading, a page stuck on its loading screen, a
      // header still fading in), is not taken: at least MIN_INK of the clip's pixels must change clearly when the logo
      // is made transparent. A late logo is shot again every `gapMs` until `lateMs` have passed.
      const fade = (opacity: string) =>
        element.evaluate(async (e, value) => {
          (e as HTMLElement).style.setProperty("opacity", value, "important");
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        }, opacity);
      let bytes = await take();
      const lateBy = Date.now() + timing.lateMs;
      for (;;) {
        await fade("0");
        const ink = await inkShare(bytes, await take());
        await fade("1");
        if (ink >= MIN_INK) break;
        if (Date.now() >= lateBy)
          throw new Error(
            `the logo painted next to nothing (${(ink * 100).toFixed(1)}% of its pixels; still loading?)`,
          );
        await page.waitForTimeout(timing.gapMs);
        bytes = await take();
      }
      // Provenance is the document the logo was taken from, read after the shot: a page that navigated meanwhile (a
      // script redirect after the wait) is refused, never recorded under the address it started on.
      const pageUrl = await element.evaluate((e) => e.ownerDocument.location.href);
      if (page.url() !== startUrl || pageUrl !== startUrl)
        throw new Error(`the page moved from ${startUrl} to ${page.url()} while the logo was taken`);
      return { bytes: new Uint8Array(bytes), pageUrl, sourceUrl: pageUrl };
    } finally {
      await close();
    }
  };
  return { grab, close: () => browser.close() };
}

// --- Load and check --------------------------------------------------------------------------------------------------

// One Wrangler command, stopped after `timeoutMs` (a stopped command answers a null status).
export type Run = (args: string[], timeoutMs: number) => { status: number | null; stdout: string; stderr: string };
const wrangler: Run = (args, timeoutMs) => {
  const done = spawnSync("pnpm", ["exec", "wrangler", ...args], { encoding: "utf8", timeout: timeoutMs });
  return { status: done.status, stdout: done.stdout ?? "", stderr: done.stderr ?? "" };
};
const COMMAND_MS = 60_000;

// Why a Wrangler command failed, as a next step the operator can take. Its own output is read, never printed: it can
// name accounts and paths.
export function wranglerFailure(done: { status: number | null; stdout: string; stderr: string }): string {
  const said = `${done.stdout}\n${done.stderr}`;
  if (done.status === null)
    return `Wrangler did not answer within ${COMMAND_MS / 1000} s; check the connection, then retry`;
  if (
    /not (?:logged|signed) in|authenticat|unauthori[sz]ed|\b401\b|\b403\b|permission denied for|\[code: 10000\]/i.test(
      said,
    )
  )
    return "Wrangler is not signed in or lacks R2 rights: run `pnpm exec wrangler login` (or check the token), then retry";
  if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network/i.test(said))
    return "Cloudflare could not be reached: check the network, then retry";
  if (/ENOSPC|EACCES|EROFS|EPERM|no space left/i.test(said))
    return "the local disk refused the file: free space or fix the folder's permissions, then retry";
  return `Wrangler exited ${done.status}; rerun the command by hand to see why`;
}

function bucket(run: Run, target: "local" | "remote", dir: string) {
  const where = `--${target}`;
  const inside = (key: string) => {
    if (!key.startsWith(PREFIX) || key.includes(".."))
      throw new LoadRefused(`refusing a key outside ${PREFIX}: ${key}`);
    return `${BUCKET}/${key}`;
  };
  let n = 0;
  return {
    put(key: string, path: string, type: string) {
      const done = run(["r2", "object", "put", inside(key), "--file", path, "--content-type", type, where], COMMAND_MS);
      if (done.status !== 0) throw new LoadRefused(`writing ${key} failed: ${wranglerFailure(done)}`);
    },
    // The object's bytes, or null when there is no such key.
    get(key: string): Uint8Array | null {
      const path = join(dir, `get-${n++}`);
      const done = run(["r2", "object", "get", inside(key), "--file", path, where], COMMAND_MS);
      if (done.status !== 0 && MISSING_OBJECT.test(done.stdout + done.stderr)) return null;
      if (done.status !== 0) throw new LoadRefused(`reading ${key} failed: ${wranglerFailure(done)}`);
      return new Uint8Array(readFileSync(path));
    },
  };
}

const parseIndex = (bytes: Uint8Array, what: string): LogoIndex => {
  const parsed = LogoIndex.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
  if (!parsed.success) throw new LoadRefused(`${what} is malformed: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
};

// The generation folders of the local store, newest last.
export const generations = (store = storeRoot()) =>
  readdirSync(store)
    .filter((d) => GENERATION.test(d))
    .sort();

export type LoadOptions = {
  target: "local" | "remote";
  // The brand table's names: a generation that does not cover them is never published.
  brands: string[];
  store?: string;
  generation?: string;
  dryRun?: boolean;
  restore?: boolean;
  run?: Run;
  log?: (line: string) => void;
};

export function load(options: LoadOptions): { generation: string; keys: string[] } {
  const run = options.run ?? wrangler;
  const log = options.log ?? console.log;
  const temp = mkdtempSync(join(tmpdir(), "reference-logos-"));
  try {
    const r2 = bucket(run, options.target, temp);
    if (options.restore) {
      const previous = r2.get(PREVIOUS_KEY);
      if (!previous) throw new LoadRefused(`there is no ${PREVIOUS_KEY} to restore`);
      const index = parseIndex(previous, PREVIOUS_KEY);
      const path = join(temp, "index.json");
      writeFileSync(path, previous);
      if (options.dryRun) {
        log(
          `would run: wrangler r2 object put ${BUCKET}/${INDEX_KEY} --file <${PREVIOUS_KEY}> --content-type application/json --${options.target} (generation ${index.generation})`,
        );
        return { generation: index.generation, keys: [INDEX_KEY] };
      }
      r2.put(INDEX_KEY, path, "application/json");
      if (!sameBytes(r2.get(INDEX_KEY), previous)) throw new LoadRefused(`${INDEX_KEY} did not read back as written`);
      return { generation: index.generation, keys: [INDEX_KEY] };
    }
    const store = options.store ?? storeRoot();
    // By default the newest complete generation: a capture that stopped part way (no index.json yet) is skipped, and
    // said so, never loaded and never in the way of an earlier complete one.
    const all = generations(store);
    const complete = all.filter((g) => existsSync(join(store, g, "index.json")));
    const generation = options.generation ?? complete.at(-1);
    if (!generation) throw new LoadRefused(`no complete generation in ${store}; run capture first`);
    if (!options.generation)
      for (const g of all.filter((g) => g > generation))
        log(`skipping ${g}: the capture did not finish (no index.json)`);
    const dir = join(store, generation);
    const indexBytes = new Uint8Array(readFileSync(join(dir, "index.json")));
    const index = parseIndex(indexBytes, `${dir}/index.json`);
    if (index.generation !== generation)
      throw new LoadRefused(`${dir}/index.json names generation ${index.generation}`);
    publishable(index, options.brands);
    // Every file is checked before anything is written: a load never starts on a store that changed after capture.
    const files = index.logos.map((logo) => {
      const path = join(dir, logo.key.slice(logo.key.lastIndexOf("/") + 1));
      const bytes = new Uint8Array(readFileSync(path));
      const info = imageInfo(bytes);
      if (
        sha256(bytes) !== logo.sha256 ||
        info?.type !== logo.media_type ||
        info.width !== logo.width ||
        info.height !== logo.height
      )
        throw new LoadRefused(`${path} does not match the index (hash, type or size)`);
      return { logo, path };
    });
    const keys = [...files.map((f) => f.logo.key), INDEX_KEY];
    if (options.dryRun) {
      const where = `--${options.target}`;
      for (const { logo, path } of files)
        log(
          `would run: wrangler r2 object put ${BUCKET}/${logo.key} --file ${path} --content-type ${logo.media_type} ${where}`,
        );
      log(`would run: wrangler r2 object get ${BUCKET}/${INDEX_KEY} --file <temp> ${where} (the live index)`);
      log(
        `would run, if the live index exists and differs: wrangler r2 object put ${BUCKET}/${PREVIOUS_KEY} --file <that copy> --content-type application/json ${where}`,
      );
      log(
        `would run: wrangler r2 object put ${BUCKET}/${INDEX_KEY} --file ${join(dir, "index.json")} --content-type application/json ${where} (generation ${generation})`,
      );
      log(`would run: wrangler r2 object get ${BUCKET}/${INDEX_KEY} --file <temp> ${where} (read back and compared)`);
      return { generation, keys };
    }
    for (const { logo, path } of files) r2.put(logo.key, path, logo.media_type);
    // The index it replaces becomes the rollback copy, unless it is this same index (a retried load).
    const live = r2.get(INDEX_KEY);
    if (live && !sameBytes(live, indexBytes)) {
      const path = join(temp, "previous.json");
      writeFileSync(path, live);
      r2.put(PREVIOUS_KEY, path, "application/json");
    }
    r2.put(INDEX_KEY, join(dir, "index.json"), "application/json");
    if (!sameBytes(r2.get(INDEX_KEY), indexBytes)) throw new LoadRefused(`${INDEX_KEY} did not read back as written`);
    return { generation, keys };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const sameBytes = (a: Uint8Array | null, b: Uint8Array) =>
  a !== null && a.length === b.length && a.every((byte, i) => byte === b[i]);

export function check(options: { target: "local" | "remote"; brands: string[]; run?: Run }): {
  real: number;
  fictional: number;
  missing: number;
  generation: string;
} {
  const run = options.run ?? wrangler;
  const temp = mkdtempSync(join(tmpdir(), "reference-logos-check-"));
  try {
    const r2 = bucket(run, options.target, temp);
    const bytes = r2.get(INDEX_KEY);
    if (!bytes) throw new LoadRefused(`there is no ${INDEX_KEY}`);
    const index = parseIndex(bytes, INDEX_KEY);
    const counts = publishable(index, options.brands);
    for (const logo of index.logos) {
      const object = r2.get(logo.key);
      if (!object) throw new LoadRefused(`${logo.key} is listed but not in R2`);
      const info = imageInfo(object);
      if (
        sha256(object) !== logo.sha256 ||
        info?.type !== logo.media_type ||
        info.width !== logo.width ||
        info.height !== logo.height
      )
        throw new LoadRefused(`${logo.key} in R2 does not match the index (hash, type or size)`);
    }
    return { ...counts, generation: index.generation };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// --- Command line ----------------------------------------------------------------------------------------------------

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      local: { type: "boolean", default: false },
      remote: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      restore: { type: "boolean", default: false },
      generation: { type: "string" },
      only: { type: "string" },
      into: { type: "string" },
    },
  });
  const command = values.check ? "check" : positionals[0];
  const brandTable = JSON.parse(readFileSync("data/brands.json", "utf8")) as {
    brands: { name: string; domains: string[] }[];
  };
  const target = () => {
    if (values.local === values.remote) {
      console.error("load-reference-logos: name the target, --local or --remote");
      process.exit(2);
    }
    return values.local ? "local" : "remote";
  };
  try {
    if (command === "capture") {
      const table = SelectorTable.parse(JSON.parse(readFileSync("data/reference-logos.json", "utf8")));
      // `--only` names brands to capture alone (comma-separated), for checking a selector; it is not a full store.
      const only = values.only?.split(",").map((name) => name.trim());
      const brands = only ? brandTable.brands.filter((b) => only.includes(b.name)) : brandTable.brands;
      const browser = await chromiumGrab();
      try {
        const { dir, index } = await capture({
          table,
          brands,
          grab: browser.grab,
          log: (line) => console.log(line),
          ...(values.into ? { into: values.into } : {}),
        });
        for (const gone of index.missing) console.log(`missing ${gone.slug}: ${gone.reason}`);
        console.log(`reference logos: captured ${index.logos.length} into ${dir} (${index.missing.length} missing)`);
      } finally {
        await browser.close();
      }
    } else if (command === "load") {
      const { generation, keys } = load({
        target: target(),
        brands: brandNames(brandTable),
        ...(values.generation ? { generation: values.generation } : {}),
        dryRun: values["dry-run"],
        restore: values.restore,
      });
      console.log(
        `reference logos: ${values["dry-run"] ? "would write" : "wrote"} ${keys.length} objects (generation ${generation})`,
      );
    } else if (command === "check") {
      const c = check({ target: target(), brands: brandNames(brandTable) });
      console.log(
        `reference logos: ${c.real} brands in R2 (${c.fictional} fictional, ${c.missing} missing; generation ${c.generation})`,
      );
    } else {
      console.error(
        "load-reference-logos: capture | load --local|--remote [--dry-run] [--restore] | --check --local|--remote",
      );
      process.exit(2);
    }
  } catch (error) {
    console.error(`load-reference-logos: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
