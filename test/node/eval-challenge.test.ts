// The synthetic challenge set (D08 T01 §7): 30 pairs of a subtle attack and its matched benign control, their rules, and
// (once generated) the persisted set held to its pairs, its bodies and its second readings.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assemble } from "../../eval/generate/assemble.ts";
import {
  ATTACK_CATEGORIES,
  CHALLENGE_SET,
  challengeCounts,
  challengeSpec,
  challengeSpecs,
  cueOf,
  PAIRS,
  PER_CATEGORY,
  pairOf,
  pairProblems,
} from "../../eval/generate/challenge.ts";
import { challengeProblems } from "../../eval/generate/realism.ts";
import { SETS_DIR, scenarioText } from "../../eval/generate/run.ts";
import { EXPECTABLE, type Spec } from "../../eval/generate/scenarios.ts";
import { loadSet } from "../../eval/load.ts";

const specs = challengeSpecs();
const byId = new Map(specs.map((s) => [s.id, s]));
const one = (id: string) => byId.get(id) as Spec;

// A body that passes the rules for its spec: the claimed party, every detail verbatim, the category's request for an
// attack, neutral words between.
const FILLER =
  "Please keep this note with the rest of the paperwork for the month, and let the team know when it has been read.";
const ASK: Record<string, string> = {
  "credential-phishing": "Sign in there to keep access.",
  "bec-payment": "Please make the payment today.",
  "invoice-bank-change": "Our new bank account is the one above.",
  impersonation: "The fee must be settled first.",
  "voice-lure": "Call the number above to stop it.",
  "malware-attachment": "Open the attached file.",
};
function body(spec: Spec, extra = "") {
  const details = Object.values(spec.details).join(" and ");
  const ask = spec.label === "attack" ? ` ${ASK[spec.category]}` : "";
  return {
    subject: `A note from ${spec.claimed}`,
    body: `Good day ${spec.to.name},\n\nThis note comes from ${spec.claimed}. It concerns ${details}.${ask} ${FILLER} ${FILLER} ${FILLER}${extra ? ` ${extra}` : ""}\n\nRegards,\n${spec.from.name}`,
  };
}
const attackOf = (pair: (typeof PAIRS)[number]) => one(pair.attack);
const controlOf = (pair: (typeof PAIRS)[number]) => one(pair.control);

describe("the challenge specs", () => {
  it("stores results alongside the generator", () => {
    expect(CHALLENGE_SET.resultsFile).toBe(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../eval/generate/results-challenge.json"),
    );
  });
  it("are 60 valid specs: five subtle attacks in each attack category and a control for each, interleaved by pair", () => {
    expect(specs).toHaveLength(60);
    expect(new Set(specs.map((s) => s.id)).size).toBe(60);
    expect(PAIRS).toHaveLength(ATTACK_CATEGORIES.length * PER_CATEGORY);
    for (const category of ATTACK_CATEGORIES)
      expect(specs.filter((s) => s.category === category && s.label === "attack")).toHaveLength(PER_CATEGORY);
    expect(specs.filter((s) => s.label === "genuine")).toHaveLength(30);
    for (const [i, s] of specs.entries()) expect(s.label).toBe(i % 2 === 0 ? "attack" : "genuine");
    for (const pair of PAIRS) {
      expect(attackOf(pair).label).toBe("attack");
      expect(controlOf(pair).label).toBe("genuine");
      expect(attackOf(pair).category).toBe(pair.category);
    }
  });

  it("put every address under .example and expect only §3's eight names", () => {
    for (const s of specs) {
      for (const address of [s.from.address, s.to.address, s.returnPath, s.replyTo?.address].filter(Boolean))
        expect(address, s.id).toMatch(/@[a-z0-9.-]+\.example$/);
      for (const name of s.expected) expect(EXPECTABLE, s.id).toContain(name);
      if (s.label === "genuine") expect(s.expected, s.id).toEqual([]);
    }
    // Most subtle attacks have no header tell (basis model); a few carry one the checks can see.
    const attacks = specs.filter((s) => s.label === "attack");
    expect(attacks.filter((s) => s.basis === "model").length).toBeGreaterThanOrEqual(20);
    expect(attacks.filter((s) => s.basis === "checks").length).toBeGreaterThanOrEqual(5);
  });

  it("make each pair share its parties, recipient, topic and cue, and differ in its tell alone", () => {
    expect(pairProblems(specs)).toEqual([]);
    expect(challengeCounts(specs, { total: 0, genuine: 0 })).toEqual([]);
    for (const pair of PAIRS) {
      const attack = attackOf(pair);
      const control = controlOf(pair);
      expect([attack.claimed, attack.recipient, attack.to]).toEqual([control.claimed, control.recipient, control.to]);
      const cue = cueOf(pair);
      expect(cue.length).toBeGreaterThan(0);
      for (const key of cue) expect(attack.details[key], pair.attack).toBe(control.details[key]);
      expect(attack.details.tell, pair.attack).toBeTruthy();
      expect(control.details.counter, pair.control).toBeTruthy();
      expect(control.details.tell).toBeUndefined();
      expect(attack.details.counter).toBeUndefined();
    }
  });

  it("fail a pair whose parties or cue differ, or that lacks a partner", () => {
    const pair = PAIRS.find((p) => p.attack === "bec-payment-001") as (typeof PAIRS)[number];
    const attack = attackOf(pair);
    const control = controlOf(pair);
    const rest = specs.filter((s) => s.id !== control.id);
    expect(pairProblems(rest).join()).toMatch(/pair 6 \(bec-payment-001\) lacks its control/);
    const otherParty = { ...control, claimed: "Another Party" };
    expect(pairProblems([...rest, otherParty]).join()).toMatch(/pair 6: the claimed parties differ/);
    const otherCue = { ...control, details: { ...control.details, amount: "R1.00" } };
    expect(pairProblems([...rest, otherCue]).join()).toMatch(/pair 6: the cue amount differs/);
    const otherRecipient = {
      ...control,
      to: attack.to.address === control.to.address ? { ...control.to, address: "x@y.example" } : control.to,
    };
    expect(pairProblems([...rest, otherRecipient]).join()).toMatch(/pair 6: the recipients differ/);
    expect(challengeCounts(specs.slice(0, 20), { total: 0, genuine: 0 }).join()).toMatch(/accepted, fewer than 5/);
  });

  it("send both members of every pair from the same sender domain, and fail a pair that does not", () => {
    for (const pair of PAIRS) {
      const a = attackOf(pair);
      const c = controlOf(pair);
      expect(a.from.address.split("@")[1], pair.attack).toBe(c.from.address.split("@")[1]);
      expect(a.returnPath.split("@")[1]?.replace(/^mail\./, ""), pair.attack).toBe(
        c.returnPath.split("@")[1]?.replace(/^mail\./, ""),
      );
    }
    const pair = PAIRS[5] as (typeof PAIRS)[number];
    const control = controlOf(pair);
    const rest = specs.filter((s) => s.id !== control.id);
    const moved = { ...control, from: { ...control.from, address: "x@elsewhere.example" } };
    expect(pairProblems([...rest, moved]).join()).toMatch(/pair 6: the sender domains differ/);
    const bounced = { ...control, returnPath: "x@elsewhere.example" };
    expect(pairProblems([...rest, bounced]).join()).toMatch(/pair 6: the return-path domains differ/);
  });

  it("give a variant the same pair with a fresh tell or counter, and resolve any id", () => {
    for (const pair of PAIRS.filter((_, i) => i % 4 === 0)) {
      const attack = attackOf(pair);
      const control = controlOf(pair);
      const va = challengeSpec(`${pair.attack}-v2`) as Spec;
      const vc = challengeSpec(`${pair.control}-v1`) as Spec;
      expect(va.id).toBe(`${pair.attack}-v2`);
      expect([va.claimed, va.recipient, va.to]).toEqual([attack.claimed, attack.recipient, attack.to]);
      for (const key of cueOf(pair)) expect(va.details[key]).toBe(attack.details[key]);
      expect(va.details.tell).not.toBe(attack.details.tell);
      expect(vc.id).toBe(`${pair.control}-v1`);
      expect(vc.details.counter).not.toBe(control.details.counter);
      // The pair is whole with either side replaced.
      const swapped = specs.map((s) => (s.id === pair.attack ? va : s.id === pair.control ? vc : s));
      expect(pairProblems(swapped)).toEqual([]);
      expect(pairOf(va.id)?.index).toBe(pair.index);
      expect(pairOf(vc.id)?.index).toBe(pair.index);
    }
    for (const bad of ["bec-payment-006", "genuine-business-031", "unknown-001", "bec-payment-1", "../x"])
      expect(challengeSpec(bad), bad).toBeNull();
    const bec = PAIRS.find((p) => p.attack === "bec-payment-001") as (typeof PAIRS)[number];
    expect(CHALLENGE_SET.variant(attackOf(bec), 1).id).toBe("bec-payment-001-v1");
    expect(CHALLENGE_SET.variant(controlOf(bec), 2).id).toBe(`${bec.control}-v2`);
  });
});

describe("the challenge rules", () => {
  const pair = PAIRS[0] as (typeof PAIRS)[number];
  const attack = attackOf(pair);
  const control = controlOf(pair);

  it("accept every planted pair", () => {
    for (const p of PAIRS) {
      expect(challengeProblems(attackOf(p), body(attackOf(p))), p.attack).toEqual([]);
      expect(challengeProblems(controlOf(p), body(controlOf(p))), p.control).toEqual([]);
    }
  });

  it("refuse an attack without its tell, and a control that drops the pair's cue or its counter", () => {
    const tell = attack.details.tell as string;
    const noTell = body(attack);
    expect(challengeProblems(attack, { ...noTell, body: noTell.body.replace(tell, "the usual link") }).join()).toMatch(
      /lacks its tell/,
    );
    const cue = control.details.deadline as string;
    const noCue = body(control);
    expect(challengeProblems(control, { ...noCue, body: noCue.body.replace(cue, "soon") }).join()).toMatch(
      /lacks its deadline/,
    );
    const counter = control.details.counter as string;
    expect(challengeProblems(control, { ...noCue, body: noCue.body.replace(counter, "the page") }).join()).toMatch(
      /lacks its counter/,
    );
  });

  it("refuse a control with a changed account, secrecy, a credential request or an off-domain link", () => {
    const g = body(control);
    for (const bad of [
      "Our new bank account number is 62 1234 5678.",
      "We have updated our bank details.",
      "Keep this confidential.",
      "Please verify your password.",
      "Buy gift cards and do not tell anyone.",
    ])
      expect(challengeProblems(control, body(control, bad)).join(), bad).toMatch(/a control carries/);
    expect(challengeProblems(control, { ...g, body: `${g.body}\nSee https://other-party.example/x` }).join()).toMatch(
      /a control links off its sender's own domain \(other-party\.example\)/,
    );
    expect(
      challengeProblems(control, {
        ...g,
        body: `${g.body}\nSee https://${control.from.address.split("@")[1]}%2e.evil.example/x`,
      }).join(),
    ).toMatch(/links off its sender's own domain/);
  });

  it("let a control sound urgent or confirm a requested bank detail, which the main set forbids", () => {
    const urgent = body(control, "This is urgent and must be done immediately, within 24 hours.");
    expect(challengeProblems(control, urgent)).toEqual([]);
    expect(
      challengeProblems(
        controlOf(PAIRS[10] as (typeof PAIRS)[number]),
        body(controlOf(PAIRS[10] as (typeof PAIRS)[number]), "Our banking details are unchanged, as you asked."),
      ),
    ).toEqual([]);
  });

  it("refuse a message that names its role in the test set, either label", () => {
    for (const spec of [attack, control]) {
      const g = body(spec, "This is an honest control for the test set.");
      expect(challengeProblems(spec, g).join(), spec.id).toMatch(/names its role in the test set/);
      const decoy = body(spec, "A benign decoy message.");
      expect(challengeProblems(spec, decoy).join(), spec.id).toMatch(/names its role in the test set/);
    }
  });

  it("ask both members of a pair in the same plain register, without the words of the test set", () => {
    const a = scenarioText(attack, null, CHALLENGE_SET);
    const c = scenarioText(control, null, CHALLENGE_SET);
    for (const text of [a, c]) {
      expect(text).toContain("Write only what the scenario gives, in a plain, businesslike register");
      expect(text).not.toMatch(/honest control|benign|decoy|test set/i);
    }
  });

  it("hold an attack to the main set's rules too", () => {
    const g = body(attack);
    expect(challengeProblems(attack, { ...g, body: `${g.body} Write to x@sunmail.co.za.` }).join()).toMatch(
      /address outside \.example/,
    );
    expect(challengeProblems(attack, { ...g, body: `${g.body} Do not visit that address.` }).join()).toMatch(
      /warns against itself/,
    );
  });
});

describe("the persisted challenge set", () => {
  const dir = join(SETS_DIR, CHALLENGE_SET.name);
  const stored = (
    JSON.parse(readFileSync(CHALLENGE_SET.resultsFile, "utf-8")) as {
      results: { id: string; status: string; generated: { subject: string; body: string } | null }[];
    }
  ).results;
  const set = loadSet(dir, CHALLENGE_SET.name);
  const idOf = (path: string) => path.replace(/\.eml$/, "");
  const specOf = (path: string) => challengeSpec(idOf(path)) as Spec;

  it("holds 60 messages: 30 attacks, five in each attack category, and 30 controls", () => {
    expect(set.samples).toHaveLength(60);
    expect(set.samples.filter((s) => s.label === "genuine")).toHaveLength(30);
    for (const category of ATTACK_CATEGORIES)
      expect(set.samples.filter((s) => s.category === category)).toHaveLength(PER_CATEGORY);
    expect(
      challengeCounts(
        set.samples.map((s) => specOf(s.path)),
        { total: 0, genuine: 0 },
      ),
    ).toEqual([]);
  });

  it("is every file exactly as its spec and stored body assemble, passing the rules, its label its spec's", () => {
    for (const sample of set.samples) {
      const id = idOf(sample.path);
      const spec = specOf(sample.path);
      expect(spec, id).not.toBeNull();
      const result = stored.find((r) => r.id === id);
      expect(result?.status, id).toBe("accepted");
      const generated = result?.generated as { subject: string; body: string };
      expect(challengeProblems(spec, generated), id).toEqual([]);
      expect(Buffer.from(readFileSync(join(dir, sample.path))).equals(Buffer.from(assemble(spec, generated))), id).toBe(
        true,
      );
      expect([sample.label, sample.category, sample.expected, sample.basis ?? "checks"]).toEqual([
        spec.label,
        spec.category,
        spec.expected,
        spec.basis,
      ]);
    }
  });

  it("keeps every pair whole: attack and control share their parties and cue", () => {
    expect(pairProblems(set.samples.map((s) => specOf(s.path)))).toEqual([]);
  });
});
