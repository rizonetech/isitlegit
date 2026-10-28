import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUTH_MIGRATION, authSchema } from "../../scripts/auth-schema.ts";

// D07 T02 §1: the committed migration is what Better Auth itself compiles for the Worker's options.
describe("Better Auth's migration", () => {
  it("matches what Better Auth compiles (regenerate with pnpm db:auth-schema)", async () => {
    expect(readFileSync(AUTH_MIGRATION, "utf-8")).toBe(await authSchema());
  });
});
