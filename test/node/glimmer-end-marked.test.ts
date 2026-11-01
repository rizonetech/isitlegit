// A browser's helpers that are forked while it is being killed are ended too (found on a loaded runner: a marked process
// outlived `pkill`, coordinator-gate run 41246458316).
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { endMarked } from "../../scripts/glimmer/source-pages.ts";

const alive = (marker: string) => {
  try {
    return execFileSync("pgrep", ["-f", "--", marker]).toString().trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

describe("ending every process a marker names", () => {
  it("ends a helper forked after the first kill, which one pkill leaves alive", async () => {
    const marker = `--glimmer-reader=${randomUUID()}`;
    // A supervisor without the marker that keeps starting a marked helper for two seconds: a kill sent once misses
    // each helper forked after it.
    const supervisor = spawn(
      process.execPath,
      [
        "-e",
        `const {spawn}=require("node:child_process");const end=Date.now()+2000;` +
          `const next=()=>{if(Date.now()<end){spawn(process.execPath,["-e","setTimeout(()=>{},30000)","--",process.env.MARKER],{stdio:"ignore"}).unref();setTimeout(next,40);}else process.exit(0)};next();`,
      ],
      { stdio: "ignore", env: { ...process.env, MARKER: marker } },
    );
    try {
      await new Promise((done) => setTimeout(done, 200));
      expect(alive(marker).length).toBeGreaterThan(0);
      const left = await endMarked(marker, 8_000);
      expect(left).toEqual([]);
      expect(alive(marker)).toEqual([]);
    } finally {
      supervisor.kill("SIGKILL");
      try {
        execFileSync("pkill", ["-KILL", "-f", "--", marker]);
      } catch {
        // nothing left
      }
    }
  }, 30_000);
});
