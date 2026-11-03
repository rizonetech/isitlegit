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
  putVisible,
  rawKey,
  readArtefact,
  type Store,
  StoreError,
  visibleKey,
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
function watched(options: { failPut?: number; failInsert?: number; corrupt?: boolean; failBody?: number } = {}) {
  const calls = { put: 0, head: 0, get: 0, prepare: 0 };
  const bucket = new Proxy(env.ARTEFACTS, {
    get(target, key) {
      if (key === "put")
        return (k: string, body: Uint8Array, opts: R2PutOptions) => {
          calls.put++;
          if (options.failPut && options.failPut-- > 0) throw new Error("R2 unavailable");
          return target.put(k, options.corrupt ? bytes("tampered") : body, opts);
        };
      if (key === "head")
        return (k: string) => {
          calls.head++;
          return target.head(k);
        };
      if (key === "get")
        return async (k: string) => {
          calls.get++;
          const object = await target.get(k);
          if (!object || !(options.failBody && options.failBody-- > 0)) return object;
          // The headers arrived; the body is cut off.
          return new Proxy(object, {
            get(o, m) {
              if (m === "arrayBuffer") return () => Promise.reject(new Error("network connection lost"));
              const value = Reflect.get(o, m);
              return typeof value === "function" ? value.bind(o) : value;
            },
          });
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
    for (const kind of ["render", "crop", "page", "audio"] as const)
      expect(artefactKey(id, kind, sha, "x.bin")).toBe(`art/${id}/${kind}/${sha}-x.bin`);
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
    // Cut by characters: an emoji at the limit is kept whole or left out, never halved.
    const emoji = attachmentKey(id, sha, `${"a".repeat(119)}\u{1F600}${"b".repeat(10)}`).slice(
      `raw/${id}/attachments/${sha}-`.length,
    );
    expect(Array.from(emoji)).toHaveLength(120);
    expect(emoji.endsWith("\u{1F600}")).toBe(true);
    expect(emoji.isWellFormed()).toBe(true);
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
    await expect(readArtefact(counted, "nope", "raw/x")).rejects.toEqual(refusal("invalid"));
    expect(calls).toEqual({ put: 0, head: 0, get: 0, prepare: 0 });
  });

  it("refuses a put for a case that does not exist, writing nothing", async () => {
    const { store: counted, calls } = watched();
    await expect(putAttachment(counted, ulid(), "x.txt", bytes("x"), "text/plain")).rejects.toEqual(refusal("invalid"));
    expect(calls.put).toBe(0);
  });

  it("refuses a parsed summary that is not a JSON object", async () => {
    const caseId = await newCase();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const bad of [undefined, null, [1, 2], "text", circular, { n: 10n }])
      await expect(putParsed(store, caseId, bad as Record<string, unknown>)).rejects.toEqual(refusal("invalid"));
    expect(await rows(caseId)).toHaveLength(0);
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
    // Only the row check before the write; no insert followed the failed write.
    expect(failing.calls.prepare).toBe(1);
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

  it("records the stored object's media type when a later writer declares the same bytes differently", async () => {
    // Writer A creates the object, then its row fails; writer B, the same bytes as text/html, completes it.
    const caseId = await newCase();
    const a = watched({ failInsert: 1 });
    await expect(putAttachment(a.store, caseId, "part.txt", bytes("same bytes"), "text/plain")).rejects.toEqual(
      refusal("database"),
    );
    const b = await putAttachment(store, caseId, "part.txt", bytes("same bytes"), "text/html");
    const row = (await rows(caseId))[0];
    const head = await env.ARTEFACTS.head(b.key);
    expect([b.mediaType, row?.media_type, head?.httpMetadata?.contentType]).toEqual([
      "text/plain",
      "text/plain",
      "text/plain",
    ]);
    // Two overlapping writers declaring different types: all three agree on whichever object won.
    const other = await newCase();
    const [x, y] = await Promise.all([
      putAttachment(store, other, "p.bin", bytes("race"), "application/octet-stream"),
      putAttachment(store, other, "p.bin", bytes("race"), "image/png"),
    ]);
    const winner = (await env.ARTEFACTS.head(x.key))?.httpMetadata?.contentType;
    expect([x.mediaType, y.mediaType, (await rows(other))[0]?.media_type]).toEqual([winner, winner, winner]);
  });

  it("reports a body cut off after its headers as a storage failure, and reads it on retry", async () => {
    const caseId = await newCase();
    const stored = await putAttachment(store, caseId, "cut.txt", bytes("whole body"), "text/plain");
    const flaky = watched({ failBody: 1 });
    await expect(readArtefact(flaky.store, caseId, stored.key)).rejects.toEqual(refusal("storage"));
    const read = await readArtefact(flaky.store, caseId, stored.key);
    expect(read && "body" in read && new TextDecoder().decode(read.body)).toBe("whole body");
  });

  it("stores and reads back a 25 MiB attachment, the intake limit, within its time budget", async () => {
    const times = { write: [] as number[], read: [] as number[] };
    const big = new Uint8Array(25 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big[i] = i % 251;
    for (let run = 0; run < 3; run++) {
      const caseId = await newCase();
      let start = performance.now();
      const stored = await putAttachment(store, caseId, "large.pdf", big, "application/pdf");
      times.write.push(performance.now() - start);
      start = performance.now();
      const read = await readArtefact(store, caseId, stored.key);
      times.read.push(performance.now() - start);
      expect(read && "body" in read && read.body.byteLength).toBe(big.byteLength);
      expect(stored.sha256).toBe(await hexOf(big));
      expect(read && "body" in read && (await hexOf(read.body))).toBe(stored.sha256);
    }
    const p95 = (list: number[]) => [...list].sort((a, b) => a - b)[Math.ceil(list.length * 0.95) - 1] as number;
    console.info(
      `25 MiB local Miniflare: write ${times.write.map(Math.round)} ms, read ${times.read.map(Math.round)} ms`,
    );
    expect(p95(times.write)).toBeLessThan(15_000);
    expect(p95(times.read)).toBeLessThan(15_000);
  }, 120_000);

  it("refuses other content for a fixed key whose object has expired, writing nothing", async () => {
    const caseId = await newCase();
    const first = await putRaw(store, caseId, bytes("message A"));
    await env.ARTEFACTS.delete(first.key);
    const counted = watched();
    await expect(putRaw(counted.store, caseId, bytes("message B"))).rejects.toEqual(refusal("conflict"));
    expect(counted.calls.put).toBe(0);
    expect(await readArtefact(store, caseId, first.key)).toEqual({ stored: first, missing: true });
    // The same content again restores the expired object under its row, with the row's media type.
    expect(await putRaw(store, caseId, bytes("message A"), "text/plain")).toEqual(first);
    expect((await env.ARTEFACTS.head(first.key))?.httpMetadata?.contentType).toBe("message/rfc822");
  });

  it("calls an object that vanishes mid-write a retryable storage failure, not a conflict", async () => {
    const caseId = await newCase();
    const stored = await putAttachment(store, caseId, "v.txt", bytes("vanish"), "text/plain");
    const vanishing = new Proxy(env.ARTEFACTS, {
      get(target, key) {
        if (key === "put") return async () => null; // the object exists...
        if (key === "head") return async () => null; // ...then is gone
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      putAttachment({ bucket: vanishing, db: env.DB }, caseId, "v.txt", bytes("vanish"), "text/plain"),
    ).rejects.toEqual(refusal("storage"));
    expect(await putAttachment(store, caseId, "v.txt", bytes("vanish"), "text/plain")).toEqual(stored);
  });

  it("checks an existing object without a stored checksum by its bytes", async () => {
    const caseId = await newCase();
    const key = attachmentKey(caseId, await hexOf(bytes("unsummed")), "u.txt");
    await env.ARTEFACTS.put(key, bytes("unsummed"), { httpMetadata: { contentType: "text/plain" } });
    const stored = await putAttachment(store, caseId, "u.txt", bytes("unsummed"), "text/plain");
    expect(stored.key).toBe(key);
    const tampered = attachmentKey(caseId, await hexOf(bytes("expected")), "t.txt");
    await env.ARTEFACTS.put(tampered, bytes("something else"));
    await expect(putAttachment(store, caseId, "t.txt", bytes("expected"), "text/plain")).rejects.toEqual(
      refusal("conflict"),
    );
    // Found without a checksum, then gone before its bytes are read: retryable, not a conflict.
    const between = new Proxy(env.ARTEFACTS, {
      get(target, key) {
        if (key === "put") return async () => null;
        if (key === "head") return async () => ({ checksums: {}, httpMetadata: {} });
        if (key === "get") return async () => null;
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      putAttachment({ bucket: between, db: env.DB }, caseId, "g.txt", bytes("gone"), "text/plain"),
    ).rejects.toEqual(refusal("storage"));
  });

  it("reads an object that is gone as missing, and another case's key as not found", async () => {
    const caseId = await newCase();
    const stored = await putRaw(store, caseId, bytes("expires"));
    await env.ARTEFACTS.delete(stored.key);
    expect(await readArtefact(store, caseId, stored.key)).toEqual({ stored, missing: true });
    expect(await readArtefact(store, await newCase(), stored.key)).toBeNull();
  });
});

describe("a case removed mid-write (D01 T01 §24)", () => {
  // The removal the test drives deletes only cases it created; the two protected live test accounts'
  // cases are never removed by any path here, as AGENTS.md requires.
  const removeCase = (caseId: string) => env.DB.prepare("DELETE FROM cases WHERE id = ?").bind(caseId).run();
  // A bucket whose put lands the object, then removes the case before the write's insert.
  const removing = (caseId: string, failDelete = false): Store => ({
    bucket: new Proxy(env.ARTEFACTS, {
      get(target, key) {
        if (key === "put")
          return async (k: string, body: Uint8Array, opts: R2PutOptions) => {
            const created = await target.put(k, body, opts);
            await removeCase(caseId);
            return created;
          };
        if (key === "delete" && failDelete) return async () => Promise.reject(new Error("R2 unavailable"));
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as R2Bucket,
    db: env.DB,
  });

  const writes: [string, (s: Store, id: string) => Promise<unknown>, (id: string) => string][] = [
    ["putRaw", (s, id) => putRaw(s, id, bytes("from: a@b.example")), (id) => rawKey(id)],
    ["putParsed", (s, id) => putParsed(s, id, { headers: [], text: "x" }), (id) => parsedKey(id)],
    [
      "putAttachment",
      async (s, id) => (await putAttachment(s, id, "a.pdf", bytes("%PDF"), "application/pdf")).key,
      (id) => attachmentKey(id, "0".repeat(64), "a.pdf"),
    ],
    [
      "putArtefact",
      async (s, id) => (await putArtefact(s, id, "render", "page.png", bytes("PNG"), "image/png")).key,
      (id) => artefactKey(id, "render", "0".repeat(64), "page.png"),
    ],
    ["putVisible", (s, id) => putVisible(s, id, "Pay invoice 77 today."), (id) => visibleKey(id)],
  ];

  it("fences every public write across a removal, storing neither row nor object", async () => {
    for (const [name, write] of writes) {
      const id = await newCase();
      const other = await newCase();
      await putRaw(store, other, bytes("untouched"));
      await expect(write(removing(id), id), name).rejects.toEqual(
        expect.objectContaining({ code: "storage", message: expect.stringContaining("was fenced: its case is gone") }),
      );
      expect(await rows(id), name).toEqual([]);
      // The other case's artefacts are untouched.
      expect(await rows(other), name).toHaveLength(1);
    }
  });

  it("leaves no object behind for the fenced fixed-key writes, and lands the same write whole without a removal", async () => {
    for (const [name, write, keyOf] of writes) {
      const id = await newCase();
      await expect(write(removing(id), id), name).rejects.toMatchObject({ code: "storage" });
      if (!name.startsWith("putA")) expect(await env.ARTEFACTS.head(keyOf(id)), name).toBeNull();
      const landed = await newCase();
      await write(store, landed);
      expect(await rows(landed), name).toHaveLength(1);
    }
  });

  it("names cleanup pending when the fenced object cannot be removed, and the prefix sweep recovers it", async () => {
    const id = await newCase();
    await expect(putRaw(removing(id, true), id, bytes("stranded"))).rejects.toEqual(
      expect.objectContaining({ message: expect.stringContaining("the removal sweep owns it") }),
    );
    expect(await env.ARTEFACTS.head(rawKey(id))).not.toBeNull();
    // The recovery owner: a prefix sweep, as the account closure lists, needs no row to find the object.
    const listed = await env.ARTEFACTS.list({ prefix: `raw/${id}/` });
    for (const object of listed.objects) await env.ARTEFACTS.delete(object.key);
    expect(await env.ARTEFACTS.head(rawKey(id))).toBeNull();
  });

  it("keeps an earlier attempt's object when a retried write is fenced", async () => {
    // An earlier attempt recorded the object but no row (its insert failed then); a fenced retry must
    // not delete that recorded work.
    const id = await newCase();
    const body = bytes("earlier attempt");
    const key = rawKey(id);
    await env.ARTEFACTS.put(key, body, { sha256: await hexOf(body) });
    await expect(putRaw(removing(id), id, body)).rejects.toMatchObject({ code: "storage" });
    expect(await env.ARTEFACTS.head(key)).not.toBeNull();
    await env.ARTEFACTS.delete(key);
  });
});
