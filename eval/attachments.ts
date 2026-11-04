// Attachment identification measurement (D08 T02 section 8, D02 T04 sections 1, 3 and 5): the sniffed type
// of every valid synthetic sample, of disguised bytes (a real type behind another name, which identification
// must catch as its real type), and of damaged packages (truncated bytes, which must not read as the valid
// type). Scored through the real `sniff` the checks step uses.
import { MAX_SNIFFED, type SniffedType, sniff } from "../src/checks/sniff.ts";
import { samples } from "../test/fixtures/attachments/samples.ts";

export const EXPECTED: Partial<Record<keyof typeof samples, SniffedType>> = {
  pdf: "pdf",
  zip: "zip",
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  ole: "ole",
  pe: "pe",
  elf: "elf",
  macho: "macho",
  rar: "rar",
  "7z": "7z",
  iso: "iso",
  png: "png",
  jpeg: "jpeg",
  gif: "gif",
  webp: "webp",
  html: "html",
  svg: "svg",
  lnk: "lnk",
  script: "script",
  text: "text",
  rtf: "rtf",
  odf: "odf",
  m4a: "m4a",
  ogg: "ogg",
  wav: "wav",
  mp3: "mp3",
};

export function scoreAttachments() {
  const names = Object.keys(EXPECTED) as (keyof typeof EXPECTED)[];
  const missed: string[] = [];
  for (const name of names) if (sniff(samples[name]) !== EXPECTED[name]) missed.push(name);
  // Disguised: executable and archive bytes behind a document name must still read as their real type.
  const disguised: { name: string; bytes: Uint8Array; real: SniffedType }[] = [
    { name: "invoice.pdf (pe bytes)", bytes: samples.pe, real: "pe" },
    { name: "statement.docx (zip bytes)", bytes: samples.zip, real: "zip" },
    { name: "photo.png (html bytes)", bytes: samples.html, real: "html" },
  ];
  const undetected = disguised.filter((d) => sniff(d.bytes) !== d.real).map((d) => d.name);
  // Damaged: a truncated valid file must not read as its valid type.
  const damaged: { name: string; bytes: Uint8Array; valid: SniffedType }[] = [
    { name: "truncated pdf", bytes: samples.pdf.slice(0, 4), valid: "pdf" },
    { name: "truncated zip", bytes: samples.zip.slice(0, 10), valid: "zip" },
    { name: "truncated png", bytes: samples.png.slice(0, 4), valid: "png" },
  ];
  const readAsValid = damaged.filter((d) => sniff(d.bytes) === d.valid).map((d) => d.name);

  // Measure p50 and p95 time with MAX_SNIFFED (20) attachments per case.
  const batchBytes = names.slice(0, MAX_SNIFFED).map((n) => samples[n]);
  const timesMs: number[] = [];
  for (let rep = 0; rep < 8; rep++) {
    const t0 = performance.now();
    for (const b of batchBytes) sniff(b);
    timesMs.push(Number((performance.now() - t0).toFixed(3)));
  }
  const sorted = [...timesMs].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted.length ? (sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] as number) : null;

  return {
    valid: names.length,
    identified: names.length - missed.length,
    disguised: disguised.length,
    disguisedCaught: disguised.length - undetected.length,
    damaged: damaged.length,
    damagedReadAsValid: readAsValid.length,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    missed,
    undetected,
    readAsValid,
    timesMs,
  };
}
