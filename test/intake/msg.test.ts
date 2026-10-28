import { env } from "cloudflare:workers";
import MsgReader from "@kenjiuno/msgreader";
import msgreaderConstants from "@kenjiuno/msgreader/lib/const.js";
import { describe, expect, it } from "vitest";
import { makeDecoyCompoundFile, makeMsg, renameEntry } from "../../scripts/fixtures/msg-builder";
import { createCase } from "../../src/db/cases";
import { ParseError } from "../../src/intake/mime";
import { parseMsg, STRING_PROPERTY_LIMIT } from "../../src/intake/msg";
import { BODY_PART_LIMIT, parseMessage, storeParsed } from "../../src/intake/parse";
import { parsedKey, readArtefact, type Store } from "../../src/intake/store";
import { msgs, twin } from "../fixtures/msg/load";

// D01 T01 §6: an attached Outlook .msg parsed into the same ParsedMessage as its MIME twin.
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };

describe("parseMsg", () => {
  it("reads the transport headers, bodies and attachments as the .eml twin holds them", async () => {
    const { parsed, headersAvailable } = await parseMsg(msgs.full);
    const mime = await parseMessage(twin);
    expect(headersAvailable).toBe(true);
    // The twin adds its own MIME Content-Type after the same transport headers.
    expect(parsed.headers).toEqual(mime.headers.filter((h) => h.name !== "Content-Type"));
    expect(parsed.headers.filter((h) => h.name === "Received")).toHaveLength(2);
    expect(parsed.text?.trim()).toBe(mime.text?.trim());
    // The HTML from code page 1252, non-ASCII text intact.
    expect(parsed.html).toBe(mime.html);
    expect(parsed.html).toContain("Café São Paulo");
    const pdf = mime.attachments.find((a) => a.filename === "invoice-77.pdf");
    expect(parsed.attachments.find((a) => a.filename === "invoice-77.pdf")).toMatchObject({
      mediaType: "application/pdf",
      disposition: "attachment",
      bytes: pdf?.bytes,
    });
  });

  it("keeps an inline image's content id and stores an embedded message as .msg bytes that reopen", async () => {
    const { parsed } = await parseMsg(msgs.full);
    const image = parsed.attachments.find((a) => a.filename === "logo.png");
    expect(image).toMatchObject({ contentId: "<logo77@fictional>", disposition: "inline", mediaType: "image/png" });
    expect(parsed.html).toContain("cid:logo77@fictional");
    const embedded = parsed.attachments.find((a) => a.mediaType === "application/vnd.ms-outlook");
    if (!embedded) throw new Error("the embedded message is missing");
    const reopened = new MsgReader(
      new DataView(embedded.bytes.buffer, embedded.bytes.byteOffset, embedded.bytes.byteLength),
    );
    expect(reopened.getFileData().subject).toBe("Earlier message from the supplier");
  });

  it("says a draft without transport headers has none", async () => {
    expect(await parseMsg(msgs.draft)).toMatchObject({ headersAvailable: false, parsed: { headers: [] } });
  });

  it("refuses an RTF-only body, a file that is not a .msg and a cut-off one as a ParseError", async () => {
    for (const [name, bytes] of [
      ["rtf-only", msgs.rtfOnly],
      ["not-a-msg", msgs.notAMsg],
      ["truncated", msgs.truncated],
      ["empty", msgs.empty],
    ] as const)
      await expect(parseMsg(bytes), name).rejects.toBeInstanceOf(ParseError);
    // Each for its own reason: msgreader's returned error, and a well-formed file holding nothing.
    await expect(parseMsg(msgs.notAMsg)).rejects.toThrow(/not a compound file/);
    await expect(parseMsg(msgs.empty)).rejects.toThrow(/holds nothing readable/);
  });

  it("stores the parse with storeParsed, the inline image under its content id", async () => {
    const made = await createCase(env.DB, { orgId: "org-msg", channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const { parsed, headersAvailable } = await parseMsg(msgs.full);
    const summary = await storeParsed(store, made.value.id, parsed, {
      original: msgs.full,
      format: "msg",
      headersAvailable,
      path: "msg",
      otherOriginals: 0,
    });
    const read = await readArtefact(store, made.value.id, parsedKey(made.value.id));
    if (!read || !("body" in read)) throw new Error("the summary is missing");
    const stored = JSON.parse(new TextDecoder().decode(read.body));
    expect(stored.html).toContain("cid:logo77@fictional");
    const image = stored.attachments.find((a: { contentId: string | null }) => a.contentId === "<logo77@fictional>");
    expect(image).toMatchObject({ filename: "logo.png", mediaType: "image/png" });
    const bytes = await readArtefact(store, made.value.id, image.key);
    expect(bytes && "body" in bytes ? [...bytes.body.subarray(0, 4)] : []).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(summary.forward).toEqual({ path: "msg", headersAvailable: true, otherOriginals: 0 });
  });

  it("cuts a large body to §5's limit and keeps it whole in its own charset", async () => {
    const { parsed } = await parseMsg(makeMsg({ transportHeaders: true, bodyRepeat: 30_000 }));
    expect(parsed.text?.length).toBe(BODY_PART_LIMIT / 2);
    expect(parsed.truncated).toMatchObject([
      { mediaType: "text/plain", charset: "utf-16le", keptBytes: BODY_PART_LIMIT },
    ]);
    expect(parsed.truncated[0]?.full.byteLength).toBeGreaterThan(BODY_PART_LIMIT);
    expect(new TextDecoder("utf-16le").decode(parsed.truncated[0]?.full).startsWith(parsed.text ?? "?")).toBe(true);
  });

  describe("completion review cases", () => {
    it("keeps repeated headers in order", async () => {
      const { parsed } = await parseMsg(msgs.full);
      expect(parsed.headers.filter((h) => h.name === "Received").map((h) => h.value.split(" ")[1])).toEqual([
        "mx.fictional-recipient.example",
        "mail.fictional-supplier.example",
      ]);
    });

    it("reads 8-bit strings in the message's code page, and HTML in its own", async () => {
      expect((await parseMsg(msgs.ansi)).parsed.text).toContain("Please pay \u20ac100 today.");
      expect((await parseMsg(msgs.cyrillic)).parsed.html).toBe("<p>\u041f\u0440\u0438\u0432\u0435\u0442</p>");
      await expect(parseMsg(makeMsg({ transportHeaders: true, messageCodepage: 99_999 }))).rejects.toThrow(
        /code page 99999/,
      );
    });

    it("keeps a cut HTML body whole with its code page", async () => {
      const { parsed } = await parseMsg(makeMsg({ transportHeaders: true, htmlRepeat: 12_000 }));
      expect(parsed.truncated).toMatchObject([
        { mediaType: "text/html", charset: "windows-1252", keptBytes: BODY_PART_LIMIT },
      ]);
      expect(new TextDecoder("windows-1252").decode(parsed.truncated[0]?.full)).toContain("Caf\u00e9 S\u00e3o Paulo");
    });

    it("refuses a malformed property and a forged stream size as ParseError, before allocating", async () => {
      await expect(parseMsg(msgs.malformedHeaders)).rejects.toThrow(/transport headers is not text/);
      await expect(parseMsg(msgs.forgedSize)).rejects.toThrow(/declares 268435456 bytes/);
      await expect(parseMsg(msgs.forgedSize)).rejects.toBeInstanceOf(ParseError);
    });
  });

  describe("round 1 cases", () => {
    it("refuses a DIFAT chain that loops, in bounded time", async () => {
      // The reviewer's file: one more sector, named as the DIFAT's first, whose next link points at itself.
      const sector = 512;
      const looped = new Uint8Array(msgs.full.byteLength + sector);
      looped.set(msgs.full);
      const view = new DataView(looped.buffer);
      const id = msgs.full.byteLength / sector - 1;
      view.setUint32(68, id, true);
      view.setUint32(msgs.full.byteLength + sector - 4, id, true);
      view.setUint32(72, 0x7fffffff, true);
      await expect(parseMsg(looped)).rejects.toThrow(/sector tables are larger than the file/);
      view.setUint32(72, 2, true);
      await expect(parseMsg(looped)).rejects.toThrow(/already in use/);
    });

    it("refuses a compound file that is not a message", async () => {
      await expect(parseMsg(makeDecoyCompoundFile())).rejects.toThrow(/has no message properties/);
    });

    it("reads 8-bit strings declared UTF-8", async () => {
      const text = new TextEncoder().encode("Please pay \u20ac100 today. \u041f\u0440\u0438\u0432\u0435\u0442\r\n");
      const { parsed } = await parseMsg(
        makeMsg({
          transportHeaders: true,
          ansi: { subject: new TextEncoder().encode("Pay"), text },
          messageCodepage: 65001,
        }),
      );
      expect(parsed.text).toBe("Please pay \u20ac100 today. \u041f\u0440\u0438\u0432\u0435\u0442\r\n");
    });

    it("refuses a text property over the limit rather than decoding it", async () => {
      const subject = "x".repeat(STRING_PROPERTY_LIMIT / 2 + 1);
      await expect(parseMsg(makeMsg({ transportHeaders: true, subject }))).rejects.toThrow(/more than 1048576/);
    });

    it("takes a short file name, refuses a binary one, and keeps an OLE object's own name and type", async () => {
      const short = await parseMsg(makeMsg({ transportHeaders: true, pdf: "short-name" }));
      expect(short.parsed.attachments[0]).toMatchObject({ filename: "INV77.PDF", mediaType: "application/pdf" });
      await expect(parseMsg(makeMsg({ transportHeaders: true, pdf: "binary-name" }))).rejects.toThrow(
        /attachment file name is not text/,
      );
      const ole = await parseMsg(makeMsg({ transportHeaders: true, pdf: "ole" }));
      expect(ole.parsed.attachments[0]).toMatchObject({ filename: "payment.doc", mediaType: "application/msword" });
      // The embedded message beside it is still one.
      expect(ole.parsed.attachments[2]).toMatchObject({ mediaType: "application/vnd.ms-outlook" });
    });
  });

  describe("round 2 cases", () => {
    it("refuses a single-valued property name with a suffix, which msgreader would still decode", async () => {
      const body = makeMsg({ transportHeaders: true, bodyRepeat: 30_000 });
      await expect(
        parseMsg(renameEntry(body, "__substg1.0_1000001F", "__substg1.0_1000001F-00000000")),
      ).rejects.toThrow(/malformed name \(__substg1\.0_1000001F-00000000\)/);
      const subject = makeMsg({ transportHeaders: true, subject: "x".repeat(STRING_PROPERTY_LIMIT / 2 + 1) });
      await expect(parseMsg(renameEntry(subject, "__substg1.0_0037001F", "__substg1.0_0037001Fx"))).rejects.toThrow(
        /malformed name/,
      );
    });

    it("refuses two entries in one storage with the same name in another case", async () => {
      const twice = renameEntry(msgs.full, "__substg1.0_0E04001F", "__substg1.0_1000001f");
      await expect(parseMsg(twice)).rejects.toThrow(/both named/);
    });
  });

  describe("round 3 cases", () => {
    it("counts each named-property name as often as entries refer to it", async () => {
      const once = await parseMsg(makeMsg({ transportHeaders: true, names: { nameBytes: 1024, references: 16 } }));
      expect(once.parsed.text).toContain("invoice 77");
      await expect(
        parseMsg(makeMsg({ transportHeaders: true, names: { nameBytes: STRING_PROPERTY_LIMIT / 4, references: 16 } })),
      ).rejects.toThrow(/text properties hold \d+ bytes, more than 4194304/);
    });

    it("refuses a named binary property over the limit", async () => {
      await expect(
        parseMsg(makeMsg({ transportHeaders: true, namedBinary: STRING_PROPERTY_LIMIT + 2 })),
      ).rejects.toThrow(/__substg1\.0_80000102\) is 1048578 bytes/);
    });
  });

  describe("round 4 cases", () => {
    it("refuses every spelling msgreader recognises that the format does not give", async () => {
      const body = makeMsg({ transportHeaders: true, bodyRepeat: 30_000 });
      const renames: [string, string][] = [
        ["__substg1.0_1000001F", "__substg1.X_1000001F"],
        ["__substg1.0_0037001F", "__substg1.0_0037001"],
        ["__attach_version1.0_#00000000", "__attach_version1.0_x"],
        ["__recip_version1.0_#00000000", "__recip_version1.0_#0000000Z"],
        ["__nameid_version1.0", "__nameid_version1.0x"],
      ];
      for (const [from, to] of renames)
        await expect(parseMsg(renameEntry(body, from, to)), to).rejects.toThrow(/malformed name/);
    });

    it("takes msgreader's name prefixes from msgreader", () => {
      // The pinned 1.29.0's values; a change here is an upgrade whose spellings above need reading again.
      expect(msgreaderConstants.MSG.FIELD.PREFIX).toEqual({
        ATTACHMENT: "__attach_version1.0",
        RECIPIENT: "__recip_version1.0",
        DOCUMENT: "__substg1.",
        NAMEID: "__nameid_version1.0",
      });
    });
  });
});
