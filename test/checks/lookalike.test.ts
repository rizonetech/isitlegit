import { describe, expect, it } from "vitest";
import MAP from "../../src/checks/confusables-map.json";
import { ADDED_WORDS, addedWords, distance, skeleton, unicodeLabel } from "../../src/checks/lookalike";

// D02 T03 §1: the UTS #39 skeleton, the optimal string alignment distance and the added-word pattern.
const PROTOTYPES: Record<string, string> = MAP.prototypes;

describe("skeleton", () => {
  it("maps confusables to their prototypes, exactly", () => {
    // A Cyrillic а in a Latin name.
    expect(skeleton("pаypal")).toBe("paypal");
    expect(skeleton("paypal")).toBe("paypal");
    // One character to two: m looks like rn.
    expect(skeleton("modern")).toBe("rnodern");
    expect(skeleton("rnodern")).toBe("rnodern");
    // Digits and letters UTS #39 itself names: 1 and l, 0 and O.
    expect(skeleton("paypa1")).toBe(skeleton("paypal"));
    expect(skeleton("g00gle")).toBe(skeleton("gOOgle"));
  });

  it("tells unrelated labels apart", () => {
    for (const [a, b] of [
      ["paypal", "paypals"],
      ["fynbosfreight", "fynbosfright"],
      ["standardbank", "standardbonk"],
    ] as const)
      expect(skeleton(a), `${a} ${b}`).not.toBe(skeleton(b));
  });

  it("drops default-ignorable characters such as a zero-width joiner", () => {
    expect(skeleton("payp‍al")).toBe("paypal");
    expect(skeleton("pay­pal")).toBe("paypal");
  });

  it("decomposes first, so a precomposed letter maps like its parts", () => {
    // Ì is I and a grave accent; I's prototype is l. Without the first NFD, Ì would stay itself.
    expect(PROTOTYPES["Ì"]).toBeUndefined();
    expect(skeleton("Ì")).toBe("l̀");
    expect(skeleton("café")).toBe(skeleton("café"));
  });

  it("decomposes again after mapping, so a prototype's marks are in canonical order", () => {
    const character = "\u{1df2d}";
    const prototype = PROTOTYPES[character] as string;
    expect(prototype.normalize("NFD")).not.toBe(prototype);
    expect(skeleton(character)).toBe(prototype.normalize("NFD"));
  });

  it("gives no skeleton for a label with a right-to-left character", () => {
    for (const label of ["שלום", "مرحبا", "ދި", "payאpal"]) expect(skeleton(label), label).toBeNull();
    expect(skeleton("paypal")).not.toBeNull();
  });
});

describe("unicodeLabel", () => {
  it("decodes an A-label, so its Unicode and Punycode forms compare alike", () => {
    expect(unicodeLabel("xn--pypal-4ve")).toBe("pаypal");
    expect(skeleton(unicodeLabel("xn--pypal-4ve") as string)).toBe(skeleton(unicodeLabel("pаypal") as string));
    expect(unicodeLabel("XN--PYPAL-4VE")).toBe("pаypal");
    expect(unicodeLabel("xn--fynbosfreght-0fb")).toBe("fynbosfreíght");
  });

  it("decodes what the runtime's own IDNA encoder makes", () => {
    for (const label of [
      "p\u0430ypal",
      "fynbosfre\u00edght",
      "m\u00fcller",
      "\u0441\u0431\u0435\u0440\u0431\u0430\u043d\u043a",
      "caf\u00e9-online",
    ]) {
      const encoded = new URL(`http://${label}.example`).hostname.split(".")[0] as string;
      expect(encoded.startsWith("xn--"), label).toBe(true);
      expect(unicodeLabel(encoded), label).toBe(label);
    }
  });

  it("lowercases a plain label and refuses an invalid one", () => {
    expect(unicodeLabel("FynbosFreight")).toBe("fynbosfreight");
    for (const label of ["", "two.labels", "xn--", "xn--ab_c", "xn--abc-", "xn--99999999", `xn--${"a".repeat(60)}`])
      expect(unicodeLabel(label), label).toBeNull();
    // Punycode that decodes to plain ASCII is not a valid A-label.
    expect(unicodeLabel("xn--abc-")).toBeNull();
  });
});

describe("distance", () => {
  it("counts insertions, deletions, substitutions and adjacent transpositions, in code points", () => {
    expect(distance("fynbos", "fynbos")).toBe(0);
    expect(distance("fynbos", "fynboss")).toBe(1);
    expect(distance("fynbos", "fynbo")).toBe(1);
    expect(distance("fynbos", "fynb0s")).toBe(1);
    expect(distance("fynbos", "fnybos")).toBe(1);
    expect(distance("", "abc")).toBe(3);
    // A supplementary character is one code point, not two UTF-16 units.
    expect(distance("pay\u{1d5ba}", "paya")).toBe(1);
  });

  it("is the optimal string alignment distance, not unrestricted Damerau-Levenshtein", () => {
    // Unrestricted gives 2 (transpose, then insert between); OSA may not edit a transposed pair again.
    expect(distance("ca", "abc")).toBe(3);
  });
});

describe("addedWords", () => {
  it("finds a whole word added after or before the whole base", () => {
    expect(addedWords("fynbosfreight-payments", "fynbosfreight")).toEqual({ word: "payments", side: "after" });
    expect(addedWords("fynbosfreightpayments", "fynbosfreight")).toEqual({ word: "payments", side: "after" });
    expect(addedWords("secure-fynbosfreight", "fynbosfreight")).toEqual({ word: "secure", side: "before" });
    expect(addedWords("fynbosfreight-za", "fynbosfreight")).toEqual({ word: "za", side: "after" });
    expect(addedWords("onlinefynbosfreight", "fynbosfreight")).toEqual({ word: "online", side: "before" });
  });

  it("refuses an unchanged base, an unrelated name and a word inside a longer word", () => {
    for (const candidate of [
      "fynbosfreight",
      "otherfreight-payments",
      "fynbosfreightpayable",
      "fynbosfreight-payments-now",
      "fynbosfreigh-payments",
      "payfynbosfreightza",
    ])
      expect(addedWords(candidate, "fynbosfreight"), candidate).toBeNull();
    expect(addedWords("payments", "")).toBeNull();
  });

  it("has every word lowercase and unique", () => {
    expect(new Set(ADDED_WORDS).size).toBe(ADDED_WORDS.length);
    for (const word of ADDED_WORDS) expect(word).toMatch(/^[a-z]+$/);
  });
});
