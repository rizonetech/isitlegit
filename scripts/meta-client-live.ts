// The live checkpoint of D03 T01 §1: one call through src/meta/client.ts's metaResponses, the route the Worker takes,
// and its gateway log read back, which must hold the call's metadata and no stored request or response body.
//
// It spends under the smoke's guard (scripts/meta-smoke.ts, D00 T01 §7): the same lock, the same caps and the same
// ledger (`metaLedger()`, outside every checkout, which D03 T01 §2's budget guard counts). The caps are checked before any secret
// is read; each attempt's estimate is reserved before it is sent (the client may try three times) and the answered one
// settled at Meta's reported cost after, so an interrupted run still counts what it may have spent. An answered call is
// kept (its log id and counts, no body) until its log is checked and recorded, so a failed check is resumed by running
// again, with no second call. The Meta key, the gateway's Run token and its admin token (the log read-back only,
// never a Worker secret) come from Conclave through conclave-op and are never printed.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { ModelError, metaResponses } from "../src/meta/client.ts";
import {
  adoptLegacyLedger,
  checkLog,
  DAY_CAP,
  GATEWAY_URL,
  LEGACY_LEDGER,
  LOGS_URL,
  metaLedger,
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
ledger, each attempt reserved before it is sent. A run whose call was answered but whose log check or record failed is
resumed by running again: no second call is made. --confirm-credit is required: the call is billed.`;

export type LiveOptions = {
  readSecrets?: () => Promise<Secrets>;
  fetch?: typeof fetch;
  ledger?: string;
  legacyLedger?: string;
  // The answered call awaiting its log check and record (meta-client-live-pending.json beside the ledger).
  pending?: string;
  record?: string;
  now?: () => Date;
  runCap?: number;
  dayCap?: number;
  logWaitMs?: number;
  pause?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};
export type LiveOutcome = { code: 0 | 1; lines: string[] };
// A call in flight or answered, until its log is checked and recorded: no body, only its identifiers and counts. It is
// written before the call is sent (logId null), so a call whose answer could not be saved is never sent again unasked.
export type Pending = {
  run: string;
  logId: string | null;
  usage: Usage | null;
  cost: number | null;
  estimate: number;
  // What identifies a call that may have been answered but could not be verified, to find it by: the gateway's log
  // ids of failed attempts, or Meta's response id when the gateway gave none.
  traces?: string[];
};

type Say = (line: string) => void;

export async function runClientLive(options: LiveOptions = {}): Promise<LiveOutcome> {
  const lines: string[] = [];
  const say: Say = (line) => {
    lines.push(line);
    options.log?.(line);
  };
  // The shared ledger and, beside it, the call in flight: both outside every checkout, so no lane repeats a call another
  // made or spends past the caps another reached.
  const ledgerFile = options.ledger ?? metaLedger();
  const pendingFile = options.pending ?? join(dirname(ledgerFile), "meta-client-live-pending.json");
  const legacy = options.ledger ? options.legacyLedger : (options.legacyLedger ?? LEGACY_LEDGER);
  // The shared ledger's folder, made on first use; one that cannot be made is refused by the lock just below, which
  // names the cause.
  try {
    mkdirSync(dirname(ledgerFile), { recursive: true });
  } catch {
    // refused by takeLock
  }
  const unlock = takeLock(`${ledgerFile}.lock`);
  if (typeof unlock === "string") {
    say(`meta-client-live: refused: ${unlock}`);
    return { code: 1, lines };
  }
  try {
    const unmoved = adoptLegacyLedger(ledgerFile, legacy);
    if (unmoved) {
      say(`meta-client-live: refused: ${unmoved}`);
      return { code: 1, lines };
    }
    return await run(options, ledgerFile, pendingFile, say, lines);
  } finally {
    unlock();
  }
}

async function run(
  options: LiveOptions,
  ledgerFile: string,
  pendingFile: string,
  say: Say,
  lines: string[],
): Promise<LiveOutcome> {
  const refuse = (why: string): LiveOutcome => {
    say(`meta-client-live: refused: ${why}`);
    return { code: 1, lines };
  };
  const readSecrets = options.readSecrets ?? readSecretsFromVault;
  const fetchImpl = options.fetch ?? fetch;

  // An answered call still to verify is finished first, with no new call.
  if (existsSync(pendingFile)) {
    let pending: Pending;
    try {
      pending = JSON.parse(readFileSync(pendingFile, "utf-8"));
      if (typeof pending?.run !== "string" || !(typeof pending.logId === "string" || pending.logId === null))
        throw new Error("no run or log id");
    } catch (error) {
      return refuse(
        `${pendingFile} is unreadable (${(error as Error).message}); it holds an answered call's log id, so repair it rather than delete it`,
      );
    }
    if (pending.logId === null) {
      const logs = pending.traces?.length ? `, ${pending.traces.join(" or ")}` : "";
      return refuse(
        `the call of ${pending.run} was sent and its answer was not saved, so it is not sent again; find it in the gateway's log (its time, model ${MODEL}${logs}), record it, then remove ${pendingFile} to make a new call`,
      );
    }
    const answered = { ...pending, logId: pending.logId };
    let secrets: Secrets;
    try {
      secrets = await readSecrets();
    } catch (error) {
      return refuse((error as Error).message);
    }
    say(`resuming: the call of ${answered.run} was answered (log ${answered.logId}); verifying it, no new call`);
    return verify(options, pendingFile, answered, secrets, fetchImpl, say, lines);
  }

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
  const overCap = (attempt: number) => {
    const spentToday = spentOn(ledger, today);
    if (attempt * estimate > runCap)
      return `${attempt} attempt(s) could cost US$${(attempt * estimate).toFixed(6)}, over the US$${runCap} cap`;
    if (spentToday + estimate > dayCap)
      return `US$${spentToday.toFixed(4)} spent under the smoke's ledger today; another attempt's US$${estimate.toFixed(6)} would pass the US$${dayCap} a day`;
    return null;
  };
  const before = overCap(1);
  if (before) return refuse(before);

  // 2. The secrets, never printed: any line said is scrubbed of them.
  let secrets: Secrets;
  try {
    secrets = await readSecrets();
  } catch (error) {
    return refuse((error as Error).message);
  }
  const safe = scrub(secrets);

  // 3. Sent, every attempt reserved first: the client may try three times, and each may be charged.
  const attempts: Spend[] = [];
  let stopped: string | null = null;
  const guarded = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(GATEWAY_URL)) {
      const over = overCap(attempts.length + 1);
      const reserved = over
        ? { refused: over }
        : reserveSpend(ledgerFile, ledger, {
            date: today,
            run: runId,
            call: `client Spark attempt ${attempts.length + 1}`,
            estimate,
          });
      if ("refused" in reserved) {
        stopped = reserved.refused;
        throw new Error("spend refused");
      }
      attempts.push(reserved.entry);
    }
    return fetchImpl(input, init);
  }) as typeof fetch;
  // The call marked as sent before it is: a failure to save its answer later cannot lead to a second paid call.
  try {
    writeWhole(
      pendingFile,
      `${JSON.stringify({ run: runId, logId: null, usage: null, cost: null, estimate } satisfies Pending, null, 1)}\n`,
    );
  } catch (error) {
    return refuse(`${pendingFile} could not be written (${(error as Error).message}), so nothing was sent`);
  }
  const unmark = () => {
    try {
      rmSync(pendingFile, { force: true });
    } catch (error) {
      say(
        `meta-client-live: ${pendingFile} could not be removed (${(error as Error).message}); remove it to run again`,
      );
    }
  };
  let answer: Awaited<ReturnType<typeof metaResponses>>;
  try {
    answer = await metaResponses(
      { model: MODEL, input: PROMPT, max_output_tokens: MAX_OUTPUT_TOKENS },
      {
        env: { META_API_KEY: secrets.meta, CF_AIG_TOKEN: secrets.run, META_GATEWAY_URL: GATEWAY_URL },
        fetch: guarded,
        deadlineMs: 60_000,
      },
    );
  } catch (error) {
    // Whether Meta charged any attempt is unknown: each reservation stands at its estimate.
    for (const entry of attempts) {
      const unsettled = settleSpend(ledgerFile, ledger, entry, null);
      if (unsettled) say(`meta-client-live: ${unsettled}`);
    }
    // Only a call Meta certainly did not answer may be made again: nothing was sent, or Meta refused every attempt
    // with an error status. Any other failure after sending (a 200 cut off mid-body, a timeout, a dropped connection)
    // may have been answered and charged, so the mark stays, naming what the gateway logged, and a rerun refuses.
    const failed = (error instanceof ModelError ? (error.details.attempts ?? []) : []).slice(0, attempts.length);
    const refused =
      failed.length === attempts.length &&
      failed.every((a) => a.status !== undefined && a.status >= 400 && a.kind !== "timeout");
    const why = error instanceof ModelError ? `${error.kind}: ${error.message}` : (error as Error).name;
    if (refused) unmark();
    else {
      const traces = failed.flatMap((a) => (a.logId === null ? [] : [`log ${a.logId}`]));
      try {
        writeWhole(
          pendingFile,
          `${JSON.stringify({ run: runId, logId: null, usage: null, cost: null, estimate, traces } satisfies Pending, null, 1)}\n`,
        );
      } catch {
        // The mark from before the call stands, without the log ids.
      }
      say(
        safe(
          `failed: the call did not complete (${why}) and may have been answered${traces.length ? ` (${traces.join(" or ")})` : ""}; a rerun will not call again until it is found in the gateway's log and ${pendingFile} is removed`,
        ),
      );
      if (stopped) say(`meta-client-live: stopped before attempt ${attempts.length + 1}: ${stopped}`);
      return { code: 1, lines };
    }
    if (stopped) return refuse(`stopped before attempt ${attempts.length + 1}: ${stopped}`);
    say(safe(`failed: the call did not complete (${why})`));
    return { code: 1, lines };
  }

  // 4. Settled: the answered attempt at Meta's reported usage, any earlier one left at its estimate.
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
  attempts.forEach((entry, i) => {
    const unsettled = settleSpend(ledgerFile, ledger, entry, i === attempts.length - 1 ? cost : null);
    if (unsettled) say(`meta-client-live: ${unsettled}; the reservation stands at its estimate`);
  });
  if (!answer.logId) {
    // Answered and charged, but with nothing to verify by: the mark stays, naming Meta's response id, so a rerun
    // refuses rather than pays again. After a call is sent, only a finished verification or a call Meta certainly did
    // not answer removes the mark.
    const traces = [`response ${answer.data.id}`];
    try {
      writeWhole(
        pendingFile,
        `${JSON.stringify({ run: runId, logId: null, usage, cost, estimate, traces } satisfies Pending, null, 1)}\n`,
      );
    } catch {
      // The mark from before the call stands, without the response id.
    }
    say(
      safe(
        `failed: no cf-aig-log-id came back, so the gateway did not log the call (${traces[0]}); a rerun will not call again until ${pendingFile} is removed`,
      ),
    );
    return { code: 1, lines };
  }

  // 5. The answer kept before it is verified, so a failed check or record is resumed without paying again. Unsaved,
  // the mark from step 3 stays: a failed check is then not retried by a new call, and the log id is said here.
  const pending = { run: runId, logId: answer.logId, usage, cost, estimate };
  try {
    writeWhole(pendingFile, `${JSON.stringify(pending, null, 1)}\n`);
  } catch (error) {
    say(
      `meta-client-live: ${pendingFile} could not be written (${(error as Error).message}); the answered call's log is ${answer.logId}`,
    );
  }
  return verify(options, pendingFile, pending, secrets, fetchImpl, say, lines);
}

// The gateway's log: this call's metadata, and no stored body; then the record. The pending file goes only when both
// are done.
async function verify(
  options: LiveOptions,
  pendingFile: string,
  pending: Pending & { logId: string },
  secrets: Secrets,
  fetchImpl: typeof fetch,
  say: Say,
  lines: string[],
): Promise<LiveOutcome> {
  const safe = scrub(secrets);
  // A rerun resumes only an answer the pending file holds; otherwise it refuses, and the log id is the way back.
  let saved = false;
  try {
    saved = JSON.parse(readFileSync(pendingFile, "utf-8"))?.logId === pending.logId;
  } catch {
    // not saved
  }
  const resume = saved
    ? "; run again to resume, no new call is made"
    : `; it was not saved, so a rerun will not call again: record log ${pending.logId} by hand`;
  const planned: Planned = { name: "client Spark", model: MODEL, body: {}, stream: false, estimate: pending.estimate };
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
  const logCheck = await checkLog(getLog, pending.logId, planned, pending.usage, options.logWaitMs, options.pause);
  if (!logCheck.ok) {
    say(safe(`failed: ${logCheck.detail} (log ${pending.logId})${resume}`));
    return { code: 1, lines };
  }
  const { usage, cost } = pending;
  const row = `| ${pending.run} | \`${MODEL}\` | passed | ${usage?.input ?? "?"} / ${usage?.output ?? "?"} | US$${(cost ?? pending.estimate).toFixed(6)} | \`${pending.logId}\`: ${logCheck.detail} |`;
  try {
    appendRecord(options.record ?? join(ROOT, "docs/live-checks.md"), row);
  } catch (error) {
    say(`failed: the record could not be written (${(error as Error).message})${resume}`);
    return { code: 1, lines };
  }
  rmSync(pendingFile, { force: true });
  say(safe(`passed: ${MODEL} through src/meta/client.ts; log ${pending.logId}: ${logCheck.detail}`));
  return { code: 0, lines };
}

const scrub = (secrets: Secrets) => (text: string) =>
  Object.values(secrets).reduce((t, s) => (s ? t.split(s).join("[secret]") : t), text);

function writeWhole(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
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
  writeWhole(file, text.endsWith("\n") ? text : `${text}\n`);
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
