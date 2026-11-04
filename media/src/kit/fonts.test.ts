// node --test: the font loader releases the render only when every font loaded, and cancels it naming the font that
// failed (D10 T01 §1 completion review).
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadFonts } from "./fonts.ts";

const FONTS = [
  ["Exo", "fonts/Exo[wght].ttf"],
  ["Exo 2", "fonts/Exo2[wght].ttf"],
] as const;

test("releases the render once every font has loaded", async () => {
  const loaded: string[] = [];
  let done = 0;
  let failed: Error | undefined;
  await loadFonts(FONTS, async (family) => void loaded.push(family), () => done++, (e) => (failed = e));
  assert.deepEqual(loaded.sort(), ["Exo", "Exo 2"]);
  assert.equal(done, 1);
  assert.equal(failed, undefined);
});

test("cancels the render with the failed font's path and never releases it", async () => {
  let done = 0;
  let failed: Error | undefined;
  await loadFonts(
    FONTS,
    async (family) => {
      if (family === "Exo 2") throw new Error("404");
    },
    () => done++,
    (e) => (failed = e),
  );
  assert.equal(done, 0);
  assert.match(String(failed?.message), /^font Exo 2 \(fonts\/Exo2\[wght\]\.ttf\) failed to load: 404$/);
});
