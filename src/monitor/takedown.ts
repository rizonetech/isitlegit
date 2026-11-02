// The takedown pack (D05 T04 §5): everything a member needs to ask a registrar and a host to take
// a fake site down, built for them to send. We never contact either for them. Markdown and PDF
// carry the same content; the PDF embeds the settled screenshot, and a capture artefact that
// cannot be read states itself in both.
import type { Finding } from "./findings";
import type { RdapContacts } from "./rdap-contacts";

export type PackInput = {
  finding: Finding;
  contacts: RdapContacts;
  evidenceSummaries: string[];
  screenshotName: string | null;
};

export function takedownMarkdown(input: PackInput): string {
  const { finding, contacts } = input;
  const lines = [
    `# Takedown request: ${finding.host}`,
    "",
    `A site at ${finding.host} impersonates our business. It was first seen on ${finding.first_seen} and confirmed by IsItLegit's impersonation monitor.`,
    "",
    "## The domain",
    "",
    `- Domain: ${finding.host}`,
    `- Registrar: ${contacts.registrar ?? "not available from RDAP"}`,
    `- Registrar abuse contact: ${contacts.registrarAbuse ?? "not published in RDAP"}`,
    "",
    "## The hosting",
    "",
    `- IP address: ${contacts.ip ?? "not resolved"}`,
    `- Network: ${contacts.network ?? "not available from RDAP"}`,
    `- Hosting abuse contact: ${contacts.networkAbuse ?? "not published in RDAP"}`,
    "",
    "## Evidence",
    "",
    ...(input.evidenceSummaries.length
      ? input.evidenceSummaries.map((s) => `- ${s}`)
      : ["- The investigation evidence is on the case record."]),
    `- Screenshot: ${input.screenshotName ?? "the settled capture could not be read back"}`,
    "",
    "## What we ask",
    "",
    "Please suspend the domain and the hosting for this site. It impersonates our business and collects visitors' credentials or payments under our name.",
    "",
    "We have not sent this for you: send it to the abuse contacts above, keeping the screenshot and this pack attached.",
  ];
  if (contacts.unavailable.length)
    lines.push(
      "",
      `Some facts could not be read from RDAP (${contacts.unavailable.join(", ")}); the contacts shown are the ones RDAP published.`,
    );
  return `${lines.join("\n")}\n`;
}

const escPdf = (text: string) =>
  text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[^\x20-\x7E]/g, "?");

// A small production PDF: the pack text over pages, with the screenshot (a JPEG) embedded whole
// on its own page when it could be read. Objects are numbered as written; offsets are real.
export function takedownPdf(input: PackInput & { screenshotJpeg: Uint8Array | null }): Uint8Array {
  const text = takedownMarkdown(input);
  const perPage = 42;
  const allLines = text.split("\n").flatMap((line) => {
    const wrapped: string[] = [];
    for (let i = 0; i < Math.max(1, line.length); i += 88) wrapped.push(line.slice(i, i + 88));
    return wrapped;
  });
  const pages: string[][] = [];
  for (let i = 0; i < allLines.length; i += perPage) pages.push(allLines.slice(i, i + perPage));
  if (input.screenshotJpeg) pages.push(["Screenshot of the fake site (settled capture):"]);

  type Obj = { body: string } | { dict: string; stream: Uint8Array };
  const objects = new Map<number, Obj>();
  const encoder = new TextEncoder();
  let next = 3;
  const pageIds: number[] = [];
  for (let p = 0; p < pages.length; p++) pageIds.push(next++);
  const contentIds = pageIds.map(() => next++);
  const fontId = next++;
  const imageId = input.screenshotJpeg ? next++ : null;

  pageIds.forEach((id, p) => {
    const isShot = input.screenshotJpeg && p === pages.length - 1;
    objects.set(id, {
      body: `<</Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources <</Font <</F1 ${fontId} 0 R>>${isShot && imageId ? ` /XObject <</Im1 ${imageId} 0 R>>` : ""}>> /Contents ${contentIds[p]} 0 R>>`,
    });
    const lines = (pages[p] as string[]).map((line, i) => `BT /F1 10 Tf 40 ${800 - i * 16} Td (${escPdf(line)}) Tj ET`);
    if (isShot) lines.push("q 515 0 0 360 40 420 cm /Im1 Do Q");
    objects.set(contentIds[p] as number, {
      dict: `<</Length ${encoder.encode(lines.join("\n")).byteLength}>>`,
      stream: encoder.encode(lines.join("\n")),
    });
  });
  objects.set(fontId, { body: "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>" });
  if (imageId && input.screenshotJpeg)
    objects.set(imageId, {
      dict: `<</Type /XObject /Subtype /Image /Width 1280 /Height 800 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${input.screenshotJpeg.byteLength}>>`,
      stream: input.screenshotJpeg,
    });
  objects.set(1, { body: "<</Type /Catalog /Pages 2 0 R>>" });
  objects.set(2, {
    body: `<</Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length}>>`,
  });

  const chunks: Uint8Array[] = [encoder.encode("%PDF-1.4\n")];
  const offsets = new Map<number, number>();
  let at = 15;
  const push = (bytes: Uint8Array) => {
    chunks.push(bytes);
    at += bytes.byteLength;
  };
  // Header is 9 bytes plus newline counted above as 15 with the binary comment line.
  at = chunks[0]?.byteLength ?? 0;
  for (const id of [...objects.keys()].sort((a, b) => a - b)) {
    offsets.set(id, at);
    const value = objects.get(id) as Obj;
    if ("body" in value) {
      push(encoder.encode(`${id} 0 obj\n${value.body}\nendobj\n`));
    } else {
      push(encoder.encode(`${id} 0 obj\n${value.dict}\nstream\n`));
      push(value.stream);
      push(encoder.encode("\nendstream\nendobj\n"));
    }
  }
  const xrefAt = at;
  const size = Math.max(...objects.keys()) + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i < size; i++) xref += `${String(offsets.get(i) ?? 0).padStart(10, "0")} 00000 n \n`;
  push(encoder.encode(`${xref}trailer\n<</Size ${size} /Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`));
  const out = new Uint8Array(at);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.byteLength;
  }
  return out;
}
