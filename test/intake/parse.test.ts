import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createCase } from "../../src/db/cases";
import { extractOriginal } from "../../src/intake/forward";
import { BODY_PART_LIMIT, BODY_TOTAL_LIMIT, ParseError, parseMessage, storeParsed } from "../../src/intake/parse";
import { parsedKey, readArtefact, type Store } from "../../src/intake/store";
import { forwards } from "../fixtures/forward/load";

// D01 T01 §5: the original parsed by postal-mime with its rendering bounded, its attachments stored, then the summary.
const enc = (text: string) => new TextEncoder().encode(text);
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const PDF = enc("%PDF-1.4\n% fictional invoice\n%%EOF\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
// In chunks: one call spreading megabytes of arguments overflows the stack.
const b64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

// A multipart original: two Received headers, text and HTML alternatives with an inline image, a PDF, a CSV, an
// unnamed attachment and an attached message.
const ORIGINAL = enc(
  [
    "Received: from relay-two.fictional-supplier.example by mx.fictional-recipient.example",
    "Received: from relay-one.fictional-supplier.example by relay-two.fictional-supplier.example",
    "From: Fictional Supplier <billing@fictional-supplier.example>",
    "To: accounts@fictional-recipient.example",
    "Subject: Invoice 42",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="mixed"',
    "",
    "--mixed",
    'Content-Type: multipart/related; boundary="related"',
    "",
    "--related",
    'Content-Type: multipart/alternative; boundary="alt"',
    "",
    "--alt",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Please pay invoice 42.",
    "--alt",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<p>Please pay invoice 42.</p><img src="cid:logo@fictional">',
    "--alt--",
    "--related",
    "Content-Type: image/png",
    "Content-ID: <logo@fictional>",
    "Content-Transfer-Encoding: base64",
    "",
    b64(PNG),
    "--related--",
    "--mixed",
    'Content-Type: application/pdf; name="invoice-42.pdf"',
    'Content-Disposition: attachment; filename="invoice-42.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(PDF),
    "--mixed",
    'Content-Type: text/csv; name="lines.csv"',
    "Content-Disposition: attachment",
    "",
    "item,amount\r\nwidgets,4200",
    "--mixed",
    "Content-Type: application/octet-stream",
    "Content-Disposition: attachment",
    "Content-Transfer-Encoding: base64",
    "",
    b64(enc("unnamed bytes")),
    "--mixed",
    "Content-Type: message/rfc822",
    "",
    "From: earlier@fictional-supplier.example\r\nSubject: Earlier\r\n\r\nThe earlier message.\r\n",
    "--mixed--",
    "",
  ].join("\r\n"),
);

async function newCase() {
  const made = await createCase(env.DB, { orgId: "org-parse", channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  return made.value.id;
}
const bytesAt = async (key: string) =>
  new Uint8Array((await (await env.ARTEFACTS.get(key))?.arrayBuffer()) ?? new ArrayBuffer(0));

describe("parseMessage", () => {
  it("returns every header in order with repeats, both bodies, and each attachment with its name, type and id", async () => {
    const parsed = await parseMessage(ORIGINAL);
    expect(parsed.headers.filter((h) => h.name === "Received").map((h) => h.value)).toEqual([
      "from relay-two.fictional-supplier.example by mx.fictional-recipient.example",
      "from relay-one.fictional-supplier.example by relay-two.fictional-supplier.example",
    ]);
    expect(parsed.text?.trim()).toBe("Please pay invoice 42.");
    expect(parsed.html).toContain("<p>Please pay invoice 42.</p>");
    expect(
      parsed.attachments.map((a) => ({ filename: a.filename, mediaType: a.mediaType, contentId: a.contentId })),
    ).toEqual([
      { filename: null, mediaType: "image/png", contentId: "<logo@fictional>" },
      { filename: "invoice-42.pdf", mediaType: "application/pdf", contentId: null },
      { filename: "lines.csv", mediaType: "text/csv", contentId: null },
      { filename: null, mediaType: "application/octet-stream", contentId: null },
      { filename: null, mediaType: "message/rfc822", contentId: null },
    ]);
    expect(parsed.attachments[0]?.bytes).toEqual(PNG);
    expect(parsed.attachments[1]?.bytes).toEqual(PDF);
    // The attached message stays an attachment: its text is not merged into the original's body.
    expect(parsed.text).not.toContain("The earlier message");
    expect(parsed.truncated).toEqual([]);
  });

  it("refuses a message past the parser's limits as a ParseError, and reads a cut-off one as far as it goes", async () => {
    let body = "text\r\n";
    for (let i = 0; i < 300; i++)
      body = `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n${body}--b${i}--\r\n`;
    await expect(parseMessage(enc(`From: a@fictional.example\r\nMIME-Version: 1.0\r\n${body}`))).rejects.toBeInstanceOf(
      ParseError,
    );
    const cut = ORIGINAL.subarray(0, ORIGINAL.indexOf(enc("--related--")[0] as number, 900));
    expect((await parseMessage(cut)).text?.trim()).toBe("Please pay invoice 42.");
  });
});

describe("the rendering bound", () => {
  const multipart = (parts: string[]) =>
    enc(
      [
        "From: billing@fictional-supplier.example",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        ...parts.flatMap((p) => ["--b", p]),
        "--b--",
        "",
      ].join("\r\n"),
    );

  it("cuts an 8 MB crafted text part to 1 MiB and keeps the whole part", async () => {
    const text = `${"&".repeat(900)}\r\n`.repeat(8889);
    const parsed = await parseMessage(multipart([`Content-Type: text/plain\r\n\r\n${text}`]));
    expect(parsed.truncated).toHaveLength(1);
    expect(parsed.truncated[0]).toMatchObject({ mediaType: "text/plain", keptBytes: BODY_PART_LIMIT });
    expect(parsed.truncated[0]?.full.byteLength).toBe(text.length);
    expect((parsed.text ?? "").length).toBeLessThanOrEqual(BODY_PART_LIMIT);
  });

  it("holds twenty parts under the per-part limit and an HTML part to 2 MiB together", async () => {
    const part = `${"x".repeat(78)}\r\n`.repeat(10_000);
    const parsed = await parseMessage(
      multipart([
        ...Array.from({ length: 20 }, () => `Content-Type: text/plain\r\n\r\n${part}`),
        "Content-Type: text/html\r\n\r\n<p>last</p>",
      ]),
    );
    const kept = parsed.truncated.reduce((sum, t) => sum + t.keptBytes, 0);
    // The parts that fit whole, plus what was kept of the cut ones, stay within the total.
    const whole = 20 - parsed.truncated.filter((t) => t.mediaType === "text/plain").length;
    expect(whole * part.length + kept).toBeLessThanOrEqual(BODY_TOTAL_LIMIT);
    expect(parsed.truncated.length).toBeGreaterThan(0);
    expect(parsed.truncated.map((t) => t.mediaType)).toContain("text/html");
  });

  it("never cuts a text or HTML attachment", async () => {
    const big = "y".repeat(BODY_PART_LIMIT + 4096);
    const parsed = await parseMessage(
      multipart([
        "Content-Type: text/plain\r\n\r\nShort body.",
        `Content-Type: text/plain\r\nContent-Disposition: attachment; filename="big.txt"\r\n\r\n${big}`,
        `Content-Type: text/html\r\nContent-Disposition: attachment; filename="big.html"\r\n\r\n${big}`,
      ]),
    );
    expect(parsed.truncated).toEqual([]);
    expect(parsed.attachments.map((a) => a.bytes.byteLength)).toEqual([big.length, big.length]);
  });
});

describe("storeParsed", () => {
  it("stores each attachment byte for byte under its name, then a summary naming them and the forward", async () => {
    const caseId = await newCase();
    const forward = await extractOriginal(forwards["two-originals"]);
    const summary = await storeParsed(store, caseId, await parseMessage(ORIGINAL), forward);
    expect(summary.attachments.map((a) => a.filename)).toEqual([
      "attachment-1",
      "invoice-42.pdf",
      "lines.csv",
      "attachment-4",
      "attachment-5",
    ]);
    expect(await bytesAt(summary.attachments[0]?.key as string)).toEqual(PNG);
    expect(await bytesAt(summary.attachments[1]?.key as string)).toEqual(PDF);
    expect(await bytesAt(summary.attachments[3]?.key as string)).toEqual(enc("unnamed bytes"));
    expect(summary.attachments[0]).toMatchObject({ mediaType: "image/png", contentId: "<logo@fictional>" });
    const rows = await env.DB.prepare(
      "SELECT r2_key, media_type FROM artefacts WHERE case_id = ? AND kind = 'attachment'",
    )
      .bind(caseId)
      .all<{ r2_key: string; media_type: string }>();
    expect(rows.results.map((r) => r.r2_key).sort()).toEqual(summary.attachments.map((a) => a.key).sort());
    const read = JSON.parse(new TextDecoder().decode(await bytesAt(parsedKey(caseId))));
    expect(read).toEqual(summary);
    expect(read.forward).toEqual({ path: "rfc822", headersAvailable: true, otherOriginals: 1 });
    expect(JSON.stringify(read).length).toBeLessThan(1024 * 1024);
    // An inline forward's outcome is recorded as such.
    const inline = await extractOriginal(forwards["inline-forward"]);
    const other = await newCase();
    expect((await storeParsed(store, other, await parseMessage(inline.original), inline)).forward).toEqual({
      path: "inline",
      headersAvailable: false,
      otherOriginals: 0,
    });
  });

  it("writes no summary when an attachment cannot be stored, and completes on the retry without conflict", async () => {
    const caseId = await newCase();
    const parsed = await parseMessage(ORIGINAL);
    const forward = await extractOriginal(forwards["attached-rfc822"]);
    let puts = 0;
    const failing: Store = {
      db: env.DB,
      bucket: new Proxy(env.ARTEFACTS, {
        get(target, key) {
          if (key === "put")
            return (...args: Parameters<R2Bucket["put"]>) => {
              puts += 1;
              if (puts === 3) return Promise.reject(new Error("R2 unavailable"));
              return target.put(...args);
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    };
    await expect(storeParsed(failing, caseId, parsed, forward)).rejects.toThrow();
    expect(await env.ARTEFACTS.head(parsedKey(caseId))).toBeNull();
    const summary = await storeParsed(store, caseId, parsed, forward);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM artefacts WHERE case_id = ? AND kind = 'attachment'")
      .bind(caseId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(summary.attachments.length);
    expect(await env.ARTEFACTS.head(parsedKey(caseId))).not.toBeNull();
  });

  it("keeps each cut body part whole in R2 and names it in the summary's truncated", async () => {
    const caseId = await newCase();
    const text = `${"&".repeat(900)}\r\n`.repeat(2000);
    const message = enc(`From: billing@fictional-supplier.example\r\nContent-Type: text/plain\r\n\r\n${text}`);
    const summary = await storeParsed(store, caseId, await parseMessage(message), await extractOriginal(message));
    expect(summary.truncated).toEqual([
      {
        mediaType: "text/plain",
        charset: null,
        key: expect.stringContaining("body-1.txt"),
        fullBytes: text.length,
        keptBytes: BODY_PART_LIMIT,
      },
    ]);
    expect(new TextDecoder().decode(await bytesAt(summary.truncated[0]?.key as string))).toBe(text);
  });
});

describe("completion review cases", () => {
  const multipart = (parts: string[]) =>
    enc(
      [
        "From: billing@fictional-supplier.example",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        ...parts.flatMap((p) => ["--b", p]),
        "--b--",
        "",
      ].join("\r\n"),
    );

  it("stores a calendar-labelled attachment's own bytes, never postal-mime's text rewrite", async () => {
    const binary = new Uint8Array([0x00, 0xff, 0x0d, 0x0a, 0x80, 0x81, 0x00, 0x0a, 0x0a, 0x0a]);
    const invite = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n\r\n";
    const parsed = await parseMessage(
      multipart([
        "Content-Type: text/plain\r\n\r\nSee attached.",
        `Content-Type: text/calendar; charset=utf-8\r\nContent-Disposition: attachment; filename="odd.ics"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(binary)}`,
        `Content-Type: application/ics\r\nContent-Disposition: attachment; filename="invite.ics"\r\nContent-Transfer-Encoding: base64\r\n\r\n${btoa(invite)}`,
      ]),
    );
    expect(parsed.attachments.map((a) => a.bytes)).toEqual([binary, enc(invite)]);
  });

  it("keeps a cut part's charset, so text past the cut in UTF-16 reads back", async () => {
    const caseId = await newCase();
    const utf16 = (text: string) => {
      const out = new Uint8Array(text.length * 2);
      for (let i = 0; i < text.length; i++) {
        out[i * 2] = text.charCodeAt(i) & 0xff;
        out[i * 2 + 1] = text.charCodeAt(i) >> 8;
      }
      return out;
    };
    const body = `${"padding line\r\n".repeat(60_000)}https://fictional-lure.example/pay\r\n`;
    const message = multipart([
      `Content-Type: text/plain; charset=UTF-16LE\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(utf16(body))}`,
    ]);
    const summary = await storeParsed(store, caseId, await parseMessage(message), await extractOriginal(message));
    expect(summary.truncated).toMatchObject([{ mediaType: "text/plain", charset: "utf-16le" }]);
    const read = await readArtefact(store, caseId, summary.truncated[0]?.key as string);
    if (!read || !("body" in read)) throw new Error("the cut part is missing");
    const decoded = new TextDecoder(summary.truncated[0]?.charset ?? "utf-8").decode(read.body);
    expect(decoded).toContain("https://fictional-lure.example/pay");
    expect(summary.text ?? "").not.toContain("fictional-lure.example");
  });

  it("stores a summary whose contents match the message, read back through the store and its row", async () => {
    const caseId = await newCase();
    const forward = await extractOriginal(forwards["attached-rfc822"]);
    await storeParsed(store, caseId, await parseMessage(ORIGINAL), forward);
    const read = await readArtefact(store, caseId, parsedKey(caseId));
    if (!read || !("body" in read)) throw new Error("the summary is missing");
    expect(read.stored).toMatchObject({ kind: "raw", mediaType: "application/json" });
    const summary = JSON.parse(new TextDecoder().decode(read.body));
    // Values from the fixture itself, not from what storeParsed answered.
    expect(summary.headers.map((h: { name: string }) => h.name)).toEqual([
      "Received",
      "Received",
      "From",
      "To",
      "Subject",
      "MIME-Version",
      "Content-Type",
    ]);
    expect(summary.text.trim()).toBe("Please pay invoice 42.");
    expect(summary.html).toContain('<img src="cid:logo@fictional">');
    expect(
      summary.attachments.map((a: { filename: string; mediaType: string; bytes: number }) => [
        a.filename,
        a.mediaType,
        a.bytes,
      ]),
    ).toEqual([
      ["attachment-1", "image/png", PNG.byteLength],
      ["invoice-42.pdf", "application/pdf", PDF.byteLength],
      ["lines.csv", "text/csv", "item,amount\r\nwidgets,4200".length],
      ["attachment-4", "application/octet-stream", "unnamed bytes".length],
      ["attachment-5", "message/rfc822", expect.any(Number)],
    ]);
    expect(summary.forward).toEqual({ path: "rfc822", headersAvailable: true, otherOriginals: 0 });
    expect(summary.truncated).toEqual([]);
  });
});

describe("round 1 cases", () => {
  it("records each part's own declared type when two share their bytes and name", async () => {
    const caseId = await newCase();
    const message = enc(
      [
        "From: billing@fictional-supplier.example",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        "Two copies.",
        "--b",
        'Content-Type: application/pdf; name="invoice.pdf"',
        "Content-Disposition: attachment",
        "Content-Transfer-Encoding: base64",
        "",
        b64(PDF),
        "--b",
        'Content-Type: application/x-msdownload; name="invoice.pdf"',
        "Content-Disposition: attachment",
        "Content-Transfer-Encoding: base64",
        "",
        b64(PDF),
        "--b--",
        "",
      ].join("\r\n"),
    );
    const summary = await storeParsed(store, caseId, await parseMessage(message), await extractOriginal(message));
    expect(summary.attachments.map((a) => a.mediaType)).toEqual(["application/pdf", "application/x-msdownload"]);
    expect(summary.attachments[0]?.key).toBe(summary.attachments[1]?.key);
  });

  it("keeps a binary attachment that ends the message byte for byte, with no line break added", async () => {
    const message = new Uint8Array([
      ...enc(
        [
          "From: billing@fictional-supplier.example",
          'Content-Type: multipart/mixed; boundary="b"',
          "",
          "--b",
          "Content-Type: text/plain",
          "",
          "Binary follows.",
          "--b",
          'Content-Type: application/octet-stream; name="data.bin"',
          "Content-Disposition: attachment",
          "Content-Transfer-Encoding: binary",
          "",
          "",
        ].join("\r\n"),
      ),
      1,
      2,
      3,
      4,
    ]);
    const parsed = await parseMessage(message);
    expect(parsed.attachments.at(-1)?.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});
