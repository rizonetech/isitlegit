// The RESULTS.md merge contract (D08 T02 sections 3, 5 and 8; coordinator note 2026-11-02): each writer
// merges its own section into the file, keyed by its heading, and never replaces another section's rows.
// A write is temp-then-replace, so a crash never half-writes the file reviewers read.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

export function writeResultsSection(dir: string, heading: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "RESULTS.md");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, mergeResultsSection(existing, heading, body));
  renameSync(tmp, path);
  return path;
}
