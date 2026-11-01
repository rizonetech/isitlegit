import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDecoyCompoundFile, renameEntry } from "../../scripts/fixtures/msg-builder";
import {
  attachmentRisksOf,
  crc32,
  inflate,
  MAX_EXPANDED_BYTES,
  MAX_MEMBER_PACKED_BYTES,
  MAX_MEMBERS_READ,
  MAX_NESTED_BYTES,
  MAX_OLE_BYTES,
  MAX_RAR_BYTES,
  MAX_RISK_ATTACHMENTS,
  MAX_RTF_BYTES,
  manifestEncrypted,
} from "../../src/checks/attachment-risk";
import type { CaseView } from "../../src/checks/case-view";
import { readEvidence } from "../../src/checks/evidence";
import { MAX_OBJECT_BYTES, MAX_RTF_OBJECTS, rtfObjects } from "../../src/checks/rtf";
import { attachmentHeadsOf, SNIFF_BYTES, sniff } from "../../src/checks/sniff";
import { createCase } from "../../src/db/cases";
import { parsedKey, putAttachment, putParsed, putRaw, readArtefact, type Store } from "../../src/intake/store";
import { checks } from "../../src/pipeline/analysis-workflow";
import {
  AES,
  AES_IN_NAME,
  encodedHeader,
  LZMA,
  plainHeader,
  plainHeaderWithAdditional,
  rar4,
  rar5,
  rar5Many,
  rar5Oversized,
  sevenZip,
  unicodePath,
  zip,
} from "../fixtures/attachments/archives";
import { encryptedNames7z, plainNames7z } from "../fixtures/attachments/lzma";
import * as rtfs from "../fixtures/attachments/rtf";
import { samples } from "../fixtures/attachments/samples";
import { lockedFiles7z, lockedNames7z, plain7z } from "../fixtures/attachments/seven-zip";
import * as zips from "../fixtures/attachments/zips";

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

  it("finds a 7z AES coder in a plain or encoded header, and says an LZMA-encoded header it cannot decode is not checked", async () => {
    expect(await one(["d.7z", "application/x-7z-compressed", sevenZip(plainHeader(AES))])).toEqual([
      ["attachment.encrypted_archive", "high", "d.7z"],
    ]);
    expect(await one(["d.7z", "application/x-7z-compressed", sevenZip(encodedHeader(AES))])).toEqual([
      ["attachment.encrypted_archive", "high", "d.7z"],
    ]);
    expect(await one(["d.7z", "application/x-7z-compressed", sevenZip(plainHeader(LZMA))])).toEqual([]);
    // A filename holding the AES coder's bytes is no coder (completion review).
    expect(await one(["e.7z", "application/x-7z-compressed", sevenZip(plainHeader(LZMA, AES_IN_NAME))])).toEqual([]);
    // An LZMA-encoded header whose packed bytes are no LZMA stream (this fixture's are zeros): decoded since D02 T04 §7,
    // and refused as not checked with the decoder's reason, never clean.
    expect(await one(["d.7z", "application/x-7z-compressed", sevenZip(encodedHeader(LZMA))])).toEqual([
      ["attachment.executable", "info", "its compressed header could not be decoded (the stream ends early)"],
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
      ["attachment.executable", "info", "it is too short to be a ZIP archive"],
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

describe("after the completion review", () => {
  it("reads an LZMA-compressed 7z header: encrypted files with visible names are high, plain ones nothing (D02 T04 §7)", async () => {
    const b64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    expect(await one(["names.7z", "application/x-7z-compressed", b64(encryptedNames7z)])).toEqual([
      ["attachment.encrypted_archive", "high", "names.7z"],
    ]);
    expect(await one(["plain.7z", "application/x-7z-compressed", b64(plainNames7z)])).toEqual([]);
  });

  it("reads 7z archives 7-Zip itself made: plain files nothing, locked files and locked names high (§7 completion)", async () => {
    const b64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    expect(await one(["plain.7z", "application/x-7z-compressed", b64(plain7z)])).toEqual([]);
    expect(await one(["files.7z", "application/x-7z-compressed", b64(lockedFiles7z)])).toEqual([
      ["attachment.encrypted_archive", "high", "files.7z"],
    ]);
    expect(await one(["names.7z", "application/x-7z-compressed", b64(lockedNames7z)])).toEqual([
      ["attachment.encrypted_archive", "high", "names.7z"],
    ]);
  });

  it("says a 7z whose start, header or decoded-header checksum does not match is not checked, never clean", async () => {
    const archive = Uint8Array.from(atob(plainNames7z), (c) => c.charCodeAt(0));
    const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
    // Recomputes the start header's two checksums after a change further in, so only the change itself is wrong.
    const resealed = (b: Uint8Array) => {
      const next = 32 + Number(view(b).getBigUint64(12, true));
      view(b).setUint32(28, crc32(b.subarray(next)), true);
      view(b).setUint32(8, crc32(b.subarray(12, 32)), true);
      return b;
    };
    const startWrong = archive.slice();
    startWrong[8] = (startWrong[8] as number) ^ 0xff;
    const headerWrong = archive.slice();
    headerWrong[headerWrong.length - 2] = (headerWrong[headerWrong.length - 2] as number) ^ 0xff;
    // The decoded header's CRC (the encoded header's last four bytes before its two ends) made wrong, the rest resealed.
    const decodedWrong = archive.slice();
    decodedWrong[decodedWrong.length - 3] = (decodedWrong[decodedWrong.length - 3] as number) ^ 0xff;
    resealed(decodedWrong);
    // The encoded header's packed CRC (its PackInfo's kCRC) made wrong, and its packed size made zero (round 1).
    const encodedAt = (b: Uint8Array) => 32 + Number(view(b).getBigUint64(12, true));
    const packCrcWrong = archive.slice();
    packCrcWrong[encodedAt(packCrcWrong) + 8] = (packCrcWrong[encodedAt(packCrcWrong) + 8] as number) ^ 0xff;
    resealed(packCrcWrong);
    const packEmpty = archive.slice();
    packEmpty[encodedAt(packEmpty) + 5] = 0;
    resealed(packEmpty);
    // A SubStreamsInfo after the folders, carrying a digest that is not read (round 2): the encoded header's end
    // (its last 0x00) becomes `08 0A 01 <CRC> 00 00`, NextHeaderSize grows by eight and the start header is resealed.
    const withSubstreams = new Uint8Array([
      ...archive.subarray(0, archive.length - 1),
      0x08,
      0x0a,
      0x01,
      1,
      2,
      3,
      4,
      0x00,
      0x00,
    ]);
    view(withSubstreams).setBigUint64(20, BigInt(archive.length - encodedAt(archive) + 8), true);
    resealed(withSubstreams);
    for (const [name, body, why] of [
      ["substreams.7z", withSubstreams, "its compressed header has a record after its folders that is not read"],
      ["packcrc.7z", packCrcWrong, "its compressed header's checksum does not match"],
      ["packempty.7z", packEmpty, "its compressed header is too short to hold a stream"],
      ["start.7z", startWrong, "its start header's checksum does not match"],
      ["header.7z", headerWrong, "its header's checksum does not match"],
      ["decoded.7z", decodedWrong, "its compressed header's checksum does not match"],
    ] as const)
      expect(await one([name, "application/x-7z-compressed", body]), name).toEqual([
        ["attachment.executable", "info", why],
      ]);
  });

  it("keeps AES first in an encoded header, alone or with LZMA, and refuses a bad compressed header as not checked", async () => {
    expect(await one(["aes.7z", "application/x-7z-compressed", sevenZip(encodedHeader(AES))])).toEqual([
      ["attachment.encrypted_archive", "high", "aes.7z"],
    ]);
    // One folder of two coders, LZMA then AES, as 7-Zip writes a header compressed and encrypted (-mhe).
    const both = new Uint8Array([
      0x17,
      ...[0x06, 0x00, 0x01, 0x09, 0x10, 0x00],
      ...[0x07, 0x0b, 0x01, 0x00, 0x02],
      ...[0x23, 0x03, 0x01, 0x01, 0x05, 0x5d, 0x00, 0x00, 0x01, 0x00],
      ...[0x24, ...AES, 0x00],
      ...[0x01, 0x00],
      ...[0x0c, 0x20, 0x20, 0x00],
      0x00,
    ]);
    expect(await one(["both.7z", "application/x-7z-compressed", sevenZip(both)])).toEqual([
      ["attachment.encrypted_archive", "high", "both.7z"],
    ]);
    const plain = Uint8Array.from(atob(plainNames7z), (c) => c.charCodeAt(0));
    // The packed range made to run past the file, then the packed bytes corrupted.
    const past = plain.slice();
    const encodedAt = 32 + Number(new DataView(past.buffer).getBigUint64(12, true));
    past[encodedAt + 4] = 0x7f;
    const corrupted = plain.slice();
    for (let i = 32 + 48 + 1; i < 32 + 48 + 12; i++) corrupted[i] = (corrupted[i] as number) ^ 0xa5;
    for (const [name, body] of [
      ["past.7z", past],
      ["corrupt.7z", corrupted],
    ] as const) {
      const got = await one([name, "application/x-7z-compressed", body]);
      expect(got.length, name).toBe(1);
      expect(got[0]?.[1], name).toBe("info");
    }
  });

  it("says a compressed 7z header R2 gives back short is not checked, and one beside an encrypted ZIP leaves its finding", async () => {
    const plain = Uint8Array.from(atob(plainNames7z), (c) => c.charCodeAt(0));
    const id = await caseWith([
      ["short.7z", "application/x-7z-compressed", plain],
      ["locked.zip", "application/zip", zip([{ name: "a.pdf", data: pdf, encrypted: true }])],
    ]);
    // R2 answers the packed header's range with fewer bytes than asked, as a truncated object would.
    const shortBucket = new Proxy(env.ARTEFACTS, {
      get: (target, name) =>
        name === "get"
          ? async (key: string, options?: R2GetOptions) => {
              const object = await target.get(key, options);
              const range = options?.range as { offset?: number; length?: number } | undefined;
              if (!object || !String(key).endsWith("short.7z") || (range?.offset ?? 0) !== 32 + 48) return object;
              const body = new Uint8Array(await object.arrayBuffer()).subarray(0, 3);
              return { ...object, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + 3) };
            }
          : Reflect.get(target, name).bind(target),
    });
    const read = await readArtefact(store, id, parsedKey(id));
    if (!read || !("body" in read)) throw new Error("no summary");
    const summary = JSON.parse(new TextDecoder().decode(read.body)) as { attachments: CaseView["attachments"] };
    const risks = await attachmentRisksOf(shortBucket as unknown as R2Bucket, {
      attachments: summary.attachments,
      attachmentHeads: await attachmentHeadsOf(env.ARTEFACTS, summary.attachments),
    });
    const byName = new Map((risks?.items ?? []).map((item) => [item.filename, item]));
    expect(byName.get("short.7z")?.notChecked).toBe("its compressed header is truncated");
    expect(byName.get("locked.zip")?.findings.map((f) => f.kind)).toContain("encrypted");
  });

  it("says a damaged ZIP, RAR or 7z was not checked, never clean", async () => {
    const zipped = zip([
      { name: "a.pdf", data: pdf },
      { name: "b.pdf", data: pdf },
    ]);
    // The end record counts three entries, the directory holds two.
    const miscounted = zipped.slice();
    miscounted[miscounted.length - 22 + 10] = 3;
    miscounted[miscounted.length - 22 + 8] = 3;
    const cutRar5 = rar5({ encryptedAfter: 5_000 }).subarray(0, 2_000);
    const cutRar4 = rar4().subarray(0, 30);
    const shortSeven = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
    for (const [name, body] of [
      ["m.zip", miscounted],
      ["c.rar", cutRar5],
      ["d.rar", cutRar4],
      ["s.7z", shortSeven],
    ] as const) {
      const got = await one([name, "application/octet-stream", body]);
      expect(got.length, name).toBe(1);
      expect(got[0]?.[1], name).toBe("info");
    }
  });

  it("opens a ZIP inside a ZIP and finds its program, and names one a level deeper, not opened (D02 T04 §8)", async () => {
    const inner = zip([{ name: "run.exe", data: samples.pe }]);
    expect(await one(["outer.zip", "application/zip", zip([{ name: "inner.zip", data: inner }])])).toEqual([
      ["attachment.executable", "critical", "outer.zip > inner.zip > run.exe"],
    ]);
    const deeper = zip([{ name: "level2.zip", data: zip([{ name: "level3.zip", data: inner }]) }]);
    const id = await caseWith([["outer.zip", "application/zip", deeper]]);
    await run(id);
    const [item] = (await readEvidence(env.DB, id)).filter((e) => e.check === "attachment.executable");
    expect(item?.detail).toMatchObject({ checked: false, nested: ["level2.zip > level3.zip"] });
  });

  it("says an attachment whose first bytes could not be read was not checked", async () => {
    const view = {
      attachments: [
        {
          key: "raw/x/attachments/a",
          filename: "a.zip",
          mediaType: "application/zip",
          contentId: null,
          disposition: null,
          bytes: 10,
        },
      ],
      attachmentHeads: { heads: [], unread: 1 },
    } as unknown as Pick<CaseView, "attachments" | "attachmentHeads">;
    expect((await attachmentRisksOf(env.ARTEFACTS, view))?.items[0]?.notChecked).toBe("its contents could not be read");
  });

  it("cites each attachment's key and stores each check once on a replay", async () => {
    const id = await caseWith([
      ["run.exe", "application/octet-stream", samples.pe],
      ["pay.zip", "application/zip", zip([{ name: "invoice.pdf", data: pdf, encrypted: true }])],
      ["report.docx", "application/zip", zip([{ name: "[Content_Types].xml" }, { name: "word/vbaProject.bin" }])],
    ]);
    await run(id);
    await run(id);
    const items = (await readEvidence(env.DB, id)).filter((e) =>
      ["attachment.macro", "attachment.encrypted_archive", "attachment.executable"].includes(e.check),
    );
    expect(items.map((i) => i.check).sort()).toEqual([
      "attachment.encrypted_archive",
      "attachment.executable",
      "attachment.macro",
    ]);
    for (const item of items)
      expect(item.artefacts).toEqual([expect.stringMatching(/^raw\/[0-9A-Z]{26}\/attachments\//)]);
    expect(new Set(items.map((i) => i.artefacts[0])).size).toBe(3);
  });

  it("reads a run of small RAR members from one buffered window", async () => {
    const id = await caseWith([["many.rar", "application/vnd.rar", rar5Many(100, 1_000)]]);
    let gets = 0;
    const counting = {
      get: (key: string, options?: R2GetOptions) => {
        gets++;
        return env.ARTEFACTS.get(key, options);
      },
    } as unknown as R2Bucket;
    const view = await (async () => {
      const read = await readEvidence(env.DB, id);
      void read;
      const stored = await env.ARTEFACTS.list({ prefix: `raw/${id}/attachments/` });
      const key = stored.objects[0]?.key as string;
      const bytes = rar5Many(100, 1_000);
      return {
        attachments: [
          {
            key,
            filename: "many.rar",
            mediaType: "application/vnd.rar",
            contentId: null,
            disposition: null,
            bytes: bytes.length,
          },
        ],
        attachmentHeads: { heads: [{ key, head: btoa(String.fromCharCode(...bytes.subarray(0, 64))) }], unread: 0 },
      } as unknown as Pick<CaseView, "attachments" | "attachmentHeads">;
    })();
    const risks = await attachmentRisksOf(counting, view);
    expect(risks?.items[0]?.findings.map((f) => f.kind)).toEqual(["encrypted"]);
    expect(gets).toBeLessThanOrEqual(3);
  });

  it("says no more than it found: a name is a name, a disk image can carry programs", async () => {
    const id = await caseWith([
      ["budget.xlsm", "application/octet-stream", zip([{ name: "[Content_Types].xml" }, { name: "xl/workbook.xml" }])],
      ["disk.iso", "application/octet-stream", samples.iso],
      ["note.vbs", "text/plain", enc('MsgBox "hi"')],
    ]);
    await run(id);
    const summaries = (await readEvidence(env.DB, id))
      .filter((e) => ["attachment.macro", "attachment.executable"].includes(e.check))
      .map((e) => e.summary);
    expect(summaries).toEqual([
      "budget.xlsm is named as a macro-enabled document (.xlsm).",
      "disk.iso is a disk image, which can carry programs that run when it is opened.",
      "note.vbs is named as a program or script (.vbs).",
    ]);
  });
});

describe("after round 1", () => {
  it("reads a ZIP member's Unicode Path name when its CRC matches, and not otherwise", async () => {
    const legacy = enc("invoice.pdf");
    const good = zip([{ name: "invoice.pdf", data: samples.pe, extra: unicodePath(crc32(legacy), "invoice.pdf.exe") }]);
    expect(await one(["p.zip", "application/zip", good])).toEqual([
      ["attachment.executable", "critical", "p.zip > invoice.pdf.exe"],
    ]);
    const stale = zip([{ name: "invoice.pdf", data: pdf, extra: unicodePath(crc32(legacy) ^ 1, "invoice.pdf.exe") }]);
    expect(await one(["q.zip", "application/zip", stale])).toEqual([]);
  });

  it("keeps another attachment's critical finding when a coverage item names a huge file", async () => {
    const id = await caseWith([
      [`${"a".repeat(70_000)}.zip`, "application/zip", enc("PK\x03\x04 broken")],
      ["run.exe", "application/octet-stream", samples.pe],
    ]);
    await run(id);
    const items = (await readEvidence(env.DB, id)).filter(
      (e) => e.check === "attachment.executable" || e.detail.check === "attachment.executable",
    );
    expect(items.map((i) => i.severity).sort()).toEqual(["critical", "info"]);
    expect(items.some((i) => i.check === "not_checked")).toBe(false);
  });

  it("reads a 7z's main streams after its additional streams", async () => {
    expect(await one(["e.7z", "application/x-7z-compressed", sevenZip(plainHeaderWithAdditional(LZMA, AES))])).toEqual([
      ["attachment.encrypted_archive", "high", "e.7z"],
    ]);
    expect(await one(["f.7z", "application/x-7z-compressed", sevenZip(plainHeaderWithAdditional(LZMA, LZMA))])).toEqual(
      [],
    );
  });

  it("refuses a RAR5 header size RAR does not allow, reading within its budget", async () => {
    const bytes = rar5Oversized(8 * 1024 * 1024);
    const id = await caseWith([["big.rar", "application/vnd.rar", bytes]]);
    const key = (await env.ARTEFACTS.list({ prefix: `raw/${id}/attachments/` })).objects[0]?.key as string;
    let requested = 0;
    const counting = {
      get: async (k: string, options?: R2GetOptions) => {
        const object = await env.ARTEFACTS.get(k, options);
        requested +=
          object?.size !== undefined && options?.range && "length" in options.range ? (options.range.length ?? 0) : 0;
        return object;
      },
    } as unknown as R2Bucket;
    const view = {
      attachments: [
        {
          key,
          filename: "big.rar",
          mediaType: "application/vnd.rar",
          contentId: null,
          disposition: null,
          bytes: bytes.length,
        },
      ],
      attachmentHeads: { heads: [{ key, head: btoa(String.fromCharCode(...bytes.subarray(0, 64))) }], unread: 0 },
    } as unknown as Pick<CaseView, "attachments" | "attachmentHeads">;
    const risks = await attachmentRisksOf(counting, view);
    expect(risks?.items[0]?.notChecked).toBe("a header claims a size RAR does not allow");
    expect(requested).toBeLessThanOrEqual(MAX_RAR_BYTES);
  });
});

describe("after round 2", () => {
  it("checks a member's name CRC once, however many Unicode Path fields repeat", async () => {
    const name = "n".repeat(60_000);
    const fields = Array.from({ length: 7_000 }, () => unicodePath(1, "x.exe"));
    const extra = new Uint8Array(fields.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of fields) {
      extra.set(f, at);
      at += f.length;
    }
    const started = Date.now();
    expect(
      await one(["w.zip", "application/zip", zip([{ name, data: pdf, extra: extra.subarray(0, 65_000) }])]),
    ).toEqual([]);
    // Once per member this is a fraction of a second; once per field it took 1.5 s here.
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("after round 3", () => {
  it("says a 7z header whose property runs past its end was not checked", async () => {
    const got = await one([
      "invoice.7z",
      "application/x-7z-compressed",
      sevenZip(new Uint8Array([0x01, 0x02, 0x01, 0x7f])),
    ]);
    expect(got).toEqual([["attachment.executable", "info", "its header is truncated"]]);
    expect(await one(["odd.7z", "application/x-7z-compressed", sevenZip(new Uint8Array([0x01, 0x09]))])).toEqual([
      ["attachment.executable", "info", "its header is malformed"],
    ]);
  });
});

describe("OpenDocument (D02 T04 §5)", () => {
  const MANIFEST =
    '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/></manifest:manifest>';
  const ENCRYPTED = MANIFEST.replace(
    "</manifest:manifest>",
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"><manifest:encryption-data manifest:checksum-type="SHA1/1K" manifest:checksum="x"/></manifest:file-entry></manifest:manifest>',
  );
  const odt = (names: string[], manifest: string | null = MANIFEST) =>
    zip([
      { name: "mimetype", data: new TextEncoder().encode("application/vnd.oasis.opendocument.text") },
      ...(manifest === null ? [] : [{ name: "META-INF/manifest.xml", data: new TextEncoder().encode(manifest) }]),
      ...names.map((name) => ({ name })),
    ]);
  // The same package with its manifest deflated: the data replaced by its raw DEFLATE form, method 8 in both headers.
  const deflated = async (manifest: string) => {
    const packed = new Uint8Array(
      await new Response(
        new Blob([new TextEncoder().encode(manifest)]).stream().pipeThrough(new CompressionStream("deflate-raw")),
      ).arrayBuffer(),
    );
    const bytes = zip([
      { name: "mimetype", data: new TextEncoder().encode("application/vnd.oasis.opendocument.text") },
      { name: "META-INF/manifest.xml", data: packed },
      { name: "content.xml" },
    ]);
    const name = new TextEncoder().encode("META-INF/manifest.xml");
    for (let i = 0; i + 4 <= bytes.length; i++) {
      const sig = bytes[i] === 0x50 && bytes[i + 1] === 0x4b;
      if (
        sig &&
        bytes[i + 2] === 0x03 &&
        bytes[i + 3] === 0x04 &&
        bytes.subarray(i + 30, i + 30 + name.length).every((b, k) => b === name[k])
      )
        bytes[i + 8] = 8;
      if (
        sig &&
        bytes[i + 2] === 0x01 &&
        bytes[i + 3] === 0x02 &&
        bytes.subarray(i + 46, i + 46 + name.length).every((b, k) => b === name[k])
      )
        bytes[i + 10] = 8;
    }
    return bytes;
  };
  it("opens an OpenDocument file, finding a Basic macro module and a program inside, and nothing in a plain one", async () => {
    const withMacro = odt([
      "content.xml",
      "Basic/script-lc.xml",
      "Basic/Standard/script-lb.xml",
      "Basic/Standard/Module1.xml",
    ]);
    expect(await one(["minutes.odt", "application/vnd.oasis.opendocument.text", withMacro])).toEqual([
      ["attachment.macro", "high", "minutes.odt > Basic/Standard/Module1.xml"],
    ]);
    expect(await one(["m.odt", "application/vnd.oasis.opendocument.text", odt(["content.xml", "run.exe"])])).toEqual([
      ["attachment.executable", "critical", "m.odt > run.exe"],
    ]);
    expect(
      await one(["plain.odt", "application/vnd.oasis.opendocument.text", odt(["content.xml", "Basic/script-lc.xml"])]),
    ).toEqual([]);
    // A directory cut short: not checked, never clean.
    const cut = odt(["content.xml"]).slice();
    cut[cut.length - 22 + 10] = 5;
    cut[cut.length - 22 + 8] = 5;
    const got = await one(["cut.odt", "application/vnd.oasis.opendocument.text", cut]);
    expect(got.map(([check, severity]) => [check, severity])).toEqual([["attachment.executable", "info"]]);
  });

  it("names a script macro, a password-protected document stored or deflated, and a package without a manifest (completion review)", async () => {
    expect(
      await one(["py.odt", "application/vnd.oasis.opendocument.text", odt(["content.xml", "Scripts/python/hello.py"])]),
    ).toEqual([["attachment.macro", "high", "py.odt > Scripts/python/hello.py"]]);
    expect(
      await one(["locked.odt", "application/vnd.oasis.opendocument.text", odt(["content.xml"], ENCRYPTED)]),
    ).toEqual([["attachment.encrypted_archive", "high", "locked.odt"]]);
    expect(await one(["locked2.odt", "application/vnd.oasis.opendocument.text", await deflated(ENCRYPTED)])).toEqual([
      ["attachment.encrypted_archive", "high", "locked2.odt"],
    ]);
    expect(await one(["open.odt", "application/vnd.oasis.opendocument.text", await deflated(MANIFEST)])).toEqual([]);
    const bare = await one(["bare.odt", "application/vnd.oasis.opendocument.text", odt(["content.xml"], null)]);
    expect(bare.map(([check, severity]) => [check, severity])).toEqual([["attachment.executable", "info"]]);
  });

  it("reads the manifest as XML: any prefix, the default namespace, UTF-16, comments ignored, and a package without a mimetype (round 1)", async () => {
    const ns = 'xmlns:m="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"';
    const prefixed = `<m:manifest ${ns}><m:file-entry m:full-path="content.xml"><m:encryption-data m:checksum="x"/></m:file-entry></m:manifest>`;
    const byDefault =
      '<manifest xmlns="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><file-entry full-path="content.xml"><encryption-data checksum="x"/></file-entry></manifest>';
    const commented = MANIFEST.replace(
      "</manifest:manifest>",
      "<!-- <manifest:encryption-data/> --></manifest:manifest>",
    );
    const utf16 = (text: string) => {
      const out = new Uint8Array(2 + text.length * 2);
      out.set([0xff, 0xfe]);
      for (let i = 0; i < text.length; i++) out[2 + 2 * i] = text.charCodeAt(i);
      return out;
    };
    const pkg = (manifest: Uint8Array, withMimetype = true) =>
      zip([
        ...(withMimetype
          ? [{ name: "mimetype", data: new TextEncoder().encode("application/vnd.oasis.opendocument.text") }]
          : []),
        { name: "META-INF/manifest.xml", data: manifest },
        { name: "content.xml" },
      ]);
    const enc = (t: string) => new TextEncoder().encode(t);
    for (const [name, bytes] of [
      ["prefixed.odt", pkg(enc(prefixed))],
      ["default.odt", pkg(enc(byDefault))],
      ["wide.odt", pkg(utf16(ENCRYPTED))],
      ["nomime.odt", pkg(enc(ENCRYPTED), false)],
    ] as const)
      expect(await one([name, "application/vnd.oasis.opendocument.text", bytes]), name).toEqual([
        ["attachment.encrypted_archive", "high", name],
      ]);
    expect(await one(["commented.odt", "application/vnd.oasis.opendocument.text", pkg(enc(commented))])).toEqual([]);
  });

  it("finds the element however its namespace is spelled or prefixed, in linear time (round 2)", () => {
    const enc = (t: string) => new TextEncoder().encode(t);
    const referenced = ENCRYPTED.replace("urn:oasis", "urn:&#111;asis");
    const unicode =
      '<é:manifest xmlns:é="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><é:file-entry é:full-path="c.xml"><é:encryption-data/></é:file-entry></é:manifest>';
    expect(manifestEncrypted(enc(referenced))).toBe(true);
    expect(manifestEncrypted(enc(unicode))).toBe(true);
    expect(manifestEncrypted(enc(MANIFEST))).toBe(false);
    expect(manifestEncrypted(enc(`${"<".repeat(30_000)}${"a".repeat(30_000)}`))).toBe(false);
  });
});

// D02 T04 §8: members read by their content, a ZIP inside a ZIP opened, within bounds measured, not assumed.
describe("archive members read by content", () => {
  const b64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  // Every byte DecompressionStream gives, counted, so the bounds are read off what was inflated.
  let inflated = 0;
  let streams = 0;
  const Real = (globalThis as unknown as { DecompressionStream: typeof DecompressionStream }).DecompressionStream;
  const counting = () =>
    vi.stubGlobal(
      "DecompressionStream",
      class {
        readonly writable: WritableStream;
        readonly readable: ReadableStream;
        constructor(format: "deflate-raw") {
          const real = new Real(format);
          streams++;
          this.writable = real.writable;
          this.readable = real.readable.pipeThrough(
            new TransformStream({
              transform(chunk: Uint8Array, controller) {
                inflated += chunk.byteLength;
                controller.enqueue(chunk);
              },
            }),
          );
        }
      },
    );
  afterEach(() => {
    vi.unstubAllGlobals();
    inflated = 0;
    streams = 0;
  });

  it("finds a renamed program among PDFs, deflated and stored, and nothing in a ZIP of PDFs", async () => {
    counting();
    expect(await one(["renamed.zip", "application/zip", b64(zips.renamedProgramZip)])).toEqual([
      ["attachment.executable", "critical", "renamed.zip > statement.pdf"],
    ]);
    // Two deflated members, each stopped once SNIFF_BYTES are out (a chunk past it at most).
    expect(inflated).toBeLessThanOrEqual(2 * (SNIFF_BYTES + 65_536));
    expect(await one(["stored.zip", "application/zip", b64(zips.renamedProgramStoredZip)])).toEqual([
      ["attachment.executable", "critical", "stored.zip > statement.pdf"],
    ]);
    expect(await one(["pdfs.zip", "application/zip", b64(zips.pdfsZip)])).toEqual([]);
  });

  it("finds a program inside a deflated ZIP inside a ZIP, and names a third level, not opened", async () => {
    expect(await one(["outer.zip", "application/zip", b64(zips.nestedProgramZip)])).toEqual([
      ["attachment.executable", "critical", "outer.zip > inner.zip > payment.pdf"],
    ]);
    const id = await caseWith([["deep.zip", "application/zip", b64(zips.thirdLevelZip)]]);
    await run(id);
    const [item] = (await readEvidence(env.DB, id)).filter((e) => e.check === "attachment.executable");
    expect(item?.detail).toMatchObject({ checked: false, nested: ["level2.zip > level3.zip"] });
  });

  it("stops a nested ZIP whose real size passes MAX_NESTED_BYTES though its header says less, and names it", async () => {
    counting();
    const id = await caseWith([["big.zip", "application/zip", b64(zips.understatedNestedZip)]]);
    await run(id);
    const [item] = (await readEvidence(env.DB, id)).filter((e) => e.check === "attachment.executable");
    expect(item?.detail).toMatchObject({ checked: false, nested: ["inner.zip"] });
    // The 9 MiB stream was stopped at the bound, never inflated whole.
    expect(inflated).toBeLessThanOrEqual(MAX_NESTED_BYTES + 2 * 65_536);
  });

  it("keeps one expansion budget across both levels, naming the nested ZIP past it", async () => {
    counting();
    const id = await caseWith([["three.zip", "application/zip", b64(zips.budgetAcrossLevelsZip)]]);
    await run(id);
    const [item] = (await readEvidence(env.DB, id)).filter((e) => e.check === "attachment.executable");
    expect(item?.detail).toMatchObject({ checked: false });
    expect(((item?.detail.nested as string[] | undefined) ?? []).length).toBeGreaterThan(0);
    expect(inflated).toBeLessThanOrEqual(MAX_EXPANDED_BYTES + 2 * 65_536);
  });

  it("reads past a damaged member to the program after it, counting the member not read", async () => {
    const id = await caseWith([["damaged.zip", "application/zip", b64(zips.damagedThenProgramZip)]]);
    await run(id);
    expect(await risky(id)).toEqual([["attachment.executable", "critical", "damaged.zip > statement.pdf"]]);
  });

  const deflate = async (bytes: Uint8Array) =>
    new Uint8Array(
      await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer(),
    );
  // Bytes that do not compress: each a step of a fixed linear congruential sequence, the same every run.
  const noise = (n: number) => {
    const out = new Uint8Array(n);
    let x = 12345;
    for (let i = 0; i < n; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      out[i] = x >>> 24;
    }
    return out;
  };
  const risksOf = async (bucket: R2Bucket, name: string, body: Uint8Array) => {
    const id = await caseWith([[name, "application/zip", body]]);
    const sum = await readArtefact(store, id, parsedKey(id));
    if (!sum || !("body" in sum)) throw new Error("no summary");
    const { attachments } = JSON.parse(new TextDecoder().decode(sum.body)) as { attachments: CaseView["attachments"] };
    const heads = await attachmentHeadsOf(env.ARTEFACTS, attachments);
    return attachmentRisksOf(bucket, { attachments, attachmentHeads: heads });
  };
  // R2, counting the bytes each read gives back.
  const counted = () => {
    const seen = { bytes: 0 };
    const bucket = new Proxy(env.ARTEFACTS, {
      get: (target, name) =>
        name === "get"
          ? async (key: string, options?: R2GetOptions) => {
              const object = await target.get(key, options);
              if (!object) return object;
              const body = new Uint8Array(await object.arrayBuffer());
              seen.bytes += body.length;
              return {
                ...object,
                arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
              };
            }
          : Reflect.get(target, name).bind(target),
    });
    return { bucket: bucket as unknown as R2Bucket, seen };
  };

  it("asks R2 for a member's first bytes only: SNIFF_BYTES stored, MAX_MEMBER_PACKED_BYTES deflated (completion review)", async () => {
    const big = noise(3 * 1024 * 1024);
    const stored = counted();
    const a = await risksOf(stored.bucket, "stored.zip", zip([{ name: "big.pdf", data: big }]));
    expect(a?.items[0]?.membersNotRead ?? 0).toBe(0);
    // The directory's tail (at most 64 KiB and the end record), one local header, SNIFF_BYTES of data.
    expect(stored.seen.bytes).toBeLessThanOrEqual(65_557 + 30 + 64 + SNIFF_BYTES + 200);
    const packed = await deflate(big);
    expect(packed.length).toBeGreaterThan(MAX_MEMBER_PACKED_BYTES);
    const deflated = counted();
    const b = await risksOf(
      deflated.bucket,
      "deflated.zip",
      zip([{ name: "big.pdf", data: packed, method: 8, size: big.length }]),
    );
    expect(b?.items[0]?.membersNotRead ?? 0).toBe(0);
    expect(deflated.seen.bytes).toBeLessThanOrEqual(65_557 + 30 + 64 + MAX_MEMBER_PACKED_BYTES + 200);
  });

  it("counts the inflation budget exactly: met still reads, one byte past it does not (completion review)", async () => {
    const bytes = noise(1000);
    const packed = await deflate(bytes);
    const met = { members: 0, expanded: MAX_EXPANDED_BYTES - 1000 };
    expect(await inflate(packed, 2000, met, false)).toEqual(bytes);
    expect(met.expanded).toBe(MAX_EXPANDED_BYTES);
    expect(await inflate(packed, 2000, { members: 0, expanded: MAX_EXPANDED_BYTES - 999 }, false)).toBe("budget");
  });

  it("names a member called .zip whose bytes are not a ZIP from their first byte, instead of passing it silently (round 2)", async () => {
    // A ZIP with text in front of it: a ZIP reader extracts it, the signature sniff does not see it.
    const hidden = zip([{ name: "payment.pdf", data: samples.pe }]);
    const prefixed = new Uint8Array([...new TextEncoder().encode("Invoice attached.\r\n"), ...hidden]);
    const outer = zip([{ name: "invoice.zip", data: prefixed }]);
    const got = await risksOf(env.ARTEFACTS, "outer.zip", outer);
    expect(got?.items[0]?.nested).toEqual(["invoice.zip"]);
    // Text named .zip is named too, and an honest nested ZIP is still opened, not named.
    const text = zip([{ name: "notes.zip", data: new TextEncoder().encode("not an archive") }]);
    expect((await risksOf(env.ARTEFACTS, "text.zip", text))?.items[0]?.nested).toEqual(["notes.zip"]);
    const honest = zip([{ name: "inner.zip", data: hidden }]);
    const opened = await risksOf(env.ARTEFACTS, "honest.zip", honest);
    expect(opened?.items[0]?.nested).toEqual([]);
    expect(opened?.items[0]?.findings.map((f) => f.where)).toContain("honest.zip > inner.zip > payment.pdf");
  });

  it("opens a nested ZIP of exactly MAX_NESTED_BYTES, and names one a byte longer (completion review)", async () => {
    const sized = (total: number) => {
      const head = zip([
        { name: "run.pdf", data: samples.pe },
        { name: "pad.bin", data: new Uint8Array(0) },
      ]);
      const inner = zip([
        { name: "run.pdf", data: samples.pe },
        { name: "pad.bin", data: new Uint8Array(total - head.length) },
      ]);
      expect(inner.length).toBe(total);
      return zip([{ name: "inner.zip", data: inner }]);
    };
    const met = await risksOf(env.ARTEFACTS, "met.zip", sized(MAX_NESTED_BYTES));
    expect(met?.items[0]?.findings.map((f) => f.where)).toContain("met.zip > inner.zip > run.pdf");
    expect(met?.items[0]?.nested).toEqual([]);
    const past = await risksOf(env.ARTEFACTS, "past.zip", sized(MAX_NESTED_BYTES + 1));
    expect(past?.items[0]?.nested).toEqual(["inner.zip"]);
  });

  it("inflates nothing more once the budget is spent, counting every member after it (completion review)", async () => {
    const six = await deflate(new Uint8Array(6 * 1024 * 1024));
    const small = await deflate(samples.pdf);
    const body = zip([
      ...["a.pdf", "b.pdf", "c.pdf"].map((name) => ({ name, data: six, method: 8, size: 6 * 1024 * 1024 })),
      ...Array.from({ length: 10 }, (_, i) => ({
        name: `doc-${i}.pdf`,
        data: small,
        method: 8,
        size: samples.pdf.length,
      })),
    ]);
    const risks = await risksOf(env.ARTEFACTS, "spent.zip", body);
    // Three 6 MiB members are read for SNIFF_BYTES each, far under the budget: they are all read.
    expect(risks?.items[0]?.membersNotRead ?? 0).toBe(0);
    // Three nested 6 MiB ZIPs are inflated whole: the third passes the budget, and the ten after it inflate nothing.
    const inner6 = zip([{ name: "zeros.pdf", data: new Uint8Array(6 * 1024 * 1024) }]);
    const zips6 = await deflate(inner6);
    const zip6Size = inner6.length;
    // Each member after them 1 MiB of zeros, so a member inflated past the spent budget shows in the count.
    const mib = await deflate(new Uint8Array(1024 * 1024));
    counting();
    const nestedBody = zip([
      ...["a.zip", "b.zip", "c.zip"].map((name) => ({ name, data: zips6, method: 8, size: zip6Size })),
      ...Array.from({ length: 10 }, (_, i) => ({
        name: `doc-${i}.pdf`,
        data: mib,
        method: 8,
        size: 1024 * 1024,
      })),
    ]);
    const spent = await risksOf(env.ARTEFACTS, "spent-nested.zip", nestedBody);
    expect(spent?.items[0]?.membersNotRead).toBeGreaterThanOrEqual(10);
    expect(inflated).toBeLessThanOrEqual(MAX_EXPANDED_BYTES + 65_536);
    // Six decompressors (each nested ZIP sniffed, then inflated whole), none for the ten members after the budget.
    expect(streams).toBe(6);
  });

  it("opens an Office file inside a ZIP and names a RAR or 7z known only by its bytes (completion review)", async () => {
    const docx = zip([
      { name: "[Content_Types].xml", data: new TextEncoder().encode("<Types/>") },
      { name: "word/document.xml", data: new TextEncoder().encode("<w:document/>") },
      { name: "word/payment.pdf", data: samples.pe },
    ]);
    const office = await risksOf(env.ARTEFACTS, "outer.zip", zip([{ name: "report.docx", data: docx }]));
    expect(office?.items[0]?.findings.map((f) => f.where)).toContain("outer.zip > report.docx > word/payment.pdf");
    const rar = await risksOf(env.ARTEFACTS, "rar.zip", zip([{ name: "invoice.pdf", data: samples.rar }]));
    expect(rar?.items[0]?.nested).toEqual(["invoice.pdf"]);
  });

  it("counts a deflated member whose capped prefix gives less than SNIFF_BYTES as not read (round 1)", async () => {
    // Raw DEFLATE (RFC 1951) of stored blocks: "M", then empty blocks past MAX_MEMBER_PACKED_BYTES, then the rest of a
    // program. An extractor gives the whole program; the prefix gives only "M".
    const stored = (data: Uint8Array, final: boolean) =>
      Uint8Array.of(
        final ? 1 : 0,
        data.length & 0xff,
        data.length >> 8,
        ~data.length & 0xff,
        (~data.length >> 8) & 0xff,
        ...data,
      );
    const empty = stored(new Uint8Array(0), false);
    const blocks = Math.ceil(MAX_MEMBER_PACKED_BYTES / empty.length) + 1;
    const head = stored(samples.pe.subarray(0, 1), false);
    const tail = stored(samples.pe.subarray(1), true);
    const packed = new Uint8Array(head.length + blocks * empty.length + tail.length);
    packed.set(head, 0);
    for (let i = 0; i < blocks; i++) packed.set(empty, head.length + i * empty.length);
    packed.set(tail, head.length + blocks * empty.length);
    expect(
      await inflate(packed.subarray(0, MAX_MEMBER_PACKED_BYTES), SNIFF_BYTES, { members: 0, expanded: 0 }, true),
    ).toBe("short");
    const risks = await risksOf(
      env.ARTEFACTS,
      "padded.zip",
      zip([{ name: "invoice.pdf", data: packed, method: 8, size: samples.pe.length }]),
    );
    expect(risks?.items[0]?.membersNotRead).toBe(1);
  });

  it("reads a nested OpenDocument package's manifest: a protected one inside a ZIP is said to be one (round 1)", async () => {
    const manifest = (encrypted: boolean) =>
      new TextEncoder().encode(
        `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml">${encrypted ? '<manifest:encryption-data manifest:checksum="x"/>' : ""}</manifest:file-entry></manifest:manifest>`,
      );
    const odt = (encrypted: boolean) =>
      zip([
        { name: "mimetype", data: new TextEncoder().encode("application/vnd.oasis.opendocument.text") },
        { name: "META-INF/manifest.xml", data: manifest(encrypted) },
        { name: "content.xml", data: new TextEncoder().encode("<office:document-content/>") },
      ]);
    const locked = await risksOf(env.ARTEFACTS, "outer.zip", zip([{ name: "letter.odt", data: odt(true) }]));
    expect(locked?.items[0]?.findings.map((f) => [f.kind, f.where])).toContainEqual([
      "encrypted",
      "outer.zip > letter.odt",
    ]);
    const plain = await risksOf(env.ARTEFACTS, "outer.zip", zip([{ name: "letter.odt", data: odt(false) }]));
    expect(plain?.items[0]?.findings).toEqual([]);
    expect(plain?.items[0]?.membersNotRead ?? 0).toBe(0);
  });

  it("reads MAX_MEMBERS_READ members exactly, and counts one past it as not read", async () => {
    const many = (n: number) => zip(Array.from({ length: n }, (_, i) => ({ name: `doc-${i}.pdf`, data: pdf })));
    const read = async (body: Uint8Array) => {
      const id = await caseWith([["many.zip", "application/zip", body]]);
      const sum = await readArtefact(store, id, parsedKey(id));
      if (!sum || !("body" in sum)) throw new Error("no summary");
      const { attachments } = JSON.parse(new TextDecoder().decode(sum.body)) as {
        attachments: CaseView["attachments"];
      };
      const risks = await attachmentRisksOf(env.ARTEFACTS, {
        attachments,
        attachmentHeads: await attachmentHeadsOf(env.ARTEFACTS, attachments),
      });
      return risks?.items[0]?.membersNotRead ?? 0;
    };
    expect(await read(many(MAX_MEMBERS_READ))).toBe(0);
    expect(await read(many(MAX_MEMBERS_READ + 1))).toBe(1);
  });

  it("counts a member whose local header R2 gives back short as not read, and lets an R2 failure throw", async () => {
    const id = await caseWith([["renamed.zip", "application/zip", b64(zips.renamedProgramZip)]]);
    const sum = await readArtefact(store, id, parsedKey(id));
    if (!sum || !("body" in sum)) throw new Error("no summary");
    const { attachments } = JSON.parse(new TextDecoder().decode(sum.body)) as { attachments: CaseView["attachments"] };
    const heads = await attachmentHeadsOf(env.ARTEFACTS, attachments);
    // Every 30-byte read (a member's local header) answered with 10 bytes.
    const short = new Proxy(env.ARTEFACTS, {
      get: (target, name) =>
        name === "get"
          ? async (key: string, options?: R2GetOptions) => {
              const object = await target.get(key, options);
              const range = options?.range as { length?: number } | undefined;
              if (!object || range?.length !== 30) return object;
              const body = new Uint8Array(await object.arrayBuffer()).subarray(0, 10);
              return { ...object, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + 10) };
            }
          : Reflect.get(target, name).bind(target),
    });
    const risks = await attachmentRisksOf(short as unknown as R2Bucket, { attachments, attachmentHeads: heads });
    expect(risks?.items[0]?.membersNotRead).toBe(2);
    // R2 itself failing on a member read: thrown, so the step retries, never a clean or partial answer.
    const failing = new Proxy(env.ARTEFACTS, {
      get: (target, name) =>
        name === "get"
          ? async (key: string, options?: R2GetOptions) => {
              const range = options?.range as { length?: number } | undefined;
              if (range?.length === 30) throw new Error("R2 unavailable");
              return target.get(key, options);
            }
          : Reflect.get(target, name).bind(target),
    });
    await expect(
      attachmentRisksOf(failing as unknown as R2Bucket, { attachments, attachmentHeads: heads }),
    ).rejects.toThrow("R2 unavailable");
  });
});

// D02 T04 §9: an RTF document's embedded objects, read without opening or running them. The fixtures are read back by
// oletools before they are kept (scripts/fixtures/make-rtf.ts).
describe("RTF embedded objects", () => {
  const b64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  const doc = (name: string, text: string): File => [name, "application/rtf", b64(text)];
  const risks = async (name: string, body: Uint8Array) => {
    const id = await caseWith([[name, "application/rtf", body]]);
    const sum = await readArtefact(store, id, parsedKey(id));
    if (!sum || !("body" in sum)) throw new Error("no summary");
    const { attachments } = JSON.parse(new TextDecoder().decode(sum.body)) as { attachments: CaseView["attachments"] };
    const read = await attachmentRisksOf(env.ARTEFACTS, {
      attachments,
      attachmentHeads: await attachmentHeadsOf(env.ARTEFACTS, attachments),
    });
    return read?.items[0];
  };
  // OLE 1.0 bytes built here for the bounds, the same layout the fixtures' oletools-checked script writes.
  const enc = (t: string) => new TextEncoder().encode(t);
  const u32 = (v: number) => Uint8Array.of(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const cat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  const prefixed = (t: string) => (t ? cat(u32(t.length + 1), enc(t), Uint8Array.of(0)) : u32(0));
  const packagedProgram = (total: number) => {
    // An embedded Package whose whole object is `total` bytes, its packaged file a program padded to fit.
    const pre = (dataLength: number) => {
      const native = cat(
        Uint8Array.of(2, 0),
        enc("a.pdf"),
        Uint8Array.of(0),
        Uint8Array.of(0),
        u32(0),
        u32(0),
        Uint8Array.of(0),
        u32(dataLength),
      );
      return cat(u32(0x0501), u32(2), prefixed("Package"), u32(0), u32(0), u32(native.length + dataLength), native);
    };
    const dataLength = total - pre(0).length;
    const data = new Uint8Array(dataLength);
    data.set(samples.pe.subarray(0, Math.min(samples.pe.length, dataLength)));
    const object = cat(pre(dataLength), data);
    expect(object.length).toBe(total);
    return object;
  };
  const binDoc = (objects: Uint8Array[]) =>
    cat(
      enc("{\\rtf1\\ansi "),
      ...objects.map((o) => cat(enc(`{\\object\\objemb{\\*\\objdata \\bin${o.length} `), o, enc("}}"))),
      enc("}"),
    );

  it("finds a packaged program by its name and by its bytes, in hex, in \\bin and mixed", async () => {
    expect(await one(doc("letter.rtf", rtfs.programByNameRtf))).toEqual([
      ["attachment.executable", "critical", "letter.rtf > object 1 (setup.exe)"],
    ]);
    for (const text of [rtfs.programByBytesRtf, rtfs.programInBinRtf, rtfs.programMixedRtf])
      expect(await one(doc("letter.rtf", text))).toEqual([
        ["attachment.executable", "critical", "letter.rtf > object 1 (invoice.pdf)"],
      ]);
    expect(await one(doc("plain.rtf", rtfs.plainRtf))).toEqual([]);
  });

  it("finds a VBA project in a packaged document and in an embedded Word document", async () => {
    expect(await one(doc("letter.rtf", rtfs.macroPackageRtf))).toEqual([
      ["attachment.macro", "high", "letter.rtf > object 1 (invoice.doc)"],
    ]);
    expect(await one(doc("letter.rtf", rtfs.macroDocumentRtf))).toEqual([
      ["attachment.macro", "high", "letter.rtf > object 1"],
    ]);
  });

  it("reads on past a damaged object, before or after a program, and counts it not read", async () => {
    for (const text of [rtfs.damagedThenProgramRtf, rtfs.programThenDamagedRtf]) {
      const item = await risks("letter.rtf", b64(text));
      expect(item?.findings.map((f) => f.kind)).toEqual(["executable"]);
      expect(item?.objectsNotRead).toBe(1);
    }
    expect((await risks("letter.rtf", b64(rtfs.truncatedRtf)))?.objectsNotRead).toBe(1);
    expect((await risks("letter.rtf", b64(rtfs.linkedRtf)))?.objectsNotRead).toBe(1);
  });

  it("reads MAX_RTF_OBJECTS objects and counts the one after them", async () => {
    const program = packagedProgram(5000);
    const full = rtfObjects(binDoc(Array.from({ length: MAX_RTF_OBJECTS }, () => program)));
    expect([full.objects.length, full.more]).toEqual([MAX_RTF_OBJECTS, 0]);
    const past = await risks("many.rtf", binDoc(Array.from({ length: MAX_RTF_OBJECTS + 1 }, () => program)));
    expect(past?.objectsNotRead).toBe(1);
  });

  it("decodes an object of exactly MAX_OBJECT_BYTES, and stops one byte over at the bound", async () => {
    const met = await risks("met.rtf", binDoc([packagedProgram(MAX_OBJECT_BYTES)]));
    expect(met?.findings.map((f) => f.where)).toEqual(["met.rtf > object 1 (a.pdf)"]);
    const over = rtfObjects(binDoc([packagedProgram(MAX_OBJECT_BYTES + 1)]));
    expect(over.objects).toEqual([{ unread: "too large" }]);
    const past = await risks("over.rtf", binDoc([packagedProgram(MAX_OBJECT_BYTES + 1)]));
    expect([past?.findings, past?.objectsNotRead]).toEqual([[], 1]);
  });

  it("reads a NUL-padded Package class, and hex broken by a vertical tab or form feed (completion review)", async () => {
    expect(await one(doc("letter.rtf", rtfs.paddedClassRtf))).toEqual([
      ["attachment.executable", "critical", "letter.rtf > object 1 (setup.exe)"],
    ]);
    for (const text of [rtfs.verticalTabRtf, rtfs.formFeedRtf])
      expect(await one(doc("letter.rtf", text))).toEqual([
        ["attachment.executable", "critical", "letter.rtf > object 1 (invoice.pdf)"],
      ]);
  });

  it("counts a cabinet as not read: packaged in an RTF, inside a ZIP and attached (completion review)", async () => {
    const cabinet = Uint8Array.of(0x4d, 0x53, 0x43, 0x46, 0, 0, 0, 0, ...new Uint8Array(200).fill(0x20));
    expect(sniff(cabinet)).toBe("cab");
    expect((await risks("letter.rtf", b64(rtfs.packagedCabRtf)))?.objectsNotRead).toBe(1);
    const zipped = await risks("outer.zip", zip([{ name: "invoice.pdf", data: cabinet }]));
    expect(zipped?.nested).toEqual(["invoice.pdf"]);
    const attached = await risks("invoice.pdf", cabinet);
    expect(attached?.membersUnread).toBe(true);
  });

  it("checks a package's temporary path, reads an RTF packaged in an RTF, skips a nested group's text (round 1)", async () => {
    expect(new TextDecoder().decode(b64(rtfs.commentInObjdataRtf))).toContain("{\\*\\comment ignored}");
    expect(await one(doc("letter.rtf", rtfs.tempPathProgramRtf))).toEqual([
      ["attachment.executable", "critical", "letter.rtf > object 1 (invoice.txt)"],
    ]);
    expect(await one(doc("letter.rtf", rtfs.nestedRtfRtf))).toEqual([
      ["attachment.executable", "critical", "letter.rtf > object 1 (invoice.rtf) > object 1 (setup.exe)"],
    ]);
    expect(await one(doc("letter.rtf", rtfs.commentInObjdataRtf))).toEqual([
      ["attachment.executable", "critical", "letter.rtf > object 1 (setup.exe)"],
    ]);
  });

  it("reads an RTF inside a ZIP, and counts one a level deeper than is read (round 2)", async () => {
    const letter = b64(rtfs.programByNameRtf);
    expect(await one(["outer.zip", "application/zip", zip([{ name: "invoice.rtf", data: letter }])])).toEqual([
      ["attachment.executable", "critical", "outer.zip > invoice.rtf > object 1 (setup.exe)"],
    ]);
    // An RTF holding a packaged ZIP holding that RTF: the third level is counted, never taken as read.
    const native = (name: string, data: Uint8Array) =>
      cat(
        Uint8Array.of(2, 0),
        enc(name),
        Uint8Array.of(0),
        Uint8Array.of(0),
        u32(0),
        u32(0),
        Uint8Array.of(0),
        u32(data.length),
        data,
      );
    const object = (name: string, data: Uint8Array) => {
      const n = native(name, data);
      return cat(u32(0x0501), u32(2), prefixed("Package"), u32(0), u32(0), u32(n.length), n);
    };
    const wrapped = binDoc([object("invoice.zip", zip([{ name: "invoice.rtf", data: letter }]))]);
    const item = await risks("letter.rtf", wrapped);
    expect(item?.findings).toEqual([]);
    expect(item?.membersNotRead).toBe(1);
  });

  it("counts a document past MAX_RTF_BYTES as not read, never as holding nothing", async () => {
    const big = cat(enc("{\\rtf1\\ansi "), new Uint8Array(MAX_RTF_BYTES).fill(0x41), enc("}"));
    const item = await risks("big.rtf", big);
    expect([item?.findings, item?.objectsNotRead]).toEqual([[], 1]);
  });
});
