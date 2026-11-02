// The results summary the site reads (D08 T02 §4) and the page the app serves are made from the same published report:
// every figure of the file equals the figure the page renders, and a summary of another run is refused.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { computeMetrics } from "../../eval/metrics.ts";
import { SUMMARY_PATH, summaryOf, summaryProblems, writeResultsSummary } from "../../eval/publish.ts";
import type { ResultRow, RunRow } from "../../eval/run.ts";
import type { RunSample } from "../../eval/run-core.ts";
import { parseResults } from "../../site/src/lib/results.ts";
import { EvalPage, pct, seconds } from "../../src/web/pages/eval-view.tsx";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sample = (name: string, label: "attack" | "genuine"): RunSample => ({
  id: `synthetic-sa/${name}`,
  set: "synthetic-sa",
  path: name,
  file: `/nowhere/${name}`,
  label,
  category: label === "attack" ? "credential-phishing" : "genuine-business",
  basis: label === "attack" ? "checks" : undefined,
  sha256: "0".repeat(64),
});
const row = (id: string, verdict: ResultRow["verdict"], label: "attack" | "genuine", ms: number): ResultRow => ({
  runId: "run-00000001",
  sample: id,
  caseId: `case-${id}`,
  outcome: "done",
  label,
  category: "x",
  verdict,
  ms,
  costUsd: 0.03,
  criticalFound: false,
  httpStatus: null,
  detail: null,
});
const run = (id: string): RunRow => ({
  id,
  commitSha: "abcdef1234567",
  setVersion: "a".repeat(64),
  mode: "full",
  sets: ["synthetic-sa"],
  sampleLimit: null,
  status: "complete",
  selected: 8,
  capUsd: 5,
  startedAt: "2026-11-05T10:00:00.000Z",
  finishedAt: "2026-11-05T10:30:00.000Z",
  costUsd: 0.24,
});
function reportFor(id: string) {
  const attacks = ["a1", "a2", "a3", "a4", "a5"].map((n) => sample(`${n}.eml`, "attack"));
  const genuine = ["g1", "g2", "g3"].map((n) => sample(`${n}.eml`, "genuine"));
  const samples = [...attacks, ...genuine];
  const results = [
    ...attacks.map((s, i) => row(s.id, i === 0 ? "safe" : "malicious", "attack", 3000 + i * 500)),
    ...genuine.map((s, i) => row(s.id, i === 0 ? "suspicious" : "safe", "genuine", 1000 + i * 500)),
  ];
  return computeMetrics({ run: run(id), samples, results });
}

describe("the summary and the page", () => {
  it("hold the same figures: each field of the file is what the page renders for that report", () => {
    const report = reportFor("run-00000001");
    const summary = summaryOf(report);
    const html = String(
      EvalPage({
        view: {
          kind: "report",
          report: report as never,
          publishedAt: "2026-11-05T11:00:00.000Z",
          ablations: [],
          history: [],
          counts: {
            since: "x",
            cases: 0,
            flagged: 0,
            invoiceFlags: 0,
            bankChanges: null,
            reportedWrong: 0,
            medianSeconds: null,
          },
        },
      }),
    );
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    // Detection 4 of 5, false alarms 1 of 3, and the median analysis time of eight cases (1.0 to 5.0 s): 3.25 s.
    expect(summary).toMatchObject({ detectionRate: 0.8, medianSeconds: 3.25, samples: 8, runId: "run-00000001" });
    expect(text).toContain(`caught ${pct(summary.detectionRate)} of attacks`);
    expect(text).toContain(`wrongly flagged ${pct(summary.falseAlarmRate)} of genuine mail`);
    expect(text).toContain(`Median time to analyse ${seconds(summary.medianSeconds * 1000)}`);
    expect(text).toContain(`labelled emails and documents`);
    expect(text).toContain(`test of ${summary.samples} labelled`);
    expect(text).toContain(`Eval run ${summary.runId}`);
    // The site's own parser reads the file the command writes.
    const dir = mkdtempSync(join(tmpdir(), "eval-summary-"));
    dirs.push(dir);
    const file = join(dir, SUMMARY_PATH);
    writeResultsSummary(file, summary);
    expect(parseResults(readFileSync(file, "utf-8"), file)).toEqual(summary);
    expect(summaryProblems(JSON.parse(readFileSync(file, "utf-8")), report)).toEqual([]);
  });

  it("refuses a summary of another run, or one whose figure is not the report's", () => {
    const report = reportFor("run-00000001");
    const other = summaryOf(reportFor("run-00000002"));
    expect(summaryProblems(other, report).join()).toMatch(/is of run run-00000002, not run-00000001/);
    expect(summaryProblems({ ...summaryOf(report), detectionRate: 0.99 }, report).join()).toMatch(
      /detectionRate is 0.99, the report's is 0.8/,
    );
    expect(summaryProblems({ ...summaryOf(report), samples: 7 }, report).join()).toMatch(/samples is 7/);
    expect(summaryProblems(null, report)).toEqual(["the summary is not an object"]);
  });
});
