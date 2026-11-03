import PostalMime from "postal-mime";
import { describe, expect, it, vi } from "vitest";
import { extractOriginal, extractOriginals, MAX_ORIGINALS, ParseError } from "../../src/intake/forward";
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

  it("returns every original in order up to the bound, the excess counted (D01 T01 §12)", async () => {
    const two = await extractOriginals(forwards["two-originals"]);
    expect(two.total).toBe(2);
    expect(two.chosen).toMatchObject({ original: inners["first-of-two"], otherOriginals: 1 });
    expect(two.others).toHaveLength(1);
    expect(two.others[0]?.original).not.toEqual(inners["first-of-two"]);
    expect(new TextDecoder().decode(two.others[0]?.original)).toContain("Subject: Updated banking details");
    // Six attached originals: the chosen one plus four more, in attachment order, and six counted.
    const part = (n: number) =>
      `--b\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename="o${n}.eml"\r\n\r\nFrom: a@bank.example\r\nSubject: Original ${n}\r\n\r\nPay ${n}.\r\n`;
    const six = new TextEncoder().encode(
      `From: member@example.com\r\nSubject: Fwd: six\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n${[1, 2, 3, 4, 5, 6].map(part).join("")}--b--\r\n`,
    );
    const all = await extractOriginals(six);
    expect(all.total).toBe(6);
    expect(MAX_ORIGINALS).toBe(5);
    expect(all.others).toHaveLength(4);
    const subjects = [all.chosen, ...all.others].map(
      (o) => /Subject: (Original \d)/.exec(new TextDecoder().decode(o.original))?.[1],
    );
    expect(subjects).toEqual(["Original 1", "Original 2", "Original 3", "Original 4", "Original 5"]);
    // No attached message: the forward itself, and nothing counted.
    const inline = await extractOriginals(forwards["inline-forward"]);
    expect(inline).toMatchObject({ total: 0, others: [] });
    expect(inline.chosen.path).toBe("inline");
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
      // Only postal-mime's first stage runs: neither its full parse nor the step that renders text into HTML.
      type Stages = { parse: () => unknown; renderTextContent: () => unknown };
      const prototype = PostalMime.prototype as unknown as Stages;
      const fullParse = vi.spyOn(prototype, "parse");
      const render = vi.spyOn(prototype, "renderTextContent");
      const found = await extractOriginal(forward);
      const calls = [fullParse.mock.calls.length, render.mock.calls.length];
      fullParse.mockRestore();
      render.mockRestore();
      expect(calls).toEqual([0, 0]);
      expect(found).toMatchObject({ path: "rfc822", headersAvailable: true });
      expect(new TextDecoder().decode(found.original)).toBe(original);
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

describe("round 2 cases", () => {
  const enc = (text: string) => new TextEncoder().encode(text);
  const message = (tag: string) => `From: billing@fictional-supplier.example\r\nSubject: ${tag}\r\n\r\n${tag} body\r\n`;

  it("reads the boundary from its own parameter, never from inside another's quoted value", async () => {
    const forward = enc(
      [
        "From: boss@fictional-recipient.example",
        'Content-Type: multipart/mixed; name="ignored; boundary=decoy; ignored"; boundary="real"',
        "",
        "--decoy",
        "Content-Type: message/rfc822",
        "",
        message("benign"),
        "--decoy--",
        "--real",
        "Content-Type: message/rfc822",
        "",
        message("suspicious"),
        "--real--",
        "",
      ].join("\r\n"),
    );
    expect(await extractOriginal(forward)).toMatchObject({ original: enc(message("suspicious")), otherOriginals: 0 });
  });

  it("decodes a 22 MB quoted-printable original into one buffer", async () => {
    const line = `${"a".repeat(74)}\r\n`;
    const body = line.repeat(300_000);
    const forward = enc(
      [
        "From: boss@fictional-recipient.example",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        'Content-Type: application/octet-stream; name="original.eml"',
        "Content-Transfer-Encoding: quoted-printable",
        "",
        `${body}--b--`,
        "",
      ].join("\r\n"),
    );
    expect(forward.byteLength).toBeGreaterThan(22_000_000);
    const found = await extractOriginal(forward);
    expect(found.original.byteLength).toBe(body.length - 2);
    expect(found.path).toBe("eml");
  });

  it("reads a forward with a 60,000-character boundary without parts (timed in test/node/forward-memory.test.ts)", async () => {
    const boundary = `${"-".repeat(60_000)}X`;
    const forward = enc(
      `From: boss@fictional-recipient.example\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${"-".repeat(5_000_000)}`,
    );
    // The path alone: a failure must not print five megabytes of bytes.
    expect((await extractOriginal(forward)).path).toBe("inline");
  });

  it("reads a long run of near-delimiters as no parts", async () => {
    const boundary = `${"-".repeat(68)}X`;
    const forward = enc(
      `From: boss@fictional-recipient.example\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${`${"-".repeat(70)}\n`.repeat(70_000)}`,
    );
    expect((await extractOriginal(forward)).path).toBe("inline");
  });

  it("counts a digest's untyped parts as messages, in order", async () => {
    const forward = enc(
      [
        "From: boss@fictional-recipient.example",
        'Content-Type: multipart/mixed; boundary="outer"',
        "",
        "--outer",
        'Content-Type: multipart/digest; boundary="digest"',
        "",
        "--digest",
        "",
        message("suspicious"),
        "--digest--",
        "--outer",
        "Content-Type: message/rfc822",
        "",
        message("benign"),
        "--outer--",
        "",
      ].join("\r\n"),
    );
    expect(await extractOriginal(forward)).toMatchObject({ original: enc(message("suspicious")), otherOriginals: 1 });
  });

  it("decodes malformed base64 as postal-mime does, never throwing outside ParseError", async () => {
    for (const encoded of ["QUJD=REVG", "QUJD*REVG", "QUJDR"]) {
      const forward = enc(
        [
          "From: boss@fictional-recipient.example",
          'Content-Type: multipart/mixed; boundary="b"',
          "",
          "--b",
          'Content-Type: application/octet-stream; name="original.eml"',
          "Content-Transfer-Encoding: base64",
          "",
          encoded,
          "--b--",
          "",
        ].join("\r\n"),
      );
      expect((await extractOriginal(forward)).path, encoded).toBe("eml");
    }
  });

  it("ignores a boundary inside a MIME comment, and a comment after the transfer encoding (round 3)", async () => {
    const forward = enc(
      [
        "From: boss@fictional-recipient.example",
        "Content-Type: multipart/mixed (note; boundary=decoy;); boundary=real",
        "",
        "--decoy",
        "Content-Type: message/rfc822",
        "",
        message("benign"),
        "--decoy--",
        "--real",
        "Content-Type: message/rfc822",
        "",
        message("suspicious"),
        "--real--",
        "",
      ].join("\r\n"),
    );
    expect(await extractOriginal(forward)).toMatchObject({ original: enc(message("suspicious")), otherOriginals: 0 });
    for (const cte of ["base64 (comment)", "(comment) base64"]) {
      const encoded = btoa(message("encoded"));
      const withComment = enc(
        [
          "From: boss@fictional-recipient.example",
          'Content-Type: multipart/mixed; boundary="b"',
          "",
          "--b",
          'Content-Type: application/octet-stream; name="original.eml"',
          `Content-Transfer-Encoding: ${cte}`,
          "",
          encoded,
          "--b--",
          "",
        ].join("\r\n"),
      );
      expect(await extractOriginal(withComment), cte).toMatchObject({ original: enc(message("encoded")), path: "eml" });
    }
  });

  describe("final review cases", () => {
    it("decodes a whole-message original that declares a transfer encoding", async () => {
      const forward = enc(
        `From: boss@fictional-recipient.example\r\nContent-Type: message/rfc822\r\nContent-Transfer-Encoding: base64\r\n\r\n${btoa(message("encoded-root"))}\r\n`,
      );
      expect(await extractOriginal(forward)).toMatchObject({ original: enc(message("encoded-root")), path: "rfc822" });
    });

    it("keeps the last attached part whole when no closing boundary ends the forward", async () => {
      for (const [cte, body] of [
        ["base64", btoa(message("unclosed-b64"))],
        ["quoted-printable", message("unclosed-qp").replaceAll("\r\n", "=0D=0A")],
      ] as const) {
        const forward = enc(
          [
            "From: boss@fictional-recipient.example",
            'Content-Type: multipart/mixed; boundary="b"',
            "",
            "--b",
            'Content-Type: application/octet-stream; name="original.eml"',
            `Content-Transfer-Encoding: ${cte}`,
            "",
            body,
            "",
          ].join("\r\n"),
        );
        // Base64 ignores line breaks; in quoted-printable the forward's final line break is a hard one, part of the
        // content, since no closing delimiter claims it.
        const expected = cte === "base64" ? message("unclosed-b64") : `${message("unclosed-qp")}\r\n`;
        expect(await extractOriginal(forward), cte).toMatchObject({ original: enc(expected), path: "eml" });
      }
    });

    it("refuses a forward past postal-mime's part-count and header-size limits as a ParseError", async () => {
      // 10,001 parts, past maxPartCount's 10,000.
      const parts = Array.from({ length: 10_001 }, () => "--p\r\nContent-Type: text/plain\r\n\r\nx").join("\r\n");
      const wide = enc(
        `From: boss@fictional-recipient.example\r\nContent-Type: multipart/mixed; boundary="p"\r\n\r\n${parts}\r\n--p--\r\n`,
      );
      await expect(extractOriginal(wide)).rejects.toBeInstanceOf(ParseError);
      // 40,000 header lines, each counted as at least 64 bytes against maxHeadersSize's 2 MiB.
      const tall = enc(`From: boss@fictional-recipient.example\r\n${"X-A: b\r\n".repeat(40_000)}\r\nbody\r\n`);
      await expect(extractOriginal(tall)).rejects.toBeInstanceOf(ParseError);
    });
  });
});
