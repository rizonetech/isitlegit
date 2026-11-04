// Synthetic native PDF pairs supplement the existing generator fixtures, never rasterize PNGs into fake PDF coverage.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ROOT = resolve(import.meta.dirname, "../..");
export const SET = "eval/sets/pdf-forensics";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function build(root = ROOT) {
  register("../../scripts/lib/ts-resolve.mjs", import.meta.url);
  const { makeDoc, HELVETICA, TIMES } = await import("../../test/invoice/forensics-fixtures.ts");
  const { appendUpdate, contentOf } = await import("../../test/invoice/pdf-writer.ts");
  const out = join(root, SET);
  mkdirSync(out, { recursive: true });
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
      writeFileSync(join(root, path), bytes);
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
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify({ version: 1, documents, unsupported }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await build();
