// Brings the Meta spend made before the budget guard into its table (D03 T01 §2), so the caps start from what was
// really spent: every entry in the shared ledger (~/isitlegit-data/ledgers/meta-spend.json, the smoke test's and the
// Glimmer lane's teacher labels), and the spend recorded before that ledger existed. Each row's id comes from its
// source, inserted with INSERT OR IGNORE, so a second run adds nothing. Run with the operator's Wrangler login:
//
//   node scripts/meta-spend-import.ts [--dry]
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import type { Statement } from "../src/meta/budget-sql.ts";
import { execute } from "./lib/meta-budget.ts";
import { metaLedger, readLedger, type Spend } from "./meta-smoke.ts";
import { installSignalCleanup, type Runner, runCommand } from "./smoke.ts";

// Spend recorded before the shared ledger, from the records that hold it: the smoke test's total to its last run
// (docs/meta-smoke-test.md, run 2026-10-27T16:32:55Z, "Spend so far US$0.008507") and the client's live check
// (docs/live-checks.md "Meta model client", run 2026-10-28T16:43:00Z, US$0.000291).
export const BEFORE_LEDGER = [
  {
    id: "import:meta-smoke:2026-10-27",
    day: "2026-10-27",
    caller: "meta-smoke",
    model: "muse-spark-1.3",
    usd: 0.008507,
  },
  {
    id: "import:meta-client-live:2026-10-28",
    day: "2026-10-28",
    caller: "meta-client-live",
    model: "muse-spark-1.3",
    usd: 0.000291,
  },
] as const;

export type ImportRow = {
  id: string;
  day: string;
  caller: string;
  model: string;
  estimate: number;
  actual: number | null;
  state: Spend["state"];
};

// A ledger entry as a row: its id from its own fields, its day the date it was recorded on (the ledger's dates are the
// SAST days the smoke and the lane counted on), its cost when settled, its estimate counted otherwise.
export function rowOf(entry: Spend): ImportRow {
  const id = `ledger:${createHash("sha256").update(`${entry.date}\n${entry.run}\n${entry.call}`).digest("hex").slice(0, 32)}`;
  const model = entry.call.split(" ")[0] ?? "unknown";
  return {
    id,
    day: entry.date,
    caller: entry.run.slice(0, 120) || "ledger",
    model,
    estimate: entry.estimate,
    actual: entry.state === "settled" ? entry.cost : null,
    state: entry.state,
  };
}

export function importStatement(row: ImportRow): Statement {
  return {
    sql: `INSERT OR IGNORE INTO model_spend (id, at, day, source, caller, model, case_id, attempt, estimate_usd, actual_usd, state)
VALUES (?1, ?2, ?3, 'local', ?4, ?5, NULL, 1, ?6, ?7, ?8)`,
    params: [row.id, `${row.day}T12:00:00.000Z`, row.day, row.caller, row.model, row.estimate, row.actual, row.state],
  };
}

export function rowsToImport(ledger: Spend[]): ImportRow[] {
  return [
    ...BEFORE_LEDGER.map((r) => ({
      id: r.id,
      day: r.day,
      caller: r.caller,
      model: r.model,
      estimate: r.usd,
      actual: r.usd,
      state: "settled" as const,
    })),
    ...ledger.map(rowOf),
  ];
}

export async function importSpend(
  ledger: Spend[],
  run: Runner = runCommand,
): Promise<{ added: number; total: number }> {
  const rows = rowsToImport(ledger);
  let added = 0;
  for (const row of rows) added += (await execute(importStatement(row), run)).meta?.changes ?? 0;
  const total = rows.reduce((sum, r) => sum + (r.state === "settled" ? (r.actual ?? r.estimate) : r.estimate), 0);
  return { added, total };
}

if (import.meta.filename === process.argv[1]) {
  const { values } = parseArgs({ options: { dry: { type: "boolean", default: false } }, strict: true });
  installSignalCleanup("meta-spend-import");
  const ledger = readLedger(metaLedger());
  const rows = rowsToImport(ledger);
  console.log(
    `meta-spend-import: ${rows.length} rows (${BEFORE_LEDGER.length} before the ledger, ${ledger.length} from it)`,
  );
  if (values.dry) process.exit(0);
  try {
    const { added, total } = await importSpend(ledger);
    console.log(
      `meta-spend-import: ${added} added, ${rows.length - added} already there; imported spend US$${total.toFixed(6)}`,
    );
  } catch (error) {
    console.error(`meta-spend-import: ${(error as Error).message}`);
    process.exit(1);
  }
}
