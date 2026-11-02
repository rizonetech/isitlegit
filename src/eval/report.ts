// The published eval reports the public results page shows (D08 T02 §4). A run is published once (`eval_published`,
// eval/publish.ts): its report holds figures, counts and denominators only. The headline is the latest published report of
// mode `full`; an ablation row is compared only with a baseline of the same selection and deployed commit, else it is
// `not comparable`. A stored report is checked before it is shown, so a damaged row is an error, never a blank figure.
import { z } from "zod";

const Rate = z.strictObject({
  n: z.number().int().min(0),
  hits: z.number().int().min(0),
  rate: z.number().min(0).max(1).nullable(),
});
const Spread = z.strictObject({
  n: z.number().int().min(0),
  median: z.number().min(0).nullable(),
  p95: z.number().min(0).nullable(),
});
const Category = z.strictObject({
  attacks: z.number().int().min(0),
  detected: z.number().int().min(0),
  genuine: z.number().int().min(0),
  measuredGenuine: z.number().int().min(0),
  falsePositives: z.number().int().min(0),
});
const Population = z.object({
  attacks: z.number().int().min(0),
  genuine: z.number().int().min(0),
  measuredGenuine: z.number().int().min(0),
  detection: Rate,
  falsePositives: Rate,
  byCategory: z.record(z.string(), Category),
  modelBasis: Rate,
  checksBasis: Rate,
  analysisMs: Spread,
  costUsd: z.object({ n: z.number().int().min(0), median: z.number().min(0).nullable(), total: z.number().min(0) }),
});
const Target = z.object({
  name: z.string(),
  figure: z.number().nullable(),
  figureText: z.string(),
  threshold: z.string(),
  denominator: z.number().int().min(0),
  state: z.enum(["met", "missed", "not measured", "incomplete"]),
  note: z.string().optional(),
});
export const PublishedReport = z.object({
  run: z.object({
    id: z.string(),
    mode: z.string(),
    commit: z.string(),
    setVersion: z.string(),
    sets: z.array(z.string()),
    sampleLimit: z.number().nullable(),
    status: z.string(),
    selected: z.number().int(),
    stored: z.number().int(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
  }),
  complete: z.boolean(),
  main: Population,
  targets: z.array(Target),
});
export type PublishedReport = z.infer<typeof PublishedReport>;
export type Published = { report: PublishedReport; publishedAt: string };

// One published full run in the public history (D08 T02 §10): comparable with the latest only when its set
// version, selection and deployed commit match and it is complete, else the reason it is not compared.
export type HistoryRow = {
  report: PublishedReport;
  publishedAt: string;
  comparable: boolean;
  reason: string | null;
};

export type EvalRunRow = {
  id: string;
  mode: string;
  status: string;
  commit: string;
  setVersion: string;
  sets: string;
  sampleLimit: number | null;
  selected: number;
  capUsd: number;
  costUsd: number;
  startedAt: string;
  finishedAt: string | null;
  published: { report: PublishedReport; publishedAt: string } | null;
};

export const parseReport = (json: string): PublishedReport => PublishedReport.parse(JSON.parse(json));

export type AblationRow =
  | {
      mode: string;
      runId: string;
      comparable: true;
      detection: Rate2;
      falsePositives: Rate2;
      medianMs: number | null;
      medianUsd: number | null;
      detectionDelta: number | null;
      falsePositiveDelta: number | null;
      msDelta: number | null;
      usdDelta: number | null;
    }
  | { mode: string; runId: string; comparable: false; reason: string };
type Rate2 = { n: number; hits: number; rate: number | null };

export const PRODUCTION_SINCE = "2026-10-26T22:00:00.000Z"; // 27 October 2026, 00:00 SAST
// The organisations that are not real use: the eval organisation (D08 T02 §7) and the demo organisation (D07 T07).
export const EXCLUDED_ORGANISATIONS = ["IsItLegit Eval", "Fynbos Freight"] as const;
// Evidence of an invoice or a payment document that carries a finding (the PDF forensics' checks, D06 T02).
export const INVOICE_CHECK_PREFIXES = ["document.forensics."] as const;
// The checks that name a changed bank account: none is registered yet, so the count says "not counted" rather than 0.
export const BANK_CHANGE_CHECKS: readonly string[] = [];

export type ProductionCounts = {
  since: string;
  cases: number;
  flagged: number;
  invoiceFlags: number;
  bankChanges: number | null;
  reportedWrong: number;
  medianSeconds: number | null;
};
