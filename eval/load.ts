// The evaluation sets (D08 T01 §1): each a folder under the root, `<root>/<name>/labels.json` beside the files it
// names. Each sample is known by its set and path (`<set>/<path>`) and carries its file's resolved location, so two sets
// may both hold `001.eml`. A load is refused whole, never partly, when the root or a set is missing or empty, when
// labels.json cannot be read as a list, or when a label is malformed, names no file inside its set, or repeats a path;
// each refusal names the set, the label's index and its path, `null` where there is none.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { Label } from "./schema";

export type Sample = Label & { id: string; set: string; file: string };
export type LoadedSet = { name: string; dir: string; samples: Sample[] };

export class SetRefused extends Error {
  override name = "SetRefused";
  readonly set: string | null;
  readonly index: number | null;
  readonly path: string | null;
  readonly reason: string;

  constructor(where: { set: string | null; index?: number | null; path?: string | null }, reason: string) {
    const index = where.index ?? null;
    const path = where.path ?? null;
    super(`${where.set ?? "(no set)"}: label ${index ?? "-"} (${path ?? "no path"}): ${reason}`);
    this.set = where.set;
    this.index = index;
    this.path = path;
    this.reason = reason;
  }
}

export function loadSet(dir: string, name: string): LoadedSet {
  const file = join(dir, "labels.json");
  if (!existsSync(file)) throw new SetRefused({ set: name }, "it has no labels.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new SetRefused({ set: name }, `labels.json cannot be read as JSON (${(error as Error).name})`);
  }
  if (!Array.isArray(raw)) throw new SetRefused({ set: name }, "labels.json is not a list of labels");
  if (!raw.length) throw new SetRefused({ set: name }, "the set has no samples");
  const samples: Sample[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const path = typeof entry === "object" && entry && "path" in entry ? String(entry.path) : null;
    const where = { set: name, index, path };
    const parsed = Label.safeParse(entry);
    if (!parsed.success) throw new SetRefused(where, z.prettifyError(parsed.error));
    // The schema keeps a path inside its set (relative, no `..`, no backslash), so it resolves under the set.
    const full = resolve(dir, parsed.data.path);
    if (!existsSync(full) || !statSync(full).isFile()) throw new SetRefused(where, "no such file");
    if (seen.has(parsed.data.path)) throw new SetRefused(where, "the path is labelled twice");
    seen.add(parsed.data.path);
    samples.push({ ...parsed.data, id: `${name}/${parsed.data.path}`, set: name, file: full });
  }
  return { name, dir, samples };
}

// Every set under `root`, by name; a root that is missing or holds no set is refused, never read as an empty population.
export function loadSets(root: string): LoadedSet[] {
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new SetRefused({ set: null }, "the sets directory is missing");
  const names = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  if (!names.length) throw new SetRefused({ set: null }, "the sets directory holds no set");
  return names.map((name) => loadSet(join(root, name), name));
}
