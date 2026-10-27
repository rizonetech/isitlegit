// Settles a send the reconciler could not (D01 T02 §5): the operator looks the send key up in SMTP2GO's activity (the
// X-IsItLegit-Send header) and records what it shows. `sent` when SMTP2GO has the message; `failed` only when SMTP2GO
// has no record of it, which lets the caller send again. Refused unless the row is still `uncertain` or `pending`, so
// a sent message is never reopened. Runs against the live D1 database through Wrangler.
//
//   node scripts/mail-settle.ts <send key> sent|failed
import { parseArgs } from "node:util";
import { runCommand } from "./smoke.ts";

// Send keys are what sendMail's callers make (`reply:<ulid>`, `unresolved:reply:<ulid>`): nothing that needs quoting.
const SEND_KEY = /^[A-Za-z0-9:._-]{1,200}$/;
export type Runner = (command: string, args: string[]) => Promise<string>;

export function settleStatement(sendKey: string, status: string, at: string): string {
  if (!SEND_KEY.test(sendKey)) throw new Error(`mail-settle: "${sendKey}" is not a send key`);
  if (status !== "sent" && status !== "failed") throw new Error("mail-settle: the outcome is sent or failed");
  return `UPDATE mail_sends SET status = '${status}', error = 'settled by the operator', updated_at = '${at}' WHERE send_key = '${sendKey}' AND status IN ('uncertain', 'pending')`;
}

export async function settle(run: Runner, sendKey: string, status: string, now = new Date()): Promise<string> {
  const sql = settleStatement(sendKey, status, now.toISOString());
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
      `mail-settle: ${sendKey} was not changed: it does not exist, or it is no longer uncertain or pending`,
    );
  return `mail-settle: ${sendKey} is now ${status}`;
}

if (import.meta.filename === process.argv[1]) {
  const { positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, strict: true });
  const [sendKey = "", status = ""] = positionals;
  try {
    console.log(await settle((command, args) => runCommand(command, args, "", Date.now() + 120_000), sendKey, status));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
