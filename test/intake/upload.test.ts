import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { makeDecoyCompoundFile } from "../../scripts/fixtures/msg-builder";
import { getCaseForPipeline } from "../../src/db/cases";
import { sweepIntake } from "../../src/intake/admit";
import { parsedKey, readArtefact, type Store } from "../../src/intake/store";
import { MAX_UPLOAD_BYTES } from "../../src/intake/upload";
import { call, signIn, stubSmtp2go } from "../auth/helpers";
import { toneMp3, toneOgg, toneWav } from "../fixtures/audio/load";
import { addInviteCode } from "../fixtures/auth/members";
import { msgs } from "../fixtures/msg/load";

// D01 T03 §1: POST /api/upload through the Worker, as a signed-in member.
const db = env.DB;
const store: Store = { bucket: env.ARTEFACTS, db };
const enc = (text: string) => new TextEncoder().encode(text);
const PDF = enc("%PDF-1.4\n% an invoice\n%%EOF\n");
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const WEBP = Uint8Array.from([...enc("RIFF"), 20, 0, 0, 0, ...enc("WEBPVP8 ")]);
const EML = enc(
  "Received: from mail.fictional-supplier.example by mx.fictional-recipient.example\r\nFrom: billing@fictional-supplier.example\r\nSubject: Invoice 77\r\nMessage-ID: <inv77@fictional-supplier.example>\r\n\r\nPlease pay invoice 77.\r\n",
);

// A member of a new organisation, signed in (its first organisation is the session's active one).
async function member() {
  const email = `uploader-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
  const code = `code-${crypto.randomUUID()}`;
  await addInviteCode(db, code);
  const smtp = stubSmtp2go();
  try {
    const made = await call("/api/auth/sign-up/invite-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code, organizationName: "Uploads", consent: true }),
    });
    if (made.status !== 201) throw new Error(`signup answered ${made.status}`);
  } finally {
    smtp.restore();
  }
  const { cookie } = await signIn(email);
  const org = await db
    .prepare(`SELECT m."organizationId" AS id FROM "member" m JOIN "user" u ON u.id = m."userId" WHERE u.email = ?`)
    .bind(email)
    .first<{ id: string }>();
  return { cookie, orgId: org?.id as string };
}

function upload(cookie: string | null, parts: [string, Blob | string, string?][], workerEnv?: Env) {
  const form = new FormData();
  for (const [field, value, name] of parts)
    if (typeof value === "string") form.append(field, value);
    else form.append(field, value, name);
  return call(
    "/api/upload",
    { method: "POST", body: form, headers: { accept: "application/json", ...(cookie ? { cookie } : {}) } },
    workerEnv,
  );
}
const file = (bytes: Uint8Array, name: string): [string, Blob, string] => ["file", new Blob([bytes]), name];

const casesOf = async (orgId: string) =>
  (await db.prepare("SELECT id, channel, source_kind FROM cases WHERE org_id = ?").bind(orgId).all()).results;
const claimsOf = async (orgId: string) =>
  (await db.prepare("SELECT state FROM intake_messages WHERE org_id = ?").bind(orgId).all()).results;
const objectsOf = async (caseId: string) =>
  (await env.ARTEFACTS.list({ prefix: `raw/${caseId}/` })).objects.length +
  (await env.ARTEFACTS.list({ prefix: `att/${caseId}/` })).objects.length;

async function finished(caseId: string) {
  const instance = await env.ANALYSIS.get(caseId);
  await expect.poll(async () => (await instance.status()).status, { timeout: 15_000, interval: 200 }).toBe("complete");
}

describe("POST /api/upload", () => {
  it("refuses a request without a session, and one without an organisation", async () => {
    expect((await upload(null, [file(PDF, "x.pdf")])).status).toBe(401);
    const loner = `loner-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
    const { cookie } = await signIn(loner);
    expect((await upload(cookie, [file(PDF, "x.pdf")])).status).toBe(403);
  });

  it("takes each kind by its bytes, making one case and one Workflow", async () => {
    const { cookie, orgId } = await member();
    const accepted: [Uint8Array, string, string][] = [
      [PDF, "invoice.pdf", "document"],
      [enc("%PDF-1.7\n% another document, named as an image\n"), "renamed.png", "document"],
      [PNG, "pop.png", "image"],
      [JPEG, "pop.jpg", "image"],
      [WEBP, "pop.webp", "image"],
      [toneOgg, "note.ogg", "audio"],
      [toneWav, "note.wav", "audio"],
      [toneMp3, "note.mp3", "audio"],
      [EML, "original.eml", "mail"],
      [msgs.full, "original.msg", "mail"],
    ];
    for (const [bytes, name, kind] of accepted) {
      const answer = await upload(cookie, [file(bytes, name)]);
      expect(answer.status, name).toBe(201);
      const { caseId } = (await answer.json()) as { caseId: string };
      const row = await getCaseForPipeline(db, caseId);
      expect(row.ok && row.value, name).toMatchObject({ channel: "upload", sourceKind: kind, forwardedBy: null });
      await expect(env.ANALYSIS.get(caseId)).resolves.toBeDefined();
    }
    expect(await casesOf(orgId)).toHaveLength(accepted.length);
  });

  it("refuses what it does not take with 415, storing nothing", async () => {
    const { cookie, orgId } = await member();
    const oggVorbis = Uint8Array.from([...enc("OggS"), 0, 2, ...new Array(20).fill(0), 1, 30, ...enc("\x01vorbis")]);
    const avi = Uint8Array.from([...enc("RIFF"), 0, 0, 0, 0, ...enc("AVI LIST")]);
    const m4a = Uint8Array.from([0, 0, 0, 24, ...enc("ftypM4A "), 0, 0, 0, 0]);
    for (const [bytes, name] of [
      [makeDecoyCompoundFile(), "report.doc"],
      [oggVorbis, "song.ogg"],
      [avi, "clip.avi"],
      [enc("MZ\x90\x00 an executable"), "setup.exe"],
      [m4a, "memo.m4a"],
    ] as [Uint8Array, string][]) {
      const answer = await upload(cookie, [file(bytes, name)]);
      expect(answer.status, name).toBe(415);
      const { error } = (await answer.json()) as { error: string };
      if (name === "memo.m4a") expect(error).toContain("M4A");
      else expect(error.length).toBeGreaterThan(10);
    }
    expect(await casesOf(orgId)).toEqual([]);
    expect(await claimsOf(orgId)).toEqual([]);
  });

  it("refuses a request without exactly one file in the field `file`", async () => {
    const { cookie, orgId } = await member();
    for (const parts of [
      [],
      [file(PDF, "a.pdf"), file(PNG, "b.png")],
      [["note", "hello"] as [string, string], file(PDF, "a.pdf")],
      [["file", "not a file"] as [string, string]],
      [["other", new Blob([PDF]), "a.pdf"] as [string, Blob, string]],
    ])
      expect((await upload(cookie, parts)).status).toBe(400);
    const malformed = await call("/api/upload", {
      method: "POST",
      body: "not multipart",
      headers: { cookie, accept: "application/json", "content-type": "multipart/form-data; boundary=x" },
    });
    expect(malformed.status).toBe(400);
    expect(await casesOf(orgId)).toEqual([]);
  });

  it("takes 25 MiB exactly, refuses one byte more, and stops reading a body without a length past the limit", async () => {
    const { cookie, orgId } = await member();
    const pdf = (size: number) => {
      const bytes = new Uint8Array(size);
      bytes.set(PDF);
      return bytes;
    };
    expect((await upload(cookie, [file(pdf(MAX_UPLOAD_BYTES), "max.pdf")])).status).toBe(201);
    expect((await upload(cookie, [file(pdf(MAX_UPLOAD_BYTES + 1), "over.pdf")])).status).toBe(413);
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1024 * 1024;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const unbounded = await call("/api/upload", {
      method: "POST",
      body: endless,
      headers: { cookie, accept: "application/json", "content-type": "multipart/form-data; boundary=x" },
      duplex: "half",
    } as RequestInit);
    expect(unbounded.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(MAX_UPLOAD_BYTES + 3 * 1024 * 1024);
    expect(await casesOf(orgId)).toHaveLength(1);
  });

  it("refuses a declared length past the limit without reading the body", async () => {
    const { cookie, orgId } = await member();
    let read = false;
    // A high-water mark of 0, so the stream is pulled only when someone reads it, not on construction.
    const untouched = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          read = true;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const answer = await call("/api/upload", {
      method: "POST",
      body: untouched,
      headers: {
        cookie,
        accept: "application/json",
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(MAX_UPLOAD_BYTES + 128 * 1024),
      },
      duplex: "half",
    } as RequestInit);
    expect(answer.status).toBe(413);
    expect(read).toBe(false);
    expect(await casesOf(orgId)).toEqual([]);
  });

  it("refuses at the daily cap with 429, storing nothing", async () => {
    const { cookie, orgId } = await member();
    await db.prepare("INSERT INTO org_limits (org_id, daily_cases) VALUES (?, 0)").bind(orgId).run();
    expect((await upload(cookie, [file(PDF, "x.pdf")])).status).toBe(429);
    expect(await casesOf(orgId)).toEqual([]);
    expect(await claimsOf(orgId)).toEqual([]);
  });

  it("answers the same file again with the first case", async () => {
    const { cookie, orgId } = await member();
    const first = (await (await upload(cookie, [file(PDF, "x.pdf")])).json()) as { caseId: string };
    const again = await upload(cookie, [file(PDF, "same-bytes.pdf")]);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ caseId: first.caseId, repeat: true });
    expect(await casesOf(orgId)).toHaveLength(1);
  });

  it("leaves no case, object or claim when storing fails, and the sweep settles a Workflow that may not have started", async () => {
    const { cookie, orgId } = await member();
    // The real bucket, except that writing fails (a spread copy would lose the binding's methods, delete included).
    const brokenR2 = new Proxy(env.ARTEFACTS, {
      get: (target, name) =>
        name === "put" ? () => Promise.reject(new Error("R2 down")) : Reflect.get(target, name).bind(target),
    });
    expect(
      (await upload(cookie, [file(PDF, "x.pdf")], { ...(env as unknown as Env), ARTEFACTS: brokenR2 })).status,
    ).toBe(503);
    expect(await casesOf(orgId)).toEqual([]);
    expect(await claimsOf(orgId)).toEqual([]);

    // The Workflow's creation fails and its state cannot be read: the claim stays pending with its case.
    const unknown = {
      create: () => Promise.reject(new Error("workflows down")),
      get: () => Promise.reject(new Error("workflows down")),
    } as unknown as Workflow;
    expect((await upload(cookie, [file(PNG, "y.png")], { ...(env as unknown as Env), ANALYSIS: unknown })).status).toBe(
      503,
    );
    const [pending] = await casesOf(orgId);
    expect(pending).toBeDefined();
    expect(await claimsOf(orgId)).toEqual([{ state: "pending" }]);
    // Past the lease, the sweep finds no Workflow and removes the case, its file and the claim.
    const later = new Date(Date.now() + 6 * 60_000);
    await sweepIntake(env as unknown as Env, later);
    expect(await casesOf(orgId)).toEqual([]);
    expect(await claimsOf(orgId)).toEqual([]);
    expect(await objectsOf((pending as { id: string }).id)).toBe(0);
    vi.restoreAllMocks();
  });
});

describe("an upload's Workflow", () => {
  it("records a document, an image and a voice note for the later steps, the file unchanged", async () => {
    const { cookie } = await member();
    for (const [bytes, name, kind, type] of [
      [PDF, "invoice.pdf", "document", "application/pdf"],
      [PNG, "pop.png", "image", "image/png"],
      [toneOgg, "note.ogg", "audio", "audio/ogg"],
    ] as [Uint8Array, string, string, string][]) {
      const { caseId } = (await (await upload(cookie, [file(bytes, name)])).json()) as { caseId: string };
      await finished(caseId);
      const summary = await readArtefact(store, caseId, parsedKey(caseId));
      const read = JSON.parse(new TextDecoder().decode(summary && "body" in summary ? summary.body : new Uint8Array()));
      expect(read.source).toMatchObject({ kind, mediaType: type, bytes: bytes.byteLength });
      const original = await readArtefact(store, caseId, read.source.key);
      expect(original && "body" in original ? [...original.body] : []).toEqual([...bytes]);
      const row = await getCaseForPipeline(db, caseId);
      expect(row.ok && row.value).toMatchObject({ status: "done", verdict: "suspicious" });
    }
  });

  it("reads an uploaded .eml as the original, headers and all, and a draft .msg without them", async () => {
    const { cookie } = await member();
    const eml = (await (await upload(cookie, [file(EML, "original.eml")])).json()) as { caseId: string };
    await finished(eml.caseId);
    const emlRow = await getCaseForPipeline(db, eml.caseId);
    expect(emlRow.ok && emlRow.value.headersAvailable).toBe(true);
    const stored = await readArtefact(store, eml.caseId, parsedKey(eml.caseId));
    const summary = JSON.parse(new TextDecoder().decode(stored && "body" in stored ? stored.body : new Uint8Array()));
    expect(summary.text).toContain("Please pay invoice 77.");
    expect(summary.forward).toMatchObject({ path: "eml", headersAvailable: true });

    const msg = (await (await upload(cookie, [file(msgs.draft, "draft.msg")])).json()) as { caseId: string };
    await finished(msg.caseId);
    const msgRow = await getCaseForPipeline(db, msg.caseId);
    expect(msgRow.ok && msgRow.value).toMatchObject({ headersAvailable: false, status: "done" });
  });
});
