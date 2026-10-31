// A child process for D08 T03 §8: the edited-digits runner over a set folder, its Meta calls stubbed, so a test can
// kill it mid-request and resume against what it left behind (its results file, its run lock, the shared ledger).
//
//   node test/node/fixtures/digits-child.ts <set folder> <ledger file> <answer|hang|silent> [marker file] [--retry-pending]
//
// `answer` answers every request; `hang` answers two, then writes the marker file on the third and never answers it;
// `silent` never answers and never writes the marker (a child that hangs before the point a test waits for).
// Prints {"report": <the run's report>, "sent": <requests made>} as one JSON line when the run ends.
import { writeFileSync } from "node:fs";
import { runSet, sharedLedger } from "../../../eval/frontier/digits.ts";
import type { Budget } from "../../../src/meta/guard.ts";

const args = process.argv.slice(2);
const retryPending = args.includes("--retry-pending");
const [dir, ledgerFile, mode, marker] = args.filter((a) => a !== "--retry-pending");
if (!dir || !ledgerFile || !["answer", "hang", "silent"].includes(mode ?? "") || (mode === "hang" && !marker)) {
  console.error(
    "usage: digits-child.ts <set folder> <ledger file> <answer|hang|silent> [marker file] [--retry-pending]",
  );
  process.exit(2);
}

const answer = JSON.stringify({ edited: false, confidence: 0.1, regions: [] });
const reply = () =>
  new Response(
    JSON.stringify({
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] }],
      output_text: answer,
      usage: { input_tokens: 2000, output_tokens: 1000 },
    }),
    { status: 200, headers: { "content-type": "application/json", "cf-aig-log-id": "log-1" } },
  );

let sent = 0;
const fetch = (async () => {
  sent++;
  if (mode === "silent") return new Promise<Response>(() => {});
  if (mode === "hang" && sent === 3) {
    writeFileSync(marker as string, String(process.pid));
    return new Promise<Response>(() => {}); // killed here, the answer never stored
  }
  return reply();
}) as typeof globalThis.fetch;

// The guard's side, in memory: it accepts every reservation.
const guard: Budget = {
  reserve: async (_model, _estimate, _attempt, id) => id as string,
  settle: async () => {},
  uncertain: async () => {},
  refused: async () => {},
  cached: async () => {},
  outputFailed: async () => {},
};

const report = await runSet({
  dir,
  context: {
    env: {
      META_API_KEY: "LLM_test_key_0123456789",
      CF_AIG_TOKEN: "aig-token-0123456789",
      META_GATEWAY_URL: "https://gateway.test/v1/",
    },
    fetch,
    sleep: async () => {},
    random: () => 0.5,
  },
  guard,
  ledger: sharedLedger(ledgerFile, "eval-frontier-digits-child", { waitMs: 0 }),
  retryPending,
  now: () => new Date("2026-10-31T10:00:00Z"),
});
console.log(JSON.stringify({ report, sent }));
