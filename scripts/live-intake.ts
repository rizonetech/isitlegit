// The live intake smoke (D01 T01 §9): given the Message-ID of one forward to check@ (read from the forwarding
// mailbox's Sent Items), find that forward's case in the live D1, wait for its analysis to finish and its reply to be
// sent, and exit non-zero naming the cause otherwise. Only that forward's case can satisfy it, so an earlier run's case
// never stands in for this one.
//
//   node scripts/live-intake.ts --message-id '<id@host>' [--wait 300]
//
// Exit 0 with the case id; 1 when the case never appeared, its analysis ended partial, or its reply failed, was
// refused or was still unsent at the deadline; 2 for a bad argument.

import { parseArgs } from "node:util";
import { installSignalCleanup, type Runner, runCommand } from "./smoke.ts";

// A Message-ID as a mailbox reports it: angle brackets around an id with one "@", and nothing that could leave the
// quoted SQL literal it is placed in (wrangler's `d1 execute --command` takes no bound parameters).
const MESSAGE_ID = /^<[A-Za-z0-9!#$%&*+\-/=?^_`{|}~.]+@[A-Za-z0-9!#$%&*+\-/=?^_`{|}~.[\]]+>$/;

export type Row = Record<string, unknown>;
// `timeoutMs` is what is left of the run's budget: a read never runs past the deadline.
export type Query = (sql: string, timeoutMs?: number) => Promise<Row[]>;
export type Result = { ok: true; caseId: string; seconds: number } | { ok: false; reason: string };

export function validMessageId(value: string): boolean {
  return value.length <= 998 && MESSAGE_ID.test(value);
}

// One look at the live state: the case for that Message-ID and its reply's send row.
// `left` gives what is left of the run's budget, asked again before each read, so the second read never gets the
// first's time back (round 1).
export async function look(query: Query, messageId: string, left?: () => number) {
  const cases = await query(`SELECT id, status FROM cases WHERE message_id = '${messageId}'`, left?.());
  if (cases.length > 1) return { kind: "fail" as const, reason: `${cases.length} cases carry that Message-ID` };
  const found = cases[0];
  if (!found) return { kind: "wait" as const, why: "no case for that Message-ID yet" };
  const caseId = String(found.id);
  if (found.status === "partial")
    return { kind: "fail" as const, reason: `case ${caseId}: the analysis ended partial` };
  if (found.status !== "done") return { kind: "wait" as const, why: `case ${caseId} is ${String(found.status)}` };
  const sends = await query(`SELECT status, error FROM mail_sends WHERE send_key = 'reply:${caseId}'`, left?.());
  const reply = sends[0];
  if (!reply) return { kind: "wait" as const, why: `case ${caseId} is done; no reply row yet` };
  if (reply.status === "sent") return { kind: "done" as const, caseId };
  if (reply.status === "failed" || reply.status === "refused")
    return { kind: "fail" as const, reason: `case ${caseId}: the reply was ${reply.status} (${String(reply.error)})` };
  return { kind: "wait" as const, why: `case ${caseId} is done; its reply is ${String(reply.status)}` };
}

export async function waitForCase(options: {
  messageId: string;
  waitSeconds: number;
  query: Query;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  everyMs?: number;
}): Promise<Result> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? (() => {});
  const started = now();
  const deadline = started + options.waitSeconds * 1000;
  let last = "nothing read";
  for (;;) {
    // A failed read (wrangler or the network) is retried until the deadline, and named if it is the last thing seen.
    let seen: Awaited<ReturnType<typeof look>>;
    try {
      seen = await look(options.query, options.messageId, () => Math.max(1, deadline - now()));
    } catch (error) {
      seen = { kind: "wait", why: `the live D1 could not be read (${(error as Error).message.slice(0, 200)})` };
    }
    // A success seen only after the deadline is not one: the run promised an answer within it.
    if (seen.kind === "done" && now() > deadline)
      return { ok: false, reason: `timed out after ${options.waitSeconds} s: case ${seen.caseId} finished late` };
    if (seen.kind === "done") return { ok: true, caseId: seen.caseId, seconds: Math.round((now() - started) / 1000) };
    if (seen.kind === "fail") return { ok: false, reason: seen.reason };
    last = seen.why;
    if (now() >= deadline) return { ok: false, reason: `timed out after ${options.waitSeconds} s: ${last}` };
    log(`live-intake: ${last}; ${Math.max(0, Math.round((deadline - now()) / 1000))} s left`);
    await sleep(Math.min(options.everyMs ?? 10_000, Math.max(0, deadline - now())));
  }
}

// The live D1 through the local Wrangler login (read only: SELECT statements).
export const d1Query =
  (run: Runner = runCommand, limitMs = 60_000): Query =>
  async (sql, timeoutMs = limitMs) => {
    const out = await run(
      "pnpm",
      ["exec", "wrangler", "d1", "execute", "isitlegit", "--remote", "--json", "--command", sql],
      "",
      Date.now() + Math.min(limitMs, timeoutMs),
    );
    const parsed = JSON.parse(out) as { results?: Row[]; success?: boolean }[];
    const first = parsed[0];
    if (!first?.success || !Array.isArray(first.results)) throw new Error("wrangler d1 execute gave no results");
    return first.results;
  };

export function parseLiveIntakeArgs(argv: string[]): { messageId: string; waitSeconds: number } {
  const { values } = parseArgs({
    args: argv,
    options: { "message-id": { type: "string" }, wait: { type: "string", default: "300" } },
    strict: true,
  });
  const messageId = values["message-id"] ?? "";
  if (!validMessageId(messageId)) throw new Error("--message-id needs one Message-ID in angle brackets");
  const waitSeconds = Number(values.wait);
  if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 3600)
    throw new Error("--wait needs whole seconds from 1 to 3600");
  return { messageId, waitSeconds };
}

if (import.meta.filename === process.argv[1]) {
  let args: ReturnType<typeof parseLiveIntakeArgs>;
  try {
    args = parseLiveIntakeArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`live-intake: ${(error as Error).message}`);
    process.exit(2);
  }
  installSignalCleanup("live-intake");
  try {
    const result = await waitForCase({ ...args, query: d1Query(), log: (line) => console.log(line) });
    if (result.ok) {
      console.log(
        `live-intake: case ${result.caseId} done and its reply sent, ${result.seconds} s after the first look`,
      );
      process.exit(0);
    }
    console.error(`live-intake: ${result.reason}`);
    process.exit(1);
  } catch (error) {
    console.error(`live-intake: ${(error as Error).message}`);
    process.exit(1);
  }
}
