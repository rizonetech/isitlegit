// D08 T01 §6: second readings imported from a review, with no hand transcription; refused whole, nothing written.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type Fs, importReadings, report } from "../../eval/import-readings.ts";

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
    ).toMatchObject({ written: true });
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
    expect(importReadings(root, "docs/reviews/x.md", join(root, "set"), join(root, "pending"))).toMatchObject({
      written: true,
    });
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
      const outcome = importReadings(root, "docs/reviews/x.md", join(root, "set"), join(root, "pending"));
      expect(outcome.written).toBe(false);
      expect("problems" in outcome && outcome.problems.join("\n")).toMatch(problem);
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
    expect([done.status, done.stdout.split("\n")[0]]).toEqual([
      0,
      "import-readings: 3 readings written (1 agree, 2 disagree)",
    ]);
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

describe("the real record through the command", () => {
  it("reproduces both committed files whole when run as the command on cleared copies", () => {
    const setFile = join(ROOT, "eval", "sets", "nazario-2025", "annotations.json");
    const pendingFile = join(ROOT, "eval", "pending", "nazario-2025", "pending.json");
    const dir = temp();
    mkdirSync(join(dir, "set"));
    mkdirSync(join(dir, "pending"));
    const cleared = (JSON.parse(readFileSync(setFile, "utf8")) as Record<string, unknown>[]).map((a) => ({
      ...a,
      second_reading: null,
    }));
    const pending = JSON.parse(readFileSync(pendingFile, "utf8")) as {
      pending: { annotation?: Record<string, unknown> }[];
    };
    for (const e of pending.pending) if (e.annotation) e.annotation = { ...e.annotation, second_reading: null };
    writeFileSync(join(dir, "set", "annotations.json"), JSON.stringify(cleared));
    writeFileSync(join(dir, "pending", "pending.json"), JSON.stringify(pending));
    const done = spawnSync(
      process.execPath,
      [SCRIPT, "docs/reviews/08-eval/D08-T01-s5.md", join(dir, "set"), join(dir, "pending")],
      { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
    );
    expect(done.status).toBe(0);
    expect(done.stdout).toMatch(/48 readings written \(42 agree, 6 disagree\)/);
    expect(readFileSync(join(dir, "set", "annotations.json"), "utf8")).toBe(readFileSync(setFile, "utf8"));
    expect(readFileSync(join(dir, "pending", "pending.json"), "utf8")).toBe(readFileSync(pendingFile, "utf8"));
  });
});

describe("a write that fails part-way", () => {
  // The real file operations, with the nth call of one kind failing (and, when persistent, every later one too).
  const failing = (kind: keyof Fs, nth: number, persistent = false, only?: RegExp): Fs => {
    const counts = { write: 0, rename: 0, remove: 0 };
    const fails = (k: keyof Fs, file: string) => {
      if (k !== kind || (only && !only.test(file))) return false;
      counts[k]++;
      return persistent ? counts[k] >= nth : counts[k] === nth;
    };
    return {
      write: (file, text) => {
        if (fails("write", file)) throw new Error("ENOSPC");
        writeFileSync(file, text);
      },
      rename: (from, to) => {
        if (fails("rename", from)) throw new Error("EACCES");
        renameSync(from, to);
      },
      remove: (file) => {
        if (fails("remove", file)) throw new Error("EBUSY");
        rmSync(file, { force: true });
      },
    };
  };
  const leftovers = (root: string) =>
    [...readdirSync(join(root, "set")), ...readdirSync(join(root, "pending"))].filter((f) =>
      /\.tmp$|before-import|created-by-import/.test(f),
    );
  const imported = () => {
    const clean = fixture(review(ASTRA, GOOD));
    importReadings(clean.root, "docs/reviews/x.md", join(clean.root, "set"), join(clean.root, "pending"));
    return clean.snapshot();
  };
  const run = (root: string, fs?: Fs) =>
    importReadings(root, "docs/reviews/x.md", join(root, "set"), join(root, "pending"), fs);

  for (const [name, fs] of [
    ["the first temporary file cannot be written", failing("write", 1)],
    ["the second temporary file cannot be written", failing("write", 2)],
    ["an original cannot be kept", failing("write", 3)],
    ["a kept original cannot be renamed into place", failing("rename", 1)],
    ["the first replacement fails", failing("rename", 3)],
    ["the second replacement fails, after the first file was replaced", failing("rename", 4)],
  ] as [string, Fs][]) {
    it(`leaves both files unchanged and nothing beside them when ${name}`, () => {
      const { root, snapshot } = fixture(review(ASTRA, GOOD));
      const before = snapshot();
      const outcome = run(root, fs);
      expect(outcome).toMatchObject({ written: false });
      expect(snapshot()).toEqual(before);
      expect(leftovers(root)).toEqual([]);
      expect(report(outcome).err.join("\n")).toMatch(/nothing written/);
    });
  }

  it("names originals that are really on disk when putting them back fails too, and the next run restores them", () => {
    const { root, snapshot } = fixture(review(ASTRA, GOOD));
    const before = snapshot();
    const outcome = run(root, failing("rename", 4, true));
    expect(outcome.written).toBe("partly");
    const text = report(outcome).err.join("\n");
    expect(text).toMatch(/not finished/);
    expect(text).toMatch(/annotations\.json\.before-import/);
    expect(readFileSync(join(root, "set", "annotations.json.before-import"), "utf8")).toBe(before[0]);
    expect(readFileSync(join(root, "pending", "pending.json.before-import"), "utf8")).toBe(before[1]);
    expect(report(outcome).code).toBe(1);
    const next = run(root);
    expect(report(next).out[0]).toMatch(/an interrupted import was undone first/);
    expect(snapshot()).toEqual(imported());
    expect(leftovers(root)).toEqual([]);
  });

  it("says so when a backup cannot be removed after both files were written", () => {
    const { root } = fixture(review(ASTRA, GOOD));
    const outcome = run(root, failing("remove", 1, false, /before-import$/));
    expect(outcome.written).toBe("partly");
    expect(report(outcome).err.join("\n")).toMatch(/both files were written, but .*before-import could not be removed/);
  });

  it("undoes an import killed between its two replacements, then imports", () => {
    const { root, snapshot } = fixture(review(ASTRA, GOOD));
    const before = snapshot();
    const killed = spawnSync(
      process.execPath,
      [join(ROOT, "test", "node", "fixtures", "import-readings-crash.ts"), root],
      {
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(killed.signal).toBe("SIGKILL");
    // Half an import on disk: annotations replaced, pending not, and both originals kept beside them.
    expect(snapshot()[0]).not.toBe(before[0]);
    expect(snapshot()[1]).toBe(before[1]);
    expect(readFileSync(join(root, "set", "annotations.json.before-import"), "utf8")).toBe(before[0]);
    const next = spawnSync(process.execPath, [SCRIPT, "docs/reviews/x.md", "set", "pending"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(next.status).toBe(0);
    expect(next.stdout).toMatch(/an interrupted import was undone first: .*annotations\.json/);
    expect(snapshot()).toEqual(imported());
    expect(leftovers(root)).toEqual([]);
  });
});

describe("annotation identities", () => {
  it("refuses duplicate annotations and a pending annotation bound to another path, writing nothing", () => {
    const duplicated = fixture(review(ASTRA, GOOD));
    const ann = JSON.parse(readFileSync(join(duplicated.root, "set", "annotations.json"), "utf8"));
    writeFileSync(join(duplicated.root, "set", "annotations.json"), JSON.stringify([...ann, ann[0]]));
    const before = duplicated.snapshot();
    const d = importReadings(
      duplicated.root,
      "docs/reviews/x.md",
      join(duplicated.root, "set"),
      join(duplicated.root, "pending"),
    );
    expect("problems" in d && d.problems).toContain("a.eml: annotated 2 times");
    expect(duplicated.snapshot()).toEqual(before);

    const pendingCopy = fixture(review(ASTRA, GOOD));
    const copied = JSON.parse(readFileSync(join(pendingCopy.root, "pending", "pending.json"), "utf8"));
    copied.pending.push(copied.pending[0]);
    writeFileSync(join(pendingCopy.root, "pending", "pending.json"), JSON.stringify(copied));
    const before3 = pendingCopy.snapshot();
    const c = importReadings(
      pendingCopy.root,
      "docs/reviews/x.md",
      join(pendingCopy.root, "set"),
      join(pendingCopy.root, "pending"),
    );
    expect("problems" in c && c.problems).toContain("c.eml: annotated 2 times");
    expect(pendingCopy.snapshot()).toEqual(before3);

    const across = fixture(review(ASTRA, GOOD));
    const set = JSON.parse(readFileSync(join(across.root, "set", "annotations.json"), "utf8"));
    const inPending = JSON.parse(readFileSync(join(across.root, "pending", "pending.json"), "utf8"));
    writeFileSync(
      join(across.root, "set", "annotations.json"),
      JSON.stringify([...set, inPending.pending[0].annotation]),
    );
    const before4 = across.snapshot();
    const x = importReadings(across.root, "docs/reviews/x.md", join(across.root, "set"), join(across.root, "pending"));
    expect("problems" in x && x.problems).toContain("c.eml: annotated 2 times");
    expect(across.snapshot()).toEqual(before4);

    const misbound = fixture(review(ASTRA, GOOD));
    const pending = JSON.parse(readFileSync(join(misbound.root, "pending", "pending.json"), "utf8"));
    pending.pending[0].path = "d.eml";
    writeFileSync(join(misbound.root, "pending", "pending.json"), JSON.stringify(pending));
    const before2 = misbound.snapshot();
    const m = importReadings(
      misbound.root,
      "docs/reviews/x.md",
      join(misbound.root, "set"),
      join(misbound.root, "pending"),
    );
    expect("problems" in m && m.problems).toContain("pending d.eml: its annotation belongs to c.eml");
    expect(misbound.snapshot()).toEqual(before2);
  });
});

describe("what the command says", () => {
  it("names each disagreement still needing settling, and none when all agree", () => {
    const mixed = fixture(review(ASTRA, GOOD));
    const m = report(
      importReadings(mixed.root, "docs/reviews/x.md", join(mixed.root, "set"), join(mixed.root, "pending")),
    );
    expect(m.out[0]).toBe("import-readings: 3 readings written (1 agree, 2 disagree)");
    expect(m.out.join("\n")).toMatch(/1 disagreements on labels still in their set need settling[\s\S]*b\.eml/);
    expect(m.out.join("\n")).not.toMatch(/c\.eml/);
    const agreed = fixture(review(ASTRA, ["- `a.eml`: agree", "- `b.eml`: agree", "- `c.eml`: agree"]));
    const a = report(
      importReadings(agreed.root, "docs/reviews/x.md", join(agreed.root, "set"), join(agreed.root, "pending")),
    );
    expect(a.out).toEqual(["import-readings: 3 readings written (3 agree, 0 disagree)"]);
    expect(a.code).toBe(0);
  });
});
