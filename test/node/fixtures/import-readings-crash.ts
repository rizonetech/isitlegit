// D08 T01 §6: an import killed between its two replacements, as a power cut or a kill would leave it.
// Usage: node import-readings-crash.ts <root>; the process dies on the second replacement's rename.
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importReadings } from "../../../eval/import-readings.ts";

const root = process.argv[2] as string;
let renames = 0;
importReadings(root, "docs/reviews/x.md", join(root, "set"), join(root, "pending"), {
  write: (file, text) => writeFileSync(file, text),
  rename: (from, to) => {
    renames++;
    // Renames 1 and 2 keep the originals; 3 replaces annotations.json; 4 would replace pending.json.
    if (renames === 4) process.kill(process.pid, "SIGKILL");
    renameSync(from, to);
  },
  remove: (file) => rmSync(file, { force: true }),
});
