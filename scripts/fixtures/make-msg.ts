// Writes the synthetic Outlook .msg fixtures and their .eml twin (D01 T01 §6) from scripts/fixtures/msg-builder.ts.
//
//   node scripts/fixtures/make-msg.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtures } from "./msg-builder.ts";

const OUT = join(import.meta.dirname, "../../test/fixtures/msg");
for (const [name, bytes] of Object.entries(fixtures())) writeFileSync(join(OUT, name), bytes);
console.log(`wrote ${Object.keys(fixtures()).join(", ")} to ${OUT}`);
