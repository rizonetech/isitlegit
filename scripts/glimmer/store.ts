// The Loupe training store (D03 T04 §3): every page the dataset is built from, kept outside every git work tree so no
// page (some carry redacted client mail) can be one `git add` from a public leak.
//
//   <store>/pages/<id>/screenshot.jpg   JPEG, at most 1280 by 2000 pixels
//   <store>/pages/<id>/text.txt         the visible text
//   <store>/pages/<id>/meta.json        source, origin, licence, host, template, south_africa, labels, label_source,
//                                       sha256, redacted
//
// `<id>` is the source and the first 16 hex digits of the SHA-256 of the screenshot and text, so the same page stored
// twice is one page. A page is written in a temporary folder, each file and the folder flushed to disk, and renamed
// into place, then the parent flushed, so a page is either whole or absent after a crash. Opening the store removes
// temporary folders a dead writer left; `verify()` names any page whose files no longer match their hashes, and a
// repeated `putPage` replaces such a page instead of reporting it stored. `removeSource()` takes a source's pages out
// whole (D03 T04 §5 removes a source whose licence or files fail Claude's check). Every screenshot is decoded with
// sharp (libvips) at its strictest before it is stored: `jpegSize` is the fast early check, the decoder is the proof
// that Fireworks gets a whole image. The store is `GLIMMER_DATA_DIR`,
// default `~/isitlegit-data/glimmer`, as scripts/astra-collect.py resolves it.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { HOST, jpegSize, LURE_TYPES } from "../../src/vision/page-screen.ts";

const ROOT = resolve(import.meta.dirname, "../..");
export const MAX_WIDTH = 1280;
export const MAX_HEIGHT = 2000;

export const ORIGINS = ["public", "benign", "samples", "synthetic"] as const;
// What a benign render's list said the page is (D03 T04 §6): a homepage, or a South African page of one kind.
export const PAGE_KINDS = ["home", "login", "checkout", "account", "shop", "company", "social"] as const;
// `unverified` marks a label from a public set whose spot check found more than 10 percent errors (D03 T04 §5): it is
// kept out of evaluation and goes to §9's Astra and Claude adjudication, never trusted as ground truth.
export const LABEL_SOURCES = [
  "ground-truth",
  "dom",
  "construction",
  "spark",
  "astra+claude",
  "claude",
  "unverified",
] as const;

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
    host: z.string().regex(HOST, "a lowercase DNS name").nullable(),
    template: z.string().min(1).nullable(),
    south_africa: z.boolean(),
    labels: Labels,
    label_source: LabelSources,
    sha256: z.strictObject({ screenshot: z.string().length(64), text: z.string().length(64) }),
    redacted: z.boolean(),
    // The listed URL a benign page was rendered from, and its list's kind (§6); other origins leave them out.
    url: z.string().url().optional(),
    kind: z.enum(PAGE_KINDS).optional(),
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
  const home = env.HOME || homedir();
  // `~` is expanded as scripts/astra-collect.py expands it, so both read one setting the same way.
  const expanded =
    configured === "~" ? home : configured?.startsWith("~/") ? join(home, configured.slice(2)) : configured;
  const path = resolve(expanded || join(home, "isitlegit-data", "glimmer"));
  if (insideRepository(path))
    throw new Error(`the Glimmer store ${path} lies in a git work tree; set GLIMMER_DATA_DIR outside every repository`);
  return path;
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

export type Writer = (path: string, data: Uint8Array | string) => void;
export type Sync = (path: string) => void;

function flush(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function openStore(dir: string = storeDir(), options: { write?: Writer; sync?: Sync } = {}) {
  if (insideRepository(resolve(dir))) throw new Error(`the Glimmer store ${dir} lies in a git work tree`);
  const pages = join(dir, "pages");
  const sync: Sync = options.sync ?? flush;
  // Each file is flushed to disk before the page that holds it is published.
  const write: Writer =
    options.write ??
    ((path, data) => {
      writeFileSync(path, data);
      sync(path);
    });
  // A temporary folder whose writer is gone is an interrupted page: never published, so it is removed.
  if (existsSync(pages))
    for (const name of readdirSync(pages)) {
      const writer = /^\.(?:tmp-.+-(\d+)-[0-9a-f]{8}|removing-.+-(\d+))$/.exec(name);
      const pid = writer ? Number(writer[1] ?? writer[2]) : 0;
      if (writer && !processAlive(pid)) rmSync(join(pages, name), { recursive: true, force: true });
    }

  // Folders whose entry in their parent is not yet known to be on disk: the parents still to flush. A folder's entry
  // lives in its parent, so the first page of a new store is durable only once every folder created above it has had
  // its parent flushed. A parent whose flush failed stays here, so a retry flushes it again rather than trusting that
  // the folder exists. Opening an existing store adds its own parents once, since an earlier process may have created
  // them and died before flushing.
  const unflushed = new Set<string>();
  if (existsSync(dir)) {
    unflushed.add(dirname(dir));
    if (existsSync(pages)) unflushed.add(dir);
  }

  function makeDurableDirs(path: string): void {
    const missing: string[] = [];
    for (let at = path; !existsSync(at); at = dirname(at)) missing.unshift(at);
    for (const folder of missing) {
      mkdirSync(folder);
      unflushed.add(dirname(folder));
    }
    for (const parent of [...unflushed]) {
      sync(parent);
      unflushed.delete(parent);
    }
  }

  // Whether a stored page's files still match the hashes its meta.json records.
  function intact(id: string): boolean {
    try {
      const folder = join(pages, id);
      const meta = PageMeta.parse(JSON.parse(readFileSync(join(folder, "meta.json"), "utf-8")));
      return (
        sha256(readFileSync(join(folder, "screenshot.jpg"))) === meta.sha256.screenshot &&
        sha256(readFileSync(join(folder, "text.txt"))) === meta.sha256.text
      );
    } catch {
      return false; // a page whose files cannot be read or parsed is not intact: that is the answer, not an error
    }
  }

  async function putPage(source: string, page: PageInput): Promise<string> {
    const header = jpegSize(page.screenshot);
    if (!header) throw new TypeError("the screenshot is not a JPEG");
    // The size is checked from the header before anything is decoded, and the decoder is held to the same limit, so a
    // huge image is refused without its pixels ever being allocated.
    if (header.width > MAX_WIDTH || header.height > MAX_HEIGHT)
      throw new RangeError(
        `the screenshot is ${header.width} by ${header.height}; at most ${MAX_WIDTH} by ${MAX_HEIGHT}`,
      );
    let size: { width: number; height: number };
    try {
      const decoded = await sharp(page.screenshot, { failOn: "warning", limitInputPixels: MAX_WIDTH * MAX_HEIGHT })
        .raw()
        .toBuffer({ resolveWithObject: true });
      size = { width: decoded.info.width, height: decoded.info.height };
    } catch (error) {
      const reason = (error as Error).message.split("\n")[0];
      throw new TypeError(`the screenshot is not a JPEG that decodes whole (${reason})`);
    }
    if (size.width > MAX_WIDTH || size.height > MAX_HEIGHT)
      throw new RangeError(`the screenshot is ${size.width} by ${size.height}; at most ${MAX_WIDTH} by ${MAX_HEIGHT}`);
    const { screenshot, text, ...rest } = page;
    const meta = PageMeta.parse({
      ...rest,
      source,
      sha256: { screenshot: sha256(screenshot), text: sha256(text) },
    });
    const digest = createHash("sha256").update(screenshot).update("\0").update(text).digest("hex");
    const id = `${source}-${digest.slice(0, 16)}`;
    const final = join(pages, id);
    if (existsSync(final)) {
      if (intact(id)) {
        // A retry after a failed flush finds the page published but maybe not on disk: flush it again before saying so.
        sync(final);
        sync(pages);
        return id;
      }
      // A damaged copy is not this page: it is set aside and the page written again.
      renameSync(final, join(pages, `.damaged-${id}-${Date.now()}`));
    }
    makeDurableDirs(pages);
    const temporary = join(pages, `.tmp-${id}-${process.pid}-${randomBytes(4).toString("hex")}`);
    mkdirSync(temporary);
    try {
      write(join(temporary, "screenshot.jpg"), screenshot);
      write(join(temporary, "text.txt"), text);
      write(join(temporary, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
      sync(temporary);
      let published = false;
      try {
        renameSync(temporary, final);
        published = true;
      } catch (error) {
        // Another writer stored the same page first: it is the same content, so this copy goes.
        if (!existsSync(final)) throw error;
        rmSync(temporary, { recursive: true, force: true });
      }
      // Outside the rename's catch: a failed flush is a failed write, never "another writer won".
      if (published) sync(pages);
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

  // Every stored page whose files no longer match their hashes, or whose meta.json does not read.
  function verify(): { intact: number; damaged: string[] } {
    if (!existsSync(pages)) return { intact: 0, damaged: [] };
    const ids = readdirSync(pages).filter((name) => !name.startsWith(".") && statSync(join(pages, name)).isDirectory());
    const damaged = ids.filter((id) => !intact(id)).sort();
    return { intact: ids.length - damaged.length, damaged };
  }

  // Takes every page of one source out of the store, each folder renamed out of view before it is deleted, so a page
  // is never half removed. Returns how many went.
  function removeSource(source: string): number {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(source)) throw new TypeError("not a source name");
    if (!existsSync(pages)) return 0;
    let removed = 0;
    for (const name of readdirSync(pages)) {
      // A page `<source>-<16 hex>`, or a damaged copy of one set aside by putPage, `.damaged-<source>-<16 hex>-<ms>`.
      const page = /^(.+)-[0-9a-f]{16}$/.exec(name);
      const damaged = /^\.damaged-(.+)-[0-9a-f]{16}-\d+$/.exec(name);
      const owner = page && !name.startsWith(".") ? page[1] : damaged?.[1];
      if (owner !== source) continue; // `public-a-…` is not a page of source `public`
      const gone = join(pages, `.removing-${name.replace(/^\./, "")}-${process.pid}`);
      renameSync(join(pages, name), gone);
      rmSync(gone, { recursive: true, force: true });
      if (page && !name.startsWith(".")) removed++;
    }
    sync(pages);
    return removed;
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

  return { dir, putPage, manifest, counts, readPage, verify, removeSource };
}
