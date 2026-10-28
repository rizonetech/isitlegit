// Makes an invite code for signup during the event (D07 T02 §4; design spec section 11). The code is random, printed
// once, and stored only as its SHA-256 in `invite_codes`, through `wrangler d1 execute` (the local database unless
// --remote): the code itself is in no row, no SQL and no argument.
//
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

if (process.argv[1]?.endsWith("invite-code.ts")) {
  const options = parseArgs(process.argv.slice(2));
  const code = makeInviteCode(options);
  console.log(
    `invite code (${options.label}, ${options.maxUses} use${options.maxUses === 1 ? "" : "s"}, ${options.days} days, ${options.remote ? "remote" : "local"}): ${code}`,
  );
  console.log("It is shown once and stored only as its hash; keep it somewhere safe or make another.");
}
