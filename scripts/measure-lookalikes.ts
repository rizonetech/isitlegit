// D02 T03 §5: same fixed populations and all-target scoring for every technique.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addedWords, distance, foldAccents, skeleton, unicodeLabel } from "../src/checks/lookalike.ts";
import { type Corpus, digest, FAMILIES, ROOT, writeCorpus } from "./fixtures/make-lookalikes.ts";

export const REFERENCE_SHA = "6ed3ee967c9dfdf6677d563c9985182fbc50a2efb7d6059cd57b2e2ce18f5b92";
// Alternative implementation v1: parses raw Unicode 18.0.0 mappings, not the product's generated map or skeleton.
// This reference covers our LTR corpus only, not bidiSkeleton or independent third-party validation.
export function referenceSkeleton(source = readFileSync(join(ROOT, "vendor/unicode/confusables.txt"), "utf8")) {
  if (digest(source) !== REFERENCE_SHA) throw new Error("Reference confusables digest mismatch");
  const mapping = new Map<string, string>();
  for (const line of source.split("\n")) {
    const data = line.split("#")[0]?.trim();
    if (!data) continue;
    const columns = data.split(";").map((s) => s.trim());
    const decode = (s: string) => String.fromCodePoint(...s.split(/\s+/).map((c) => Number.parseInt(c, 16)));
    mapping.set(decode(columns[0] as string), decode(columns[1] as string));
  }
  return (label: string): string =>
    [...label.normalize("NFD")]
      .filter((c) => !/\p{Default_Ignorable_Code_Point}/u.test(c))
      .map((c) => mapping.get(c) ?? c)
      .join("")
      .normalize("NFD");
}

type Compare = (a: string, b: string) => boolean;
export function techniques(): Record<string, Compare> {
  const reference = referenceSkeleton();
  const equalSkeleton: Compare = (a, b) => skeleton(a) === skeleton(b);
  const edit =
    (limit: number): Compare =>
    (a, b) =>
      a.length >= 6 && b.length >= 6 && distance(a, b) <= limit;
  const editTwo = edit(2);
  const baseline: Compare = (a, b) => equalSkeleton(a, b) || !!addedWords(a, b) || editTwo(a, b);
  return {
    "Skeleton equality": equalSkeleton,
    "Distance <= 1 (length >= 6)": edit(1),
    "Distance <= 2 (length >= 6)": edit(2),
    "Added words": (a, b) => !!addedWords(a, b),
    "Accent-fold equality": (a, b) => foldAccents(a) === foldAccents(b),
    "Fold then skeleton equality": (a, b) => skeleton(foldAccents(a)) === skeleton(foldAccents(b)),
    "Reference skeleton equality": (a, b) => reference(a) === reference(b),
    "Existing combined": baseline,
    "Combined plus exact accent-fold": (a, b) => baseline(a, b) || foldAccents(a) === foldAccents(b),
  };
}
export type Result = {
  name: string;
  detected: number;
  intended: number;
  falseFlags: number;
  families: Record<string, number>;
  micros: number;
};

export function measure(corpus: Corpus, repeats = 3): Result[] {
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("Positive integer repeats required");
  // Every technique gets the same IDNA-normalized eligible labels. Validation/normalization is outside timing.
  const normalize = (s: string) => {
    const label = unicodeLabel(s);
    if (label === null || skeleton(label) === null) throw new Error(`Ineligible corpus label: ${s}`);
    return label;
  };
  const targets = corpus.targets.map(normalize);
  const candidates = [...corpus.positives.map((p) => p.label), ...corpus.benign].map(normalize);
  const pairs = candidates.flatMap((a) => targets.map((b) => [a, b] as const));
  return Object.entries(techniques()).map(([name, compare]) => {
    const run = (a: string, b: string) => a !== b && compare(a, b);
    const families = Object.fromEntries(FAMILIES.map((family) => [family, 0]));
    let detected = 0;
    let intended = 0;
    let falseFlags = 0;
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i] as string;
      // Evaluate all pairs, even after the first match, so false-flag and timing populations are explicit.
      const hits = targets.map((target) => run(candidate, target));
      if (i < corpus.positives.length) {
        const positive = corpus.positives[i] as Corpus["positives"][number];
        if (hits.some(Boolean)) {
          detected++;
          families[positive.family] = (families[positive.family] ?? 0) + 1;
        }
        if (hits[targets.indexOf(normalize(positive.target))]) intended++;
      } else if (hits.some(Boolean)) falseFlags++;
    }
    for (const [a, b] of pairs) run(a, b); // Warm-up, excluded from timing.
    const timings: number[] = [];
    let hits = 0;
    for (let repeat = 0; repeat < repeats; repeat++) {
      const start = performance.now();
      for (const [a, b] of pairs) if (run(a, b)) hits++;
      timings.push(((performance.now() - start) * 1000) / pairs.length);
    }
    if (!Number.isFinite(hits)) throw new Error("Invalid benchmark accumulator");
    timings.sort((a, b) => a - b);
    return {
      name,
      detected,
      intended,
      falseFlags,
      families,
      micros: timings[Math.floor(timings.length / 2)] as number,
    };
  });
}

export function report(corpus: Corpus, results: Result[]): string {
  const byName = (name: string) => results.find((r) => r.name === name) as Result;
  const baseline = byName("Existing combined");
  const chosen = byName("Combined plus exact accent-fold");
  const advantage =
    chosen.detected > baseline.detected && chosen.falseFlags <= baseline.falseFlags
      ? `${chosen.detected - baseline.detected} additional positive labels versus existing combined techniques, with ${chosen.falseFlags}/${corpus.benign.length} benign labels flagged.`
      : "None: the selected combination shows no detection advantage without increased false flags on this corpus.";
  const rows = results
    .map(
      (r) =>
        `| ${r.name} | ${r.detected}/${corpus.positives.length} | ${r.intended}/${corpus.positives.length} | ${r.falseFlags}/${corpus.benign.length} | ${r.micros.toFixed(3)} | ${(r.micros / 2).toFixed(3)} |`,
    )
    .join("\n");
  const familyRows = results
    .map((r) => `| ${r.name} | ${FAMILIES.map((f) => `${r.families[f]}/${corpus.targets.length}`).join(" | ")} |`)
    .join("\n");
  return `# Accent-insensitive lookalike measurement\n\nMeasured ${new Date().toISOString()} with Node ${process.version}, Unicode ${process.versions.unicode}, ICU ${process.versions.icu}; ${process.platform}/${process.arch}. Local Node timing, not Worker latency, CI, deployment or population accuracy.\n\nReproduce: \`node scripts/fixtures/make-lookalikes.ts --check\`, then \`taskset -c 3 node scripts/measure-lookalikes.ts\`. Add \`--write\` to replace this report. Generation is offline and deterministic, seed ${corpus.seed}. Every name is fictional synthetic; no client data or model calls.\n\nThe target inventory contains all 20 logo-recall brands, all three invoice suppliers and six domain-check/demo names (deduplicated to ${corpus.targets.length}); source digests are in positive.json. Each target has exactly one case in each of seven families, ${corpus.positives.length} positives. The 60 benign labels combine ten independently invented accented names and six trades, fixed before scoring; no label is removed or selected by detection results. These are constructed controls, not a representative business population or independent holdout.\n\nEvery one of ${corpus.positives.length + corpus.benign.length} labels is compared with every one of ${corpus.targets.length} targets (${(corpus.positives.length + corpus.benign.length) * corpus.targets.length} pairs). Detection means a positive matches any target; intended-target detection is also shown. A false flag means a benign label matches any target. Exact unchanged labels are excluded. All labels pass the same IDNA and LTR eligibility checks. Timings are median of three warmed complete passes, microseconds per candidate-target pair (both labels transformed), without corpus I/O or initial IDNA normalization; no cross-pair transformation cache. Amortized microseconds per label is derived as half the measured pair time, since each comparison consumes two labels.\n\n| Technique | Detected | Intended target | False flags | Microseconds/pair | Amortized microseconds/label |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\n| Technique | ${FAMILIES.join(" | ")} |\n| --- | ${FAMILIES.map(() => "---:").join(" | ")} |\n${familyRows}\n\nMeasured advantage: ${advantage} Against the reference skeleton alone, the extended combination detects ${chosen.detected}/${corpus.positives.length} versus ${byName("Reference skeleton equality").detected}/${corpus.positives.length}, by adding heuristics, not by improving UTS #39 conformance. The product skeleton has no detection advantage over the reference on this corpus; their match counts are identical. Timing differences are local observations, not a general speed claim.\n\nSelected threshold: exact accent-fold equality only, after existing skeleton, added-word and edit comparisons. No increased edit-distance tolerance and no folding-plus-skeleton production expansion. Keep the UTS #39 skeleton unchanged, existing technique precedence, severity, trusted-domain exclusions, evidence/provenance and right-to-left refusal. The all-mark fold is NFD, remove every Unicode Mark, NFC. This is a separate heuristic, not identity or ownership proof. Accent distinctions can be meaningful; zero false flags here cannot establish a deployment false-positive rate.\n\nThe alternative is our separately implemented reference v1 in scripts/measure-lookalikes.ts, parsing the raw vendored Unicode 18.0.0 confusables table, digest ${REFERENCE_SHA}. It shares source data and JavaScript normalization with production, covers this LTR corpus only, and is neither third-party validation nor full bidiSkeleton conformance. It fails closed on source-digest mismatch. No comparative claim about Chrome, ICU or other products follows from this experiment.\n\nMeasurement script SHA-256: ${digest(readFileSync(fileURLToPath(import.meta.url)))}. Generator SHA-256: ${digest(readFileSync(join(ROOT, "scripts/fixtures/make-lookalikes.ts")))}. Positive fixture SHA-256: ${digest(readFileSync(join(ROOT, "test/fixtures/lookalikes/positive.json")))}. Benign fixture SHA-256: ${digest(readFileSync(join(ROOT, "test/fixtures/lookalikes/benign.json")))}.\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((arg) => arg !== "--write"))
    throw new Error("Usage: node scripts/measure-lookalikes.ts [--write]");
  const corpus = writeCorpus(undefined, true);
  const output = report(corpus, measure(corpus));
  if (process.argv.includes("--write")) writeFileSync(join(ROOT, "docs/evals/lookalikes.md"), output);
  else process.stdout.write(output);
}
