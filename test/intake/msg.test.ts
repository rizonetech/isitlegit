import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { makeDecoyCompoundFile, makeMsg, renameEntry } from "../../scripts/fixtures/msg-builder";
import { createCase, setHeadersAvailable } from "../../src/db/cases";
import { ParseError } from "../../src/intake/mime";
import { parseMsg, STRING_PROPERTY_LIMIT } from "../../src/intake/msg";
import { loadMsgReader, loadMsgreaderConstants } from "../../src/intake/msgreader";
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
    const reopened = new (loadMsgReader())(
      new DataView(embedded.bytes.buffer, embedded.bytes.byteOffset, embedded.bytes.byteLength),
    );
    expect(reopened.getFileData().subject).toBe("Earlier message from the supplier");
  });

  it("says a draft without transport headers has none", async () => {
    expect(await parseMsg(msgs.draft)).toMatchObject({ headersAvailable: false, parsed: { headers: [] } });
  });

  it("refuses a file that is not a .msg and a cut-off one as a ParseError", async () => {
    for (const [name, bytes] of [
      ["not-a-msg", msgs.notAMsg],
      ["truncated", msgs.truncated],
      ["empty", msgs.empty],
    ] as const)
      await expect(parseMsg(bytes), name).rejects.toBeInstanceOf(ParseError);
    // Each for its own reason: msgreader's returned error, and a well-formed file holding nothing.
    await expect(parseMsg(msgs.notAMsg)).rejects.toThrow(/not a compound file/);
    await expect(parseMsg(msgs.empty)).rejects.toThrow(/holds nothing readable/);
  });

  it("reads a body held only as compressed RTF (D01 T01 §13)", async () => {
    const { parsed } = await parseMsg(msgs.rtfOnly);
    expect(parsed.text).toContain("Please pay invoice 77 today.");
    expect(parsed.html).toBeNull();
  });

  it("reads an RTF-only body with nothing else readable, and states the RTF failures (D01 T01 §13)", async () => {
    const mela = (rtf: string) => {
      const body = new TextEncoder().encode(rtf);
      const out = new Uint8Array(16 + body.length);
      const view = new DataView(out.buffer);
      view.setUint32(0, body.length + 12, true);
      view.setUint32(4, body.length, true);
      view.setUint32(8, 0x414c454d, true);
      out.set(body, 16);
      return out;
    };
    // No subject, no transport headers, no attachments: the RTF alone makes the message readable.
    const only = await parseMsg(
      makeMsg({ transportHeaders: false, rtfOnly: true, subject: "", rtf: mela("{\\rtf1\\ansi Only RTF here.\\par}") }),
    );
    expect(only.parsed.text).toContain("Only RTF here.");
    // A well-formed RTF with no text is an empty body, not a refusal.
    const empty = await parseMsg(makeMsg({ transportHeaders: true, rtfOnly: true, rtf: mela("{\\rtf1\\ansi}") }));
    expect(empty.parsed.text ?? "").toBe("");
    // Content that is not RTF refuses, and a malformed RTF beside a native body is never read.
    await expect(
      parseMsg(makeMsg({ transportHeaders: true, rtfOnly: true, rtf: mela("hello world, not rtf at all") })),
    ).rejects.toBeInstanceOf(ParseError);
    const native = await parseMsg(
      makeMsg({ transportHeaders: true, extraRtf: new TextEncoder().encode("not a stream, never read") }),
    );
    expect(native.parsed.text).toContain("Please pay");
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
      // An 8-bit attachment file name, which msgreader decodes (round 5): "Facture-\u20ac77.pdf" in code page 1252, where
      // the euro sign is 0x80 (read byte for byte it would be U+0080).
      const fileName = Uint8Array.from([
        ...new TextEncoder().encode("Facture-"),
        0x80,
        ...new TextEncoder().encode("77.pdf"),
      ]);
      const named = await parseMsg(
        makeMsg({
          transportHeaders: true,
          ansi: { subject: new TextEncoder().encode("Pay"), text: new TextEncoder().encode("Pay."), fileName },
        }),
      );
      expect(named.parsed.attachments[0]?.filename).toBe("Facture-\u20ac77.pdf");
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
          ansi: {
            subject: new TextEncoder().encode("Pay"),
            text,
            fileName: new TextEncoder().encode("\u0421\u0447\u0451\u0442.pdf"),
          },
          messageCodepage: 65001,
        }),
      );
      expect(parsed.text).toBe("Please pay \u20ac100 today. \u041f\u0440\u0438\u0432\u0435\u0442\r\n");
      expect(parsed.attachments[0]?.filename).toBe("\u0421\u0447\u0451\u0442.pdf");
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
      expect(loadMsgreaderConstants().MSG.FIELD.PREFIX).toEqual({
        ATTACHMENT: "__attach_version1.0",
        RECIPIENT: "__recip_version1.0",
        DOCUMENT: "__substg1.",
        NAMEID: "__nameid_version1.0",
      });
    });
  });

  describe("final review cases", () => {
    it("refuses a recurrence declaring more instances than it holds, and reads one that holds them", async () => {
      await expect(parseMsg(makeMsg({ transportHeaders: true, recurrence: { deleted: 33_554_432 } }))).rejects.toThrow(
        /recurrence in the .msg declares 33554432 deleted instances/,
      );
      const fits = await parseMsg(makeMsg({ transportHeaders: true, recurrence: { deleted: 0 } }));
      expect(fits.parsed.text).toContain("invoice 77");
    });

    it("leaves an embedded message without a display name unnamed, never undefined.msg", async () => {
      const { parsed } = await parseMsg(makeMsg({ transportHeaders: true, embeddedName: false }));
      expect(parsed.attachments[2]).toMatchObject({ filename: null, mediaType: "application/vnd.ms-outlook" });
      const named = await parseMsg(msgs.full);
      expect(named.parsed.attachments[2]?.filename).toBe("Earlier message from the supplier.msg");
    });

    it("cuts a multi-byte body at its last whole character", async () => {
      // "a" then two-byte characters, so byte 1,048,576 falls inside one.
      const text = new TextEncoder().encode(`a${"\u00e9".repeat(600_000)}`);
      const { parsed } = await parseMsg(
        makeMsg({
          transportHeaders: true,
          ansi: { subject: new TextEncoder().encode("Pay"), text },
          messageCodepage: 65001,
        }),
      );
      expect(parsed.text?.endsWith("\u00e9")).toBe(true);
      expect(new TextEncoder().encode(parsed.text ?? "").byteLength).toBe(BODY_PART_LIMIT - 1);
      expect(parsed.truncated[0]).toMatchObject({ charset: "utf-8", keptBytes: BODY_PART_LIMIT });
    });

    it("refuses a message class stream its property stream does not list", async () => {
      await expect(parseMsg(makeDecoyCompoundFile({ orphanClass: true }))).rejects.toThrow(/has no message class/);
    });

    it("reads an HTML body stored as an 8-bit string", async () => {
      const html8 = Uint8Array.from([
        ...new TextEncoder().encode("<p>Pay "),
        0x80,
        ...new TextEncoder().encode("100</p>"),
      ]);
      const { parsed } = await parseMsg(
        makeMsg({
          transportHeaders: true,
          ansi: { subject: new TextEncoder().encode("Pay"), text: new Uint8Array(0) },
          html8,
        }),
      );
      expect(parsed.html).toBe("<p>Pay \u20ac100</p>");
    });

    it("leaves a draft's case with headers_available 0 when the parser's answer is applied", async () => {
      const made = await createCase(env.DB, { orgId: "org-msg", channel: "email", headersAvailable: true });
      if (!made.ok) throw new Error(made.error.message);
      const { headersAvailable } = await parseMsg(msgs.draft);
      const set = await setHeadersAvailable(env.DB, made.value.id, headersAvailable);
      expect(set.ok).toBe(true);
      const row = await env.DB.prepare("SELECT headers_available FROM cases WHERE id = ?")
        .bind(made.value.id)
        .first<{ headers_available: number }>();
      expect(row?.headers_available).toBe(0);
    });
  });
});
