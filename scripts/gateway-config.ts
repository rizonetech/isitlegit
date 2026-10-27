// The AI Gateway configuration as a file (D00 T01 §11). The gateway's settings, the `meta` custom provider and its
// pricing rules live in the Cloudflare account, not in git, so a Worker rollback cannot bring them back; this records
// them and puts them back.
//
//   snapshot   reads gateway `isitlegit`, the `meta` provider and its pricing rules into a file (default
//              infra/ai-gateway.json), written whole or not at all, with no token or key in it. Ids, account fields
//              and timestamps change when a resource is re-created, so the file leaves them out and names the gateway
//              by its id, the provider by its slug and a pricing rule by its model.
//   restore    checks the whole file first, then creates what is missing and updates what differs. It never deletes:
//              a live pricing rule the file lacks is named and kept. `--dry` prints the changes and sends none. A
//              failure stops the run and names each change confirmed, uncertain (sent with no answer) and not tried;
//              a rerun finds what landed, so nothing is created twice. Afterwards it reads everything back and fails
//              unless the account matches the file.
//
// Fields that can hold a credential (the provider's `headers`, the gateway's `otel` and `stripe`) are never written
// to the file: snapshot and restore both refuse while one is set, naming the field and never its value. The admin
// token ("IsItLegit AI Gateway admin token", AI Gateway Read and Write; D99 T01 §8) comes from Conclave through
// conclave-op and is never printed. Requests go only to api.cloudflare.com, never follow a redirect, are bounded in
// time and read at most 1 MiB of any answer.
//
//   node scripts/gateway-config.ts --help
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { z } from "zod";
import { boundedText } from "./check-gateway-tokens.ts";
import { installSignalCleanup, runCommand } from "./smoke.ts";

const ROOT = join(import.meta.dirname, "..");
export const ACCOUNT_ID = "f5a529987f8dc7d52ce7aba3da25e226";
export const GATEWAY = "isitlegit";
export const PROVIDER = "meta";
export const API = "https://api.cloudflare.com/client/v4";
export const VAULT_ITEM = "IsItLegit AI Gateway admin token";
export const DEFAULT_FILE = "infra/ai-gateway.json";
const BODY_LIMIT = 1024 * 1024;
// A Cloudflare token: letters, digits and a few separators, nothing that could break a header or a line.
const TOKEN = /^[A-Za-z0-9._-]{20,200}$/;

export const USAGE = `node scripts/gateway-config.ts snapshot [--file <path>]
node scripts/gateway-config.ts restore [--dry] [--file <path>]

Records AI Gateway ${GATEWAY}'s settings, its ${PROVIDER} custom provider and the provider's pricing rules in a file,
and puts them back (D00 T01 §11).
  snapshot         read the account into the file (default ${DEFAULT_FILE}); the old file stays if anything fails
  restore          create what is missing and update what differs; never deletes; reads back and compares
  --dry            with restore: print the changes and send none
  --file <path>    the snapshot to write or restore, for example an earlier one from git show
  --help           this text

Needs conclave-op and the Conclave item "${VAULT_ITEM}" (AI Gateway Read to snapshot, AI Gateway Write to
restore). Exit codes: 0 done or nothing to change, 1 failed (restore names what changed), 2 refused before any change.`;

// The gateway settings its PUT accepts (Cloudflare's API spec, read 2026-10-27); the first five are required there.
const GATEWAY_REQUIRED = [
  "rate_limiting_interval",
  "rate_limiting_limit",
  "collect_logs",
  "cache_ttl",
  "cache_invalidate_on_update",
] as const;
const GATEWAY_FIELDS = [
  ...GATEWAY_REQUIRED,
  "authentication",
  "byok_only",
  "dlp",
  "guardrails",
  "log_classification",
  "log_management",
  "log_management_strategy",
  "logpush",
  "logpush_public_key",
  "otel",
  "rate_limiting_technique",
  "retry_backoff",
  "retry_delay",
  "retry_max_attempts",
  "spend_limits",
  "store_id",
  "stripe",
  "workers_ai_billing_mode",
  "zdr",
] as const;
const PROVIDER_FIELDS = [
  "name",
  "slug",
  "base_url",
  "enable",
  "beta",
  "description",
  "link",
  "position",
  "logo",
  "curl_example",
  "js_example",
] as const;
const RULE_FIELDS = ["model", "model_rule", "cost_type", "cost_in", "cost_out", "token_pricing", "enable"] as const;
// Fields that can carry a credential; set, they are refused rather than recorded.
const CREDENTIALS = { gateway: ["otel", "stripe"], provider: ["headers"] } as const;
const RECORDED_GATEWAY_FIELDS = GATEWAY_FIELDS.filter((f) => !(CREDENTIALS.gateway as readonly string[]).includes(f));

// Each field typed as Cloudflare's API spec constrains it (read 2026-10-27), so a damaged file is refused before any
// request rather than half-applied. A credential-bearing field is refused in the file as it is in the account.
const count = z.number().int().min(0).nullable();
const credential = z.never({ error: "can hold a credential, so a snapshot never carries it" }).optional();
const action = z.enum(["FLAG", "BLOCK"]);
const strings = z.array(z.string());
const Dlp = z.union([
  z.object({ action, enabled: z.boolean(), profiles: strings }).strict(),
  z
    .object({
      enabled: z.boolean(),
      policies: z.array(
        z
          .object({
            id: z.string(),
            enabled: z.boolean(),
            action,
            profiles: strings,
            check: z.array(z.enum(["REQUEST", "RESPONSE"])),
          })
          .strict(),
      ),
    })
    .strict(),
]);
const categories = z.partialRecord(z.enum(["P1", ...Array.from({ length: 13 }, (_, i) => `S${i + 1}`)]), action);
const Guardrails = z.object({ prompt: categories, response: categories }).strict();
const filter = z.object({ mode: z.literal("filter"), values: strings }).strict();
const SpendLimits = z
  .object({
    enabled: z.boolean().optional(),
    rules: z
      .array(
        z
          .object({
            enabled: z.boolean().optional(),
            id: z
              .string()
              .regex(/^[a-zA-Z0-9_-]+$/)
              .optional(),
            limit: z.number().positive(),
            limitType: z.literal("cost"),
            metadata: z
              .record(z.string(), z.union([z.object({ mode: z.literal("partition") }).strict(), filter]))
              .optional(),
            model: filter.optional(),
            provider: filter.optional(),
            technique: z.enum(["fixed", "sliding"]).optional(),
            window: z.number().int().positive(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();
const GatewaySettings = z
  .object({
    id: z.literal(GATEWAY),
    rate_limiting_interval: count,
    rate_limiting_limit: count,
    collect_logs: z.boolean(),
    cache_ttl: count,
    cache_invalidate_on_update: z.boolean(),
    authentication: z.boolean().optional(),
    byok_only: z.boolean().optional(),
    log_classification: z.boolean().optional(),
    logpush: z.boolean().optional(),
    zdr: z.boolean().optional(),
    log_management: z.number().int().min(10_000).max(10_000_000).nullable().optional(),
    log_management_strategy: z.enum(["STOP_INSERTING", "DELETE_OLDEST"]).nullable().optional(),
    logpush_public_key: z.string().min(16).max(1024).nullable().optional(),
    rate_limiting_technique: z.enum(["fixed", "sliding"]).nullable().optional(),
    retry_backoff: z.enum(["constant", "linear", "exponential"]).nullable().optional(),
    retry_delay: z.number().int().min(0).max(60_000).nullable().optional(),
    retry_max_attempts: z.number().int().min(1).max(5).nullable().optional(),
    store_id: z.string().optional(),
    workers_ai_billing_mode: z.enum(["postpaid", "unified"]).optional(),
    dlp: Dlp.optional(),
    guardrails: Guardrails.nullable().optional(),
    spend_limits: SpendLimits.nullable().optional(),
    otel: credential,
    stripe: credential,
  })
  .strict();
const text = z.string().nullable();
// A URL can carry a user name and password; such a URL is a credential, refused like the others.
const withoutUserInfo = (value: string | null) => {
  if (value === null || !URL.canParse(value)) return true;
  const url = new URL(value);
  return url.username === "" && url.password === "";
};
const noUserInfo = { error: "carries a user name or password, which can be a credential" };
const ProviderSettings = z
  .object({
    name: z.string().min(1),
    slug: z.literal(PROVIDER),
    base_url: z.url({ protocol: /^https$/, error: "must be an https URL" }).refine(withoutUserInfo, noUserInfo),
    enable: z.boolean(),
    beta: z.boolean(),
    description: text,
    link: text.refine(withoutUserInfo, noUserInfo),
    position: z.number().int(),
    logo: text,
    curl_example: text,
    js_example: text,
    headers: credential,
  })
  .strict();
const PricingRule = z
  .object({
    model: z.string().min(1),
    model_rule: z.enum(["equals", "starts-with", "contains"]),
    cost_type: z.string().min(1),
    // Read back per token; derived by Cloudflare from token_pricing, so they must agree with it.
    cost_in: z.number().min(0),
    cost_out: z.number().min(0),
    // US$ per million tokens: the only way Cloudflare takes a rule's prices (it refuses a rule without it).
    token_pricing: z
      .object({ input_tokens: z.number().min(0), output_tokens: z.number().min(0) })
      .catchall(z.number().min(0)),
    enable: z.boolean(),
  })
  .strict()
  .refine(
    (r) =>
      Math.abs(r.cost_in - r.token_pricing.input_tokens / 1e6) < 1e-12 &&
      Math.abs(r.cost_out - r.token_pricing.output_tokens / 1e6) < 1e-12,
    { message: "cost_in and cost_out must be token_pricing's input and output prices per token", path: ["cost_in"] },
  );
export const Snapshot = z
  .object({
    schema: z.literal(1),
    gateway: GatewaySettings,
    provider: ProviderSettings,
    rules: z.array(PricingRule),
  })
  .strict()
  .refine((s) => new Set(s.rules.map((r) => r.model)).size === s.rules.length, {
    message: "two pricing rules name the same model",
    path: ["rules"],
  });
export type SnapshotData = z.infer<typeof Snapshot>;

export type Options = {
  token: string;
  file: string;
  fetch?: typeof fetch;
  api?: string;
  // Tests point the requests at a stand-in; anything else must be Cloudflare's own API.
  allowEndpoint?: boolean;
  timeoutMs?: number;
  // How often a slow request says it is still waiting.
  progressMs?: number;
  log?: (line: string) => void;
  // Kept current while restore runs, so an interrupt can say what changed (see `interrupted`).
  progress?: Progress;
};
export type Progress = { confirmed: string[]; inFlight: string | null; pending: string[] };
export const newProgress = (): Progress => ({ confirmed: [], inFlight: null, pending: [] });
const RERUN =
  "  Run restore again once the cause is fixed: it finds what landed by id, slug and model, and creates nothing twice.";
// What a stopped restore leaves behind: each change confirmed, uncertain (sent with no answer) and not tried.
export function inventory(progress: Progress, uncertain: string | null): string[] {
  return [
    `  confirmed: ${progress.confirmed.join("; ") || "none"}`,
    `  uncertain: ${uncertain ?? "none"}`,
    `  not tried: ${progress.pending.join("; ") || "none"}`,
    RERUN,
  ];
}
// Said when Ctrl+C, a termination signal or a closed terminal stops a restore: a change in flight may have landed.
export function interrupted(progress: Progress): string[] {
  return ["gateway-config: interrupted", ...inventory(progress, progress.inFlight)];
}
export type Outcome = { code: 0 | 1 | 2; lines: string[] };
type Raw = Record<string, unknown>;
type Live = { gateway: Raw | null; provider: Raw | null; rules: Raw[] };

// A refusal before anything changed (exit 2); a failure after (exit 1).
class Refused extends Error {}
// A request that got no answer: it may or may not have landed.
class NoAnswer extends Error {}

function client(options: Options, say: (line: string) => void) {
  const api = options.api ?? API;
  const progressMs = options.progressMs ?? 10_000;
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const base = `${api}/accounts/${ACCOUNT_ID}/ai-gateway`;
  const safe = (message: string) => (options.token ? message.split(options.token).join("[token]") : message);
  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Raw }> {
    const started = Date.now();
    const waiting = setInterval(
      () => say(`  still waiting for ${method} ${path} (${Math.round((Date.now() - started) / 1000)} s)`),
      progressMs,
    );
    try {
      return await send(method, path, body);
    } finally {
      clearInterval(waiting);
    }
  }
  async function send(method: string, path: string, body?: unknown): Promise<{ status: number; body: Raw }> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          "user-agent": "isitlegit-gateway-config/1.0",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new NoAnswer(safe(`${method} ${path} got no answer (${(error as Error).name})`));
    }
    let text: string | null;
    try {
      text = await boundedText(response, BODY_LIMIT);
    } catch (error) {
      throw new NoAnswer(safe(`${method} ${path}: the answer was cut off (${(error as Error).name})`));
    }
    if (text === null) throw new NoAnswer(`${method} ${path}: the answer is over 1 MiB`);
    // Only a JSON object is a body; anything else (null, a list, a number, not JSON) is judged by its status alone.
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    const answer = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Raw) : {};
    return { status: response.status, body: answer };
  }
  const explain = (method: string, path: string, status: number, body: Raw) => {
    const error = Array.isArray(body.errors) ? (body.errors[0] as { code?: unknown; message?: unknown } | null) : null;
    const first =
      error !== null && typeof error === "object" ? ` (${error.code}: ${String(error.message).slice(0, 160)})` : "";
    const needs = method === "GET" ? "AI Gateway Read" : "AI Gateway Write";
    return safe(
      status === 401 || status === 403
        ? `${method} ${path} was refused (HTTP ${status}${first}); the token needs "${needs}": check "${VAULT_ITEM}" in Conclave`
        : `${method} ${path} answered HTTP ${status}${first}`,
    );
  };
  async function read(path: string): Promise<Raw | null> {
    const answer = await call("GET", path);
    if (answer.status === 404) return null;
    if (answer.status !== 200) throw new Refused(explain("GET", path, answer.status, answer.body));
    return answer.body;
  }
  async function list(path: string): Promise<Raw[]> {
    const all: Raw[] = [];
    for (let page = 1; page <= 50; page++) {
      const answer = await read(`${path}?page=${page}&per_page=50`);
      const result = answer?.result;
      if (!Array.isArray(result)) throw new Refused(`GET ${path} did not answer a list`);
      all.push(...(result as Raw[]));
      const info = answer?.result_info as { total_count?: unknown } | undefined;
      const total = typeof info?.total_count === "number" ? info.total_count : all.length;
      if (result.length === 0 || all.length >= total) return all;
    }
    throw new Refused(`GET ${path} has more than 50 pages`);
  }
  return { call, read, list, explain, safe };
}
type Client = ReturnType<typeof client>;

async function readLive(c: Client, say: (line: string) => void): Promise<Live> {
  say(`Reading gateway ${GATEWAY}, provider ${PROVIDER} and its pricing rules...`);
  const gateway = ((await c.read(`/gateways/${GATEWAY}`))?.result as Raw | undefined) ?? null;
  const providers = (await c.list("/custom-providers")).filter((p) => p.slug === PROVIDER);
  if (providers.length > 1)
    throw new Refused(`the account has ${providers.length} custom providers with slug ${PROVIDER}`);
  const provider = providers[0] ?? null;
  const rules = provider
    ? (await c.list("/custom-providers/costs")).filter((r) => r.account_provider_id === provider.id)
    : [];
  return { gateway, provider, rules };
}

// The credential-bearing fields that are set, named by resource and field, never by value.
function credentialsSet(live: Live): string[] {
  const set = (value: unknown) =>
    value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0);
  return [
    ...CREDENTIALS.gateway.filter((f) => live.gateway && set(live.gateway[f])).map((f) => `the gateway's ${f}`),
    ...CREDENTIALS.provider.filter((f) => live.provider && set(live.provider[f])).map((f) => `the provider's ${f}`),
    // A URL with a user name or password is a credential too, checked before any value is shown.
    ...(["base_url", "link"] as const)
      .filter((f) => live.provider && typeof live.provider[f] === "string" && !withoutUserInfo(live.provider[f]))
      .map((f) => `the provider's ${f} (a user name or password in the URL)`),
  ];
}
const credentialRefusal = (fields: string[]) =>
  `${fields.join(" and ")} ${fields.length > 1 ? "are" : "is"} set, and can hold a credential that must not enter git; clear it in the dashboard (AI, AI Gateway) or keep the credential in Cloudflare's Secrets Store, then run again`;

const pick = (from: Raw, fields: readonly string[]) =>
  Object.fromEntries(fields.filter((f) => from[f] !== undefined).map((f) => [f, from[f]]));
const pricing = (value: unknown) => (typeof value === "string" ? (JSON.parse(value) as unknown) : (value ?? null));
const ruleOf = (raw: Raw): Raw => ({ ...pick(raw, RULE_FIELDS), token_pricing: pricing(raw.token_pricing) });

// The file's view of the account: what a restore would write.
function snapshotOf(live: Live): SnapshotData {
  if (!live.gateway) throw new Refused(`gateway ${GATEWAY} does not exist`);
  if (!live.provider) throw new Refused(`custom provider ${PROVIDER} does not exist`);
  const data = {
    schema: 1,
    gateway: { id: GATEWAY, ...pick(live.gateway, RECORDED_GATEWAY_FIELDS) },
    provider: Object.fromEntries(PROVIDER_FIELDS.map((f) => [f, live.provider?.[f] ?? null])),
    rules: live.rules.map(ruleOf).sort((a, b) => String(a.model).localeCompare(String(b.model))),
  };
  const parsed = Snapshot.safeParse(data);
  if (!parsed.success)
    throw new Refused(`the account's configuration does not fit the snapshot's schema (${issue(parsed.error)})`);
  return parsed.data;
}
const issue = (error: z.ZodError) => {
  const first = error.issues[0];
  return `${first?.path.join(".") || "the file"}: ${first?.message}`;
};
// Null and absent are the same setting.
const same = (a: unknown, b: unknown) => isDeepStrictEqual(a ?? null, b ?? null);

function writeAtomically(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // never written
    }
    throw error;
  }
}
const shown = (file: string) => {
  const inside = relative(ROOT, file);
  return inside && !inside.startsWith("..") ? inside : file;
};

function start(options: Options) {
  const lines: string[] = [];
  const say = (line: string) => {
    lines.push(line);
    options.log?.(line);
  };
  const end = (code: Outcome["code"]): Outcome => ({ code, lines });
  if (!TOKEN.test(options.token)) return { say, end, refused: "the admin token is not in Cloudflare's token format" };
  if (!options.allowEndpoint && options.api !== undefined && options.api !== API)
    return { say, end, refused: `requests go only to ${API}` };
  return { say, end, refused: null };
}

export async function snapshot(options: Options): Promise<Outcome> {
  const { say, end, refused } = start(options);
  if (refused) {
    say(`gateway-config: refused: ${refused}`);
    return end(2);
  }
  const c = client(options, say);
  let data: SnapshotData;
  try {
    const live = await readLive(c, say);
    const credentials = credentialsSet(live);
    if (credentials.length) throw new Refused(credentialRefusal(credentials));
    data = snapshotOf(live);
  } catch (error) {
    say(`gateway-config: snapshot failed: ${c.safe((error as Error).message)}; ${shown(options.file)} is unchanged`);
    return end(error instanceof Refused ? 2 : 1);
  }
  const text = `${JSON.stringify(data, null, 2)}\n`;
  try {
    writeAtomically(options.file, text);
  } catch (error) {
    say(
      `gateway-config: ${shown(options.file)} could not be written (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); the previous file is unchanged`,
    );
    return end(1);
  }
  if (readFileSync(options.file, "utf-8") !== text) {
    say(`gateway-config: ${shown(options.file)} does not read back as written`);
    return end(1);
  }
  say(
    `snapshot: gateway ${GATEWAY}, provider ${PROVIDER} and ${data.rules.length} pricing rule(s) (${data.rules.map((r) => r.model).join(", ")}) written to ${shown(options.file)}`,
  );
  return end(0);
}

// Cloudflare takes a pricing rule's prices only as token_pricing, per million tokens, and derives the per-token cost_in
// and cost_out it reads back (live check 2026-10-27; a per-token cost_in written directly was stored a million times
// too small, D00 T01 §6). So a write never carries cost_in or cost_out: a price change is sent as token_pricing.
function ruleForWrite(fields: Raw, whole?: Raw): Raw {
  const { cost_in, cost_out, ...rest } = fields;
  const priced = cost_in !== undefined || cost_out !== undefined;
  return priced && whole && rest.token_pricing === undefined ? { ...rest, token_pricing: whole.token_pricing } : rest;
}

type Change = { what: string; method: "POST" | "PUT" | "PATCH"; path: string; body: Raw; details: string[] };

// A value as the operator reads it: a logo by its size, prices with their units.
function shownValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return "unset";
  if (field === "logo") return `<logo, ${String(value).length} characters>`;
  if (field === "token_pricing") return `${JSON.stringify(value)} (US$ per million tokens)`;
  if (field === "cost_in" || field === "cost_out") return `${value} (US$ per token)`;
  return JSON.stringify(value);
}
const changed = (fields: string[], from: Raw | null, to: Raw) =>
  fields.map((f) => `    ${f}: ${from ? `${shownValue(f, from[f])} -> ` : ""}${shownValue(f, to[f])}`);

export async function restore(options: Options & { dry?: boolean }): Promise<Outcome> {
  const { say, end, refused } = start(options);
  const refuse = (why: string) => {
    say(`gateway-config: refused, nothing changed: ${why}`);
    return end(2);
  };
  if (refused) return refuse(refused);
  // The whole file is checked before any request.
  if (!existsSync(options.file))
    return refuse(
      `${shown(options.file)} does not exist; take one with snapshot, or write an earlier one out with git show`,
    );
  let want: SnapshotData;
  let raw: unknown;
  try {
    // Bounded before it is read: the committed snapshot is about 10 KB.
    const size = statSync(options.file).size;
    if (size > BODY_LIMIT)
      return refuse(`${shown(options.file)} is ${size} bytes, over the 1 MiB a snapshot can be; take a fresh one`);
    raw = JSON.parse(readFileSync(options.file, "utf-8"));
  } catch (error) {
    // The parser's message quotes the file, which may hold a credential, so only the position is given.
    const at = /position (\d+)/.exec((error as Error).message)?.[1];
    const why =
      error instanceof SyntaxError
        ? `is not valid JSON${at ? ` (at character ${at})` : ""}`
        : `cannot be read (${(error as NodeJS.ErrnoException).code})`;
    return refuse(`${shown(options.file)} ${why}; restore it from git, or take a fresh snapshot`);
  }
  const parsed = Snapshot.safeParse(raw);
  if (!parsed.success)
    return refuse(
      `${shown(options.file)} is not a snapshot (${issue(parsed.error)}); take a fresh one, or restore an earlier one from git`,
    );
  want = parsed.data;
  const c = client(options, say);
  let live: Live;
  try {
    live = await readLive(c, say);
  } catch (error) {
    return refuse(c.safe((error as Error).message));
  }
  const credentials = credentialsSet(live);
  if (credentials.length) return refuse(credentialRefusal(credentials));
  const byModel = new Map<string, Raw>();
  for (const rule of live.rules) {
    const model = String(rule.model);
    if (byModel.has(model))
      return refuse(`two live pricing rules name ${model}; delete one in the dashboard, then run again`);
    byModel.set(model, rule);
  }

  // The plan. The provider's id is known only once it exists, so rule paths and bodies are filled in when they run.
  const settings = Object.fromEntries(Object.entries(want.gateway).filter(([k]) => k !== "id"));
  const changes: (Change & { needsProvider?: boolean })[] = [];
  if (!live.gateway)
    changes.push({
      what: `create gateway ${GATEWAY}`,
      method: "POST",
      path: "/gateways",
      body: want.gateway,
      details: changed(Object.keys(settings), null, settings),
    });
  else {
    const differ = Object.keys({ ...settings, ...pick(live.gateway, RECORDED_GATEWAY_FIELDS) }).filter(
      (k) => !same(settings[k], live.gateway?.[k]),
    );
    if (differ.length)
      changes.push({
        what: `update gateway ${GATEWAY} (${differ.join(", ")})`,
        method: "PUT",
        path: `/gateways/${GATEWAY}`,
        body: settings,
        details: changed(differ, live.gateway, settings),
      });
  }
  const { logo, ...providerBody } = want.provider;
  const withoutNulls = (o: Raw) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));
  if (!live.provider) {
    changes.push({
      what: `create provider ${PROVIDER}`,
      method: "POST",
      path: "/custom-providers",
      body: withoutNulls(providerBody),
      details: changed(Object.keys(withoutNulls(providerBody)), null, providerBody),
    });
    if (logo !== null)
      changes.push({
        what: `set provider ${PROVIDER}'s logo`,
        method: "PATCH",
        path: "/custom-providers/{provider}",
        body: { logo },
        needsProvider: true,
        details: changed(["logo"], null, { logo }),
      });
  } else {
    const differ = PROVIDER_FIELDS.filter((f) => !same(want.provider[f], live.provider?.[f]));
    if (differ.length)
      changes.push({
        what: `update provider ${PROVIDER} (${differ.join(", ")})`,
        method: "PATCH",
        path: `/custom-providers/${live.provider.id}`,
        body: Object.fromEntries(differ.map((f) => [f, want.provider[f]])),
        details: changed(differ, live.provider, want.provider),
      });
  }
  for (const rule of want.rules) {
    const current = byModel.get(rule.model);
    if (!current)
      changes.push({
        what: `create pricing rule ${rule.model}`,
        method: "POST",
        path: "/custom-providers/costs",
        body: ruleForWrite({ account_provider_id: "{provider}", ...rule }),
        needsProvider: true,
        details: changed(
          [...RULE_FIELDS].filter((f) => f !== "model"),
          null,
          rule,
        ),
      });
    else {
      const have = ruleOf(current);
      const differ = RULE_FIELDS.filter((f) => !same(rule[f], have[f as keyof typeof have]));
      if (differ.length)
        changes.push({
          what: `update pricing rule ${rule.model} (${differ.join(", ")})`,
          method: "PATCH",
          path: `/custom-providers/costs/${current.id}`,
          body: ruleForWrite(Object.fromEntries(differ.map((f) => [f, rule[f]])), rule),
          details: changed(differ, have, rule),
        });
    }
  }
  const extras = [...byModel.keys()].filter((m) => !want.rules.some((r) => r.model === m));
  for (const model of extras)
    say(
      `note: the live pricing rule ${model} is not in ${shown(options.file)}; it is kept (delete it in the dashboard if unwanted)`,
    );

  if (options.dry) {
    for (const change of changes) {
      say(`would ${change.what}`);
      for (const line of change.details) say(line);
    }
    say(changes.length ? `dry run: ${changes.length} change(s), none sent` : "dry run: no change");
    return end(0);
  }

  const progress = options.progress ?? newProgress();
  progress.confirmed = [];
  progress.inFlight = null;
  progress.pending = changes.map((x) => x.what);
  let providerId = live.provider ? String(live.provider.id) : null;
  for (const change of changes) {
    const fill = (value: string) => value.replace("{provider}", providerId ?? "{provider}");
    const path = fill(change.path);
    const body = change.needsProvider ? JSON.parse(fill(JSON.stringify(change.body))) : change.body;
    say(`${change.what}...`);
    for (const line of change.details) say(line);
    // Landed or not: a refused change goes back to the front of what was not tried.
    const stop = (why: string, landed: "unknown" | "no") => {
      const uncertain = landed === "unknown" ? progress.inFlight : null;
      if (landed === "no" && progress.inFlight) progress.pending.unshift(progress.inFlight);
      progress.inFlight = null;
      say(`gateway-config: failed: ${why}`);
      for (const line of inventory(progress, uncertain)) say(line);
      return end(1);
    };
    progress.pending.shift();
    progress.inFlight = change.what;
    if (change.needsProvider && !providerId)
      return stop(`the provider's id is unknown, so ${change.what} cannot be sent`, "no");
    let answer: { status: number; body: Raw };
    try {
      answer = await c.call(change.method, path, body);
    } catch (error) {
      return stop(c.safe((error as Error).message), "unknown");
    }
    if (answer.status >= 500) return stop(c.explain(change.method, path, answer.status, answer.body), "unknown");
    if (answer.status < 200 || answer.status >= 300)
      return stop(c.explain(change.method, path, answer.status, answer.body), "no");
    if (change.method === "POST" && change.path === "/custom-providers") {
      const id = (answer.body.result as Raw | undefined)?.id;
      providerId = typeof id === "string" ? id : null;
    }
    progress.confirmed.push(change.what);
    progress.inFlight = null;
  }
  // After the writes, a failed check still names what changed: the changes stand, unverified.
  const unverified = (why: string) => {
    say(`gateway-config: failed: ${why}`);
    say(`  confirmed: ${progress.confirmed.join("; ") || "none"}`);
    say(
      "  unverified: the read-back could not confirm the account matches the file; run restore --dry to see what differs",
    );
    return end(1);
  };

  // Read back: the account must now match the file, with no credential field set.
  let after: Live;
  try {
    after = await readLive(c, say);
  } catch (error) {
    return unverified(`the read-back failed (${c.safe((error as Error).message)})`);
  }
  const left = credentialsSet(after);
  if (left.length) return unverified(`after restoring, ${credentialRefusal(left)}`);
  let now: SnapshotData;
  try {
    now = snapshotOf(after);
  } catch (error) {
    return unverified(`the read-back ${(error as Error).message}`);
  }
  const differ = [
    ...Object.keys({ ...want.gateway, ...now.gateway })
      .filter((k) => !same((want.gateway as Raw)[k], (now.gateway as Raw)[k]))
      .map((k) => `gateway.${k}`),
    ...PROVIDER_FIELDS.filter((f) => !same(want.provider[f], now.provider[f])).map((f) => `provider.${f}`),
    ...want.rules
      .filter(
        (r) =>
          !same(
            r,
            now.rules.find((x) => x.model === r.model),
          ),
      )
      .map((r) => `rule ${r.model}`),
  ];
  if (differ.length)
    return unverified(`the account still differs from ${shown(options.file)} after restoring: ${differ.join(", ")}`);
  say(
    changes.length
      ? `restore: ${changes.length} change(s) made; the account matches ${shown(options.file)}`
      : `restore: no change; the account matches ${shown(options.file)}`,
  );
  return end(0);
}

export function parseConfigArgs(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      dry: { type: "boolean", default: false },
      file: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  if (values.help) return { help: true as const };
  const [command, ...extra] = positionals;
  if (command !== "snapshot" && command !== "restore") throw new Error("name a command: snapshot or restore");
  if (extra.length) throw new Error(`unexpected ${extra.join(" ")}`);
  if (command === "snapshot" && values.dry) throw new Error("--dry goes with restore");
  return { help: false as const, command, dry: values.dry, file: resolve(values.file ?? join(ROOT, DEFAULT_FILE)) };
}

if (import.meta.filename === process.argv[1]) {
  let args: ReturnType<typeof parseConfigArgs>;
  try {
    args = parseConfigArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`gateway-config: ${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  installSignalCleanup("gateway-config");
  // Said before the cleanup exits: what an interrupted restore changed, what was in flight and what was not tried.
  const progress = newProgress();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.prependOnceListener(signal, () => {
      if (args.command === "restore" && !args.dry) for (const line of interrupted(progress)) console.error(line);
    });
  console.log(`Reading "${VAULT_ITEM}" from Conclave...`);
  const started = Date.now();
  const waiting = setInterval(
    () => console.log(`  still waiting for conclave-op (${Math.round((Date.now() - started) / 1000)} s)`),
    10_000,
  );
  let token: string;
  try {
    token = (
      await runCommand("conclave-op", ["read", `op://Conclave/${VAULT_ITEM}/credential`], "", Date.now() + 60_000)
    ).trim();
  } catch {
    console.error(
      `gateway-config: refused, nothing changed: reading "${VAULT_ITEM}" from Conclave failed; check the item exists and that conclave-op can reach 1Password`,
    );
    process.exit(2);
  } finally {
    clearInterval(waiting);
  }
  const log = (line: string) => console.log(line);
  const outcome =
    args.command === "snapshot"
      ? await snapshot({ token, file: args.file, log })
      : await restore({ token, file: args.file, dry: args.dry, log, progress });
  process.exit(outcome.code);
}
