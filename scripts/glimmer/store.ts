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
  appendFileSync,
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
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { HOST, inEscalationBand, jpegSize, LURE_TYPES, PageAnswer } from "../../src/vision/page-screen.ts";
import { EMAIL, LONG_NUMBER, PHONE } from "./redact.ts";

const ROOT = resolve(import.meta.dirname, "../..");
export const MAX_WIDTH = 1280;
export const MAX_HEIGHT = 2000;

export const ORIGINS = ["public", "benign", "samples", "synthetic", "production"] as const;
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
  // A value derived by a fixed rule from the page's other labels (D03 T04 §9: a lure's type from its form flags). It
  // trains, but evaluation never trusts it.
  "rule",
  // A source's brand kept only to group and cap pages (D03 T04 §45): never a trusted label, never taught or scored.
  "grouping-only",
  // The §9 teacher labelling a captured production page (D03 T04 §49): it trains only after judging and admission.
  "spark-teacher",
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
    // The dataset item a public or sample page came from (its file, row or member id), so every stored page traces
    // back to its source row and a resumed import skips what it already stored (§5).
    item: z.string().min(1).max(500).optional(),
    // The item's input digest (its row's SHA-256) when the page was rendered from it (§28 G4).
    input: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    // Every dataset item this content stands for once a second item brought the same content (§28, G3): each with the
    // lure label it was given, so items with one content and contradictory labels are found (`applyRules` excludes the
    // page) whichever arrived first. A page one item stands for has none.
    items: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(500),
          input: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional(),
          lure: z.boolean().optional(),
          lure_type: z.enum(LURE_TYPES).optional(),
        }),
      )
      .max(10_000)
      .optional(),
    // A captured production page's settling provenance (D03 T04 §46): when it settled, which tier settled it, that
    // answer, and Loupe's own answer when the page escalated past it.
    capture: z
      .strictObject({
        settled_at: z.string().min(1),
        tier: z.string().min(1).max(40),
        screener: z.enum(["glimmer", "spark"]),
        settling: PageAnswer,
        loupe: PageAnswer.optional(),
        calls: z
          .array(z.strictObject({ callId: z.string().min(1), logId: z.string().nullable() }))
          .max(4)
          .optional(),
      })
      .optional(),
    // What a benign render saw beside the text (its title and what was drawn over the page), so a later wall check can
    // judge a stored page as it judged the capture (§26).
    // The structural readings are kept too, so the same refusals apply to a stored page (a record from before they were
    // kept lacks them).
    evidence: z
      .strictObject({
        title: z.string().max(2000),
        overlays: z.string().max(8000),
        captcha: z.boolean().optional(),
        consentWall: z.boolean().optional(),
        challengeCover: z.boolean().optional(),
        wall: z.boolean().optional(),
      })
      .optional(),
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

// A version's collection freeze (§18, §27): 1.0's is `raw/FROZEN.json`, as it was written; each later version has its
// own, `raw/FROZEN-<version>.json`, so freezing 1.1 never touches the freeze 1.0 was built from.
export function freezeFile(dir: string, version = "1.0"): string {
  if (!/^[1-9]\d?\.\d{1,2}$/.test(version)) throw new TypeError(`not a version: ${version}`);
  return join(dir, "raw", version === "1.0" ? "FROZEN.json" : `FROZEN-${version}.json`);
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
      if (!writer || processAlive(pid)) continue;
      // A removal a stop left: its rename is made durable before anything is deleted (a temporary folder was never
      // published, so it has no rename to keep).
      if (name.startsWith(".removing-")) sync(pages);
      rmSync(join(pages, name), { recursive: true, force: true });
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

  // One page's labels and their sources replaced, validated against the page record and written whole (temp then
  // rename, flushed), so a stopped write leaves the old meta.json, never half of one.
  function setLabels(id: string, labels: Labels, label_source: PageMeta["label_source"], licence?: string): StoredPage {
    const folder = join(pages, id);
    const current = PageMeta.parse(JSON.parse(readFileSync(join(folder, "meta.json"), "utf-8")));
    const meta = PageMeta.parse({ ...current, labels, label_source, ...(licence ? { licence } : {}) });
    const temporary = join(folder, `.meta.json.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    const written = `${JSON.stringify(meta, null, 2)}\n`;
    write(temporary, written);
    sync(temporary);
    const target = join(folder, "meta.json");
    renameSync(temporary, target);
    sync(folder);
    if (readFileSync(target, "utf-8") !== written) throw new Error(`page ${id} meta.json did not read back as written`);
    return { id, ...meta };
  }

  // A second dataset item with this page's content, kept on the page with its lure label (written whole, temp then
  // rename); the page's own item comes first in the list. An item already listed changes nothing.
  function addItem(
    id: string,
    item: {
      id: string;
      input?: string | undefined;
      lure?: boolean | undefined;
      lure_type?: (typeof LURE_TYPES)[number] | undefined;
    },
  ): StoredPage {
    const folder = join(pages, id);
    const current = PageMeta.parse(JSON.parse(readFileSync(join(folder, "meta.json"), "utf-8")));
    const own = {
      id: current.item ?? id,
      input: current.input,
      lure: current.labels.lure,
      lure_type: current.labels.lure_type,
    };
    const listed = current.items ?? [own];
    if (listed.some((entry) => entry.id === item.id) || item.id === own.id) return { id, ...current };
    const clean = (entry: typeof item) => ({
      id: entry.id,
      ...(entry.input === undefined ? {} : { input: entry.input }),
      ...(entry.lure === undefined ? {} : { lure: entry.lure }),
      ...(entry.lure_type === undefined ? {} : { lure_type: entry.lure_type }),
    });
    const meta = PageMeta.parse({ ...current, items: [...listed.map(clean), clean(item)] });
    const temporary = join(folder, `.meta.json.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    const written = `${JSON.stringify(meta, null, 2)}\n`;
    write(temporary, written);
    sync(temporary);
    const target = join(folder, "meta.json");
    renameSync(temporary, target);
    sync(folder);
    if (readFileSync(target, "utf-8") !== written) throw new Error(`page ${id} meta.json did not read back as written`);
    return { id, ...meta };
  }

  // A shared page's items narrowed to `keep` (the ones its source still lists, §28 G4), written whole; the page's own item
  // becomes the first kept one when its own is gone. `keep` must name at least one of its items.
  function keepItems(id: string, keep: string[]): StoredPage {
    const folder = join(pages, id);
    const current = PageMeta.parse(JSON.parse(readFileSync(join(folder, "meta.json"), "utf-8")));
    const kept = (current.items ?? []).filter((entry) => keep.includes(entry.id));
    if (!kept.length) throw new Error(`page ${id} would keep none of its items`);
    const { items: _items, ...rest } = current;
    const first = kept[0];
    const meta = PageMeta.parse({
      ...rest,
      item: first?.id,
      ...(first?.input ? { input: first.input } : { input: undefined }),
      ...(kept.length > 1 ? { items: kept } : {}),
    });
    const temporary = join(folder, `.meta.json.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    const written = `${JSON.stringify(meta, null, 2)}\n`;
    write(temporary, written);
    sync(temporary);
    const target = join(folder, "meta.json");
    renameSync(temporary, target);
    sync(folder);
    if (readFileSync(target, "utf-8") !== written) throw new Error(`page ${id} meta.json did not read back as written`);
    return { id, ...meta };
  }

  // Updates a stored page's lineage and capture evidence (D03 T04 §28), validated and written whole (temp then rename).
  function setLineage(
    id: string,
    update: {
      item?: string | undefined;
      input?: string | undefined;
      items?: PageMeta["items"] | undefined;
      evidence?: PageMeta["evidence"] | undefined;
    },
  ): StoredPage {
    const folder = join(pages, id);
    const current = PageMeta.parse(JSON.parse(readFileSync(join(folder, "meta.json"), "utf-8")));
    const meta = PageMeta.parse({
      ...current,
      ...(update.item !== undefined ? { item: update.item } : {}),
      ...(update.input !== undefined ? { input: update.input } : {}),
      ...(update.items !== undefined ? { items: update.items } : {}),
      ...(update.evidence !== undefined ? { evidence: update.evidence } : {}),
    });
    const temporary = join(folder, `.meta.json.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    const written = `${JSON.stringify(meta, null, 2)}\n`;
    write(temporary, written);
    sync(temporary);
    const target = join(folder, "meta.json");
    renameSync(temporary, target);
    sync(folder);
    if (readFileSync(target, "utf-8") !== written) throw new Error(`page ${id} meta.json did not read back as written`);
    return { id, ...meta };
  }

  // Every page's record. A `meta.json` that does not read throws, unless `tolerant`: then that page is left out, for a
  // caller (a resumed import) that finds and repairs damaged pages through `verify()` and `putPage()`.
  function manifest(options: { tolerant?: boolean; source?: string } = {}): StoredPage[] {
    if (!existsSync(pages)) return [];
    const own = options.source
      ? new RegExp(`^${options.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[0-9a-f]{16}$`)
      : null;
    return readdirSync(pages)
      .filter((name) => !name.startsWith(".") && (!own || own.test(name)) && statSync(join(pages, name)).isDirectory())
      .sort()
      .flatMap((id) => {
        try {
          return [{ id, ...PageMeta.parse(JSON.parse(readFileSync(join(pages, id, "meta.json"), "utf-8"))) }];
        } catch (error) {
          if (options.tolerant) return [];
          throw error;
        }
      });
  }

  // Every stored page whose files no longer match their hashes, or whose meta.json does not read; with `source`, only
  // that source's pages (`<source>-<16 hex>`), so a resumed import checks its own pages, not the whole store.
  function verify(source?: string): { intact: number; damaged: string[]; setAside: string[] } {
    if (!existsSync(pages)) return { intact: 0, damaged: [], setAside: [] };
    const own = source ? new RegExp(`^${source.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}-[0-9a-f]{16}$`) : null;
    const ids = readdirSync(pages).filter(
      (name) => !name.startsWith(".") && (!own || own.test(name)) && statSync(join(pages, name)).isDirectory(),
    );
    const damaged = ids.filter((id) => !intact(id)).sort();
    // Damaged copies a repair set aside (`.damaged-<id>-<ms>`): kept for inspection, counted so they never pile up
    // unseen; `removeSource` clears them with their source.
    const setAside = readdirSync(pages)
      .filter((name) => name.startsWith(".damaged-") && (!own || own.test(name.replace(/^\.damaged-|-\d+$/g, ""))))
      .sort();
    return { intact: ids.length - damaged.length, damaged, setAside };
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

  // Takes one page out (a page a later check refuses, `render.ts recheck`): renamed out of view, the rename made durable,
  // then deleted. A stop or a failed flush after the rename leaves the `.removing-` folder, out of the manifest, for the
  // next open to finish; the page is never half deleted while it still shows. Returns whether it was there.
  function removePage(id: string): boolean {
    if (!/^[a-z0-9][a-z0-9-]{0,40}-[0-9a-f]{16}$/.test(id)) throw new TypeError("not a page id");
    const folder = join(pages, id);
    if (!existsSync(folder)) return false;
    const gone = join(pages, `.removing-${id}-${process.pid}`);
    renameSync(folder, gone);
    sync(pages);
    rmSync(gone, { recursive: true, force: true });
    return true;
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

  // A page's files, refused unless both match the SHA-256 its record holds (D03 T04 §9): a rule or the teacher never
  // reads a damaged page as a whole one. Null for a page whose record or files do not read or do not match.
  function readVerifiedPage(id: string): { page: StoredPage; screenshot: Uint8Array; text: string } | null {
    try {
      const folder = join(pages, id);
      const meta = PageMeta.parse(JSON.parse(readFileSync(join(folder, "meta.json"), "utf-8")));
      const screenshot = new Uint8Array(readFileSync(join(folder, "screenshot.jpg")));
      const raw = readFileSync(join(folder, "text.txt"));
      if (sha256(screenshot) !== meta.sha256.screenshot || sha256(raw) !== meta.sha256.text) return null;
      return { page: { id, ...meta }, screenshot, text: raw.toString("utf-8") };
    } catch {
      return null;
    }
  }

  return {
    dir,
    putPage,
    addItem,
    keepItems,
    setLabels,
    setLineage,
    manifest,
    counts,
    readPage,
    readVerifiedPage,
    verify,
    removeSource,
    removePage,
  };
}

export type Store = ReturnType<typeof openStore>;

// ---------------------------------------------------------------------------
// Captured production pages (D03 T04 §46): every page a screening settles is copied here under origin `production`,
// labelled by the Spark teacher only after §41's clearance names its exact bytes, queued when that label is disputed,
// and admitted to a training build only by the admission record. No function in this section calls a model except
// through the labeller a caller injects.

export type ScreenedCapture = {
  screenshot: Uint8Array | null;
  text: string;
  host: string | null;
  settledAt: string;
  tier: string;
  screener: "glimmer" | "spark";
  settling: PageAnswer;
  loupe?: PageAnswer | null;
  sparkCalls?: { callId: string; logId: string | null }[];
};

export type CaptureOutcome =
  | { id: string; stored: boolean; duplicate: boolean }
  | { id: null; stored: false; reason: "no-screenshot" };

const hasIdentifiers = (host: string | null, text: string) => {
  const hay = `${host ?? ""}\n${text}`;
  return [EMAIL, PHONE, LONG_NUMBER].some((shape) => new RegExp(shape.source, "g").test(hay));
};
export const hasRecipientIdentifiers = hasIdentifiers;

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w");
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  // The rename is acknowledged only once its directory entry is durable too.
  const folder = openSync(dirname(file), "r");
  try {
    fsyncSync(folder);
  } finally {
    closeSync(folder);
  }
}

type ClearanceRecord = { cleared: { id: string; screenshot: string; text: string; by: string; at: string }[] };
const clearanceFile = (store: Store) => join(store.dir, "production-clearance.json");
export function readClearance(store: Store): ClearanceRecord {
  try {
    return JSON.parse(readFileSync(clearanceFile(store), "utf-8")) as ClearanceRecord;
  } catch {
    return { cleared: [] };
  }
}
export function isProductionCleared(store: Store, page: StoredPage): boolean {
  return readClearance(store).cleared.some(
    (entry) => entry.id === page.id && entry.screenshot === page.sha256.screenshot && entry.text === page.sha256.text,
  );
}

// The §41 authorised clearance action for one page: refused while recipient identifiers are in its host or text.
export function clearProductionPage(
  store: Store,
  id: string,
  by: string,
  at: string,
): { cleared: boolean; reason?: string } {
  const page = store.manifest().find((entry) => entry.id === id);
  if (!page) return { cleared: false, reason: "not in the store" };
  const read = store.readVerifiedPage(id);
  if (!read) return { cleared: false, reason: "the page's files do not match its record" };
  if (hasIdentifiers(page.host, read.text))
    return { cleared: false, reason: "recipient identifiers in the host or text; redact or withhold first" };
  const record = readClearance(store);
  const kept = record.cleared.filter((entry) => entry.id !== id);
  kept.push({ id, screenshot: page.sha256.screenshot, text: page.sha256.text, by, at });
  writeJsonAtomic(clearanceFile(store), { cleared: kept });
  return { cleared: isProductionCleared(store, page) };
}

export async function captureScreenedPage(store: Store, capture: ScreenedCapture): Promise<CaptureOutcome> {
  if (!capture.screenshot) return { id: null, stored: false, reason: "no-screenshot" };
  const digest = sha256(capture.screenshot);
  const existing = store
    .manifest({ tolerant: true })
    .find((page) => page.origin === "production" && page.sha256.screenshot === digest);
  // A damaged stored copy is not a duplicate: the store's own write repairs it below.
  if (existing && store.readVerifiedPage(existing.id)) return { id: existing.id, stored: false, duplicate: true };
  const id = await store.putPage("production", {
    origin: "production",
    licence: "IsItLegit production capture; private, never published",
    host: capture.host,
    template: null,
    south_africa: capture.host?.endsWith(".za") ?? false,
    labels: {},
    label_source: {},
    redacted: false,
    capture: {
      settled_at: capture.settledAt,
      tier: capture.tier,
      screener: capture.screener,
      settling: capture.settling,
      ...(capture.loupe ? { loupe: capture.loupe } : {}),
      ...(capture.sparkCalls?.length ? { calls: capture.sparkCalls } : {}),
    },
    screenshot: capture.screenshot,
    text: capture.text,
  });
  return { id, stored: true, duplicate: false };
}

export type Labeller = (page: StoredPage, screenshot: Uint8Array, text: string) => Promise<PageAnswer | null>;

const queueFile = (store: Store) => join(store.dir, "review-queue.jsonl");
export type QueueEntry = {
  id: string;
  screenshot: string;
  text: string;
  reason: string;
  at: string;
  teacher?: PageAnswer;
};
// Fail-closed: a queue that does not read throws, so no caller can treat a damaged queue as no disputes. A missing
// queue file is an empty queue.
export function readReviewQueue(store: Store): QueueEntry[] {
  let raw: string;
  try {
    raw = readFileSync(queueFile(store), "utf-8");
  } catch (error) {
    // Only a missing queue is an empty queue; an unreadable one refuses, never reads as no disputes.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`the review queue ${queueFile(store)} cannot be read (${(error as Error).message})`);
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as QueueEntry;
      } catch {
        throw new Error(
          `the review queue ${queueFile(store)} does not read at line ${index + 1}; no page is admitted until it is repaired`,
        );
      }
    });
}
// Durable append: the dispute is on disk, file and directory flushed, before the label it guards is committed.
const appendQueue = (store: Store, entry: QueueEntry) => {
  mkdirSync(store.dir, { recursive: true });
  const file = queueFile(store);
  const fd = openSync(file, "a");
  try {
    writeSync(fd, `${JSON.stringify(entry)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const folder = openSync(store.dir, "r");
  try {
    fsyncSync(folder);
  } finally {
    closeSync(folder);
  }
};
const rewriteQueue = (store: Store, entries: QueueEntry[]) => {
  const file = queueFile(store);
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w");
  try {
    writeSync(fd, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
};

// Labels one cleared captured page through the injected teacher labeller. An uncleared page is refused before the
// labeller is called; a page already labelled is not labelled again.
export async function labelCapturedPage(
  store: Store,
  id: string,
  labeller: Labeller,
  at: string,
): Promise<{ labelled: boolean; queued: boolean; reason?: string }> {
  const page = store.manifest().find((entry) => entry.id === id);
  if (!page) return { labelled: false, queued: false, reason: "not in the store" };
  if (page.labels.lure !== undefined)
    return { labelled: true, queued: readReviewQueue(store).some((e) => e.id === id) };
  if (!isProductionCleared(store, page)) return { labelled: false, queued: false, reason: "not cleared" };
  const read = store.readVerifiedPage(id);
  if (!read) return { labelled: false, queued: false, reason: "the page's files do not match its record" };
  const answer = await labeller(read.page, read.screenshot, read.text);
  if (!answer) return { labelled: false, queued: false, reason: "the labeller gave no answer" };
  const settling = page.capture?.settling;
  const disputed = (settling !== undefined && settling.lure !== answer.lure) || inEscalationBand(answer.confidence);
  // The dispute is queued before the label is written: a stop between the two leaves a queued, unlabelled page,
  // which admission refuses, never a labelled page whose dispute was lost.
  if (disputed && !readReviewQueue(store).some((entry) => entry.id === id))
    appendQueue(store, {
      id,
      screenshot: page.sha256.screenshot,
      text: page.sha256.text,
      reason:
        settling && settling.lure !== answer.lure
          ? "the teacher disagrees with the settling answer"
          : "the teacher is unsure",
      at,
      teacher: answer,
    });
  const sources = Object.fromEntries(
    ["brand", "has_login_form", "has_payment_form", "lure", "lure_type"].map((key) => [key, "spark-teacher"]),
  ) as PageMeta["label_source"];
  store.setLabels(
    id,
    {
      brand: answer.brand,
      has_login_form: answer.has_login_form,
      has_payment_form: answer.has_payment_form,
      lure: answer.lure,
      lure_type: answer.lure_type,
    },
    sources,
  );
  return { labelled: true, queued: disputed };
}

// The executable backlog path (§46): every cleared, unlabelled production page is labelled once, in id order, and
// the counts say what happened. Safe to rerun: labelled pages are skipped, failures stay unlabelled for the next run.
export async function processProductionBacklog(
  store: Store,
  labeller: Labeller,
  at: string,
): Promise<{ labelled: number; queued: number; failed: { id: string; reason: string }[]; skipped: number }> {
  const pages = store
    .manifest({ tolerant: true })
    .filter((page) => page.origin === "production")
    .sort((a, b) => a.id.localeCompare(b.id));
  let labelled = 0;
  let queued = 0;
  let skipped = 0;
  const failed: { id: string; reason: string }[] = [];
  for (const page of pages) {
    if (page.labels.lure !== undefined) {
      skipped++;
      continue;
    }
    const outcome = await labelCapturedPage(store, page.id, labeller, at);
    if (outcome.labelled) {
      labelled++;
      if (outcome.queued) queued++;
    } else failed.push({ id: page.id, reason: outcome.reason ?? "the labeller gave no answer" });
  }
  return { labelled, queued, failed, skipped };
}

// Imports offline judgements (Astra and Wonder, §46): each must name the page's current hashes, or it is refused and
// the page stays queued. An accepted judgement becomes the page's label, with the judge as its source.
export function applyJudgements(
  store: Store,
  judgements: { id: string; screenshot: string; text: string; answer: PageAnswer; source: "astra+claude" | "claude" }[],
): { id: string; accepted: boolean; reason?: string }[] {
  const queue = readReviewQueue(store);
  const outcomes = judgements.map((judgement) => {
    const page = store.manifest().find((entry) => entry.id === judgement.id);
    if (!page) return { id: judgement.id, accepted: false, reason: "not in the store" };
    if (judgement.screenshot !== page.sha256.screenshot || judgement.text !== page.sha256.text)
      return { id: judgement.id, accepted: false, reason: "stale: the page changed after judging" };
    if (judgement.source !== "astra+claude" && judgement.source !== "claude")
      return { id: judgement.id, accepted: false, reason: "the judgement's source is not an offline judge" };
    if (typeof judgement.screenshot !== "string" || typeof judgement.text !== "string")
      return { id: judgement.id, accepted: false, reason: "the judgement does not name the page's hashes" };
    const parsed = PageAnswer.safeParse(judgement.answer);
    if (!parsed.success)
      return { id: judgement.id, accepted: false, reason: "the judgement is not a valid PageAnswer" };
    if (!isProductionCleared(store, page)) return { id: judgement.id, accepted: false, reason: "not cleared" };
    if (!store.readVerifiedPage(judgement.id))
      return { id: judgement.id, accepted: false, reason: "the page's files do not match its record" };
    const sources = Object.fromEntries(
      ["brand", "has_login_form", "has_payment_form", "lure", "lure_type"].map((key) => [key, judgement.source]),
    ) as PageMeta["label_source"];
    store.setLabels(
      judgement.id,
      {
        brand: judgement.answer.brand,
        has_login_form: judgement.answer.has_login_form,
        has_payment_form: judgement.answer.has_payment_form,
        lure: judgement.answer.lure,
        lure_type: judgement.answer.lure_type,
      },
      sources,
    );
    return { id: judgement.id, accepted: true };
  });
  const accepted = new Set(outcomes.filter((outcome) => outcome.accepted).map((outcome) => outcome.id));
  if (accepted.size) {
    // The teacher's and the judge's answers stay on record after the queue entry goes.
    for (const judgement of judgements.filter((entry) => accepted.has(entry.id))) {
      const queued = queue.find((entry) => entry.id === judgement.id);
      appendFileSync(
        join(store.dir, "judgements.jsonl"),
        `${JSON.stringify({ id: judgement.id, teacher: queued?.teacher ?? null, judge: judgement.answer, source: judgement.source })}\n`,
      );
    }
    rewriteQueue(
      store,
      queue.filter((entry) => !accepted.has(entry.id)),
    );
  }
  return outcomes;
}

type AdmissionRecord = { admitted: string[]; by: string; at: string };
const admissionFile = (store: Store) => join(store.dir, "production-admission.json");
export function readAdmission(store: Store): Set<string> {
  try {
    return new Set((JSON.parse(readFileSync(admissionFile(store), "utf-8")) as AdmissionRecord).admitted);
  } catch {
    return new Set();
  }
}

// The §41 admission action: only cleared, labelled pages no longer in the review queue may be named, and the record
// is read back before it is reported.
export function admitProductionPages(
  store: Store,
  ids: string[],
  by: string,
  at: string,
): { admitted: string[]; refused: { id: string; reason: string }[] } {
  const queue = new Set(readReviewQueue(store).map((entry) => entry.id));
  const admitted = readAdmission(store);
  const refused: { id: string; reason: string }[] = [];
  for (const id of ids) {
    const page = store.manifest().find((entry) => entry.id === id);
    if (!page) refused.push({ id, reason: "not in the store" });
    else if (page.origin !== "production") refused.push({ id, reason: "not a production capture" });
    else if (!isProductionCleared(store, page)) refused.push({ id, reason: "not cleared" });
    else if (page.labels.lure === undefined) refused.push({ id, reason: "unlabelled" });
    else if (queue.has(id)) refused.push({ id, reason: "in the review queue" });
    else admitted.add(id);
  }
  writeJsonAtomic(admissionFile(store), { admitted: [...admitted].sort(), by, at });
  const back = readAdmission(store);
  return { admitted: ids.filter((id) => back.has(id)), refused };
}

export function revokeProductionAdmission(store: Store, ids: string[], by: string, at: string): string[] {
  const admitted = readAdmission(store);
  for (const id of ids) admitted.delete(id);
  writeJsonAtomic(admissionFile(store), { admitted: [...admitted].sort(), by, at });
  const back = readAdmission(store);
  return ids.filter((id) => !back.has(id));
}

// The flywheel's counts, reconciled against the manifest, the queue and the two gate records.
export function productionCounts(store: Store) {
  const pages = store.manifest({ tolerant: true }).filter((page) => page.origin === "production");
  const queue = new Set(readReviewQueue(store).map((entry) => entry.id));
  const admitted = readAdmission(store);
  return {
    captured: pages.length,
    cleared: pages.filter((page) => isProductionCleared(store, page)).length,
    labelled: pages.filter((page) => page.labels.lure !== undefined).length,
    unlabelled: pages.filter((page) => page.labels.lure === undefined).length,
    queued: pages.filter((page) => queue.has(page.id)).length,
    judged: pages.filter((page) => page.label_source.lure === "astra+claude" || page.label_source.lure === "claude")
      .length,
    admitted: pages.filter((page) => admitted.has(page.id)).length,
    // Admitted pages the build withholds for recipient identifiers, counted from their verified text.
    withheld: pages.filter((page) => {
      if (!admitted.has(page.id)) return false;
      const read = store.readVerifiedPage(page.id);
      return read !== null && hasIdentifiers(page.host, read.text);
    }).length,
  };
}
