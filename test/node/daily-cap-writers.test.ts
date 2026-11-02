import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Who can write the operator's daily-cases override (D07 T08 §15): its statements live in src/auth/plan-sql.ts,
// scripts/org-plan.ts (the operator's command, which also reads it back) calls them, and the operator's own admin
// console page does too (D07 T08 §8's correction: the admin console is built on the override; it sits behind
// requireAccess in src/index.ts, so only the operator's Access session reaches it). The organisation detail page
// (D07 T08 §5) is the same operator surface behind the same gate, so it is named here too (console lane,
// 2026-11-02: the §5 page reads the stored override and writes it through the shared statements, nothing else).
// No member route, page or hook in src/ names the column: a member has no way to set it because there is no code
// path from a member request to it.
const ROOT = join(import.meta.dirname, "../..");
const WRITERS = ["setDailyCapOverrideStatement", "clearDailyCapOverrideStatement"];
const ALLOWED_CALLERS = new Set([
  "src/auth/plan-sql.ts",
  "scripts/org-plan.ts",
  "src/web/pages/admin.tsx",
  "src/web/pages/admin-org.tsx",
]);
const ALLOWED_COLUMN = new Set([
  "src/auth/plan-sql.ts",
  "scripts/org-plan.ts",
  "src/web/pages/admin.tsx",
  "src/web/pages/admin-org.tsx",
]);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "migrations" || entry.name === "node_modules" ? [] : files(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

// The files that name a writer or the column when they should not, from (path, text) pairs.
function strays(sources: readonly (readonly [string, string])[]): string[] {
  const found: string[] = [];
  for (const [path, text] of sources) {
    if (WRITERS.some((w) => text.includes(w)) && !ALLOWED_CALLERS.has(path)) found.push(`${path}: calls a writer`);
    if (text.includes("daily_cases_override") && !ALLOWED_COLUMN.has(path)) found.push(`${path}: names the column`);
  }
  return found;
}

describe("who can write the daily-cases override", () => {
  it("is written only by the shared statements and the operator's command, and no route names the column", () => {
    const sources = [...files(join(ROOT, "src")), ...files(join(ROOT, "scripts"))].map(
      (path) => [relative(ROOT, path).replaceAll("\\", "/"), readFileSync(path, "utf-8")] as const,
    );
    expect(strays(sources)).toEqual([]);
    // The scan sees the allowed callers at all, so an empty result is not an empty scan.
    expect(sources.some(([path, text]) => path === "scripts/org-plan.ts" && text.includes(WRITERS[0] as string))).toBe(
      true,
    );
  });

  it("fails for a planted route that imports the setter or names the column", () => {
    expect(
      strays([["src/web/pages/team.tsx", `import { setDailyCapOverrideStatement } from "../../auth/plan-sql";`]]),
    ).toEqual(["src/web/pages/team.tsx: calls a writer"]);
    expect(strays([["src/auth/domains.ts", "UPDATE org_limits SET daily_cases_override = 5"]])).toEqual([
      "src/auth/domains.ts: names the column",
    ]);
  });
});
