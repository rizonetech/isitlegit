// The live checkpoint of D03 T01 §1: one call through src/meta/client.ts's metaResponses, the route the Worker takes,
// and its gateway log read back, which must hold the call's metadata and no stored request or response body.
//
// It spends under the smoke's guard (scripts/meta-smoke.ts, D00 T01 §7): the same lock, the same caps and the same
// ledger (build/meta-smoke-spend.json, which D03 T01 §2's budget guard counts). The caps are checked before any secret
// is read; the call's estimate is reserved before it is sent and settled at Meta's reported cost after it, so an
// interrupted run still counts it. The Meta key, the gateway's Run token and its admin token (the log read-back only,
// never a Worker secret) come from Conclave through conclave-op and are never printed.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ModelError, metaResponses } from "../src/meta/client.ts";
import {
  checkLog,
  DAY_CAP,
  GATEWAY_URL,
  LOGS_URL,
  type Planned,
  RUN_CAP,
  readLedger,
  readSecretsFromVault,
  reserveSpend,
  type Secrets,
  type Spend,
  settleSpend,
  spentOn,
  takeLock,
  tokenCost,
  type Usage,
} from "./meta-smoke.ts";
import { installSignalCleanup } from "./smoke.ts";

const ROOT = join(import.meta.dirname, "..");
const MODEL = "muse-spark-1.3";
const MAX_OUTPUT_TOKENS = 64;
// Generous for the one short prompt below, so the estimate is a ceiling.
const INPUT_TOKENS_CEILING = 200;
const PROMPT = "Reply with the single word: ok";
const RECORD_HEADING = "## Meta model client";

export const USAGE = `node scripts/meta-client-live.ts --confirm-credit

One Muse Spark call (at most ${MAX_OUTPUT_TOKENS} output tokens) through src/meta/client.ts and AI Gateway, its log read
back for metadata and no stored body, recorded in docs/live-checks.md. Spends under scripts/meta-smoke.ts's caps and
ledger. --confirm-credit is required: the call is billed.`;

export type LiveOptions = {
  readSecrets?: () => Promise<Secrets>;
  fetch?: typeof fetch;
  ledger?: string;
  record?: string;
  now?: () => Date;
  runCap?: number;
  dayCap?: number;
  logWaitMs?: number;
  pause?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};
export type LiveOutcome = { code: 0 | 1; lines: string[] };

export async function runClientLive(options: LiveOptions = {}): Promise<LiveOutcome> {
  const lines: string[] = [];
  const say = (line: string) => {
    lines.push(line);
    options.log?.(line);
  };
  const ledgerFile = options.ledger ?? join(ROOT, "build/meta-smoke-spend.json");
  const unlock = takeLock(`${ledgerFile}.lock`);
  if (typeof unlock === "string") {
    say(`meta-client-live: refused: ${unlock}`);
    return { code: 1, lines };
  }
  try {
    return await spend(options, ledgerFile, say, lines);
  } finally {
    unlock();
  }
}

async function spend(
  options: LiveOptions,
  ledgerFile: string,
  say: (line: string) => void,
  lines: string[],
): Promise<LiveOutcome> {
  const refuse = (why: string): LiveOutcome => {
    say(`meta-client-live: refused: ${why}`);
    return { code: 1, lines };
  };
  const now = options.now ?? (() => new Date());
  const today = now().toISOString().slice(0, 10);
  const runId = now().toISOString();
  const estimate = tokenCost(MODEL, INPUT_TOKENS_CEILING, MAX_OUTPUT_TOKENS);

  // 1. The caps, before any secret is read.
  let ledger: Spend[];
  try {
    ledger = readLedger(ledgerFile);
  } catch (error) {
    return refuse(`${ledgerFile} is unreadable (${(error as Error).message}); it records Meta spend, so repair it`);
  }
  const runCap = options.runCap ?? RUN_CAP;
  const dayCap = options.dayCap ?? DAY_CAP;
  const spentToday = spentOn(ledger, today);
  if (estimate > runCap) return refuse(`the call could cost US$${estimate.toFixed(6)}, over the US$${runCap} cap`);
  if (spentToday + estimate > dayCap)
    return refuse(
      `US$${spentToday.toFixed(4)} spent under the smoke's ledger today; this call's US$${estimate.toFixed(6)} would pass the US$${dayCap} a day`,
    );

  // 2. The secrets, never printed: any line said is scrubbed of them.
  let secrets: Secrets;
  try {
    secrets = await (options.readSecrets ?? readSecretsFromVault)();
  } catch (error) {
    return refuse((error as Error).message);
  }
  const safe = (text: string) => Object.values(secrets).reduce((t, s) => (s ? t.split(s).join("[secret]") : t), text);
  const fetchImpl = options.fetch ?? fetch;

  // 3. Reserved, then sent.
  const reserved = reserveSpend(ledgerFile, ledger, { date: today, run: runId, call: "client Spark", estimate });
  if ("refused" in reserved) return refuse(reserved.refused);
  const { entry } = reserved;
  let answer: Awaited<ReturnType<typeof metaResponses>>;
  try {
    answer = await metaResponses(
      { model: MODEL, input: PROMPT, max_output_tokens: MAX_OUTPUT_TOKENS },
      {
        env: { META_API_KEY: secrets.meta, CF_AIG_TOKEN: secrets.run, META_GATEWAY_URL: GATEWAY_URL },
        fetch: fetchImpl,
        deadlineMs: 60_000,
      },
    );
  } catch (error) {
    // Whether Meta charged is unknown: the reservation stands at its estimate.
    const unsettled = settleSpend(ledgerFile, ledger, entry, null);
    const why = error instanceof ModelError ? `${error.kind}: ${error.message}` : (error as Error).name;
    say(safe(`failed: the call did not complete (${why})`));
    if (unsettled) say(`meta-client-live: ${unsettled}`);
    return { code: 1, lines };
  }

  // 4. Settled at Meta's reported usage.
  const counts = answer.data.usage;
  const usage: Usage | null =
    counts && Number.isInteger(counts.input_tokens) && Number.isInteger(counts.output_tokens)
      ? {
          input: counts.input_tokens,
          output: counts.output_tokens,
          cached: counts.input_tokens_details?.cached_tokens ?? 0,
        }
      : null;
  const cost = usage ? tokenCost(MODEL, usage.input, usage.output, usage.cached) : null;
  const unsettled = settleSpend(ledgerFile, ledger, entry, cost);
  if (unsettled) say(`meta-client-live: ${unsettled}; the reservation stands at its estimate`);

  // 5. The gateway's log: this call's metadata, and no stored body.
  if (!answer.logId) {
    say("failed: no cf-aig-log-id came back, so the gateway did not log the call");
    return { code: 1, lines };
  }
  const planned: Planned = { name: "client Spark", model: MODEL, body: {}, stream: false, estimate };
  const getLog = async (path: string) => {
    const response = await fetchImpl(`${LOGS_URL}${path}`, {
      headers: { authorization: `Bearer ${secrets.admin}`, "user-agent": "isitlegit-meta-client-live/1.0" },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // kept as text
    }
    return { status: response.status, body };
  };
  const logCheck = await checkLog(getLog, answer.logId, planned, usage, options.logWaitMs, options.pause);
  if (!logCheck.ok) {
    say(safe(`failed: ${logCheck.detail} (log ${answer.logId})`));
    return { code: 1, lines };
  }

  // 6. Recorded.
  const row = `| ${runId} | \`${MODEL}\` | passed | ${usage?.input ?? "?"} / ${usage?.output ?? "?"} | US$${(cost ?? estimate).toFixed(6)} | \`${answer.logId}\`: ${logCheck.detail} |`;
  try {
    appendRecord(options.record ?? join(ROOT, "docs/live-checks.md"), row);
  } catch (error) {
    say(`failed: the record could not be written (${(error as Error).message})`);
    return { code: 1, lines };
  }
  say(safe(`passed: ${MODEL} through src/meta/client.ts; log ${answer.logId}: ${logCheck.detail}`));
  return { code: 0, lines };
}

// The row under the record's heading, the table made the first time; written whole, through a temporary file.
function appendRecord(file: string, row: string): void {
  let text = existsSync(file) ? readFileSync(file, "utf-8") : "";
  if (!text.includes(RECORD_HEADING))
    text = `${text.trimEnd()}\n\n${RECORD_HEADING}\n\nOne call through \`src/meta/client.ts\` by \`node scripts/meta-client-live.ts --confirm-credit\` (D03 T01 §1), its gateway log read back.\n\n| Run (UTC) | Model | Result | Meta tokens in / out | Cost | Gateway log |\n| --- | --- | --- | --- | --- | --- |\n`;
  const at = text.indexOf(RECORD_HEADING);
  const next = text.indexOf("\n## ", at + RECORD_HEADING.length);
  const end = next < 0 ? text.length : next;
  text = `${text.slice(0, end).trimEnd()}\n${row}\n${text.slice(end)}`;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text.endsWith("\n") ? text : `${text}\n`);
  renameSync(tmp, file);
}

if (import.meta.filename === process.argv[1]) {
  let confirmed: boolean;
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { "confirm-credit": { type: "boolean", default: false }, help: { type: "boolean", short: "h" } },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      console.log(USAGE);
      process.exit(0);
    }
    confirmed = values["confirm-credit"];
  } catch (error) {
    console.error(`meta-client-live: ${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (!confirmed) {
    console.error(`meta-client-live: --confirm-credit is required\n\n${USAGE}`);
    process.exit(2);
  }
  installSignalCleanup("meta-client-live");
  const outcome = await runClientLive({ log: (line) => console.log(line) });
  process.exit(outcome.code);
}
