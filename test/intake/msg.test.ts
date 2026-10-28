import { env } from "cloudflare:workers";
import MsgReader from "@kenjiuno/msgreader";
import { describe, expect, it } from "vitest";
import { makeMsg } from "../../scripts/fixtures/msg-builder";
import { createCase } from "../../src/db/cases";
import { ParseError } from "../../src/intake/mime";
import { parseMsg } from "../../src/intake/msg";
import { BODY_PART_LIMIT, parseMessage, storeParsed } from "../../src/intake/parse";
import { parsedKey, readArtefact, type Store } from "../../src/intake/store";
import { msgs, twin } from "../fixtures/msg/load";

// D01 T01 §6: an attached Outlook .msg parsed into the same ParsedMessage as its MIME twin.
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };

describe("parseMsg", () => {
  it("reads the transport headers, bodies and attachments as the .eml twin holds them", async () => {
    const { parsed, headersAvailable } = await parseMsg(msgs.full);
    const mime = await parseMessage(twin);
    expect(headersAvailable).toBe(true);
    // The twin adds its own MIME Content-Type after the same transport headers.
    expect(parsed.headers).toEqual(mime.headers.filter((h) => h.name !== "Content-Type"));
    expect(parsed.headers.filter((h) => h.name === "Received")).toHaveLength(1);
    expect(parsed.text?.trim()).toBe(mime.text?.trim());
    // The HTML from code page 1252, non-ASCII text intact.
    expect(parsed.html).toBe(mime.html);
    expect(parsed.html).toContain("Café São Paulo");
    const pdf = mime.attachments.find((a) => a.filename === "invoice-77.pdf");
    expect(parsed.attachments.find((a) => a.filename === "invoice-77.pdf")).toMatchObject({
      mediaType: "application/pdf",
      disposition: "attachment",
      bytes: pdf?.bytes,
    });
  });

  it("keeps an inline image's content id and stores an embedded message as .msg bytes that reopen", async () => {
    const { parsed } = await parseMsg(msgs.full);
    const image = parsed.attachments.find((a) => a.filename === "logo.png");
    expect(image).toMatchObject({ contentId: "<logo77@fictional>", disposition: "inline", mediaType: "image/png" });
    expect(parsed.html).toContain("cid:logo77@fictional");
    const embedded = parsed.attachments.find((a) => a.mediaType === "application/vnd.ms-outlook");
    if (!embedded) throw new Error("the embedded message is missing");
    const reopened = new MsgReader(
      new DataView(embedded.bytes.buffer, embedded.bytes.byteOffset, embedded.bytes.byteLength),
    );
    expect(reopened.getFileData().subject).toBe("Earlier message from the supplier");
  });

  it("says a draft without transport headers has none", async () => {
    expect(await parseMsg(msgs.draft)).toMatchObject({ headersAvailable: false, parsed: { headers: [] } });
  });

  it("refuses an RTF-only body, a file that is not a .msg and a cut-off one as a ParseError", async () => {
    for (const [name, bytes] of [
      ["rtf-only", msgs.rtfOnly],
      ["not-a-msg", msgs.notAMsg],
      ["truncated", msgs.truncated],
      ["empty", msgs.empty],
    ] as const)
      await expect(parseMsg(bytes), name).rejects.toBeInstanceOf(ParseError);
    // Each for its own reason: msgreader's returned error, and a well-formed file holding nothing.
    await expect(parseMsg(msgs.notAMsg)).rejects.toThrow(/Unsupported file type/);
    await expect(parseMsg(msgs.empty)).rejects.toThrow(/holds nothing readable/);
  });

  it("stores the parse with storeParsed, the inline image under its content id", async () => {
    const made = await createCase(env.DB, { orgId: "org-msg", channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const { parsed, headersAvailable } = await parseMsg(msgs.full);
    const summary = await storeParsed(store, made.value.id, parsed, {
      original: msgs.full,
      format: "msg",
      headersAvailable,
      path: "msg",
      otherOriginals: 0,
    });
    const read = await readArtefact(store, made.value.id, parsedKey(made.value.id));
    if (!read || !("body" in read)) throw new Error("the summary is missing");
    const stored = JSON.parse(new TextDecoder().decode(read.body));
    expect(stored.html).toContain("cid:logo77@fictional");
    const image = stored.attachments.find((a: { contentId: string | null }) => a.contentId === "<logo77@fictional>");
    expect(image).toMatchObject({ filename: "logo.png", mediaType: "image/png" });
    const bytes = await readArtefact(store, made.value.id, image.key);
    expect(bytes && "body" in bytes ? [...bytes.body.subarray(0, 4)] : []).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(summary.forward).toEqual({ path: "msg", headersAvailable: true, otherOriginals: 0 });
  });

  it("cuts a large body to §5's limit and keeps it whole", async () => {
    const { parsed } = await parseMsg(makeMsg({ transportHeaders: true, bodyRepeat: 30_000 }));
    expect(new TextEncoder().encode(parsed.text ?? "").byteLength).toBeLessThanOrEqual(BODY_PART_LIMIT);
    expect(parsed.truncated).toMatchObject([{ mediaType: "text/plain", charset: "utf-8", keptBytes: BODY_PART_LIMIT }]);
    expect(parsed.truncated[0]?.full.byteLength).toBeGreaterThan(BODY_PART_LIMIT);
  });
});
