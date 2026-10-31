// D08 T01 §4: a label's basis. `checks` (the reading when absent) names the evidence deterministic checks raise; `model`
// is an attack only a model can see, which may name none.
import { describe, expect, it } from "vitest";
import { Label } from "../../eval/schema.ts";

const attack = { path: "a.eml", label: "attack", category: "credential-phishing", source: "test" } as const;
const genuine = {
  path: "g.eml",
  label: "genuine",
  category: "genuine-business",
  expected: [],
  source: "test",
} as const;

describe("a label's basis", () => {
  it("loads a model attack that names no expected evidence", () => {
    expect(Label.parse({ ...attack, expected: [], basis: "model" })).toEqual({
      ...attack,
      expected: [],
      basis: "model",
    });
  });

  it("holds a checks attack, written or read by default, to naming its evidence", () => {
    expect(Label.safeParse({ ...attack, expected: [], basis: "checks" }).success).toBe(false);
    expect(Label.safeParse({ ...attack, expected: [] }).success).toBe(false);
    expect(Label.safeParse({ ...attack, expected: ["sender.reply_to"] }).success).toBe(true);
  });

  it("never writes a default basis into a label that had none", () => {
    const parsed = Label.parse({ ...attack, expected: ["sender.reply_to"] });
    expect("basis" in parsed).toBe(false);
  });

  it("refuses genuine mail resting on a model, and an unknown basis", () => {
    const refused = Label.safeParse({ ...genuine, basis: "model" });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((i) => i.message)).toContain("only an attack can rest on a model");
    expect(Label.safeParse({ ...attack, expected: [], basis: "guess" }).success).toBe(false);
    expect(Label.safeParse({ ...genuine, basis: "checks" }).success).toBe(true);
  });
});
