// Second readings imported from a review (D08 T01 §6): the pinned reviewer's per-path verdicts, written by the review
// prompt's fixed form under a review's `### Second reading` heading, recorded into each annotation's `second_reading`
// with no hand transcription. The whole import is refused, and nothing written, on a missing, duplicate or unknown path
// or a malformed verdict line.
//
//   node eval/import-readings.ts <findings file> <set folder> [<pending folder>]
//
// The reviewer is read from the review's own heading (`## <kind>: <name> (...)`), never given on the command line, and
// must be one the pin names (`.conclave/reviewers.toml`), never the writer, `claude`. Every reading is validated by
// `SecondReading` before anything is written. Exit 0 when written, 1 when refused (each problem named, nothing written),
// 2 on bad arguments.
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Annotation, SecondReading } from "./schema.ts";

export const HEADING = "Second reading";
export type Verdict = { path: string; verdict: "agree" | "disagree"; note: string };
export type Readings = { reviewer: string; review: string; verdicts: Verdict[] };

// The review's verdicts: every line under `### Second reading` in the named findings file. Each fault named.
export function readVerdicts(findingsText: string, findingsPath: string): Readings | { problems: string[] } {
  const lines = findingsText.split("\n");
  const at = lines.findIndex((l) => /^#+\s/.test(l) && l.replace(/^#+\s*/, "").trim() === HEADING);
  if (at < 0) return { problems: [`${findingsPath} has no ### ${HEADING}`] };
  const reviewer = lines
    .slice(0, at)
    .reverse()
    .map((l) => l.match(/^## [^:]+: ([\w-]+) \(/)?.[1])
    .find(Boolean);
  if (!reviewer) return { problems: [`${findingsPath}: no review heading names who wrote the ${HEADING}`] };
  const problems: string[] = [];
  const verdicts: Verdict[] = [];
  for (const line of lines.slice(at + 1)) {
    if (/^#/.test(line)) break;
    if (!line.trim()) continue;
    const m = line.trim().match(/^- `([^`]+)`: (agree|disagree)(?:: (.*))?$/);
    if (!m) {
      problems.push(`a malformed verdict line: ${line.trim().slice(0, 120)}`);
      continue;
    }
    const verdict = m[2] as "agree" | "disagree";
    if (verdict === "disagree" && !m[3]?.trim()) problems.push(`${m[1]}: disagree with no reason`);
    verdicts.push({ path: m[1] as string, verdict, note: m[3] ?? "" });
  }
  return problems.length ? { problems } : { reviewer, review: `${findingsPath}#${HEADING}`, verdicts };
}

type PendingFile = { pending: { path: string; annotation?: unknown }[] } & Record<string, unknown>;

// Each verdict applied to its annotation (in the set, or a pending entry's): every annotation must get exactly one,
// and every verdict must name one. Answers the files to write, or the problems.
// The reviewers the pin names.
export const pinnedReviewers = (root: string) => {
  const pin = join(root, ".conclave", "reviewers.toml");
  return existsSync(pin)
    ? [...readFileSync(pin, "utf8").matchAll(/^\[reviewers\.([\w-]+)\]/gm)].map((m) => m[1] as string)
    : [];
};

export function applyVerdicts(
  readings: Readings,
  annotations: unknown[],
  pending: PendingFile | null,
  reviewers: string[],
): { annotations: Annotation[]; pending: PendingFile | null } | { problems: string[] } {
  const problems: string[] = [];
  if (!reviewers.includes(readings.reviewer) || readings.reviewer === "claude")
    problems.push(`${readings.review} is ${readings.reviewer}'s, not a pinned reviewer's`);
  const seen = new Map<string, number>();
  for (const v of readings.verdicts) seen.set(v.path, (seen.get(v.path) ?? 0) + 1);
  for (const [path, n] of seen) if (n > 1) problems.push(`${path}: ${n} verdicts`);
  const byPath = new Map(readings.verdicts.map((v) => [v.path, v]));
  const parsed: Annotation[] = [];
  for (const [i, raw] of annotations.entries()) {
    const a = Annotation.safeParse(raw);
    if (!a.success) problems.push(`annotation ${i}: malformed`);
    else parsed.push(a.data);
  }
  const pendingAnnotations = (pending?.pending ?? []).flatMap((e, i) => {
    if (e.annotation === undefined) return [];
    const a = Annotation.safeParse(e.annotation);
    if (!a.success) {
      problems.push(`pending ${e.path}: malformed annotation`);
      return [];
    }
    return [{ index: i, annotation: a.data }];
  });
  // One annotation per path, and a pending entry's annotation bound to its own entry.
  const counts = new Map<string, number>();
  for (const a of [...parsed, ...pendingAnnotations.map((p) => p.annotation)])
    counts.set(a.path, (counts.get(a.path) ?? 0) + 1);
  for (const [path, n] of counts) if (n > 1) problems.push(`${path}: annotated ${n} times`);
  for (const p of pendingAnnotations) {
    const entry = pending?.pending[p.index];
    if (entry && entry.path !== p.annotation.path)
      problems.push(`pending ${entry.path}: its annotation belongs to ${p.annotation.path}`);
  }
  const known = new Set([...parsed.map((a) => a.path), ...pendingAnnotations.map((p) => p.annotation.path)]);
  for (const path of seen.keys()) if (!known.has(path)) problems.push(`${path}: a verdict for no annotation`);
  for (const path of known) if (!byPath.has(path)) problems.push(`${path}: no verdict`);
  // Every reading as it would be written, validated first.
  for (const v of readings.verdicts) {
    const checked = SecondReading.safeParse({
      reviewer: readings.reviewer,
      review: readings.review,
      verdict: v.verdict,
      note: v.note,
    });
    if (!checked.success) problems.push(`${v.path}: ${checked.error.issues[0]?.message ?? "an invalid reading"}`);
  }
  if (problems.length) return { problems };
  const reading = (path: string) => {
    const v = byPath.get(path) as Verdict;
    return { reviewer: readings.reviewer, review: readings.review, verdict: v.verdict, note: v.note };
  };
  const nextPending = pending
    ? {
        ...pending,
        pending: pending.pending.map((e) => {
          const found = pendingAnnotations.find((p) => p.index === pending.pending.indexOf(e));
          return found ? { ...e, annotation: { ...found.annotation, second_reading: reading(e.path) } } : e;
        }),
      }
    : null;
  return { annotations: parsed.map((a) => ({ ...a, second_reading: reading(a.path) })), pending: nextPending };
}

// The file operations a write uses, injected so a test can fail any one of them.
export type Fs = {
  write: (file: string, text: string) => void;
  rename: (from: string, to: string) => void;
  remove: (file: string) => void;
};
const nodeFs: Fs = {
  write: (file, text) => writeFileSync(file, text),
  rename: (from, to) => renameSync(from, to),
  remove: (file) => rmSync(file, { force: true }),
};

export type Outcome =
  | { written: true; agree: number; disagree: number; unresolved: string[]; recovered: string[]; leftover: string[] }
  | { written: false; problems: string[]; recovered?: string[] }
  // A failure after a file was replaced whose rollback also failed: what changed and how it is restored.
  | { written: "partly"; problems: string[] };

// An import is a transaction recorded in a journal beside the set's annotations (`annotations.json.import-journal`),
// written before anything else: it names every file the import replaces (relative to the journal), whether each
// existed, and the state, `keeping` while the originals are kept as `<file>.before-import`, then `committed` once
// both files are in place. Any later run reads the journal, never its own arguments, so a retry with other arguments
// still settles the whole import: forward when committed (backups removed), otherwise back (originals restored).
export const backupOf = (file: string) => `${file}.before-import`;
export const journalOf = (annotationsFile: string) => `${annotationsFile}.import-journal`;
type Journal = { state: "keeping" | "committed"; files: { path: string; existed: boolean }[] };

const writeAtomic = (fs: Fs, file: string, text: string) => {
  fs.write(`${file}.tmp`, text);
  fs.rename(`${file}.tmp`, file);
};

// The interrupted import recorded beside these annotations settled as a whole. Answers the files restored.
export function recoverInterrupted(annotationsFile: string, fs: Fs): string[] {
  const journalFile = journalOf(annotationsFile);
  const dir = dirname(annotationsFile);
  // A journal's temporary file from a run killed while writing it: nothing was kept or replaced yet.
  if (existsSync(`${journalFile}.tmp`)) fs.remove(`${journalFile}.tmp`);
  if (!existsSync(journalFile)) return [];
  const journal = JSON.parse(readFileSync(journalFile, "utf8")) as Journal;
  const files = journal.files.map((f) => ({ file: resolve(dir, f.path), existed: f.existed }));
  for (const { file } of files) {
    // That run's own temporary files: `<file>.<pid>.tmp` and `<file>.before-import.tmp`.
    const ours = new RegExp(`^${basename(file).replace(/[.]/g, "\\.")}\\.(\\d+|before-import)\\.tmp$`);
    if (existsSync(dirname(file)))
      for (const entry of readdirSync(dirname(file))) if (ours.test(entry)) fs.remove(join(dirname(file), entry));
  }
  const restored: string[] = [];
  if (journal.state === "committed") for (const { file } of files) fs.remove(backupOf(file));
  else
    for (const { file, existed } of files) {
      if (existsSync(backupOf(file))) {
        fs.rename(backupOf(file), file);
        restored.push(file);
      } else if (!existed && existsSync(file)) {
        fs.remove(file);
        restored.push(file);
      }
    }
  fs.remove(journalFile);
  return restored;
}

const message = (error: unknown) => (error as Error).message;

// Both files replaced, or neither, across a failure or a kill: the journal first, then the new texts to temporary
// files and every original kept, then each renamed into place, then the journal marked committed, then the backups
// and the journal removed. A failure before the commit puts every original back; one after it leaves only harmless
// leftovers that the next run clears.
function writeBoth(
  annotationsFile: string,
  files: { file: string; text: string; before: string | null }[],
  fs: Fs,
): { failed: Outcome } | { leftover: string[] } {
  const journalFile = journalOf(annotationsFile);
  const dir = dirname(annotationsFile);
  const journal = (state: Journal["state"]): string =>
    `${JSON.stringify({ state, files: files.map((f) => ({ path: relative(dir, f.file), existed: f.before !== null })) }, null, 2)}\n`;
  const temps = files.map((f) => `${f.file}.${process.pid}.tmp`);
  const removeTemps = () => {
    for (const t of [...temps, ...files.map((f) => `${backupOf(f.file)}.tmp`), `${journalFile}.tmp`]) {
      try {
        fs.remove(t);
      } catch {
        // A leftover temporary file is named by its pid or suffix, never read as data, and cleared by the next run.
      }
    }
  };
  const nothingChanged = (error: unknown): { failed: Outcome } => ({
    failed: { written: false, problems: [`the write failed (${message(error)}); nothing is left changed`] },
  });
  try {
    writeAtomic(fs, journalFile, journal("keeping"));
  } catch (error) {
    removeTemps();
    return nothingChanged(error);
  }
  try {
    for (const [i, f] of files.entries()) fs.write(temps[i] as string, f.text);
    for (const f of files) if (f.before !== null) writeAtomic(fs, backupOf(f.file), f.before);
    for (const [i, f] of files.entries()) fs.rename(temps[i] as string, f.file);
    writeAtomic(fs, journalFile, journal("committed"));
  } catch (error) {
    try {
      recoverInterrupted(annotationsFile, fs);
    } catch (restoreError) {
      removeTemps();
      return {
        failed: {
          written: "partly",
          problems: [
            `the write failed (${message(error)}) and putting the originals back failed (${message(restoreError)})`,
            `the import is recorded in ${journalFile}, with each original beside its file as <file>.before-import; the next run of this command puts them back first`,
          ],
        },
      };
    }
    removeTemps();
    return nothingChanged(error);
  }
  // Committed: the backups go, then the journal, which stays while any backup does. Anything left is harmless: the
  // next run reads the committed journal and clears it.
  const leftover: string[] = [];
  for (const f of files) {
    if (f.before === null) continue;
    try {
      fs.remove(backupOf(f.file));
    } catch {
      leftover.push(backupOf(f.file));
    }
  }
  try {
    if (leftover.length === 0) fs.remove(journalFile);
    else leftover.push(journalFile);
  } catch {
    leftover.push(journalFile);
  }
  removeTemps();
  return { leftover };
}

// The whole import: read, check, and only then write both files, together. Answers what happened.
export function importReadings(
  root: string,
  findings: string,
  setDir: string,
  pendingDir: string | null,
  fs: Fs = nodeFs,
): Outcome {
  const annotationsFile = join(setDir, "annotations.json");
  const pendingFile = pendingDir ? join(pendingDir, "pending.json") : null;
  // An earlier interrupted import is settled, from its own journal, before anything is read.
  const recovered = recoverInterrupted(annotationsFile, fs);
  if (!existsSync(join(root, findings))) return { written: false, problems: [`${findings} does not exist`], recovered };
  const readings = readVerdicts(readFileSync(join(root, findings), "utf8"), findings);
  if ("problems" in readings) return { written: false, problems: readings.problems, recovered };
  const annotationsText = existsSync(annotationsFile) ? readFileSync(annotationsFile, "utf8") : null;
  const pendingText = pendingFile && existsSync(pendingFile) ? readFileSync(pendingFile, "utf8") : null;
  const annotations = annotationsText ? (JSON.parse(annotationsText) as unknown[]) : [];
  const pending = pendingText ? (JSON.parse(pendingText) as PendingFile) : null;
  const applied = applyVerdicts(readings, annotations, pending, pinnedReviewers(root));
  if ("problems" in applied) return { written: false, problems: applied.problems, recovered };
  const json = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`;
  const files = [{ file: annotationsFile, text: json(applied.annotations), before: annotationsText }];
  if (pendingFile && applied.pending)
    files.push({ file: pendingFile, text: json(applied.pending), before: pendingText });
  const written = writeBoth(annotationsFile, files, fs);
  if ("failed" in written) return written.failed;
  // A disagreement on a label still in its set needs a resolution, or the label moved to pending (D08 T01 §5).
  const unresolved = applied.annotations
    .filter((a) => a.second_reading?.verdict === "disagree" && !a.resolution)
    .map((a) => a.path);
  return {
    written: true,
    agree: readings.verdicts.filter((v) => v.verdict === "agree").length,
    disagree: readings.verdicts.filter((v) => v.verdict === "disagree").length,
    unresolved,
    recovered,
    leftover: written.leftover,
  };
}

// What the command prints for an outcome, and its exit code.
export function report(outcome: Outcome): { code: 0 | 1; out: string[]; err: string[] } {
  const recovered =
    "recovered" in outcome && outcome.recovered?.length
      ? [`import-readings: an interrupted import was undone first: ${outcome.recovered.join(", ")} put back`]
      : [];
  if (outcome.written === false)
    return {
      code: 1,
      out: [],
      err: [...recovered, "import-readings: nothing written:", ...outcome.problems.map((p) => `  ${p}`)],
    };
  if (outcome.written === "partly")
    return { code: 1, out: [], err: ["import-readings: not finished:", ...outcome.problems.map((p) => `  ${p}`)] };
  const out = [
    ...recovered,
    `import-readings: ${outcome.agree + outcome.disagree} readings written (${outcome.agree} agree, ${outcome.disagree} disagree)`,
  ];
  if (outcome.leftover.length)
    out.push(`  left beside the files, harmless, cleared by the next run: ${outcome.leftover.join(", ")}`);
  if (outcome.unresolved.length)
    out.push(
      `  ${outcome.unresolved.length} disagreements on labels still in their set need settling: correct each label with a resolution, or move it to pending with its annotation:`,
      ...outcome.unresolved.map((p) => `    ${p}`),
    );
  return { code: 0, out, err: [] };
}

if (import.meta.filename === process.argv[1]) {
  const [findings, setDir, pendingDir] = process.argv.slice(2);
  if (!findings || !setDir || process.argv.length > 5) {
    console.error("usage: node eval/import-readings.ts <findings file> <set folder> [<pending folder>]");
    process.exit(2);
  }
  // Paths are read from the directory the command runs in, the repository root.
  const root = process.cwd();
  let outcome: Outcome;
  try {
    outcome = importReadings(root, findings, resolve(root, setDir), pendingDir ? resolve(root, pendingDir) : null);
  } catch (error) {
    outcome = { written: false, problems: [(error as Error).message] };
  }
  const { code, out, err } = report(outcome);
  for (const line of out) console.log(line);
  for (const line of err) console.error(line);
  process.exit(code);
}
