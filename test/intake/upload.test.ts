import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { makeDecoyCompoundFile } from "../../scripts/fixtures/msg-builder";
import { readCheckOutcomes, readEvidence } from "../../src/checks/evidence";
import { getCaseForPipeline } from "../../src/db/cases";
import { ulid } from "../../src/db/ulid";
import worker from "../../src/index";
import { CLAIM_LEASE_MS, sweepIntake } from "../../src/intake/admit";
import { parsedKey, readArtefact, type Store } from "../../src/intake/store";
import { MAX_CLAIM_CHARS, MAX_UPLOAD_BYTES, uploadKey } from "../../src/intake/upload";
import { call, ORIGIN, signIn, stubSmtp2go } from "../auth/helpers";
import { zip } from "../fixtures/attachments/archives";
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
  "Received: from mail.fictional-supplier.example by mx.fictional-recipient.example\r\nFrom: billing@fictional-supplier.example\r\nDate: Tue, 27 Oct 2026 08:00:00 +0200\r\nSubject: Invoice 77\r\nMessage-ID: <inv77@fictional-supplier.example>\r\n\r\nPlease pay invoice 77.\r\n",
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

// A second member of `orgId`, signed in: a user and a membership as Better Auth stores them, then its own sign-in.
async function secondMember(orgId: string) {
  const email = `second-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
  const now = new Date().toISOString();
  const userId = `user-${crypto.randomUUID()}`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .bind(userId, email, email, now, now),
    db
      .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, 'member', ?)`)
      .bind(`member-${userId}`, orgId, userId, now),
  ]);
  const { cookie } = await signIn(email);
  return { cookie, userId };
}
const userIdOf = async (cookie: string) => {
  const session = await call("/api/auth/get-session", { headers: { cookie } });
  return ((await session.json()) as { user: { id: string } }).user.id;
};
const uploadedBy = async (caseId: string) =>
  (await db.prepare("SELECT uploaded_by FROM cases WHERE id = ?").bind(caseId).first<{ uploaded_by: string | null }>())
    ?.uploaded_by;

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
const caseStatus = async (id: string) =>
  (await db.prepare("SELECT status FROM cases WHERE id = ?").bind(id).first<{ status: string }>())?.status;
const claimsOf = async (orgId: string) =>
  (await db.prepare("SELECT state FROM intake_messages WHERE org_id = ?").bind(orgId).all()).results;
// Every object a case can own is under raw/<case>/ or art/<case>/ (src/intake/store.ts).
const objectsOf = async (caseId: string) =>
  (await env.ARTEFACTS.list({ prefix: `raw/${caseId}/` })).objects.length +
  (await env.ARTEFACTS.list({ prefix: `art/${caseId}/` })).objects.length;

// The Worker's environment with every R2 write and Workflow start counted, so a refusal can be shown to make neither.
function counted() {
  const seen = { puts: [] as string[], starts: 0 };
  const bucket = new Proxy(env.ARTEFACTS, {
    get: (target, name) =>
      name === "put"
        ? (key: string, ...rest: unknown[]) => {
            seen.puts.push(key);
            return (target.put as (...a: unknown[]) => unknown)(key, ...rest);
          }
        : Reflect.get(target, name).bind(target),
  });
  const analysis = new Proxy(env.ANALYSIS, {
    get: (target, name) =>
      name === "create"
        ? (...args: unknown[]) => {
            seen.starts++;
            return (target.create as (...a: unknown[]) => unknown)(...args);
          }
        : Reflect.get(target, name).bind(target),
  });
  return { seen, workerEnv: { ...(env as unknown as Env), ARTEFACTS: bucket, ANALYSIS: analysis } as Env };
}

// An Excel workbook: a compound file whose only stream is the workbook, no message properties.
async function xls() {
  const CFB = (await import("cfb")).default;
  const cfb = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfb, "/Workbook", new Uint8Array(600));
  return new Uint8Array(CFB.write(cfb, { type: "buffer" }) as Uint8Array);
}

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
      [
        zip([
          { name: "[Content_Types].xml", data: enc("<Types/>") },
          { name: "word/document.xml", data: enc("<w:document/>") },
        ]),
        "letter.docx",
        "document",
      ],
      [
        zip([
          { name: "[Content_Types].xml", data: enc("<Types/>") },
          { name: "xl/workbook.xml", data: enc("<x/>") },
        ]),
        "sheet.xlsx",
        "document",
      ],
      [
        zip([
          { name: "[Content_Types].xml", data: enc("<Types/>") },
          { name: "ppt/presentation.xml", data: enc("<x/>") },
        ]),
        "deck.pptx",
        "document",
      ],
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
    const { seen, workerEnv } = counted();
    const oggVorbis = Uint8Array.from([...enc("OggS"), 0, 2, ...new Array(20).fill(0), 1, 30, ...enc("\x01vorbis")]);
    const avi = Uint8Array.from([...enc("RIFF"), 0, 0, 0, 0, ...enc("AVI LIST")]);
    const m4a = Uint8Array.from([0, 0, 0, 24, ...enc("ftypM4A "), 0, 0, 0, 0]);
    for (const [bytes, name] of [
      [
        zip([
          { name: "[Content_Types].xml", data: enc("<Types/>") },
          { name: "word/document.xml", data: enc("<w:document/>") },
          { name: "word/vbaProject.bin", data: enc("x") },
        ]),
        "macro.docx",
      ],
      [zip([{ name: "readme.txt", data: enc("hi") }]), "plain.zip"],
      // A directory whose count under-reports its entries (the macro is never inspected).
      [
        (() => {
          const pkgBytes = zip([
            { name: "[Content_Types].xml", data: enc("<Types/>") },
            { name: "word/document.xml", data: enc("<w:document/>") },
            { name: "word/vbaProject.bin", data: enc("x") },
          ]);
          const lying = new Uint8Array(pkgBytes);
          lying[lying.length - 22 + 10] = 2;
          lying[lying.length - 22 + 11] = 0;
          return lying;
        })(),
        "undercounted.docx",
      ],
      [makeDecoyCompoundFile(), "report.doc"],
      [await xls(), "sheet.xls"],
      [oggVorbis, "song.ogg"],
      [avi, "clip.avi"],
      [enc("MZ\x90\x00 an executable"), "setup.exe"],
      [m4a, "memo.m4a"],
      // MPEG audio the decoder does not take (src/voice/mp3.ts): Layer II, free format, a tag with no frames.
      [Uint8Array.from([0xff, 0xfd, 0x90, 0x00, ...new Array(400).fill(0)]), "layer2.mp3"],
      [Uint8Array.from([0xff, 0xfb, 0x00, 0x00, ...new Array(400).fill(0)]), "free.mp3"],
      [Uint8Array.from([...enc("ID3"), 4, 0, 0, 0, 0, 0, 10, ...new Array(10).fill(0)]), "tag-only.mp3"],
      // A text file with a Subject line is not a message: RFC 5322 requires From and Date.
      [enc("Subject: hello\r\n\r\njust some notes\r\n"), "notes.eml"],
    ] as [Uint8Array, string][]) {
      const answer = await upload(cookie, [file(bytes, name)], workerEnv);
      expect(answer.status, name).toBe(415);
      const { error } = (await answer.json()) as { error: string };
      if (name === "memo.m4a") expect(error).toContain("M4A");
      else if (name === "layer2.mp3") expect(error).toContain("Layer");
      else if (name === "free.mp3") expect(error).toContain("free format");
      else expect(error.length).toBeGreaterThan(10);
    }
    expect(await casesOf(orgId)).toEqual([]);
    expect(await claimsOf(orgId)).toEqual([]);
    expect(seen).toEqual({ puts: [], starts: 0 });
  });

  it("refuses a request without exactly one file in the field `file`", async () => {
    const { cookie, orgId } = await member();
    const { seen, workerEnv } = counted();
    for (const parts of [
      [],
      [file(PDF, "a.pdf"), file(PNG, "b.png")],
      [["note", "hello"] as [string, string], file(PDF, "a.pdf")],
      [["file", "not a file"] as [string, string]],
      [["other", new Blob([PDF]), "a.pdf"] as [string, Blob, string]],
    ])
      expect((await upload(cookie, parts, workerEnv)).status).toBe(400);
    const malformed = await call("/api/upload", {
      method: "POST",
      body: "not multipart",
      headers: { cookie, accept: "application/json", "content-type": "multipart/form-data; boundary=x" },
    });
    expect(malformed.status).toBe(400);
    expect(await casesOf(orgId)).toEqual([]);
    expect(seen).toEqual({ puts: [], starts: 0 });
  });

  it("answers a body that breaks off mid-upload with a JSON refusal, creating nothing", async () => {
    const { cookie, orgId } = await member();
    const { seen, workerEnv } = counted();
    let sent = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 2) controller.enqueue(new Uint8Array(1024));
        else controller.error(new Error("connection reset"));
      },
    });
    const answer = await call(
      "/api/upload",
      {
        method: "POST",
        body: broken,
        headers: { cookie, accept: "application/json", "content-type": "multipart/form-data; boundary=x" },
        duplex: "half",
      } as RequestInit,
      workerEnv,
    );
    expect(answer.status).toBe(400);
    expect(answer.headers.get("content-type")).toContain("application/json");
    expect(((await answer.json()) as { error: string }).error).toContain("interrupted");
    expect(await casesOf(orgId)).toEqual([]);
    expect(seen).toEqual({ puts: [], starts: 0 });
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
    const { seen, workerEnv } = counted();
    await db.prepare("INSERT INTO org_limits (org_id, daily_cases_override) VALUES (?, 0)").bind(orgId).run();
    expect((await upload(cookie, [file(PDF, "x.pdf")], workerEnv)).status).toBe(429);
    expect(await casesOf(orgId)).toEqual([]);
    expect(await claimsOf(orgId)).toEqual([]);
    expect(seen).toEqual({ puts: [], starts: 0 });
  });

  it("tells a client the same file is still being taken, with the lease's remaining time", async () => {
    const { cookie, orgId } = await member();
    await db
      .prepare(
        "INSERT INTO intake_messages (org_id, message_key, state, case_id, claimed_at) VALUES (?, ?, 'pending', NULL, ?)",
      )
      // A part sent without a type arrives as application/octet-stream, which is part of the upload's key.
      .bind(orgId, `upload:${await uploadKey(PDF, "x.pdf", "application/octet-stream")}`, new Date().toISOString())
      .run();
    const answer = await upload(cookie, [file(PDF, "x.pdf")]);
    expect(answer.status).toBe(503);
    expect(Number(answer.headers.get("retry-after"))).toBeGreaterThan(250);
    expect(await casesOf(orgId)).toEqual([]);
  });

  it("never answers an upload with an email's case, nor an email with an upload's, whichever comes first", async () => {
    const { admitDelivery, sha256Hex } = await import("../../src/intake/admit");
    const { cookie, orgId } = await member();
    const email = (key: string) =>
      admitDelivery(env as unknown as Env, {
        orgId,
        key,
        channel: "email",
        sourceKind: "mail",
        headersAvailable: false,
        store: async () => {},
      });
    // An email first whose Message-ID spells, in every form, what an upload of this PDF is keyed by.
    const hash = await sha256Hex(PDF);
    for (const id of [`upload:sha256:${hash}`, `sha256:${hash}`, `upload:${hash}`])
      expect((await email(id)).kind, id).toBe("admitted");
    const uploaded = await upload(cookie, [file(PDF, "x.pdf")]);
    expect(uploaded.status).toBe(201);
    // The upload first, then an email spelling its key: the email is a case of its own.
    const other = enc("%PDF-1.4\n% other\n");
    expect((await upload(cookie, [file(other, "o.pdf")])).status).toBe(201);
    expect((await email(`sha256:${await sha256Hex(other)}`)).kind).toBe("admitted");
    expect((await email(`upload:sha256:${await sha256Hex(other)}`)).kind).toBe("admitted");
  });

  it("records the uploading member on the case (D01 T03 §11)", async () => {
    const { cookie } = await member();
    const made = (await (await upload(cookie, [file(PDF, "x.pdf")])).json()) as { caseId: string };
    expect(await uploadedBy(made.caseId)).toBe(await userIdOf(cookie));
  });

  it("keeps the first uploader when another member uploads the same file again (D01 T03 §11)", async () => {
    const first = await member();
    const second = await secondMember(first.orgId);
    const made = (await (await upload(first.cookie, [file(PDF, "x.pdf")])).json()) as { caseId: string };
    const again = await upload(second.cookie, [file(PDF, "x.pdf")]);
    expect(await again.json()).toEqual({ caseId: made.caseId, repeat: true });
    expect(await casesOf(first.orgId)).toHaveLength(1);
    expect(await uploadedBy(made.caseId)).toBe(await userIdOf(first.cookie));
    expect(await uploadedBy(made.caseId)).not.toBe(second.userId);
  });

  it("answers the same file under the same name and type with the first case, and under another with a new one", async () => {
    const { cookie, orgId } = await member();
    const first = (await (await upload(cookie, [file(PDF, "x.pdf")])).json()) as { caseId: string };
    const again = await upload(cookie, [file(PDF, "x.pdf")]);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ caseId: first.caseId, repeat: true });
    expect(await casesOf(orgId)).toHaveLength(1);
    // What it claims is checked, so a renamed or retyped copy is a case of its own (D02 T04 §4's plan review).
    expect((await upload(cookie, [file(PDF, "x.png")])).status).toBe(201);
    expect((await upload(cookie, [["file", new Blob([PDF], { type: "image/png" }), "x.pdf"]])).status).toBe(201);
    expect(await casesOf(orgId)).toHaveLength(3);
  });

  it("keeps a case whose file could not be stored, ended partial, and the sweep starts one whose start was unknown", async () => {
    const { cookie, orgId } = await member();
    // The real bucket, except that writing fails (a spread copy would lose the binding's methods, delete included).
    const brokenR2 = new Proxy(env.ARTEFACTS, {
      get: (target, name) =>
        name === "put" ? () => Promise.reject(new Error("R2 down")) : Reflect.get(target, name).bind(target),
    });
    expect(
      (await upload(cookie, [file(PDF, "x.pdf")], { ...(env as unknown as Env), ARTEFACTS: brokenR2 })).status,
    ).toBe(503);
    // A case the member may have seen is never deleted (D01 T03 §12): it reads RawMissing, and its claim is freed.
    const [unstored] = await casesOf(orgId);
    expect(await caseStatus((unstored as { id: string }).id)).toBe("partial");
    expect(await claimsOf(orgId)).toEqual([]);

    // R2 takes the file, then D1 cannot record its row: retain the case and claim until recovery repairs the row.
    const written: string[] = [];
    const recordingBucket = new Proxy(env.ARTEFACTS, {
      get: (target, name) =>
        name === "put"
          ? (key: string, ...rest: unknown[]) => {
              written.push(key);
              return (target.put as (...a: unknown[]) => unknown)(key, ...rest);
            }
          : Reflect.get(target, name).bind(target),
    });
    const rowsDown = new Proxy(env.DB, {
      get: (target, name) =>
        name === "prepare"
          ? (sql: string) =>
              sql.startsWith("INSERT INTO artefacts")
                ? { bind: () => ({ run: () => Promise.reject(new Error("D1 down")) }) }
                : target.prepare(sql)
          : Reflect.get(target, name).bind(target),
    });
    const orphaned = await upload(cookie, [file(JPEG, "z.jpg")], {
      ...(env as unknown as Env),
      ARTEFACTS: recordingBucket,
      DB: rowsDown,
    });
    expect(orphaned.status).toBe(503);
    expect(written.length).toBeGreaterThan(0);
    const failed = (await casesOf(orgId)).map((c) => (c as { id: string }).id);
    expect(failed).toHaveLength(2);
    const orphanId = failed.find((id) => id !== (unstored as { id: string }).id);
    if (!orphanId) throw new Error("the orphaned intake case is missing");
    expect(await caseStatus((unstored as { id: string }).id)).toBe("partial");
    expect(await caseStatus(orphanId)).toBe("received");
    expect(await claimsOf(orgId)).toEqual([{ state: "pending" }]);

    // The Workflow's creation fails and its state cannot be read: the claim stays pending with its case.
    const unknown = {
      create: () => Promise.reject(new Error("workflows down")),
      get: () => Promise.reject(new Error("workflows down")),
    } as unknown as Workflow;
    expect((await upload(cookie, [file(PNG, "y.png")], { ...(env as unknown as Env), ANALYSIS: unknown })).status).toBe(
      503,
    );
    const pending = (await casesOf(orgId)).find((c) => !failed.includes((c as { id: string }).id));
    expect(pending).toBeDefined();
    expect(await claimsOf(orgId)).toEqual([{ state: "pending" }, { state: "pending" }]);
    // Past the lease, the sweep finds the case stored with no Workflow and starts it (D01 T03 §12): the case, its file
    // and a done claim stay, and the case finishes.
    const later = new Date(Date.now() + 6 * 60_000);
    await sweepIntake(env as unknown as Env, later);
    expect((await casesOf(orgId)).map((c) => c.id)).toContain((pending as { id: string }).id);
    expect(await claimsOf(orgId)).toEqual([{ state: "done" }, { state: "done" }]);
    expect(
      await db.prepare("SELECT r2_key FROM artefacts WHERE case_id=? AND kind='attachment'").bind(orphanId).first(),
    ).not.toBeNull();
    expect(await objectsOf((pending as { id: string }).id)).toBeGreaterThan(0);
    await finished((pending as { id: string }).id);
    await finished(orphanId);
    vi.restoreAllMocks();
  });
});

// A voice note's upload now transcribes (D01 T03 §3): Meta's transcription answered at the gateway, the rest untouched.
function stubTranscription() {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.endsWith("/asr/transcribe")) return real(input, init);
    const body = { sessionId: "s", transcript: "", audioDurationMs: 3_000, turns: [] };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
}

describe("an upload's Workflow", () => {
  // Three uploads run through the Workflow one after another, longer than one step's 15 seconds on a loaded machine.
  it("records a document, an image and a voice note for the later steps, the file unchanged", {
    timeout: 60_000,
  }, async () => {
    const { cookie } = await member();
    stubTranscription();
    for (const [bytes, name, kind, type] of [
      [PDF, "invoice.pdf", "document", "application/pdf"],
      [PNG, "pop.png", "image", "image/png"],
      [toneOgg, "note.ogg", "audio", "audio/ogg"],
      [
        zip([
          { name: "[Content_Types].xml", data: enc("<Types/>") },
          { name: "word/document.xml", data: enc("<w:document/>") },
        ]),
        "letter.docx",
        "document",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ],
      [
        zip([
          { name: "[Content_Types].xml", data: enc("<Types/>") },
          { name: "xl/workbook.xml", data: enc("<x/>") },
        ]),
        "sheet.xlsx",
        "document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
      [
        zip([
          { name: "[Content_Types].xml", data: enc("<Types/>") },
          { name: "ppt/presentation.xml", data: enc("<x/>") },
        ]),
        "deck.pptx",
        "document",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ],
    ] as [Uint8Array, string, string, string][]) {
      const { caseId } = (await (await upload(cookie, [file(bytes, name)])).json()) as { caseId: string };
      await finished(caseId);
      const summary = await readArtefact(store, caseId, parsedKey(caseId));
      const read = JSON.parse(new TextDecoder().decode(summary && "body" in summary ? summary.body : new Uint8Array()));
      expect(read.source).toMatchObject({ kind, mediaType: type, bytes: bytes.byteLength });
      const original = await readArtefact(store, caseId, read.source.key);
      expect(original && "body" in original ? [...original.body] : []).toEqual([...bytes]);
      const row = await getCaseForPipeline(db, caseId);
      expect(row.ok && row.value).toMatchObject({ status: "done", verdict: "safe" });
    }
    vi.restoreAllMocks();
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

  it("keeps the file's own name and submitted media type on the case, apart from what was detected (D02 T04 §4)", async () => {
    const { cookie } = await member();
    const made = (await (
      await upload(cookie, [["file", new Blob([PDF], { type: "image/png" }), "invoice.png"]])
    ).json()) as { caseId: string };
    const row = await getCaseForPipeline(db, made.caseId);
    expect(row.ok && row.value).toMatchObject({
      uploadName: "invoice.png",
      uploadMediaType: "image/png",
      sourceKind: "document",
    });
    await finished(made.caseId);
    const summary = await readArtefact(store, made.caseId, parsedKey(made.caseId));
    const parsed = JSON.parse(new TextDecoder().decode(summary && "body" in summary ? summary.body : new Uint8Array()));
    expect(parsed.source).toMatchObject({
      mediaType: "application/pdf",
      claimed: { name: "invoice.png", mediaType: "image/png" },
    });
  });

  it("stores a mismatch for a name, a media type or both that disagree with the bytes, and none when they agree", async () => {
    const { cookie } = await member();
    const cases: [string, string, string[] | null][] = [
      ["invoice.png", "application/pdf", ["extension"]],
      ["invoice.pdf", "image/png", ["media type"]],
      ["invoice.png", "image/png", ["extension", "media type"]],
      ["invoice.pdf", "application/pdf", null],
    ];
    for (const [name, type, claims] of cases) {
      const answer = await upload(cookie, [["file", new Blob([PDF], { type }), name]]);
      const { caseId } = (await answer.json()) as { caseId: string };
      await finished(caseId);
      const items = (await readEvidence(db, caseId)).filter((e) => e.check === "attachment.type_mismatch");
      const row = await getCaseForPipeline(db, caseId);
      const summary = await readArtefact(store, caseId, parsedKey(caseId));
      const key = JSON.parse(new TextDecoder().decode(summary && "body" in summary ? summary.body : new Uint8Array()))
        .source.key;
      if (!claims) {
        expect(items, `${name} ${type}`).toEqual([]);
        continue;
      }
      expect(items, `${name} ${type}`).toMatchObject([
        { severity: "medium", artefacts: [key], detail: { filename: name, declared: type, sniffed: "pdf", claims } },
      ]);
      expect(row.ok && row.value.uploadMediaType).toBe(type);
    }
  });

  it("refuses a name or media type past the limit with 400, leaving no case, claim or object", async () => {
    const { cookie, orgId } = await member();
    const long = `${"n".repeat(MAX_CLAIM_CHARS - 3)}.pdf`;
    const byName = await upload(cookie, [file(PDF, long)]);
    expect(byName.status).toBe(400);
    expect(((await byName.json()) as { error: string }).error).toContain("name");
    const byType = await upload(cookie, [
      ["file", new Blob([PDF], { type: `application/${"x".repeat(MAX_CLAIM_CHARS)}` }), "x.pdf"],
    ]);
    expect(byType.status).toBe(400);
    expect(await casesOf(orgId)).toEqual([]);
    expect(await claimsOf(orgId)).toEqual([]);
    const fits = await upload(cookie, [file(PDF, `${"n".repeat(MAX_CLAIM_CHARS - 4)}.pdf`)]);
    expect(fits.status).toBe(201);
  });

  it("keeps the name exactly as sent, and states a file of a type not identified as partly checked (completion review)", async () => {
    const { cookie } = await member();
    const spaced = (await (
      await upload(cookie, [["file", new Blob([PDF], { type: "image/png" }), " invoice.png "]])
    ).json()) as { caseId: string };
    const row = await getCaseForPipeline(db, spaced.caseId);
    expect(row.ok && row.value.uploadName).toBe(" invoice.png ");
    await finished(spaced.caseId);
    expect(
      (await readEvidence(db, spaced.caseId)).find((e) => e.check === "attachment.type_mismatch")?.detail,
    ).toMatchObject({
      filename: " invoice.png ",
      claims: ["extension", "media type"],
    });
    // Transcribed by what its bytes are, WAV, never by the false PDF claim (D01 T03 §3).
    stubTranscription();
    const audio = (await (
      await upload(cookie, [["file", new Blob([toneWav], { type: "application/pdf" }), "invoice.pdf"]])
    ).json()) as { caseId: string };
    await finished(audio.caseId);
    vi.restoreAllMocks();
    // WAV is identified (D02 T04 §5): the false PDF claim is evidence, and the check read all it compares.
    expect(
      (await readEvidence(db, audio.caseId)).find((e) => e.check === "attachment.type_mismatch")?.detail,
    ).toMatchObject({ sniffed: "wav", claims: ["extension", "media type"] });
    expect(
      (await readCheckOutcomes(db, audio.caseId))?.find((o) => o.check === "attachment.type_mismatch"),
    ).toMatchObject({ outcome: "ran", reason: null, findings: 1 });
  });
});

// D01 T03 §12: an upload's admission finishes whatever the browser does, and a stranded case is never removed.
describe("an upload whose browser leaves", () => {
  it("hands the admission to waitUntil, still open when it is handed, and finishes it after the request is abandoned", async () => {
    const { cookie, orgId } = await member();
    // The Workflow's creation is held open, as a slow start would be while the browser signs out.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const analysis = new Proxy(env.ANALYSIS, {
      get: (target, name) =>
        name === "create"
          ? async (...args: unknown[]) => {
              await gate;
              return (target.create as (...a: unknown[]) => unknown)(...args);
            }
          : Reflect.get(target, name).bind(target),
    });
    const waits: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => void waits.push(promise),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    const form = new FormData();
    form.append("file", new Blob([JPEG], { type: "image/jpeg" }), "late.jpg");
    // The answer is never read: the browser has gone.
    void worker.fetch(
      new Request(`${ORIGIN}/api/upload`, {
        method: "POST",
        body: form,
        headers: { origin: ORIGIN, accept: "application/json", cookie },
      }),
      { ...(env as unknown as Env), ANALYSIS: analysis as unknown as Workflow },
      ctx,
    );
    await expect.poll(() => waits.length, { timeout: 10_000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await casesOf(orgId)).length, { timeout: 10_000 }).toBe(1);
    const [made] = await casesOf(orgId);
    expect(await claimsOf(orgId)).toEqual([{ state: "pending" }]);
    release();
    await Promise.all(waits);
    expect(await claimsOf(orgId)).toEqual([{ state: "done" }]);
    await finished((made as { id: string }).id);
  });

  it("keeps a case whose file was stored though the store's read-back failed, and the sweep starts it (round 1)", async () => {
    const { cookie, orgId } = await member();
    // The artefact row commits; the read that follows it fails once, as a dropped connection would.
    let failed = false;
    const readBackDown = new Proxy(env.DB, {
      get: (target, name) =>
        name === "prepare"
          ? (sql: string) => {
              if (!failed && sql.startsWith("SELECT * FROM artefacts WHERE r2_key")) {
                failed = true;
                return {
                  bind: () => ({ first: () => Promise.reject(new Error("D1_ERROR: Network connection lost.")) }),
                };
              }
              return target.prepare(sql);
            }
          : Reflect.get(target, name).bind(target),
    });
    const answer = await upload(cookie, [file(JPEG, "stored.jpg")], { ...(env as unknown as Env), DB: readBackDown });
    expect(answer.status).toBe(503);
    const [kept] = await casesOf(orgId);
    const id = (kept as { id: string }).id;
    // Not RawMissing: the file is there, so the case stays received with its claim pending.
    expect(await caseStatus(id)).toBe("received");
    expect(await objectsOf(id)).toBeGreaterThan(0);
    expect(await claimsOf(orgId)).toEqual([{ state: "pending" }]);
    await sweepIntake(env as unknown as Env, new Date(Date.now() + CLAIM_LEASE_MS + 60_000));
    expect(await claimsOf(orgId)).toEqual([{ state: "done" }]);
    await finished(id);
    expect(await caseStatus(id)).toBe("done");
  });

  it("admits each eval replay run as its own case, and a repeat of one run as its duplicate (D01 T01 §22)", async () => {
    const { cookie, orgId } = await member();
    const evalEnv = { ...(env as unknown as Env), EVAL_ORG_ID: orgId } as Env;
    const first = await upload(cookie, [file(PDF, "x.pdf"), ["replayRunId", "run-1"]], evalEnv);
    expect(first.status).toBe(201);
    const one = (await first.json()) as { caseId: string };
    const second = await upload(cookie, [["replayRunId", "run-2"], file(PDF, "x.pdf")], evalEnv);
    expect(second.status).toBe(201);
    const two = (await second.json()) as { caseId: string };
    expect(two.caseId).not.toBe(one.caseId);
    const repeat = await upload(cookie, [file(PDF, "x.pdf"), ["replayRunId", "run-1"]], evalEnv);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ caseId: one.caseId, repeat: true });
    const keys = (
      await db
        .prepare("SELECT message_key FROM intake_messages WHERE org_id = ?")
        .bind(orgId)
        .all<{ message_key: string }>()
    ).results.map((r) => r.message_key);
    expect(keys.some((k) => k.startsWith("replay:run-1:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("replay:run-2:"))).toBe(true);
    // With the variable unset, the same field is ignored: an ordinary case of its own, then its duplicate.
    const plain = await upload(cookie, [file(PDF, "x.pdf"), ["replayRunId", "run-3"]]);
    expect(plain.status).toBe(201);
    const plainCase = ((await plain.json()) as { caseId: string }).caseId;
    expect(plainCase).not.toBe(one.caseId);
    const plainRepeat = await upload(cookie, [file(PDF, "x.pdf")]);
    expect(await plainRepeat.json()).toEqual({ caseId: plainCase, repeat: true });
  });

  it("expires a replay claim like an ordinary one, then admits the run again (D01 T01 §22)", async () => {
    const { cookie, orgId } = await member();
    const evalEnv = { ...(env as unknown as Env), EVAL_ORG_ID: orgId } as Env;
    const first = await upload(cookie, [file(PDF, "x.pdf"), ["replayRunId", "run-1"]], evalEnv);
    const one = ((await first.json()) as { caseId: string }).caseId;
    await db
      .prepare("UPDATE intake_messages SET claimed_at = ? WHERE org_id = ?")
      .bind(new Date(Date.now() - 25 * 60 * 60_000).toISOString(), orgId)
      .run();
    await sweepIntake(env as unknown as Parameters<typeof sweepIntake>[0]);
    expect(await claimsOf(orgId)).toHaveLength(0);
    const again = await upload(cookie, [file(PDF, "x.pdf"), ["replayRunId", "run-1"]], evalEnv);
    expect(again.status).toBe(201);
    expect(((await again.json()) as { caseId: string }).caseId).not.toBe(one);
  });

  it("keeps replay claims inside their own organisation (D01 T01 §22)", async () => {
    const a = await member();
    const b = await member();
    const envA = { ...(env as unknown as Env), EVAL_ORG_ID: a.orgId } as Env;
    const fromA = await upload(a.cookie, [file(PDF, "x.pdf"), ["replayRunId", "run-1"]], envA);
    expect(fromA.status).toBe(201);
    const caseA = ((await fromA.json()) as { caseId: string }).caseId;
    // The same bytes and run id from another organisation, with that organisation named as eval for its
    // own request, answer only its own case; without the predicate each would read the other's.
    const envB = { ...(env as unknown as Env), EVAL_ORG_ID: b.orgId } as Env;
    const fromB = await upload(b.cookie, [file(PDF, "x.pdf"), ["replayRunId", "run-1"]], envB);
    expect(fromB.status).toBe(201);
    const caseB = ((await fromB.json()) as { caseId: string }).caseId;
    expect(caseB).not.toBe(caseA);
    expect((await casesOf(a.orgId)).map((c) => c.id)).toEqual([caseA]);
    expect((await casesOf(b.orgId)).map((c) => c.id)).toEqual([caseB]);
    // Each organisation's persisted claim is its own, scoped and linked to its own case, and each
    // organisation's scoped repeat answers its own case (round 1).
    for (const [orgId, caseId] of [
      [a.orgId, caseA],
      [b.orgId, caseB],
    ] as const) {
      const claims = (
        await db
          .prepare("SELECT message_key, case_id FROM intake_messages WHERE org_id = ?")
          .bind(orgId)
          .all<{ message_key: string; case_id: string }>()
      ).results;
      expect(claims).toEqual([{ message_key: expect.stringMatching(/^replay:run-1:/), case_id: caseId }]);
    }
    const repeatA = await upload(a.cookie, [file(PDF, "x.pdf"), ["replayRunId", "run-1"]], envA);
    expect(await repeatA.json()).toEqual({ caseId: caseA, repeat: true });
    const repeatScopedB = await upload(b.cookie, [file(PDF, "x.pdf"), ["replayRunId", "run-1"]], envB);
    expect(await repeatScopedB.json()).toEqual({ caseId: caseB, repeat: true });
    // A non-eval organisation's replay field is ignored: it makes its own ordinary case, never A's,
    // and that ordinary case is what its fieldless repeat duplicates.
    const repeatB = await upload(b.cookie, [file(PDF, "x.pdf"), ["replayRunId", "run-9"]], envA);
    expect(repeatB.status).toBe(201);
    const ordinaryB = ((await repeatB.json()) as { caseId: string }).caseId;
    expect(ordinaryB).not.toBe(caseA);
    expect(ordinaryB).not.toBe(caseB);
    const againB = await upload(b.cookie, [file(PDF, "x.pdf")], envA);
    expect(await againB.json()).toEqual({ caseId: ordinaryB, repeat: true });
  });

  it("refuses a malformed replay run id before anything is admitted (D01 T01 §22)", async () => {
    const { cookie, orgId } = await member();
    const { seen, workerEnv } = counted();
    const evalEnv = { ...workerEnv, EVAL_ORG_ID: orgId } as Env;
    for (const parts of [
      [file(PDF, "x.pdf"), ["replayRunId", ""]] as [string, Blob | string, string?][],
      [file(PDF, "x.pdf"), ["replayRunId", "bad id!"]] as [string, Blob | string, string?][],
      [file(PDF, "x.pdf"), ["replayRunId", "a".repeat(65)]] as [string, Blob | string, string?][],
      [file(PDF, "x.pdf"), ["replayRunId", "run-1"], ["replayRunId", "run-2"]] as [string, Blob | string, string?][],
      [file(PDF, "x.pdf"), ["replayRunId", new Blob(["run-1"]), "run.txt"]] as [string, Blob | string, string?][],
    ]) {
      expect((await upload(cookie, parts, evalEnv)).status).toBe(400);
    }
    expect(await casesOf(orgId)).toHaveLength(0);
    expect(await claimsOf(orgId)).toHaveLength(0);
    expect(seen.puts).toHaveLength(0);
    expect(seen.starts).toBe(0);
  });

  it("makes its case under a stale claim whose case was never made, with no sweep first", async () => {
    const { cookie, orgId } = await member();
    const key = `upload:${await uploadKey(PNG, "again.png", "image/png")}`;
    const old = new Date(Date.now() - CLAIM_LEASE_MS - 60_000).toISOString();
    await db
      .prepare(
        "INSERT INTO intake_messages (org_id, message_key, state, case_id, claimed_at) VALUES (?, ?, 'pending', ?, ?)",
      )
      .bind(orgId, key, ulid(), old)
      .run();
    const answer = await upload(cookie, [["file", new Blob([PNG], { type: "image/png" }), "again.png"]]);
    expect(answer.status).toBe(201);
    const { caseId } = (await answer.json()) as { caseId: string };
    expect((await casesOf(orgId)).map((c) => c.id)).toEqual([caseId]);
    expect(await claimsOf(orgId)).toEqual([{ state: "done" }]);
    await finished(caseId);
  });
});
