import dev from "../../data/dev-facts.json";
import loupe from "../../data/loupe-facts.json";
import tech from "../../data/tech-facts.json";
import stats from "../data/stats.json";

// Storyboard text may name a figure instead of typing it: {stats.path} reads media/src/data/stats.json (written by
// tools/collect-stats.py at render time) and {fact.key} reads a facts file proven by tools/check-facts.py. An unknown
// name throws, so a render fails rather than showing a guessed number.
type Facts = { facts: Record<string, { value: string }> };
const FACT_FILES: Facts[] = [loupe as Facts, dev as Facts, tech as Facts];

const fact = (key: string): string => {
  for (const file of FACT_FILES) if (key in file.facts) return file.facts[key].value;
  throw new Error(`storyboard names an unknown fact: ${key}`);
};

const stat = (path: string): string => {
  let node: unknown = stats;
  for (const part of path.split(".")) {
    if (node === null || typeof node !== "object" || !(part in node)) throw new Error(`storyboard names an unknown stat: ${path}`);
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "number" ? node.toLocaleString("en-US") : String(node);
};

export const fill = (text: string): string =>
  text.replace(/\{(stats|fact)\.([A-Za-z0-9_.]+)\}/g, (_, kind: string, key: string) => (kind === "stats" ? stat(key) : fact(key)));

export const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
