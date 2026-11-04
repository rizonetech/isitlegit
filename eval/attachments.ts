// Attachment identification and archive-check measurement (D08 T02 section 8, D02 T04 sections 1, 3 and 5):
// the sniffed type of every valid synthetic sample, of disguised bytes (a real type behind another name),
// and of damaged packages (truncated bytes), scored through the real `sniff`, `typeMismatchEvidence`, and
// `attachmentRisksOf` + `executableEvidence` / `macroEvidence` / `encryptedArchiveEvidence`.
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CaseView } from "../src/checks/case-view.ts";
import { MAX_SNIFFED, type SniffedType, sniff } from "../src/checks/sniff.ts";
import { samples } from "../test/fixtures/attachments/samples.ts";
import type { AttachmentObservation, AttachmentsSummary } from "./components.ts";
import { ensureTsResolve } from "./intake-time.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

const b64 = (bytes: Uint8Array) => Buffer.from(bytes.subarray(0, 512)).toString("base64");

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

// Runs the full `attachmentRisksOf` + `typeMismatchEvidence` + `executableEvidence` / `macroEvidence` /
// `encryptedArchiveEvidence` checks step over valid, disguised, and damaged packages and times `MAX_SNIFFED = 20`
// attachments per case, persisting raw observations incrementally.
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
  const observations: AttachmentObservation[] = [];

  const disguised: { name: string; filename: string; mediaType: string; bytes: Uint8Array; real: SniffedType }[] = [
    { name: "invoice.pdf (pe bytes)", filename: "invoice.pdf", mediaType: "application/pdf", bytes: samples.pe, real: "pe" },
    { name: "statement.docx (zip bytes)", filename: "statement.docx", mediaType: "application/pdf", bytes: samples.zip, real: "zip" },
    { name: "photo.png (html bytes)", filename: "photo.png", mediaType: "image/png", bytes: samples.html, real: "html" },
  ];
  const damaged: { name: string; filename: string; bytes: Uint8Array; valid: SniffedType }[] = [
    { name: "truncated pdf", filename: "truncated.pdf", bytes: samples.pdf.slice(0, 4), valid: "pdf" },
    { name: "truncated zip", filename: "truncated.zip", bytes: samples.zip.slice(0, 10), valid: "zip" },
    { name: "truncated png", filename: "truncated.png", bytes: samples.png.slice(0, 4), valid: "png" },
  ];

  const computeSummary = (): AttachmentsSummary => {
    const valObs = observations.filter((o) => o.category === "valid");
    const disgObs = observations.filter((o) => o.category === "disguised");
    const damObs = observations.filter((o) => o.category === "damaged");
    const batchObs = observations.filter((o) => o.category === "batch-check" && o.status === "ok" && o.ms !== null);
    const times = batchObs.map((o) => o.ms as number).sort((a, b) => a - b);
    const at = (q: number) =>
      times.length ? (times[Math.min(times.length - 1, Math.ceil(q * times.length) - 1)] as number) : null;
    return {
      valid: valObs.length,
      identified: valObs.filter((o) => o.status === "ok" && o.matched).length,
      disguised: disgObs.length,
      disguisedCaught: disgObs.filter((o) => o.status === "ok" && o.matched).length,
      damaged: damObs.length,
      damagedReadAsValid: damObs.filter((o) => o.status === "ok" && o.matched).length,
      mismatchCaught: disgObs.filter((o) => o.status === "ok" && o.mismatchFlagged).length,
      damagedArchiveCaught: damObs.filter((o) => o.status === "ok" && (!o.matched || Boolean(o.riskNotChecked))).length,
      p50Ms: at(0.5),
      p95Ms: at(0.95),
      observations,
      provenance: {
        collector: "eval/attachments.ts#measureAttachmentChecks",
        timingBoundary: "attachmentRisksOf (R2 range reads + archive inspection) + typeMismatchEvidence + macroEvidence + encryptedArchiveEvidence + executableEvidence over MAX_SNIFFED = 20 attachments",
        repetitions: 8,
        inputDescription: "27 valid format samples, 3 disguised samples, 3 damaged truncated packages, plus 8 batch runs of 20 attachments",
      },
    };
  };

  const persist = () => {
    if (opts?.outPath) {
      writeFileSync(opts.outPath, `${JSON.stringify(computeSummary(), null, 1)}\n`);
    }
  };

  let idx = 0;
  for (const name of names) {
    try {
      if (opts?.failAt === idx++) throw new Error("simulated collector failure");
      const bytes = samples[name];
      const s = sniff(bytes);
      observations.push({
        name,
        category: "valid",
        expected: EXPECTED[name],
        sniffed: s,
        matched: s === EXPECTED[name],
        status: "ok",
      });
    } catch {
      observations.push({ name, category: "valid", expected: EXPECTED[name], matched: false, status: "failed" });
    }
    persist();
  }

  for (const d of disguised) {
    try {
      if (opts?.failAt === idx++) throw new Error("simulated collector failure");
      const s = sniff(d.bytes);
      const view = {
        source: { kind: "email" },
        attachments: [{ key: d.name, filename: d.filename, mediaType: d.mediaType, bytes: d.bytes.byteLength, sha256: "0".repeat(64) }],
        attachmentHeads: { heads: [{ key: d.name, head: b64(d.bytes) }], unread: 0 },
      } as unknown as CaseView;
      const mismatch = typeMismatchEvidence(view).some((e) => e.check === "attachment.type_mismatch");
      observations.push({
        name: d.name,
        category: "disguised",
        expected: d.real,
        sniffed: s,
        matched: s === d.real,
        mismatchFlagged: mismatch,
        status: "ok",
      });
    } catch {
      observations.push({ name: d.name, category: "disguised", expected: d.real, matched: false, status: "failed" });
    }
    persist();
  }

  for (const d of damaged) {
    try {
      if (opts?.failAt === idx++) throw new Error("simulated collector failure");
      const s = sniff(d.bytes);
      const store = new Map<string, Uint8Array>([[d.name, d.bytes]]);
      const risks = await attachmentRisksOf(makeR2Bucket(store), {
        attachments: [{ key: d.name, filename: d.filename, mediaType: "application/octet-stream", bytes: d.bytes.byteLength, sha256: "0".repeat(64) }],
        attachmentHeads: { heads: [{ key: d.name, head: b64(d.bytes) }], unread: 0 },
      });
      const notChecked = risks?.items[0]?.notChecked ?? null;
      observations.push({
        name: d.name,
        category: "damaged",
        expected: d.valid,
        sniffed: s,
        matched: s === d.valid,
        riskNotChecked: notChecked,
        status: "ok",
      });
    } catch {
      observations.push({ name: d.name, category: "damaged", expected: d.valid, matched: false, status: "failed" });
    }
    persist();
  }

  const batchStore = new Map<string, Uint8Array>();
  const batchAtts = names.slice(0, MAX_SNIFFED).map((n, i) => {
    const key = `batch-${i}`;
    batchStore.set(key, samples[n]);
    return {
      key,
      filename: `sample-${i}.${n}`,
      mediaType: "application/octet-stream",
      bytes: samples[n].byteLength,
      sha256: "0".repeat(64),
    };
  });
  const batchHeads = names.slice(0, MAX_SNIFFED).map((n, i) => ({ key: `batch-${i}`, head: b64(samples[n]) }));
  const bucket = makeR2Bucket(batchStore);

  for (let rep = 0; rep < 8; rep++) {
    try {
      if (opts?.failAt === idx++) throw new Error("simulated collector failure");
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
      typeMismatchEvidence(view);
      macroEvidence(view);
      encryptedArchiveEvidence(view);
      executableEvidence(view);
      const elapsed = Number((performance.now() - t0).toFixed(3));
      observations.push({
        name: `batch-20-rep-${rep + 1}`,
        category: "batch-check",
        matched: true,
        ms: elapsed,
        status: "ok",
      });
    } catch {
      observations.push({
        name: `batch-20-rep-${rep + 1}`,
        category: "batch-check",
        matched: false,
        ms: null,
        status: "failed",
      });
    }
    persist();
  }

  return computeSummary();
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const outPath = join(ROOT, "eval/components/attachments.json");
  await measureAttachmentChecks({ outPath });
}
