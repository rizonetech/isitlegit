import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createCase, getCase, setOriginalHeader } from "../../src/db/cases";
import { HEADER_TEXT_LIMIT, oneLine, originalHeaderOf } from "../../src/intake/original-header";
import { parsedKey, putAttachment, putRaw, rawKey, readArtefact, type Store } from "../../src/intake/store";
import { parse } from "../../src/pipeline/analysis-workflow";
import { forwards } from "../fixtures/forward/load";
import { msgs, twin } from "../fixtures/msg/load";

// D01 T01 §16: the checked original's subject and sender on the case, for the report header.
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const h = (name: string, value: string) => ({ name, value });

describe("originalHeaderOf", () => {
  it("decodes encoded words in the subject and the display name, and canonicalises the address", () => {
    expect(
      originalHeaderOf([
        h("Subject", "=?UTF-8?B?UmVrZW5pbmcgNzcg4oCTIGJldGFhbA==?="),
        h("From", "=?UTF-8?Q?Gr=C3=BCn_Accounts?= <Billing@Bücher.Example>"),
      ]),
    ).toEqual({
      subject: "Rekening 77 – betaal",
      fromName: "Grün Accounts",
      fromAddress: "billing@xn--bcher-kva.example",
    });
  });

  it("makes one line: folding, controls and bidirectional overrides removed", () => {
    expect(oneLine("Pay\r\n\tnow\u0007 \u202Egpj.exe\u202C  please")).toBe("Pay now gpj.exe please");
    expect(oneLine(" \u200F \t")).toBeNull();
  });

  it("cuts at the limit in code points, never inside a character", () => {
    const long = oneLine("😀".repeat(400));
    expect([...(long ?? "")]).toHaveLength(HEADER_TEXT_LIMIT);
    expect(long?.endsWith("…")).toBe(true);
    expect(long).not.toContain("�");
    expect(oneLine("a".repeat(HEADER_TEXT_LIMIT))).toBe("a".repeat(HEADER_TEXT_LIMIT));
  });

  it("gives no sender for several mailboxes, an invalid one, or a repeated From, and no subject when repeated", () => {
    expect(originalHeaderOf([h("From", "a@x.example, b@y.example")])).toMatchObject({
      fromName: null,
      fromAddress: null,
    });
    expect(originalHeaderOf([h("From", "Someone <not an address>")]).fromAddress).toBeNull();
    expect(
      originalHeaderOf([h("From", "a@x.example"), h("From", "b@y.example"), h("Subject", "1"), h("Subject", "2")]),
    ).toEqual({ subject: null, fromName: null, fromAddress: null });
  });

  it("decodes and bounds an oversized encoded display name", () => {
    const utf8 = String.fromCharCode(...new TextEncoder().encode("Ünïcode Supplier ".repeat(4)));
    const word = `=?UTF-8?B?${btoa(utf8)}?=`;
    const { fromName, fromAddress } = originalHeaderOf([h("From", `${Array(30).fill(word).join(" ")} <a@b.example>`)]);
    expect([...(fromName ?? "")]).toHaveLength(HEADER_TEXT_LIMIT);
    expect(fromName?.startsWith("Ünïcode Supplier")).toBe(true);
    expect(fromAddress).toBe("a@b.example");
  });

  it("decodes a display name once, so an encoded literal stays literal (completion review)", () => {
    const literal = btoa("=?UTF-8?Q?Trusted_Bank?=");
    expect(originalHeaderOf([h("From", `=?UTF-8?B?${literal}?= <x@y.example>`)]).fromName).toBe(
      "=?UTF-8?Q?Trusted_Bank?=",
    );
  });

  it("gives no sender for a field with two angle addresses, but counts none inside quotes or comments", () => {
    expect(originalHeaderOf([h("From", "Accounts <a@b.example> <x@y.example>")])).toMatchObject({
      fromName: null,
      fromAddress: null,
    });
    for (const malformed of [
      "Accounts a@b.example x@y.example",
      "Accounts a@b.example",
      "<a@b.example> trailing",
      "Name <a@b.example",
      "a@b.example <x@y.example>",
      '"unterminated <a@b.example>',
    ])
      expect(originalHeaderOf([h("From", malformed)]), malformed).toMatchObject({ fromName: null, fromAddress: null });
    expect(originalHeaderOf([h("From", '"a b"@x.example (desk)')]).fromAddress).toBe('"a b"@x.example');
    expect(originalHeaderOf([h("From", '"Pay <now>" (via <portal>) <a@b.example>')])).toMatchObject({
      fromName: "Pay <now>",
      fromAddress: "a@b.example",
    });
  });

  it("drops an address with a hidden character or past 254 characters, never cutting it", () => {
    expect(originalHeaderOf([h("From", '"pay\u202Emoc"@x.example')]).fromAddress).toBeNull();
    expect(originalHeaderOf([h("From", '"a\u0007b"@x.example')]).fromAddress).toBeNull();
    // A tab is header whitespace, not hidden.
    expect(originalHeaderOf([h("From", "Accounts\t<a@x.example>")]).fromAddress).toBe("a@x.example");
    const long = `${"a".repeat(64)}@${Array(4).fill("b".repeat(60)).join(".")}.example`;
    expect(long.length).toBeGreaterThan(254);
    expect(originalHeaderOf([h("From", long)]).fromAddress).toBeNull();
  });

  it("falls back to a .msg's own fields only when the headers have no Subject or From", () => {
    const msg = { subject: "From the file", name: "File Sender", address: "File@Sender.example" };
    expect(originalHeaderOf([], msg)).toEqual({
      subject: "From the file",
      fromName: "File Sender",
      fromAddress: "file@sender.example",
    });
    // Headers missing only one field: that field from the file, the other from the headers.
    expect(originalHeaderOf([h("From", "Hdr <h@x.example>")], msg)).toEqual({
      subject: "From the file",
      fromName: "Hdr",
      fromAddress: "h@x.example",
    });
    expect(originalHeaderOf([h("Subject", "Header")], msg)).toEqual({
      subject: "Header",
      fromName: "File Sender",
      fromAddress: "file@sender.example",
    });
    expect(originalHeaderOf([h("Subject", "Header"), h("From", "Hdr <h@x.example>")], msg)).toEqual({
      subject: "Header",
      fromName: "Hdr",
      fromAddress: "h@x.example",
    });
    // An Exchange sender's X.500 name is no address.
    expect(
      originalHeaderOf([], { ...msg, address: "/O=EXCHANGELABS/OU=FIRST/CN=RECIPIENTS/CN=SENDER" }).fromAddress,
    ).toBeNull();
  });
});

async function caseOf(channel: "email" | "upload", sourceKind: "mail" | "document" = "mail") {
  const made = await createCase(env.DB, { orgId: "org-header", channel, headersAvailable: false, sourceKind });
  if (!made.ok) throw new Error(made.error.message);
  return made.value.id;
}
const header = async (id: string) => {
  const read = await getCase(env.DB, "org-header", id);
  if (!read.ok) throw new Error(read.error.message);
  const { originalSubject, originalFromName, originalFromAddress } = read.value;
  return { originalSubject, originalFromName, originalFromAddress };
};
const MAIL = { channel: "email" as const, sourceKind: "mail" as const, headersAvailable: false };
const UPLOAD = { channel: "upload" as const, sourceKind: "mail" as const, headersAvailable: false };
const enc = (s: string) => new TextEncoder().encode(s);
// A forward carrying `bytes` as an attached Outlook message.
const forwardWithMsg = (bytes: Uint8Array) =>
  enc(
    [
      "From: boss@fictional-recipient.example",
      "To: check@isitlegit.co.za",
      "Subject: Fwd: see attached",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "Is this real?",
      "--b",
      'Content-Type: application/vnd.ms-outlook; name="original.msg"',
      'Content-Disposition: attachment; filename="original.msg"',
      "Content-Transfer-Encoding: base64",
      "",
      btoa(String.fromCharCode(...bytes)).replace(/.{76}/g, "$&\r\n"),
      "--b--",
      "",
    ].join("\r\n"),
  );

describe("the parse step stores the original's header", () => {
  it("from an attached original, not the forward around it, the same on a retried step", async () => {
    const id = await caseOf("email");
    await putRaw(store, id, forwards["attached-rfc822"]);
    await parse(store, id, MAIL);
    const first = await header(id);
    expect(first.originalSubject).not.toMatch(/^(fwd?|fw):/i);
    expect(first.originalSubject).toBeTruthy();
    expect(first.originalFromAddress).toMatch(/@/);
    await parse(store, id, MAIL);
    expect(await header(id)).toEqual(first);
  });

  it("from an uploaded .eml without trusted headers and an uploaded .msg", async () => {
    const eml = await caseOf("upload");
    await putRaw(store, eml, twin);
    await parse(store, eml, UPLOAD);
    expect(await header(eml)).toEqual({
      originalSubject: "Updated banking details for invoice 77",
      originalFromName: "Fictional Supplier",
      originalFromAddress: "billing@fictional-supplier.example",
    });
    const msg = await caseOf("upload");
    await putRaw(store, msg, msgs.full, "application/vnd.ms-outlook");
    await parse(store, msg, UPLOAD);
    expect(await header(msg)).toEqual(await header(eml));
  });

  it("from a .msg's own fields when it has no transport headers", async () => {
    const id = await caseOf("upload");
    await putRaw(store, id, msgs.draft, "application/vnd.ms-outlook");
    await parse(store, id, UPLOAD);
    expect((await header(id)).originalSubject).toBe("Updated banking details for invoice 77");
  });

  it("from an attached .msg without transport headers, by its own fields", async () => {
    const id = await caseOf("email");
    await putRaw(store, id, forwardWithMsg(msgs.draft));
    await parse(store, id, MAIL);
    const read = await header(id);
    expect(read.originalSubject).toBe("Updated banking details for invoice 77");
    expect(read).toEqual(
      await (async () => {
        const upload = await caseOf("upload");
        await putRaw(store, upload, msgs.draft, "application/vnd.ms-outlook");
        await parse(store, upload, UPLOAD);
        return header(upload);
      })(),
    );
  });

  it("reads a .msg's From from its sent-representing properties, not the delegate Sender's (round 1)", async () => {
    const plain = await caseOf("upload");
    await putRaw(store, plain, msgs.draft, "application/vnd.ms-outlook");
    await parse(store, plain, UPLOAD);
    // The same file with its Sender address stream renamed to the sent-representing one (same length, so the compound
    // file's directory stays whole): a From address and no From name, so the Sender's name must not be used.
    const from = (text: string) => new Uint8Array([...text].flatMap((c) => [c.charCodeAt(0), 0]));
    const bytes = msgs.draft.slice();
    const [old, renamed] = [from("0C1F001F"), from("0065001F")];
    let renames = 0;
    for (let i = 0; i <= bytes.length - old.length; i++)
      if (old.every((b, j) => bytes[i + j] === b)) {
        bytes.set(renamed, i);
        renames++;
      }
    expect(renames).toBeGreaterThan(0);
    const delegated = await caseOf("upload");
    await putRaw(store, delegated, bytes, "application/vnd.ms-outlook");
    await parse(store, delegated, UPLOAD);
    const [before, after] = [await header(plain), await header(delegated)];
    expect(before.originalFromName).not.toBeNull();
    expect(after.originalFromName).toBeNull();
    expect(after.originalFromAddress).toBe(before.originalFromAddress);
  });

  it("fails the attempt before the summary when the write is refused, and a retry writes it", async () => {
    const id = await caseOf("upload");
    await putRaw(store, id, twin);
    await env.DB.prepare("ALTER TABLE cases RENAME COLUMN original_subject TO original_subject_away").run();
    try {
      await expect(parse(store, id, UPLOAD)).rejects.toThrow();
    } finally {
      await env.DB.prepare("ALTER TABLE cases RENAME COLUMN original_subject_away TO original_subject").run();
    }
    expect(await readArtefact(store, id, parsedKey(id))).toBeNull();
    await parse(store, id, UPLOAD);
    const written = await header(id);
    expect(written.originalSubject).toBe("Updated banking details for invoice 77");
    // A replay once the raw message is gone keeps them: the summary is there, so the step returns early.
    await env.ARTEFACTS.delete(rawKey(id));
    await parse(store, id, UPLOAD);
    expect(await header(id)).toEqual(written);
  });

  it("leaves nulls for an inline forward and a document upload", async () => {
    const inline = await caseOf("email");
    await putRaw(store, inline, forwards["inline-forward"]);
    await parse(store, inline, MAIL);
    const none = { originalSubject: null, originalFromName: null, originalFromAddress: null };
    expect(await header(inline)).toEqual(none);
    const doc = await caseOf("upload", "document");
    await putAttachment(store, doc, "invoice.pdf", enc("%PDF-1.4\n%%EOF\n"), "application/pdf");
    await parse(store, doc, { channel: "upload", sourceKind: "document", headersAvailable: false });
    expect(await header(doc)).toEqual(none);
  });

  it("bounds an oversized subject", async () => {
    const id = await caseOf("upload");
    await putRaw(store, id, enc(`From: a@b.example\r\nSubject: ${"Pay ".repeat(2000)}\r\n\r\nBody\r\n`));
    await parse(store, id, UPLOAD);
    expect([...((await header(id)).originalSubject ?? "")]).toHaveLength(HEADER_TEXT_LIMIT);
  });

  it("is refused once the case has finished, and for an over-long value", async () => {
    const id = await caseOf("upload");
    await env.DB.prepare("UPDATE cases SET status = 'done' WHERE id = ?").bind(id).run();
    const done = await setOriginalHeader(env.DB, id, { subject: "x", fromName: null, fromAddress: null });
    expect(done.ok ? null : done.error.code).toBe("transition");
    const long = await setOriginalHeader(env.DB, id, { subject: "x".repeat(301), fromName: null, fromAddress: null });
    expect(long.ok ? null : long.error.code).toBe("invalid");
  });

  it("is read only within the organisation", async () => {
    const id = await caseOf("upload");
    await putRaw(store, id, twin);
    await parse(store, id, UPLOAD);
    expect((await getCase(env.DB, "another-org", id)).ok).toBe(false);
  });
});
