import { describe, expect, it } from "vitest";
import MAP from "../../src/checks/confusables-map.json";
import {
  ADDED_WORDS,
  addedWords,
  distance,
  foldAccents,
  labelSkeleton,
  MAX_LABEL_CHARACTERS,
  skeleton,
  unicodeLabel,
} from "../../src/checks/lookalike";

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
    expect(PROTOTYPES.Ì).toBeUndefined();
    expect(skeleton("Ì")).toBe("l̀");
    expect(skeleton("café")).toBe(skeleton("café"));
  });

  it("decomposes again after mapping, so a prototype's marks are in canonical order", () => {
    const character = "\u{1df2d}";
    const prototype = PROTOTYPES[character] as string;
    expect(prototype.normalize("NFD")).not.toBe(prototype);
    expect(skeleton(character)).toBe(prototype.normalize("NFD"));
  });

  it("counts an unassigned code point in a right-to-left block as right-to-left (the @missing defaults)", () => {
    // U+0590 is unassigned, in the Hebrew block: Right_To_Left by default.
    expect(skeleton("pay\u0590pal")).toBeNull();
    expect(skeleton("pay\u07c0pal")).toBeNull();
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

  it("gives one form for a decomposed label, its precomposed form and its A-label, so every primitive agrees", () => {
    const forms = ["cafe\u0301-payments", "caf\u00e9-payments", "xn--caf-payments-deb", "CAF\u00c9-PAYMENTS"].map(
      unicodeLabel,
    );
    expect(new Set(forms)).toEqual(new Set(["caf\u00e9-payments"]));
    const base = unicodeLabel("cafe\u0301") as string;
    for (const form of forms) {
      expect(addedWords(form as string, base)).toEqual({ word: "payments", side: "after" });
      expect(distance(form as string, "caf\u00e9-payments")).toBe(0);
    }
    // Full-width letters are the same host to every browser (UTS #46 maps them), so the same label.
    expect(unicodeLabel("\uff50aypal")).toBe("paypal");
  });

  it("refuses an A-label the runtime's IDNA rejects, and any label over 63 octets", () => {
    for (const label of ["xn--a", "xn--e-xbb", "a".repeat(64), "pay%2epal", "pay pal", `xn--${"a".repeat(58)}-9ba`])
      expect(unicodeLabel(label), label).toBeNull();
    expect(unicodeLabel("a".repeat(63))).toBe("a".repeat(63));
  });

  it("lowercases a plain label and refuses an invalid one", () => {
    expect(unicodeLabel("FynbosFreight")).toBe("fynbosfreight");
    for (const label of ["", "two.labels", "xn--", "xn--ab_c", "xn--abc-", "xn--99999999", `xn--${"a".repeat(60)}`])
      expect(unicodeLabel(label), label).toBeNull();
    // Punycode that decodes to plain ASCII is not a valid A-label.
    expect(unicodeLabel("xn--abc-")).toBeNull();
  });
});

describe("the final review (2026-10-29)", () => {
  it("bounds distance to a label's length", () => {
    expect(distance("a".repeat(MAX_LABEL_CHARACTERS), "b".repeat(MAX_LABEL_CHARACTERS))).toBe(MAX_LABEL_CHARACTERS);
    expect(() => distance("a".repeat(20_000), "b")).toThrow(RangeError);
    expect(() => distance("a", "b".repeat(64))).toThrow(RangeError);
  });

  it("refuses a label no one can register", () => {
    for (const label of ["-fynbosfreight", "fynbosfreight-", "pay_pal", "ab--cd", "pay!pal"])
      expect(unicodeLabel(label), label).toBeNull();
    expect(unicodeLabel("fynbos-freight")).toBe("fynbos-freight");
    expect(unicodeLabel("xn--pypal-4ve")).toBe("p\u0430ypal");
  });

  it("compares labels in their normal form whatever form they are given in", () => {
    expect(labelSkeleton("PAYPAL")).toBe("paypal");
    expect(labelSkeleton("xn--pypal-4ve")).toBe("paypal");
    expect(labelSkeleton("-paypal")).toBeNull();
    expect(addedWords("FynbosFreight-Payments", "fynbosfreight")).toEqual({ word: "payments", side: "after" });
    expect(addedWords("fynbosfreight-payments", "FYNBOSFREIGHT")).toEqual({ word: "payments", side: "after" });
    expect(addedWords("-payments", "fynbosfreight")).toBeNull();
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

describe("foldAccents", () => {
  it("removes marks separately from the UTS #39 skeleton", () => {
    expect(foldAccents("fýnbósfreíght")).toBe("fynbosfreight");
    expect(distance(skeleton("fýnbósfreíght") as string, skeleton("fynbosfreight") as string)).toBe(3);
    expect(foldAccents("cafe\u0301")).toBe("cafe");
    expect(foldAccents("a\u0301\u1ab0\u20dd")).toBe("a");
    expect(foldAccents("각")).toBe("각"); // NFC recomposes non-mark decompositions.
    expect(foldAccents("øß")).toBe("øß"); // Not compatibility folding or transliteration.
    expect(foldAccents("")).toBe("");
  });
});
