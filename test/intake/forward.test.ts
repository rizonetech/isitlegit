import { describe, expect, it } from "vitest";
import { extractOriginal, ParseError } from "../../src/intake/forward";
import { forwards, inners } from "../fixtures/forward/load";

// D01 T01 §4: the original inside a forward, its precedence, the inline fallback and the parser's refusal.
const MSG_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

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
    const msg = await extractOriginal(forwards["attached-msg"]);
    expect({ ...msg, original: [...msg.original.subarray(0, 8)] }).toEqual({
      original: MSG_MAGIC,
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
});
