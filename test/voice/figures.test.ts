import { describe, expect, it } from "vitest";
import { figuresOf } from "../../src/voice/figures";

describe("whole transcript figures", () => {
  it.each([
    ["100.50", "100.50", null],
    ["R1,50", "1.50", "R"],
    ["R1,500", "1500", "R"],
    ["R48 000", "48000", "R"],
    ["R100 million", "100000000", "R"],
    ["100 rand", "100", "rand"],
    ["200 dollars", "200", "dollars"],
    ["EUR 1.234,50", "1234.50", "EUR"],
    ["$1,234.50", "1234.50", "$"],
    ["R1.25 million", "1250000", "R"],
    ["R0,01", "0.01", "R"],
  ])("extracts %s as an exact decimal, never also an account", (raw, value, currency) => {
    const transcript = `Before: ${raw}; after.`;
    expect(figuresOf(transcript)).toEqual([
      { kind: "amount", raw, start: 8, end: 8 + String(raw).length, value, currency },
    ]);
  });

  it("keeps grouped account digits including leading zeros and offsets", () => {
    const raw = "0012 3456 78";
    const transcript = `Account ${raw}.`;
    expect(figuresOf(transcript)).toEqual([
      { kind: "account", raw, start: 8, end: 20, value: "0012345678", currency: null },
    ]);
  });

  it("preserves integers beyond floating-point precision", () => {
    expect(figuresOf("R9007199254740993.01")[0]?.value).toBe("9007199254740993.01");
    expect(figuresOf("001234567890123456789")[0]?.value).toBe("001234567890123456789");
  });

  it("separates amounts and retains their literal currency without inferring a dollar country", () => {
    expect(figuresOf("100 rand beside 200 dollars").map((f) => [f.raw, f.value, f.currency])).toEqual([
      ["100 rand", "100", "rand"],
      ["200 dollars", "200", "dollars"],
    ]);
  });

  it.each(["R1,50,0", "R12 34", "ABC123456789XYZ", "991234R100", "R1.2.3", "123456/789012", "R0,500"])(
    "rejects the malformed or embedded run %s without extracting a fragment",
    (text) => {
      expect(figuresOf(text)).toEqual([]);
    },
  );

  it("reports UTF-16 offsets that round-trip the exact source including nonbreaking spaces", () => {
    const transcript = "☎️ Please pay R48\u00a0000 to 0012\u202f3456\u202f78.";
    const figures = figuresOf(transcript);
    expect(figures).toHaveLength(2);
    for (const figure of figures) expect(transcript.slice(figure.start, figure.end)).toBe(figure.raw);
    expect(figures.map((f) => f.value)).toEqual(["48000", "0012345678"]);
  });
});

it("does not mistake the final letter of an ordinary preceding word for a currency", () => {
  expect(figuresOf("Transfer 0012 3456 78").map((f) => [f.kind, f.value, f.currency])).toEqual([
    ["account", "0012345678", null],
  ]);
  expect(figuresOf("remember 100.50").map((f) => [f.value, f.currency])).toEqual([["100.50", null]]);
});

it("handles a recording-sized transcript and rejects oversized runs whole", () => {
  const transcript = "Pay R1.50 then ".repeat(6000);
  expect(figuresOf(transcript)).toHaveLength(6000);
  expect(figuresOf(`R${"1".repeat(10000)} million`)).toEqual([]);
});

it.each([
  "-100.50",
  "R100-200",
  "12:30",
  "2026-11-04",
  "1e6",
  "R100 percent",
  "100.50%",
  "123456\u200b789012",
  "123456’789012",
  "123456٬789012",
  "R100–200",
])("leaves ambiguous form %s in the quote without a derived amount", (text) => {
  expect(figuresOf(text)).toEqual([]);
});
