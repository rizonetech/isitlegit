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
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
  for (const a of parsed) counts.set(a.path, (counts.get(a.path) ?? 0) + 1);
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
  | { written: true; agree: number; disagree: number; unresolved: string[] }
  | { written: false; problems: string[] }
  // A failure part-way through the two renames whose rollback also failed: what changed and how to restore it.
  | { written: "partly"; problems: string[] };

// Both files replaced, or neither: both temporary files are written first, then each renamed into place; when the
// second rename fails the first file is put back from what was read, and every temporary file is removed on every path.
function writeBoth(files: { file: string; text: string; before: string | null }[], fs: Fs): Outcome | null {
  const temps = files.map((f) => `${f.file}.${process.pid}.tmp`);
  const done: number[] = [];
  try {
    for (const [i, f] of files.entries()) fs.write(temps[i] as string, f.text);
    for (const [i, f] of files.entries()) {
      fs.rename(temps[i] as string, f.file);
      done.push(i);
    }
    return null;
  } catch (error) {
    const problems = [`the write failed (${(error as Error).message}); nothing is left changed`];
    for (const i of done) {
      const f = files[i] as { file: string; before: string | null };
      try {
        if (f.before === null) fs.remove(f.file);
        else {
          fs.write(`${f.file}.restore.tmp`, f.before);
          fs.rename(`${f.file}.restore.tmp`, f.file);
        }
      } catch (restoreError) {
        const backup = `${f.file}.before-import`;
        try {
          if (f.before !== null) fs.write(backup, f.before);
        } catch {
          // The backup is reported either way; its absence is in the message.
        }
        return {
          written: "partly",
          problems: [
            `the write failed (${(error as Error).message}) after ${f.file} was replaced, and putting it back failed (${(restoreError as Error).message})`,
            f.before === null ? `delete ${f.file} by hand` : `restore it from ${backup}`,
          ],
        };
      }
    }
    return { written: false, problems };
  } finally {
    for (const t of temps) {
      try {
        fs.remove(t);
      } catch {
        // A temporary file that cannot be removed is harmless beside the real one and named by its pid.
      }
    }
  }
}

// The whole import: read, check, and only then write both files, together. Answers what happened.
export function importReadings(
  root: string,
  findings: string,
  setDir: string,
  pendingDir: string | null,
  fs: Fs = nodeFs,
): Outcome {
  const readings = readVerdicts(readFileSync(join(root, findings), "utf8"), findings);
  if ("problems" in readings) return { written: false, problems: readings.problems };
  const annotationsFile = join(setDir, "annotations.json");
  const pendingFile = pendingDir ? join(pendingDir, "pending.json") : null;
  const annotationsText = existsSync(annotationsFile) ? readFileSync(annotationsFile, "utf8") : null;
  const pendingText = pendingFile && existsSync(pendingFile) ? readFileSync(pendingFile, "utf8") : null;
  const annotations = annotationsText ? (JSON.parse(annotationsText) as unknown[]) : [];
  const pending = pendingText ? (JSON.parse(pendingText) as PendingFile) : null;
  const applied = applyVerdicts(readings, annotations, pending, pinnedReviewers(root));
  if ("problems" in applied) return { written: false, problems: applied.problems };
  const json = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`;
  const files = [{ file: annotationsFile, text: json(applied.annotations), before: annotationsText }];
  if (pendingFile && applied.pending)
    files.push({ file: pendingFile, text: json(applied.pending), before: pendingText });
  const failed = writeBoth(files, fs);
  if (failed) return failed;
  // A disagreement on a label still in its set needs a resolution, or the label moved to pending (D08 T01 §5).
  const unresolved = applied.annotations
    .filter((a) => a.second_reading?.verdict === "disagree" && !a.resolution)
    .map((a) => a.path);
  return {
    written: true,
    agree: readings.verdicts.filter((v) => v.verdict === "agree").length,
    disagree: readings.verdicts.filter((v) => v.verdict === "disagree").length,
    unresolved,
  };
}

// What the command prints for an outcome, and its exit code.
export function report(outcome: Outcome): { code: 0 | 1; out: string[]; err: string[] } {
  if (outcome.written === false)
    return { code: 1, out: [], err: ["import-readings: nothing written:", ...outcome.problems.map((p) => `  ${p}`)] };
  if (outcome.written === "partly")
    return {
      code: 1,
      out: [],
      err: ["import-readings: a file was changed and could not be put back:", ...outcome.problems.map((p) => `  ${p}`)],
    };
  const out = [
    `import-readings: ${outcome.agree + outcome.disagree} readings written (${outcome.agree} agree, ${outcome.disagree} disagree)`,
  ];
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
