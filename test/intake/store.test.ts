import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createCase } from "../../src/db/cases";
import { ulid } from "../../src/db/ulid";
import {
  artefactKey,
  attachmentKey,
  type DerivedKind,
  parsedKey,
  putArtefact,
  putAttachment,
  putParsed,
  putRaw,
  rawKey,
  readArtefact,
  type Store,
  StoreError,
} from "../../src/intake/store";

// src/intake/store.ts (D01 T01 §2): the R2 layout, create-only writes that never delete, and the row beside each object.
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const bytes = (text: string) => new TextEncoder().encode(text);
const hexOf = async (body: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body)), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
async function newCase(): Promise<string> {
  const c = await createCase(env.DB, { orgId: "org-a", channel: "email", headersAvailable: true });
  if (!c.ok) throw new Error(c.error.message);
  return c.value.id;
}
const rows = async (caseId: string) =>
  (await env.DB.prepare("SELECT * FROM artefacts WHERE case_id = ? ORDER BY r2_key").bind(caseId).all()).results;
// A store whose R2 and D1 calls are counted, and whose next calls can be made to fail or to alter the body.
function watched(options: { failPut?: number; failInsert?: number; corrupt?: boolean } = {}) {
  const calls = { put: 0, head: 0, get: 0, prepare: 0 };
  const bucket = new Proxy(env.ARTEFACTS, {
    get(target, key) {
      if (key === "put")
        return (k: string, body: Uint8Array, opts: R2PutOptions) => {
          calls.put++;
          if (options.failPut && options.failPut-- > 0) throw new Error("R2 unavailable");
          return target.put(k, options.corrupt ? bytes("tampered") : body, opts);
        };
      if (key === "head" || key === "get")
        return (k: string) => {
          calls[key]++;
          return target[key](k);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          calls.prepare++;
          if (sql.startsWith("INSERT") && options.failInsert && options.failInsert-- > 0)
            throw new Error("D1 unavailable");
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { store: { bucket, db } as Store, calls };
}
const refusal = (code: string) => expect.objectContaining({ name: "StoreError", code });

describe("the R2 layout", () => {
  it("builds the exact keys, with raw content under raw/", () => {
    const id = ulid();
    const sha = "a".repeat(64);
    expect(rawKey(id)).toBe(`raw/${id}/message.eml`);
    expect(parsedKey(id)).toBe(`raw/${id}/parsed.json`);
    expect(attachmentKey(id, sha, "invoice.pdf")).toBe(`raw/${id}/attachments/${sha}-invoice.pdf`);
    expect(artefactKey(id, "render", sha, "page.png")).toBe(`art/${id}/render/${sha}-page.png`);
    for (const key of [rawKey(id), parsedKey(id), attachmentKey(id, sha, "x")])
      expect(key.startsWith(`raw/${id}/`)).toBe(true);
  });

  it("makes any attachment name safe for a key", () => {
    const id = ulid();
    const sha = "b".repeat(64);
    const traversal = attachmentKey(id, sha, "../../x.eml");
    expect(traversal).toBe(`raw/${id}/attachments/${sha}-x.eml`);
    const long = attachmentKey(id, sha, `${"n".repeat(500)}.pdf`);
    const name = long.slice(`raw/${id}/attachments/${sha}-`.length);
    expect(name.length).toBe(120);
    expect(name.endsWith(".pdf")).toBe(true);
    expect(attachmentKey(id, sha, "a\u0000b\nc\\d:e")).toBe(`raw/${id}/attachments/${sha}-a_b_c_d_e`);
    expect(attachmentKey(id, sha, "...")).toBe(`raw/${id}/attachments/${sha}-file`);
  });

  it("refuses a case id that is not a ULID, a kind outside the derived list, and a malformed hash, before any call", async () => {
    const { store: counted, calls } = watched();
    const id = ulid();
    for (const run of [
      () => rawKey("not-a-ulid"),
      () => attachmentKey(crypto.randomUUID(), "a".repeat(64), "x"),
      () => artefactKey(id, "attachment" as DerivedKind, "a".repeat(64), "x"),
      () => artefactKey(id, "render", "ABC", "x"),
    ])
      expect(run).toThrow(StoreError);
    await expect(putRaw(counted, "nope", bytes("x"))).rejects.toEqual(refusal("invalid"));
    await expect(putArtefact(counted, id, "raw" as DerivedKind, "x", bytes("x"), "text/plain")).rejects.toEqual(
      refusal("invalid"),
    );
    await expect(putAttachment(counted, id, "x", bytes("x"), "")).rejects.toEqual(refusal("invalid"));
    expect(calls).toEqual({ put: 0, head: 0, get: 0, prepare: 0 });
  });
});

describe("storing and reading", () => {
  it("stores each kind and reads it back with its exact media type, size and SHA-256", async () => {
    const caseId = await newCase();
    const message = bytes("From: a@example.com\r\n\r\nPay now");
    const raw = await putRaw(store, caseId, message);
    const pdf = await putAttachment(store, caseId, "invoice.pdf", bytes("%PDF-1.7"), "application/pdf");
    const png = await putArtefact(store, caseId, "render", "page.png", bytes("\u0089PNG"), "image/png");
    expect(raw).toMatchObject({
      key: rawKey(caseId),
      kind: "raw",
      mediaType: "message/rfc822",
      bytes: message.byteLength,
      sha256: await hexOf(message),
    });
    for (const item of [raw, pdf, png]) {
      const read = await readArtefact(store, caseId, item.key);
      expect(read && "body" in read).toBe(true);
      if (!read || !("body" in read)) continue;
      expect(read.stored).toEqual(item);
      expect(await hexOf(read.body)).toBe(item.sha256);
      const head = await env.ARTEFACTS.head(item.key);
      expect(head?.httpMetadata?.contentType).toBe(item.mediaType);
      expect(head?.size).toBe(item.bytes);
    }
    expect((await rows(caseId)).map((r) => r.kind).sort()).toEqual(["attachment", "raw", "render"]);
  });

  it("round-trips the parsed summary under raw/", async () => {
    const caseId = await newCase();
    const summary = { headers: { subject: "Invoice 42" }, text: "Pay now", attachments: ["raw/x"] };
    const stored = await putParsed(store, caseId, summary);
    expect(stored.key).toBe(parsedKey(caseId));
    const read = await readArtefact(store, caseId, stored.key);
    expect(read && "body" in read && JSON.parse(new TextDecoder().decode(read.body))).toEqual(summary);
  });

  it("answers a repeated put from the first, without rewriting", async () => {
    const caseId = await newCase();
    const first = await putAttachment(store, caseId, "a.txt", bytes("same"), "text/plain");
    const before = await env.ARTEFACTS.head(first.key);
    const again = await putAttachment(store, caseId, "a.txt", bytes("same"), "text/plain");
    const after = await env.ARTEFACTS.head(first.key);
    expect(again).toEqual(first);
    expect(after?.etag).toBe(before?.etag);
    expect(after?.uploaded.getTime()).toBe(before?.uploaded.getTime());
    expect(await rows(caseId)).toHaveLength(1);
  });

  it("lets two overlapping puts of the same content both succeed, leaving one readable object and one row", async () => {
    const caseId = await newCase();
    const [a, b] = await Promise.all([
      putAttachment(store, caseId, "same.txt", bytes("overlap"), "text/plain"),
      putAttachment(store, caseId, "same.txt", bytes("overlap"), "text/plain"),
    ]);
    expect(a).toEqual(b);
    expect(await rows(caseId)).toHaveLength(1);
    const read = await readArtefact(store, caseId, a.key);
    expect(read && "body" in read && new TextDecoder().decode(read.body)).toBe("overlap");
  });

  it("refuses different content for a case's fixed raw key, keeping the first", async () => {
    const caseId = await newCase();
    const first = await putRaw(store, caseId, bytes("first message"));
    await expect(putRaw(store, caseId, bytes("second message"))).rejects.toEqual(refusal("conflict"));
    const read = await readArtefact(store, caseId, first.key);
    expect(read && "body" in read && new TextDecoder().decode(read.body)).toBe("first message");
    expect(await rows(caseId)).toHaveLength(1);
  });

  it("reports an R2 failure with no row, and completes on retry", async () => {
    const caseId = await newCase();
    const failing = watched({ failPut: 1 });
    await expect(putAttachment(failing.store, caseId, "r.txt", bytes("r2"), "text/plain")).rejects.toEqual(
      refusal("storage"),
    );
    expect(await rows(caseId)).toHaveLength(0);
    expect(failing.calls.prepare).toBe(0);
    const stored = await putAttachment(failing.store, caseId, "r.txt", bytes("r2"), "text/plain");
    expect(await rows(caseId)).toHaveLength(1);
    expect(await readArtefact(store, caseId, stored.key)).toMatchObject({ stored });
  });

  it("reports a D1 failure, leaving the object for the retry to record", async () => {
    const caseId = await newCase();
    const failing = watched({ failInsert: 1 });
    await expect(putAttachment(failing.store, caseId, "d.txt", bytes("d1"), "text/plain")).rejects.toEqual(
      refusal("database"),
    );
    expect(await rows(caseId)).toHaveLength(0);
    const stored = await putAttachment(failing.store, caseId, "d.txt", bytes("d1"), "text/plain");
    expect(await rows(caseId)).toHaveLength(1);
    expect(failing.calls.put).toBe(2);
    expect(await readArtefact(store, caseId, stored.key)).toMatchObject({ stored });
  });

  it("publishes no row when R2 rejects bytes that do not match their hash", async () => {
    const caseId = await newCase();
    const tampering = watched({ corrupt: true });
    await expect(putAttachment(tampering.store, caseId, "t.txt", bytes("genuine"), "text/plain")).rejects.toEqual(
      refusal("storage"),
    );
    expect(await rows(caseId)).toHaveLength(0);
  });

  it("reads an object that is gone as missing, and another case's key as not found", async () => {
    const caseId = await newCase();
    const stored = await putRaw(store, caseId, bytes("expires"));
    await env.ARTEFACTS.delete(stored.key);
    expect(await readArtefact(store, caseId, stored.key)).toEqual({ stored, missing: true });
    expect(await readArtefact(store, await newCase(), stored.key)).toBeNull();
  });
});
