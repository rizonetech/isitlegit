import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAIN_CRON, RETRY_CRON } from "../../src/schedules";

// D01 T01 §17: the Worker's schedules are the two `scheduled()` in src/index.ts dispatches on (`MAIN_CRON`, `RETRY_CRON` in src/schedules.ts);
// a schedule added here without its dispatch would run nothing, and is logged as unknown.
describe("wrangler.jsonc's schedules", () => {
  it("are the quarter-hour work and the minute retry sweep", () => {
    const text = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    const crons = /"crons"\s*:\s*(\[[^\]]*\])/.exec(text)?.[1];
    expect(JSON.parse(crons ?? "null")).toEqual(["*/15 * * * *", "* * * * *"]);
    expect([MAIN_CRON, RETRY_CRON]).toEqual(["*/15 * * * *", "* * * * *"]);
  });
});
