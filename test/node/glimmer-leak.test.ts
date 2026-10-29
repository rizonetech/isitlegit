import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PostalMime from "postal-mime";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertConsent,
  CONSENT_HEADING,
  labelOf,
  leakCheck,
  leaks,
  messageFiles,
  messageParts,
  type Ocr,
  opaqueId,
  parseCsv,
  partNames,
  personalDetail,
  readClientNames,
  readManifest,
  redactionState,
  renderRedacted,
  runImport,
  SOURCES,
} from "../../scripts/glimmer/import-samples.ts";
import { hasImages } from "../../scripts/glimmer/redact.ts";
import {
  CONTROLS,
  DISCOVERY,
  dictionary,
  KINDS,
  renderRedactedBy,
  runBenchmark,
  seedPages,
  survives,
  unlistedSurvives,
  WAYS,
} from "../../scripts/glimmer/redaction-benchmark.ts";
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
function message(body: string, extra = "", recipient = RECIPIENT): string {
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
  return samples;
}

let reader: Awaited<ReturnType<typeof openTextReader>>;
const rendered: string[] = [];
const render = async (html: string) => {
  rendered.push(html);
  return reader.renderHtml(html, { pictures: false });
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
    writeFileSync(join(dir, "manifest.csv"), "file,label\nclient/a.eml,attack\nclient/a.eml,genuine\n");
    expect(() => readManifest(dir, ["client/a.eml"])).toThrow(/already labelled attack/);
    writeFileSync(join(dir, "manifest.csv"), 'file,label\n"client/a, b.eml",attack\n');
    expect(readManifest(dir, ["client/a, b.eml"]).get("client/a, b.eml")).toBe("attack");
    expect(partNames("Content-Type: text/html; charset=x; name*0*=utf-8''a%20; name*1*=b.html")).toContain("a b.html");
    expect(partNames('Content-Type: text/html; name="=?utf-8?B?0J/RgNC40LLQtdGC?=.html"')).toContain("Привет.html");
    expect(parseCsv('a,"b ""c"", d"\r\n\r\n1,2\n')).toEqual([
      ["a", 'b "c", d'],
      ["1", "2"],
    ]);
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

  it("finds every message at any depth and in any case, and reads a manifest saved with a byte-order mark", () => {
    mkdirSync(join(dir, "client", "archive"), { recursive: true });
    for (const name of ["1.eml", "client/2.EML", "client/archive/3.eml", "client/.hidden.eml", "client/notes.txt"])
      writeFileSync(join(dir, name), "x");
    expect(messageFiles(dir)).toEqual(["1.eml", "client/2.EML", "client/archive/3.eml"]);
    writeFileSync(join(dir, "manifest.csv"), "\uFEFFfile,label\n1.eml,attack\n");
    expect(readManifest(dir, ["1.eml"]).get("1.eml")).toBe("attack");
  });

  it("decodes two attachments with one name each by its own MIME charset", async () => {
    const parts = [
      "--b",
      "Content-Type: text/html; charset=windows-1251; name=invoice.html",
      "Content-Disposition: attachment; filename=invoice.html",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]).toString("base64"),
      "--b",
      "Content-Type: text/html; charset=utf-8; name=invoice.html",
      "Content-Disposition: attachment; filename=invoice.html",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("Привет", "utf-8").toString("base64"),
      "--b--",
      "",
    ].join("\r\n");
    const raw = `Content-Type: multipart/mixed; boundary="b"\r\n\r\n${parts}`;
    expect(messageParts(await PostalMime.parse(raw), raw).attachments).toEqual(["Привет", "Привет"]);
  });

  it("matches a name as a whole word and an address or domain anywhere, and sees a joined-up detail", () => {
    expect(leaks([{ id: "p", text: "Announcement for everyone" }], ["Ann"])).toEqual([]);
    expect(leaks([{ id: "p", text: "Dear Ann," }], ["Ann"])).toHaveLength(1);
    // A name written with a look-alike letter is the same name on the screen.
    expect(leaks([{ id: "p", text: "Dear \u0410nn," }], ["Ann"])).toHaveLength(1);
    expect(leaks([{ id: "p", text: "see www.acme.co.za/x" }], ["acme.co.za"])).toHaveLength(1);
    expect(personalDetail("Call 082 555 1234 now")).toBe("a phone number");
    expect(personalDetail("Pay R 4 210.00 by 2026-10-31")).toBeNull();
  });
});

const noText: Ocr = async (shots) => shots.map(() => "");
const sourceStatus = (store: ReturnType<typeof openStore>, source: string) =>
  JSON.parse(readFileSync(join(store.dir, "raw", source, "IMPORT.json"), "utf-8")).status;

describe("the sample import, end to end", () => {
  it("accounts for every message, stores redacted pages under opaque ids, and reconciles labels", async () => {
    const samples = samplesDir();
    const store = openStore(join(dir, "store"));
    rendered.length = 0;
    const first = await runImport({ samples, store, render, maxBytes: 64 * 1024 });
    // The unreadable and the oversized message keep the run incomplete: nothing is published as done.
    expect(first.code).toBe(1);
    expect(first.inventory).toMatchObject({ messages: 16 });
    expect(first.inventory.failed).toEqual(
      expect.arrayContaining([
        { id: opaqueId("client/9_HighConfPhish.eml"), reason: "unreadable (EACCES)" },
        { id: opaqueId("client/14_HighConfPhish.eml"), reason: "over 0.06 MB" },
      ]),
    );
    expect(first.inventory.excluded).toEqual([
      { id: opaqueId("client/4_Spam.eml"), reason: "a Spam verdict: neither a lure nor benign" },
    ]);
    expect(redactionState(store)).toMatchObject({ key: null });
    for (const source of Object.values(SOURCES)) expect(sourceStatus(store, source)).toBe("incomplete");
    expect((await leakCheck({ samples, store, ocr: noText })).problems).toContain(
      "the stored pages were not all made under the current redaction",
    );
    // Nothing rendered held a picture, vector art or generated text.
    expect(rendered.length).toBeGreaterThan(0);
    for (const html of rendered) expect(hasImages(html)).toBe(false);

    const pages = store.manifest().filter((p) => p.origin === "samples");
    for (const page of pages) {
      const { screenshot, text } = store.readPage(page.id);
      expect(screenshot.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/thandi|merwe|vdmerwe|ndlovu|acme|anne/i);
      expect(page.redacted).toBe(true);
      expect(page.item).toMatch(/^m-[0-9a-f]{16}#(attachment|body)\d$/);
    }
    const byText = (needle: string) => pages.filter((p) => store.readPage(p.id).text.includes(needle));
    // The Windows-1252 attachment reads as written, its encoded name redacted; the windows-1251 one by its MIME charset.
    expect(byText("Café invoice")[0]?.labels.has_login_form).toBe(true);
    expect(byText("Привет")).toHaveLength(1);
    // The plain-text body is a page too.
    expect(byText("SARS refund")).toHaveLength(1);
    // Identical pages from a Phish and a HighConfPhish message keep the stronger label, whichever came first.
    expect(byText("act now")[0]?.label_source.lure).toBe("ground-truth");
    // The same page as one message's body and another's attachment: both take the stronger label.
    const shared = byText("Shared page");
    expect(shared).toHaveLength(2);
    for (const page of shared) expect(page.label_source.lure).toBe("ground-truth");
    // Identical pages from a genuine and a phishing message keep no lure label.
    expect(byText("labelled two ways")[0]?.labels.lure).toBeUndefined();
    // A short name is redacted on every page, its own message's and another's.
    expect(byText("Dear [name], Your FNB")).toHaveLength(1);
    expect(byText("[name] from FNB will help")).toHaveLength(1);
    // The page whose phone number only the render joined up was refused, by kind, never by the number.
    const bodies = JSON.parse(readFileSync(join(store.dir, "raw", SOURCES.body, "IMPORT.json"), "utf-8"));
    expect(bodies.excluded).toEqual([
      { item: `${opaqueId("client/6_HighConfPhish.eml")}#body0`, reason: "refused: a phone number survived redaction" },
    ]);
    // A message with only a PDF is accounted for as an unsupported part and no body.
    const pdfOnly = first.inventory.outcomes.find((o) => o.id === opaqueId("client/15_HighConfPhish.eml"));
    expect(pdfOnly?.parts).toEqual([{ unsupported: "application/pdf" }, { none: true }]);

    // With the unreadable and oversized messages gone, the import completes and the leak check passes.
    rmSync(join(samples, "client", "9_HighConfPhish.eml"), { recursive: true });
    rmSync(join(samples, "client", "14_HighConfPhish.eml"));
    // Its refusal is one page in fourteen here, over the 5 percent an import may exclude.
    rmSync(join(samples, "client", "6_HighConfPhish.eml"));
    expect((await runImport({ samples, store, render })).code).toBe(0);
    for (const source of Object.values(SOURCES)) expect(sourceStatus(store, source)).toBe("complete");
    expect(await leakCheck({ samples, store, ocr: noText })).toMatchObject({
      code: 0,
      hits: 0,
      unaccounted: 0,
      problems: [],
    });
  }, 240_000);

  it("resumes a rebuild that failed part-way, keeping its finished pages", async () => {
    const samples = samplesDir();
    rmSync(join(samples, "client", "9_HighConfPhish.eml"), { recursive: true });
    rmSync(join(samples, "client", "6_HighConfPhish.eml"));
    const store = openStore(join(dir, "store"));
    expect((await runImport({ samples, store, render })).code).toBe(0);
    const key = redactionState(store).key;
    // A new client name: the earlier pages go; a rebuild that fails on one page records only that it is building.
    writeFileSync(join(samples, "client-names.txt"), "Acme Holdings\nFNB Online\n");
    const lines: string[] = [];
    let calls = 0;
    const flaky = async (html: string) => {
      calls++;
      if (html.includes("SARS refund")) throw new Error("render failed");
      return render(html);
    };
    expect((await runImport({ samples, store, render: flaky, log: (l) => lines.push(l) })).code).toBe(1);
    expect(lines.some((l) => /earlier pages removed/.test(l))).toBe(true);
    const building = redactionState(store);
    expect(building.key).toBeNull();
    expect(building.building).not.toBe(key);
    // The next run resumes it: only what is not yet stored is rendered again, and the key is recorded.
    const before = calls;
    const again: string[] = [];
    const counted = async (html: string) => {
      again.push(html);
      return render(html);
    };
    expect((await runImport({ samples, store, render: counted, log: (l) => lines.push(l) })).code).toBe(0);
    expect(lines.some((l) => /resuming the rebuild/.test(l))).toBe(true);
    expect(redactionState(store)).toMatchObject({ key: building.building, building: null });
    // The pages stored before the failure are skipped: fewer renders than the first attempt, the failed one among them.
    expect(again.length).toBeLessThan(before);
    expect(again.some((html) => html.includes("SARS refund"))).toBe(true);
  }, 240_000);

  it("makes every page again when a message's bytes change, and stops a parse at its deadline", async () => {
    const samples = samplesDir();
    for (const name of ["9_HighConfPhish.eml", "14_HighConfPhish.eml", "6_HighConfPhish.eml"])
      rmSync(join(samples, "client", name), { recursive: true });
    const store = openStore(join(dir, "store"));
    expect((await runImport({ samples, store, render })).code).toBe(0);
    writeFileSync(join(samples, "client", "4_Spam.eml"), message(`<p>${words} Changed.</p>`));
    const lines: string[] = [];
    expect((await runImport({ samples, store, render, log: (l) => lines.push(l) })).code).toBe(0);
    expect(lines.some((l) => /earlier pages removed/.test(l))).toBe(true);
    // A deadline no parse can meet: every message is late, recorded, and the run is incomplete.
    const late = await runImport({ samples, store, render, parseMs: 1 });
    expect(late.code).toBe(1);
    expect(late.inventory.failed.length).toBeGreaterThan(0);
    expect(late.inventory.failed.every((f) => f.reason === "not parsed within 0.001 seconds")).toBe(true);
  }, 240_000);

  it("stops the old pages counting before it removes any", async () => {
    const samples = samplesDir();
    for (const name of ["9_HighConfPhish.eml", "14_HighConfPhish.eml", "6_HighConfPhish.eml"])
      rmSync(join(samples, "client", name), { recursive: true });
    const store = openStore(join(dir, "store"));
    expect((await runImport({ samples, store, render })).code).toBe(0);
    writeFileSync(join(samples, "client-names.txt"), "Acme Holdings\nFNB Online\n");
    const dying = {
      ...store,
      removeSource: () => {
        throw new Error("killed during the removal");
      },
    } as typeof store;
    await expect(runImport({ samples, store: dying, render })).rejects.toThrow(/killed/);
    for (const source of Object.values(SOURCES)) expect(sourceStatus(store, source)).toBe("running");
    expect(redactionState(store)).toMatchObject({ key: null, cleaned: false });
    // The retry removes the old pages again before it skips anything, so none made under the old rules survives.
    const lines: string[] = [];
    expect((await runImport({ samples, store, render, log: (l) => lines.push(l) })).code).toBe(0);
    expect(lines.some((l) => /earlier pages removed/.test(l))).toBe(true);
    for (const page of store.manifest().filter((p) => p.origin === "samples"))
      expect(store.readPage(page.id).text).not.toMatch(/FNB Online/);
    expect(redactionState(store)).toMatchObject({ building: null, cleaned: true });
  }, 240_000);

  it("publishes nothing as complete when a step after the import fails", async () => {
    const samples = samplesDir();
    rmSync(join(samples, "client", "9_HighConfPhish.eml"), { recursive: true });
    rmSync(join(samples, "client", "14_HighConfPhish.eml"));
    rmSync(join(samples, "client", "6_HighConfPhish.eml"));
    const store = openStore(join(dir, "store"));
    const broken = {
      ...store,
      setLabels: () => {
        throw new Error("disk full");
      },
    } as typeof store;
    await expect(runImport({ samples, store: broken, render })).rejects.toThrow(/disk full/);
    for (const source of Object.values(SOURCES)) expect(sourceStatus(store, source)).toBe("running");
    expect(redactionState(store).key).toBeNull();
  }, 240_000);

  it("finds a client detail in a page, a screenshot or a record, and refuses to check without consent", async () => {
    const samples = samplesDir();
    rmSync(join(samples, "client", "9_HighConfPhish.eml"), { recursive: true });
    rmSync(join(samples, "client", "14_HighConfPhish.eml"));
    rmSync(join(samples, "client", "6_HighConfPhish.eml"));
    const store = openStore(join(dir, "store"));
    expect((await runImport({ samples, store, render })).code).toBe(0);
    // A screenshot whose picture shows a name the text does not.
    expect(
      await leakCheck({ samples, store, ocr: async (s) => s.map((_, i) => (i === 0 ? "Dear Thandi" : "")) }),
    ).toMatchObject({ code: 1 });
    // A screenshot that shows a phone number.
    expect(
      (await leakCheck({ samples, store, ocr: async (s) => s.map((_, i) => (i === 0 ? "Call 082 555 1234" : "")) }))
        .problems,
    ).toContain("1 pages or screenshots show an address, phone or long number");
    // No OCR engine: the screenshots are unchecked, so the check fails.
    expect(
      (await leakCheck({ samples, store, ocr: async () => Promise.reject(new Error("no OCR engine")) })).code,
    ).toBe(1);
    // A record that names a client, and one that names a client folder.
    const record = join(store.dir, "raw", SOURCES.body, "IMPORT.json");
    const saved = readFileSync(record, "utf-8");
    writeFileSync(record, saved.replace('"status"', '"note": "for Thandi", "status"'));
    expect((await leakCheck({ samples, store, ocr: noText })).hits).toBeGreaterThan(0);
    writeFileSync(record, saved.replace('"status"', '"note": "client/1_HighConfPhish.eml", "status"'));
    expect((await leakCheck({ samples, store, ocr: noText })).hits).toBeGreaterThan(0);
    writeFileSync(record, saved);
    // A stored screenshot replaced by another picture, and a page record that no longer reads.
    const page = store.manifest().find((p) => p.origin === "samples") as { id: string };
    const shotFile = join(store.dir, "pages", page.id, "screenshot.jpg");
    const kept = readFileSync(shotFile);
    writeFileSync(
      shotFile,
      await sharp({ create: { width: 64, height: 64, channels: 3, background: "#fff" } })
        .jpeg()
        .toBuffer(),
    );
    expect((await leakCheck({ samples, store, ocr: noText })).problems).toContain(
      "1 pages' files no longer match their records",
    );
    writeFileSync(shotFile, kept);
    const metaFile = join(store.dir, "pages", page.id, "meta.json");
    const keptMeta = readFileSync(metaFile, "utf-8");
    writeFileSync(metaFile, "{ broken");
    expect((await leakCheck({ samples, store, ocr: noText })).problems).toContain("a page's record does not read");
    writeFileSync(metaFile, keptMeta);
    // A planted page that keeps a name, and a page no part accounts for.
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
    const planted = await leakCheck({ samples, store, ocr: noText });
    expect(planted.code).toBe(1);
    expect(planted.problems).toContain("1 stored pages are no part's");
    rmSync(join(samples, "pilot-consent.md"));
    await expect(leakCheck({ samples, store, ocr: noText })).rejects.toThrow(/refused/);
  }, 240_000);
});

describe("a sample render", () => {
  it("refuses a name the page draws in a form value, however its letters are written", async () => {
    // `&acy;` is a Cyrillic а the redactor's own table does not know; the browser decodes it and draws the name.
    const html = `<p>${words}</p><input value="Th&acy;ndi" style="font-size:24px"><input placeholder="Dear Thandi">`;
    await expect(renderRedacted(render, html, [], ["Thandi"])).rejects.toThrow(/a client detail survived/);
    // A phone in a placeholder is redacted before the render, and the drawn text shows the placeholder.
    const page = await renderRedacted(render, `<p>${words}</p><input placeholder="082 555 1234">`, [], ["Thandi"]);
    expect(page.drawn).toBe("[phone]");
  });

  it("draws no picture however the page writes it, by the browser's own reading", async () => {
    const red = (
      await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ff0000" } })
        .png()
        .toBuffer()
    ).toString("base64");
    // An unquoted style hiding url( and data: in escapes, a pseudo-element's picture marked !important by an id rule,
    // and a plain image: each a solid red block where the screenshot would show it.
    const escaped = `\\000075rl(data\\00003aimage/png;base64,${red})`;
    const html = `<style>#p::before{content:"";display:block;width:300px;height:100px;background-image:url(data:image/png;base64,${red})!important;background-size:cover}</style>
<div style=width:300px;height:100px;background-size:cover;background-image:${escaped}></div><div id=p></div><img src="data:image/png;base64,${red}" width=300 height=100>
<p>${words}</p>`;
    let shot: Uint8Array | undefined;
    try {
      shot = (await reader.renderHtml(html, { pictures: false })).screenshot;
    } catch (error) {
      expect(String(error)).toMatch(/refused: a picture survived/);
      return;
    }
    const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
    let reds = 0;
    for (let i = 0; i < data.length; i += info.channels)
      if ((data[i] as number) > 200 && (data[i + 1] as number) < 60 && (data[i + 2] as number) < 60) reds++;
    expect(reds).toBe(0);
    // Without the rule the same page shows its pictures: the test can see red when red is drawn.
    const plain = (await reader.renderHtml(html)).screenshot;
    const raw = await sharp(plain).raw().toBuffer({ resolveWithObject: true });
    let shown = 0;
    for (let i = 0; i < raw.data.length; i += raw.info.channels)
      if ((raw.data[i] as number) > 200 && (raw.data[i + 1] as number) < 60 && (raw.data[i + 2] as number) < 60)
        shown++;
    expect(shown).toBeGreaterThan(1000);
  });
});

describe("the redaction benchmark", () => {
  it("finds a detail still there however the benchmark wrote it", () => {
    // Its own look-alike way: full-width digits and a Cyrillic letter in the client's domain.
    expect(
      survives(
        { kind: "phone", way: "look-alike letters", value: "082 555 1234" },
        "call \uff10\uff18\uff12 \uff15\uff15\uff15 \uff11\uff12\uff13\uff14",
      ),
    ).toBe(true);
    expect(
      survives(
        { kind: "domain", way: "look-alike letters", value: "kestrel-holdings.co.za" },
        "see k\u0435strel-holdings.co.za",
      ),
    ).toBe(true);
    expect(survives({ kind: "name", way: "plain", value: "Sipho Naidoo" }, "Dear [name]")).toBe(false);
  });

  it("leaves no seeded detail of any kind, written any way, on a page it accepts", async () => {
    // Eight pages of ten: every one of the seven kinds meets each of the eleven ways at least once.
    const result = await runBenchmark({ pages: 8, render });
    expect(result.total.seeded).toBe(80);
    expect(Object.keys(result.byKindAndWay)).toHaveLength(KINDS.length * WAYS.length);
    expect(result.total.survived).toBe(0);
    expect(result.total.removed).toBeGreaterThan(0);
    expect(result.failedPages).toBe(0);
  }, 120_000);

  it("seeds details no detector is given, scores them apart, and keeps the lure's brand (§19)", async () => {
    const { pages, names, terms, domains } = seedPages(4);
    const unlisted = pages.flatMap((page) => page.unlisted);
    expect(new Set(unlisted.map((u) => u.kind))).toEqual(new Set(DISCOVERY));
    // The truth stays in its own record: no detector input names an unlisted person or address.
    const inputs = [...names, ...terms, ...domains].join("\n").toLowerCase();
    for (const u of unlisted)
      for (const word of u.value
        .toLowerCase()
        .split(/[\s,]+/)
        .filter((w) => [...w].length >= 4))
        expect(inputs).not.toContain(word);
    const result = await runBenchmark({ pages: 4, render });
    expect(Object.keys(result.discovery).sort()).toEqual([...DISCOVERY].sort());
    // The dictionary cannot remove what it was never given; that is measured, and the known kinds' bar still holds.
    expect(Object.values(result.discovery).reduce((n, t) => n + t.survived, 0)).toBeGreaterThan(0);
    expect(result.total.survived).toBe(0);
    // Every page the check accepts keeps the brand it impersonates.
    const accepted = result.pages - result.refusedPages - result.failedPages;
    expect(accepted).toBeGreaterThan(0);
    expect(result.controls).toEqual({ kept: accepted * CONTROLS.length, lost: 0 });
    expect(
      unlistedSurvives({ kind: "postal address", value: "14 Jacaranda Street, Parkhurst" }, "Deliver to [address]"),
    ).toBe(false);
  }, 120_000);

  it("runs the importer's path with only the redaction step swapped: the dictionary through it equals renderRedacted", async () => {
    const { pages, names, terms, domains } = seedPages(8);
    const outcome = (run: () => Promise<{ text: string }>) =>
      run().then(
        (page) => page.text,
        (error: Error) => error.message,
      );
    for (const page of pages) {
      const viaImporter = await outcome(() => renderRedacted(render, page.html, names, terms, domains));
      const viaBenchmark = await outcome(() =>
        renderRedactedBy(dictionary, render, page.html, { names, terms, domains }),
      );
      expect(viaBenchmark).toBe(viaImporter);
    }
    // Another redactor meets the same refusals: one that changes nothing is refused where its page still shows a detail.
    let refused = 0;
    for (const page of pages)
      refused += await renderRedactedBy(async (html) => html, render, page.html, { names, terms, domains }).then(
        () => 0,
        (error: Error) => (/^refused: /.test(error.message) ? 1 : 0),
      );
    expect(refused).toBeGreaterThan(pages.length / 2);
  }, 120_000);

  it("counts a render that failed as a failure, never as a refusal", async () => {
    const result = await runBenchmark({ pages: 7, render: async () => Promise.reject(new Error("browser closed")) });
    expect(result).toMatchObject({ failedPages: 7, refusedPages: 0 });
    expect(result.total.seeded).toBe(0);
  });
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
