import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtures } from "../../scripts/fixtures/msg-builder";

// D01 T01 §6: the committed .msg fixtures are exactly what the builder writes.
const DIR = join(import.meta.dirname, "../fixtures/msg");

describe("the .msg fixtures", () => {
  it("are exactly what scripts/fixtures/msg-builder.ts builds", () => {
    for (const [name, bytes] of Object.entries(fixtures()))
      expect(new Uint8Array(readFileSync(join(DIR, name))), name).toEqual(bytes);
  });
});
