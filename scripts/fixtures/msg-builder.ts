// Builds the synthetic Outlook .msg fixtures and the .eml twin they are compared with (D01 T01 §6), with no file system,
// so the Worker tests can build a variant (a large body) as well as the generator writing the committed files
// (scripts/fixtures/make-msg.ts). Everything comes from fictional senders on .example domains; no real mail is ever used
// (AGENTS.md). A .msg is an OLE compound file holding MAPI properties ([MS-OXMSG]): fixed-size values in each storage's
// `__properties_version1.0` stream, variable-size ones in their own `__substg1.0_<tag>` streams, one storage per
// recipient and per attachment.
import CFB from "cfb";

const SUBJECT = "Updated banking details for invoice 77";
const FROM_NAME = "Fictional Supplier";
const FROM = "billing@fictional-supplier.example";
const TO_NAME = "Accounts";
const TO = "accounts@fictional-recipient.example";
const TEXT = "Please pay invoice 77 into our new account from today.\r\n";
// Non-ASCII text in the HTML, stored as code page 1252 bytes (PidTagInternetCodepage), as Outlook does.
const HTML =
  '<html><body><p>Please pay invoice 77 into our new account from today. Caf\u00e9 S\u00e3o Paulo.</p><img src="cid:logo77@fictional"></body></html>';
const cp1252 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7]);
const EMBEDDED_SUBJECT = "Earlier message from the supplier";
const PDF = new TextEncoder().encode("%PDF-1.4\n% fictional invoice 77\n%%EOF\n");
const TRANSPORT_HEADERS = [
  "Received: from mx.fictional-recipient.example by store.fictional-recipient.example; Tue, 27 Oct 2026 08:00:01 +0200",
  "Received: from mail.fictional-supplier.example by mx.fictional-recipient.example; Tue, 27 Oct 2026 08:00:00 +0200",
  "Authentication-Results: mx.fictional-recipient.example; spf=pass smtp.mailfrom=billing@fictional-supplier.example",
  `From: ${FROM_NAME} <${FROM}>`,
  `To: ${TO_NAME} <${TO}>`,
  `Subject: ${SUBJECT}`,
  "Message-ID: <invoice-77@fictional-supplier.example>",
  "Date: Tue, 27 Oct 2026 08:00:00 +0200",
  "MIME-Version: 1.0",
  "",
  "",
].join("\r\n");

const utf16 = (text: string) => {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    out[i * 2] = text.charCodeAt(i) & 0xff;
    out[i * 2 + 1] = text.charCodeAt(i) >> 8;
  }
  return out;
};

type Property = { tag: number; type: number; value: Uint8Array | number };
const PT_LONG = 0x0003;
const PT_UNICODE = 0x001f;
const PT_BINARY = 0x0102;
const PT_STRING8 = 0x001e;
const unicode = (tag: number, text: string): Property => ({ tag, type: PT_UNICODE, value: utf16(text) });
const binary = (tag: number, bytes: Uint8Array): Property => ({ tag, type: PT_BINARY, value: bytes });
const long = (tag: number, value: number): Property => ({ tag, type: PT_LONG, value });

// One storage's properties: the fixed-size entries in its properties stream (after a header of `headerBytes`), the
// variable-size values in substg streams.
function addProperties(cfb: CFB.CFB$Container, path: string, header: Uint8Array, properties: Property[]) {
  const entries = new Uint8Array(header.length + properties.length * 16);
  entries.set(header);
  const view = new DataView(entries.buffer);
  properties.forEach((p, i) => {
    const at = header.length + i * 16;
    view.setUint32(at, ((p.tag << 16) | p.type) >>> 0, true);
    view.setUint32(at + 4, 0x6, true);
    if (typeof p.value === "number") view.setUint32(at + 8, p.value, true);
    else {
      view.setUint32(at + 8, p.value.length + (p.type === PT_UNICODE ? 2 : p.type === PT_STRING8 ? 1 : 0), true);
      const id = `${p.tag.toString(16).padStart(4, "0")}${p.type.toString(16).padStart(4, "0")}`.toUpperCase();
      CFB.utils.cfb_add(cfb, `${path}__substg1.0_${id}`, p.value);
    }
  });
  CFB.utils.cfb_add(cfb, `${path}__properties_version1.0`, entries);
}

// `bodyRepeat` repeats the text body that many times, for the body limits (D01 T01 §5).
// `bodyRepeat` and `htmlRepeat` repeat the text and HTML bodies (§5's limits); `ansi` writes the subject and text as 8-bit
// strings in `messageCodepage` (1252 by default) instead of Unicode; `html` and `internetCodepage` replace the HTML body
// and its code page; `binaryHeaders` stores the transport headers as binary, a malformed property; `subject` replaces the
// subject; `pdf` changes the first attachment: only a short file name, its file name stored as binary, or an OLE object
// (attach method 6, a Word document storage) in its place.
export type Variant = {
  transportHeaders: boolean;
  rtfOnly?: boolean;
  // The compressed-RTF stream for an rtfOnly message (the MELA default otherwise), and one stored beside
  // the native bodies.
  rtf?: Uint8Array;
  extraRtf?: Uint8Array;
  bodyRepeat?: number;
  htmlRepeat?: number;
  // `fileName` gives the first attachment an 8-bit file name in the same code page (msgreader decodes it).
  ansi?: { subject: Uint8Array; text: Uint8Array; fileName?: Uint8Array };
  messageCodepage?: number;
  html?: Uint8Array;
  internetCodepage?: number;
  binaryHeaders?: boolean;
  subject?: string;
  pdf?: "short-name" | "binary-name" | "ole";
  // A named-property map whose one string name, `nameBytes` long, `references` entries point at; and a named property's
  // binary value of `namedBinary` bytes.
  names?: { nameBytes: number; references: number };
  namedBinary?: number;
  // A recurrence (PidLidAppointmentRecur, a numeric named property 0x8216) declaring `deleted` deleted instances it
  // does not hold; the embedded message without its display name; the HTML body as an 8-bit string instead of binary.
  recurrence?: { deleted: number };
  embeddedName?: boolean;
  html8?: Uint8Array;
};

export function makeMsg({
  transportHeaders,
  rtfOnly = false,
  rtf,
  extraRtf,
  bodyRepeat = 1,
  htmlRepeat = 1,
  ansi,
  messageCodepage,
  html,
  internetCodepage,
  binaryHeaders = false,
  subject = SUBJECT,
  pdf,
  names,
  namedBinary,
  recurrence,
  embeddedName = true,
  html8,
}: Variant): Uint8Array {
  const cfb = CFB.utils.cfb_new();
  // The top-level header: 8 reserved bytes, next recipient id, next attachment id, recipient count, attachment count,
  // 8 reserved bytes.
  const top = new Uint8Array(32);
  const topView = new DataView(top.buffer);
  const attachments = rtfOnly ? 0 : 3;
  topView.setUint32(8, 1, true);
  topView.setUint32(12, attachments, true);
  topView.setUint32(16, 1, true);
  topView.setUint32(20, attachments, true);
  addProperties(cfb, "/", top, [
    unicode(0x001a, "IPM.Note"),
    // PidTagStoreSupportMask: STORE_UNICODE_OK, so readers take the Unicode strings as Unicode ([MS-OXMSG] 2.1.3); an
    // 8-bit message leaves it out and names its code page instead.
    ...(ansi
      ? [
          { tag: 0x0037, type: PT_STRING8, value: ansi.subject },
          { tag: 0x1000, type: PT_STRING8, value: ansi.text },
          long(0x3ffd, messageCodepage ?? 1252),
        ]
      : [
          long(0x340d, 0x00040000),
          unicode(0x0037, subject),
          ...(messageCodepage ? [long(0x3ffd, messageCodepage)] : []),
        ]),
    unicode(0x0c1a, FROM_NAME),
    unicode(0x0c1f, FROM),
    unicode(0x0c1e, "SMTP"),
    unicode(0x0e04, `${TO_NAME} <${TO}>`),
    ...(rtfOnly
      ? // Only a compressed RTF body: the "MELA" (uncompressed) form of [MS-OXRTFCP], no text and no HTML.
        [binary(0x1009, rtf ?? rtfUncompressed("{\\rtf1\\ansi Please pay invoice 77 today.\\par}"))]
      : [
          ...(ansi ? [] : [unicode(0x1000, TEXT.repeat(bodyRepeat))]),
          html8
            ? { tag: 0x1013, type: PT_STRING8, value: html8 }
            : binary(0x1013, html ?? cp1252(HTML.repeat(htmlRepeat))),
          long(0x3fde, internetCodepage ?? 1252),
          ...(extraRtf ? [binary(0x1009, extraRtf)] : []),
        ]),
    ...(transportHeaders
      ? [
          binaryHeaders
            ? binary(0x007d, new TextEncoder().encode(TRANSPORT_HEADERS))
            : unicode(0x007d, TRANSPORT_HEADERS),
        ]
      : []),
  ]);
  addProperties(cfb, "/__recip_version1.0_#00000000/", new Uint8Array(8), [
    long(0x0c15, 1),
    unicode(0x3001, TO_NAME),
    unicode(0x3003, TO),
    unicode(0x39fe, TO),
  ]);
  if (!rtfOnly) {
    addProperties(
      cfb,
      "/__attach_version1.0_#00000000/",
      new Uint8Array(8),
      pdf === "ole"
        ? [long(0x3705, 6), unicode(0x3707, "payment.doc"), unicode(0x370e, "application/msword")]
        : [
            long(0x3705, 1),
            ...(pdf === "short-name"
              ? []
              : [
                  pdf === "binary-name"
                    ? binary(0x3707, new TextEncoder().encode("bad.pdf"))
                    : ansi?.fileName
                      ? { tag: 0x3707, type: PT_STRING8, value: ansi.fileName }
                      : unicode(0x3707, "invoice-77.pdf"),
                ]),
            unicode(0x3704, pdf === "short-name" ? "INV77.PDF" : "invoice-77.pdf"),
            unicode(0x370e, "application/pdf"),
            binary(0x3701, PDF),
          ],
    );
    // An OLE object's data is a storage of its own ([MS-OXMSG] 2.2.2.1), here a Word document's main stream.
    if (pdf === "ole")
      CFB.utils.cfb_add(cfb, "/__attach_version1.0_#00000000/__substg1.0_3701000D/WordDocument", cp1252("Word bytes"));
    // An inline image the HTML names by content id.
    addProperties(cfb, "/__attach_version1.0_#00000001/", new Uint8Array(8), [
      long(0x3705, 1),
      unicode(0x3707, "logo.png"),
      unicode(0x370e, "image/png"),
      unicode(0x3712, "logo77@fictional"),
      binary(0x3701, PNG),
    ]);
    // An embedded Outlook message (attach method 5): a message storage of its own inside the attachment.
    const embedded = "/__attach_version1.0_#00000002/";
    addProperties(cfb, embedded, new Uint8Array(8), [
      long(0x3705, 5),
      ...(embeddedName ? [unicode(0x3001, EMBEDDED_SUBJECT)] : []),
    ]);
    addProperties(cfb, `${embedded}__substg1.0_3701000D/`, new Uint8Array(24), [
      unicode(0x001a, "IPM.Note"),
      unicode(0x0037, EMBEDDED_SUBJECT),
      unicode(0x0c1f, FROM),
      unicode(0x1000, "The earlier message.\r\n"),
    ]);
  }
  if (names) {
    // [MS-OXMSG] 2.2.3: the GUID stream, the string stream (a 4-byte length, then the name in UTF-16LE) and 8-byte
    // entries (the name's offset, then a word whose bit 0 marks a string name, then the property index).
    const strings = new Uint8Array(4 + names.nameBytes).fill(0x78);
    new DataView(strings.buffer).setUint32(0, names.nameBytes, true);
    for (let i = 4; i < strings.length; i += 2) strings[i + 1] = 0;
    const entries = new Uint8Array(8 * names.references);
    for (let i = 0; i < names.references; i++) {
      new DataView(entries.buffer).setUint16(8 * i + 4, 5, true);
      new DataView(entries.buffer).setUint16(8 * i + 6, i, true);
    }
    CFB.utils.cfb_add(cfb, "/__nameid_version1.0/__substg1.0_00020102", new Uint8Array(16));
    CFB.utils.cfb_add(cfb, "/__nameid_version1.0/__substg1.0_00030102", entries);
    CFB.utils.cfb_add(cfb, "/__nameid_version1.0/__substg1.0_00040102", strings);
  } else if (recurrence) {
    // One numeric entry: id 0x8216 in the GUID stream's first set (PSETID_Appointment), property index 0, so the value
    // is __substg1.0_80000102: a daily pattern, versions 0x3004, then the counts ([MS-OXOCAL] 2.2.1.44.1).
    const guid = Uint8Array.from([0x02, 0x20, 0x06, 0x00, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46]);
    const entries = new Uint8Array(8);
    new DataView(entries.buffer).setUint32(0, 0x8216, true);
    new DataView(entries.buffer).setUint16(4, 3 << 1, true);
    const blob = new Uint8Array(22 + 12 + 4 + 4 + 8);
    const view = new DataView(blob.buffer);
    view.setUint16(0, 0x3004, true);
    view.setUint16(2, 0x3004, true);
    view.setUint32(34, recurrence.deleted, true);
    CFB.utils.cfb_add(cfb, "/__nameid_version1.0/__substg1.0_00020102", guid);
    CFB.utils.cfb_add(cfb, "/__nameid_version1.0/__substg1.0_00030102", entries);
    CFB.utils.cfb_add(cfb, "/__nameid_version1.0/__substg1.0_00040102", new Uint8Array(0));
    CFB.utils.cfb_add(cfb, "/__substg1.0_80000102", blob);
  } else CFB.utils.cfb_add(cfb, "/__nameid_version1.0/__substg1.0_00020102", new Uint8Array(0));
  if (namedBinary) CFB.utils.cfb_add(cfb, "/__substg1.0_80000102", new Uint8Array(namedBinary));
  return new Uint8Array(CFB.write(cfb, { type: "buffer" }) as Uint8Array);
}

// A compound file that is not a message: a Word document's stream beside a decoy body stream, with no property stream
// and no message class, renamed .msg.
// With `orphanClass`, it also has an empty property stream and a message class stream the property stream does not list.
export function makeDecoyCompoundFile({ orphanClass = false } = {}): Uint8Array {
  const cfb = CFB.utils.cfb_new();
  if (orphanClass) {
    CFB.utils.cfb_add(cfb, "/__properties_version1.0", new Uint8Array(32));
    CFB.utils.cfb_add(cfb, "/__substg1.0_001A001F", utf16("IPM.Note"));
  }
  CFB.utils.cfb_add(cfb, "/__substg1.0_1000001F", utf16("Nothing to see here.\r\n"));
  CFB.utils.cfb_add(cfb, "/WordDocument", cp1252("Word bytes ".repeat(500)));
  return new Uint8Array(CFB.write(cfb, { type: "buffer" }) as Uint8Array);
}

// A copy of a .msg whose directory entry named `from` is renamed `to` (at most 31 characters), as a malformed file
// would name it ([MS-CFB] 2.6: the name in UTF-16LE at the entry's start, its byte length with the NUL at offset 64).
export function renameEntry(msg: Uint8Array, from: string, to: string): Uint8Array {
  const renamed = msg.slice();
  const needle = utf16(from);
  for (let i = 0; i + needle.length <= renamed.length; i++) {
    if (renamed.subarray(i, i + needle.length).every((b, k) => b === needle[k])) {
      renamed.fill(0, i, i + 64);
      renamed.set(utf16(to), i);
      new DataView(renamed.buffer).setUint16(i + 64, utf16(to).length + 2, true);
      return renamed;
    }
  }
  throw new Error(`no directory entry named ${from}`);
}

// A copy of a .msg whose directory entry named `name` declares `size` bytes ([MS-CFB] 2.6: a 128-byte entry, the name in
// UTF-16LE at its start, the stream size at offset 120), as a hostile file would.
function forgeSize(msg: Uint8Array, name: string, size: number): Uint8Array {
  const forged = msg.slice();
  const needle = utf16(name);
  for (let i = 0; i + needle.length <= forged.length; i++) {
    if (forged.subarray(i, i + needle.length).every((b, k) => b === needle[k])) {
      new DataView(forged.buffer).setUint32(i + 120, size, true);
      return forged;
    }
  }
  throw new Error(`no directory entry named ${name}`);
}

// A well-formed .msg holding only its message class: no subject, body, headers or attachments.
function makeEmptyMsg(): Uint8Array {
  const cfb = CFB.utils.cfb_new();
  addProperties(cfb, "/", new Uint8Array(32), [unicode(0x001a, "IPM.Note")]);
  CFB.utils.cfb_add(cfb, "/__nameid_version1.0/__substg1.0_00020102", new Uint8Array(0));
  return new Uint8Array(CFB.write(cfb, { type: "buffer" }) as Uint8Array);
}

// A compressed RTF stream in its uncompressed form ([MS-OXRTFCP] 2.1.3.1: COMPSIZE, RAWSIZE, "MELA", CRC 0, then the RTF).
function rtfUncompressed(rtf: string): Uint8Array {
  const body = new TextEncoder().encode(rtf);
  const out = new Uint8Array(16 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length + 12, true);
  view.setUint32(4, body.length, true);
  view.setUint32(8, 0x414c454d, true);
  view.setUint32(12, 0, true);
  out.set(body, 16);
  return out;
}

// The same message as a MIME message: the twin a .msg's parse is compared with field by field.
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const TWIN = [
  TRANSPORT_HEADERS.trimEnd(),
  'Content-Type: multipart/mixed; boundary="mixed"',
  "",
  "--mixed",
  'Content-Type: multipart/alternative; boundary="alt"',
  "",
  "--alt",
  "Content-Type: text/plain; charset=utf-8",
  "",
  TEXT.trimEnd(),
  "--alt",
  "Content-Type: text/html; charset=windows-1252",
  "Content-Transfer-Encoding: base64",
  "",
  b64(cp1252(HTML)),
  "--alt--",
  "--mixed",
  'Content-Type: application/pdf; name="invoice-77.pdf"',
  'Content-Disposition: attachment; filename="invoice-77.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  b64(PDF),
  "--mixed--",
  "",
].join("\r\n");

// Every fixture by name, so a test can regenerate them and compare with the committed files.
export function fixtures(): Record<string, Uint8Array> {
  const full = makeMsg({ transportHeaders: true });
  return {
    "invoice-request.msg": full,
    "invoice-request-draft.msg": makeMsg({ transportHeaders: false }),
    "rtf-only.msg": makeMsg({ transportHeaders: true, rtfOnly: true }),
    "not-a-msg.msg": new TextEncoder().encode("This is a plain text file renamed to .msg.\r\n"),
    "truncated.msg": full.subarray(0, 1024),
    "empty.msg": makeEmptyMsg(),
    // 8-bit strings in code page 1252: "Pay \u20ac100" is 0x80 for the euro sign there.
    "ansi.msg": makeMsg({
      transportHeaders: true,
      ansi: {
        subject: Uint8Array.from([...cp1252("Pay "), 0x80, ...cp1252("100")]),
        text: Uint8Array.from([...cp1252("Please pay "), 0x80, ...cp1252("100 today.\r\n")]),
      },
    }),
    // HTML in ISO-8859-5 (code page 28595): "\u041f\u0440\u0438\u0432\u0435\u0442".
    "cyrillic-html.msg": makeMsg({
      transportHeaders: true,
      html: Uint8Array.from([...cp1252("<p>"), 0xbf, 0xe0, 0xd8, 0xd2, 0xd5, 0xe2, ...cp1252("</p>")]),
      internetCodepage: 28595,
    }),
    "malformed-headers.msg": makeMsg({ transportHeaders: true, binaryHeaders: true }),
    "forged-size.msg": forgeSize(full, "__substg1.0_1000001F", 0x10000000),
    "invoice-request.eml": new TextEncoder().encode(TWIN),
  };
}
