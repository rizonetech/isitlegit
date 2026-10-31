// The CI file-progress reporter (scripts/lib/vitest-file-reporter.ts): a stalled shard must name the file it stopped
// in, or say it stopped between files.
import { describe, expect, it } from "vitest";
import FileProgressReporter, { type Module } from "../../scripts/lib/vitest-file-reporter.ts";

const mod = (path: string, state = "passed"): Module => ({
  moduleId: `/repo/${path}`,
  project: { name: "worker" },
  state: () => state,
});

function reporter() {
  const lines: string[] = [];
  let clock = 0;
  const r = new FileProgressReporter({ write: (line) => lines.push(line), now: () => clock, cwd: "/repo" });
  return { r, lines, tick: (ms: number) => (clock += ms) };
}

describe("FileProgressReporter", () => {
  it("prints each file's start and end with its state and time", () => {
    const { r, lines, tick } = reporter();
    r.onTestModuleStart(mod("test/auth/domains.test.ts"));
    tick(15_000);
    r.onTestModuleEnd(mod("test/auth/domains.test.ts", "failed"));
    expect(lines).toEqual([
      "[file start] worker test/auth/domains.test.ts",
      "[file end] worker test/auth/domains.test.ts failed 15 s",
    ]);
  });

  it("names the files still running on a heartbeat, oldest first", () => {
    const { r, lines, tick } = reporter();
    r.onTestModuleStart(mod("test/intake/email.test.ts"));
    tick(30_000);
    r.onTestModuleStart(mod("test/web/upload-page.test.ts"));
    tick(90_000);
    r.heartbeat();
    expect(lines.at(-1)).toBe(
      "[files running] 2: worker test/intake/email.test.ts (120 s), worker test/web/upload-page.test.ts (90 s)",
    );
  });

  it("says a stall is between files when nothing is running", () => {
    const { r, lines } = reporter();
    r.onTestModuleStart(mod("test/auth/domains.test.ts"));
    r.onTestModuleEnd(mod("test/auth/domains.test.ts"));
    r.heartbeat();
    expect(lines.at(-1)).toBe("[files running] 0 (between files)");
  });

  it("lists unfinished files when the run is stopped, and nothing when all ended", () => {
    const { r, lines, tick } = reporter();
    r.onTestModuleStart(mod("test/web/upload-page.test.ts"));
    tick(5_000);
    r.unfinished();
    expect(lines.at(-1)).toBe("[files unfinished] worker test/web/upload-page.test.ts (5 s)");
    r.onTestModuleEnd(mod("test/web/upload-page.test.ts"));
    const before = lines.length;
    r.unfinished();
    expect(lines.length).toBe(before);
  });

  it("stops its heartbeat and exit listener when the run ends", () => {
    const { r } = reporter();
    const listeners = process.listenerCount("exit");
    r.onTestRunStart();
    expect(process.listenerCount("exit")).toBe(listeners + 1);
    r.onTestRunEnd();
    expect(process.listenerCount("exit")).toBe(listeners);
  });
});
