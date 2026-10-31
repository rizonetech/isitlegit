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
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
          const found = pendingAnnotations.find((p) => p.annotation.path === e.path);
          return found ? { ...e, annotation: { ...found.annotation, second_reading: reading(e.path) } } : e;
        }),
      }
    : null;
  return { annotations: parsed.map((a) => ({ ...a, second_reading: reading(a.path) })), pending: nextPending };
}

const writeJson = (file: string, data: unknown) => {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
};

// The whole import: read, check, and only then write both files. Answers the problems, or null.
export function importReadings(
  root: string,
  findings: string,
  setDir: string,
  pendingDir: string | null,
): string[] | null {
  const readings = readVerdicts(readFileSync(join(root, findings), "utf8"), findings);
  if ("problems" in readings) return readings.problems;
  const annotationsFile = join(setDir, "annotations.json");
  const pendingFile = pendingDir ? join(pendingDir, "pending.json") : null;
  const annotations = existsSync(annotationsFile)
    ? (JSON.parse(readFileSync(annotationsFile, "utf8")) as unknown[])
    : [];
  const pending =
    pendingFile && existsSync(pendingFile) ? (JSON.parse(readFileSync(pendingFile, "utf8")) as PendingFile) : null;
  const applied = applyVerdicts(readings, annotations, pending, pinnedReviewers(root));
  if ("problems" in applied) return applied.problems;
  writeJson(annotationsFile, applied.annotations);
  if (pendingFile && applied.pending) writeJson(pendingFile, applied.pending);
  return null;
}

if (import.meta.filename === process.argv[1]) {
  const [findings, setDir, pendingDir] = process.argv.slice(2);
  if (!findings || !setDir || process.argv.length > 5) {
    console.error("usage: node eval/import-readings.ts <findings file> <set folder> [<pending folder>]");
    process.exit(2);
  }
  // Paths are read from the directory the command runs in, the repository root.
  const root = process.cwd();
  let problems: string[] | null;
  try {
    problems = importReadings(root, findings, resolve(root, setDir), pendingDir ? resolve(root, pendingDir) : null);
  } catch (error) {
    problems = [`${(error as Error).message}`];
  }
  if (problems) {
    console.error(`import-readings: nothing written:\n${problems.map((p) => `  ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("import-readings: every annotation read a second time");
}
