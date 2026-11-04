// Attachment identification and archive-check measurement (D08 T02 section 8, D02 T04 sections 1, 3 and 5):
// the sniffed type and check-level findings (`typeMismatchEvidence`, `macroEvidence`, `encryptedArchiveEvidence`,
// `executableEvidence`) over every valid synthetic sample, disguised bytes, risky archives (macros, encrypted ZIP,
// executable in ZIP), and damaged packages (truncated bytes), plus 8 batch runs of MAX_SNIFFED = 20 attachments.
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDecoyCompoundFile } from "../scripts/fixtures/msg-builder.ts";
import type { CaseView } from "../src/checks/case-view.ts";
import { MAX_SNIFFED, type SniffedType, sniff } from "../src/checks/sniff.ts";
import { zip } from "../test/fixtures/attachments/archives.ts";
import { samples } from "../test/fixtures/attachments/samples.ts";
import type { AttachmentObservation, AttachmentsSummary } from "./components.ts";
import { ensureTsResolve } from "./intake-time.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const enc = (s: string) => new TextEncoder().encode(s);

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

const VALID_SPEC: Record<
  keyof typeof EXPECTED,
  { filename: string; mediaType: string; benign: boolean; bytes: Uint8Array }
> = {
  pdf: { filename: "sample.pdf", mediaType: "application/pdf", benign: true, bytes: samples.pdf },
  zip: {
    filename: "sample.zip",
    mediaType: "application/zip",
    benign: true,
    bytes: zip([{ name: "readme.txt", data: enc("Hello") }]),
  },
  docx: {
    filename: "sample.docx",
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    benign: true,
    bytes: zip([{ name: "[Content_Types].xml" }, { name: "word/document.xml" }]),
  },
  xlsx: {
    filename: "sample.xlsx",
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    benign: true,
    bytes: zip([{ name: "[Content_Types].xml" }, { name: "xl/workbook.xml" }]),
  },
  pptx: {
    filename: "sample.pptx",
    mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    benign: true,
    bytes: zip([{ name: "[Content_Types].xml" }, { name: "ppt/presentation.xml" }]),
  },
  ole: { filename: "sample.doc", mediaType: "application/msword", benign: true, bytes: makeDecoyCompoundFile() },
  pe: { filename: "sample.exe", mediaType: "application/octet-stream", benign: false, bytes: samples.pe },
  elf: { filename: "sample.elf", mediaType: "application/octet-stream", benign: false, bytes: samples.elf },
  macho: { filename: "sample.macho", mediaType: "application/octet-stream", benign: false, bytes: samples.macho },
  rar: { filename: "sample.rar", mediaType: "application/octet-stream", benign: true, bytes: samples.rar },
  "7z": { filename: "sample.7z", mediaType: "application/octet-stream", benign: true, bytes: samples["7z"] },
  iso: { filename: "sample.iso", mediaType: "application/octet-stream", benign: false, bytes: samples.iso },
  png: { filename: "sample.png", mediaType: "image/png", benign: true, bytes: samples.png },
  jpeg: { filename: "sample.jpg", mediaType: "image/jpeg", benign: true, bytes: samples.jpeg },
  gif: { filename: "sample.gif", mediaType: "image/gif", benign: true, bytes: samples.gif },
  webp: { filename: "sample.webp", mediaType: "image/webp", benign: true, bytes: samples.webp },
  html: { filename: "sample.html", mediaType: "text/html", benign: true, bytes: samples.html },
  svg: { filename: "sample.svg", mediaType: "image/svg+xml", benign: true, bytes: samples.svg },
  lnk: { filename: "sample.lnk", mediaType: "application/octet-stream", benign: false, bytes: samples.lnk },
  script: { filename: "sample.bat", mediaType: "application/octet-stream", benign: false, bytes: samples.script },
  text: { filename: "sample.txt", mediaType: "text/plain", benign: true, bytes: samples.text },
  rtf: { filename: "sample.rtf", mediaType: "application/rtf", benign: true, bytes: samples.rtf },
  odf: {
    filename: "sample.odt",
    mediaType: "application/vnd.oasis.opendocument.text",
    benign: true,
    bytes: zip([
      { name: "mimetype", data: enc("application/vnd.oasis.opendocument.text") },
      { name: "content.xml", data: enc("<office:document-content/>") },
    ]),
  },
  m4a: { filename: "sample.m4a", mediaType: "audio/mp4", benign: true, bytes: samples.m4a },
  ogg: { filename: "sample.ogg", mediaType: "audio/ogg", benign: true, bytes: samples.ogg },
  wav: { filename: "sample.wav", mediaType: "audio/wav", benign: true, bytes: samples.wav },
  mp3: { filename: "sample.mp3", mediaType: "audio/mpeg", benign: true, bytes: samples.mp3 },
};

const b64 = (bytes: Uint8Array) => Buffer.from(bytes.subarray(0, 36 * 1024)).toString("base64");

function makeR2Bucket(store: Map<string, Uint8Array>): R2Bucket {
  return {
    get: async (key: string, opts?: { range?: { offset: number; length: number } }) => {
      const full = store.get(key);
      if (!full) return null;
      const slice = opts?.range
        ? full.subarray(opts.range.offset, opts.range.offset + opts.range.length)
        : full;
      return {
        arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
        body: new Response(slice).body,
      };
    },
  } as unknown as R2Bucket;
}

export function scoreAttachments() {
  const names = Object.keys(EXPECTED) as (keyof typeof EXPECTED)[];
  const missed: string[] = [];
  for (const name of names) if (sniff(samples[name]) !== EXPECTED[name]) missed.push(name);
  // Disguised: executable and archive bytes behind a document name must still read as their real type.
  const disguised: { name: string; bytes: Uint8Array; real: SniffedType }[] = [
    { name: "invoice.pdf (pe bytes)", bytes: samples.pe, real: "pe" },
    { name: "statement.pdf (zip bytes)", bytes: samples.zip, real: "zip" },
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

// Runs the full `attachmentRisksOf` + `typeMismatchEvidence` + `executableEvidence` / `macroEvidence` /
// `encryptedArchiveEvidence` checks step over all 27 valid formats, 3 disguised files, 3 risky archives,
// 3 damaged packages, and 8 batch runs of MAX_SNIFFED = 20 attachments, pre-populating observations so an
// interrupted run leaves unrun items marked `failed` and never shrinks denominators.
export async function measureAttachmentChecks(opts?: {
  outPath?: string;
  failAt?: number;
}): Promise<AttachmentsSummary> {
  ensureTsResolve();
  const {
    attachmentRisksOf,
    encryptedArchiveEvidence,
    executableEvidence,
    macroEvidence,
  } = await import("../src/checks/attachment-risk.ts");
  const { typeMismatchEvidence } = await import("../src/checks/attachment-type.ts");
  const names = Object.keys(EXPECTED) as (keyof typeof EXPECTED)[];

  const disguised: { name: string; filename: string; mediaType: string; bytes: Uint8Array; real: SniffedType }[] = [
    { name: "invoice.pdf (pe bytes)", filename: "invoice.pdf", mediaType: "application/pdf", bytes: samples.pe, real: "pe" },
    {
      name: "statement.pdf (zip bytes)",
      filename: "statement.pdf",
      mediaType: "application/pdf",
      bytes: zip([{ name: "readme.txt", data: enc("Hello") }]),
      real: "zip",
    },
    { name: "photo.png (html bytes)", filename: "photo.png", mediaType: "image/png", bytes: samples.html, real: "html" },
  ];
  const archiveRisks: { name: string; filename: string; mediaType: string; bytes: Uint8Array; expectedCheck: string }[] = [
    {
      name: "macro-docx",
      filename: "report.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: zip([{ name: "[Content_Types].xml" }, { name: "word/document.xml" }, { name: "word/vbaProject.bin" }]),
      expectedCheck: "attachment.macro",
    },
    {
      name: "encrypted-zip",
      filename: "pay.zip",
      mediaType: "application/zip",
      bytes: zip([{ name: "invoice.pdf", data: samples.pdf, encrypted: true }]),
      expectedCheck: "attachment.encrypted_archive",
    },
    {
      name: "exe-in-zip",
      filename: "bundle.zip",
      mediaType: "application/zip",
      bytes: zip([{ name: "invoice.exe", data: samples.pe }]),
      expectedCheck: "attachment.executable",
    },
  ];
  const damaged: { name: string; filename: string; bytes: Uint8Array; valid: SniffedType; isArchive: boolean }[] = [
    { name: "truncated pdf", filename: "truncated.pdf", bytes: samples.pdf.slice(0, 4), valid: "pdf", isArchive: false },
    { name: "truncated zip", filename: "truncated.zip", bytes: samples.zip.slice(0, 10), valid: "zip", isArchive: true },
    { name: "truncated png", filename: "truncated.png", bytes: samples.png.slice(0, 4), valid: "png", isArchive: false },
  ];
  const BATCH_REPS = 8;

  const observations: AttachmentObservation[] = [
    ...names.map((name) => ({
      name,
      category: "valid" as const,
      expected: EXPECTED[name],
      matched: false,
      isBenignValid: VALID_SPEC[name].benign,
      mismatchFlagged: false,
      riskFlagged: false,
      status: "failed" as const,
    })),
    ...disguised.map((d) => ({
      name: d.name,
      category: "disguised" as const,
      expected: d.real,
      matched: false,
      mismatchFlagged: false,
      status: "failed" as const,
    })),
    ...archiveRisks.map((a) => ({
      name: a.name,
      category: "archive-risk" as const,
      expected: a.expectedCheck,
      matched: false,
      riskFlagged: false,
      status: "failed" as const,
    })),
    ...damaged.map((d) => ({
      name: d.name,
      category: "damaged" as const,
      expected: d.valid,
      matched: false,
      isArchive: d.isArchive,
      riskNotChecked: null,
      status: "failed" as const,
    })),
    ...Array.from({ length: BATCH_REPS }, (_, r) => ({
      name: `batch-20-rep-${r + 1}`,
      category: "batch-check" as const,
      matched: false,
      ms: null,
      status: "failed" as const,
    })),
  ];

  const benignValidTotal = names.filter((n) => VALID_SPEC[n].benign).length;
  const damagedArchivesTotal = damaged.filter((d) => d.isArchive).length;

  const computeSummary = (): AttachmentsSummary => {
    const valObs = observations.filter((o) => o.category === "valid");
    const disgObs = observations.filter((o) => o.category === "disguised");
    const archObs = observations.filter((o) => o.category === "archive-risk");
    const damObs = observations.filter((o) => o.category === "damaged");
    const batchObs = observations.filter((o) => o.category === "batch-check" && o.status === "ok" && o.ms !== null);
    const times = batchObs.map((o) => o.ms as number).sort((a, b) => a - b);
    const at = (q: number) =>
      times.length ? (times[Math.min(times.length - 1, Math.ceil(q * times.length) - 1)] as number) : null;
    return {
      valid: names.length,
      identified: valObs.filter((o) => o.status === "ok" && o.matched).length,
      typeMismatchFalsePositives: valObs.filter((o) => o.status === "ok" && o.mismatchFlagged).length,
      benignValid: benignValidTotal,
      archiveFalsePositives: valObs.filter((o) => o.status === "ok" && o.isBenignValid && o.riskFlagged).length,
      disguised: disguised.length,
      disguisedCaught: disgObs.filter((o) => o.status === "ok" && o.matched).length,
      mismatchCaught: disgObs.filter((o) => o.status === "ok" && o.mismatchFlagged).length,
      archiveChecks: archiveRisks.length,
      archiveRiskCaught: archObs.filter((o) => o.status === "ok" && o.riskFlagged).length,
      damaged: damaged.length,
      damagedReadAsValid: damObs.filter((o) => o.status === "ok" && o.matched).length,
      damagedArchives: damagedArchivesTotal,
      damagedArchiveCaught: damObs.filter((o) => o.status === "ok" && o.isArchive && Boolean(o.riskNotChecked)).length,
      p50Ms: at(0.5),
      p95Ms: at(0.95),
      observations,
      provenance: {
        collector: "eval/attachments.ts#measureAttachmentChecks",
        timingBoundary: "attachmentRisksOf (R2 range reads + archive inspection) + typeMismatchEvidence + macroEvidence + encryptedArchiveEvidence + executableEvidence over MAX_SNIFFED = 20 attachments",
        repetitions: observations.length,
        inputDescription: "27 valid format samples, 3 disguised samples, 3 archive-risk samples, 3 damaged truncated packages, plus 8 batch runs of 20 attachments",
      },
    };
  };

  const persist = () => {
    if (opts?.outPath) {
      writeFileSync(opts.outPath, `${JSON.stringify(computeSummary(), null, 1)}\n`);
    }
  };

  persist();

  const runCheckSuite = async (key: string, filename: string, mediaType: string, bytes: Uint8Array) => {
    const store = new Map<string, Uint8Array>([[key, bytes]]);
    const attachments = [{ key, filename, mediaType, bytes: bytes.byteLength, sha256: "0".repeat(64) }];
    const attachmentHeads = { heads: [{ key, head: b64(bytes) }], unread: 0 };
    const attachmentRisks = await attachmentRisksOf(makeR2Bucket(store), { attachments, attachmentHeads });
    const view = {
      source: { kind: "email" },
      attachments,
      attachmentHeads,
      attachmentRisks,
    } as unknown as CaseView;
    const mismatchItems = typeMismatchEvidence(view);
    const riskItems = [
      ...macroEvidence(view),
      ...encryptedArchiveEvidence(view),
      ...executableEvidence(view),
    ];
    return {
      attachmentRisks,
      mismatchFlagged: mismatchItems.some((e) => e.check === "attachment.type_mismatch"),
      riskFlagged: riskItems.some((e) => e.severity === "high" || e.severity === "critical"),
      riskChecks: riskItems.filter((e) => e.severity === "high" || e.severity === "critical").map((e) => e.check),
    };
  };

  let idx = 0;
  for (const name of names) {
    const slot = idx++;
    const spec = VALID_SPEC[name];
    try {
      if (opts?.failAt === slot) throw new Error("simulated collector failure");
      const s = sniff(spec.bytes);
      const res = await runCheckSuite(name, spec.filename, spec.mediaType, spec.bytes);
      observations[slot] = {
        name,
        category: "valid",
        expected: EXPECTED[name],
        sniffed: s,
        matched: s === EXPECTED[name],
        isBenignValid: spec.benign,
        mismatchFlagged: res.mismatchFlagged,
        riskFlagged: res.riskFlagged,
        status: "ok",
      };
    } catch {
      // keep pre-populated failed slot
    }
    persist();
  }

  for (const d of disguised) {
    const slot = idx++;
    try {
      if (opts?.failAt === slot) throw new Error("simulated collector failure");
      const s = sniff(d.bytes);
      const res = await runCheckSuite(d.name, d.filename, d.mediaType, d.bytes);
      observations[slot] = {
        name: d.name,
        category: "disguised",
        expected: d.real,
        sniffed: s,
        matched: s === d.real,
        mismatchFlagged: res.mismatchFlagged,
        status: "ok",
      };
    } catch {
      // keep pre-populated failed slot
    }
    persist();
  }

  for (const a of archiveRisks) {
    const slot = idx++;
    try {
      if (opts?.failAt === slot) throw new Error("simulated collector failure");
      const res = await runCheckSuite(a.name, a.filename, a.mediaType, a.bytes);
      const caught = res.riskChecks.includes(a.expectedCheck);
      observations[slot] = {
        name: a.name,
        category: "archive-risk",
        expected: a.expectedCheck,
        matched: caught,
        riskFlagged: caught,
        status: "ok",
      };
    } catch {
      // keep pre-populated failed slot
    }
    persist();
  }

  for (const d of damaged) {
    const slot = idx++;
    try {
      if (opts?.failAt === slot) throw new Error("simulated collector failure");
      const s = sniff(d.bytes);
      const res = await runCheckSuite(d.name, d.filename, "application/octet-stream", d.bytes);
      const notChecked = res.attachmentRisks?.items[0]?.notChecked ?? null;
      observations[slot] = {
        name: d.name,
        category: "damaged",
        expected: d.valid,
        sniffed: s,
        matched: s === d.valid,
        isArchive: d.isArchive,
        riskNotChecked: notChecked,
        status: "ok",
      };
    } catch {
      // keep pre-populated failed slot
    }
    persist();
  }

  const batchStore = new Map<string, Uint8Array>();
  const batchAtts = names.slice(0, MAX_SNIFFED).map((n, i) => {
    const key = `batch-${i}`;
    const spec = VALID_SPEC[n];
    batchStore.set(key, spec.bytes);
    return {
      key,
      filename: spec.filename,
      mediaType: spec.mediaType,
      bytes: spec.bytes.byteLength,
      sha256: "0".repeat(64),
    };
  });
  const batchHeads = names.slice(0, MAX_SNIFFED).map((n, i) => ({
    key: `batch-${i}`,
    head: b64(VALID_SPEC[n].bytes),
  }));
  const bucket = makeR2Bucket(batchStore);

  for (let rep = 0; rep < BATCH_REPS; rep++) {
    const slot = idx++;
    try {
      if (opts?.failAt === slot) throw new Error("simulated collector failure");
      const t0 = performance.now();
      const attachmentRisks = await attachmentRisksOf(bucket, {
        attachments: batchAtts,
        attachmentHeads: { heads: batchHeads, unread: 0 },
      });
      const view = {
        source: { kind: "email" },
        attachments: batchAtts,
        attachmentHeads: { heads: batchHeads, unread: 0 },
        attachmentRisks,
      } as unknown as CaseView;
      const mm = typeMismatchEvidence(view);
      const mc = macroEvidence(view);
      const ec = encryptedArchiveEvidence(view);
      const xc = executableEvidence(view);
      const elapsed = Number((performance.now() - t0).toFixed(3));
      observations[slot] = {
        name: `batch-20-rep-${rep + 1}`,
        category: "batch-check",
        matched: mm.length === 0 && mc.length === 0 && ec.length === 0 && xc.length > 0,
        ms: elapsed,
        status: "ok",
      };
    } catch {
      // keep pre-populated failed slot
    }
    persist();
  }

  return computeSummary();
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const outPath = join(ROOT, "eval/components/attachments.json");
  await measureAttachmentChecks({ outPath });
}
