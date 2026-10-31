// The synthetic message assembled in code (D08 T01 §3): headers written as Google Workspace records a delivered
// message (its own `Received` on top, its `Authentication-Results: mx.google.com` beneath, then the sender's hop),
// the authentication results set per scenario, the marker `X-IsItLegit-Synthetic: true`, the body the model wrote,
// and an attachment built in code. Pure: no file, clock or network, so the Worker-project test assembles the same
// bytes the set is written from.
import type { Generated } from "./realism.ts";
import { registrableOf, type Spec } from "./scenarios.ts";

// A fixed date per scenario, so a message assembles to the same bytes every time.
export function dateOf(spec: Spec): Date {
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

// The attachment's bytes, made in code: a Windows executable's header, an HTML sign-in form, or a one-page PDF.
export function attachmentBytes(spec: Spec): Uint8Array {
  const kind = spec.attachment?.kind;
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
  return new TextEncoder().encode("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
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
  const boundary = `=_isitlegit_${spec.id}`;
  const headers = [
    `Received: by 2002:a05:6402:1a2b:b0:5c4:${spec.id.length.toString(16)}::1 with SMTP id s${spec.id.replace(/[^a-z0-9]/g, "")}; ${sent}`,
    `Authentication-Results: ${authResults(spec)}`,
    `Return-Path: <${spec.returnPath}>`,
    `Received: from ${sendingHost} (${sendingHost}. [${spec.auth.spf === "pass" ? "198.51.100.24" : "203.0.113.77"}]) by mx.google.com with ESMTPS id ${spec.id.replace(/[^a-z0-9]/g, "")}.1; ${sent}`,
    `Received: from client by ${sendingHost} with ESMTP id q${spec.id.length}; ${sent}`,
    `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=${domainOf(spec.from.address)}; s=s1; h=from:to:subject:date; bh=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=; b=Q2s9vT1x`,
    `From: ${mailbox(spec.from)}`,
    `To: ${mailbox(spec.to)}`,
    ...(spec.replyTo ? [`Reply-To: ${mailbox(spec.replyTo)}`] : []),
    `Subject: ${generated.subject.replace(/[\r\n]+/g, " ").trim()}`,
    `Date: ${sent}`,
    `Message-ID: <${spec.id}@${domainOf(spec.from.address)}>`,
    "MIME-Version: 1.0",
    ...(spec.category === "genuine-newsletter"
      ? [`List-Unsubscribe: <https://${domainOf(spec.from.address)}/unsubscribe?u=${spec.id}>`]
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
