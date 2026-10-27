// The Meta smoke test (D00 T01 §7): one call per capability the product relies on, through AI Gateway `isitlegit`,
// each judged by what it returns, and each call's gateway log read back to prove the gateway kept metadata and cost
// but no body. A run passes only when every check passes; anything else exits non-zero.
//
//   Spark text      muse-spark-1.3 answers a fixed sum.
//   Spark image     muse-spark-1.3 reads a random code printed only on test/fixtures/meta-smoke/code-card.png.
//   SAM 3.1         sam-3.1, streamed to `response.completed` and parsed with @meta-sam/parser, finds the logo on
//                   logo-card.png (a box overlapping its known area).
//   Wonder          muse-wonder-1.0, given a `click(x, y)` function, clicks Continue on continue-page.png (a screenshot;
//                   no browser is driven and no URL is opened). Meta's native computer tool is refused for our key, so
//                   function tools are the design (operator, 2026-10-27; D04 T02).
//
// Every request carries `store: false`, an output ceiling, the gateway's Run token and `cf-aig-collect-log: true` with
// `cf-aig-collect-log-payload: false`; no `-contributor` model is ever sent (Meta's terms, spec 4.8). Before any call
// the run's worst-case cost is estimated and refused above US$0.50, or above US$2 of smoke spend that day
// (build/meta-smoke-spend.json), inside spec 11's caps. Secrets come from Conclave through conclave-op and are never
// printed. `--dry` prints the four requests and sends nothing; a live run needs `--confirm-credit` and writes
// docs/meta-smoke-test.md.
//
//   node scripts/meta-smoke.ts --dry
//   node scripts/meta-smoke.ts --confirm-credit
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { parseImageStream, recordsOfKind } from "@meta-sam/parser";
import OpenAI from "openai";
import { z } from "zod";
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
// US dollars per million tokens, as AI Gateway's pricing rules hold them (D00 T01 §6); SAM is priced per image.
export const PRICES = {
  "muse-spark-1.3": { input: 1.25, output: 4.25 },
  "muse-wonder-1.0": { input: 4, output: 20 },
} as const;
export const SAM_PER_IMAGE = 2.5 / 1000;
export const RUN_CAP = 0.5;
export const DAY_CAP = 2;
// A generous worst case for an image's input tokens, so the estimate never undercounts.
const IMAGE_TOKENS = 4000;

export type Fixtures = {
  code: string;
  logoBox: [number, number, number, number];
  buttonBox: [number, number, number, number];
  images: { code: string; logo: string; page: string }; // data URLs
};

export function loadFixtures(dir = join(ROOT, "test/fixtures/meta-smoke")): Fixtures {
  const facts = JSON.parse(readFileSync(join(dir, "fixtures.json"), "utf-8"));
  const png = (name: string) => `data:image/png;base64,${readFileSync(join(dir, name)).toString("base64")}`;
  return {
    code: facts.code,
    logoBox: facts.logoBox,
    buttonBox: facts.buttonBox,
    images: { code: png("code-card.png"), logo: png("logo-card.png"), page: png("continue-page.png") },
  };
}

type Check = { ok: boolean; detail: string; excerpt?: string | undefined };
export type Planned = {
  name: string;
  model: keyof typeof PRICES | "sam-3.1";
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
const tokenCost = (model: keyof typeof PRICES, input: number, output: number) =>
  (input * PRICES[model].input + output * PRICES[model].output) / 1_000_000;

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
        tools: [CLICK_TOOL],
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

const CLICK_TOOL = {
  type: "function",
  name: "click",
  description: "Click the left mouse button at a point on the screenshot, in pixels from its top-left corner.",
  parameters: {
    type: "object",
    properties: { x: { type: "integer" }, y: { type: "integer" } },
    required: ["x", "y"],
    additionalProperties: false,
  },
};
const ClickArguments = z.object({ x: z.number(), y: z.number() }).strict();

// What each call's answer must show, given the fixtures' known facts.
export function judge(name: string, fx: Fixtures, answer: unknown): Check {
  const text = (answer as { output_text?: unknown })?.output_text;
  const excerpt = typeof text === "string" ? text.slice(0, 80) : undefined;
  if (name === "Spark text")
    return /\b51\b/.test(String(text ?? ""))
      ? { ok: true, detail: "answered 51", excerpt }
      : { ok: false, detail: `expected 51, got ${JSON.stringify(excerpt ?? null)}`, excerpt };
  if (name === "Spark image") {
    const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
    return squash(String(text ?? "")).includes(squash(fx.code))
      ? { ok: true, detail: "read the code printed only on the fixture", excerpt }
      : { ok: false, detail: `did not read the fixture's code, got ${JSON.stringify(excerpt ?? null)}`, excerpt };
  }
  if (name === "Wonder") {
    const items = (answer as { output?: unknown[] })?.output ?? [];
    const call = items.find((i) => (i as { type?: unknown })?.type === "function_call") as
      | { name?: unknown; arguments?: unknown }
      | undefined;
    if (!call) return { ok: false, detail: `no function call; returned ${JSON.stringify(excerpt ?? null)}` };
    if (call.name !== "click") return { ok: false, detail: `called ${String(call.name)}, not click` };
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
      ? { ok: true, detail: `clicked Continue at (${x}, ${y})` }
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
      return { ok: false, detail: `the stream ended ${outcome.status} (${outcome.reason}), not completed` };
    const boxes = recordsOfKind(result.records, "box");
    if (boxes.length === 0) return { ok: false, detail: "no logo found (a valid, empty answer)" };
    const best = Math.max(...boxes.map((x) => overlap([x.left, x.top, x.right, x.bottom], fx.logoBox)));
    return best >= 0.3
      ? { ok: true, detail: `${boxes.length} box(es); best overlap with the logo ${best.toFixed(2)}` }
      : { ok: false, detail: `${boxes.length} box(es), none over the logo (best overlap ${best.toFixed(2)})` };
  } catch (error) {
    return { ok: false, detail: `the segmentation stream could not be read: ${(error as Error).name}` };
  }
}

// The spend ledger, one entry per run; refused when it is not a list of entries.
type Spend = { date: string; estimate: number; cost: number | null };
export function readLedger(file: string): Spend[] {
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, "utf-8"));
  if (!Array.isArray(data)) throw new Error(`${file} is not a spend ledger`);
  return data;
}
function writeAtomically(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// Each call's gateway log, read back within a bounded wait: metadata and (for token-priced models) a cost matching
// Meta's usage at the gateway's prices, and no stored body.
type LogFacts = Record<string, unknown>;
type LogCheck = Check & { log?: LogFacts; gatewayCost?: number | null | undefined; gatewayMs?: number | undefined };
export async function checkLog(
  get: (path: string) => Promise<{ status: number; body: unknown }>,
  logId: string,
  call: Planned,
  usage: { input: number; output: number } | null,
  waitMs = 30_000,
  pause = (ms: number) => new Promise((r) => setTimeout(r, ms)),
): Promise<LogCheck> {
  let log: LogFacts | undefined;
  const start = Date.now();
  for (; Date.now() - start < waitMs; await pause(Math.min(2_000, Math.max(0, waitMs - (Date.now() - start))))) {
    const answer = await get(`/${logId}`);
    const result = (answer.body as { result?: unknown })?.result;
    if (answer.status === 200 && result && typeof result === "object") {
      log = result as LogFacts;
      break;
    }
  }
  if (!log) return { ok: false, detail: `the gateway log ${logId} did not appear within ${waitMs / 1000} s` };
  for (const field of ["model", "duration", "tokens_in", "tokens_out"])
    if (log[field] === undefined || log[field] === null)
      return { ok: false, detail: `the gateway log has no ${field}`, log };
  for (const part of ["request", "response"]) {
    const stored = await get(`/${logId}/${part}`);
    const body = (stored.body as { result?: unknown })?.result ?? null;
    const empty = body === null || body === "" || (typeof body === "object" && Object.keys(body).length === 0);
    if (stored.status === 200 && !empty)
      return { ok: false, detail: `the gateway stored the ${part} body, which it must not`, log };
  }
  const gatewayCost = typeof log.cost === "number" ? log.cost : null;
  const gatewayMs = typeof log.duration === "number" ? log.duration : undefined;
  if (call.model === "sam-3.1")
    return { ok: true, detail: "metadata kept, no body", log, gatewayCost: null, gatewayMs };
  if (gatewayCost === null || !usage)
    return { ok: false, detail: "a token-priced call has no gateway cost", log, gatewayCost, gatewayMs };
  const expected = tokenCost(call.model as keyof typeof PRICES, usage.input, usage.output);
  return Math.abs(gatewayCost - expected) <= Math.max(1e-6, expected * 0.02)
    ? { ok: true, detail: "metadata and a matching cost kept, no body", log, gatewayCost, gatewayMs }
    : {
        ok: false,
        detail: `the gateway cost ${gatewayCost} does not match Meta's usage at the gateway's prices (${expected.toFixed(8)})`,
        log,
        gatewayCost,
        gatewayMs,
      };
}

export type Secrets = { meta: string; run: string; admin: string };
export type RunOptions = {
  dry: boolean;
  confirmCredit: boolean;
  model?: string;
  fixtures?: Fixtures;
  readSecrets?: () => Promise<Secrets>;
  fetch?: typeof fetch;
  ledger?: string;
  report?: string;
  now?: () => Date;
  log?: (line: string) => void;
  timeoutMs?: number;
  logWaitMs?: number;
  runCap?: number;
  dayCap?: number;
};
export type RunOutcome = { code: 0 | 1 | 2; lines: string[] };

export async function runMetaSmoke(options: RunOptions): Promise<RunOutcome> {
  const lines: string[] = [];
  const say = (line: string) => {
    lines.push(line);
    options.log?.(line);
  };
  const fx = options.fixtures ?? loadFixtures();
  let calls = plannedCalls(fx);
  if (options.model) {
    const refused = refuseContributor(options.model);
    if (refused) {
      say(`meta-smoke: refused: ${refused}`);
      return { code: 2, lines };
    }
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
      const shown = headers("<redacted>");
      say(`${call.name} -> POST ${GATEWAY_URL}/responses`);
      say(`  headers: ${JSON.stringify({ authorization: "Bearer <redacted>", ...shown })}`);
      say(`  body: ${preview(call.body)}`);
      say(`  worst case: US$${call.estimate.toFixed(4)}`);
    }
    return { code: 0, lines };
  }
  if (!options.confirmCredit) {
    say("meta-smoke: refused: a live run spends Meta credit; pass --confirm-credit once the credit shows (D99 T01 §1)");
    return { code: 2, lines };
  }
  // The spend gate, before any secret is read or call is sent.
  const ledgerFile = options.ledger ?? join(ROOT, "build/meta-smoke-spend.json");
  const today = (options.now?.() ?? new Date()).toISOString().slice(0, 10);
  const estimate = calls.reduce((sum, c) => sum + c.estimate, 0);
  let ledger: Spend[];
  try {
    ledger = readLedger(ledgerFile);
  } catch (error) {
    say(`meta-smoke: refused: ${(error as Error).message}; fix or delete it`);
    return { code: 2, lines };
  }
  const spentToday = ledger.filter((e) => e.date === today).reduce((sum, e) => sum + (e.cost ?? e.estimate), 0);
  const runCap = options.runCap ?? RUN_CAP;
  const dayCap = options.dayCap ?? DAY_CAP;
  if (estimate > runCap) {
    say(`meta-smoke: refused: the run could cost US$${estimate.toFixed(4)}, over the US$${runCap} cap`);
    return { code: 2, lines };
  }
  if (spentToday + estimate > dayCap) {
    say(
      `meta-smoke: refused: US$${spentToday.toFixed(4)} spent on smoke runs today; this run's US$${estimate.toFixed(4)} would pass the US$${dayCap} a day`,
    );
    return { code: 2, lines };
  }

  const secrets = await (options.readSecrets ?? readSecretsFromVault)();
  const fetchImpl = options.fetch ?? fetch;
  const client = new OpenAI({
    apiKey: secrets.meta,
    baseURL: GATEWAY_URL,
    defaultHeaders: headers(secrets.run),
    fetch: fetchImpl,
    maxRetries: 0,
    timeout: options.timeoutMs ?? 120_000,
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
    usage: { input: number; output: number } | null;
    log?: LogCheck;
    cost: number | null;
  };
  const rows: Row[] = [];
  for (const call of calls) {
    say(`Calling ${call.name} (${call.model})...`);
    const started = Date.now();
    let check: Check;
    let logId: string | null = null;
    let usage: Row["usage"] = null;
    try {
      if (call.stream) {
        const { data, response } = await client.responses.create(call.body as never).withResponse();
        logId = response.headers.get("cf-aig-log-id");
        check = await judgeSegmentation(data as unknown as AsyncIterable<{ type: string }>, fx);
      } else {
        const { data, response } = await client.responses.create(call.body as never).withResponse();
        logId = response.headers.get("cf-aig-log-id");
        const answer = data as { status?: string; usage?: { input_tokens?: number; output_tokens?: number } };
        usage = answer.usage
          ? { input: answer.usage.input_tokens ?? 0, output: answer.usage.output_tokens ?? 0 }
          : null;
        check =
          answer.status && answer.status !== "completed"
            ? { ok: false, detail: `the response ended ${answer.status}, not completed` }
            : judge(call.name, fx, data);
      }
    } catch (error) {
      const e = error as { status?: number; name?: string; message?: string };
      check = {
        ok: false,
        detail: safe(
          e.status
            ? `Meta or the gateway answered HTTP ${e.status}`
            : `${e.name ?? "Error"}: ${e.message ?? "no answer"}`,
        ),
      };
    }
    const ms = Date.now() - started;
    const logCheck = logId
      ? await checkLog(getLog, logId, call, usage, options.logWaitMs ?? 30_000)
      : { ok: false, detail: "no cf-aig-log-id came back, so the gateway did not log the call" };
    const cost =
      call.model === "sam-3.1"
        ? SAM_PER_IMAGE
        : usage
          ? tokenCost(call.model as keyof typeof PRICES, usage.input, usage.output)
          : null;
    const passed = check.ok && logCheck.ok;
    rows.push({ call, passed, detail: check.detail, excerpt: check.excerpt, ms, usage, log: logCheck, cost });
    say(`${passed ? "passed" : "failed"}: ${call.name} (${check.detail}; log: ${logCheck.detail})`);
  }

  const spent = rows.reduce((sum, r) => sum + (r.cost ?? 0), 0);
  writeAtomically(ledgerFile, `${JSON.stringify([...ledger, { date: today, estimate, cost: spent }], null, 1)}\n`);
  const reportFile = options.report ?? join(ROOT, "docs/meta-smoke-test.md");
  const ok = rows.length === calls.length && rows.every((r) => r.passed);
  const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");
  const table = rows.map((r) => {
    const gatewayCost =
      r.call.model === "sam-3.1"
        ? `unavailable from the gateway; US$${SAM_PER_IMAGE.toFixed(4)} per image`
        : r.log?.gatewayCost === undefined || r.log.gatewayCost === null
          ? "none"
          : `US$${r.log.gatewayCost.toFixed(6)}`;
    return `| ${r.call.name} | \`${r.call.model}\` | ${r.passed ? "passed" : "failed"} | ${r.ms} | ${r.log?.gatewayMs ?? "?"} | ${r.usage?.input ?? "?"} | ${r.usage?.output ?? "?"} | ${r.cost === null ? "?" : `US$${r.cost.toFixed(6)}`} | ${gatewayCost} | ${cell(r.detail)}; ${cell(r.log?.detail ?? "")} |`;
  });
  writeAtomically(
    reportFile,
    [
      "# Meta smoke test",
      "",
      `Run ${(options.now?.() ?? new Date()).toISOString()} by \`node scripts/meta-smoke.ts --confirm-credit\` (D00 T01 §7), through AI Gateway \`isitlegit\` with \`store: false\` and payload logging off. Result: **${ok ? "every check passed" : "failed"}**. Total cost US$${spent.toFixed(6)} (estimate US$${estimate.toFixed(4)}). No keys and no bodies are recorded here.`,
      "",
      "| Call | Model | Result | Wall ms | Gateway ms | Tokens in | Tokens out | Cost (Meta usage) | Gateway cost | Detail |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ...table,
      "",
    ].join("\n"),
  );
  say(
    `${ok ? "passed" : "failed"}: ${rows.filter((r) => r.passed).length} of ${calls.length} calls; US$${spent.toFixed(6)} spent`,
  );
  return { code: ok ? 0 : 1, lines };
}

async function readSecretsFromVault(): Promise<Secrets> {
  const read = async (title: string) =>
    (await runCommand("conclave-op", ["read", `op://Conclave/${title}/credential`], "", Date.now() + 60_000)).trim();
  return { meta: await read(VAULT.meta), run: await read(VAULT.run), admin: await read(VAULT.admin) };
}

export function parseMetaArgs(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dry: { type: "boolean", default: false },
      "confirm-credit": { type: "boolean", default: false },
      model: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  return { dry: values.dry, confirmCredit: values["confirm-credit"], ...(values.model ? { model: values.model } : {}) };
}

if (import.meta.filename === process.argv[1]) {
  let args: ReturnType<typeof parseMetaArgs>;
  try {
    args = parseMetaArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`meta-smoke: ${(error as Error).message}`);
    process.exit(2);
  }
  installSignalCleanup("meta-smoke");
  const outcome = await runMetaSmoke({ ...args, log: (line) => console.log(line) });
  process.exit(outcome.code);
}
