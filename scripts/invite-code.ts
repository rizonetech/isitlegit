// Makes an invite code for signup during the event (D07 T02 §4; design spec section 11). The code is random, printed
// once, and stored only as its SHA-256 in `invite_codes`, through `wrangler d1 execute` (the local database unless
// --remote): the code itself is in no row, no SQL and no argument.
//
//   node scripts/invite-code.ts --id <existing-id> --set-max-uses 100 [--remote]
//   node scripts/invite-code.ts --label "Pilot: Rizonetech staff" [--max-uses 10] [--days 14] [--remote]
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";

// Unambiguous letters and digits (no 0/O, 1/I/L), in four groups of four: easy to read out and type.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newCode(bytes = randomBytes(16)): string {
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

export const hashCode = (code: string) => createHash("sha256").update(code.trim()).digest("hex");

export type InviteCodeOptions = { label: string; maxUses: number; days: number; remote: boolean };

export function parseArgs(argv: string[]): InviteCodeOptions {
  const value = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const label = value("--label") ?? "";
  // A label goes into SQL, so it is held to plain words.
  if (!/^[A-Za-z0-9 _.,:()-]{1,200}$/.test(label))
    throw new Error("--label is required: 1 to 200 letters, digits, spaces and _.,:()-");
  const maxUses = Number(value("--max-uses") ?? 1);
  const days = Number(value("--days") ?? 14);
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10_000) throw new Error("--max-uses must be 1 to 10000");
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("--days must be 1 to 365");
  return { label, maxUses, days, remote: argv.includes("--remote") };
}

export function insertStatement(hash: string, options: InviteCodeOptions, now = new Date(), id: string = randomUUID()) {
  const expires = new Date(now.getTime() + options.days * 86_400_000).toISOString();
  return `INSERT INTO invite_codes (id, code_hash, label, max_uses, uses, expires_at, created_at) VALUES ('${id}', '${hash}', '${options.label}', ${options.maxUses}, 0, '${expires}', '${now.toISOString()}')`;
}

export type Exec = (file: string, args: string[]) => void;
const wrangler: Exec = (file, args) => {
  execFileSync(file, args, { stdio: ["ignore", "ignore", "inherit"] });
};

// Stores the code's hash, then returns the code for the one print.
export function makeInviteCode(options: InviteCodeOptions, exec: Exec = wrangler, code = newCode()) {
  const sql = insertStatement(hashCode(code), options);
  exec("pnpm", ["exec", "wrangler", "d1", "execute", "DB", options.remote ? "--remote" : "--local", "--command", sql]);
  return code;
}

// Existing invitation management: changes only the total use limit, never creates or rotates a code.
export type InviteQuery = (sql: string) => Record<string, unknown>[];
export function updateInviteLimit(id: string, maxUses: number, query: InviteQuery) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("invalid invite id");
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10_000) throw new Error("invalid use limit");
  const select = `SELECT * FROM invite_codes WHERE id = '${id}'`;
  const rows = query(select);
  if (rows.length !== 1 || !rows[0]) throw new Error("expected exactly one existing invitation");
  const before = rows[0];
  if (!Number.isInteger(before.uses) || !Number.isInteger(before.max_uses)) throw new Error("invalid stored usage");
  if (maxUses < (before.uses as number)) throw new Error("limit is below current usage");
  const changed = query(
    `UPDATE invite_codes SET max_uses = ${maxUses} WHERE id = '${id}' AND uses = ${before.uses} AND max_uses = ${before.max_uses} RETURNING *`,
  );
  if (changed.length !== 1 || !changed[0])
    throw new Error("invitation changed concurrently; read back before retrying");
  const after = changed[0];
  for (const key of Object.keys(before)) {
    if (after[key] !== (key === "max_uses" ? maxUses : before[key]))
      throw new Error("invitation readback differs outside the requested limit");
  }
  const current = query(select);
  if (current.length !== 1 || !current[0] || current[0].max_uses !== maxUses)
    throw new Error("invitation limit readback failed");
  for (const key of Object.keys(before).filter((key) => key !== "uses" && key !== "max_uses")) {
    if (current[0][key] !== before[key]) throw new Error("invitation metadata readback changed");
  }
  const safe = (row: Record<string, unknown>) => ({
    id: row.id,
    label: row.label,
    max_uses: row.max_uses,
    uses: row.uses,
    expires_at: row.expires_at,
  });
  return { before: safe(before), after: safe(current[0]) };
}

export function queryInvites(remote: boolean): InviteQuery {
  return (sql) => {
    let output: string;
    try {
      output = execFileSync(
        "pnpm",
        ["exec", "wrangler", "d1", "execute", "DB", remote ? "--remote" : "--local", "--json", "--command", sql],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      throw new Error("invitation database command failed; no credential or row data logged");
    }
    const data = JSON.parse(output) as { success?: boolean; results?: Record<string, unknown>[] }[];
    if (!Array.isArray(data) || data.length !== 1 || data[0]?.success !== true || !Array.isArray(data[0].results))
      throw new Error("unexpected invitation database response");
    return data[0].results;
  };
}

if (process.argv[1]?.endsWith("invite-code.ts")) {
  const args = process.argv.slice(2);
  if (args.includes("--set-max-uses")) {
    const id = args[args.indexOf("--id") + 1] ?? "";
    const max = Number(args[args.indexOf("--set-max-uses") + 1]);
    if (!args.includes("--id") || args.includes("--label") || args.includes("--days"))
      throw new Error("limit update requires --id and cannot change creation settings");
    console.log(JSON.stringify(updateInviteLimit(id, max, queryInvites(args.includes("--remote")))));
  } else {
    const options = parseArgs(args);
    const code = makeInviteCode(options);
    console.log(
      `invite code (${options.label}, ${options.maxUses} use${options.maxUses === 1 ? "" : "s"}, ${options.days} days, ${options.remote ? "remote" : "local"}): ${code}`,
    );
    console.log("It is shown once and stored only as its hash; keep it somewhere safe or make another.");
  }
}
