// The Loupe training store (D03 T04 §3): every page the dataset is built from, kept outside every git work tree so no
// page (some carry redacted client mail) can be one `git add` from a public leak.
//
//   <store>/pages/<id>/screenshot.jpg   JPEG, at most 1280 by 2000 pixels
//   <store>/pages/<id>/text.txt         the visible text
//   <store>/pages/<id>/meta.json        source, origin, licence, host, template, south_africa, labels, label_source,
//                                       sha256, redacted
//
// `<id>` is the source and the first 16 hex digits of the SHA-256 of the screenshot and text, so the same page stored
// twice is one page. A page is written in a temporary folder and renamed into place, so an interrupted write leaves no
// partial page. The store is `GLIMMER_DATA_DIR`, default `~/isitlegit-data/glimmer`, as scripts/astra-collect.py
// resolves it.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { jpegSize, LURE_TYPES } from "../../src/vision/page-screen.ts";

const ROOT = resolve(import.meta.dirname, "../..");
export const MAX_WIDTH = 1280;
export const MAX_HEIGHT = 2000;

export const ORIGINS = ["public", "benign", "samples", "synthetic"] as const;
export const LABEL_SOURCES = ["ground-truth", "dom", "construction", "spark", "astra+claude", "claude"] as const;

// What is known of a page's PageAnswer fields; a field not yet decided is absent (D03 T04 §9 fills them).
export const Labels = z.strictObject({
  brand: z.string().min(1).max(200).nullable().optional(),
  has_login_form: z.boolean().optional(),
  has_payment_form: z.boolean().optional(),
  lure: z.boolean().optional(),
  lure_type: z.enum(LURE_TYPES).optional(),
});
export type Labels = z.infer<typeof Labels>;
const LabelSources = z.strictObject(
  Object.fromEntries(Object.keys(Labels.shape).map((k) => [k, z.enum(LABEL_SOURCES).optional()])) as Record<
    keyof Labels,
    z.ZodOptional<z.ZodEnum<{ [K in (typeof LABEL_SOURCES)[number]]: K }>>
  >,
);

export const PageMeta = z
  .strictObject({
    source: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
    origin: z.enum(ORIGINS),
    licence: z.string().min(1),
    host: z.string().min(1).nullable(),
    template: z.string().min(1).nullable(),
    south_africa: z.boolean(),
    labels: Labels,
    label_source: LabelSources,
    sha256: z.strictObject({ screenshot: z.string().length(64), text: z.string().length(64) }),
    redacted: z.boolean(),
  })
  .refine((meta) => Object.keys(meta.label_source).every((k) => k in meta.labels), {
    message: "every label_source names a label the page has",
    path: ["label_source"],
  })
  .refine((meta) => Object.keys(meta.labels).every((k) => k in meta.label_source), {
    message: "every label has its source",
    path: ["label_source"],
  });
export type PageMeta = z.infer<typeof PageMeta>;

export type PageInput = Omit<PageMeta, "source" | "sha256"> & { screenshot: Uint8Array; text: string };
export type StoredPage = PageMeta & { id: string };

// Whether `path` lies in this repository or any git work tree, judged from its nearest existing folder; without git it
// cannot be shown outside one, so it counts as inside.
export function insideRepository(path: string): boolean {
  if (path === ROOT || path.startsWith(`${ROOT}/`)) return true;
  let existing = path;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return false;
    existing = parent;
  }
  const probe = spawnSync("git", ["-C", existing, "rev-parse", "--is-inside-work-tree"], { encoding: "utf-8" });
  if (probe.error) return true;
  return probe.status === 0 && probe.stdout.trim() === "true";
}

export function storeDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.GLIMMER_DATA_DIR;
  const path = resolve(configured || join(env.HOME || homedir(), "isitlegit-data", "glimmer"));
  if (insideRepository(path))
    throw new Error(`the Glimmer store ${path} lies in a git work tree; set GLIMMER_DATA_DIR outside every repository`);
  return path;
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

export type Writer = (path: string, data: Uint8Array | string) => void;

export function openStore(dir: string = storeDir(), options: { write?: Writer } = {}) {
  if (insideRepository(resolve(dir))) throw new Error(`the Glimmer store ${dir} lies in a git work tree`);
  const pages = join(dir, "pages");
  const write: Writer = options.write ?? ((path, data) => writeFileSync(path, data));

  function putPage(source: string, page: PageInput): string {
    const size = jpegSize(page.screenshot);
    if (!size) throw new TypeError("the screenshot is not a JPEG");
    if (size.width > MAX_WIDTH || size.height > MAX_HEIGHT)
      throw new RangeError(`the screenshot is ${size.width} by ${size.height}; at most ${MAX_WIDTH} by ${MAX_HEIGHT}`);
    const { screenshot, text, ...rest } = page;
    const meta = PageMeta.parse({
      ...rest,
      source,
      sha256: { screenshot: sha256(screenshot), text: sha256(text) },
    });
    const id = `${source}-${createHash("sha256").update(screenshot).update("\0").update(text).digest("hex").slice(0, 16)}`;
    const final = join(pages, id);
    if (existsSync(final)) return id;
    mkdirSync(pages, { recursive: true });
    const temporary = join(pages, `.tmp-${id}-${process.pid}-${randomBytes(4).toString("hex")}`);
    mkdirSync(temporary);
    try {
      write(join(temporary, "screenshot.jpg"), screenshot);
      write(join(temporary, "text.txt"), text);
      write(join(temporary, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
      try {
        renameSync(temporary, final);
      } catch (error) {
        // Another writer stored the same page first: it is the same content, so this copy goes.
        if (!existsSync(final)) throw error;
        rmSync(temporary, { recursive: true, force: true });
      }
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
    return id;
  }

  function manifest(): StoredPage[] {
    if (!existsSync(pages)) return [];
    return readdirSync(pages)
      .filter((name) => !name.startsWith(".") && statSync(join(pages, name)).isDirectory())
      .sort()
      .map((id) => ({ id, ...PageMeta.parse(JSON.parse(readFileSync(join(pages, id, "meta.json"), "utf-8"))) }));
  }

  function counts() {
    const bySource: Record<string, number> = {};
    const byLabel = { lure: 0, benign: 0, unlabelled: 0 };
    for (const page of manifest()) {
      bySource[page.source] = (bySource[page.source] ?? 0) + 1;
      if (page.labels.lure === true) byLabel.lure++;
      else if (page.labels.lure === false) byLabel.benign++;
      else byLabel.unlabelled++;
    }
    return { total: Object.values(bySource).reduce((a, b) => a + b, 0), bySource, byLabel };
  }

  function readPage(id: string) {
    const folder = join(pages, id);
    return {
      screenshot: new Uint8Array(readFileSync(join(folder, "screenshot.jpg"))),
      text: readFileSync(join(folder, "text.txt"), "utf-8"),
    };
  }

  return { dir, putPage, manifest, counts, readPage };
}
