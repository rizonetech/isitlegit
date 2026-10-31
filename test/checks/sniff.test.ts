import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { typeMismatchEvidence } from "../../src/checks/attachment-type";
import type { CaseView } from "../../src/checks/case-view";
import { readEvidence } from "../../src/checks/evidence";
import { checks as checks_ } from "../../src/checks/index";
import { attachmentHeadsOf, MAX_SNIFFED, SNIFF_BYTES, sniff } from "../../src/checks/sniff";
import { createCase } from "../../src/db/cases";
import { parsedKey, putAttachment, putParsed, putRaw, type Store } from "../../src/intake/store";
import { checks } from "../../src/pipeline/analysis-workflow";
import { mp3Frame, samples, scripts } from "../fixtures/attachments/samples";

// D02 T04 §1: attachments read by their bytes, compared with their names and declared types.
describe("sniff", () => {
  it("identifies a synthetic sample of each type", () => {
    for (const [type, sample] of Object.entries(samples)) expect(sniff(sample), type).toBe(type);
  });

  it("identifies each script marker, an HTML Application before HTML", () => {
    for (const [name, sample] of Object.entries(scripts)) expect(sniff(sample), name).toBe("script");
  });

  it("reads a UTF-16LE script with its byte order mark (completion review)", () => {
    const text = "Invoke-Expression (New-Object Net.WebClient).DownloadString('x')\r\n";
    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) utf16[2 + i * 2] = text.charCodeAt(i);
    expect(sniff(utf16)).toBe("script");
  });

  it("reads an SVG after its XML prolog (completion review)", () => {
    for (const text of [
      '<!-- Company logo -->\n<svg xmlns="http://www.w3.org/2000/svg"/>',
      '<?xml version="1.0"?>\n<!-- Company logo -->\n<!DOCTYPE svg>\n<svg xmlns="http://www.w3.org/2000/svg"/>',
    ])
      expect(sniff(new TextEncoder().encode(text)), text).toBe("svg");
  });

  it("reads an SVG whose doctype declares entities (round 1)", () => {
    const svg =
      '<!DOCTYPE svg [<!ENTITY company "Example">]>\n<svg xmlns="http://www.w3.org/2000/svg"><text>&company;</text></svg>';
    expect(sniff(new TextEncoder().encode(svg))).toBe("svg");
  });

  it("reads an SVG whose quoted entity holds a bracket (round 2)", () => {
    const svg =
      '<!DOCTYPE svg [<!ENTITY company "Example ] Ltd">]>\n<svg xmlns="http://www.w3.org/2000/svg"><text>&company;</text></svg>';
    expect(sniff(new TextEncoder().encode(svg))).toBe("svg");
  });

  it("reads prose that mentions a command as text, not a script (completion review)", () => {
    for (const prose of [
      "In PowerShell, Invoke-Expression runs a string as a command.",
      "Our IT notes: never run powershell -EncodedCommand from an email.",
      'The old macro used CreateObject("WScript.Shell") to open files.',
    ])
      expect(sniff(new TextEncoder().encode(prose)), prose).toBe("text");
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
    hiddenText: null,
    htmlAttachments: null,
    attachmentRisks: null,
    instructions: null,
    invisibleText: null,
    links: null,
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

  it("says what the file is named as and what it contains, in plain words (completion review)", () => {
    expect(
      typeMismatchEvidence(view([{ filename: "Invoice.pdf", mediaType: "application/pdf", sample: samples.pe }]))[0]
        ?.summary,
    ).toBe("Invoice.pdf is named as a PDF, but contains a Windows program.");
    expect(
      typeMismatchEvidence(view([{ filename: "scan", mediaType: "image/png", sample: samples.jpeg }]))[0]?.summary,
    ).toBe("scan is declared as a PNG image, but contains a JPEG image.");
  });

  it("keeps the batch's findings whatever a filename's extension spells (completion review)", () => {
    for (const odd of ["notes.constructor", "notes.__proto__", "notes.toString", "notes.hasOwnProperty"]) {
      const items = typeMismatchEvidence(
        view([
          { filename: "Invoice.pdf", mediaType: "application/pdf", sample: samples.pe },
          { filename: odd, mediaType: "application/octet-stream", sample: samples.text },
        ]),
      );
      expect(
        items.map((i) => i.severity),
        odd,
      ).toEqual(["high"]);
    }
  });

  it("stays high when a false name hides a false document type (round 2)", () => {
    for (const filename of ["invoice.bin", "invoice.zip", "invoice.txt"]) {
      const [item] = typeMismatchEvidence(view([{ filename, mediaType: "application/pdf", sample: samples.pe }]));
      expect(item?.severity, filename).toBe("high");
      expect(item?.summary, filename).toContain("as a PDF, but contains a Windows program");
    }
  });

  it("counts attachments not read", () => {
    expect(typeMismatchEvidence(view([], 3))).toMatchObject([
      { severity: "info", detail: { checked: false, unread: 3 } },
    ]);
  });
});

describe("attachment.type_mismatch through the checks step", () => {
  it("reads four at a time, keeping the attachments' order (completion review)", async () => {
    let active = 0;
    let peak = 0;
    const slow = {
      get: async (key: string) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20 - Number(key.slice(-1))));
        active--;
        return { arrayBuffer: async () => new TextEncoder().encode(key).buffer } as unknown as R2ObjectBody;
      },
    } as unknown as R2Bucket;
    const keys = Array.from({ length: 10 }, (_, i) => ({ key: `attachments/x/${i}` }));
    const read = await attachmentHeadsOf(slow, keys);
    expect(peak).toBe(4);
    expect(read.heads.map((h) => h.key)).toEqual(keys.map((k) => k.key));
  });

  it("compares at most twenty of fifty identical attachments sharing one key, keeping the findings (round 1)", async () => {
    const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
    const made = await createCase(env.DB, { orgId: "org-sniff", channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    await putRaw(store, id, new TextEncoder().encode("From: x@y.example\r\n\r\nPay.\r\n"));
    const stored = await putAttachment(store, id, "invoice.pdf", samples.pe, "application/pdf");
    const one = {
      key: stored.key,
      filename: "invoice.pdf",
      mediaType: "application/pdf",
      contentId: null,
      disposition: "attachment",
      bytes: samples.pe.length,
    };
    await putParsed(store, id, {
      headers: [],
      text: "Pay.",
      html: null,
      attachments: Array.from({ length: 50 }, () => one),
      truncated: [],
      omitted: 0,
      forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
    });
    await checks(store, id, parsedKey(id), { orgId: "org-sniff", channel: "email" }, async () => []);
    const items = (await readEvidence(env.DB, id)).filter(
      (e) => e.check === "attachment.type_mismatch" || e.check === "not_checked",
    );
    expect(items.filter((i) => i.severity === "high")).toHaveLength(MAX_SNIFFED);
    expect(items.find((i) => i.severity === "info")?.detail).toMatchObject({ checked: false, unread: 30 });
    expect(items.some((i) => i.check === "not_checked")).toBe(false);
  });

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

describe("further formats (D02 T04 §5)", () => {
  it("identifies RTF, OpenDocument, M4A, Ogg, WAV and MP3, and two stray bytes as nothing", () => {
    expect(sniff(samples.rtf)).toBe("rtf");
    expect(sniff(samples.odf)).toBe("odf");
    expect(sniff(samples.m4a)).toBe("m4a");
    expect(sniff(samples.ogg)).toBe("ogg");
    expect(sniff(samples.wav)).toBe("wav");
    expect(sniff(samples.mp3)).toBe("mp3");
    expect(sniff(mp3Frame)).toBe("mp3");
    expect(sniff(new Uint8Array([0xff, 0xe0, 0x00, 0x00, ...new Uint8Array(16)]))).toBeNull();
    expect(
      sniff(new Uint8Array([0, 0, 0, 0x20, ...new TextEncoder().encode("ftypisom"), ...new Uint8Array(16)])),
    ).toBeNull();
  });

  it("is high for a program, script or shortcut behind every new name and every new media type alone, and silent for genuine bytes", () => {
    const names: [string, Uint8Array][] = [
      ["a.rtf", samples.rtf],
      ["a.odt", samples.odf],
      ["a.ods", samples.odf],
      ["a.odp", samples.odf],
      ["a.ott", samples.odf],
      ["a.ots", samples.odf],
      ["a.otp", samples.odf],
      ["a.dot", samples.ole],
      ["a.xlt", samples.ole],
      ["a.pot", samples.ole],
      ["a.dotx", samples.docx],
      ["a.xltx", samples.xlsx],
      ["a.potx", samples.pptx],
      ["a.m4a", samples.m4a],
      ["a.ogg", samples.ogg],
      ["a.oga", samples.ogg],
      ["a.opus", samples.ogg],
      ["a.wav", samples.wav],
      ["a.mp3", samples.mp3],
    ];
    const types: [string, Uint8Array][] = [
      ["application/rtf", samples.rtf],
      ["text/rtf", samples.rtf],
      ["application/vnd.oasis.opendocument.text", samples.odf],
      ["application/vnd.oasis.opendocument.spreadsheet", samples.odf],
      ["application/vnd.oasis.opendocument.presentation", samples.odf],
      ["application/vnd.oasis.opendocument.text-template", samples.odf],
      ["application/vnd.oasis.opendocument.spreadsheet-template", samples.odf],
      ["application/vnd.oasis.opendocument.presentation-template", samples.odf],
      ["application/vnd.openxmlformats-officedocument.wordprocessingml.template", samples.docx],
      ["application/vnd.openxmlformats-officedocument.spreadsheetml.template", samples.xlsx],
      ["application/vnd.openxmlformats-officedocument.presentationml.template", samples.pptx],
      ["audio/mp4", samples.m4a],
      ["audio/m4a", samples.m4a],
      ["audio/x-m4a", samples.m4a],
      ["audio/ogg", samples.ogg],
      ["audio/opus", samples.ogg],
      ["application/ogg", samples.ogg],
      ["audio/wav", samples.wav],
      ["audio/wave", samples.wav],
      ["audio/x-wav", samples.wav],
      ["audio/vnd.wave", samples.wav],
      ["audio/mpeg", samples.mp3],
      ["audio/mp3", mp3Frame],
    ];
    const dangerous = [samples.pe, samples.script, samples.lnk];
    for (const [filename, genuine] of names) {
      expect(typeMismatchEvidence(view([{ filename, mediaType: "", sample: genuine }])), filename).toEqual([]);
      for (const bad of dangerous)
        expect(typeMismatchEvidence(view([{ filename, mediaType: "", sample: bad }]))[0]?.severity, filename).toBe(
          "high",
        );
    }
    for (const [mediaType, genuine] of types) {
      expect(typeMismatchEvidence(view([{ filename: "file", mediaType, sample: genuine }])), mediaType).toEqual([]);
      for (const bad of dangerous)
        expect(typeMismatchEvidence(view([{ filename: "file", mediaType, sample: bad }]))[0]?.severity, mediaType).toBe(
          "high",
        );
    }
  });

  it("keeps an OpenDocument file declared as a ZIP silent, as an Office package is", () => {
    for (const [filename, mediaType] of [
      ["archive.zip", "application/zip"],
      ["archive.zip", "application/x-zip-compressed"],
    ] as const)
      expect(typeMismatchEvidence(view([{ filename, mediaType, sample: samples.odf }])), mediaType).toEqual([]);
  });

  it("states a file whose bytes match no known type as not compared (D02 T04 §4's partial outcome)", () => {
    const check = checks_.all().find((c) => c.name === "attachment.type_mismatch");
    const unknown = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xfe, 0xfd, 0x00, 0x10, ...new Uint8Array(16)]);
    expect(check?.partial?.(view([{ filename: "blob.bin", mediaType: "", sample: unknown }]))).toBe(
      "1 file of a type not identified",
    );
    expect(check?.partial?.(view([{ filename: "note.wav", mediaType: "", sample: samples.wav }]))).toBeNull();
  });

  it("names an audio format by its container, never as a voice note (completion review)", () => {
    for (const [filename, mediaType] of [
      ["note.ogg", "audio/ogg"],
      ["note.m4a", "audio/mp4"],
      ["note.wav", "audio/wav"],
      ["note.mp3", "audio/mpeg"],
    ] as const) {
      const [item] = typeMismatchEvidence(view([{ filename, mediaType, sample: samples.pe }]));
      expect(item?.summary, filename).toMatch(
        /is (named|declared) as an? (Ogg file|M4A audio file|WAV audio file|MP3 audio file), but/,
      );
      expect(item?.summary, filename).not.toMatch(/voice note|recording/);
    }
  });

  it("reads an ID3 tag only by its whole header, so a script beginning ID3 is a script (round 3)", () => {
    const vbs = new TextEncoder().encode('ID3 = 1\r\nWScript.Echo "synthetic probe"\r\n');
    expect(sniff(vbs)).toBe("script");
    expect(
      typeMismatchEvidence(view([{ filename: "message.mp3", mediaType: "audio/mpeg", sample: vbs }]))[0]?.severity,
    ).toBe("high");
    expect(sniff(samples.mp3)).toBe("mp3");
  });

  it("reads a script that begins with a format's printable signature as a script (round 4)", () => {
    const text = (t: string) => new TextEncoder().encode(t);
    const disguised: [string, string, Uint8Array][] = [
      ["message.ogg", "audio/ogg", text('OggS = 1\r\nWScript.Echo "synthetic probe"\r\n')],
      ["message.wav", "audio/wav", text('RIFF = "WAVE"\r\nWScript.Echo "synthetic probe"\r\n')],
      ["message.m4a", "audio/mp4", text("rem ftypM4A \r\n@echo off\r\necho synthetic\r\n")],
      ["photo.gif", "image/gif", text('GIF89a = 1\r\nWScript.Echo "synthetic probe"\r\n')],
      ["invoice.pdf", "application/pdf", text("%PDF-1.7\r\n@echo off\r\necho synthetic\r\n")],
    ];
    for (const [filename, mediaType, sample] of disguised) {
      expect(sniff(sample), filename).toBe("script");
      expect(typeMismatchEvidence(view([{ filename, mediaType, sample }]))[0]?.severity, filename).toBe("high");
    }
    // Genuine binary files of each format are still themselves.
    for (const [sample, type] of [
      [samples.ogg, "ogg"],
      [samples.wav, "wav"],
      [samples.m4a, "m4a"],
      [samples.gif, "gif"],
      [samples.pdf, "pdf"],
    ] as const)
      expect(sniff(sample), type).toBe(type);
  });

  it("keeps an RTF document that shows a command as RTF (round 5)", () => {
    const rtf = new TextEncoder().encode("{\\rtf1\\ansi Instructions:\\par\r\n@echo off\r\n\\par Save this example.}");
    expect(sniff(rtf)).toBe("rtf");
    expect(
      typeMismatchEvidence(view([{ filename: "instructions.rtf", mediaType: "application/rtf", sample: rtf }])),
    ).toEqual([]);
  });
});
