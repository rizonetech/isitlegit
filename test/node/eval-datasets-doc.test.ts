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
// Licences whose terms require credit and the licence text to travel with the copies, with the title their full text
// carries, so a placeholder licence file never passes for the real one.
const ATTRIBUTION: Record<string, string> = {
  "CC BY 4.0": "Creative Commons Attribution 4.0 International Public License",
};

// An attribution licence's obligations met in a folder: its full licence text, and a notice crediting the source by its
// URL, naming the licence and saying what was changed. Each problem named.
function obligationProblems(folder: string, dir: string, licence: string, sourceUrl: string | undefined): string[] {
  const problems: string[] = [];
  const title = ATTRIBUTION[licence];
  if (!title) return problems;
  const licenceFile = join(dir, "LICENSE.txt");
  if (!existsSync(licenceFile) || !readFileSync(licenceFile, "utf8").includes(title))
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
    if (files.license !== false)
      writeFileSync(
        join(dir, "alpha", "LICENSE.txt"),
        files.licenseText ?? "Creative Commons Attribution 4.0 International Public License",
      );
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
    writeFileSync(join(pending, "LICENSE.txt"), "Creative Commons Attribution 4.0 International Public License");
    writeFileSync(
      join(pending, "NOTICE.md"),
      "Attribution: https://example.invalid/corpus under CC BY 4.0.\n\nChanges: none.\n",
    );
    writeFileSync(join(pending, "9.eml"), eml);
    writeFileSync(join(pending, "pending.json"), JSON.stringify({ pending: [{ path: "9.eml" }] }));
    expect(datasetProblems(doc(good), dir)).toEqual([]);
    writeFileSync(join(pending, "8.eml"), eml);
    expect(datasetProblems(doc(good), dir)).toContain("pending/alpha: pending.json does not list its files");
  });

  it("finds an empty or unparseable sample", async () => {
    const dir = root(1);
    writeFileSync(join(dir, "alpha", "0.eml"), "");
    expect(await mailProblem(join(dir, "alpha", "0.eml"))).toBe("empty");
    writeFileSync(join(dir, "alpha", "0.eml"), "not a message at all");
    expect(await mailProblem(join(dir, "alpha", "0.eml"))).toMatch(/no sender|no body|does not parse/);
  });
});
