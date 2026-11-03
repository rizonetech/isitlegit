#!/usr/bin/env node
/**
 * Verify external primary-source PDF facts in media/data/pdf-facts.json against the saved PDFs in
 * ~/isitlegit-data/media/sources/ (or MEDIA_SOURCES_DIR) by SHA-256 checksum, 1-based page number,
 * exact extracted quote, and displayed value.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SPEC = path.resolve(HERE, "../data/pdf-facts.json");
const DEFAULT_DIR = process.env.MEDIA_SOURCES_DIR || path.join(os.homedir(), "isitlegit-data", "media", "sources");

export async function extractPageText(pdfBytes, pageNumber) {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  if (pageNumber < 1 || pageNumber > doc.numPages) {
    throw new Error(`page ${pageNumber} out of range (1..${doc.numPages})`);
  }
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  return content.items
    .map((item) => ("str" in item ? item.str : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function checkPdfFacts(spec, sourcesDir = DEFAULT_DIR, loader = extractPageText) {
  const failures = [];
  const docCache = new Map();
  const pageCache = new Map();

  for (const [file, meta] of Object.entries(spec.sources || {})) {
    const full = path.join(sourcesDir, file);
    if (!fs.existsSync(full)) {
      failures.push(`${file}: missing in ${sourcesDir}`);
      continue;
    }
    const bytes = fs.readFileSync(full);
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (digest !== meta.sha256) {
      failures.push(`${file}: sha256 mismatch (got ${digest.slice(0, 12)}, expected ${String(meta.sha256).slice(0, 12)})`);
      continue;
    }
    docCache.set(file, bytes);
  }

  for (const [key, fact] of Object.entries(spec.facts || {})) {
    if (!spec.sources || !spec.sources[fact.file]) {
      failures.push(`${key}: source ${fact.file} is not declared in sources`);
      continue;
    }
    if (!String(fact.quote || "").includes(String(fact.value || ""))) {
      failures.push(`${key}: value ${JSON.stringify(fact.value)} is not in its quote`);
    }
    const bytes = docCache.get(fact.file);
    if (!bytes) continue;
    const cacheKey = `${fact.file}:${fact.page}`;
    let text = pageCache.get(cacheKey);
    if (text === undefined) {
      try {
        text = await loader(bytes, fact.page);
        pageCache.set(cacheKey, text);
      } catch (err) {
        failures.push(`${key}: ${fact.file} p.${fact.page}: ${err.message}`);
        continue;
      }
    }
    const normQuote = String(fact.quote).replace(/\s+/g, " ").trim();
    if (!text.includes(normQuote)) {
      failures.push(`${key}: quote not found on ${fact.file} p.${fact.page}: ${JSON.stringify(fact.quote)}`);
    }
  }

  return failures;
}

async function main() {
  const specPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_SPEC;
  const sourcesDir = process.argv[3] ? path.resolve(process.argv[3]) : DEFAULT_DIR;
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const failures = await checkPdfFacts(spec, sourcesDir);
  for (const f of failures) {
    console.error(`check-pdf-facts: ${f}`);
  }
  if (failures.length > 0) {
    process.exit(1);
  }
  const factCount = Object.keys(spec.facts || {}).length;
  const sourceCount = Object.keys(spec.sources || {}).length;
  console.log(`check-pdf-facts: ${factCount} PDF facts across ${sourceCount} primary PDFs hold`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`check-pdf-facts: ${err.message}`);
    process.exit(1);
  });
}
