// D08 T01 §2: every evaluation set is recorded in eval/DATASETS.md with its licence, every corpus considered has a
// decision, an accepted corpus's licence obligations are met in its set, and every sample is mail intake can read.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PostalMime from "postal-mime";
import { afterAll, describe, expect, it } from "vitest";
import { loadSets } from "../../eval/load.ts";

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
// Licences whose terms require credit and the licence text to travel with the copies.
const ATTRIBUTION = /^CC BY\b/;

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
    if (ATTRIBUTION.test(licence)) {
      if (!existsSync(join(setsRoot, folder, "LICENSE.txt")))
        problems.push(`${folder}: its licence text is not kept beside it`);
      const notice = join(setsRoot, folder, "NOTICE.md");
      if (!existsSync(notice) || !/attribution/i.test(readFileSync(notice, "utf8")))
        problems.push(`${folder}: no attribution notice`);
    }
  }
  for (const name of named.keys()) if (!folders.includes(name)) problems.push(`${name}: a row with no set folder`);
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
    expect(problems).toEqual([]);
  }, 60_000);
});

describe("the datasets check", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const eml = "From: A <a@example.invalid>\r\nTo: b@example.invalid\r\nSubject: s\r\n\r\nbody\r\n";
  const label = (path: string) => ({
    path,
    label: "attack",
    category: "credential-phishing",
    expected: ["sender.reply_to"],
    source: "x",
  });
  // A sets root with one set, `alpha`, of `n` samples, and its licence files.
  function root(n = 2, files: { license?: boolean; notice?: string | null } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "eval-doc-"));
    dirs.push(dir);
    mkdirSync(join(dir, "alpha"));
    for (let i = 0; i < n; i++) writeFileSync(join(dir, "alpha", `${i}.eml`), eml);
    writeFileSync(
      join(dir, "alpha", "labels.json"),
      JSON.stringify(Array.from({ length: n }, (_, i) => label(`${i}.eml`))),
    );
    if (files.license !== false) writeFileSync(join(dir, "alpha", "LICENSE.txt"), "CC BY 4.0");
    if (files.notice !== null)
      writeFileSync(join(dir, "alpha", "NOTICE.md"), files.notice ?? "Attribution: the corpus.");
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
  });

  it("finds an empty or unparseable sample", async () => {
    const dir = root(1);
    writeFileSync(join(dir, "alpha", "0.eml"), "");
    expect(await mailProblem(join(dir, "alpha", "0.eml"))).toBe("empty");
    writeFileSync(join(dir, "alpha", "0.eml"), "not a message at all");
    expect(await mailProblem(join(dir, "alpha", "0.eml"))).toMatch(/no sender|no body|does not parse/);
  });
});
