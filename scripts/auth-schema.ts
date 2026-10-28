// Better Auth's tables as migrations (D07 T02 §1, §2). Better Auth compiles the SQL itself (getMigrations, for the same
// options as src/auth/auth.ts) against an in-memory SQLite holding the auth migrations already committed, so a new
// migration is exactly what the Worker still needs and an applied one is never rewritten. It writes nothing when
// nothing is missing; test/node/auth-schema.test.ts fails while anything is. Regenerate, never edit.
//
//   pnpm db:auth-schema <name>     writes src/db/migrations/<next number>_auth_<name>.sql
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { schemaOptions } from "../src/auth/schema.ts";

export const MIGRATIONS = join(import.meta.dirname, "../src/db/migrations");
// The schema does not depend on the host; the production one is passed for the passkey plugin's options.
const APP_URL = "https://app.isitlegit.co.za";
const AUTH_FILE = /^\d{4}_auth(_[a-z0-9_]+)?\.sql$/;
const ANY_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

export const authMigrations = (dir: string) =>
  readdirSync(dir)
    .filter((name) => AUTH_FILE.test(name))
    .sort();

// The SQL Better Auth still needs after the committed auth migrations, or "" when nothing is missing.
export async function missingAuthSchema(dir = MIGRATIONS): Promise<string> {
  const database = new DatabaseSync(":memory:");
  for (const name of authMigrations(dir)) database.exec(readFileSync(join(dir, name), "utf-8"));
  const options = { database, ...schemaOptions(async () => {}, APP_URL) };
  const { toBeCreated, toBeAdded, compileMigrations } = await getMigrations(options as never);
  if (toBeCreated.length === 0 && toBeAdded.length === 0) return "";
  return (await compileMigrations()).trim();
}

// Writes the missing schema as the next numbered migration and returns its file name, or null when nothing is missing.
export async function writeAuthMigration(name: string, dir = MIGRATIONS): Promise<string | null> {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`migration name must be lower-case letters, digits and _: ${name}`);
  const sql = await missingAuthSchema(dir);
  if (!sql) return null;
  const last =
    readdirSync(dir)
      .filter((file) => ANY_FILE.test(file))
      .sort()
      .at(-1) ?? "0000";
  const file = `${String(Number(last.slice(0, 4)) + 1).padStart(4, "0")}_auth_${name}.sql`;
  const header =
    `-- Better Auth's schema still missing after the earlier auth migrations (${name}), compiled by Better Auth\n` +
    "-- itself (scripts/auth-schema.ts). Never edit by hand; a later change is a new migration.\n\n";
  const path = join(dir, file);
  writeFileSync(`${path}.tmp`, `${header}${sql}\n`);
  renameSync(`${path}.tmp`, path);
  return file;
}

if (process.argv[1]?.endsWith("auth-schema.ts")) {
  const name = process.argv[2];
  if (!name) {
    console.error("usage: pnpm db:auth-schema <name>");
    process.exit(2);
  }
  const file = await writeAuthMigration(name);
  console.log(file ? `auth-schema: wrote src/db/migrations/${file}` : "auth-schema: nothing missing, nothing written");
}
