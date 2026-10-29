// The Meta smoke test (D00 T01 §7): one call per capability the product relies on, through AI Gateway `isitlegit`,
// each judged by what it returns, and each call's gateway log read back to prove the gateway kept the call's metadata
// and cost but no body. A run passes only when every check passes; anything else exits non-zero.
//
//   Spark text      muse-spark-1.3 answers a fixed sum with exactly the number.
//   Spark image     muse-spark-1.3 reads a random code printed only on test/fixtures/meta-smoke/code-card.png.
//   SAM 3.1         sam-3.1, streamed to `response.completed` and parsed with @meta-sam/parser, finds the logo on
//                   logo-card.png (a box overlapping its known area).
//   Wonder          muse-wonder-1.0, given a `click(x, y)` function, makes exactly one click inside Continue on
//                   continue-page.png (a screenshot; no browser is driven and no URL is opened). Meta's native computer
//                   tool is refused for our key, so function tools are the design (operator, 2026-10-27; D04 T02).
//
// Every request carries `store: false`, an output ceiling, the gateway's Run token and `cf-aig-collect-log: true` with
// `cf-aig-collect-log-payload: false`; no `-contributor` model is ever sent (Meta's terms, spec 4.8); one deadline
// bounds each call from request to the end of its stream. Spend: the run's worst case is refused above US$0.50 or
// above US$2 of smoke spend that day; each call's estimate is reserved in the shared Meta ledger (metaLedger) before it is
// sent and settled with its real cost after, so an interrupted or failed run never loses a charge. The report,
// docs/meta-smoke-test.md, is rewritten after each call, so an interrupted run shows as in progress. Secrets come
// from Conclave through conclave-op and are never printed.
//
//   node scripts/meta-smoke.ts --help
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseImageStream, recordsOfKind } from "@meta-sam/parser";
import OpenAI from "openai";
import { z } from "zod";
import { describeError, metadataHeader, traced } from "../src/meta/client.ts";
import { sastDay } from "../src/meta/day.ts";
import { type Budget, BudgetExceeded, type Described } from "../src/meta/guard.ts";
import type { ModelId } from "../src/meta/models.ts";
import { ledgerId, localBudget } from "./lib/meta-budget.ts";
import { installSignalCleanup, runCommand } from "./smoke.ts";

const ROOT = join(import.meta.dirname, "..");
const ACCOUNT_ID = "f5a529987f8dc7d52ce7aba3da25e226";
export const GATEWAY_URL = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/isitlegit/custom-meta/v1`;
export const LOGS_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai-gateway/gateways/isitlegit/logs`;
const VAULT = {
  meta: "IsItLegit Meta Model API",
  run: "IsItLegit AI Gateway token",
  admin: "IsItLegit AI Gateway admin token",
} as const;
// US dollars per million tokens, as AI Gateway's pricing rules hold them (D00 T01 §6), cached input at its own rate;
// SAM is priced per image.
export const PRICES = {
  "muse-spark-1.3": { input: 1.25, cached: 0.15, output: 4.25 },
  "muse-wonder-1.0": { input: 4, cached: 0.2, output: 20 },
} as const;
export const SAM_PER_IMAGE = 2.5 / 1000;
export const RUN_CAP = 0.5;
export const DAY_CAP = 2;
export const MODELS = ["muse-spark-1.3", "sam-3.1", "muse-wonder-1.0"] as const;
const SMOKE_OWNER = { kind: "script", name: "meta-smoke" } as const;
// A generous worst case for an image's input tokens, so the estimate never undercounts.
const IMAGE_TOKENS = 4000;

export const USAGE = `node scripts/meta-smoke.ts [--dry | --confirm-credit] [--model <id>]

Calls each Meta capability the product relies on through AI Gateway isitlegit and checks the answers and the
gateway's logs (D00 T01 §7).
  --dry              print the requests and send nothing (no credit, no secrets needed)
  --confirm-credit   send them; spends Meta credit, so only once "Meta credit visible:" is recorded (D99 T01 §1)
  --model <id>       only the calls for one model: ${MODELS.join(", ")} (the report says the coverage is partial)
  --help             this text

Spend: refused above US$${RUN_CAP} a run or US$${DAY_CAP} a day; ~/isitlegit-data/ledgers/meta-spend.json (shared by
every checkout; ISITLEGIT_LEDGER_DIR moves it) records it.
Report: docs/meta-smoke-test.md. Exit codes: 0 every check passed, 1 a check failed, 2 refused before sending.`;

export type Fixtures = {
  code: string;
  logoBox: [number, number, number, number];
  buttonBox: [number, number, number, number];
  pageSize: { width: number; height: number }; // continue-page.png, from its PNG header
  images: { code: string; logo: string; page: string }; // data URLs
};

export function loadFixtures(dir = join(ROOT, "test/fixtures/meta-smoke")): Fixtures {
  const facts = JSON.parse(readFileSync(join(dir, "fixtures.json"), "utf-8"));
  const png = (name: string) => `data:image/png;base64,${readFileSync(join(dir, name)).toString("base64")}`;
  const page = readFileSync(join(dir, "continue-page.png"));
  return {
    code: facts.code,
    logoBox: facts.logoBox,
    buttonBox: facts.buttonBox,
    // The IHDR chunk follows the 8-byte signature: width and height are big-endian at bytes 16 and 20.
    pageSize: { width: page.readUInt32BE(16), height: page.readUInt32BE(20) },
    images: { code: png("code-card.png"), logo: png("logo-card.png"), page: png("continue-page.png") },
  };
}

// `interrupted` names how an answer failed to arrive whole (a stream cut off, unreadable or past its deadline), as the
// attempt's error class: a failure of the call, apart from a whole answer that fails the content check (round 2).
type Check = { ok: boolean; detail: string; excerpt?: string | undefined; interrupted?: string };
export type Planned = {
  name: string;
  model: (typeof MODELS)[number];
  body: Record<string, unknown>;
  stream: boolean;
  estimate: number; // worst-case US dollars
};

const userInput = (text: string, image?: string) => [
  {
    role: "user",
    content: [{ type: "input_text", text }, ...(image ? [{ type: "input_image", image_url: image }] : [])],
  },
];
export type Usage = { input: number; cached: number; output: number }; // `input` includes `cached`
export const tokenCost = (model: keyof typeof PRICES, input: number, output: number, cached = 0) =>
  ((input - cached) * PRICES[model].input + cached * PRICES[model].cached + output * PRICES[model].output) / 1_000_000;

// A native computer tool declares the display's size; this function stands in for one, so it says the same.
const clickTool = (size: Fixtures["pageSize"]) => ({
  type: "function",
  name: "click",
  description: `Click the left mouse button at a point on the screenshot, which is ${size.width} by ${size.height} pixels; x and y are pixels from its top-left corner.`,
  parameters: {
    type: "object",
    properties: {
      x: { type: "integer", minimum: 0, maximum: size.width - 1 },
      y: { type: "integer", minimum: 0, maximum: size.height - 1 },
    },
    required: ["x", "y"],
    additionalProperties: false,
  },
});

export function plannedCalls(fx: Fixtures): Planned[] {
  const spark = (name: string, text: string, image?: string): Planned => ({
    name,
    model: "muse-spark-1.3",
    stream: false,
    body: { model: "muse-spark-1.3", input: userInput(text, image), store: false, max_output_tokens: 1024 },
    estimate: tokenCost("muse-spark-1.3", 200 + (image ? IMAGE_TOKENS : 0), 1024),
  });
  return [
    spark("Spark text", "What is 17 multiplied by 3? Reply with the number only."),
    spark(
      "Spark image",
      "What code is printed on this card? Reply with the code only, exactly as printed.",
      fx.images.code,
    ),
    {
      name: "SAM 3.1",
      model: "sam-3.1",
      stream: true,
      body: { model: "sam-3.1", input: userInput("logo", fx.images.logo), store: false, stream: true },
      estimate: SAM_PER_IMAGE,
    },
    {
      name: "Wonder",
      model: "muse-wonder-1.0",
      stream: false,
      body: {
        model: "muse-wonder-1.0",
        tools: [clickTool(fx.pageSize)],
        // Meta allows only "auto" here.
        tool_choice: "auto",
        input: userInput("Click the Continue button.", fx.images.page),
        store: false,
        max_output_tokens: 2048,
      },
      estimate: tokenCost("muse-wonder-1.0", 200 + IMAGE_TOKENS, 2048),
    },
  ];
}

export function refuseContributor(model: string): string | null {
  return model.endsWith("-contributor")
    ? `${model} is a Contributor model; Meta may train on its input, and only Standard models are used (spec 4.8)`
    : null;
}

const overlap = (a: number[], b: number[]) => {
  const [al, at, ar, ab] = a as [number, number, number, number];
  const [bl, bt, br, bb] = b as [number, number, number, number];
  const w = Math.max(0, Math.min(ar, br) - Math.max(al, bl));
  const h = Math.max(0, Math.min(ab, bb) - Math.max(at, bt));
  const union = (ar - al) * (ab - at) + (br - bl) * (bb - bt) - w * h;
  return union > 0 ? (w * h) / union : 0;
};

const ClickArguments = z.object({ x: z.number().int(), y: z.number().int() }).strict();
// Output items that carry a tool call: the Wonder probe allows exactly one, a click.
const TOOL_CALLS = new Set(["function_call", "computer_call", "custom_tool_call", "mcp_call"]);
const bounded = (text: string) => text.replace(/\s+/g, " ").slice(0, 60);

// What each call's answer must show, given the fixtures' known facts. The response must have completed.
export function judge(name: string, fx: Fixtures, answer: unknown): Check {
  const envelope = answer as { status?: unknown; output_text?: unknown; output?: unknown };
  if (envelope?.status !== "completed")
    return { ok: false, detail: `the response's status is ${JSON.stringify(envelope?.status ?? null)}, not completed` };
  const text = typeof envelope.output_text === "string" ? envelope.output_text : "";
  const excerpt = bounded(text);
  if (name === "Spark text")
    return /^\s*51\.?\s*$/.test(text)
      ? { ok: true, detail: "answered 51", excerpt }
      : { ok: false, detail: `expected exactly 51, got ${JSON.stringify(excerpt)}`, excerpt };
  if (name === "Spark image") {
    const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
    return squash(text) === squash(fx.code)
      ? { ok: true, detail: "read exactly the code printed only on the fixture", excerpt }
      : { ok: false, detail: `expected exactly the fixture's code, got ${JSON.stringify(excerpt)}`, excerpt };
  }
  if (name === "Wonder") {
    const items = Array.isArray(envelope.output) ? envelope.output : [];
    const calls = items.filter((i) => TOOL_CALLS.has(String((i as { type?: unknown })?.type)));
    if (calls.length === 0) return { ok: false, detail: `no function call; returned ${JSON.stringify(excerpt)}` };
    if (calls.length > 1) return { ok: false, detail: `${calls.length} tool calls; exactly one click is allowed` };
    const call = calls[0] as { type?: unknown; name?: unknown; arguments?: unknown };
    if (call.type !== "function_call" || call.name !== "click")
      return { ok: false, detail: `called ${String(call.name ?? call.type)}, not click` };
    let args: unknown;
    try {
      args = JSON.parse(String(call.arguments));
    } catch {
      return { ok: false, detail: "the click's arguments are not JSON" };
    }
    const parsed = ClickArguments.safeParse(args);
    if (!parsed.success) return { ok: false, detail: `malformed click arguments: ${parsed.error.issues[0]?.message}` };
    const { x, y } = parsed.data;
    const [l, t, r, b] = fx.buttonBox;
    return x >= l && x <= r && y >= t && y <= b
      ? { ok: true, detail: `clicked Continue at (${x}, ${y})`, excerpt: `click(${x}, ${y})` }
      : { ok: false, detail: `clicked (${x}, ${y}), outside the button (${l}, ${t})-(${r}, ${b})` };
  }
  return { ok: false, detail: `no judge for ${name}` };
}

// SAM's stream, read to `response.completed` through Meta's parser: a box overlapping the logo passes; no box, a
// malformed stream or one cut off before completion each fail with its own reason.
export async function judgeSegmentation(events: AsyncIterable<{ type: string }>, fx: Fixtures): Promise<Check> {
  try {
    const parsed = parseImageStream(events);
    for await (const _ of parsed) {
      // the snapshots are not needed; the final result is
    }
    const result = await parsed.finalResult;
    const outcome = result.outcome;
    if (outcome.status !== "completed")
      return {
        ok: false,
        detail: `the stream ended ${outcome.status} (${outcome.reason}), not completed`,
        interrupted: "stream-incomplete",
      };
    // An error diagnostic means the parser dropped malformed data, which completion alone does not show.
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0)
      return { ok: false, detail: `the segmentation had ${errors.length} malformed part(s) (${errors[0]?.code})` };
    const boxes = recordsOfKind(result.records, "box");
    if (boxes.length === 0) return { ok: false, detail: "no logo found (a valid, empty answer)" };
    const best = Math.max(...boxes.map((x) => overlap([x.left, x.top, x.right, x.bottom], fx.logoBox)));
    const excerpt = `${boxes.length} box(es), best overlap ${best.toFixed(2)}`;
    return best >= 0.3
      ? { ok: true, detail: `${boxes.length} box(es); best overlap with the logo ${best.toFixed(2)}`, excerpt }
      : { ok: false, detail: `${boxes.length} box(es), none over the logo (best overlap ${best.toFixed(2)})` };
  } catch (error) {
    const e = error as Error;
    const late = e.name === "AbortError" || e.name === "TimeoutError" || /abort/i.test(e.message);
    return {
      ok: false,
      detail: late
        ? "the segmentation stream did not finish before the deadline"
        : `the segmentation stream could not be read: ${e.name}`,
      interrupted: late ? "timeout" : "stream-unreadable",
    };
  }
}

// The spend ledger: one entry per call, written before the call (reserved, at its estimate) and after it (settled at
// the cost Meta reported, or left uncertain at the estimate). A day's spend counts every entry's cost, else its
// estimate (an entry from before reservations has a cost and no state), so nothing charged is lost or counted as zero.
export type Spend = {
  date: string;
  run: string;
  call: string;
  estimate: number;
  cost: number | null;
  state: "reserved" | "settled" | "uncertain";
};
// The one Meta spend ledger of every checkout: each lane works its own worktree (todo/lanes.json), whose build/ is its
// own, so a ledger there would hold the caps per checkout. It lives outside every repository instead, beside the
// Glimmer store; ISITLEGIT_LEDGER_DIR moves it, `~` expanded as scripts/glimmer/store.ts expands GLIMMER_DATA_DIR.
export function metaLedger(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || homedir();
  const configured = env.ISITLEGIT_LEDGER_DIR;
  const expanded =
    configured === "~" ? home : configured?.startsWith("~/") ? join(home, configured.slice(2)) : configured;
  return join(resolve(expanded || join(home, "isitlegit-data", "ledgers")), "meta-spend.json");
}
// Where each checkout kept its ledger before it was shared.
export const LEGACY_LEDGER = join(ROOT, "build/meta-smoke-spend.json");

// A checkout's ledger from before is moved into the shared one, under the shared one's lock: every entry not already
// there is added (an entry is its date, run and call), then the old file is set aside as `.moved`, so no spend it
// recorded is lost or counted twice. Answers why it could not be moved, or null.
export function adoptLegacyLedger(file: string, legacy: string | undefined): string | null {
  if (!legacy || !existsSync(legacy) || resolve(legacy) === resolve(file)) return null;
  let old: Spend[];
  let current: Spend[];
  try {
    old = readLedger(legacy);
    current = readLedger(file);
  } catch (error) {
    return `${legacy} could not be moved into ${file} (${(error as Error).message}); repair the unreadable one rather than delete it`;
  }
  const key = (e: Partial<Spend>) => `${e.date}\n${e.run}\n${e.call}`;
  const held = new Set(current.map(key));
  const unsaved = saveLedger(file, [...current, ...old.filter((e) => !held.has(key(e)))]);
  if (unsaved) return unsaved;
  try {
    renameSync(legacy, `${legacy}.moved`);
  } catch (error) {
    return `${legacy} was copied into ${file} but could not be set aside (${(error as Error).message}); rename it to ${legacy}.moved`;
  }
  return null;
}

export function readLedger(file: string): Spend[] {
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, "utf-8"));
  if (!Array.isArray(data)) throw new Error("not a list of spend entries");
  return data;
}
const counted = (entry: Partial<Spend>) => (typeof entry.cost === "number" ? entry.cost : Number(entry.estimate ?? 0));
// A day's spend: every entry's cost, else its estimate.
export const spentOn = (ledger: Spend[], date: string) =>
  ledger.filter((e) => e.date === date).reduce((sum, e) => sum + counted(e), 0);
// The ledger written whole; answers why it could not be, or null.
export function saveLedger(file: string, ledger: Spend[]): string | null {
  try {
    writeAtomically(file, `${JSON.stringify(ledger, null, 1)}\n`);
    return null;
  } catch (error) {
    return `${file} could not be written (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); free space or fix its permissions, then run again`;
  }
}
// A call's estimate reserved before it is sent, so an interrupted run still counts it. A ledger that cannot be written
// takes nothing, and the call must not be sent: answers why, or the entry to settle.
export function reserveSpend(
  file: string,
  ledger: Spend[],
  call: Omit<Spend, "cost" | "state">,
): { entry: Spend } | { refused: string } {
  const entry: Spend = { ...call, cost: null, state: "reserved" };
  ledger.push(entry);
  const unsaved = saveLedger(file, ledger);
  if (!unsaved) return { entry };
  ledger.pop();
  return { refused: unsaved };
}
// Settled at Meta's reported cost when there is one; otherwise the reservation stands at the estimate, uncertain.
// Answers why the ledger could not be written, or null.
export function settleSpend(file: string, ledger: Spend[], entry: Spend, cost: number | null): string | null {
  entry.cost = cost;
  entry.state = cost === null ? "uncertain" : "settled";
  return saveLedger(file, ledger);
}
function writeAtomically(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// One run at a time per ledger: a lock file holding the run's process id, released when the run ends or the process
// exits. It is created whole (the id is written to a private file, then hard-linked into place, which fails if a lock
// exists), so no run ever sees an empty lock. A lock whose process is gone is cleared under a second lock, and re-read
// there first, so two runs cannot both clear it and both start. Answers the release, or why the lock was refused.
const alive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
const contents = (file: string) => {
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return null;
  }
};
// True when this process now holds `file`, false when another holds it.
function claim(file: string): boolean {
  const mine = `${file}.${process.pid}.tmp`;
  writeFileSync(mine, String(process.pid));
  try {
    linkSync(mine, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    unlinkSync(mine);
  }
}
function releaser(file: string): () => void {
  const release = () => {
    if (contents(file) !== String(process.pid)) return;
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  };
  process.once("exit", release);
  return () => {
    process.removeListener("exit", release);
    release();
  };
}
export function takeLock(file: string): (() => void) | string {
  const failed = (error: unknown) =>
    `${file} could not be created (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`;
  const busy = (pid: string | null) =>
    `another smoke run (process ${pid?.trim() || "unknown"}) is running; wait for it to finish`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    if (claim(file)) return releaser(file);
    const holder = contents(file);
    if (alive(Number(holder))) return busy(holder);
    const guard = `${file}.reclaim`;
    if (!claim(guard)) {
      const other = contents(guard);
      return alive(Number(other))
        ? "another smoke run is starting; run again in a moment"
        : `${guard} was left by process ${other?.trim()}, which is gone; delete it and run again`;
    }
    try {
      // Re-read under the guard: only a lock still held by the same gone process is cleared.
      const now = contents(file);
      if (now !== null && now !== holder) return busy(now);
      if (now !== null) unlinkSync(file);
      return claim(file) ? releaser(file) : busy(contents(file));
    } finally {
      unlinkSync(guard);
    }
  } catch (error) {
    return failed(error);
  }
}

// The gateway log's own record of the call, as Cloudflare's logs API returns it.
const GatewayLog = z.object({
  model: z.string(),
  success: z.boolean(),
  status_code: z.number(),
  duration: z.number(),
  tokens_in: z.number(),
  tokens_out: z.number(),
  cost: z.number().optional(),
});
type LogFacts = z.infer<typeof GatewayLog>;
type LogCheck = Check & { log?: LogFacts | undefined; gatewayCost?: number | null | undefined };

// Each call's gateway log, read back within a bounded wait: it must be this call's model, successful, carry Meta's
// token counts, (for token-priced models) a cost matching that usage at the gateway's prices, and no stored body. A
// body counts as absent only on Cloudflare's own answer for that, 404 with code 7002; any other answer is unverified.
export async function checkLog(
  get: (path: string) => Promise<{ status: number; body: unknown }>,
  logId: string,
  call: Planned,
  usage: Usage | null,
  waitMs = 30_000,
  pause = (ms: number) => new Promise((r) => setTimeout(r, ms)),
): Promise<LogCheck> {
  try {
    let raw: unknown;
    const start = Date.now();
    for (; Date.now() - start < waitMs; await pause(Math.min(2_000, Math.max(0, waitMs - (Date.now() - start))))) {
      const answer = await get(`/${logId}`);
      const result = (answer.body as { result?: unknown })?.result;
      if (answer.status === 200 && result && typeof result === "object") {
        raw = result;
        break;
      }
    }
    if (!raw) return { ok: false, detail: `the gateway log ${logId} did not appear within ${waitMs / 1000} s` };
    const parsed = GatewayLog.safeParse(raw);
    if (!parsed.success)
      return { ok: false, detail: `the gateway log is malformed (${parsed.error.issues[0]?.path.join(".")})` };
    const log = parsed.data;
    if (log.model !== call.model)
      return { ok: false, detail: `the gateway logged ${log.model}, not ${call.model}`, log };
    if (!log.success || log.status_code !== 200)
      return { ok: false, detail: `the gateway logged a failure (HTTP ${log.status_code})`, log };
    for (const part of ["request", "response"]) {
      const stored = await get(`/${logId}/${part}`);
      const codes = ((stored.body as { errors?: unknown })?.errors as { code?: unknown }[] | undefined) ?? [];
      const absent = stored.status === 404 && Array.isArray(codes) && codes.some((e) => e?.code === 7002);
      if (!absent)
        return {
          ok: false,
          detail:
            stored.status === 200
              ? `the gateway stored the ${part} body, which it must not`
              : `the ${part} body's absence could not be verified (HTTP ${stored.status})`,
          log,
        };
    }
    if (!usage) return { ok: false, detail: "Meta reported no usage to compare with the gateway's", log };
    if (log.tokens_in !== usage.input || log.tokens_out !== usage.output)
      return {
        ok: false,
        detail: `the gateway counted ${log.tokens_in} in and ${log.tokens_out} out; Meta reported ${usage.input} and ${usage.output}`,
        log,
      };
    // SAM is priced per image, so the gateway holds no cost to compare.
    if (call.model === "sam-3.1")
      return { ok: true, detail: "metadata and Meta's counts kept, no body", log, gatewayCost: null };
    const gatewayCost = log.cost ?? null;
    if (gatewayCost === null) return { ok: false, detail: "a token-priced call has no gateway cost", log, gatewayCost };
    const expected = tokenCost(call.model as keyof typeof PRICES, usage.input, usage.output, usage.cached);
    return Math.abs(gatewayCost - expected) <= Math.max(1e-6, expected * 0.02)
      ? { ok: true, detail: "metadata and a matching cost kept, no body", log, gatewayCost }
      : {
          ok: false,
          detail: `the gateway cost ${gatewayCost} does not match Meta's usage at the gateway's prices (${expected.toFixed(8)})`,
          log,
          gatewayCost,
        };
  } catch (error) {
    return { ok: false, detail: `the gateway log could not be read (${(error as Error).name}); try again later` };
  }
}

export type Secrets = { meta: string; run: string; admin: string };
export type RunOptions = {
  dry: boolean;
  confirmCredit: boolean;
  model?: string;
  fixtures?: Fixtures;
  fixturesDir?: string;
  readSecrets?: () => Promise<Secrets>;
  fetch?: typeof fetch;
  ledger?: string;
  // A checkout's ledger from before the shared one, moved into it (LEGACY_LEDGER unless `ledger` is given).
  legacyLedger?: string;
  report?: string;
  now?: () => Date;
  log?: (line: string) => void;
  timeoutMs?: number;
  logWaitMs?: number;
  runCap?: number;
  dayCap?: number;
  // The shared Meta budget in the live D1 (D03 T01 §2): every call is reserved there before it is sent. The command line
  // gives `localBudget`; a paid run without one is refused.
  budget?: Budget;
};
export type RunOutcome = { code: 0 | 1 | 2; lines: string[] };

export async function runMetaSmoke(options: RunOptions): Promise<RunOutcome> {
  const lines: string[] = [];
  const say = (line: string) => {
    lines.push(line);
    options.log?.(line);
  };
  const refuse = (why: string): RunOutcome => {
    say(`meta-smoke: refused: ${why}`);
    return { code: 2, lines };
  };
  let fx: Fixtures;
  try {
    fx = options.fixtures ?? loadFixtures(options.fixturesDir);
  } catch (error) {
    return refuse(
      `the fixtures in test/fixtures/meta-smoke could not be read (${(error as Error).message}); restore them from git, or regenerate them with python3 test/fixtures/meta-smoke/make-fixtures.py`,
    );
  }
  let calls = plannedCalls(fx);
  const partial = options.model !== undefined;
  if (options.model !== undefined) {
    const refused = refuseContributor(options.model);
    if (refused) return refuse(refused);
    if (!(MODELS as readonly string[]).includes(options.model))
      return refuse(`${options.model} is not one of the models this test calls: ${MODELS.join(", ")}`);
    calls = calls.filter((c) => c.model === options.model);
  }
  const preview = (body: Record<string, unknown>) =>
    JSON.stringify(body, (_k, v) =>
      typeof v === "string" && v.startsWith("data:image/") ? `<image, ${v.length} chars>` : v,
    );
  const headers = (token: string) => ({
    "cf-aig-authorization": `Bearer ${token}`,
    "cf-aig-collect-log": "true",
    "cf-aig-collect-log-payload": "false",
  });
  if (options.dry) {
    for (const call of calls) {
      say(`${call.name} -> POST ${GATEWAY_URL}/responses`);
      say(`  headers: ${JSON.stringify({ authorization: "Bearer <redacted>", ...headers("<redacted>") })}`);
      say(`  body: ${preview(call.body)}`);
      say(`  worst case: US$${call.estimate.toFixed(4)}`);
    }
    return { code: 0, lines };
  }
  if (!options.dry && options.confirmCredit && !options.budget)
    return refuse("no Meta budget was given; every call is reserved against the shared caps (D03 T01 §2)");
  if (!options.confirmCredit)
    return refuse("a live run spends Meta credit; pass --confirm-credit once the credit shows (D99 T01 §1)");

  // The spend gate, before any secret is read or call is sent, under the ledger's lock: two runs at once cannot both
  // pass it, or overwrite each other's entries.
  const ledgerFile = options.ledger ?? metaLedger();
  // A test naming its own ledger moves nothing unless it names the old one too.
  const legacy = options.ledger ? options.legacyLedger : (options.legacyLedger ?? LEGACY_LEDGER);
  // The shared ledger's folder, made on first use; one that cannot be made is refused by the lock just below, which
  // names the cause.
  try {
    mkdirSync(dirname(ledgerFile), { recursive: true });
  } catch {
    // refused by takeLock
  }
  const unlock = takeLock(`${ledgerFile}.lock`);
  if (typeof unlock === "string") return refuse(unlock);
  try {
    const unmoved = adoptLegacyLedger(ledgerFile, legacy);
    if (unmoved) return refuse(unmoved);
    return await spend({ options, fx, calls, partial, headers, ledgerFile, say, refuse, lines });
  } finally {
    unlock();
  }
}

type Admitted = {
  options: RunOptions;
  fx: Fixtures;
  calls: Planned[];
  partial: boolean;
  headers: (token: string) => Record<string, string>;
  ledgerFile: string;
  say: (line: string) => void;
  refuse: (why: string) => RunOutcome;
  lines: string[];
};

// The run once its ledger is locked.
async function spend(admitted: Admitted): Promise<RunOutcome> {
  const { options, fx, calls, partial, headers, ledgerFile, say, refuse, lines } = admitted;
  const now = options.now ?? (() => new Date());
  // The budget's day, SAST (src/meta/day.ts), as the shared caps count it.
  const today = sastDay(now());
  const runId = now().toISOString();
  const estimate = calls.reduce((sum, c) => sum + c.estimate, 0);
  let ledger: Spend[];
  try {
    ledger = readLedger(ledgerFile);
  } catch (error) {
    return refuse(
      `${ledgerFile} is unreadable (${(error as Error).message}); it records Meta spend, so repair it (a list of { date, run, call, estimate, cost, state }) rather than delete it`,
    );
  }
  const spentToday = spentOn(ledger, today);
  const runCap = options.runCap ?? RUN_CAP;
  const dayCap = options.dayCap ?? DAY_CAP;
  if (estimate > runCap) return refuse(`the run could cost US$${estimate.toFixed(4)}, over the US$${runCap} cap`);
  if (spentToday + estimate > dayCap)
    return refuse(
      `US$${spentToday.toFixed(4)} spent on smoke runs today; this run's US$${estimate.toFixed(4)} would pass the US$${dayCap} a day`,
    );

  let secrets: Secrets;
  try {
    secrets = await (options.readSecrets ?? readSecretsFromVault)();
  } catch (error) {
    return refuse((error as Error).message);
  }
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const client = new OpenAI({
    apiKey: secrets.meta,
    baseURL: GATEWAY_URL,
    // The owner's gateway metadata, as every caller sends it (D03 T01 §3), so the gateway's log filters by this script.
    defaultHeaders: { ...headers(secrets.run), ...(await metadataHeader(SMOKE_OWNER)) },
    fetch: fetchImpl,
    maxRetries: 0,
    timeout: timeoutMs,
  });
  const safe = (text: string) => Object.values(secrets).reduce((t, s) => (s ? t.split(s).join("[secret]") : t), text);
  const getLog = async (path: string) => {
    const response = await fetchImpl(`${LOGS_URL}${path}`, {
      headers: { authorization: `Bearer ${secrets.admin}`, "user-agent": "isitlegit-meta-smoke/1.0" },
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

  type Row = {
    call: Planned;
    passed: boolean;
    detail: string;
    excerpt?: string | undefined;
    ms: number;
    usage: Usage | null;
    log: LogCheck;
    cost: number | null;
  };
  const rows: Row[] = [];
  const reportFile = options.report ?? join(ROOT, "docs/meta-smoke-test.md");
  const writeReport = (state: "in progress" | "passed" | "failed") => {
    const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");
    const money = (n: number | null | undefined) => (typeof n === "number" ? `US$${n.toFixed(6)}` : "?");
    const table = rows.map((r) => {
      const g = r.log.log;
      const gatewayCost =
        r.call.model === "sam-3.1"
          ? `unavailable from the gateway; US$${SAM_PER_IMAGE.toFixed(4)} per image`
          : money(r.log.gatewayCost);
      const usage = r.usage
        ? `${r.usage.input}${r.usage.cached ? ` (${r.usage.cached} cached)` : ""} / ${r.usage.output}`
        : "not reported by Meta";
      const gatewayFacts = g
        ? `${g.status_code}, ${g.success ? "success" : "failure"}, ${g.tokens_in} / ${g.tokens_out}, ${g.duration} ms`
        : "not read";
      return `| ${r.call.name} | \`${r.call.model}\` | ${r.passed ? "passed" : "failed"} | ${r.ms} | ${usage} | ${gatewayFacts} | ${money(r.cost)} | ${gatewayCost} | ${cell(r.excerpt ?? "")} | ${cell(r.detail)}; ${cell(r.log.detail)} |`;
    });
    const spent = rows.reduce((sum, r) => sum + (r.cost ?? r.call.estimate), 0);
    const coverage = partial ? ` Partial coverage: only \`${options.model}\`.` : "";
    const result =
      state === "in progress"
        ? `**in progress** (${rows.length} of ${calls.length} calls done; if this stays, the run was interrupted)`
        : state === "passed"
          ? "**every check passed**"
          : "**failed**";
    writeAtomically(
      reportFile,
      [
        "# Meta smoke test",
        "",
        `Run ${runId} by \`node scripts/meta-smoke.ts --confirm-credit\` (D00 T01 §7), through AI Gateway \`isitlegit\` with \`store: false\` and payload logging off. Result: ${result}.${coverage} Spend so far US$${spent.toFixed(6)} (estimate US$${estimate.toFixed(4)}). No keys and no bodies are recorded here; excerpts are of answers about synthetic fixtures.`,
        "",
        "| Call | Model | Result | Wall ms | Meta tokens in / out | Gateway log: status, outcome, tokens in / out, duration | Cost (Meta usage) | Gateway cost | Excerpt | Detail |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ...table,
        "",
      ].join("\n"),
    );
  };
  try {
    if (existsSync(reportFile) && readFileSync(reportFile, "utf-8").includes("**in progress**"))
      say("note: the previous run did not finish (its report still says in progress); its reserved spend is counted");
    writeReport("in progress");
  } catch (error) {
    return refuse(`${reportFile} could not be written (${(error as Error).message})`);
  }

  const budget = options.budget as Budget;
  for (const call of calls) {
    // The shared caps first (the one authority, the live D1), then this checkout's own ledger record.
    let held: string;
    try {
      // Named for its ledger entry, so an import of the ledger finds it already counted.
      // Named for its ledger entry, and carrying the call record every caller writes (D03 T01 §3).
      held = await budget.reserve(call.model as ModelId, call.estimate, 1, ledgerId(today, runId, call.name), {
        callId: crypto.randomUUID(),
        owner: SMOKE_OWNER,
      });
    } catch (error) {
      say(
        `meta-smoke: stopped before ${call.name}: ${error instanceof BudgetExceeded ? `the ${error.cap} cap refused it` : "the shared budget could not be reached"}`,
      );
      return { code: 1, lines };
    }
    const reserved = reserveSpend(ledgerFile, ledger, {
      date: today,
      run: runId,
      call: call.name,
      estimate: call.estimate,
    });
    if ("refused" in reserved) {
      // Never sent: the shared reservation is released, so a failed local record cannot use up the allowance.
      await budget
        .settle(held, 0, { ms: 0, outcome: "refused", errorClass: "NotSent", certainty: "none", source: "estimate" })
        .catch(() => {});
      say(`meta-smoke: stopped before ${call.name}: ${reserved.refused}`);
      return { code: 1, lines };
    }
    const { entry } = reserved;
    say(`Calling ${call.name} (${call.model})...`);
    const started = Date.now();
    let check: Check;
    let logId: string | null = null;
    let requestId: string | null = null;
    let failure: Described | null = null;
    let usage: Row["usage"] = null;
    // One deadline from request to the end of the stream.
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      const { data, response } = await client.responses.create(call.body as never, { signal: deadline }).withResponse();
      logId = response.headers.get("cf-aig-log-id");
      requestId = traced(response.headers).requestId;
      const usageOf = (answer: unknown): Usage | null => {
        const counts = (
          answer as {
            usage?: {
              input_tokens?: unknown;
              output_tokens?: unknown;
              input_tokens_details?: { cached_tokens?: unknown };
            };
          } | null
        )?.usage;
        const input = counts?.input_tokens;
        const output = counts?.output_tokens;
        const cached = counts?.input_tokens_details?.cached_tokens ?? 0;
        return typeof input === "number" && typeof output === "number" && typeof cached === "number"
          ? { input, cached, output }
          : null;
      };
      if (call.stream) {
        // The stream's own `response.completed` event carries Meta's usage; it is read as the events pass.
        const events = data as unknown as AsyncIterable<{ type: string; response?: unknown }>;
        const watched = async function* () {
          for await (const event of events) {
            if (event.type === "response.completed") usage = usageOf(event.response);
            yield event;
          }
        };
        check = await judgeSegmentation(watched(), fx);
      } else {
        usage = usageOf(data);
        check = judge(call.name, fx, data);
      }
    } catch (error) {
      const e = error as { status?: number; name?: string; message?: string };
      // Its kind and ids as the client reads them, for the attempt's record.
      failure = describeError(error);
      logId ??= failure.logId;
      requestId ??= failure.requestId;
      check = {
        ok: false,
        detail: safe(
          e.status
            ? `Meta or the gateway answered HTTP ${e.status}`
            : deadline.aborted
              ? `no complete answer within ${timeoutMs / 1000} s`
              : `${e.name ?? "Error"}: ${e.message ?? "no answer"}`,
        ),
      };
    }
    // The SDK ends an aborted stream as if it had finished, so the deadline is named here, where it is known.
    if (deadline.aborted && !check.ok)
      check = { ok: false, detail: `no complete answer within ${timeoutMs / 1000} s`, interrupted: "timeout" };
    // An answer that never arrived whole is a failed call, whatever the transport said.
    if (!failure && check.interrupted) failure = { errorClass: check.interrupted, logId, requestId };
    const ms = Date.now() - started;
    const logCheck: LogCheck = logId
      ? await checkLog(getLog, logId, call, usage, options.logWaitMs ?? 30_000)
      : { ok: false, detail: "no cf-aig-log-id came back, so the gateway did not log the call" };
    // Refused by Meta or the gateway (a 4xx other than a timeout): nothing was charged (D03 T01 §2's rule, as the client
    // applies it). Otherwise settled at Meta's reported cost when there is one; else the reservation stands at the estimate.
    const refused =
      failure?.status !== undefined && failure.status >= 400 && failure.status < 500 && failure.status !== 408;
    const cost = refused
      ? 0
      : call.model === "sam-3.1"
        ? logCheck.log?.success
          ? SAM_PER_IMAGE
          : null
        : usage
          ? tokenCost(call.model as keyof typeof PRICES, usage.input, usage.output, usage.cached)
          : null;
    const passed = check.ok && logCheck.ok;
    rows.push({ call, passed, detail: check.detail, excerpt: check.excerpt, ms, usage, log: logCheck, cost });
    say(`${passed ? "passed" : "failed"}: ${call.name} (${check.detail}; log: ${logCheck.detail})`);
    // The attempt's record, of the model call (the smoke's own verdict is in its report): a refusal costs nothing; SAM's
    // per-image cost is the price of the image sent, labelled estimated; a token model's is Meta's reported usage.
    const measured = cost !== null && !refused && call.model !== "sam-3.1";
    const record = {
      ms,
      inputTokens: usage?.input,
      cachedTokens: usage?.cached,
      outputTokens: usage?.output,
      ...(call.model === "sam-3.1" ? { images: 1 } : {}),
      logId,
      requestId,
      outcome: refused ? ("refused" as const) : failure ? ("error" as const) : ("ok" as const),
      ...(failure ? { errorClass: failure.errorClass } : {}),
      certainty: refused ? ("none" as const) : measured ? ("measured" as const) : ("estimated" as const),
      source: measured ? ("meta-usage" as const) : ("estimate" as const),
    };
    await (cost === null ? budget.uncertain(held, record) : budget.settle(held, cost, record)).catch(() =>
      say(`meta-smoke: the shared budget's record of ${call.name} could not be updated; it stands at its estimate`),
    );
    const unsettled = settleSpend(ledgerFile, ledger, entry, cost);
    if (unsettled) say(`meta-smoke: ${unsettled}; the reservation for ${call.name} stands at its estimate`);
    try {
      writeReport("in progress");
    } catch (error) {
      say(`meta-smoke: the report could not be updated (${(error as Error).message})`);
    }
  }

  const passed = rows.length === calls.length && calls.length > 0 && rows.every((r) => r.passed);
  // The report is the run's evidence: a run whose report cannot be saved has not passed.
  let saved = true;
  try {
    writeReport(passed ? "passed" : "failed");
  } catch (error) {
    saved = false;
    say(`meta-smoke: the report could not be written (${(error as Error).message}); free space or fix its permissions`);
  }
  const ok = passed && saved;
  const spent = rows.reduce((sum, r) => sum + (r.cost ?? r.call.estimate), 0);
  say(
    `${ok ? "passed" : "failed"}: ${rows.filter((r) => r.passed).length} of ${calls.length} calls${partial ? ` (partial: ${options.model})` : ""}; US$${spent.toFixed(6)} counted`,
  );
  return { code: ok ? 0 : 1, lines };
}

export async function readSecretsFromVault(): Promise<Secrets> {
  const read = async (title: string) => {
    try {
      return (
        await runCommand("conclave-op", ["read", `op://Conclave/${title}/credential`], "", Date.now() + 60_000)
      ).trim();
    } catch {
      throw new Error(
        `reading "${title}" from Conclave failed; check the item exists and that conclave-op can reach 1Password`,
      );
    }
  };
  return { meta: await read(VAULT.meta), run: await read(VAULT.run), admin: await read(VAULT.admin) };
}

export function parseMetaArgs(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dry: { type: "boolean", default: false },
      "confirm-credit": { type: "boolean", default: false },
      model: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    help: values.help,
    dry: values.dry,
    confirmCredit: values["confirm-credit"],
    ...(values.model !== undefined ? { model: values.model } : {}),
  };
}

if (import.meta.filename === process.argv[1]) {
  let args: ReturnType<typeof parseMetaArgs>;
  try {
    args = parseMetaArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`meta-smoke: ${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  installSignalCleanup("meta-smoke");
  const { help: _help, ...run } = args;
  const outcome = await runMetaSmoke({ ...run, budget: localBudget("meta-smoke"), log: (line) => console.log(line) });
  process.exit(outcome.code);
}
