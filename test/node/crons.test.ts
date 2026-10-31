import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// D01 T01 §17: the Worker's schedules are the two `scheduled()` in src/index.ts dispatches on (MAIN_CRON, RETRY_CRON);
// a schedule added here without its dispatch would run nothing, and is logged as unknown.
describe("wrangler.jsonc's schedules", () => {
  it("are the quarter-hour work and the minute retry sweep", () => {
    const text = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    const crons = /"crons"\s*:\s*(\[[^\]]*\])/.exec(text)?.[1];
    expect(JSON.parse(crons ?? "null")).toEqual(["*/15 * * * *", "* * * * *"]);
    const index = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
    expect(index).toContain('export const MAIN_CRON = "*/15 * * * *";');
    expect(index).toContain('export const RETRY_CRON = "* * * * *";');
  });
});
