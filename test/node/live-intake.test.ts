import { describe, expect, it } from "vitest";
import { d1Query, parseLiveIntakeArgs, type Row, validMessageId, waitForCase } from "../../scripts/live-intake.ts";

// scripts/live-intake.ts (D01 T01 §9): only the named forward's case satisfies it, and every other outcome exits
// non-zero with its cause.
const ID = "<run-1@rizonetech.com>";

// A stand-in live D1: each look returns the next state, the last one repeating.
type State = { readonly cases: readonly Row[]; readonly sends?: readonly Row[] };
function world(states: readonly State[]) {
  let i = -1;
  const seen: string[] = [];
  const query = async (sql: string) => {
    seen.push(sql);
    // Each look starts with the cases query, which moves to the next state; the send query reads the same one.
    if (sql.startsWith("SELECT id, status FROM cases")) i += 1;
    const state = states[Math.min(i, states.length - 1)] as State;
    return [...(sql.startsWith("SELECT id, status FROM cases") ? state.cases : (state.sends ?? []))];
  };
  return { query, seen };
}

// A clock that each sleep moves forward.
function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("waitForCase", () => {
  it("passes once that forward's case is done and its reply sent", async () => {
    const w = world([
      { cases: [] },
      { cases: [{ id: "c1", status: "running" }] },
      { cases: [{ id: "c1", status: "done" }], sends: [{ status: "pending" }] },
      { cases: [{ id: "c1", status: "done" }], sends: [{ status: "sent" }] },
    ]);
    const result = await waitForCase({ messageId: ID, waitSeconds: 300, query: w.query, ...clock() });
    expect(result).toMatchObject({ ok: true, caseId: "c1" });
    expect(w.seen[0]).toBe(`SELECT id, status FROM cases WHERE message_id = '${ID}'`);
    expect(w.seen).toContain("SELECT status, error FROM mail_sends WHERE send_key = 'reply:c1'");
  });

  it("fails naming the cause: no case by the deadline, a partial analysis, a failed or refused reply, an unsent one", async () => {
    const cases = [
      [{ cases: [] }, "timed out after 30 s: no case for that Message-ID yet"],
      [{ cases: [{ id: "c2", status: "partial" }] }, "case c2: the analysis ended partial"],
      [{ cases: [{ id: "c3", status: "done" }], sends: [{ status: "failed", error: "HTTP 400" }] }, "reply was failed"],
      [
        { cases: [{ id: "c4", status: "done" }], sends: [{ status: "refused", error: "not allowed" }] },
        "reply was refused",
      ],
      [{ cases: [{ id: "c5", status: "done" }], sends: [{ status: "uncertain" }] }, "its reply is uncertain"],
      [{ cases: [{ id: "a" }, { id: "b" }] }, "2 cases carry that Message-ID"],
    ] as const;
    for (const [state, reason] of cases) {
      const result = await waitForCase({ messageId: ID, waitSeconds: 30, query: world([state]).query, ...clock() });
      expect(result.ok, reason).toBe(false);
      expect(result.ok ? "" : result.reason, reason).toContain(reason);
    }
  });

  it("retries a failed read until the deadline and names it", async () => {
    const query = async () => {
      throw new Error("wrangler d1 execute failed (exit 1)");
    };
    const result = await waitForCase({ messageId: ID, waitSeconds: 20, query, ...clock() });
    expect(result).toEqual({
      ok: false,
      reason: "timed out after 20 s: the live D1 could not be read (wrangler d1 execute failed (exit 1))",
    });
  });
});

describe("the arguments and the live query", () => {
  it("takes one Message-ID in angle brackets and nothing that leaves the SQL literal", () => {
    expect(parseLiveIntakeArgs(["--message-id", ID])).toEqual({ messageId: ID, waitSeconds: 300 });
    expect(parseLiveIntakeArgs(["--message-id", ID, "--wait", "60"]).waitSeconds).toBe(60);
    for (const bad of ["run-1@rizonetech.com", "<x'; DROP TABLE cases; --@h>", "<a b@h>", "<no-at>", ""])
      expect(validMessageId(bad), bad).toBe(false);
    expect(() => parseLiveIntakeArgs(["--message-id", "<x'@h>"])).toThrow(/Message-ID/);
    expect(() => parseLiveIntakeArgs(["--message-id", ID, "--wait", "0"])).toThrow(/--wait/);
  });

  it("reads the live D1 through wrangler, read only, and refuses an answer with no results", async () => {
    const calls: string[][] = [];
    const run = async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return JSON.stringify([{ results: [{ id: "c1", status: "done" }], success: true }]);
    };
    expect(await d1Query(run)("SELECT 1")).toEqual([{ id: "c1", status: "done" }]);
    expect(calls[0]).toEqual([
      "pnpm",
      "exec",
      "wrangler",
      "d1",
      "execute",
      "isitlegit",
      "--remote",
      "--json",
      "--command",
      "SELECT 1",
    ]);
    await expect(d1Query(async () => JSON.stringify([{ success: false }]))("SELECT 1")).rejects.toThrow(/no results/);
  });
});
