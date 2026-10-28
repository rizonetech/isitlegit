import PostalMime from "postal-mime";
import { describe, expect, it, vi } from "vitest";
import { extractOriginal, ParseError } from "../../src/intake/forward";
import { forwards, inners } from "../fixtures/forward/load";

// D01 T01 §4: the original inside a forward, its precedence, the inline fallback and the parser's refusal.
// The placeholder .msg the fixture carries (base64 in attached-msg.eml): the compound-file magic, 56 zero bytes and a
// note. Compared whole, so a truncated or altered attachment fails.
const PLACEHOLDER_MSG = new Uint8Array([
  ...[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  ...new Array(56).fill(0),
  ...new TextEncoder().encode("placeholder Outlook message: D01 T01 §6 parses real ones"),
]);

describe("extractOriginal", () => {
  it("returns the attached original's exact bytes, with its headers, for each attachment kind", async () => {
    expect(await extractOriginal(forwards["attached-rfc822"])).toEqual({
      original: inners["rfc822-1"],
      format: "eml",
      headersAvailable: true,
      path: "rfc822",
      otherOriginals: 0,
    });
    expect(await extractOriginal(forwards["attached-eml-file"])).toEqual({
      original: inners["eml-1"],
      format: "eml",
      headersAvailable: true,
      path: "eml",
      otherOriginals: 0,
    });
    expect(await extractOriginal(forwards["attached-msg"])).toEqual({
      original: PLACEHOLDER_MSG,
      format: "msg",
      headersAvailable: true,
      path: "msg",
      otherOriginals: 0,
    });
    // A message/rfc822 part sent without a Content-Disposition is still the original, never merged into the body.
    expect(await extractOriginal(forwards["attached-rfc822-inline"])).toMatchObject({
      original: inners["nodisp-1"],
      path: "rfc822",
    });
  });

  it("takes only the outermost attachment of a forwarded forward", async () => {
    expect(await extractOriginal(forwards["nested-forward"])).toMatchObject({
      original: inners["nested-middle"],
      path: "rfc822",
      otherOriginals: 0,
    });
  });

  it("ranks the type over the order, and counts the attached messages not chosen", async () => {
    // A .eml attachment comes first, the message/rfc822 part second: the part wins.
    expect(await extractOriginal(forwards["rfc822-and-eml"])).toMatchObject({
      original: inners["winner-rfc822"],
      path: "rfc822",
      otherOriginals: 1,
    });
    // A .msg comes first, the .eml second: the .eml wins.
    expect(await extractOriginal(forwards["eml-and-msg"])).toMatchObject({
      original: inners["winner-eml"],
      path: "eml",
      otherOriginals: 1,
    });
    // Two originals: the first is checked and the second counted, not dropped unseen.
    expect(await extractOriginal(forwards["two-originals"])).toMatchObject({
      original: inners["first-of-two"],
      otherOriginals: 1,
    });
  });

  it("falls back to the forward itself, unchanged and without headers, when nothing is attached as a message", async () => {
    for (const name of ["inline-forward", "inline-with-pdf"] as const)
      expect(await extractOriginal(forwards[name]), name).toEqual({
        original: forwards[name],
        format: "eml",
        headersAvailable: false,
        path: "inline",
        otherOriginals: 0,
      });
  });

  it("refuses a forward past the parser's limits as a ParseError, not a crash", async () => {
    // 300 nested multiparts, past postal-mime's nesting limit of 256.
    let body = "text\r\n";
    for (let i = 0; i < 300; i++)
      body = `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n${body}--b${i}--\r\n`;
    const deep = new TextEncoder().encode(`From: boss@fictional-recipient.example\r\nMIME-Version: 1.0\r\n${body}`);
    await expect(extractOriginal(deep)).rejects.toBeInstanceOf(ParseError);
  });

  describe("round 1 cases", () => {
    const enc = (text: string) => new TextEncoder().encode(text);
    const original = "From: billing@fictional-supplier.example\r\nSubject: Pay now\r\n\r\nPlease pay today.\r\n";

    it("finds the original beside an 8 MB crafted text part without rendering the text", async () => {
      // A plain-text part that the full parser's text-to-HTML step blew past 128 MiB on.
      const text = `${"&".repeat(900)}\r\n`.repeat(8889);
      const forward = enc(
        [
          "From: boss@fictional-recipient.example",
          "MIME-Version: 1.0",
          'Content-Type: multipart/mixed; boundary="outer"',
          "",
          "--outer",
          'Content-Type: multipart/alternative; boundary="alt"',
          "",
          "--alt",
          "Content-Type: text/plain",
          "",
          text,
          "--alt",
          "Content-Type: text/html",
          "",
          "<p>see attached</p>",
          "--alt--",
          "--outer",
          "Content-Type: message/rfc822",
          "",
          original,
          "--outer--",
          "",
        ].join("\r\n"),
      );
      expect(forward.byteLength).toBeGreaterThan(8_000_000);
      // The parser sees header blocks only: no body reaches its rendering.
      const parse = vi.spyOn(PostalMime, "parse");
      const started = Date.now();
      const found = await extractOriginal(forward);
      const sizeOf = (input: unknown) =>
        typeof input === "string"
          ? input.length
          : input instanceof ArrayBuffer || ArrayBuffer.isView(input)
            ? input.byteLength
            : Number.POSITIVE_INFINITY;
      const largest = Math.max(...parse.mock.calls.map(([input]) => sizeOf(input)));
      parse.mockRestore();
      expect(largest).toBeLessThan(64 * 1024);
      expect(found).toMatchObject({ path: "rfc822", headersAvailable: true });
      expect(new TextDecoder().decode(found.original)).toBe(original);
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    it("returns a .msg sent under a calendar type byte for byte", async () => {
      const msg = forwards["attached-msg"];
      const altered = new TextDecoder()
        .decode(msg)
        .replace("application/vnd.ms-outlook", "text/calendar; charset=utf-8");
      expect(await extractOriginal(enc(altered))).toMatchObject({ original: PLACEHOLDER_MSG, path: "msg" });
    });

    it("keeps a forward whose whole body is the original, with no line break added", async () => {
      const forward = enc(
        `From: boss@fictional-recipient.example\r\nContent-Type: message/rfc822\r\n\r\n${original}hello`,
      );
      expect(await extractOriginal(forward)).toMatchObject({ original: enc(`${original}hello`), path: "rfc822" });
    });

    it("decodes a quoted-printable .eml exactly, and ignores a boundary string that does not start a line", async () => {
      const forward = enc(
        [
          "From: boss@fictional-recipient.example",
          'Content-Type: multipart/mixed; boundary="b"',
          "",
          "--b",
          "Content-Type: text/plain",
          "",
          "a line mentioning --b in the middle",
          "--b",
          'Content-Type: application/octet-stream; name="qp.eml"',
          "Content-Disposition: attachment",
          "Content-Transfer-Encoding: quoted-printable",
          "",
          "From: billing@fictional-supplier.example=0D=0ASubject: Caf=C3=A9=0D=0A=0D=0ABody that is lo=",
          "ng.=0D=0A",
          "--b--",
          "",
        ].join("\r\n"),
      );
      expect(await extractOriginal(forward)).toMatchObject({
        original: enc("From: billing@fictional-supplier.example\r\nSubject: Café\r\n\r\nBody that is long.\r\n"),
        path: "eml",
        otherOriginals: 0,
      });
    });

    it("cuts an attached original only at a delimiter that starts a line", async () => {
      // The original mentions the boundary mid-line; a cut there would end it early.
      const inner =
        "From: billing@fictional-supplier.example\r\nSubject: Ref --b2 attached\r\n\r\nQuote: see --b2 below.\r\n";
      const forward = enc(
        [
          "From: boss@fictional-recipient.example",
          'Content-Type: multipart/mixed; boundary="b2"',
          "",
          "--b2",
          "Content-Type: message/rfc822",
          "",
          inner,
          "--b2--",
          "",
        ].join("\r\n"),
      );
      expect(await extractOriginal(forward)).toMatchObject({ original: enc(inner), path: "rfc822" });
    });
  });
});
