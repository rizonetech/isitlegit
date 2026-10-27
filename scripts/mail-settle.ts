// Settles a send the reconciler could not (D01 T02 §5): the operator looks the send key up in SMTP2GO's activity (the
// X-IsItLegit-Send header) and records what it shows for the attempt the alert named. `sent` when SMTP2GO has the
// message; `failed` only when SMTP2GO has no record of it, which lets the caller send again. Refused unless the row is
// still `uncertain` or `pending` and still that attempt (`--claimed-at`, from the alert), so a sent message is never
// reopened and a repeated command can never fail a newer attempt. Runs against the live D1 database through Wrangler.
//
//   node scripts/mail-settle.ts <send key> sent|failed --claimed-at <the alert's claim time>
import { parseArgs } from "node:util";
import { settleStatement } from "../src/mail/settle.ts";
import { runCommand } from "./smoke.ts";

export type Runner = (command: string, args: string[]) => Promise<string>;

export async function settle(
  run: Runner,
  sendKey: string,
  status: string,
  claimedAt: string,
  now = new Date(),
): Promise<string> {
  const sql = settleStatement(sendKey, status, claimedAt, now.toISOString());
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
  return `mail-settle: ${sendKey} is now ${status}`;
}

if (import.meta.filename === process.argv[1]) {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: { "claimed-at": { type: "string" } },
  });
  const [sendKey = "", status = ""] = positionals;
  try {
    const run: Runner = (command, args) => runCommand(command, args, "", Date.now() + 120_000);
    console.log(await settle(run, sendKey, status, values["claimed-at"] ?? ""));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
