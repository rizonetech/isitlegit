import { describe, expect, it } from "vitest";
import {
  decodeTextEntities,
  hasImages,
  namePieces,
  PLACEHOLDER,
  redact,
  stripImages,
} from "../../scripts/glimmer/redact.ts";
import { decodeHtml } from "../../scripts/glimmer/source-pages.ts";

// scripts/glimmer/redact.ts (D03 T04 §7): every kind of personal detail in a synthetic fixture is replaced, in text
// and in HTML, however it is written, while brand names and link host names stay; and no image reaches a render.
const names = ["Acme Holdings", ...namePieces("Thandi van der Merwe", "thandi.vdmerwe@acme.co.za")];

describe("redact", () => {
  it("replaces addresses, recipient names, client names, phones, ID, account and card numbers", () => {
    const html = `<p>Dear Thandi Merwe,</p>
<p>Your FNB account 62812345678 at Acme Holdings is on hold. Call 082 555 1234, (011) 555 1234 or +27 11 555 0000.</p>
<p>ID 8001015009087, card 4111 1111 1111 1111, reply to thandi.vdmerwe@acme.co.za or visit acme.co.za</p>
<a href="https://fnb-secure-login.example.com/verify?u=thandi.vdmerwe@acme.co.za">Verify with FNB</a>`;
    const out = redact(html, names, ["acme.co.za"]);
    for (const kept of ["FNB", "fnb-secure-login.example.com", "Verify with FNB", "Dear"]) expect(out).toContain(kept);
    for (const gone of [
      "Thandi",
      "Merwe",
      "Acme Holdings",
      "62812345678",
      "082 555 1234",
      "(011) 555 1234",
      "+27 11 555 0000",
      "8001015009087",
      "4111 1111 1111 1111",
      "acme.co.za",
    ])
      expect(out, gone).not.toContain(gone);
    for (const placeholder of Object.values(PLACEHOLDER)) expect(out, placeholder).toContain(placeholder);
  });

  it("reads character references and hidden characters as what the render shows", () => {
    expect(decodeTextEntities("Th&#97;ndi &#x4D;erwe Caf&eacute; &lt;b&gt;")).toBe("Thandi Merwe Café &lt;b&gt;");
    const out = redact("<p>Dear Th&#97;ndi, Mer­we and Th​andi</p>", names);
    expect(out).not.toMatch(/thandi|merwe|th&#97;ndi/i);
  });

  it("redacts numbers grouped with non-breaking spaces, written or as references", () => {
    const out = redact("<p>card 4111\u00A01111\u00A01111\u00A01111, ID 800101&nbsp;5009&nbsp;087</p>", []);
    expect(out).toBe("<p>card [number], ID [number]</p>");
  });

  it("takes a hyphenated name whole and by its parts, and no common word", () => {
    expect(namePieces("Anne-Marie Dlamini", "billing@x.co.za")).toEqual(["Anne-Marie", "Anne", "Marie", "Dlamini"]);
    expect(namePieces("The New Team", "info@x.co.za")).toEqual([]);
    // A display name written as an address or a domain gives no web words for names.
    expect(namePieces("accounts@acme.com", "accounts@acme.com")).toEqual([]);
    expect(namePieces("acme.co.za", "thandi@acme.co.za")).toEqual(["thandi"]);
  });

  it("takes a capitalised two-letter name, and no mailbox role, from the recipients", () => {
    expect(namePieces("Jo M. Dlamini", "jo.dlamini@x.co.za")).toEqual(["Jo", "Dlamini", "dlamini"]);
    expect(namePieces("Accounts Payable", "accounts_payable@x.co.za")).toEqual([]);
    expect(redact("<p>Dear Jo, your JOB is ready</p>", namePieces("Jo Dlamini", undefined))).toBe(
      "<p>Dear [name], your JOB is ready</p>",
    );
  });

  it("keeps a lure's link hosts and brand words, replacing names only outside URLs", () => {
    const pieces = [...namePieces("Accounts", "accounts@acme.co.za"), ...namePieces("Thandi", "thandi@acme.co.za")];
    const out = redact(
      `<a href="https://accounts.google.com/thandi">Google Accounts</a> for Thandi at https://thandi.example.com/`,
      pieces,
    );
    expect(out).toContain('href="https://accounts.google.com/thandi"');
    expect(out).toContain(">Google Accounts<");
    expect(out).toContain("https://thandi.example.com/");
    expect(out).toContain("for [name] at");
  });

  it("leaves an inline image's base64 alone and keeps amounts and dates", () => {
    const image = "data:image/png;base64,iVBORw0KGgo12345678901234AAAA";
    const out = redact(`<img src="${image}"><p>Pay R4,999.00 by 2026-10-31</p>`, names);
    expect(out).toContain(image);
    expect(out).toContain("R4,999.00 by 2026-10-31");
  });
});

describe("stripImages", () => {
  it("replaces every picture with a blank box of its size, so none reaches a screenshot", () => {
    const html = `<img src="data:image/png;base64,AAAA" width=200 height=50><img src="cid:logo1">
<div style="background:url(data:image/png;base64,BBBB) no-repeat">x</div><table background="sig.png"><tr><td>y</td></tr></table>
<svg><image href="data:image/png;base64,CCCC"/></svg><object data="x.pdf"></object><picture><source srcset="a.png"></picture>`;
    expect(hasImages(html)).toBe(true);
    const out = stripImages(html);
    expect(hasImages(out)).toBe(false);
    expect(out).toContain("width:200px;height:50px");
    expect(out).toContain("width:120px;height:40px");
    expect(out).not.toMatch(/AAAA|BBBB|CCCC|sig\.png|x\.pdf|a\.png/);
    // Vector artwork and CSS-generated text go too: neither is in the page text a post-render check reads.
    const drawn = stripImages(
      `<svg><path d="M0 0L9 9"/><text>Thandi</text></svg><style>.a::after{content:"Thandi 082 555 1234"}</style>`,
    );
    expect(drawn).not.toMatch(/path|Thandi|082/);
    expect(hasImages(drawn)).toBe(false);
    expect(hasImages('<style>.a::after{content:"x"}</style>')).toBe(true);
  });
});

describe("decodeHtml", () => {
  it("reads undeclared Windows-1252 bytes as Windows-1252, not as replacement characters", () => {
    expect(decodeHtml(new Uint8Array([0x43, 0x61, 0x66, 0xe9]))).toBe("Café");
    expect(decodeHtml(new TextEncoder().encode("Café"))).toBe("Café");
  });
});
