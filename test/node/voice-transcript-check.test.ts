// D01 T03 §3's live check: what a transcript must hold, a name accepted in any of its listed spellings (the synthetic
// voice says an Afrikaans name with English phonetics), never accepted when it is missing.
import { describe, expect, it } from "vitest";
import { checkTranscript } from "../../scripts/voice-transcribe-live.ts";

const expectations = {
  request: ["pay"],
  identity: [["Pieter Botha", "Peter Bota"], "managing director"],
  urgency: ["today"],
  speakers: 2,
};
const turns = [
  { speaker: "A", startMs: 0, endMs: 1000, transcript: "" },
  { speaker: "B", startMs: 1000, endMs: 2000, transcript: "" },
];

describe("checkTranscript", () => {
  it("hears a name in any listed spelling, and says which spellings were missed", () => {
    const heard = { transcript: "It's Peter Bota, the managing director. Pay it today.", turns };
    expect(checkTranscript(heard, expectations)).toEqual([]);
    const missed = { transcript: "It's the managing director. Pay it today.", turns };
    expect(checkTranscript(missed, expectations)).toEqual(['identity: "Pieter Botha" or "Peter Bota" not heard']);
  });
});
