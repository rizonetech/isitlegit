import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { CONSENT_HEADING, type Ocr } from "../../../scripts/glimmer/import-samples.ts";
import type { EntityPass, EntitySpan } from "../../../scripts/glimmer/redact.ts";
import { openTextReader } from "../../../scripts/glimmer/source-pages.ts";
import type { openStore } from "../../../scripts/glimmer/store.ts";

// The synthetic sample mail the import, leak and benchmark tests share (D03 T04 §7): one temporary folder per test and one
// warm text reader per file, each registered by `useSamples()` in the test file that calls it. `dir` and `reader` are
// live bindings, so a test reads the current test's folder.
export let dir: string;
export let reader: Awaited<ReturnType<typeof openTextReader>>;
export function useSamples() {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "glimmer-samples-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  beforeAll(async () => {
    reader = await openTextReader();
    await reader.renderHtml("<p>warm</p>");
  }, 60_000);
  afterAll(async () => reader?.close());
}

export const RECIPIENT = "To: Thandi van der Merwe <thandi.vdmerwe@acme.co.za>\r\nDelivered-To: accounts@acme.co.za";
export const words = "Your FNB account is on hold until you verify it with FNB online banking today.";
export function message(body: string, extra = "", recipient = RECIPIENT): string {
  return [
    "From: FNB Online <alerts@fnb-verify.example.com>",
    recipient,
    "Subject: Your account is on hold",
    'Content-Type: multipart/related; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/html; charset=utf-8",
    "",
    body,
    extra,
    "--b1--",
    "",
  ].join("\r\n");
}
export const LOGO = [
  "--b1",
  "Content-Type: image/png",
  "Content-ID: <logo1>",
  "Content-Transfer-Encoding: base64",
  "",
  "iVBORw0KGgo=",
].join("\r\n");
// An HTML attachment in Windows-1252 with no charset, its name written as a character reference.
export const ATTACHMENT = [
  "--b1",
  "Content-Type: text/html; name=invoice.html",
  "Content-Disposition: attachment; filename=invoice.html",
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from(
    "<form><input type=password></form><p>Sign in, Th&#97;ndi Merwe, to see the Caf\xe9 invoice for thandi.vdmerwe@acme.co.za</p>",
    "latin1",
  ).toString("base64"),
].join("\r\n");
export const PLAIN = [
  "From: SARS <efiling@sars-refund.example.com>",
  RECIPIENT,
  "Subject: Refund",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Dear Thandi, your SARS refund of R 4 210.00 is waiting. Claim it at https://sars-refund.example.com/claim today.",
  "",
].join("\r\n");

// The sample folder with every message, or only those whose names start with one of `keep` (an end-to-end test that
// proves a property of the run, not of a particular message, renders a few pages instead of all of them).
export function samplesDir(keep?: string[]): string {
  const samples = join(dir, "samples");
  mkdirSync(join(samples, "client"), { recursive: true });
  writeFileSync(join(samples, "pilot-consent.md"), `# Consent\n\n## ${CONSENT_HEADING}\n\nRedacted, for training.\n`);
  writeFileSync(join(samples, "client-names.txt"), "# the client\nAcme Holdings\n");
  writeFileSync(join(samples, "manifest.csv"), "file,label\nclient/7_genuine.eml,genuine\n");
  const put = (name: string, text: string) => writeFileSync(join(samples, "client", name), text);
  put(
    "1_HighConfPhish.eml",
    message(`<p>Dear Thandi,</p><img src="cid:logo1"><p>${words}</p>`, `${LOGO}\r\n${ATTACHMENT}`),
  );
  const same = message(`<p>${words} Acme Holdings, act now.</p>`);
  put("2_Phish.eml", same);
  put("3_HighConfPhish.eml", same);
  put("4_Spam.eml", message(`<p>${words} Great deals.</p>`));
  put("5_HighConfPhish.eml", PLAIN);
  // A phone number split by a tag: the redactor cannot see it, the render joins it, the check refuses the page.
  put("6_HighConfPhish.eml", message(`<p>${words} Call <b>082</b> 555 1234 now.</p>`));
  const disputed = message(`<p>${words} The same page, labelled two ways.</p>`);
  put("7_genuine.eml", disputed);
  put("8_HighConfPhish.eml", disputed);
  // A short name guards its own message's page; the same word on another message's page refuses nothing.
  put(
    "10_HighConfPhish.eml",
    message(
      `<p>Dear Sam, ${words}</p>`,
      "",
      "To: Sam Ndlovu <sam.ndlovu@acme.co.za>, Anne-Marie Dlamini <billing@acme.co.za>",
    ),
  );
  put("11_HighConfPhish.eml", message(`<p>${words} Sam from FNB will help.</p>`));
  // The same page as one message's body and another's attachment.
  const sharedHtml = `<p>${words} Shared page.</p>`;
  put("12_Phish.eml", message(sharedHtml));
  put(
    "13_HighConfPhish.eml",
    message(
      `<p>${words} Another body.</p>`,
      [
        "--b1",
        "Content-Type: text/html; name=shared.html",
        "Content-Disposition: attachment; filename=shared.html",
        "",
        sharedHtml,
      ].join("\r\n"),
    ),
  );
  // An attachment whose charset only its MIME header declares (windows-1251 for the Russian word for hello).
  const russian = Buffer.concat([
    Buffer.from("<p>Invoice ready to view now, invoice ready.</p><p>", "latin1"),
    Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]),
    Buffer.from("</p>", "latin1"),
  ]);
  const russianPart = [
    "--b1",
    "Content-Type: text/html; charset=windows-1251; name*=utf-8''ru%20one.html",
    "Content-Disposition: attachment; filename*=utf-8''ru%20one.html",
    "Content-Transfer-Encoding: base64",
    "",
    russian.toString("base64"),
  ].join("\r\n");
  put("16_HighConfPhish.eml", message(`<p>${words} With a Russian invoice.</p>`, russianPart));
  // A message over the size limit, and one with only a PDF.
  put("14_HighConfPhish.eml", message(`<p>${words}</p><p>${"x".repeat(70 * 1024)}</p>`));
  put(
    "15_HighConfPhish.eml",
    [
      "From: x <x@y.example.com>",
      RECIPIENT,
      "Subject: pdf",
      'Content-Type: multipart/mixed; boundary="b2"',
      "",
      "--b2",
      "Content-Type: application/pdf; name=a.pdf",
      "Content-Disposition: attachment; filename=a.pdf",
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0xLjQK",
      "--b2--",
      "",
    ].join("\r\n"),
  );
  // A message that cannot be read.
  // (A message file with no read permission.)
  put("9_HighConfPhish.eml", message(`<p>${words}</p>`));
  chmodSync(join(samples, "client", "9_HighConfPhish.eml"), 0o000);
  if (keep)
    for (const name of readdirSync(join(samples, "client")))
      if (!keep.some((prefix) => name.startsWith(prefix))) rmSync(join(samples, "client", name), { force: true });
  // The manifest names only messages that are there (the importer refuses a row naming none).
  if (keep && !keep.some((prefix) => "7_genuine.eml".startsWith(prefix)))
    writeFileSync(join(samples, "manifest.csv"), "file,label\n");
  return samples;
}

export const rendered: string[] = [];
export const render = async (html: string) => {
  rendered.push(html);
  return reader.renderHtml(html, { pictures: false });
};

export const noText: Ocr = async (shots) => shots.map(() => "");
// The entity pass stood in for (§19): it finds each of `words` in a text as a span of `label`; with none it finds
// nothing, a redaction pass made to miss every unlisted name.
export const finding = (words: string[] = [], label: EntitySpan["label"] = "person"): EntityPass => ({
  find: async (text) =>
    words.flatMap((word) => {
      const at = text.indexOf(word);
      return at < 0 ? [] : [{ start: at, end: at + word.length, label }];
    }),
  close: () => {},
});
export const misses = { pass: finding() };
export const sourceStatus = (store: ReturnType<typeof openStore>, source: string) =>
  JSON.parse(readFileSync(join(store.dir, "raw", source, "IMPORT.json"), "utf-8")).status;
