import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertConsent,
  CONSENT_HEADING,
  labelOf,
  leakCheck,
  leaks,
  opaqueId,
  personalDetail,
  readClientNames,
  readManifest,
  runImport,
  SOURCES,
} from "../../scripts/glimmer/import-samples.ts";
import { hasImages } from "../../scripts/glimmer/redact.ts";
import { openTextReader } from "../../scripts/glimmer/source-pages.ts";
import { openStore } from "../../scripts/glimmer/store.ts";

// scripts/glimmer/import-samples.ts (D03 T04 §7), on synthetic mail only: nothing is read without the consent and the
// client's names; every message is accounted for; what is rendered holds no image and no client detail; stored pages
// read back redacted under opaque ids, with labels reconciled across identical pages; a changed redaction makes every
// page again, and an interrupted rebuild never stands as done.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "glimmer-samples-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const RECIPIENT = "To: Thandi van der Merwe <thandi.vdmerwe@acme.co.za>\r\nDelivered-To: accounts@acme.co.za";
const words = "Your FNB account is on hold until you verify it with FNB online banking today.";
function message(body: string, extra = ""): string {
  return [
    "From: FNB Online <alerts@fnb-verify.example.com>",
    RECIPIENT,
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
const LOGO = [
  "--b1",
  "Content-Type: image/png",
  "Content-ID: <logo1>",
  "Content-Transfer-Encoding: base64",
  "",
  "iVBORw0KGgo=",
].join("\r\n");
// An HTML attachment in Windows-1252 with no charset, its name written as a character reference.
const ATTACHMENT = [
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
const PLAIN = [
  "From: SARS <efiling@sars-refund.example.com>",
  RECIPIENT,
  "Subject: Refund",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Dear Thandi, your SARS refund of R 4 210.00 is waiting. Claim it at https://sars-refund.example.com/claim today.",
  "",
].join("\r\n");

function samplesDir(): string {
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
  // A message that cannot be read.
  mkdirSync(join(samples, "client", "9_HighConfPhish.eml"));
  return samples;
}

let reader: Awaited<ReturnType<typeof openTextReader>>;
const rendered: string[] = [];
const render = async (html: string) => {
  rendered.push(html);
  return reader.renderHtml(html);
};
beforeAll(async () => {
  reader = await openTextReader();
  await reader.renderHtml("<p>warm</p>");
}, 60_000);
afterAll(async () => reader?.close());

describe("the sample importer's inputs", () => {
  it("reads nothing without the consent extension or the client's names", () => {
    writeFileSync(join(dir, "pilot-consent.md"), "# Consent\n\nMeta Model API only.\n");
    expect(() => assertConsent(dir)).toThrow(/refused/);
    writeFileSync(join(dir, "pilot-consent.md"), `# Consent\n\n## ${CONSENT_HEADING}\n`);
    expect(() => assertConsent(dir)).not.toThrow();
    expect(() => readClientNames(dir)).toThrow(/client-names\.txt is missing/);
    writeFileSync(join(dir, "client-names.txt"), "# nobody\n");
    expect(() => readClientNames(dir)).toThrow(/names no one/);
  });

  it("refuses a manifest with an unknown label or a file that is not a message", () => {
    writeFileSync(join(dir, "manifest.csv"), "file,label\nclient/a.eml,maybe\n");
    expect(() => readManifest(dir, ["client/a.eml"])).toThrow(/not attack or genuine/);
    writeFileSync(join(dir, "manifest.csv"), "file,label\nclient/b.eml,attack\n");
    expect(() => readManifest(dir, ["client/a.eml"])).toThrow(/names no message/);
  });

  it("labels by the manifest or the verdict, and gives Spam, Bulk and the unlabelled a reason", () => {
    const manifest = new Map([["client/g.eml", "genuine"]]);
    expect(labelOf("client/g.eml", manifest)).toMatchObject({ lure: false, source: "ground-truth" });
    expect(labelOf("client/1_HighConfPhish.eml", manifest)).toMatchObject({ lure: true, source: "ground-truth" });
    expect(labelOf("client/1_Phish.eml", manifest)).toMatchObject({ lure: true, source: "unverified" });
    expect(labelOf("client/1_Spam.eml", manifest)).toEqual({ excluded: "a Spam verdict: neither a lure nor benign" });
    expect(labelOf("client/1_Bulk.eml", manifest)).toEqual({ excluded: "a Bulk verdict: neither a lure nor benign" });
    expect(labelOf("client/1_Malware.eml", manifest)).toEqual({ excluded: "an unknown verdict" });
    expect(labelOf("client/x.eml", manifest)).toEqual({ excluded: "no label" });
  });

  it("matches a name as a whole word and an address or domain anywhere, and sees a joined-up detail", () => {
    expect(leaks([{ id: "p", text: "Announcement for everyone" }], ["Ann"])).toEqual([]);
    expect(leaks([{ id: "p", text: "Dear Ann," }], ["Ann"])).toHaveLength(1);
    expect(leaks([{ id: "p", text: "see www.acme.co.za/x" }], ["acme.co.za"])).toHaveLength(1);
    expect(personalDetail("Call 082 555 1234 now")).toBe("a phone number");
    expect(personalDetail("Pay R 4 210.00 by 2026-10-31")).toBeNull();
  });
});

describe("the sample import, end to end", () => {
  it("accounts for every message, stores redacted pages under opaque ids, and reconciles labels", async () => {
    const samples = samplesDir();
    const store = openStore(join(dir, "store"));
    rendered.length = 0;
    const first = await runImport({ samples, store, render });
    // The unreadable message keeps the run incomplete, so the redaction is not recorded as done.
    expect(first.code).toBe(1);
    expect(first.inventory).toMatchObject({ messages: 9, items: 8 });
    expect(first.inventory.failed).toEqual([
      { id: opaqueId("client/9_HighConfPhish.eml"), reason: "unreadable (EISDIR)" },
    ]);
    expect(first.inventory.excluded).toEqual([
      { id: opaqueId("client/4_Spam.eml"), reason: "a Spam verdict: neither a lure nor benign" },
    ]);
    expect(existsSync(join(store.dir, "raw", "samples", "REDACTION.json"))).toBe(false);
    // Nothing rendered held a picture; the logo became a blank box.
    expect(rendered.length).toBeGreaterThan(0);
    for (const html of rendered) expect(hasImages(html)).toBe(false);

    const pages = store.manifest().filter((p) => p.origin === "samples");
    for (const page of pages) {
      const { screenshot, text } = store.readPage(page.id);
      expect(screenshot.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/thandi|merwe|vdmerwe|acme/i);
      expect(page.redacted).toBe(true);
      expect(page.item).toMatch(/^m-[0-9a-f]{16}#(attachment|body)\d$/);
    }
    const byText = (needle: string) => pages.find((p) => store.readPage(p.id).text.includes(needle));
    // The Windows-1252 attachment reads as written, its encoded name redacted.
    expect(byText("Café invoice")?.labels.has_login_form).toBe(true);
    // The plain-text body is a page too.
    expect(byText("SARS refund")).toBeDefined();
    // Identical pages from a Phish and a HighConfPhish message keep the stronger label, whichever came first.
    expect(byText("act now")?.label_source.lure).toBe("ground-truth");
    // Identical pages from a genuine and a phishing message keep no lure label.
    expect(byText("labelled two ways")?.labels.lure).toBeUndefined();
    // The page whose phone number only the render joined up was refused, by kind, never by the number.
    const bodies = JSON.parse(readFileSync(join(store.dir, "raw", SOURCES.body, "IMPORT.json"), "utf-8"));
    expect(bodies.excluded).toEqual([
      { item: `${opaqueId("client/6_HighConfPhish.eml")}#body0`, reason: "refused: a phone number survived redaction" },
    ]);
    // The leak check finds nothing in the pages or the records, and every message accounted for.
    expect(await leakCheck({ samples, store })).toMatchObject({ code: 0, hits: 0, unaccounted: 0 });
  }, 120_000);

  it("makes every page again when the redaction changes, and records the key only when done", async () => {
    const samples = samplesDir();
    rmSync(join(samples, "client", "9_HighConfPhish.eml"), { recursive: true });
    rmSync(join(samples, "client", "6_HighConfPhish.eml"));
    const store = openStore(join(dir, "store"));
    expect((await runImport({ samples, store, render })).code).toBe(0);
    const keyFile = join(store.dir, "raw", "samples", "REDACTION.json");
    const key = JSON.parse(readFileSync(keyFile, "utf-8")).key;
    const before = store.manifest().filter((p) => p.origin === "samples").length;

    // A new client name: every earlier page goes, and a rebuild that fails part-way leaves the old key in place, so
    // the next run removes and makes the pages again.
    writeFileSync(join(samples, "client-names.txt"), "Acme Holdings\nFNB Online\n");
    const lines: string[] = [];
    const failing = await runImport({
      samples,
      store,
      render: async () => Promise.reject(new Error("render failed")),
      log: (l) => lines.push(l),
    });
    expect(failing.code).toBe(1);
    expect(lines.some((l) => l.includes(`${before} earlier pages removed`))).toBe(true);
    expect(JSON.parse(readFileSync(keyFile, "utf-8")).key).toBe(key);
    expect((await runImport({ samples, store, render })).code).toBe(0);
    expect(JSON.parse(readFileSync(keyFile, "utf-8")).key).not.toBe(key);
  }, 180_000);

  it("finds a stored page or record that keeps a client detail", async () => {
    const samples = samplesDir();
    rmSync(join(samples, "client", "9_HighConfPhish.eml"), { recursive: true });
    const store = openStore(join(dir, "store"));
    await runImport({ samples, store, render });
    const jpeg = new Uint8Array(
      await sharp({ create: { width: 64, height: 64, channels: 3, background: "#fff" } })
        .jpeg()
        .toBuffer(),
    );
    await store.putPage(SOURCES.body, {
      screenshot: jpeg,
      text: "Dear Thandi, your account is on hold.",
      origin: "samples",
      licence: "x",
      host: null,
      template: null,
      south_africa: true,
      labels: { lure: true },
      label_source: { lure: "ground-truth" },
      redacted: true,
    });
    expect(await leakCheck({ samples, store })).toMatchObject({ code: 1 });
  }, 120_000);
});

describe("the pilot-client rule", () => {
  it("allows redacted sample mail into Fireworks training lines and keeps every other restriction", () => {
    const rule =
      readFileSync(join(import.meta.dirname, "../../AGENTS.md"), "utf-8")
        .split("\n")
        .find((line) => line.startsWith("- Never send real client mail to the Meta Model API")) ?? "";
    expect(rule).toMatch(/Redacted, it may also go into Fireworks training lines for Loupe/);
    expect(rule).toMatch(/unredacted, it goes only to the Meta Model API/);
    expect(rule).toMatch(/never enters a tracked file/);
    expect(rule).toMatch(/stays under the git-ignored `samples\/`/);
  });
});
