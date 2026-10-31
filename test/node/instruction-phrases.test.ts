import { describe, expect, it } from "vitest";
import { findInstructions, PhraseLog, PhraseStream } from "../../src/checks/instruction-phrases";

// D02 T05 §2's hostile-input bounds, timed here because a Worker's clock does not move while synchronous code runs, so
// a timing bound in the Worker project can never fail (round 2).
function chunked(text: string, size: number) {
  const log = new PhraseLog();
  const stream = new PhraseStream(log, "text", "body", false);
  for (let i = 0; i < text.length; i += size) stream.feed(text.slice(i, i + size));
  stream.end();
  return log.matches.map((m) => m.pattern);
}

describe("the instruction phrases on hostile input", () => {
  it("read a long run of hashes in linear time (round 1)", () => {
    const started = performance.now();
    expect(findInstructions([{ text: `${"#".repeat(131_072)}x`, location: "text" }])).toEqual([]);
    expect(
      findInstructions([{ text: `${"#".repeat(131_072)} system:`, location: "text" }]).map((m) => m.pattern),
    ).toEqual(["template-marker"]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("read a long word before punctuation in linear time, whole or in chunks (round 2)", () => {
    const started = performance.now();
    for (const size of [131_073, 65_536]) expect(chunked(`${"a".repeat(131_072)}.`, size)).toEqual([]);
    expect(chunked(`${"a".repeat(131_072)}. ignore previous instructions`, 65_536)).toEqual(["ignore-instructions"]);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
