// Synthetic native PDF pairs supplement the existing generator fixtures, never rasterize PNGs into fake PDF coverage.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { bytesAt, loadManifest, parseManifest, validateManifest } from "./score.ts";

export const ROOT = resolve(import.meta.dirname, "../..");
export const SET = "eval/forensics/sets/pdf-forensics";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type Operations = {
  write?: (path: string, bytes: string | Uint8Array) => void;
  rename?: (from: string, to: string) => void;
};

// The kernel releases flock when the holder exits, including parent death (stdin EOF).
// This offline WSL/Linux generator requires util-linux flock; missing support fails closed.
async function lock(path: string): Promise<() => Promise<void>> {
  const holder = spawn(
    "flock",
    ["-w", "2", "-E", "73", path, process.execPath, "-e", 'process.stdout.write("locked\\n"); process.stdin.resume();'],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = new Promise<void>((resolve) => holder.once("close", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    holder.once("error", reject);
    holder.once("exit", (code) =>
      reject(new Error(code === 73 ? "PDF corpus builder already running" : `PDF corpus lock failed (${code})`)),
    );
    holder.stdout.once("data", () => resolve());
  });
  return async () => {
    holder.stdin.end();
    await closed;
  };
}

// File data precedes its directory entries. Synchronize ancestor names too, including
// directories created before this invocation. See docs/eval/corpus-durability.md.
function syncPath(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncAncestors(path: string, sync: typeof syncPath) {
  for (;;) {
    sync(path);
    const parent = dirname(path);
    if (parent === path) return;
    path = parent;
  }
}

function syncTree(path: string, sync: typeof syncPath) {
  const entry = lstatSync(path);
  if (entry.isDirectory()) {
    for (const name of readdirSync(path)) syncTree(join(path, name), sync);
  } else if (!entry.isFile()) {
    throw new Error(`unsupported corpus storage entry: ${path}`);
  }
  sync(path);
}

// Validate owned bytes even when external input fixtures have legitimately changed.
// Those external inputs are checked against the new manifest before publication.
function generationValid(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    if (!lstatSync(path).isDirectory()) return false;
    const prior = parseManifest(JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")));
    const owned = prior.documents.filter((d) => d.path.startsWith(`${SET}/`));
    if (!owned.length) return false;
    for (const document of owned) {
      if (document.path !== `${SET}/${basename(document.path)}`) return false;
      const bytes = bytesAt(path, basename(document.path), document.sha256);
      if (Buffer.from(bytes).subarray(0, 5).toString() !== "%PDF-") return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Both rename parents must persist, destination first for cross-directory moves.
function move(from: string, to: string, rename: NonNullable<Operations["rename"]>, sync: typeof syncPath) {
  rename(from, to);
  sync(dirname(to));
  if (dirname(from) !== dirname(to)) sync(dirname(from));
}

function archiveDamaged(path: string, sync: typeof syncPath) {
  // Preserve readable damaged bytes too, rather than merely their volatile names.
  syncTree(path, sync);
  const archive = mkdtempSync(join(dirname(path), ".pdf-forensics-damaged-"));
  syncAncestors(archive, sync);
  move(path, join(archive, "generation"), renameSync, sync);
}

function recover(out: string, previous: string, sync: typeof syncPath) {
  const liveValid = generationValid(out);
  const savedValid = generationValid(previous);
  if (liveValid) {
    syncTree(out, sync);
    syncAncestors(dirname(out), sync);
    // Never silently delete an invalid saved generation on the next publication.
    if (existsSync(previous) && !savedValid) archiveDamaged(previous, sync);
    return;
  }
  if (!savedValid) {
    if (existsSync(out) || existsSync(previous))
      throw new Error("No verified PDF corpus generation; live and saved evidence preserved");
    return;
  }
  syncTree(previous, sync);
  syncAncestors(dirname(previous), sync);
  if (existsSync(out)) archiveDamaged(out, sync);
  move(previous, out, renameSync, sync);
  if (!generationValid(out)) throw new Error("Recovered PDF corpus failed verification; evidence preserved");
}

// Keep legacy generations byte-for-byte, including incomplete staging and original paths.
function preserveLegacy(root: string, rename: NonNullable<Operations["rename"]>, sync: typeof syncPath) {
  const oldParent = join(root, "eval/sets");
  const entries = readdirSync(oldParent, { withFileTypes: true }).filter(
    (entry) =>
      entry.name === "pdf-forensics" ||
      entry.name === ".pdf-forensics-previous" ||
      entry.name.startsWith(".pdf-forensics-stage-"),
  );
  if (!entries.length) return;
  if (entries.some((entry) => !entry.isDirectory())) throw new Error("legacy PDF artifact is not a directory");
  const archive = join(root, "eval/forensics/legacy-publication");
  mkdirSync(archive, { recursive: true });
  const destination = mkdtempSync(join(archive, "generation-"));
  syncAncestors(destination, sync);
  for (const entry of entries) {
    const source = join(oldParent, entry.name);
    syncTree(source, sync);
    syncAncestors(oldParent, sync);
    move(source, join(destination, entry.name), rename, sync);
  }
}

export async function build(root = ROOT, operations: Operations = {}) {
  const out = join(root, SET);
  const parent = dirname(out);
  mkdirSync(parent, { recursive: true });
  const unlock = await lock(join(parent, ".pdf-forensics.lock"));
  let stage: string | undefined;
  let preserveStage = false;
  let unlockLegacy: (() => Promise<void>) | undefined;
  const sync = (path: string) => {
    try {
      syncPath(path);
    } catch (error) {
      preserveStage = true;
      throw error;
    }
  };
  try {
    syncAncestors(parent, sync);
    const oldParent = join(root, "eval/sets");
    if (existsSync(oldParent)) {
      // Retain the old lock inode and hold it through publication.
      unlockLegacy = await lock(join(oldParent, ".pdf-forensics.lock"));
      preserveLegacy(root, operations.rename ?? renameSync, sync);
    }
    const previous = join(parent, ".pdf-forensics-previous");
    recover(out, previous, sync);
    // Abandoned stages are diagnostic evidence, never candidates selected without validation.
    stage = mkdtempSync(join(parent, ".pdf-forensics-stage-"));
    await generate(root, stage, operations.write ?? writeFileSync);
    const staged = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8")) as unknown;
    const stagedPath = stage;
    validateManifest(staged, (path, expected) =>
      path.startsWith(`${SET}/`) ? bytesAt(stagedPath, basename(path), expected) : bytesAt(root, path, expected),
    );
    syncTree(stage, sync);
    sync(parent);
    preserveStage = true;
    const rename = operations.rename ?? renameSync;
    if (existsSync(out)) {
      // Recovery synchronized the live generation before removing a superseded valid backup.
      rmSync(previous, { recursive: true, force: true });
      sync(parent);
      move(out, previous, rename, sync);
    }
    try {
      move(stage, out, rename, sync);
      loadManifest(root);
    } catch (error) {
      // A sync failure does not authorize deleting either recovery copy. A valid
      // promoted generation stays in place; failed promotion restores the backup.
      recover(out, previous, sync);
      throw error;
    }
  } finally {
    try {
      if (stage && !preserveStage) rmSync(stage, { recursive: true, force: true });
    } finally {
      try {
        if (unlockLegacy) await unlockLegacy();
      } finally {
        await unlock();
      }
    }
  }
}

async function generate(root: string, out: string, write: NonNullable<Operations["write"]>) {
  register("../../scripts/lib/ts-resolve.mjs", import.meta.url);
  const { makeDoc, HELVETICA, TIMES } = await import("../../test/invoice/forensics-fixtures.ts");
  const { appendUpdate, contentOf } = await import("../../test/invoice/pdf-writer.ts");
  const documents: object[] = [];
  for (const [type, heading] of [
    ["proof-of-payment", "Proof of Payment"],
    ["bank-letter", "Bank confirmation letter"],
    ["invoice", "Tax Invoice"],
  ]) {
    const lines = [
      { font: "F1", size: 18, x: 72, y: 760, text: heading as string },
      {
        font: "F1",
        size: 10,
        x: 72,
        y: 740,
        text:
          type === "invoice"
            ? "Hadeda Couriers (fictional) - SYNTHETIC TEST DOCUMENT"
            : "Kestrel Bank (fictional) - SYNTHETIC TEST DOCUMENT",
      },
      { font: "F1", size: 11, x: 72, y: 700, text: "Date paid: 2026-10-20" },
      { font: "F1", size: 11, x: 72, y: 680, text: "Beneficiary: Hadeda Couriers (fictional)" },
      { font: "F1", size: 11, x: 72, y: 660, text: "Account number: 62004417731" },
      { font: "F1", size: 11, x: 72, y: 640, text: "Amount: R 12 450.00" },
      { font: "F1", size: 11, x: 72, y: 620, text: "Fee: R 5.00" },
    ];
    const genuine = await makeDoc({ lines, fonts: { F1: HELVETICA, F2: TIMES } });
    const changed = lines.map((line) =>
      line.text.startsWith("Amount:") ? { ...line, font: "F2", text: "Amount: R 112 450.00" } : line,
    );
    const doctored = await appendUpdate(genuine, {
      objects: { 5: { dict: "<<>>", stream: contentOf(changed), compress: true } },
      root: 2,
      info: 6,
      size: 12,
    });
    for (const [label, bytes] of [
      ["genuine", genuine],
      ["doctored", doctored],
    ] as const) {
      const path = `${SET}/${type}-${label}.pdf`;
      write(join(out, basename(path)), bytes);
      documents.push({
        path,
        type,
        generator: "project-pdf-writer",
        label,
        edit: label === "genuine" ? null : "incremental amount change with substituted font",
        sha256: hash(bytes),
      });
    }
  }
  const existing = join(root, "test/fixtures/pdf-forensics");
  const labels: Record<string, "genuine" | "doctored"> = {
    "gs-genuine-pop.pdf": "genuine",
    "gs-logo.pdf": "genuine",
    "chromium-pop.pdf": "genuine",
    "chromium-invoice.pdf": "genuine",
    "gs-edited-pop.pdf": "doctored",
    "gs-modified-pop.pdf": "doctored",
    "gs-substituted-font.pdf": "doctored",
    "gs-pasted-image.pdf": "doctored",
  };
  for (const name of readdirSync(existing)
    .filter((name) => name.endsWith(".pdf"))
    .sort()) {
    const path = `test/fixtures/pdf-forensics/${name}`;
    if (!labels[name]) throw new Error(`${name}: needs an explicit provenance-backed label`);
    const genuine = labels[name] === "genuine";
    documents.push({
      path,
      type: name.includes("invoice") ? "invoice" : "proof-of-payment",
      generator: name.startsWith("gs-") ? "Ghostscript-10.06.0" : "Chromium-Skia",
      label: genuine ? "genuine" : "doctored",
      edit: genuine ? null : name.slice(3, -4),
      sha256: hash(readFileSync(join(root, path))),
    });
  }
  const unsupported = readdirSync(join(root, "test/fixtures/payment-docs"))
    .filter((name) => name.endsWith(".png"))
    .sort()
    .map((name) => {
      const path = `test/fixtures/payment-docs/${name}`;
      return { path, sha256: hash(readFileSync(join(root, path))), reason: "Raster image, not a native PDF" };
    });
  write(join(out, "manifest.json"), `${JSON.stringify({ version: 1, documents, unsupported }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await build();
