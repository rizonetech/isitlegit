import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { makeDecoyCompoundFile, renameEntry } from "../../scripts/fixtures/msg-builder";
import { attachmentRisksOf, MAX_OLE_BYTES, MAX_RISK_ATTACHMENTS } from "../../src/checks/attachment-risk";
import type { CaseView } from "../../src/checks/case-view";
import { readEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { parsedKey, putAttachment, putParsed, putRaw, type Store } from "../../src/intake/store";
import { checks } from "../../src/pipeline/analysis-workflow";
import {
  AES,
  encodedHeader,
  LZMA,
  plainHeader,
  rar4,
  rar5,
  rar5Many,
  sevenZip,
  zip,
} from "../fixtures/attachments/archives";
import { samples } from "../fixtures/attachments/samples";

// D02 T04 §3: macros, encrypted archives and executables in attachments, read through the checks step.
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const enc = (s: string) => new TextEncoder().encode(s);
const pdf = samples.pdf;

type File = [string, string, Uint8Array] | [string, string, Uint8Array, number];
async function caseWith(files: File[]) {
  const made = await createCase(env.DB, { orgId: "org-risk", channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  const id = made.value.id;
  await putRaw(store, id, enc("From: x@y.example\r\n\r\nSee attached.\r\n"));
  const attachments = [];
  for (const [filename, mediaType, body, claimedBytes] of files) {
    const stored = await putAttachment(store, id, filename, body, mediaType);
    attachments.push({
      key: stored.key,
      filename,
      mediaType,
      contentId: null,
      disposition: "attachment",
      bytes: claimedBytes ?? body.length,
    });
  }
  await putParsed(store, id, {
    headers: [],
    text: "See attached.",
    html: null,
    attachments,
    truncated: [],
    omitted: 0,
    forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
  });
  return id;
}
const run = (id: string) => checks(store, id, parsedKey(id), { orgId: "org-risk", channel: "email" }, async () => []);
const risky = async (id: string) =>
  (await readEvidence(env.DB, id))
    .filter(
      (e) =>
        e.check.startsWith("attachment.") &&
        ["attachment.macro", "attachment.encrypted_archive", "attachment.executable"].includes(e.check),
    )
    .map((e) => [
      e.check,
      e.severity,
      (e.detail.findings as { where: string }[] | undefined)?.[0]?.where ?? e.detail.reason ?? e.detail.unread,
    ]);
const one = async (file: File) => {
  const id = await caseWith([file]);
  await run(id);
  return risky(id);
};

describe("macros", () => {
  it("finds vbaProject.bin, a macro-enabled name, and an OLE Macros storage or _VBA_PROJECT stream", async () => {
    const ooxml = zip([
      { name: "[Content_Types].xml" },
      { name: "word/document.xml" },
      { name: "word/vbaProject.bin" },
    ]);
    expect(await one(["report.docx", "application/zip", ooxml])).toEqual([
      ["attachment.macro", "high", "report.docx > word/vbaProject.bin"],
    ]);
    expect(
      await one([
        "budget.xlsm",
        "application/octet-stream",
        zip([{ name: "[Content_Types].xml" }, { name: "xl/workbook.xml" }]),
      ]),
    ).toEqual([["attachment.macro", "high", "budget.xlsm"]]);
    const decoy = makeDecoyCompoundFile();
    expect(await one(["old.doc", "application/msword", renameEntry(decoy, "WordDocument", "Macros")])).toEqual([
      ["attachment.macro", "high", "old.doc"],
    ]);
    expect(
      await one(["old.xls", "application/vnd.ms-excel", renameEntry(decoy, "WordDocument", "_VBA_PROJECT")]),
    ).toEqual([["attachment.macro", "high", "old.xls"]]);
  });

  it("finds none in a plain OOXML package or a plain OLE file", async () => {
    expect(
      await one([
        "report.docx",
        "application/zip",
        zip([{ name: "[Content_Types].xml" }, { name: "word/document.xml" }]),
      ]),
    ).toEqual([]);
    expect(await one(["old.doc", "application/msword", makeDecoyCompoundFile()])).toEqual([]);
  });
});

describe("encrypted archives", () => {
  it("finds an encrypted ZIP entry, not a plain ZIP", async () => {
    expect(
      await one(["pay.zip", "application/zip", zip([{ name: "invoice.pdf", data: pdf, encrypted: true }])]),
    ).toEqual([["attachment.encrypted_archive", "high", "pay.zip > invoice.pdf"]]);
    expect(await one(["pay.zip", "application/zip", zip([{ name: "invoice.pdf", data: pdf }])])).toEqual([]);
  });

  it("finds RAR4 and RAR5 encryption, headers or files, and none in plain ones", async () => {
    expect(await one(["a.rar", "application/vnd.rar", rar4({ headersEncrypted: true })])).toEqual([
      ["attachment.encrypted_archive", "high", "a.rar"],
    ]);
    expect(await one(["a.rar", "application/vnd.rar", rar4({ fileEncrypted: true })])).toEqual([
      ["attachment.encrypted_archive", "high", "a.rar"],
    ]);
    expect(await one(["a.rar", "application/vnd.rar", rar4()])).toEqual([]);
    expect(await one(["b.rar", "application/vnd.rar", rar5({ archiveEncrypted: true })])).toEqual([
      ["attachment.encrypted_archive", "high", "b.rar"],
    ]);
    expect(await one(["b.rar", "application/vnd.rar", rar5()])).toEqual([]);
  });

  it("walks past a large unencrypted RAR5 member to an encrypted one, within its reads", async () => {
    expect(await one(["c.rar", "application/vnd.rar", rar5({ encryptedAfter: 300_000 })])).toEqual([
      ["attachment.encrypted_archive", "high", "c.rar"],
    ]);
  });

  it("finds a 7z AES coder in a plain or encoded header, and says an LZMA-encoded header is not checked", async () => {
    expect(await one(["d.7z", "application/x-7z-compressed", sevenZip(plainHeader(AES))])).toEqual([
      ["attachment.encrypted_archive", "high", "d.7z"],
    ]);
    expect(await one(["d.7z", "application/x-7z-compressed", sevenZip(encodedHeader(AES))])).toEqual([
      ["attachment.encrypted_archive", "high", "d.7z"],
    ]);
    expect(await one(["d.7z", "application/x-7z-compressed", sevenZip(plainHeader(LZMA))])).toEqual([]);
    expect(await one(["d.7z", "application/x-7z-compressed", sevenZip(encodedHeader(LZMA))])).toEqual([
      ["attachment.executable", "info", "its header is compressed, which is not read yet"],
    ]);
  });
});

describe("executables", () => {
  it("finds a program by its bytes alone, a script by its name alone, and one inside a ZIP", async () => {
    expect(await one(["data.dat", "application/octet-stream", samples.pe])).toEqual([
      ["attachment.executable", "critical", "data.dat"],
    ]);
    expect(await one(["note.vbs", "text/plain", enc('MsgBox "hi"')])).toEqual([
      ["attachment.executable", "critical", "note.vbs"],
    ]);
    expect(
      await one(["docs.zip", "application/zip", zip([{ name: "docs/invoice.pdf.exe", data: samples.pe }])]),
    ).toEqual([["attachment.executable", "critical", "docs.zip > docs/invoice.pdf.exe"]]);
  });

  it("finds none in a ZIP holding a PDF", async () => {
    expect(await one(["docs.zip", "application/zip", zip([{ name: "invoice.pdf", data: pdf }])])).toEqual([]);
  });
});

describe("limits and refusals", () => {
  it("says what it could not check, and never hides another attachment's finding", async () => {
    const id = await caseWith([
      ["broken.zip", "application/zip", enc("PK\x03\x04 truncated")],
      ["huge.doc", "application/msword", makeDecoyCompoundFile(), MAX_OLE_BYTES + 1],
      ["run.exe", "application/octet-stream", samples.pe],
    ]);
    await run(id);
    expect(await risky(id)).toEqual([
      ["attachment.executable", "critical", "run.exe"],
      ["attachment.executable", "info", "its central directory was not found"],
      ["attachment.executable", "info", "it is larger than is read"],
    ]);
  });

  it("stops a RAR walk at its read cap and says the archive was not fully checked", async () => {
    // Seventy members of 70 KB each: every header is a separate read, past MAX_RAR_READS.
    const many = rar5Many(70, 70_000);
    expect(await one(["many.rar", "application/vnd.rar", many])).toEqual([
      ["attachment.executable", "info", "the archive is longer than is walked"],
    ]);
  });

  it("counts attachments past the limit", async () => {
    const files: File[] = Array.from({ length: MAX_RISK_ATTACHMENTS + 3 }, (_, i) => [
      `f${i}.pdf`,
      "application/pdf",
      enc(`%PDF-1.4 ${i}`),
    ]);
    const id = await caseWith(files);
    await run(id);
    expect(await risky(id)).toEqual([["attachment.executable", "info", 3]]);
  });

  it("says a missing object was not checked, and throws on a storage error", async () => {
    const view = {
      attachments: [
        {
          key: "raw/x/attachments/gone",
          filename: "gone.zip",
          mediaType: "application/zip",
          contentId: null,
          disposition: null,
          bytes: 100,
        },
      ],
      attachmentHeads: { heads: [{ key: "raw/x/attachments/gone", head: btoa("PK\x03\x04") }], unread: 0 },
    } as unknown as Pick<CaseView, "attachments" | "attachmentHeads">;
    expect((await attachmentRisksOf(env.ARTEFACTS, view))?.items[0]?.notChecked).toBe("the attachment is missing");
    const broken = { get: async () => Promise.reject(new Error("R2 down")) } as unknown as R2Bucket;
    await expect(attachmentRisksOf(broken, view)).rejects.toThrow("R2 down");
  });

  it("stores the same items when the step runs twice", async () => {
    const id = await caseWith([["run.exe", "application/octet-stream", samples.pe]]);
    await run(id);
    await run(id);
    expect(await risky(id)).toEqual([["attachment.executable", "critical", "run.exe"]]);
  });
});
