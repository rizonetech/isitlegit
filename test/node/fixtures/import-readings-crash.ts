// D08 T01 §6: an import killed between its two replacements, as a power cut or a kill would leave it.
// Usage: node import-readings-crash.ts <root> [replace|cleanup]: the process dies on the second replacement's rename
// (replace, the default), or after the commit, on removing the first kept original (cleanup).
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importReadings } from "../../../eval/import-readings.ts";

const root = process.argv[2] as string;
const at = process.argv[3] ?? "replace";
let renames = 0;
importReadings(root, "docs/reviews/x.md", join(root, "set"), join(root, "pending"), {
  write: (file, text) => writeFileSync(file, text),
  rename: (from, to) => {
    renames++;
    // Rename 1 writes the journal, 2 and 3 keep the originals, 4 replaces annotations.json, 5 would replace
    // pending.json.
    if (at === "replace" && renames === 5) process.kill(process.pid, "SIGKILL");
    renameSync(from, to);
  },
  remove: (file) => {
    if (at === "cleanup" && file.endsWith(".before-import")) process.kill(process.pid, "SIGKILL");
    rmSync(file, { force: true });
  },
});
