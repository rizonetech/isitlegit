import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("serializes all results sections under one kernel lock and preserves concurrent publications", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-results-lock-"));
  const holder = spawn(
    "flock",
    [join(dir, ".RESULTS.md.lock"), process.execPath, "-e", 'process.stdout.write("ready");process.stdin.resume();'],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const held = new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
  const released = new Promise<void>((resolve) => holder.once("close", () => resolve()));
  const module = pathToFileURL(join(import.meta.dirname, "../../eval/results-file.ts")).href;
  const writers: Promise<number | null>[] = [];
  try {
    await held;
    let finished = false;
    for (let i = 0; i < 6; i++) {
      const script = `import {writeResultsSection} from ${JSON.stringify(module)}; writeResultsSection(${JSON.stringify(dir)}, "## Section ${i}", "body ${i}");`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" });
      writers.push(
        new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) => {
            finished = true;
            resolve(code);
          });
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(finished).toBe(false);
    holder.stdin.end();
    await released;
    expect(await Promise.all(writers)).toEqual([0, 0, 0, 0, 0, 0]);
    const result = readFileSync(join(dir, "RESULTS.md"), "utf8");
    for (let i = 0; i < 6; i++) expect(result).toContain(`## Section ${i}\n\nbody ${i}`);
  } finally {
    holder.stdin.end();
    await released;
    await Promise.all(writers);
    rmSync(dir, { recursive: true, force: true });
  }
});
