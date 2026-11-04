// D02 T03 §5. Synthetic labels are assigned by construction, never by running the detector.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const SEED = 20261104;
export type Positive = { label: string; target: string; family: string };
export type Corpus = {
  seed: number;
  targets: string[];
  positives: Positive[];
  benign: string[];
  sources: Record<string, string>;
};
const ACCENTS: Record<string, string> = { a: "á", e: "é", i: "í", o: "ó", u: "ú", y: "ý", c: "ç", n: "ñ", s: "ś" };
const CONFUSABLES: Record<string, string> = { a: "а", e: "е", o: "о", c: "с", p: "р", y: "у", i: "і", s: "ѕ" };
export const FAMILIES = ["accent-1", "accent-2", "accent-3", "swapped", "doubled", "confusable", "added-word"];
export const digest = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

export function generate(seed = SEED): Corpus {
  let state = seed >>> 0;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const sources: Record<string, string> = {};
  const source = (path: string) => {
    const data = readFileSync(join(ROOT, path), "utf8");
    sources[path] = digest(data);
    return JSON.parse(data);
  };
  const logos = source("test/vision/fixtures/logo-recall/labels.json") as { samples: { brand: string }[] };
  const invoices = source("test/fixtures/invoices/labels.json") as { files: { supplier: { domain: string } }[] };
  // Fixture population: every logo-recall brand, every invoice supplier, plus the domain-check and demo names.
  const targets = [
    ...new Set([
      ...logos.samples.map(({ brand }) => brand.toLowerCase().replaceAll(" ", "")),
      ...invoices.files.map(({ supplier }) => supplier.domain.split(".")[0] as string),
      "kestrelbank",
      "karooparts",
      "examplebank",
      "example",
      "karoomutual",
      "capecoldchain",
    ]),
  ].sort();
  const positives: Positive[] = [];
  for (const target of targets) {
    const indices = [...target].map((_, i) => i).filter((i) => ACCENTS[target[i] as string]);
    // Seeded Fisher-Yates chooses positions without using any detection score.
    for (let i = indices.length - 1; i > 0; i--) {
      const j = next() % (i + 1);
      [indices[i], indices[j]] = [indices[j] as number, indices[i] as number];
    }
    if (indices.length < 3) throw new Error(`Target lacks three accentable letters: ${target}`);
    for (let count = 1; count <= 3; count++) {
      const letters = [...target];
      for (const i of indices.slice(0, count)) letters[i] = ACCENTS[letters[i] as string] as string;
      positives.push({ label: letters.join(""), target, family: `accent-${count}` });
    }
    const swappable = [...target].map((_, i) => i).filter((i) => i + 1 < target.length && target[i] !== target[i + 1]);
    const swap = swappable[next() % swappable.length] as number;
    const letters = [...target];
    [letters[swap], letters[swap + 1]] = [letters[swap + 1] as string, letters[swap] as string];
    positives.push({ label: letters.join(""), target, family: "swapped" });
    const double = next() % target.length;
    positives.push({
      label: target.slice(0, double) + target[double] + target.slice(double),
      target,
      family: "doubled",
    });
    const confusable = [...target].map((_, i) => i).filter((i) => CONFUSABLES[target[i] as string]);
    const at = confusable[next() % confusable.length] as number;
    if (at === undefined) throw new Error(`Target lacks a confusable letter: ${target}`);
    positives.push({
      label: target.slice(0, at) + CONFUSABLES[target[at] as string] + target.slice(at + 1),
      target,
      family: "confusable",
    });
    positives.push({ label: `${target}-payments`, target, family: "added-word" });
  }
  // Invented unrelated businesses, fixed before measurement. Retain every flag, even if a technique misclassifies it.
  const prefixes = [
    "velúria",
    "azúmbe",
    "tévani",
    "osírra",
    "luméko",
    "zandúli",
    "neróqua",
    "umézzi",
    "silóven",
    "émbara",
  ];
  const trades = ["ceramics", "weaving", "orchards", "joinery", "glassworks", "bookbinders"];
  const benign = prefixes.flatMap((prefix) => trades.map((trade) => prefix + trade));
  return { seed, targets, positives, benign, sources };
}

export function writeCorpus(directory = join(ROOT, "test/fixtures/lookalikes"), check = false): Corpus {
  const corpus = generate();
  const files = {
    "positive.json": { seed: corpus.seed, sources: corpus.sources, targets: corpus.targets, cases: corpus.positives },
    "benign.json": { seed: corpus.seed, fictional: true, cases: corpus.benign },
  };
  if (!check) mkdirSync(directory, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    const expected = `${JSON.stringify(data, null, 2)}\n`;
    const path = join(directory, name);
    if (check) {
      if (readFileSync(path, "utf8") !== expected) throw new Error(`Stale lookalike fixture: ${name}`);
    } else writeFileSync(path, expected);
  }
  return corpus;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((arg) => arg !== "--check"))
    throw new Error("Usage: node scripts/fixtures/make-lookalikes.ts [--check]");
  const corpus = writeCorpus(undefined, process.argv.includes("--check"));
  console.log(
    `Lookalikes: ${corpus.targets.length} targets, ${corpus.positives.length} positive labels, ${corpus.benign.length} benign labels; seed ${corpus.seed}`,
  );
}
