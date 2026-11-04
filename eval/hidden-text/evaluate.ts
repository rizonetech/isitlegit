import { detect } from "./runtime.mjs";

export { detect } from "./runtime.mjs";

import { type Case, hash, LANGUAGES, TARGETS } from "./corpus.ts";

export function validateCorpus(input: unknown): asserts input is Case[] {
  if (!Array.isArray(input) || input.length > 5000) throw new Error("Corpus must be an array of at most 5000 cases");
  const ids = new Set<string>();
  const languages = new Set(LANGUAGES.map(([language]) => language as string));
  for (const row of input) {
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.id !== "string" ||
      !/^[a-z0-9-]+$/.test(row.id) ||
      ids.has(row.id) ||
      !["attack", "control"].includes(row.label) ||
      !languages.has(row.language) ||
      !["sparse", "tag", "subject-b", "subject-q", "docx", "pdf"].includes(row.technique) ||
      typeof row.source !== "string" ||
      !row.source.startsWith("test/") ||
      typeof row.payload !== "string" ||
      row.payload.length > 1_000_000 ||
      !row.payload.length ||
      row.sha256 !== hash(row.payload) ||
      !Number.isInteger(row.chunkSize) ||
      row.chunkSize < 1 ||
      row.chunkSize > 65536 ||
      !(row.instructionLanguage === null || languages.has(row.instructionLanguage))
    )
      throw new Error("Malformed case, duplicate ID or payload digest mismatch");
    ids.add(row.id);
  }
  for (const label of ["attack", "control"]) {
    if (
      input.filter((r) => r.label === label).length < 200 ||
      new Set(input.filter((r) => r.label === label).map((r) => r.language)).size < 8
    )
      throw new Error("Each label requires 200 cases and eight languages");
  }
  for (const technique of ["sparse", "tag", "subject-b", "subject-q", "docx", "pdf"]) {
    for (const label of ["attack", "control"])
      if (!input.some((r) => r.technique === technique && r.label === label))
        throw new Error("Missing technique/label coverage");
  }
}
export type Findings = {
  matches: { pattern: string; location: string; severity: "high" }[];
  runs: { kind: string; severity: string; location: string }[];
};
export const flagged = (findings: Findings) =>
  findings.matches.length > 0 || findings.runs.some((r) => r.severity === "high" || r.severity === "medium");
export type Observation = Omit<Case, "payload" | "source" | "chunkSize"> & {
  status: "ok" | "error";
  flagged: boolean | null;
  ms: number;
  findings: Findings | null;
  error: string | null;
};
export function summarize(rows: Observation[]) {
  const attacks = rows.filter((r) => r.label === "attack");
  const controls = rows.filter((r) => r.label === "control");
  const missed = attacks.filter((r) => r.status !== "ok" || !r.flagged).map((r) => r.id);
  const falseFlags = controls.filter((r) => r.flagged === true).map((r) => r.id);
  const errors = rows.filter((r) => r.status !== "ok").map((r) => r.id);
  const times = rows.map((r) => r.ms).sort((a, b) => a - b);
  const quantile = (p: number) => (times.length ? (times[Math.ceil(p * times.length) - 1] ?? null) : null);
  return {
    attacks: attacks.length,
    controls: controls.length,
    missed,
    falseFlags,
    errors,
    missRate: attacks.length ? missed.length / attacks.length : null,
    falseFlagRate: controls.length ? falseFlags.length / controls.length : null,
    p50Ms: quantile(0.5),
    p95Ms: quantile(0.95),
  };
}
export async function evaluate(cases: Case[], detector = detect) {
  validateCorpus(cases);
  const observations: Observation[] = [];
  for (const row of cases) {
    const { payload: _payload, source: _source, chunkSize: _chunk, ...identity } = row;
    const start = performance.now();
    try {
      const findings = await detector(row);
      observations.push({
        ...identity,
        status: "ok",
        flagged: flagged(findings),
        ms: performance.now() - start,
        findings,
        error: null,
      });
    } catch {
      observations.push({
        ...identity,
        status: "error",
        flagged: null,
        ms: performance.now() - start,
        findings: null,
        error: "decoder or detector failed",
      });
    }
  }
  const summary = summarize(observations);
  const pass =
    summary.errors.length === 0 &&
    summary.missRate !== null &&
    summary.missRate <= TARGETS.missRate &&
    summary.falseFlagRate !== null &&
    summary.falseFlagRate <= TARGETS.falseFlagRate &&
    summary.p50Ms !== null &&
    summary.p50Ms <= TARGETS.p50Ms &&
    summary.p95Ms !== null &&
    summary.p95Ms <= TARGETS.p95Ms;
  const by = (field: "language" | "technique") =>
    Object.fromEntries(
      [...new Set(observations.map((r) => r[field]))].map((key) => [
        key,
        summarize(observations.filter((r) => r[field] === key)),
      ]),
    );
  return {
    targets: TARGETS,
    summary,
    byLanguage: by("language"),
    byTechnique: by("technique"),
    observations,
    pass,
    exitCode: summary.errors.length ? 2 : pass ? 0 : 1,
  };
}
