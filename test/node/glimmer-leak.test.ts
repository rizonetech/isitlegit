import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PostalMime from "postal-mime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addresses,
  assertConsent,
  bodyWithImages,
  CONSENT_HEADING,
  clientDomains,
  htmlAttachments,
  labelOf,
  leaks,
  protectedTerms,
  recipientNames,
  renderRedacted,
} from "../../scripts/glimmer/import-samples.ts";
import { redact } from "../../scripts/glimmer/redact.ts";

// scripts/glimmer/import-samples.ts (D03 T04 §7), on synthetic mail only: nothing is read without the consent
// extension, labels come from the manifest or the quarantine verdict, a body keeps its inline logo, and the leak check
// finds a client name or recipient address that survives into a page and nothing in a redacted one.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "glimmer-samples-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const MESSAGE = [
  "From: FNB Online <alerts@fnb-verify.example.com>",
  "To: Thandi van der Merwe <thandi.vdmerwe@acme.co.za>",
  "Delivered-To: accounts@acme.co.za",
  "Subject: Your account is on hold",
  'Content-Type: multipart/related; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<p>Dear Thandi,</p><img src="cid:logo1"><p>Acme Holdings account 62812345678 is on hold. Verify at FNB.</p>',
  "--b1",
  "Content-Type: image/png",
  "Content-ID: <logo1>",
  "Content-Transfer-Encoding: base64",
  "",
  "iVBORw0KGgo=",
  "--b1",
  "Content-Type: text/html; name=invoice.html",
  "Content-Disposition: attachment; filename=invoice.html",
  "",
  "<form><input type=password></form><p>Sign in to view the invoice for thandi.vdmerwe@acme.co.za</p>",
  "--b1--",
  "",
].join("\r\n");

describe("the sample importer", () => {
  it("reads nothing without the consent extension", () => {
    writeFileSync(join(dir, "pilot-consent.md"), "# Consent\n\nMeta Model API only.\n");
    expect(() => assertConsent(dir)).toThrow(/refused/);
    writeFileSync(join(dir, "pilot-consent.md"), `# Consent\n\n## ${CONSENT_HEADING}\n`);
    expect(() => assertConsent(dir)).not.toThrow();
  });

  it("labels from the manifest, else the quarantine verdict, else leaves the label to §9", () => {
    const manifest = new Map([
      ["gmail/a.eml", "attack"],
      ["outlook/g.eml", "genuine"],
    ]);
    expect(labelOf("gmail/a.eml", manifest)).toEqual({ lure: true, source: "ground-truth" });
    expect(labelOf("outlook/g.eml", manifest)).toEqual({ lure: false, source: "ground-truth" });
    expect(labelOf("client/1-2-3_4_5_HighConfPhish.eml", manifest)).toEqual({ lure: true, source: "ground-truth" });
    expect(labelOf("client/1-2-3_4_5_Phish.eml", manifest)).toEqual({ lure: true, source: "unverified" });
    expect(labelOf("client/1-2-3_4_5_Spam.eml", manifest)).toEqual({ source: "none" });
  });

  it("finds the HTML attachment, puts the inline logo back, and redacts the recipient", async () => {
    const email = await PostalMime.parse(MESSAGE);
    expect(htmlAttachments(email)).toHaveLength(1);
    const body = bodyWithImages(email) ?? "";
    expect(body).toContain("data:image/png;base64,");
    expect(body).not.toContain("cid:logo1");
    const names = recipientNames(email, MESSAGE, ["Acme Holdings"]);
    const clean = redact(body, names);
    expect(clean).not.toMatch(/Thandi|Acme Holdings|62812345678/);
    expect(clean).toContain("FNB");
    expect(addresses(email, MESSAGE)).toEqual(["thandi.vdmerwe@acme.co.za", "accounts@acme.co.za"]);
  });

  it("protects the client's own domains, not a public mail provider's", () => {
    const terms = protectedTerms(["Acme Holdings"], ["thandi@acme.co.za", "someone@gmail.com"]);
    expect(terms).toEqual(["Acme Holdings", "thandi@acme.co.za", "someone@gmail.com", "acme.co.za"]);
    expect(clientDomains(["a@outlook.com", "b@acme.co.za"])).toEqual(["acme.co.za"]);
    // A domain standing alone in the text is redacted once it is among the terms.
    expect(redact("<p>Visit acme.co.za today</p>", ["acme.co.za"])).toBe("<p>Visit [name] today</p>");
  });

  it("refuses a rendered page whose text still holds a client detail", async () => {
    const terms = ["acme.co.za"];
    // The source splits the address with a tag, so redaction cannot see it; the render joins it up again.
    const joined = async (html: string) => ({ text: html.replace(/<[^>]+>/g, "") });
    await expect(renderRedacted(joined, "<p>thandi@<b></b>acme<i></i>.co.za</p>", [], terms)).rejects.toThrow(
      /survived redaction/,
    );
    expect((await renderRedacted(joined, "<p>Verify with FNB</p>", [], terms)).text).toBe("Verify with FNB");
  });

  it("finds a client name or address that survives into a page, and nothing in a redacted one", () => {
    const terms = ["Acme Holdings", "thandi.vdmerwe@acme.co.za", "acme.co.za"];
    expect(leaks([{ id: "p1", text: "Invoice for Acme Holdings" }], terms)).toEqual([
      { id: "p1", term: "acme holdings" },
    ]);
    expect(leaks([{ id: "p2", text: "Dear [name], [email]" }], terms)).toEqual([]);
  });
});
