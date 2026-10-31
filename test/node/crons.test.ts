import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FORWARD_CRON, MAIN_CRON, MONITOR_CRON, RETRY_CRON } from "../../src/schedules";

// D01 T01 §17, D01 T02 §12 and D05 T04 §2: the Worker's schedules are the four `scheduled()` in src/index.ts
// dispatches on (`MAIN_CRON`, `RETRY_CRON`, `FORWARD_CRON`, `MONITOR_CRON` in src/schedules.ts);
// a schedule added here without its dispatch would run nothing, and is logged as unknown.
describe("wrangler.jsonc's schedules", () => {
  it("are the quarter-hour work, the minute retry sweep, the five-minute forwarding check and the daily monitor", () => {
    const text = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    const crons = /"crons"\s*:\s*(\[[^\]]*\])/.exec(text)?.[1];
    expect(JSON.parse(crons ?? "null")).toEqual([
      "*/15 * * * *",
      "* * * * *",
      "5,10,20,25,35,40,50,55 * * * *",
      "15 4 * * *",
    ]);
    expect([MAIN_CRON, RETRY_CRON, FORWARD_CRON, MONITOR_CRON]).toEqual([
      "*/15 * * * *",
      "* * * * *",
      "5,10,20,25,35,40,50,55 * * * *",
      // 06:15 SAST: the impersonation monitor's daily dispatch (D05 T04 §2).
      "15 4 * * *",
    ]);
  });

  it("never runs the forwarding check twice at once: its minutes are none of the quarter-hours", () => {
    const minutes = (FORWARD_CRON.split(" ")[0] ?? "").split(",").map(Number);
    expect(minutes.filter((m) => m % 15 === 0)).toEqual([]);
    expect(minutes.every((m) => m % 5 === 0)).toBe(true);
  });
});
