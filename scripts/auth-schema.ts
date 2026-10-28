// Better Auth's tables as the migration src/db/migrations/0007_auth.sql (D07 T02 §1). Better Auth compiles the SQL
// itself (getMigrations, for the same options as src/auth/auth.ts) against an in-memory SQLite, so the migration is
// exactly the schema the Worker expects; test/node/auth-schema.test.ts fails when they part. Regenerate, never edit.
//
//   pnpm db:auth-schema
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { schemaOptions } from "../src/auth/schema.ts";

export const AUTH_MIGRATION = join(import.meta.dirname, "../src/db/migrations/0007_auth.sql");
export const HEADER =
  "-- Better Auth's users, sessions, accounts and verifications (D07 T02 §1), compiled by Better Auth itself\n" +
  "-- (scripts/auth-schema.ts). Regenerate with `pnpm db:auth-schema`, never edit by hand.\n\n";

export async function authSchema(): Promise<string> {
  const options = { database: new DatabaseSync(":memory:"), ...schemaOptions(async () => {}) };
  const { compileMigrations } = await getMigrations(options as never);
  return `${HEADER}${(await compileMigrations()).trim()}\n`;
}

if (process.argv[1]?.endsWith("auth-schema.ts")) {
  const sql = await authSchema();
  writeFileSync(`${AUTH_MIGRATION}.tmp`, sql);
  renameSync(`${AUTH_MIGRATION}.tmp`, AUTH_MIGRATION);
  console.log(`auth-schema: wrote src/db/migrations/0007_auth.sql (${sql.length} bytes)`);
}
