// A local key-check wake that never gets an answer, run as its own process so a test can kill it mid-request (D03 T04 §35):
// argv are the ledger's SQLite file and the evidence folder. It reserves in that ledger, writes its evidence and sends its
// request through a fetcher that never answers.
import { DatabaseSync } from "node:sqlite";
import { checkInferenceKey } from "../../../scripts/glimmer/deploy.ts";
import type { Exec } from "../../../src/vision/glimmer-minutes.ts";

const [file, evidence] = process.argv.slice(2) as [string, string];
const db = new DatabaseSync(file);
// The test reads this file while this process writes it: wait for a lock instead of failing, as a loaded runner will make
// the two overlap.
db.exec("PRAGMA busy_timeout = 20000");
const exec: Exec = async ({ sql, params }) => {
  const statement = db.prepare(sql);
  if (/^\s*SELECT/i.test(sql)) return { rows: statement.all(...params) as Record<string, unknown>[], changes: 0 };
  return { rows: [], changes: Number(statement.run(...params).changes) };
};
// The request never answers, so something must keep the event loop alive until the test kills this process.
setInterval(() => {}, 1_000);
const never = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
await checkInferenceKey(
  "1.0",
  "key",
  never,
  15 * 60_000,
  async () => {},
  Date.now,
  exec,
  () => {},
  evidence,
);
