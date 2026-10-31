// The evaluation sets (D08 T01 §1): each a folder under the root, `<root>/<name>/labels.json` beside the files it
// names. Each sample is known by its set and path (`<set>/<path>`) and carries its file's real location, so two sets may
// both hold `001.eml`. A load is refused whole, never partly, naming every problem in it at once: a root or set that is
// missing, empty or unreadable, labels.json that cannot be read as a list, and each label that is malformed, names no
// file, reaches outside its set (by its path or through a link), or repeats a path. Each problem names its set, the
// label's index and its path, `null` where there is none, and a filesystem failure keeps its code.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { Label } from "./schema";

export type Sample = Label & { id: string; set: string; file: string };
export type LoadedSet = { name: string; dir: string; samples: Sample[] };
export type Problem = { set: string | null; index: number | null; path: string | null; reason: string };

export class SetRefused extends Error {
  override name = "SetRefused";
  readonly problems: Problem[];
  // The first problem's fields, for a caller that reads one.
  readonly set: string | null;
  readonly index: number | null;
  readonly path: string | null;
  readonly reason: string;

  constructor(problems: Problem[]) {
    const first = problems[0] as Problem;
    super(
      problems
        .map((p) => `${p.set ?? "(no set)"}: label ${p.index ?? "-"} (${p.path ?? "no path"}): ${p.reason}`)
        .join("\n"),
    );
    this.problems = problems;
    this.set = first.set;
    this.index = first.index;
    this.path = first.path;
    this.reason = first.reason;
  }
}

// A filesystem failure as a reason: what failed and its code.
const failed = (what: string, error: unknown) =>
  `${what} (${(error as NodeJS.ErrnoException).code ?? (error as Error).name})`;

// A set's samples, or the problems that refuse it.
function readSet(dir: string, name: string): { samples: Sample[]; problems: Problem[] } {
  const problems: Problem[] = [];
  const refuse = (reason: string, index: number | null = null, path: string | null = null) =>
    problems.push({ set: name, index, path, reason });
  const file = join(dir, "labels.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    refuse(
      code === "ENOENT"
        ? "it has no labels.json"
        : code
          ? failed("labels.json cannot be read", error)
          : `labels.json cannot be read as JSON (${(error as Error).name})`,
    );
    return { samples: [], problems };
  }
  if (!Array.isArray(raw)) {
    refuse("labels.json is not a list of labels");
    return { samples: [], problems };
  }
  if (!raw.length) {
    refuse("the set has no samples");
    return { samples: [], problems };
  }
  let home: string;
  try {
    home = realpathSync(dir) + sep;
  } catch (error) {
    refuse(failed("the set's folder cannot be read", error));
    return { samples: [], problems };
  }
  const samples: Sample[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    // Only a string is named as the path: anything else is the schema's to refuse, never coerced.
    const named =
      typeof entry === "object" && entry !== null && typeof (entry as { path?: unknown }).path === "string"
        ? (entry as { path: string }).path
        : null;
    const parsed = Label.safeParse(entry);
    if (!parsed.success) {
      refuse(z.prettifyError(parsed.error), index, named);
      continue;
    }
    const path = parsed.data.path;
    if (seen.has(path)) {
      refuse("the path is labelled twice", index, path);
      continue;
    }
    seen.add(path);
    let real: string;
    try {
      // Followed through links: a file, or a folder on its way, linked from outside the set is refused.
      real = realpathSync(resolve(dir, path));
      if (!real.startsWith(home)) {
        refuse("the file lies outside its set", index, path);
        continue;
      }
      if (!statSync(real).isFile()) {
        refuse("no such file", index, path);
        continue;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      refuse(code === "ENOENT" ? "no such file" : failed("the file cannot be read", error), index, path);
      continue;
    }
    samples.push({ ...parsed.data, id: `${name}/${path}`, set: name, file: real });
  }
  return { samples, problems };
}

export function loadSet(dir: string, name: string): LoadedSet {
  const { samples, problems } = readSet(dir, name);
  if (problems.length) throw new SetRefused(problems);
  return { name, dir, samples };
}

// Every set under `root`, by name; a root that is missing, unreadable or holds no set is refused, and any set's problems
// refuse the whole load, never read as a smaller population.
export function loadSets(root: string): LoadedSet[] {
  if (!existsSync(root))
    throw new SetRefused([{ set: null, index: null, path: null, reason: "the sets directory is missing" }]);
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (error) {
    throw new SetRefused([
      { set: null, index: null, path: null, reason: failed("the sets directory cannot be read", error) },
    ]);
  }
  if (!names.length)
    throw new SetRefused([{ set: null, index: null, path: null, reason: "the sets directory holds no set" }]);
  const sets: LoadedSet[] = [];
  const problems: Problem[] = [];
  for (const name of names) {
    const dir = join(root, name);
    const read = readSet(dir, name);
    problems.push(...read.problems);
    sets.push({ name, dir, samples: read.samples });
  }
  if (problems.length) throw new SetRefused(problems);
  return sets;
}
