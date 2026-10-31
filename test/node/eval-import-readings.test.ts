// D08 T01 §6: second readings imported from a review, with no hand transcription; refused whole, nothing written.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { importReadings } from "../../eval/import-readings.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "eval", "import-readings.ts");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "eval-import-"));
  dirs.push(d);
  return d;
};

describe("the real record", () => {
  it("reproduces every committed second reading, field for field, from D08 T01 §5's review", () => {
    const setFile = join(ROOT, "eval", "sets", "nazario-2025", "annotations.json");
    const pendingFile = join(ROOT, "eval", "pending", "nazario-2025", "pending.json");
    const committed = { annotations: readFileSync(setFile, "utf8"), pending: readFileSync(pendingFile, "utf8") };
    const dir = temp();
    mkdirSync(join(dir, "set"));
    mkdirSync(join(dir, "pending"));
    // Every reading cleared first, so an import that wrote nothing could not pass.
    const cleared = (JSON.parse(committed.annotations) as Record<string, unknown>[]).map((a) => ({
      ...a,
      second_reading: null,
    }));
    const pending = JSON.parse(committed.pending) as { pending: { annotation?: Record<string, unknown> }[] };
    for (const e of pending.pending) if (e.annotation) e.annotation = { ...e.annotation, second_reading: null };
    writeFileSync(join(dir, "set", "annotations.json"), JSON.stringify(cleared));
    writeFileSync(join(dir, "pending", "pending.json"), JSON.stringify(pending));
    expect(
      importReadings(ROOT, "docs/reviews/08-eval/D08-T01-s5.md", join(dir, "set"), join(dir, "pending")),
    ).toBeNull();
    expect(JSON.parse(readFileSync(join(dir, "set", "annotations.json"), "utf8"))).toEqual(
      JSON.parse(committed.annotations),
    );
    expect(JSON.parse(readFileSync(join(dir, "pending", "pending.json"), "utf8"))).toEqual(
      JSON.parse(committed.pending),
    );
  });
});

// A repository-shaped fixture: a pin, a findings file, a set's annotations and a pending entry.
function fixture(review: string, reviewers = "[reviewers.astra]\n[reviewers.wonder]\n") {
  const root = temp();
  mkdirSync(join(root, ".conclave"));
  writeFileSync(join(root, ".conclave", "reviewers.toml"), reviewers);
  mkdirSync(join(root, "docs", "reviews"), { recursive: true });
  writeFileSync(join(root, "docs", "reviews", "x.md"), review);
  mkdirSync(join(root, "set"));
  mkdirSync(join(root, "pending"));
  const ann = (path: string) => ({
    path,
    rationale: "A rationale long enough to read as one.",
    reader: "claude",
    date: "2026-10-31",
    second_reading: null,
    resolution: null,
  });
  writeFileSync(join(root, "set", "annotations.json"), JSON.stringify([ann("a.eml"), ann("b.eml")]));
  writeFileSync(
    join(root, "pending", "pending.json"),
    JSON.stringify({
      labelled: 2,
      pending: [{ path: "c.eml", reason: "disputed on its second reading", annotation: ann("c.eml") }],
    }),
  );
  const snapshot = () => [
    readFileSync(join(root, "set", "annotations.json"), "utf8"),
    readFileSync(join(root, "pending", "pending.json"), "utf8"),
  ];
  return { root, snapshot };
}
const review = (heading: string, lines: string[]) =>
  `${heading}\n\n### Second reading\n${lines.join("\n")}\n\n### Gap list\n- none\n`;
const ASTRA = "## Completion review: astra (`gpt-6-astra` via `codex`)";
const GOOD = ["- `a.eml`: agree", "- `b.eml`: disagree: it is impersonation", "- `c.eml`: disagree: unclear"];

describe("an import", () => {
  it("writes each reading, with the reviewer from the review's own heading", () => {
    const { root } = fixture(review(ASTRA, GOOD));
    expect(importReadings(root, "docs/reviews/x.md", join(root, "set"), join(root, "pending"))).toBeNull();
    const annotations = JSON.parse(readFileSync(join(root, "set", "annotations.json"), "utf8"));
    expect(annotations[1].second_reading).toEqual({
      reviewer: "astra",
      review: "docs/reviews/x.md#Second reading",
      verdict: "disagree",
      note: "it is impersonation",
    });
    const pending = JSON.parse(readFileSync(join(root, "pending", "pending.json"), "utf8"));
    expect(pending.pending[0].annotation.second_reading).toMatchObject({ verdict: "disagree", note: "unclear" });
    expect(pending.labelled).toBe(2);
  });

  for (const [name, text, problem, reviewers] of [
    ["a missing verdict", review(ASTRA, GOOD.slice(0, 2)), /c\.eml: no verdict/, undefined],
    ["a duplicate verdict", review(ASTRA, [...GOOD, "- `a.eml`: agree"]), /a\.eml: 2 verdicts/, undefined],
    [
      "a verdict for no annotation",
      review(ASTRA, [...GOOD, "- `z.eml`: agree"]),
      /z\.eml: a verdict for no annotation/,
      undefined,
    ],
    ["a malformed line", review(ASTRA, [...GOOD, "- a.eml agree"]), /a malformed verdict line/, undefined],
    [
      "a disagreement with no reason",
      review(ASTRA, [GOOD[0], "- `b.eml`: disagree", GOOD[2]] as string[]),
      /b\.eml: disagree with no reason/,
      undefined,
    ],
    [
      "a review by the writer",
      review("## Completion review: claude (`opus`)", GOOD),
      /claude's, not a pinned reviewer's/,
      "[reviewers.claude]\n",
    ],
    [
      "a review by an unpinned name",
      review("## Completion review: zeta (`m`)", GOOD),
      /zeta's, not a pinned reviewer's/,
      undefined,
    ],
    [
      "a note over 400 characters",
      review(ASTRA, [GOOD[0], `- \`b.eml\`: disagree: ${"x".repeat(401)}`, GOOD[2]] as string[]),
      /b\.eml: /,
      undefined,
    ],
    ["no second reading at all", `${ASTRA}\n\n### Gap list\n- none\n`, /has no ### Second reading/, undefined],
  ] as [string, string, RegExp, string | undefined][]) {
    it(`refuses ${name}, writing nothing`, () => {
      const { root, snapshot } = fixture(text, reviewers);
      const before = snapshot();
      const problems = importReadings(root, "docs/reviews/x.md", join(root, "set"), join(root, "pending"));
      expect(problems?.join("\n")).toMatch(problem);
      expect(snapshot()).toEqual(before);
    });
  }
});

describe("the command", () => {
  const run = (cwd: string, args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", timeout: 30_000 });

  it("writes and exits 0, read back from what it persisted", () => {
    const { root } = fixture(review(ASTRA, GOOD));
    const done = run(root, ["docs/reviews/x.md", "set", "pending"]);
    expect([done.status, done.stdout.trim()]).toEqual([0, "import-readings: every annotation read a second time"]);
    const annotations = JSON.parse(readFileSync(join(root, "set", "annotations.json"), "utf8"));
    expect(annotations.map((a: { second_reading: { verdict: string } }) => a.second_reading.verdict)).toEqual([
      "agree",
      "disagree",
    ]);
  });

  it("exits 1 naming every problem, with both files unchanged, and 2 on bad arguments", () => {
    const { root, snapshot } = fixture(review(ASTRA, [GOOD[0] as string, "- `z.eml`: agree"]));
    const before = snapshot();
    const refused = run(root, ["docs/reviews/x.md", "set", "pending"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/nothing written/);
    expect(refused.stderr).toMatch(/z\.eml: a verdict for no annotation/);
    expect(refused.stderr).toMatch(/b\.eml: no verdict/);
    expect(snapshot()).toEqual(before);
    expect(run(root, []).status).toBe(2);
  });
});
