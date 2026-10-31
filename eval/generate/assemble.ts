// The synthetic message assembled in code (D08 T01 §3): headers written as Google Workspace records a delivered
// message (its own `Received` on top, its `Authentication-Results: mx.google.com` beneath, then the sender's hop),
// the authentication results set per scenario, the marker `X-IsItLegit-Synthetic: true`, the body the model wrote,
// and an attachment built in code. Pure: no file, clock or network, so the Worker-project test assembles the same
// bytes the set is written from.
import type { Generated } from "./realism.ts";
import { registrableOf, type Spec } from "./scenarios.ts";

// A fixed date per scenario, so a message assembles to the same bytes every time.
export function dateOf(spec: Spec): Date {
  // From the opaque token, never the id: a hash of the id's characters made the second of the Date separate the labels
  // (D08 T01 §7, round 1).
  const h = Number.parseInt(opaque(spec.id, "date").slice(0, 8), 16);
  return new Date(Date.UTC(2026, 9, 1 + (h % 28), 6 + (h % 11), h % 60, (h >> 6) % 60));
}

// SHA-256, pure and synchronous (WebCrypto is async and node:crypto is absent from the Workers runtime): the transport
// tokens must be a real hash, because FNV-1a kept the structure of the scenario id and its first hex digits separated
// the labels (D08 T01 §7, round 2).
const K = Uint32Array.from(
  "428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5 d807aa98 12835b01 243185be 550c7dc3 72be5d74 80deb1fe 9bdc06a7 c19bf174 e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da 983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967 27b70a85 2e1b2138 4d2c6dfc 53380d13 650a7354 766a0abb 81c2c92e 92722c85 a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070 19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3 748f82ee 78a5636f 84c87814 8cc70208 90befffa a4506ceb bef9a3f7 c67178f2"
    .split(" ")
    .map((h) => Number.parseInt(h, 16)),
);
export function sha256hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bytes.length * 8, false);
  view.setUint32(padded.length - 8, Math.floor((bytes.length * 8) / 2 ** 32), false);
  const h = Uint32Array.of(
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  );
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number;
      const b = w[i - 2] as number;
      w[i] =
        ((w[i - 16] as number) +
          (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) +
          (w[i - 7] as number) +
          (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>>
        0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[] as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i++) {
      const t1 =
        (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (K[i] as number) + (w[i] as number)) >>>
        0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const sum = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = ((h[i] as number) + (sum[i] as number)) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

// An opaque, label-free token for a scenario's transport identifiers (Message-ID, Received ids, MIME boundary,
// unsubscribe token) and its dates: the scenario id names its label and category, and a reader or model of the message
// must not be able to read either from a header (D08 T01 §7, completion review G2). 16 hex digits of a salted SHA-256.
export function opaque(id: string, salt: string): string {
  return sha256hex(`${salt}:${id}`).slice(0, 16);
}

// A message's content apart from its transport identifiers: the lines `opaque` and the date replaced and the MIME boundary are
// dropped, so a set written again keeps the second reading of a message whose content did not change.
export function contentIdentity(bytes: Uint8Array): string {
  return new TextDecoder()
    .decode(bytes)
    .split("\r\n")
    .filter((line) => !/^(Received|Message-ID|Date|List-Unsubscribe):/i.test(line))
    .join("\r\n")
    .replace(/=_isitlegit_[^\s";]+/g, "=_isitlegit_");
}

// The invoice date printed inside a genuine invoice's PDF: kept as it was first written (a hash of the scenario id), so
// the PDF bytes and the second readings of those messages stay. It is no header, and only genuine invoices carry the PDF.
function invoiceDateOf(spec: Spec): Date {
  let h = 0;
  for (const c of spec.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return new Date(Date.UTC(2026, 9, 1 + (h % 28), 6 + (h % 11), h % 60, (h >> 6) % 60));
}

const domainOf = (address: string) => address.split("@")[1] ?? "";
const mailbox = (m: { name: string; address: string }) => `"${m.name.replace(/"/g, "")}" <${m.address}>`;
// Base64 without Buffer, so the same code runs in the Workers runtime.
const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};
const wrap = (b64: string) => b64.replace(/.{1,76}/g, (line) => `${line}\r\n`).trimEnd();

// CRC-32 (ISO 3309), for the ZIP entries below.
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

// A ZIP archive of stored (uncompressed) entries, as Office Open XML files are packaged.
export function zipStored(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const n = enc.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + n.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    const head = new Uint8Array(46 + n.length);
    const hv = new DataView(head.buffer);
    hv.setUint32(0, 0x02014b50, true);
    hv.setUint16(4, 20, true);
    hv.setUint16(6, 20, true);
    hv.setUint32(16, crc, true);
    hv.setUint32(20, data.length, true);
    hv.setUint32(24, data.length, true);
    hv.setUint16(28, n.length, true);
    hv.setUint32(42, offset, true);
    head.set(n, 46);
    chunks.push(local, data);
    central.push(head);
    offset += local.length + data.length;
  }
  const size = central.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + size + 22);
  let at = 0;
  for (const c of [...chunks, ...central, end]) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// A one-page PDF invoice (ISO 32000-1: catalog, page tree, page, Helvetica, one text stream, cross-reference table):
// the supplier, the customer, the invoice number and the amount the body names.
export function invoicePdf(spec: Spec): Uint8Array {
  const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, " ").replace(/([\\()])/g, "\\$1");
  const lines = [
    `${spec.claimed}`,
    "TAX INVOICE",
    `Invoice: ${spec.details.invoice ?? ""}`,
    `Bill to: ${spec.recipient}`,
    `Date: ${invoiceDateOf(spec).toISOString().slice(0, 10)}`,
    `Amount due: ${spec.details.amount ?? ""}`,
    "Paid to the account on file. Thank you for your business.",
  ];
  const text = lines
    .map((l, i) => `BT /F1 ${i === 0 ? 16 : 11} Tf 72 ${760 - i * 24} Td (${ascii(l)}) Tj ET`)
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, body] of objects.entries()) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

// The attachment's bytes, made in code: a Windows executable's header, a macro-enabled Word document (its VBA project
// part holds no code), an HTML sign-in form, or a one-page PDF.
export function attachmentBytes(spec: Spec): Uint8Array {
  const kind = spec.attachment?.kind;
  if (kind === "macro") {
    const enc = new TextEncoder();
    return zipStored([
      {
        name: "[Content_Types].xml",
        data: enc.encode(
          '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/><Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>',
        ),
      },
      {
        name: "word/document.xml",
        data: enc.encode(
          '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Enable editing and content to view this invoice.</w:t></w:r></w:p></w:body></w:document>',
        ),
      },
      { name: "word/vbaProject.bin", data: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
    ]);
  }
  if (kind === "executable") {
    const bytes = new Uint8Array(512);
    bytes.set([0x4d, 0x5a, 0x90, 0x00, 0x03]); // "MZ": a DOS/PE executable
    bytes.set([0x50, 0x45, 0x00, 0x00], 0x80); // the PE signature where e_lfanew points
    new DataView(bytes.buffer).setUint32(0x3c, 0x80, true);
    return bytes;
  }
  if (kind === "html")
    return new TextEncoder().encode(
      `<!doctype html><html><head><title>${spec.claimed}</title></head><body><h1>${spec.claimed}</h1><form action="https://${domainOf(spec.from.address)}/collect" method="post"><label>Email <input name="email"></label><label>Password <input name="password" type="password"></label><button>View statement</button></form></body></html>`,
    );
  return invoicePdf(spec);
}

// The Authentication-Results Google writes for the scenario's results.
export function authResults(spec: Spec): string {
  const from = domainOf(spec.from.address);
  const mailfrom = spec.returnPath;
  const policy = "(p=REJECT sp=REJECT dis=NONE)";
  return [
    "mx.google.com",
    ` dkim=${spec.auth.dkim} header.i=@${from} header.s=s1 header.b=Q2s9vT1x`,
    ` spf=${spec.auth.spf} (google.com: domain of ${mailfrom} ${spec.auth.spf === "pass" ? "designates 198.51.100.24 as permitted sender" : "does not designate 203.0.113.77 as permitted sender"}) smtp.mailfrom=${mailfrom}`,
    ` dmarc=${spec.auth.dmarc} ${spec.auth.dmarc === "pass" ? policy : "(p=QUARANTINE sp=QUARANTINE dis=QUARANTINE)"} header.from=${from}`,
  ].join(";\r\n      ");
}

// The whole message, CRLF line endings, as bytes.
export function assemble(spec: Spec, generated: Generated): Uint8Array {
  const date = dateOf(spec);
  const sent = date.toUTCString().replace("GMT", "+0000");
  const sendingHost = `mail.${registrableOf(spec.returnPath)}`;
  const token = opaque(spec.id, "transport");
  const boundary = `=_isitlegit_${token}`;
  const headers = [
    `Received: by 2002:a05:6402:1a2b:b0:5c4:${token.slice(0, 2)}::1 with SMTP id s${token}; ${sent}`,
    `Authentication-Results: ${authResults(spec)}`,
    `Return-Path: <${spec.returnPath}>`,
    `Received: from ${sendingHost} (${sendingHost}. [${spec.auth.spf === "pass" ? "198.51.100.24" : "203.0.113.77"}]) by mx.google.com with ESMTPS id ${token.slice(2, 14)}.1; ${sent}`,
    `Received: from client by ${sendingHost} with ESMTP id q${token.slice(4, 10)}; ${sent}`,
    `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=${domainOf(spec.from.address)}; s=s1; h=from:to:subject:date; bh=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=; b=Q2s9vT1x`,
    `From: ${mailbox(spec.from)}`,
    `To: ${mailbox(spec.to)}`,
    ...(spec.replyTo ? [`Reply-To: ${mailbox(spec.replyTo)}`] : []),
    `Subject: ${generated.subject.replace(/[\r\n]+/g, " ").trim()}`,
    `Date: ${sent}`,
    `Message-ID: <${token}@${domainOf(spec.from.address)}>`,
    "MIME-Version: 1.0",
    ...(spec.category === "genuine-newsletter"
      ? [`List-Unsubscribe: <https://${domainOf(spec.from.address)}/unsubscribe?u=${token.slice(0, 12)}>`]
      : []),
    "X-IsItLegit-Synthetic: true",
  ];
  const text = `${generated.body.replace(/\r?\n/g, "\r\n").trim()}\r\n`;
  if (!spec.attachment)
    return new TextEncoder().encode(
      `${[...headers, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit"].join("\r\n")}\r\n\r\n${text}`,
    );
  const file = base64(attachmentBytes(spec));
  const parts = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    `--${boundary}`,
    `Content-Type: ${spec.attachment.mediaType}; name="${spec.attachment.filename}"`,
    `Content-Disposition: attachment; filename="${spec.attachment.filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap(file),
    `--${boundary}--`,
    "",
  ];
  return new TextEncoder().encode(
    `${[...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`].join("\r\n")}\r\n\r\n${parts.join("\r\n")}`,
  );
}
