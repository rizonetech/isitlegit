// The RESULTS.md merge contract (D08 T02 sections 3, 5 and 8; coordinator note 2026-11-02): each writer
// merges its own section into the file, keyed by its heading, and never replaces another section's rows.
// A write is temp-then-replace, so a crash never half-writes the file reviewers read.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const ABLATION_HEADING = "## Ablation (D08 T02 section 3)";
export const COMPONENTS_HEADING = "## Component measurements (D08 T02 section 8)";
export const WORST_MISSES_HEADING = "## Worst misses (D08 T02 section 5)";

export function mergeResultsSection(existing: string, heading: string, body: string): string {
  const section = `${heading}\n\n${body.trim()}\n`;
  if (!existing.trim()) return `# Eval results\n\n${section}`;
  const at = existing.indexOf(heading);
  if (at < 0) return `${existing.trimEnd()}\n\n${section}`;
  const after = existing.slice(at + heading.length);
  const next = after.indexOf("\n## ");
  const tail = next < 0 ? "" : after.slice(next + 1);
  return `${existing.slice(0, at)}${section}${tail ? `\n${tail}` : ""}`;
}

// Every caller uses the same kernel lock, including component and ablation publications.
// The child owns the lock through merge, atomic replacement and read-back; process death releases it.
export function writeResultsSection(dir: string, heading: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const result = spawnSync(
    "flock",
    ["-w", "30", join(dir, ".RESULTS.md.lock"), process.execPath, import.meta.filename],
    {
      input: JSON.stringify({ dir, heading, body }),
      encoding: "utf8",
      timeout: 45_000,
      maxBuffer: 1_000_000,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(`results publication refused: ${result.error?.message ?? result.stderr.trim() ?? result.status}`);
  return join(dir, "RESULTS.md");
}
function publish(dir: string, heading: string, body: string): void {
  const path = join(dir, "RESULTS.md");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const expected = mergeResultsSection(existing, heading, body);
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(tmp, "wx");
    try {
      writeFileSync(fd, expected);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (readFileSync(tmp, "utf8") !== expected) throw new Error("temporary results read-back mismatch");
    renameSync(tmp, path);
    const directory = openSync(dir, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    if (readFileSync(path, "utf8") !== expected) throw new Error("published results read-back mismatch");
  } finally {
    rmSync(tmp, { force: true });
  }
}
if (process.argv[1] === import.meta.filename) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    if (!input || typeof input.dir !== "string" || typeof input.heading !== "string" || typeof input.body !== "string")
      throw new Error("invalid results publication input");
    publish(input.dir, input.heading, input.body);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
