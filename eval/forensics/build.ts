// Synthetic native PDF pairs supplement the existing generator fixtures, never rasterize PNGs into fake PDF coverage.
import { spawn } from "node:child_process";
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

// Keep legacy generations byte-for-byte, including incomplete staging and its original manifest paths.
// Atomic moves make an interrupted relocation retryable without deleting the only recovery copy.
function preserveLegacy(root: string, rename: NonNullable<Operations["rename"]>) {
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
  for (const entry of entries) rename(join(oldParent, entry.name), join(destination, entry.name));
}

export async function build(root = ROOT, operations: Operations = {}) {
  const out = join(root, SET);
  const parent = dirname(out);
  mkdirSync(parent, { recursive: true });
  const unlock = await lock(join(parent, ".pdf-forensics.lock"));
  let stage: string | undefined;
  let unlockLegacy: (() => Promise<void>) | undefined;
  try {
    const oldParent = join(root, "eval/sets");
    if (existsSync(oldParent)) {
      // Retain the old lock inode and hold it through publication so an old builder cannot race relocation.
      unlockLegacy = await lock(join(oldParent, ".pdf-forensics.lock"));
      preserveLegacy(root, operations.rename ?? renameSync);
    }
    const previous = join(parent, ".pdf-forensics-previous");
    // Recover before generation; never remove the only usable generation.
    if (!existsSync(out) && existsSync(previous)) renameSync(previous, out);
    if (existsSync(out)) {
      const prior = parseManifest(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")));
      // External fixture inputs may have legitimately changed since the prior build.
      // Preserve and verify the bytes owned by this generation; the new stage checks every current input.
      for (const document of prior.documents.filter((d) => d.path.startsWith(`${SET}/`))) {
        const bytes = bytesAt(out, basename(document.path), document.sha256);
        if (Buffer.from(bytes).subarray(0, 5).toString() !== "%PDF-") throw new Error("prior corpus is not PDF");
      }
    }
    for (const name of readdirSync(parent)) {
      if (name.startsWith(".pdf-forensics-stage-")) rmSync(join(parent, name), { recursive: true, force: true });
    }
    stage = mkdtempSync(join(parent, ".pdf-forensics-stage-"));
    await generate(root, stage, operations.write ?? writeFileSync);
    const staged = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8")) as unknown;
    const stagedPath = stage;
    validateManifest(staged, (path, expected) =>
      path.startsWith(`${SET}/`) ? bytesAt(stagedPath, basename(path), expected) : bytesAt(root, path, expected),
    );
    const rename = operations.rename ?? renameSync;
    if (existsSync(out)) {
      rmSync(previous, { recursive: true, force: true });
      rename(out, previous);
    }
    try {
      rename(stage, out);
      loadManifest(root);
    } catch (error) {
      if (existsSync(previous)) {
        if (existsSync(out)) rmSync(out, { recursive: true, force: true });
        renameSync(previous, out);
      }
      throw error;
    }
  } finally {
    try {
      if (stage) rmSync(stage, { recursive: true, force: true });
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
