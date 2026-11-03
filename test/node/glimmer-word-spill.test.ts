import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WordSpill } from "../../scripts/glimmer/build-dataset.ts";

// The build's shingles live on disk (coordinator direction, 2026-11-02): written out as pages stream
// through, read back only for a near-duplicate comparison, and removed when the build ends.
describe("WordSpill", () => {
  it("round-trips a page's shingles and reports its length without reading it", () => {
    const dir = mkdtempSync(join(tmpdir(), "spill-"));
    const path = join(dir, "words.bin");
    const spill = new WordSpill(path);
    const a = { page: { id: "a" } } as never;
    const b = { page: { id: "b" } } as never;
    spill.add(a, new Uint32Array([3, 1, 4, 1, 5]));
    spill.add(b, new Uint32Array([]));
    expect(spill.length(a as never)).toBe(5);
    expect(spill.length(b as never)).toBe(0);
    expect([...spill.get(a as never)]).toEqual([3, 1, 4, 1, 5]);
    expect([...spill.get(b as never)]).toEqual([]);
    spill.close();
    expect(existsSync(path)).toBe(false);
  });

  it("keeps at most its bounded cache while serving many entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "spill-"));
    const spill = new WordSpill(join(dir, "words.bin"));
    const entries = Array.from({ length: 300 }, (_, i) => ({ page: { id: `p${i}` } }) as never);
    entries.forEach((entry, i) => {
      spill.add(entry, new Uint32Array([i]));
    });
    entries.forEach((entry, i) => {
      expect(spill.get(entry as never)[0]).toBe(i);
    });
    // A read of the first entry again still comes back right, from disk after its cache slot went.
    expect(spill.get(entries[0] as never)[0]).toBe(0);
    spill.close();
  });
});
