// The eval's latest results for the home page's band (D07 T06 §2). D08 T02 §4 writes `eval/results-summary.json`
// (coordinator, 2026-10-31); the site build reads it. Absent, the band keeps the SPEC's [XX] placeholders; present but
// broken, the build fails, so a bad summary can never ship as a blank or wrong band.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Results = {
  detectionRate: number; // phishing caught, a fraction 0 to 1
  falseAlarmRate: number; // genuine mail called suspicious or malicious, a fraction 0 to 1
  medianSeconds: number; // median forward-to-verdict time
  samples: number; // labelled samples in the run
  runDate: string; // YYYY-MM-DD
  runId: string;
};

// The file's fields, as D08 T02 §4 writes them (`writeResultsSummary` in `eval/run.ts`; eval lane, 2026-10-31).
const FIELDS = ["detectionRate", "falseAlarmRate", "medianSeconds", "samples", "runDate", "runId"] as const;

export const SUMMARY = join(fileURLToPath(new URL("../../..", import.meta.url)), "eval/results-summary.json");

const fraction = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

// The summary at `path`, or null when there is none. Throws, naming the problem, on anything else.
export function readResults(path = SUMMARY): Results | null {
  if (!existsSync(path)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`results: ${path} is not JSON (${(error as Error).message})`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error(`results: ${path} is not an object`);
  const record = data as Record<string, unknown>;
  const missing = FIELDS.filter((field) => !(field in record));
  if (missing.length > 0) throw new Error(`results: ${path} is missing ${missing.join(", ")}`);
  const bad: string[] = [];
  if (!fraction(record.detectionRate)) bad.push("detectionRate (a fraction 0 to 1)");
  if (!fraction(record.falseAlarmRate)) bad.push("falseAlarmRate (a fraction 0 to 1)");
  const median = record.medianSeconds;
  if (typeof median !== "number" || !Number.isFinite(median) || median <= 0) bad.push("medianSeconds (seconds above 0)");
  const count = record.samples;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) bad.push("samples (a whole number from 1)");
  const date = record.runDate;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    bad.push("runDate (YYYY-MM-DD)");
  }
  if (typeof record.runId !== "string" || !record.runId.trim()) bad.push("runId (text)");
  if (bad.length > 0) throw new Error(`results: ${path} has a bad ${bad.join(", ")}`);
  return {
    detectionRate: record.detectionRate as number,
    falseAlarmRate: record.falseAlarmRate as number,
    medianSeconds: median as number,
    samples: count as number,
    runDate: date as string,
    runId: (record.runId as string).trim(),
  };
}

// The band's four values as printed: the measured numbers, or the SPEC's placeholders when there is no summary.
export function band(results: Results | null) {
  if (!results) return { detection: "[XX]%", falseAlarms: "[X]%", median: "[XX] s", samples: "[N]", date: null };
  const percent = (value: number) => `${Math.round(value * 1000) / 10}%`;
  return {
    detection: percent(results.detectionRate),
    falseAlarms: percent(results.falseAlarmRate),
    median: `${Math.round(results.medianSeconds)} s`,
    samples: results.samples.toLocaleString("en-ZA"),
    date: results.runDate,
  };
}
