// Settles a send the reconciler could not (D01 T02 §5): the operator looks the send key up in SMTP2GO's activity (the
// X-IsItLegit-Send header) and records what it shows for the attempt the alert named. `sent` when SMTP2GO has the
// message; `failed` only when SMTP2GO has no record of it, which lets the caller send again. Refused unless the row is
// still `uncertain` or `pending` and still that attempt (`--claimed-at`, from the alert), so a sent message is never
// reopened and a repeated command can never fail a newer attempt. Runs against the live D1 database through Wrangler.
//
//   node scripts/mail-settle.ts <send key> sent|failed --claimed-at <the alert's claim time> [--resend]
//   node scripts/mail-settle.ts <send key> status|cancel|requeue
//
// `--resend` (with failed, for a reply only, D01 T02 §8) asks the Worker's cron to send the reply again from its case,
// within 15 minutes; `status` reads where it stands, `cancel` stops it before the cron claims it, `requeue` asks again
// after an exhausted or cancelled one.
import { parseArgs } from "node:util";
import { cancelStatement, requeueStatement, settleStatement, statusStatement } from "../src/mail/settle.ts";
import { runCommand } from "./smoke.ts";

export type Runner = (command: string, args: string[]) => Promise<string>;

export async function settle(
  run: Runner,
  sendKey: string,
  status: string,
  claimedAt: string,
  now = new Date(),
  resend = false,
): Promise<string> {
  const sql = settleStatement(sendKey, status, claimedAt, now.toISOString(), resend);
  const out = await run("pnpm", [
    "exec",
    "wrangler",
    "d1",
    "execute",
    "isitlegit",
    "--remote",
    "--json",
    "--command",
    sql,
  ]);
  const changes = (JSON.parse(out) as { meta?: { changes?: number } }[])[0]?.meta?.changes;
  if (changes !== 1)
    throw new Error(
      `mail-settle: ${sendKey} was not changed: it does not exist, it is no longer uncertain or pending, or a newer attempt has claimed it since ${claimedAt}`,
    );
  return `mail-settle: ${sendKey} is now ${status}${resend ? "; the reply goes again within 15 minutes" : ""}`;
}

const wrangler = (sql: string) => [
  "exec",
  "wrangler",
  "d1",
  "execute",
  "isitlegit",
  "--remote",
  "--json",
  "--command",
  sql,
];
type Answer = { results?: Record<string, unknown>[]; meta?: { changes?: number } };

// The operator's read and steering of a resend (D01 T02 §8).
export async function steer(run: Runner, sendKey: string, action: string, now = new Date()): Promise<string> {
  if (action === "status") {
    const row = ((JSON.parse(await run("pnpm", wrangler(statusStatement(sendKey)))) as Answer[])[0]?.results ?? [])[0];
    if (!row) throw new Error(`mail-settle: no send ${sendKey}`);
    return `mail-settle: ${sendKey}: ${row.status} (claimed ${row.claimed_at}); resend ${row.resend_state ?? "none"}${row.resend_state ? `, ${row.resend_runs} run(s), at ${row.resend_at}` : ""}`;
  }
  const sql =
    action === "cancel"
      ? cancelStatement(sendKey, now.toISOString())
      : action === "requeue"
        ? requeueStatement(sendKey, now.toISOString())
        : null;
  if (!sql) throw new Error("mail-settle: the action is sent, failed, status, cancel or requeue");
  const changes = (JSON.parse(await run("pnpm", wrangler(sql))) as Answer[])[0]?.meta?.changes;
  if (changes !== 1)
    throw new Error(
      action === "cancel"
        ? `mail-settle: ${sendKey} was not cancelled: it has no requested resend (the cron may have claimed it; read its status)`
        : `mail-settle: ${sendKey} was not requeued: it has no exhausted or cancelled resend`,
    );
  return action === "cancel"
    ? `mail-settle: ${sendKey}: resend cancelled`
    : `mail-settle: ${sendKey}: resend requested again`;
}

if (import.meta.filename === process.argv[1]) {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: { "claimed-at": { type: "string" }, resend: { type: "boolean", default: false } },
  });
  const [sendKey = "", status = ""] = positionals;
  try {
    const run: Runner = (command, args) => runCommand(command, args, "", Date.now() + 120_000);
    console.log(
      ["status", "cancel", "requeue"].includes(status)
        ? await steer(run, sendKey, status)
        : await settle(run, sendKey, status, values["claimed-at"] ?? "", new Date(), values.resend ?? false),
    );
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
