// The generated shots reach the demo as imports only when their file exists (capture/index.ts).
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generatedFor, moduleFor } from "./index.ts";

test("a generated file that exists is imported and one that does not is null", () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-"));
  writeFileSync(join(dir, "shot-1-road.mp4"), "x");
  const { imports, table } = generatedFor(join(dir, "out", "demo-capture.ts"), dir);
  assert.equal(imports.length, 1);
  assert.match(imports[0], /import gen_road from ".*shot-1-road\.mp4"/);
  assert.match(table, /road: gen_road,/);
  assert.match(table, /attacker: null,/);
});

test("with no capture the module still carries the generated table", () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-"));
  writeFileSync(join(dir, "plate-c-harbour.png"), "x");
  const out = moduleFor(null, join(dir, "out", "demo-capture.ts"), dir);
  assert.match(out, /export const CAPTURE = null;/);
  assert.match(out, /plateC: gen_plateC,/);
});
