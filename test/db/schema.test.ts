import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// src/db/migrations/0001_core.sql (D01 T01 §1): the tables hold the spec's values, every child row belongs to one case,
// evidence ids are per case, and deleting a case deletes what it gathered.
const db = env.DB;
let n = 0;
async function newCase(org = "org-a") {
  const id = `case-${++n}`;
  const now = new Date().toISOString();
  await db
    .prepare("INSERT INTO cases (id, org_id, channel, created_at, updated_at) VALUES (?, ?, 'email', ?, ?)")
    .bind(id, org, now, now)
    .run();
  return id;
}
const now = () => new Date().toISOString();
const artefact = (caseId: string | null, key: string) =>
  db
    .prepare(
      "INSERT INTO artefacts (r2_key, case_id, kind, sha256, media_type, bytes) VALUES (?, ?, 'raw', 'ab', 'message/rfc822', 10)",
    )
    .bind(key, caseId);
const evidence = (
  caseId: string | null,
  id: string,
  severity = "high",
  detail = '{"spf":"fail","nested":[1,2]}',
  keys = '["raw/a"]',
  seq = Number(id.slice(1)),
) =>
  db
    .prepare(
      `INSERT INTO evidence (case_id, id, seq, "check", severity, summary, detail_json, artefact_keys_json, created_at) VALUES (?, ?, ?, 'auth', ?, 'SPF failed', ?, ?, ?)`,
    )
    .bind(caseId, id, seq, severity, detail, keys, now());
const event = (caseId: string | null, step: string) =>
  db
    .prepare("INSERT INTO case_events (case_id, step, status, started_at, ms) VALUES (?, ?, 'ok', ?, 5)")
    .bind(caseId, step, now());

describe("the core schema", () => {
  it("refuses values the spec does not name", async () => {
    const at = now();
    for (const [column, value] of [
      ["channel", "fax"],
      ["status", "bogus"],
      ["verdict", "maybe"],
      ["headers_available", 2],
    ] as const) {
      const insert = db
        .prepare(
          `INSERT INTO cases (id, org_id, channel, created_at, updated_at, ${column === "channel" ? "status" : column}) VALUES (?, 'o', ${column === "channel" ? "?" : "'email'"}, ?, ?, ${column === "channel" ? "'received'" : "?"})`,
        )
        .bind(...(column === "channel" ? [`bad-${column}`, value, at, at] : [`bad-${column}`, at, at, value]));
      await expect(insert.run(), column).rejects.toThrow(/CHECK constraint failed/);
    }
    const caseId = await newCase();
    await expect(evidence(caseId, "E1", "severe").run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      db
        .prepare(
          "INSERT INTO artefacts (r2_key, case_id, kind, sha256, media_type, bytes) VALUES ('k', ?, 'video', 'ab', 'x', 1)",
        )
        .bind(caseId)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("round-trips an artefact, an evidence row with its JSON intact, and events in order", async () => {
    const caseId = await newCase();
    await artefact(caseId, "raw/one").run();
    expect(await db.prepare("SELECT * FROM artefacts WHERE r2_key = 'raw/one'").first()).toMatchObject({
      case_id: caseId,
      kind: "raw",
      bytes: 10,
    });
    await evidence(caseId, "E1").run();
    const row = await db.prepare("SELECT * FROM evidence WHERE case_id = ? AND id = 'E1'").bind(caseId).first<{
      detail_json: string;
      artefact_keys_json: string;
      check: string;
    }>();
    expect(JSON.parse(row?.detail_json as string)).toEqual({ spf: "fail", nested: [1, 2] });
    expect(JSON.parse(row?.artefact_keys_json as string)).toEqual(["raw/a"]);
    expect(row?.check).toBe("auth");
    await event(caseId, "parse").run();
    await event(caseId, "checks").run();
    const { results } = await db
      .prepare("SELECT step FROM case_events WHERE case_id = ? ORDER BY id")
      .bind(caseId)
      .all();
    expect(results.map((r) => r.step)).toEqual(["parse", "checks"]);
  });

  it("numbers evidence per case: two cases each hold E1, one case cannot hold it twice", async () => {
    const [a, b] = [await newCase(), await newCase()];
    await evidence(a, "E1").run();
    await evidence(b, "E1").run();
    const { results } = await db
      .prepare("SELECT case_id FROM evidence WHERE id = 'E1' AND case_id IN (?, ?) ORDER BY case_id")
      .bind(a, b)
      .all();
    expect(results.map((r) => r.case_id).sort()).toEqual([a, b].sort());
    await expect(evidence(a, "E1").run()).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("keeps evidence in creation order past nine items, and in the shapes spec 4.3 names", async () => {
    const caseId = await newCase();
    for (let i = 1; i <= 10; i++) await evidence(caseId, `E${i}`).run();
    const { results } = await db.prepare("SELECT id FROM evidence WHERE case_id = ? ORDER BY seq").bind(caseId).all();
    expect(results.map((r) => r.id)).toEqual(Array.from({ length: 10 }, (_, i) => `E${i + 1}`));
    const other = await newCase();
    for (const [detail, keys] of [
      ["42", "[]"],
      ['"text"', "[]"],
      ["{}", "{}"],
      ["{}", '"raw/a"'],
    ])
      await expect(evidence(other, "E1", "high", detail, keys).run(), `${detail} ${keys}`).rejects.toThrow(
        /CHECK constraint failed/,
      );
    await expect(evidence(other, "E2", "high", "{}", "[]", 3).run()).rejects.toThrow(/CHECK constraint failed/);
  });

  it("refuses a child row without a case or naming a missing one, in every child table", async () => {
    for (const insert of [artefact(null, "orphan/1"), evidence(null, "E1"), event(null, "x")])
      await expect(insert.run()).rejects.toThrow(/NOT NULL constraint failed/);
    for (const insert of [
      artefact("no-such-case", "orphan/2"),
      evidence("no-such-case", "E1"),
      event("no-such-case", "x"),
    ])
      await expect(insert.run()).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("deletes a case's artefacts, evidence and events with it, and leaves another case's alone", async () => {
    const [gone, kept] = [await newCase(), await newCase()];
    for (const id of [gone, kept]) {
      await artefact(id, `raw/${id}`).run();
      await evidence(id, "E1").run();
      await event(id, "parse").run();
    }
    await db.prepare("DELETE FROM cases WHERE id = ?").bind(gone).run();
    for (const table of ["artefacts", "evidence", "case_events"]) {
      const count = async (id: string) =>
        (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE case_id = ?`).bind(id).first<{ n: number }>())?.n;
      expect(await count(gone), table).toBe(0);
      expect(await count(kept), table).toBe(1);
    }
  });
});

// src/db/migrations/0003_mail.sql (D01 T02 §1): one row per logical send, the statuses its client and D01 T02 §2 write,
// a recipient only as a hash, and a case's sends deleted with it.
describe("the mail send log", () => {
  const HASH = "a".repeat(64);
  let k = 0;
  let rows = 0;
  const send = (caseId: string | null, status = "sent", kind = "reply", key = `send-${++k}`, toHash = HASH) =>
    db
      .prepare(
        "INSERT INTO mail_sends (id, send_key, case_id, kind, to_hash, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
      )
      .bind(`m-${++rows}`, key, caseId, kind, toHash, status, now(), now());

  it("round-trips every status, D01 T02 §2's refused included, and refuses an unknown status or kind", async () => {
    const id = await newCase();
    for (const status of ["pending", "sent", "failed", "uncertain", "refused"]) await send(id, status).run();
    const statuses = await db.prepare("SELECT status FROM mail_sends WHERE case_id = ? ORDER BY status").bind(id).all();
    expect(statuses.results.map((r) => r.status)).toEqual(["failed", "pending", "refused", "sent", "uncertain"]);
    for (const kind of ["reply", "signin", "verify", "alert", "notice", "renewal"])
      await send(null, "sent", kind).run();
    await expect(send(id, "delivered").run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(send(id, "sent", "newsletter").run()).rejects.toThrow(/CHECK constraint failed/);
  });

  it("holds one row per send key, and a recipient only as a 64-hex hash", async () => {
    await send(null, "sent", "signin", "signin:once").run();
    await expect(send(null, "sent", "signin", "signin:once").run()).rejects.toThrow(/UNIQUE constraint failed/);
    for (const toHash of ["someone@example.com", "A".repeat(64), "a".repeat(63)])
      await expect(send(null, "sent", "signin", `hash-${toHash.length}-${toHash[0]}`, toHash).run()).rejects.toThrow(
        /CHECK constraint failed/,
      );
  });

  it("deletes a case's sends with it, leaving another case's and those with no case", async () => {
    const [gone, kept] = [await newCase(), await newCase()];
    await send(gone, "sent", "reply", `reply:${gone}`).run();
    await send(kept, "sent", "reply", `reply:${kept}`).run();
    await send(null, "sent", "alert", "alert:standalone").run();
    await db.prepare("DELETE FROM cases WHERE id = ?").bind(gone).run();
    const keys = await db
      .prepare("SELECT send_key FROM mail_sends WHERE send_key IN (?, ?, ?) ORDER BY send_key")
      .bind(`reply:${gone}`, `reply:${kept}`, "alert:standalone")
      .all();
    expect(keys.results.map((r) => r.send_key)).toEqual(["alert:standalone", `reply:${kept}`]);
  });
});
