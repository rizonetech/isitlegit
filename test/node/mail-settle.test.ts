import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { settle, steer } from "../../scripts/mail-settle.ts";
import { settleStatement } from "../../src/mail/settle.ts";

// scripts/mail-settle.ts (D01 T02 §5): the operator's way to settle a send the reconciler could not, which never
// reopens a sent message and never lets a send key carry SQL. And wrangler.jsonc's cron runs the reconciler.
const AT = new Date("2026-10-27T20:00:00Z");

describe("mail-settle", () => {
  it("updates only an uncertain or pending row, through Wrangler against the live database", async () => {
    const calls: string[][] = [];
    const run = async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return JSON.stringify([{ results: [], meta: { changes: 1 } }]);
    };
    expect(await settle(run, "reply:01JB2Z3Y4X5W6V7T8S9R0Q1P2N", "sent", "2026-10-24T19:20:11.000Z", AT)).toBe(
      "mail-settle: reply:01JB2Z3Y4X5W6V7T8S9R0Q1P2N is now sent",
    );
    expect(calls[0]?.slice(0, 8)).toEqual([
      "pnpm",
      "exec",
      "wrangler",
      "d1",
      "execute",
      "isitlegit",
      "--remote",
      "--json",
    ]);
    expect(calls[0]?.at(-1)).toBe(
      "UPDATE mail_sends SET status = 'sent', error = 'settled by the operator', search_cursor = NULL, updated_at = '2026-10-27T20:00:00.000Z' WHERE send_key = 'reply:01JB2Z3Y4X5W6V7T8S9R0Q1P2N' AND claimed_at = '2026-10-24T19:20:11.000Z' AND status IN ('uncertain', 'pending') AND coalesce(resend_state, '') <> 'sending'",
    );
  });

  it("refuses a row that changed nothing (sent already, or no such key)", async () => {
    const run = async () => JSON.stringify([{ results: [], meta: { changes: 0 } }]);
    await expect(settle(run, "reply:x", "failed", "2026-10-24T19:20:11.000Z", AT)).rejects.toThrow(
      /a newer attempt has claimed it since 2026-10-24T19:20:11.000Z/,
    );
  });

  it("refuses a send key that is not one, and an outcome other than sent or failed", () => {
    for (const key of ["reply:x' OR '1'='1", "a b", "", "x".repeat(201)])
      expect(() => settleStatement(key, "sent", AT.toISOString(), AT.toISOString()), key).toThrow(/is not a send key/);
    expect(() => settleStatement("reply:x", "delivered", AT.toISOString(), AT.toISOString())).toThrow(/sent or failed/);
    for (const claimed of ["", "yesterday", "2026-10-24' OR '1'='1"])
      expect(() => settleStatement("reply:x", "sent", claimed, AT.toISOString()), claimed).toThrow(/--claimed-at/);
  });
});

describe("wrangler.jsonc", () => {
  it("runs the scheduled handler every 15 minutes and names the operator's mailbox", () => {
    const text = readFileSync(join(import.meta.dirname, "../../wrangler.jsonc"), "utf-8");
    // JSON with comments: drop whole-line comments and trailing ones after a value.
    const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
    expect(config.triggers).toEqual({ crons: ["*/15 * * * *"] });
    expect(config.vars.OPERATOR_EMAIL).toBe("hostmaster@rizonetech.com");
  });
});

// D01 T02 §8: --resend, status, cancel and requeue, on an in-memory SQLite with the resend migration.
function live() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE mail_sends (id TEXT PRIMARY KEY, send_key TEXT UNIQUE, kind TEXT, status TEXT, error TEXT, search_cursor TEXT, updated_at TEXT, claimed_at TEXT);",
  );
  db.exec(readFileSync(join(import.meta.dirname, "../../src/db/migrations/0031_mail_resend.sql"), "utf-8"));
  db.exec(readFileSync(join(import.meta.dirname, "../../src/db/migrations/0032_mail_resend_outcome.sql"), "utf-8"));
  db.exec(readFileSync(join(import.meta.dirname, "../../src/db/migrations/0033_mail_resend_alert_tried.sql"), "utf-8"));
  const add = (key: string, kind: string, status = "uncertain") =>
    db
      .prepare(
        "INSERT INTO mail_sends (id, send_key, kind, status, claimed_at) VALUES (?, ?, ?, ?, '2026-10-24T19:20:11.000Z')",
      )
      .run(key, key, kind, status);
  const run = async (_command: string, args: string[]) => {
    const sql = args.at(-1) as string;
    if (/^\s*select/i.test(sql)) return JSON.stringify([{ results: db.prepare(sql).all(), meta: {} }]);
    return JSON.stringify([{ results: [], meta: { changes: Number(db.prepare(sql).run().changes) } }]);
  };
  const state = (key: string) =>
    db.prepare("SELECT status, resend_state, resend_runs FROM mail_sends WHERE send_key = ?").get(key) as Record<
      string,
      unknown
    >;
  return { add, run, state };
}
const CLAIM = "2026-10-24T19:20:11.000Z";

describe("mail-settle --resend (D01 T02 §8)", () => {
  it("asks for a reply's resend in the statement that settles it failed", async () => {
    const w = live();
    w.add("reply:01JB2Z3Y4X5W6V7T8S9R0Q1P2N", "reply");
    expect(await settle(w.run, "reply:01JB2Z3Y4X5W6V7T8S9R0Q1P2N", "failed", CLAIM, AT, true)).toContain(
      "goes again within 15 minutes",
    );
    expect(w.state("reply:01JB2Z3Y4X5W6V7T8S9R0Q1P2N")).toEqual({
      status: "failed",
      resend_state: "requested",
      resend_runs: 0,
    });
  });

  it("refuses --resend for another kind or with sent, writing nothing, and asks nothing when the row was not settled", async () => {
    const w = live();
    w.add("unresolved:reply:x@2026-10-24T19:20:11.000Z", "alert");
    w.add("reply:01JB2Z3Y4X5W6V7T8S9R0Q1P2M", "reply");
    w.add("reply:01JB2Z3Y4X5W6V7T8S9R0Q1P2L", "reply", "sent");
    await expect(
      settle(w.run, "unresolved:reply:x@2026-10-24T19:20:11.000Z", "failed", CLAIM, AT, true),
    ).rejects.toThrow(/only a reply can be sent again/);
    await expect(settle(w.run, "reply:01JB2Z3Y4X5W6V7T8S9R0Q1P2M", "sent", CLAIM, AT, true)).rejects.toThrow(
      /never with sent/,
    );
    expect(w.state("reply:01JB2Z3Y4X5W6V7T8S9R0Q1P2M")).toEqual({
      status: "uncertain",
      resend_state: null,
      resend_runs: 0,
    });
    await expect(settle(w.run, "reply:01JB2Z3Y4X5W6V7T8S9R0Q1P2L", "failed", CLAIM, AT, true)).rejects.toThrow(
      /was not changed/,
    );
    expect(w.state("reply:01JB2Z3Y4X5W6V7T8S9R0Q1P2L")).toEqual({ status: "sent", resend_state: null, resend_runs: 0 });
  });

  it("reads a resend's state, cancels it before the cron claims it and not after, and requeues an exhausted one", async () => {
    const w = live();
    const key = "reply:01JB2Z3Y4X5W6V7T8S9R0Q1P2K";
    w.add(key, "reply");
    await settle(w.run, key, "failed", CLAIM, AT, true);
    expect(await steer(w.run, key, "status", AT)).toContain("resend requested, 0 run(s)");
    expect(await steer(w.run, key, "cancel", AT)).toContain("resend cancelled");
    expect(w.state(key).resend_state).toBe("cancelled");
    expect(await steer(w.run, key, "requeue", AT)).toContain("requested again");
    // The cron claims it: a cancel now is refused, so a confirmed cancel can never still send.
    await w.run("pnpm", [
      "UPDATE mail_sends SET resend_state = 'sending' WHERE send_key = 'reply:01JB2Z3Y4X5W6V7T8S9R0Q1P2K'",
    ]);
    await expect(steer(w.run, key, "cancel", AT)).rejects.toThrow(/the cron may have claimed it/);
    await w.run("pnpm", [
      "UPDATE mail_sends SET resend_state = 'exhausted', resend_runs = 3 WHERE send_key = 'reply:01JB2Z3Y4X5W6V7T8S9R0Q1P2K'",
    ]);
    expect(await steer(w.run, key, "requeue", AT)).toContain("requested again");
    expect(w.state(key)).toEqual({ status: "failed", resend_state: "requested", resend_runs: 0 });
    await expect(steer(w.run, key, "requeue", AT)).rejects.toThrow(/was not requeued/);
  });
});

describe("mail-settle, completion review (2026-10-29)", () => {
  it("asks for a reply settled failed without --resend, and says where each send stands and what to do next", async () => {
    const w = live();
    const key = "reply:01JB2Z3Y4X5W6V7T8S9R0Q1P2J";
    w.add(key, "reply");
    await settle(w.run, key, "failed", CLAIM, AT);
    expect(await steer(w.run, key, "status", AT)).toContain("Next: resend, if SMTP2GO has no record of it");
    expect(await steer(w.run, key, "resend", AT)).toContain("requested again");
    expect(w.state(key)).toEqual({ status: "failed", resend_state: "requested", resend_runs: 0 });
    expect(await steer(w.run, key, "status", AT)).toContain("Next: wait for the cron (15 minutes), or cancel");
    const other = "unresolved:reply:y@2026-10-24T19:20:11.000Z";
    w.add(other, "alert", "failed");
    expect(await steer(w.run, other, "status", AT)).toContain("Next: nothing; only a reply can be sent again");
    // A resend that ended, its row then settled failed: resend is the next step (round 4).
    await w.run("pnpm", [`UPDATE mail_sends SET resend_state = 'done' WHERE send_key = '${key}'`]);
    expect(await steer(w.run, key, "status", AT)).toContain("Next: resend, if SMTP2GO has no record of it");
  });
});
