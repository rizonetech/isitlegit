import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { settle, settleStatement } from "../../scripts/mail-settle.ts";

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
    expect(await settle(run, "reply:01JB2Z3Y4X5W6V7T8S9R0Q1P2N", "sent", AT)).toBe(
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
      "UPDATE mail_sends SET status = 'sent', error = 'settled by the operator', updated_at = '2026-10-27T20:00:00.000Z' WHERE send_key = 'reply:01JB2Z3Y4X5W6V7T8S9R0Q1P2N' AND status IN ('uncertain', 'pending')",
    );
  });

  it("refuses a row that changed nothing (sent already, or no such key)", async () => {
    const run = async () => JSON.stringify([{ results: [], meta: { changes: 0 } }]);
    await expect(settle(run, "reply:x", "failed", AT)).rejects.toThrow(/no longer uncertain or pending/);
  });

  it("refuses a send key that is not one, and an outcome other than sent or failed", () => {
    for (const key of ["reply:x' OR '1'='1", "a b", "", "x".repeat(201)])
      expect(() => settleStatement(key, "sent", AT.toISOString()), key).toThrow(/is not a send key/);
    expect(() => settleStatement("reply:x", "delivered", AT.toISOString())).toThrow(/sent or failed/);
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
