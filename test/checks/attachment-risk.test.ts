import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { makeDecoyCompoundFile, renameEntry } from "../../scripts/fixtures/msg-builder";
import {
  attachmentRisksOf,
  crc32,
  MAX_OLE_BYTES,
  MAX_RAR_BYTES,
  MAX_RISK_ATTACHMENTS,
  manifestEncrypted,
} from "../../src/checks/attachment-risk";
import type { CaseView } from "../../src/checks/case-view";
import { readEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { parsedKey, putAttachment, putParsed, putRaw, type Store } from "../../src/intake/store";
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
    // A filename holding the AES coder's bytes is no coder (completion review).
    expect(await one(["e.7z", "application/x-7z-compressed", sevenZip(plainHeader(LZMA, AES_IN_NAME))])).toEqual([]);
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

  it("names an archive inside an archive, which is not opened", async () => {
    const inner = zip([{ name: "run.exe", data: samples.pe }]);
    expect(await one(["outer.zip", "application/zip", zip([{ name: "inner.zip", data: inner }])])).toEqual([
      ["attachment.executable", "info", undefined],
    ]);
    const id = await caseWith([["outer.zip", "application/zip", zip([{ name: "inner.zip", data: inner }])]]);
    await run(id);
    const [item] = (await readEvidence(env.DB, id)).filter((e) => e.check === "attachment.executable");
    expect(item?.detail).toMatchObject({ checked: false, nested: ["inner.zip"] });
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
