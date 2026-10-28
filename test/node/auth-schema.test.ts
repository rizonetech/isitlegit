import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { authMigrations, MIGRATIONS, missingAuthSchema, writeAuthMigration } from "../../scripts/auth-schema.ts";

// D07 T02 §1, §2: Better Auth's tables come from migrations Better Auth compiles itself, one more for each change, and
// an applied migration is never rewritten.
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const folderWith = (...names: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), "auth-schema-"));
  scratch.push(dir);
  for (const name of names) copyFileSync(join(MIGRATIONS, name), join(dir, name));
  return dir;
};
const snapshot = (dir: string) =>
  Object.fromEntries(
    readdirSync(dir).map((name) => [name, [readFileSync(join(dir, name), "utf-8"), statSync(join(dir, name)).mtimeMs]]),
  );

describe("Better Auth's migrations", () => {
  it("leave nothing missing for the Worker's options (regenerate with pnpm db:auth-schema <name>)", async () => {
    expect(authMigrations(MIGRATIONS)).toEqual([
      "0007_auth.sql",
      "0008_auth_passkey.sql",
      "0010_auth_organization.sql",
    ]);
    expect(await missingAuthSchema()).toBe("");
  });

  // Each auth migration was written from the ones before it; the newest is what the generator writes from them today.
  const committed = readdirSync(MIGRATIONS)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const newestAuth = authMigrations(MIGRATIONS).at(-1) as string;
  const before = committed.filter((name) => name < newestAuth);

  it("writes only what is missing as the next migration, the newest committed one byte for byte", async () => {
    const dir = folderWith(...before);
    const earlier = snapshot(dir);
    expect(await writeAuthMigration(newestAuth.replace(/^\d{4}_auth_|\.sql$/g, ""), dir)).toBe(newestAuth);
    const written = readFileSync(join(dir, newestAuth), "utf-8");
    expect(written).toBe(readFileSync(join(MIGRATIONS, newestAuth), "utf-8"));
    expect(written).not.toMatch(/create table "(user|session|account|verification|passkey)"/);
    // The earlier migrations are untouched, all apply in order, and nothing is left missing.
    for (const [name, [bytes]] of Object.entries(earlier))
      expect(readFileSync(join(dir, name), "utf-8"), name).toBe(bytes);
    const database = new DatabaseSync(":memory:");
    for (const name of authMigrations(dir)) database.exec(readFileSync(join(dir, name), "utf-8"));
    expect(await missingAuthSchema(dir)).toBe("");
  });

  it("writes and rewrites nothing when nothing is missing", async () => {
    const dir = folderWith(...committed);
    const earlier = snapshot(dir);
    expect(await writeAuthMigration("again", dir)).toBeNull();
    expect(snapshot(dir)).toEqual(earlier);
  });

  it("numbers after the last migration of any kind, and refuses an unsafe name", async () => {
    const dir = folderWith("0007_auth.sql", "0009_passkey_credential_unique.sql");
    expect(await writeAuthMigration("passkey", dir)).toBe("0010_auth_passkey.sql");
    await expect(writeAuthMigration("../escape", folderWith("0007_auth.sql"))).rejects.toThrow(/migration name/);
  });
});
