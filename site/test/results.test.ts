// The eval summary the home page's results band reads (D07 T06 §2), over fixture files in a temporary folder.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { band, readResults } from "../src/lib/results.ts";

const dir = mkdtempSync(join(tmpdir(), "site-results-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const GOOD = { detectionRate: 0.962, falseAlarmRate: 0.018, medianSeconds: 47.4, samples: 240, runDate: "2026-11-02", runId: "r-42" };
const write = (name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
};

describe("readResults", () => {
  it("is null when there is no summary, and the band keeps the SPEC's placeholders", () => {
    assert.equal(readResults(join(dir, "absent.json")), null);
    assert.deepEqual(band(null), { detection: "[XX]%", falseAlarms: "[X]%", median: "[XX] s", samples: "[N]", date: null });
  });

  it("reads a valid summary and prints its numbers", () => {
    const results = readResults(write("good.json", JSON.stringify(GOOD)));
    assert.deepEqual(results, GOOD);
    assert.deepEqual(band(results), { detection: "96.2%", falseAlarms: "1.8%", median: "47 s", samples: "240", date: "2026-11-02" });
  });

  it("fails the build on a summary that is not JSON", () => {
    assert.throws(() => readResults(write("bad.json", "{ not json")), /is not JSON/);
    assert.throws(() => readResults(write("list.json", "[]")), /is not an object/);
  });

  for (const field of Object.keys(GOOD)) {
    it(`fails the build when ${field} is missing`, () => {
      const { [field]: _, ...rest } = GOOD as Record<string, unknown>;
      assert.throws(() => readResults(write(`no-${field}.json`, JSON.stringify(rest))), new RegExp(`missing ${field}`));
    });
  }

  it("fails the build on a value out of range or of the wrong kind, naming each", () => {
    const bad = { ...GOOD, detectionRate: 96.2, falseAlarmRate: -1, medianSeconds: 0, samples: 2.5, runDate: "2 Nov", runId: " " };
    const error = (() => {
      try {
        readResults(write("range.json", JSON.stringify(bad)));
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    })();
    for (const field of Object.keys(GOOD)) assert.match(error, new RegExp(field));
  });
});
