// D08 T01 §2: every evaluation set is recorded in eval/DATASETS.md with its licence, every corpus considered has a
// decision, an accepted corpus's licence obligations are met in its set, and every sample is mail intake can read.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PostalMime from "postal-mime";
import { afterAll, describe, expect, it } from "vitest";
import { loadSets } from "../../eval/load.ts";
import { Annotation } from "../../eval/schema.ts";

const ROOT = join(import.meta.dirname, "..", "..");

// A Markdown table's rows after its header line, each split into trimmed cells.
function tableRows(text: string, header: string): string[][] {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trim() === header);
  if (at < 0) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(
      line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  }
  return rows;
}

const SETS_HEADER = "| Source | Licence | URL | Date | Count | Use |";
const CANDIDATES_HEADER = "| Corpus | Licence | URL | Read on | Decision | Why | Obligations |";
// Licences whose terms require credit and the licence text to travel with the copies, with the title their full text
// carries, so a placeholder licence file never passes for the real one.
// The full text is checked by its eight sections and its length, so a file holding only the title is refused (round 1).
const ATTRIBUTION: Record<string, { title: string; sections: string[]; minLength: number }> = {
  "CC BY 4.0": {
    title: "Creative Commons Attribution 4.0 International Public License",
    sections: [
      "Definitions",
      "Scope",
      "License Conditions",
      "Sui Generis Database Rights",
      "Disclaimer of Warranties",
      "Term and Termination",
      "Other Terms and Conditions",
      "Interpretation",
    ],
    minLength: 15_000,
  },
};
const fullLicence = (text: string, terms: { title: string; sections: string[]; minLength: number }) =>
  text.includes(terms.title) &&
  text.length >= terms.minLength &&
  terms.sections.every((name, i) => new RegExp(`^\\s*Section ${i + 1}\\W+${name}`, "m").test(text));

// An attribution licence's obligations met in a folder: its full licence text, and a notice crediting the source by its
// URL, naming the licence and saying what was changed. Each problem named.
function obligationProblems(folder: string, dir: string, licence: string, sourceUrl: string | undefined): string[] {
  const problems: string[] = [];
  const terms = ATTRIBUTION[licence];
  if (!terms) return problems;
  const licenceFile = join(dir, "LICENSE.txt");
  if (!existsSync(licenceFile) || !fullLicence(readFileSync(licenceFile, "utf8"), terms))
    problems.push(`${folder}: its licence text is not kept beside it`);
  const notice = join(dir, "NOTICE.md");
  const text = existsSync(notice) ? readFileSync(notice, "utf8") : "";
  if (!/attribution/i.test(text)) problems.push(`${folder}: no attribution notice`);
  else {
    if (!sourceUrl || !text.includes(sourceUrl))
      problems.push(`${folder}: the notice does not credit the source's URL`);
    if (!text.includes(licence)) problems.push(`${folder}: the notice does not name the licence`);
    if (!/^Changes:/m.test(text)) problems.push(`${folder}: the notice does not say what was changed`);
  }
  return problems;
}

// What is wrong with a sets root and its DATASETS.md, each problem named.
function datasetProblems(doc: string, setsRoot: string): string[] {
  const problems: string[] = [];
  const refs = new Map([...doc.matchAll(/^\[([^\]]+)\]:\s*(\S+)/gm)].map((m) => [m[1] as string, m[2] as string]));
  const url = (cell: string) => {
    const ref = cell.match(/^\[[^\]]*\]\[([^\]]+)\]$/)?.[1];
    return ref ? refs.get(ref) : /^https?:\/\//.test(cell) ? cell : undefined;
  };
  const rows = tableRows(doc, SETS_HEADER);
  const named = new Map(rows.map((r) => [(r[0] ?? "").replace(/`/g, ""), r]));
  const folders = existsSync(setsRoot)
    ? readdirSync(setsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];
  const sets = folders.length ? loadSets(setsRoot) : [];
  for (const folder of folders) {
    const row = named.get(folder);
    if (!row) {
      problems.push(`${folder}: no row in the sets table`);
      continue;
    }
    const [, licence = "", link = "", , count = ""] = row;
    if (!licence || licence === "none") problems.push(`${folder}: no licence`);
    if (!url(link)) problems.push(`${folder}: no URL`);
    const samples = sets.find((s) => s.name === folder)?.samples ?? [];
    const [, total, genuine] = count.match(/^(\d+) \((\d+) genuine\)$/) ?? [];
    if (Number(total) !== samples.length)
      problems.push(`${folder}: Count says ${total ?? count}, labels hold ${samples.length}`);
    const realGenuine = samples.filter((s) => s.label === "genuine").length;
    if (Number(genuine) !== realGenuine)
      problems.push(`${folder}: Count says ${genuine ?? "?"} genuine, labels hold ${realGenuine}`);
    problems.push(...obligationProblems(folder, join(setsRoot, folder), licence, url(link)));
    problems.push(...annotationProblems(join(setsRoot, folder), samples, join(setsRoot, "..", "pending", folder)));
    // Messages drawn with this set but waiting for labels keep the same obligations, and a manifest naming each.
    const pending = join(setsRoot, "..", "pending", folder);
    if (existsSync(pending)) {
      problems.push(...obligationProblems(`pending/${folder}`, pending, licence, url(link)));
      const files = readdirSync(pending)
        .filter((f) => f.endsWith(".eml"))
        .sort();
      let listed: string[] = [];
      try {
        const manifest = JSON.parse(readFileSync(join(pending, "pending.json"), "utf8")) as {
          pending: { path: string }[];
        };
        listed = manifest.pending.map((p) => p.path).sort();
      } catch {
        problems.push(`pending/${folder}: no readable pending.json`);
      }
      if (JSON.stringify(listed) !== JSON.stringify(files))
        problems.push(`pending/${folder}: pending.json does not list its files`);
      if (listed.length === files.length)
        problems.push(
          ...drawProblems(join(setsRoot, folder), pending, sets.find((s) => s.name === folder)?.samples ?? []),
        );
    }
  }
  for (const name of named.keys()) if (!folders.includes(name)) problems.push(`${name}: a row with no set folder`);
  // A pending folder needs the record its set has: one with no sets row is unrecorded mail (round 1).
  const pendingRoot = join(setsRoot, "..", "pending");
  if (existsSync(pendingRoot))
    for (const d of readdirSync(pendingRoot, { withFileTypes: true }))
      if (d.isDirectory() && !named.has(d.name)) problems.push(`pending/${d.name}: no row in the sets table`);
  const candidates = tableRows(doc, CANDIDATES_HEADER);
  for (const [corpus = "", licence = "", link = "", , decision = "", , obligations = ""] of candidates) {
    if (decision !== "accept" && decision !== "reject") problems.push(`${corpus}: no decision`);
    if (!licence) problems.push(`${corpus}: no licence recorded`);
    if (!url(link)) problems.push(`${corpus}: no URL`);
    if (decision === "accept" && !obligations) problems.push(`${corpus}: no obligations recorded`);
    if (decision === "accept" && ![...named.values()].some((r) => r[1] === licence))
      problems.push(`${corpus}: accepted but no set carries its licence`);
  }
  return problems;
}

// A draw recorded in `<pending>/draw.json` reconciled against its labelled set and its pending manifest (D08 T01 §4):
// every drawn message exactly once, its bytes unchanged, a reason for each still pending, and the manifest's count true.
function drawProblems(setDir: string, pendingDir: string, labels: { path: string; source: string }[]): string[] {
  const problems: string[] = [];
  const drawFile = join(pendingDir, "draw.json");
  if (!existsSync(drawFile)) return problems;
  const draw = (
    JSON.parse(readFileSync(drawFile, "utf8")) as { draw: { message: number; path: string; sha256: string }[] }
  ).draw;
  const manifest = JSON.parse(readFileSync(join(pendingDir, "pending.json"), "utf8")) as {
    labelled: number;
    pending: { path: string; reason: string }[];
  };
  const labelled = labels.map((l) => ({ path: l.path, message: Number(l.source.match(/message (\d+)/)?.[1]) }));
  for (const d of draw) {
    const inSet = labelled.filter((l) => l.message === d.message);
    const inPending = manifest.pending.filter((p) => p.path === d.path);
    if (inSet.length + inPending.length !== 1)
      problems.push(
        `message ${d.message}: ${inSet.length + inPending.length} times across the set and pending, not once`,
      );
    // The label for this message must be the drawn file itself: its path the draw's, so labels cannot trade files.
    for (const l of inSet)
      if (l.path !== d.path)
        problems.push(`message ${d.message}: labelled on ${l.path}, but it was drawn as ${d.path}`);
    const file = inSet.length ? join(setDir, d.path) : join(pendingDir, d.path);
    if (!existsSync(file) || createHash("sha256").update(readFileSync(file)).digest("hex") !== d.sha256)
      problems.push(`message ${d.message}: its bytes are not the ones drawn`);
  }
  for (const l of labelled)
    if (!draw.some((d) => d.message === l.message)) problems.push(`${l.path}: labelled but not in the draw`);
  for (const p of manifest.pending)
    if (p.reason.trim().length < 20) problems.push(`${p.path}: pending without a reason`);
  if (manifest.labelled !== labels.length)
    problems.push(`pending.json counts ${manifest.labelled} labelled, the set holds ${labels.length}`);
  return problems;
}

// The reviewers the pin names: a second reading must be one of theirs, never the writer's.
const PIN_REVIEWERS = [
  ...readFileSync(join(ROOT, ".conclave", "reviewers.toml"), "utf8").matchAll(/^\[reviewers\.([\w-]+)\]/gm),
].map((m) => m[1] as string);

// A second reading backed by its review: a pinned reviewer (never the reader), and the named findings file's heading
// holding this path's verdict, equal to the one recorded. Each problem named.
function readingProblems(a: Annotation, root: string, reviewers: string[], inSet: boolean): string[] {
  const r = a.second_reading;
  if (!r) return [`${a.path}: awaiting a second reading`];
  const problems: string[] = [];
  if (!reviewers.includes(r.reviewer) || r.reviewer === a.reader || r.reviewer === "claude")
    problems.push(`${a.path}: read a second time by ${r.reviewer}, not the pinned reviewer`);
  const [file = "", heading = ""] = r.review.split("#");
  const text = existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : "";
  const at = text.split("\n").findIndex((l) => l.replace(/^#+\s*/, "").trim() === heading.trim());
  const section = at < 0 ? [] : text.split("\n").slice(at + 1);
  const end = section.findIndex((l) => /^## /.test(l));
  const lines = end < 0 ? section : section.slice(0, end);
  const escaped = a.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const verdict = lines
    .map((l) => l.match(new RegExp(`\`?${escaped}\`?\\s*:\\s*(agree|disagree)\\b`))?.[1])
    .find(Boolean);
  if (!verdict) problems.push(`${a.path}: ${r.review} holds no verdict for it`);
  else if (verdict !== r.verdict) problems.push(`${a.path}: recorded ${r.verdict}, but the review says ${verdict}`);
  if (inSet && r.verdict === "disagree" && !a.resolution) problems.push(`${a.path}: disputed with no resolution`);
  return problems;
}

// A set's annotations: one for each `model`-basis label, none for anything else, each read a second time.
function annotationProblems(
  setDir: string,
  labels: { path: string; basis?: string | undefined }[],
  pendingDir: string,
  root = ROOT,
  reviewers = PIN_REVIEWERS,
): string[] {
  const problems: string[] = [];
  const file = join(setDir, "annotations.json");
  const model = labels.filter((l) => l.basis === "model").map((l) => l.path);
  if (!existsSync(file)) return model.map((p) => `${p}: no annotation`);
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown[];
  const annotations: Annotation[] = [];
  for (const [i, entry] of raw.entries()) {
    const parsed = Annotation.safeParse(entry);
    if (parsed.success) annotations.push(parsed.data);
    else problems.push(`annotation ${i}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  const seen = new Set<string>();
  for (const a of annotations) {
    if (seen.has(a.path)) problems.push(`${a.path}: annotated twice`);
    seen.add(a.path);
    if (!labels.some((l) => l.path === a.path)) problems.push(`${a.path}: an annotation for no label`);
    problems.push(...readingProblems(a, root, reviewers, true));
  }
  for (const p of model) if (!seen.has(p)) problems.push(`${p}: no annotation`);
  // A label that left the set for pending keeps its whole annotation there.
  const manifest = join(pendingDir, "pending.json");
  if (existsSync(manifest))
    for (const entry of (JSON.parse(readFileSync(manifest, "utf8")) as { pending: { annotation?: unknown }[] }).pending)
      if (entry.annotation !== undefined) {
        const parsed = Annotation.safeParse(entry.annotation);
        if (!parsed.success) problems.push("a pending entry's annotation is malformed");
        else problems.push(...readingProblems(parsed.data, root, reviewers, false));
      }
  return problems;
}

// A sample intake can read: one email with a sender and a body.
async function mailProblem(file: string): Promise<string | null> {
  const bytes = readFileSync(file);
  if (bytes.length === 0) return "empty";
  try {
    const mail = await PostalMime.parse(bytes);
    if (!mail.from?.address && !mail.from?.name) return "no sender";
    if (!mail.text?.trim() && !mail.html?.trim()) return "no body";
    return null;
  } catch (error) {
    return `does not parse (${(error as Error).name})`;
  }
}

describe("the committed evaluation sets", () => {
  const doc = readFileSync(join(ROOT, "eval", "DATASETS.md"), "utf8");
  const root = join(ROOT, "eval", "sets");

  it("are each recorded with a licence, a URL and a true count, and every candidate has a decision", () => {
    expect(datasetProblems(doc, root)).toEqual([]);
  });

  it("hold only mail intake can read", async () => {
    const problems: string[] = [];
    for (const set of loadSets(root))
      for (const sample of set.samples) {
        const problem = await mailProblem(sample.file);
        if (problem) problems.push(`${sample.id}: ${problem}`);
      }
    // The messages waiting for labels too: they enter a set as they are.
    const pending = join(ROOT, "eval", "pending");
    if (existsSync(pending))
      for (const folder of readdirSync(pending))
        for (const file of readdirSync(join(pending, folder)).filter((f) => f.endsWith(".eml"))) {
          const problem = await mailProblem(join(pending, folder, file));
          if (problem) problems.push(`pending/${folder}/${file}: ${problem}`);
        }
    expect(problems).toEqual([]);
  }, 60_000);
});

describe("the datasets check", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  // The licence's full text as the committed set keeps it.
  const CC_BY_TEXT = readFileSync(join(ROOT, "eval", "sets", "nazario-2025", "LICENSE.txt"), "utf8");
  const eml = "From: A <a@example.invalid>\r\nTo: b@example.invalid\r\nSubject: s\r\n\r\nbody\r\n";
  const label = (path: string) => ({
    path,
    label: "attack",
    category: "credential-phishing",
    expected: ["sender.reply_to"],
    source: "x",
  });
  // A sets root with one set, `alpha`, of `n` samples, and its licence files.
  function root(n = 2, files: { license?: boolean; licenseText?: string; notice?: string | null } = {}) {
    // The sets root inside the test's own folder, so its `../pending` stays inside it too.
    const base = mkdtempSync(join(tmpdir(), "eval-doc-"));
    dirs.push(base);
    const dir = join(base, "sets");
    mkdirSync(join(dir, "alpha"), { recursive: true });
    for (let i = 0; i < n; i++) writeFileSync(join(dir, "alpha", `${i}.eml`), eml);
    writeFileSync(
      join(dir, "alpha", "labels.json"),
      JSON.stringify(Array.from({ length: n }, (_, i) => label(`${i}.eml`))),
    );
    if (files.license !== false) writeFileSync(join(dir, "alpha", "LICENSE.txt"), files.licenseText ?? CC_BY_TEXT);
    if (files.notice !== null)
      writeFileSync(
        join(dir, "alpha", "NOTICE.md"),
        files.notice ?? "# Attribution\n\nFrom https://example.invalid/corpus under CC BY 4.0.\n\nChanges: none.\n",
      );
    return dir;
  }
  const doc = (
    setRow: string | null,
    candidate = "| Alpha | CC BY 4.0 | [link][1] | 2026-10-31 | accept | ok | Credit |",
  ) =>
    [
      SETS_HEADER,
      "| --- | --- | --- | --- | --- | --- |",
      ...(setRow ? [setRow] : []),
      "",
      CANDIDATES_HEADER,
      "| --- | --- | --- | --- | --- | --- | --- |",
      candidate,
      "",
      "[1]: https://example.invalid/corpus",
    ].join("\n");
  const good = "| `alpha` | CC BY 4.0 | [link][1] | 2026-10-31 | 2 (0 genuine) | Attacks |";

  it("passes a recorded set", () => {
    expect(datasetProblems(doc(good), root())).toEqual([]);
  });

  it("fails a folder with no row, a row with no folder, a wrong count and a candidate with no decision", () => {
    expect(datasetProblems(doc(null), root())).toContain("alpha: no row in the sets table");
    expect(datasetProblems(doc(good.replace("`alpha`", "`beta`")), root())).toEqual(
      expect.arrayContaining(["alpha: no row in the sets table", "beta: a row with no set folder"]),
    );
    expect(datasetProblems(doc(good.replace("2 (0 genuine)", "3 (0 genuine)")), root())).toContain(
      "alpha: Count says 3, labels hold 2",
    );
    expect(
      datasetProblems(doc(good, "| Alpha | CC BY 4.0 | [link][1] | 2026-10-31 | maybe | ok | Credit |"), root()),
    ).toContain("Alpha: no decision");
  });

  it("fails an attribution licence whose text or notice is not kept with the set", () => {
    expect(datasetProblems(doc(good), root(2, { license: false }))).toContain(
      "alpha: its licence text is not kept beside it",
    );
    expect(datasetProblems(doc(good), root(2, { notice: null }))).toContain("alpha: no attribution notice");
    expect(datasetProblems(doc(good), root(2, { notice: "Just files." }))).toContain("alpha: no attribution notice");
    // The contents, not only the files: an empty licence, a notice without the source, the licence or the changes.
    expect(datasetProblems(doc(good), root(2, { licenseText: "" }))).toContain(
      "alpha: its licence text is not kept beside it",
    );
    expect(
      datasetProblems(
        doc(good),
        root(2, { licenseText: "Creative Commons Attribution 4.0 International Public License" }),
      ),
    ).toContain("alpha: its licence text is not kept beside it");
    expect(datasetProblems(doc(good), root(2, { notice: "Attribution.\n\nCC BY 4.0\n\nChanges: none.\n" }))).toContain(
      "alpha: the notice does not credit the source's URL",
    );
    expect(
      datasetProblems(
        doc(good),
        root(2, { notice: "Attribution: https://example.invalid/corpus\n\nChanges: none.\n" }),
      ),
    ).toContain("alpha: the notice does not name the licence");
    expect(
      datasetProblems(doc(good), root(2, { notice: "Attribution: https://example.invalid/corpus under CC BY 4.0.\n" })),
    ).toContain("alpha: the notice does not say what was changed");
  });

  it("holds pending messages to the same obligations and a manifest that lists them", () => {
    const dir = root();
    const pending = join(dir, "..", "pending", "alpha");
    mkdirSync(pending, { recursive: true });
    writeFileSync(join(pending, "LICENSE.txt"), CC_BY_TEXT);
    writeFileSync(
      join(pending, "NOTICE.md"),
      "Attribution: https://example.invalid/corpus under CC BY 4.0.\n\nChanges: none.\n",
    );
    writeFileSync(join(pending, "9.eml"), eml);
    writeFileSync(join(pending, "pending.json"), JSON.stringify({ pending: [{ path: "9.eml" }] }));
    expect(datasetProblems(doc(good), dir)).toEqual([]);
    writeFileSync(join(pending, "8.eml"), eml);
    expect(datasetProblems(doc(good), dir)).toContain("pending/alpha: pending.json does not list its files");
    // A pending folder no set row records.
    mkdirSync(join(dir, "..", "pending", "stray"));
    writeFileSync(join(dir, "..", "pending", "stray", "1.eml"), eml);
    expect(datasetProblems(doc(good), dir)).toContain("pending/stray: no row in the sets table");
  });

  it("reconciles a draw: every drawn message once, its bytes unchanged, a reason for each pending one", () => {
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    // A draw of three: messages 1 and 2 labelled in `alpha`, message 3 pending.
    const setup = (change: (base: string) => void = () => {}) => {
      const dir = root(2);
      const base = join(dir, "..");
      writeFileSync(
        join(dir, "alpha", "labels.json"),
        JSON.stringify([0, 1].map((i) => ({ ...label(`${i}.eml`), source: `corpus, message ${i + 1}` }))),
      );
      const pending = join(base, "pending", "alpha");
      mkdirSync(pending, { recursive: true });
      writeFileSync(join(pending, "LICENSE.txt"), CC_BY_TEXT);
      writeFileSync(
        join(pending, "NOTICE.md"),
        "Attribution: https://example.invalid/corpus under CC BY 4.0.\n\nChanges: none.\n",
      );
      writeFileSync(join(pending, "2.eml"), eml);
      writeFileSync(
        join(pending, "pending.json"),
        JSON.stringify({
          labelled: 2,
          pending: [{ path: "2.eml", message: 3, reason: "unclear on reading: a test message" }],
        }),
      );
      writeFileSync(
        join(pending, "draw.json"),
        JSON.stringify({ draw: [0, 1, 2].map((i) => ({ message: i + 1, path: `${i}.eml`, sha256: sha(eml) })) }),
      );
      change(base);
      return dir;
    };
    expect(datasetProblems(doc(good), setup())).toEqual([]);
    // Dropped: message 3 deleted with its manifest entry.
    const dropped = setup((base) => {
      rmSync(join(base, "pending", "alpha", "2.eml"));
      writeFileSync(join(base, "pending", "alpha", "pending.json"), JSON.stringify({ labelled: 2, pending: [] }));
    });
    expect(datasetProblems(doc(good), dropped)).toContain("message 3: 0 times across the set and pending, not once");
    // Duplicated: message 3 also labelled in the set.
    const duplicated = setup((base) => {
      writeFileSync(join(base, "sets", "alpha", "2.eml"), eml);
      writeFileSync(
        join(base, "sets", "alpha", "labels.json"),
        JSON.stringify([0, 1, 2].map((i) => ({ ...label(`${i}.eml`), source: `corpus, message ${i + 1}` }))),
      );
    });
    expect(datasetProblems(doc(good.replace("2 (0 genuine)", "3 (0 genuine)")), duplicated)).toContain(
      "message 3: 2 times across the set and pending, not once",
    );
    // A changed byte in a labelled message.
    const changed = setup((base) => writeFileSync(join(base, "sets", "alpha", "0.eml"), `${eml} `));
    expect(datasetProblems(doc(good), changed)).toContain("message 1: its bytes are not the ones drawn");
    // Two labels trading files: each label's source names one message, its path the other's.
    const swapped = setup((base) =>
      writeFileSync(
        join(base, "sets", "alpha", "labels.json"),
        JSON.stringify([
          { ...label("1.eml"), source: "corpus, message 1" },
          { ...label("0.eml"), source: "corpus, message 2" },
        ]),
      ),
    );
    expect(datasetProblems(doc(good), swapped)).toEqual(
      expect.arrayContaining([
        "message 1: labelled on 1.eml, but it was drawn as 0.eml",
        "message 2: labelled on 0.eml, but it was drawn as 1.eml",
      ]),
    );
    // A pending message without a reason.
    const reasonless = setup((base) =>
      writeFileSync(
        join(base, "pending", "alpha", "pending.json"),
        JSON.stringify({ labelled: 2, pending: [{ path: "2.eml", message: 3, reason: "" }] }),
      ),
    );
    expect(datasetProblems(doc(good), reasonless)).toContain("2.eml: pending without a reason");
  });

  it("holds every model label to an annotation read a second time by the pinned reviewer, backed by its review", () => {
    const base = mkdtempSync(join(tmpdir(), "eval-ann-"));
    dirs.push(base);
    const setDir = join(base, "set");
    mkdirSync(setDir);
    mkdirSync(join(base, "docs", "reviews"), { recursive: true });
    const review = "docs/reviews/x.md#Completion review";
    writeFileSync(
      join(base, "docs", "reviews", "x.md"),
      "## Completion review\n\n- `a.eml`: agree\n- `b.eml`: disagree: it is impersonation\n\n## Round 1\n- `c.eml`: agree\n",
    );
    const labels = [
      { path: "a.eml", basis: "model" },
      { path: "b.eml", basis: "model" },
    ];
    const reading = (verdict: "agree" | "disagree", reviewer = "astra", where = review) => ({
      reviewer,
      review: where,
      verdict,
      note: "",
    });
    const ann = (path: string, second: unknown, resolution: string | null = null) => ({
      path,
      rationale: "A rationale long enough to read as one.",
      reader: "claude",
      date: "2026-10-31",
      second_reading: second,
      resolution,
    });
    const check = (annotations: unknown[], pending: unknown[] = []) => {
      writeFileSync(join(setDir, "annotations.json"), JSON.stringify(annotations));
      const pendingDir = join(base, "pending");
      mkdirSync(pendingDir, { recursive: true });
      writeFileSync(join(pendingDir, "pending.json"), JSON.stringify({ pending }));
      return annotationProblems(setDir, labels, pendingDir, base, ["astra", "wonder"]);
    };
    const good = [
      ann("a.eml", reading("agree")),
      ann("b.eml", reading("disagree"), "Relabelled as impersonation after the review."),
    ];
    expect(check(good)).toEqual([]);
    expect(check([good[0]])).toContain("b.eml: no annotation");
    expect(check([...good, ann("z.eml", reading("agree"))])).toContain("z.eml: an annotation for no label");
    expect(check([...good, good[0]])).toContain("a.eml: annotated twice");
    expect(check([ann("a.eml", null), good[1]])).toContain("a.eml: awaiting a second reading");
    expect(check([ann("a.eml", reading("agree", "claude")), good[1]])).toContain(
      "a.eml: read a second time by claude, not the pinned reviewer",
    );
    expect(check([ann("a.eml", reading("agree", "astra", "docs/reviews/x.md#Round 1")), good[1]])).toContain(
      "a.eml: docs/reviews/x.md#Round 1 holds no verdict for it",
    );
    expect(check([ann("a.eml", reading("disagree")), good[1]])).toContain(
      "a.eml: recorded disagree, but the review says agree",
    );
    expect(check([good[0], ann("b.eml", reading("disagree"))])).toContain("b.eml: disputed with no resolution");
  });

  it("keeps a disputed label's whole annotation and unchanged file when it moves to pending", () => {
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    const dir = root(1);
    const base = join(dir, "..");
    mkdirSync(join(base, "docs", "reviews"), { recursive: true });
    writeFileSync(join(base, "docs", "reviews", "x.md"), "## Completion review\n- `1.eml`: disagree: unclear\n");
    // Message 2 was labelled, disputed, and moved back to pending with its record.
    writeFileSync(
      join(dir, "alpha", "labels.json"),
      JSON.stringify([{ ...label("0.eml"), source: "corpus, message 1" }]),
    );
    const pending = join(base, "pending", "alpha");
    mkdirSync(pending, { recursive: true });
    writeFileSync(join(pending, "LICENSE.txt"), CC_BY_TEXT);
    writeFileSync(
      join(pending, "NOTICE.md"),
      "Attribution: https://example.invalid/corpus under CC BY 4.0.\n\nChanges: none.\n",
    );
    writeFileSync(join(pending, "1.eml"), eml);
    const annotation = {
      path: "1.eml",
      rationale: "A rationale long enough to read as one.",
      reader: "claude",
      date: "2026-10-31",
      second_reading: {
        reviewer: "astra",
        review: "docs/reviews/x.md#Completion review",
        verdict: "disagree",
        note: "unclear",
      },
      resolution: null,
    };
    writeFileSync(
      join(pending, "pending.json"),
      JSON.stringify({
        labelled: 1,
        pending: [{ path: "1.eml", message: 2, reason: "disputed on its second reading", annotation }],
      }),
    );
    writeFileSync(
      join(pending, "draw.json"),
      JSON.stringify({ draw: [0, 1].map((i) => ({ message: i + 1, path: `${i}.eml`, sha256: sha(eml) })) }),
    );
    const problems = annotationProblems(join(dir, "alpha"), [{ path: "0.eml" }], pending, base, ["astra"]);
    expect(problems).toEqual([]);
    expect(datasetProblems(doc(good.replace("2 (0 genuine)", "1 (0 genuine)")), dir)).toEqual([]);
  });

  it("finds an empty or unparseable sample", async () => {
    const dir = root(1);
    writeFileSync(join(dir, "alpha", "0.eml"), "");
    expect(await mailProblem(join(dir, "alpha", "0.eml"))).toBe("empty");
    writeFileSync(join(dir, "alpha", "0.eml"), "not a message at all");
    expect(await mailProblem(join(dir, "alpha", "0.eml"))).toMatch(/no sender|no body|does not parse/);
  });
});
