import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { typeMismatchEvidence } from "../../src/checks/attachment-type";
import type { CaseView } from "../../src/checks/case-view";
import { readEvidence } from "../../src/checks/evidence";
import { attachmentHeadsOf, MAX_SNIFFED, SNIFF_BYTES, sniff } from "../../src/checks/sniff";
import { createCase } from "../../src/db/cases";
import { parsedKey, putAttachment, putParsed, putRaw, type Store } from "../../src/intake/store";
import { checks } from "../../src/pipeline/analysis-workflow";
import { samples, scripts } from "../fixtures/attachments/samples";

// D02 T04 §1: attachments read by their bytes, compared with their names and declared types.
describe("sniff", () => {
  it("identifies a synthetic sample of each type", () => {
    for (const [type, sample] of Object.entries(samples)) expect(sniff(sample), type).toBe(type);
  });

  it("identifies each script marker, an HTML Application before HTML", () => {
    for (const [name, sample] of Object.entries(scripts)) expect(sniff(sample), name).toBe("script");
  });

  it("recognises nothing in random binary", () => {
    expect(sniff(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]))).toBeNull();
    expect(sniff(new Uint8Array())).toBeNull();
  });
});

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
function view(attachments: { filename: string; mediaType: string; sample: Uint8Array }[], unread = 0): CaseView {
  const list = attachments.map((a, i) => ({
    key: `attachments/case-x/${i}`,
    filename: a.filename,
    mediaType: a.mediaType,
    contentId: null,
    disposition: "attachment",
    bytes: a.sample.length,
  }));
  return {
    tenant: {
      orgId: "org-sniff",
      channel: "email",
      receivers: [],
      headersAvailable: true,
      trusted: { own: [], suppliers: [] },
    },
    raw: "raw/case-x/message.eml",
    brands: {
      version: 1,
      revision: "t",
      community_labels: [],
      brands: [],
      excluded: [],
    } as unknown as CaseView["brands"],
    senderHistory: null,
    domainAges: null,
    attachmentHeads: {
      heads: attachments.map((a, i) => ({ key: `attachments/case-x/${i}`, head: b64(a.sample) })),
      unread,
    },
    source: { kind: "message", path: "rfc822", otherOriginals: 0 },
    headers: [],
    text: null,
    html: null,
    attachments: list,
    truncated: [],
    omitted: 0,
  };
}

describe("attachment.type_mismatch", () => {
  it("is high for a program named as a PDF, citing the attachment", () => {
    const items = typeMismatchEvidence(
      view([{ filename: "Invoice 77.pdf", mediaType: "application/pdf", sample: samples.pe }]),
    );
    expect(items).toMatchObject([
      {
        severity: "high",
        artefacts: ["attachments/case-x/0"],
        detail: { sniffed: "pe", extension: "pdf", claims: ["extension", "media type"] },
      },
    ]);
  });

  it("is high for a shortcut or an ELF or Mach-O program behind an image or document name", () => {
    for (const [filename, sample] of [
      ["photo.jpg", samples.lnk],
      ["statement.docx", samples.elf],
      ["scan.png", samples.macho],
    ] as const)
      expect(
        typeMismatchEvidence(view([{ filename, mediaType: "application/octet-stream", sample }]))[0]?.severity,
        filename,
      ).toBe("high");
  });

  it("yields nothing for correct files, OOXML as ZIP, and an unknown extension", () => {
    for (const [filename, mediaType, sample] of [
      ["Invoice 77.pdf", "application/pdf", samples.pdf],
      ["Statement.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", samples.docx],
      ["Statement.docx", "application/zip", samples.docx],
      ["Book.xlsx", "application/octet-stream", samples.xlsx],
      ["legacy.doc", "application/msword", samples.ole],
      ["photo.JPEG", "image/jpeg", samples.jpeg],
      ["data.bin", "application/octet-stream", samples.pe],
    ] as const)
      expect(typeMismatchEvidence(view([{ filename, mediaType, sample }])), filename).toEqual([]);
  });

  it("is high for a script behind a document or image name", () => {
    expect(
      typeMismatchEvidence(view([{ filename: "Invoice.pdf", mediaType: "application/pdf", sample: scripts.hta }]))[0]
        ?.severity,
    ).toBe("high");
  });

  it("compares concrete formats: a Word file named .pdf, JPEG declared image/png (plan review)", () => {
    expect(
      typeMismatchEvidence(
        view([{ filename: "invoice.pdf", mediaType: "application/octet-stream", sample: samples.ole }]),
      ),
    ).toMatchObject([{ severity: "medium", detail: { sniffed: "ole", claims: ["extension"] } }]);
    expect(
      typeMismatchEvidence(view([{ filename: "photo", mediaType: "image/png", sample: samples.jpeg }])),
    ).toMatchObject([{ severity: "medium", detail: { sniffed: "jpeg", claims: ["media type"] } }]);
  });

  it("is medium for any other disagreement, by name or by declared type", () => {
    expect(
      typeMismatchEvidence(view([{ filename: "invoice.pdf", mediaType: "application/pdf", sample: samples.html }])),
    ).toMatchObject([{ severity: "medium", detail: { sniffed: "html", claims: ["extension", "media type"] } }]);
    expect(
      typeMismatchEvidence(view([{ filename: "scan", mediaType: "image/png", sample: samples.zip }])),
    ).toMatchObject([{ severity: "medium", detail: { claims: ["media type"] } }]);
  });

  it("decides by the bytes, never the extension", () => {
    const named = typeMismatchEvidence(
      view([{ filename: "Invoice.pdf", mediaType: "application/pdf", sample: samples.pdf }]),
    );
    const renamed = typeMismatchEvidence(
      view([{ filename: "Invoice.pdf", mediaType: "application/pdf", sample: samples.pe }]),
    );
    expect(named).toEqual([]);
    expect(renamed).toHaveLength(1);
  });

  it("counts attachments not read", () => {
    expect(typeMismatchEvidence(view([], 3))).toMatchObject([
      { severity: "info", detail: { checked: false, unread: 3 } },
    ]);
  });
});

describe("attachment.type_mismatch through the checks step", () => {
  it("fails the step on a storage error, so the Workflow retries, rather than counting it as unread", async () => {
    const failing = { get: async () => Promise.reject(new Error("R2 down")) } as unknown as R2Bucket;
    await expect(attachmentHeadsOf(failing, [{ key: "attachments/x/1" }])).rejects.toThrow("R2 down");
  });

  it("reads each attachment's first bytes from R2 and stores a renamed program as high", async () => {
    const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
    const made = await createCase(env.DB, { orgId: "org-sniff", channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    await putRaw(store, id, new TextEncoder().encode("From: x@y.example\r\n\r\nPay.\r\n"));
    const program = await putAttachment(store, id, "Invoice 77.pdf", samples.pe, "application/pdf");
    const fine = await putAttachment(store, id, "Statement.pdf", samples.pdf, "application/pdf");
    const attachment = (stored: { key: string }, filename: string, bytes: number) => ({
      key: stored.key,
      filename,
      mediaType: "application/pdf",
      contentId: null,
      disposition: "attachment",
      bytes,
    });
    await putParsed(store, id, {
      headers: [],
      text: "Pay.",
      html: null,
      attachments: [
        attachment(program, "Invoice 77.pdf", samples.pe.length),
        attachment(fine, "Statement.pdf", samples.pdf.length),
      ],
      truncated: [],
      omitted: 0,
      forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
    });
    await checks(store, id, parsedKey(id), { orgId: "org-sniff", channel: "email" }, async () => []);
    expect((await readEvidence(env.DB, id)).filter((e) => e.check === "attachment.type_mismatch")).toMatchObject([
      { severity: "high", artefacts: [program.key], detail: { filename: "Invoice 77.pdf", sniffed: "pe" } },
    ]);
  });

  it("stores each claim's disagreement, and a count of attachments past the limit", async () => {
    const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
    const made = await createCase(env.DB, { orgId: "org-sniff", channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    await putRaw(store, id, new TextEncoder().encode("From: x@y.example\r\n\r\nPay.\r\n"));
    const entries: [string, string, Uint8Array][] = [
      ["both.pdf", "application/pdf", samples.pe],
      ["byname.pdf", "application/octet-stream", samples.ole],
      ["bytype", "image/png", samples.jpeg],
      ["fine.pdf", "application/pdf", samples.pdf],
      ...Array.from(
        { length: 17 },
        (_, i) => [`f${i}.txt`, "text/plain", new TextEncoder().encode(`note ${i}`)] as [string, string, Uint8Array],
      ),
    ];
    const attachments = [];
    for (const [filename, mediaType, body] of entries) {
      const stored = await putAttachment(store, id, filename, body, mediaType);
      attachments.push({
        key: stored.key,
        filename,
        mediaType,
        contentId: null,
        disposition: "attachment",
        bytes: body.length,
      });
    }
    await putParsed(store, id, {
      headers: [],
      text: "Pay.",
      html: null,
      attachments,
      truncated: [],
      omitted: 0,
      forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
    });
    await checks(store, id, parsedKey(id), { orgId: "org-sniff", channel: "email" }, async () => []);
    const items = (await readEvidence(env.DB, id)).filter((e) => e.check === "attachment.type_mismatch");
    expect(items.map((i) => [i.severity, i.detail.filename ?? null, i.detail.claims ?? i.detail.unread])).toEqual([
      ["high", "both.pdf", ["extension", "media type"]],
      ["medium", "byname.pdf", ["extension"]],
      ["medium", "bytype", ["media type"]],
      ["info", null, 1],
    ]);
  });

  it("reads at most MAX_SNIFFED attachments' first SNIFF_BYTES, counting the rest and any that cannot be read", async () => {
    const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
    const made = await createCase(env.DB, { orgId: "org-sniff", channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const caseId = made.value.id;
    const large = new Uint8Array(SNIFF_BYTES + 4096).fill(0x41);
    const big = await putAttachment(store, caseId, "large.txt", large, "text/plain");
    const keys = [
      big,
      ...(await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          putAttachment(store, caseId, `f${i}.txt`, new TextEncoder().encode(`file ${i}`), "text/plain"),
        ),
      )),
    ].map((a) => ({ key: a.key }));
    const missing = { key: "attachments/case-heads/missing" };
    const read = await attachmentHeadsOf(env.ARTEFACTS, [missing, ...keys]);
    expect(read.heads).toHaveLength(MAX_SNIFFED - 1);
    expect(read.unread).toBe(2 + 1);
    const isoHead = read.heads.find((h) => h.key === big.key)?.head ?? "";
    expect(atob(isoHead).length).toBe(SNIFF_BYTES);
  });
});
