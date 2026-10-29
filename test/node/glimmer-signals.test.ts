// docs/glimmer/signals.md (D03 T04 §24): every source has its acceptance decision; every cue rests on accepted sources,
// stays within what the screener sees, says what it must not infer, and carries its false-positive risk and a paired
// genuine and lure case.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");

type Rubric = {
  sources: Map<string, { decision: string; date: string; reason: string }>;
  cues: { id: string; fields: Map<string, string> }[];
};

function parseRubric(text: string): Rubric {
  const sources = new Map<string, { decision: string; date: string; reason: string }>();
  const table = text.split("## Sources")[1]?.split("## Cues")[0] ?? "";
  for (const line of table.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (!/^S\d+$/.test(cells[1] ?? "")) continue;
    sources.set(cells[1] as string, { date: cells[5] ?? "", decision: cells[6] ?? "", reason: cells[7] ?? "" });
  }
  const cues: Rubric["cues"] = [];
  const body = text.split("## Cues")[1]?.split("## Out of reach")[0] ?? "";
  for (const block of body.split(/\n### /).slice(1)) {
    const id = /^(C\d+)\./.exec(block)?.[1] ?? "";
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const field = /^- ([A-Za-z ()-]+): (.+)$/.exec(line);
      if (field) fields.set(field[1] as string, field[2] as string);
    }
    cues.push({ id, fields });
  }
  return { sources, cues };
}

// What `buildScreenRequest` never carries: evidence naming one of these is out of the screener's reach.
const OUT_OF_REACH = [
  /WHOIS/i,
  /registration date/i,
  /domain'?s? age/i,
  /registrant/i,
  /\bsender\b/i,
  /certificate/i,
  /padlock/i,
];

// Each cue's problems; none for a cue the rubric may keep.
function cueProblems(rubric: Rubric): string[] {
  const problems: string[] = [];
  for (const cue of rubric.cues) {
    for (const field of ["Sources", "Evidence", "Unavailable", "False-positive risk", "Genuine case", "Lure case"])
      if (!(cue.fields.get(field) ?? "").trim()) problems.push(`${cue.id}: no ${field}`);
    const cited = (cue.fields.get("Sources") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const id of cited) {
      const source = rubric.sources.get(id);
      if (!source) problems.push(`${cue.id}: cites ${id}, which is not listed`);
      else if (source.decision !== "accepted") problems.push(`${cue.id}: rests on ${id}, which was ${source.decision}`);
    }
    // Within what the screener receives: the host (a name, never an IP address), the screenshot and the visible text.
    const evidence = cue.fields.get("Evidence") ?? "";
    if (!/\b(host|screenshot|text|form fields?)\b/.test(evidence))
      problems.push(`${cue.id}: its evidence names none of the screener's inputs`);
    if (/\bIP address/i.test(evidence))
      problems.push(`${cue.id}: its evidence needs an IP-address host the request never carries`);
    // Nor anything else the request never carries, even beside an input it does.
    const unseen = OUT_OF_REACH.find((pattern) => pattern.test(evidence));
    if (unseen) problems.push(`${cue.id}: its evidence needs ${unseen.source}, which the screener never receives`);
  }
  return problems;
}

const text = readFileSync(join(ROOT, "docs/glimmer/signals.md"), "utf-8");
const rubric = parseRubric(text);

describe("the signals rubric", () => {
  it("gives every source its acceptance decision, date and reason", () => {
    expect(rubric.sources.size).toBeGreaterThan(0);
    for (const [id, source] of rubric.sources) {
      expect(["accepted", "rejected"], id).toContain(source.decision);
      expect(source.date, id).not.toBe("");
      expect(source.reason.length, id).toBeGreaterThan(20);
    }
    expect([...rubric.sources.values()].some((s) => s.decision === "accepted")).toBe(true);
  });

  it("keeps every cue sourced, within the screener's inputs, with its unavailable state, risk and paired cases", () => {
    expect(rubric.cues.length).toBeGreaterThan(0);
    expect(cueProblems(rubric)).toEqual([]);
  });

  it("says what each missing input makes unavailable", () => {
    const missing = text.split("## Missing inputs")[1]?.split("## Cues")[0] ?? "";
    for (const input of ["No host", "No screenshot", "Empty or cut-off text"]) expect(missing).toContain(input);
  });

  it("pairs the shortcuts a screener could take with genuine pages that share them", () => {
    const fields = rubric.cues.flatMap((cue) => [...cue.fields.keys()]);
    for (const pair of ["new business", "plain form"]) {
      expect(fields).toContain(`Genuine case (${pair})`);
      expect(fields).toContain(`Lure case (${pair})`);
    }
  });

  it("lists the cues out of the screener's reach apart, so their absence is never read as evidence", () => {
    const outOfReach = text.split("## Out of reach")[1] ?? "";
    for (const unseen of ["sender", "domain's age", "padlock"]) expect(outOfReach).toContain(unseen);
  });

  it("refuses a cue with no evidence, no unavailable state, no counterexample or a rejected source", () => {
    const broken = text
      .replace("- Sources: S1, S3\n", "- Sources: S6\n")
      .replace(/- Unavailable: whether an unfamiliar host[^\n]*\n/, "")
      .replace(/- Genuine case: a South African retailer's checkout[^\n]*\n/, "")
      .replace(/- Evidence: the host alone[^\n]*\n/, "- Evidence: the visitor's feeling\n")
      .replace(
        /- Evidence: the text: a short deadline/,
        "- Evidence: the host given as an IP address and the text: a short deadline",
      );
    const problems = cueProblems(parseRubric(broken));
    expect(problems).toContain("C1: rests on S6, which was rejected");
    expect(problems).toContain("C1: no Unavailable");
    expect(problems).toContain("C1: no Genuine case");
    expect(problems).toContain("C2: its evidence names none of the screener's inputs");
    expect(problems).toContain("C5: its evidence needs an IP-address host the request never carries");
    // Unavailable evidence beside an allowed input is still out of reach.
    const whois = cueProblems(
      parseRubric(
        text.replace(
          "- Evidence: the host alone:",
          "- Evidence: the host registration date from WHOIS and the host alone:",
        ),
      ),
    );
    expect(whois.some((p) => p.startsWith("C2: its evidence needs"))).toBe(true);
  });
});
