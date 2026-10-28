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
      view.setUint32(at + 8, p.value.length + (p.type === PT_UNICODE ? 2 : 0), true);
      const id = `${p.tag.toString(16).padStart(4, "0")}${p.type.toString(16).padStart(4, "0")}`.toUpperCase();
      CFB.utils.cfb_add(cfb, `${path}__substg1.0_${id}`, p.value);
    }
  });
  CFB.utils.cfb_add(cfb, `${path}__properties_version1.0`, entries);
}

// `bodyRepeat` repeats the text body that many times, for the body limits (D01 T01 §5).
export type Variant = { transportHeaders: boolean; rtfOnly?: boolean; bodyRepeat?: number };

export function makeMsg({ transportHeaders, rtfOnly = false, bodyRepeat = 1 }: Variant): Uint8Array {
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
    unicode(0x0037, SUBJECT),
    unicode(0x0c1a, FROM_NAME),
    unicode(0x0c1f, FROM),
    unicode(0x0c1e, "SMTP"),
    unicode(0x0e04, `${TO_NAME} <${TO}>`),
    ...(rtfOnly
      ? // Only a compressed RTF body: the "MELA" (uncompressed) form of [MS-OXRTFCP], no text and no HTML.
        [binary(0x1009, rtfUncompressed("{\\rtf1\\ansi Please pay invoice 77 today.\\par}"))]
      : [unicode(0x1000, TEXT.repeat(bodyRepeat)), binary(0x1013, cp1252(HTML)), long(0x3fde, 1252)]),
    ...(transportHeaders ? [unicode(0x007d, TRANSPORT_HEADERS)] : []),
  ]);
  addProperties(cfb, "/__recip_version1.0_#00000000/", new Uint8Array(8), [
    long(0x0c15, 1),
    unicode(0x3001, TO_NAME),
    unicode(0x3003, TO),
    unicode(0x39fe, TO),
  ]);
  if (!rtfOnly) {
    addProperties(cfb, "/__attach_version1.0_#00000000/", new Uint8Array(8), [
      long(0x3705, 1),
      unicode(0x3707, "invoice-77.pdf"),
      unicode(0x3704, "invoice-77.pdf"),
      unicode(0x370e, "application/pdf"),
      binary(0x3701, PDF),
    ]);
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
    addProperties(cfb, embedded, new Uint8Array(8), [long(0x3705, 5), unicode(0x3001, EMBEDDED_SUBJECT)]);
    addProperties(cfb, `${embedded}__substg1.0_3701000D/`, new Uint8Array(24), [
      unicode(0x001a, "IPM.Note"),
      unicode(0x0037, EMBEDDED_SUBJECT),
      unicode(0x0c1f, FROM),
      unicode(0x1000, "The earlier message.\r\n"),
    ]);
  }
  CFB.utils.cfb_add(cfb, "/__nameid_version1.0/__substg1.0_00020102", new Uint8Array(0));
  return new Uint8Array(CFB.write(cfb, { type: "buffer" }) as Uint8Array);
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
    "invoice-request.eml": new TextEncoder().encode(TWIN),
  };
}
