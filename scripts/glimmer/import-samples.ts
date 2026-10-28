// The pilot client's sample mail as Loupe training pages (D03 T04 §7).
//
//   node scripts/glimmer/import-samples.ts inventory    # counts only: no names, subjects or addresses
//   node scripts/glimmer/import-samples.ts import       # redact, render inertly and store every HTML attachment and body
//   node scripts/glimmer/import-samples.ts leak-check   # scan every stored sample page for the client's details
//
// Reads `samples/` (git-ignored; linked into this worktree from the main checkout). Runs only while
// `samples/pilot-consent.md` holds the "Extension: Fireworks training (2026-10-28 15:16 SAST)" section. Each HTML
// attachment and HTML body is redacted (`redact.ts`) before it is rendered, so the screenshot and the text both carry
// the placeholders, and is stored with `origin: samples`, `redacted: true`. Labels: an operator-labelled message
// (`manifest.csv`) is ground truth; a quarantined message's Microsoft verdict in its file name is a lure, ground truth
// when `HighConfPhish` and `unverified` when `Phish`; a `Spam` or `Bulk` verdict leaves `lure` unset.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import PostalMime, { type Email } from "postal-mime";
import { importSource, type SourceItem } from "./import-source.ts";
import { namePieces, redact } from "./redact.ts";
import { openTextReader } from "./source-pages.ts";
import { openStore, type StoredPage, storeDir } from "./store.ts";

const ROOT = resolve(import.meta.dirname, "../..");
export const CONSENT_HEADING = "Extension: Fireworks training (2026-10-28 15:16 SAST)";
export const LICENCE = "pilot client consent, 2026-10-28";

export function assertConsent(samples: string): void {
  const file = join(samples, "pilot-consent.md");
  if (!existsSync(file) || !readFileSync(file, "utf-8").includes(CONSENT_HEADING))
    throw new Error(`refused: ${file} has no "${CONSENT_HEADING}" section; no sample is read without it`);
}

export type Label = { lure?: boolean; source: "ground-truth" | "unverified" | "none" };

// A message's label: the manifest's (listed by its path under samples/, like `gmail/x.eml`), else the Microsoft
// verdict in a quarantine file name.
export function labelOf(file: string, manifest: Map<string, string>): Label {
  const listed = manifest.get(file);
  if (listed === "attack") return { lure: true, source: "ground-truth" };
  if (listed === "genuine") return { lure: false, source: "ground-truth" };
  const verdict = /_([A-Za-z]+)\.eml$/.exec(file)?.[1];
  // Microsoft's high-confidence phishing verdict counts as ground truth (operator, 2026-10-28 21:41 SAST), which gives
  // the evaluation its South African lures; a plain `Phish` verdict stays unverified: trained on, never evaluated.
  if (verdict === "HighConfPhish") return { lure: true, source: "ground-truth" };
  if (verdict === "Phish") return { lure: true, source: "unverified" };
  return { source: "none" }; // Spam, Bulk or no verdict: §9 decides
}

export function readManifest(samples: string): Map<string, string> {
  const file = join(samples, "manifest.csv");
  const out = new Map<string, string>();
  if (!existsSync(file)) return out;
  const [header, ...rows] = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const columns = (header ?? "").split(",");
  const at = (name: string) => columns.indexOf(name);
  for (const row of rows) {
    const cells = row.split(",");
    out.set(cells[at("file")] ?? "", cells[at("label")] ?? "");
  }
  return out;
}

// Every message in every folder under samples/ (a client set's folder is named after the client, so the code names
// none of them), as its path under samples/.
export function messageFiles(samples: string): string[] {
  return readdirSync(samples, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((folder) => !folder.startsWith(".") && statSync(join(samples, folder)).isDirectory())
    .sort()
    .flatMap((folder) =>
      readdirSync(join(samples, folder))
        .filter((name) => name.endsWith(".eml"))
        .sort()
        .map((name) => `${folder}/${name}`),
    );
}

const HTML_NAME = /\.(s?html?)$/i;

export function htmlAttachments(email: Email): string[] {
  return email.attachments
    .filter((a) => a.mimeType === "text/html" || HTML_NAME.test(a.filename ?? ""))
    .filter((a) => a.disposition === "attachment" || HTML_NAME.test(a.filename ?? ""))
    .map((a) => (typeof a.content === "string" ? a.content : new TextDecoder().decode(a.content)));
}

// The HTML body with each `cid:` image put back as a data URI, so a brand's logo survives a render with no network.
export function bodyWithImages(email: Email): string | null {
  if (!email.html) return null;
  let html = email.html;
  for (const part of email.attachments) {
    const id = part.contentId?.replace(/^<|>$/g, "");
    if (!id || typeof part.content === "string") continue;
    const data = `data:${part.mimeType};base64,${Buffer.from(new Uint8Array(part.content)).toString("base64")}`;
    html = html.split(`cid:${id}`).join(data);
  }
  return html;
}

// The names to redact: every recipient's name pieces and the client names file.
export function recipientNames(email: Email, raw: string, clientNames: string[]): string[] {
  const people = [...(email.to ?? []), ...(email.cc ?? [])].flatMap((a) =>
    "group" in a && a.group ? a.group : [a as { name?: string; address?: string }],
  );
  const delivered = [...raw.matchAll(/^Delivered-To:\s*(\S+@\S+)/gim)].map((m) => ({ name: "", address: m[1] }));
  return [...clientNames, ...[...people, ...delivered].flatMap((p) => namePieces(p.name, p.address))];
}

export function addresses(email: Email, raw: string): string[] {
  const people = [...(email.to ?? []), ...(email.cc ?? [])].flatMap((a) =>
    "group" in a && a.group ? a.group : [a as { address?: string }],
  );
  const delivered = [...raw.matchAll(/^Delivered-To:\s*(\S+@\S+)/gim)].map((m) => m[1] ?? "");
  return [...people.map((p) => p.address ?? ""), ...delivered].filter(Boolean).map((a) => a.toLowerCase());
}

// The client's own domains: every recipient address's domain that is not a public mail provider.
export function clientDomains(recipientAddresses: string[]): string[] {
  const publicMail = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|aol|proton|protonmail)\./;
  return [...new Set(recipientAddresses.map((a) => a.split("@")[1] ?? ""))].filter((d) => d && !publicMail.test(d));
}

// What must never reach a stored sample page: client names, recipient addresses and the client's domains.
export function protectedTerms(clientNames: string[], recipientAddresses: string[]): string[] {
  return [...clientNames, ...recipientAddresses, ...clientDomains(recipientAddresses)];
}

// A sample's HTML redacted, then rendered, then checked: an address split by tags in the source can join up again on
// render, so a page whose text still holds a client detail is refused, never stored.
export async function renderRedacted<T extends { text: string }>(
  render: (html: string) => Promise<T>,
  html: string,
  names: string[],
  terms: string[],
): Promise<T> {
  const page = await render(redact(html, names));
  if (leaks([{ id: "page", text: page.text }], terms).length) throw new Error("a client detail survived redaction");
  return page;
}

// Every stored sample page whose text holds a client name, a recipient address or the client's domain.
export function leaks(pages: { id: string; text: string }[], terms: string[]): { id: string; term: string }[] {
  const wanted = [...new Set(terms.map((t) => t.toLowerCase()).filter((t) => t.length >= 3))];
  return pages.flatMap((page) => {
    const text = page.text.toLowerCase();
    return wanted.filter((term) => text.includes(term)).map((term) => ({ id: page.id, term }));
  });
}

async function main(command: string | undefined) {
  const samples = join(ROOT, "samples");
  assertConsent(samples);
  const files = messageFiles(samples);
  const manifest = readManifest(samples);
  const clientNames = existsSync(join(samples, "client-names.txt"))
    ? readFileSync(join(samples, "client-names.txt"), "utf-8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
    : [];
  const parsed = [];
  for (const file of files) {
    const raw = readFileSync(join(samples, file), "utf-8");
    parsed.push({ file, raw, email: await PostalMime.parse(raw) });
  }
  if (command === "inventory") {
    const counts = { messages: parsed.length, attachments: 0, bodies: 0, lure: 0, benign: 0, undecided: 0 };
    for (const { file, email } of parsed) {
      counts.attachments += htmlAttachments(email).length;
      if (email.html) counts.bodies++;
      const label = labelOf(file, manifest);
      if (label.lure === true) counts.lure++;
      else if (label.lure === false) counts.benign++;
      else counts.undecided++;
    }
    console.log(JSON.stringify(counts));
    return 0;
  }
  const store = openStore(storeDir());
  const terms = protectedTerms(
    clientNames,
    parsed.flatMap(({ email, raw }) => addresses(email, raw)),
  );
  const domains = clientDomains(parsed.flatMap(({ email, raw }) => addresses(email, raw)));
  if (command === "leak-check") {
    const pages = store
      .manifest()
      .filter((p: StoredPage) => p.origin === "samples")
      .map((p) => ({ id: p.id, text: store.readPage(p.id).text }));
    const found = leaks(pages, terms);
    console.log(
      found.length
        ? `leak-check: ${found.length} hits in ${new Set(found.map((f) => f.id)).size} pages`
        : `leak-check: clean (${pages.length} pages)`,
    );
    return found.length ? 1 : 0;
  }
  if (command !== "import") {
    console.error("usage: node scripts/glimmer/import-samples.ts inventory | import | leak-check");
    return 2;
  }
  const reader = await openTextReader();
  try {
    for (const kind of ["attachment", "body"] as const) {
      const items: SourceItem[] = [];
      for (const { file, raw, email } of parsed) {
        const label = labelOf(file, manifest);
        // The client's domains are redacted too: a domain can stand alone in the text, outside any address.
        const names = [...recipientNames(email, raw, clientNames), ...domains];
        const htmls =
          kind === "attachment" ? htmlAttachments(email) : [bodyWithImages(email)].filter((h): h is string => !!h);
        htmls.forEach((html, index) => {
          items.push({
            id: `${file}#${kind}${index}`,
            url: null,
            labels: label.lure === undefined ? {} : { lure: label.lure },
            label_source:
              label.lure === undefined ? {} : { lure: label.source === "ground-truth" ? "ground-truth" : "unverified" },
            load: () => renderRedacted(reader.renderHtml, html, names, terms),
          });
        });
      }
      const result = await importSource({
        source: kind === "attachment" ? "samples-attachment" : "samples-body",
        licence: LICENCE,
        items,
        store,
        origin: "samples",
        redacted: true,
        southAfrica: true,
        log: (line) => console.log(line),
      });
      console.log(
        `samples ${kind}: ${JSON.stringify({ ...result, excluded: result.excluded.length, filtered: result.filtered.length })}`,
      );
    }
  } finally {
    await reader.close();
  }
  return 0;
}

if (import.meta.filename === process.argv[1]) process.exit(await main(process.argv[2]));
