import { describe, expect, it } from "vitest";
import { namePieces, PLACEHOLDER, redact } from "../../scripts/glimmer/redact.ts";

// scripts/glimmer/redact.ts (D03 T04 §7): every kind of personal detail in a synthetic fixture is replaced, in text
// and in HTML, while brand names and link host names stay.
const names = ["Acme Holdings", ...namePieces("Thandi van der Merwe", "thandi.vdmerwe@acme.co.za")];

describe("redact", () => {
  it("replaces addresses, recipient names, client names, phones, ID, account and card numbers", () => {
    const html = `<p>Dear Thandi Merwe,</p>
<p>Your FNB account 62812345678 at Acme Holdings is on hold. Call 082 555 1234 or +27 11 555 0000.</p>
<p>ID 8001015009087, card 4111 1111 1111 1111, reply to thandi.vdmerwe@acme.co.za</p>
<a href="https://fnb-secure-login.example.com/verify?u=thandi.vdmerwe@acme.co.za">Verify with FNB</a>`;
    const out = redact(html, names);
    for (const kept of ["FNB", "fnb-secure-login.example.com", "Verify with FNB", "Dear"]) expect(out).toContain(kept);
    for (const gone of [
      "Thandi",
      "Merwe",
      "Acme Holdings",
      "62812345678",
      "082 555 1234",
      "+27 11 555 0000",
      "8001015009087",
      "4111 1111 1111 1111",
      "acme.co.za",
    ])
      expect(out, gone).not.toContain(gone);
    expect(out).toContain(PLACEHOLDER.email);
    expect(out).toContain(PLACEHOLDER.name);
    expect(out).toContain(PLACEHOLDER.phone);
    expect(out).toContain(PLACEHOLDER.number);
  });

  it("leaves an inline image's base64 alone and keeps amounts and dates", () => {
    const image = "data:image/png;base64,iVBORw0KGgo12345678901234AAAA";
    const out = redact(`<img src="${image}"><p>Pay R4,999.00 by 2026-10-31</p>`, names);
    expect(out).toContain(image);
    expect(out).toContain("R4,999.00 by 2026-10-31");
  });

  it("takes names from the display name and the address, three letters or more", () => {
    expect(namePieces("Jo M. Dlamini", "jo.dlamini@x.co.za")).toEqual(["Dlamini", "dlamini"]);
    expect(namePieces(undefined, "accounts_payable@x.co.za")).toEqual(["accounts", "payable"]);
  });
});
