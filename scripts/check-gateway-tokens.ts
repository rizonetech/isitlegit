// Proves the two AI Gateway tokens in the vault do what their consumers need (D99 T01 §8), never printing either: the
// gateway refuses a request with no token and with a made-up one, and lets the Run token through to Meta (Meta then
// refuses the missing provider key, so no model runs and nothing is charged); the Run token cannot read the gateway's
// settings; and the admin token reads gateway `isitlegit` and its `meta` provider and holds Edit, shown by an update
// with no fields, which Cloudflare refuses as invalid (400) only after accepting the token's permission (a token
// without Edit gets 403), so the probe can never change a setting someone set meanwhile. Any other answer fails, naming the check, the capability it needs and what to do. Swapped tokens fail
// too: the admin token holds no Run, and the Run token holds no Read. Each check is announced before it waits and
// printed as soon as it ends, so a slow or interrupted run still shows what it learned.
//
//   node scripts/check-gateway-tokens.ts
import { installSignalCleanup, runCommand } from "./smoke.ts";

const ACCOUNT_ID = "f5a529987f8dc7d52ce7aba3da25e226";
const GATEWAY = "isitlegit";
const VAULT = { run: "IsItLegit AI Gateway token", admin: "IsItLegit AI Gateway admin token" } as const;
// A Cloudflare token: letters, digits and a few separators, nothing that could break a header or a line.
const TOKEN = /^[A-Za-z0-9._-]{20,200}$/;

export type Endpoints = { api: string; gateway: string };
export type Tokens = { run: string; admin: string };
export type Outcome = { ok: boolean; lines: string[] };
export type Options = { log?: (line: string) => void; timeoutMs?: number };

type Answer = { status: number; headers: Headers; body: unknown };

export async function checkTokens(tokens: Tokens, endpoints: Endpoints, options: Options = {}): Promise<Outcome> {
  const { log = () => {}, timeoutMs = 30_000 } = options;
  const lines: string[] = [];
  const say = (line: string) => {
    lines.push(line);
    log(line);
  };
  // Every message passes through here, so no token reaches the output even inside an error text.
  const safe = (text: string) =>
    [tokens.run, tokens.admin].reduce((t, token) => (token ? t.split(token).join("[token]") : t), text);
  for (const [name, token] of Object.entries(tokens) as [keyof Tokens, string][]) {
    if (!TOKEN.test(token)) {
      say(
        `failed: the ${name} token is well formed (the vault item "${VAULT[name]}" holds something that is not a Cloudflare token; paste the token again, with no spaces or line breaks)`,
      );
      return { ok: false, lines };
    }
  }
  if (tokens.run === tokens.admin) {
    say(`failed: the two tokens differ (both vault items hold the same token; each needs its own, D99 T01 §8)`);
    return { ok: false, lines };
  }

  async function ask(stage: string, url: string, init: RequestInit = {}): Promise<Answer | string> {
    log(`  checking: ${stage}...`);
    // Cloudflare's bot rule refuses a client that names no user agent (error 1010) before the gateway sees the token.
    const headers = new Headers(init.headers);
    headers.set("user-agent", "isitlegit-token-check/1.0");
    if (init.body) headers.set("content-type", "application/json");
    try {
      const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // not JSON: kept as text
      }
      return { status: response.status, headers: response.headers, body };
    } catch (error) {
      const why = (error as Error).name === "TimeoutError" ? `no answer within ${timeoutMs / 1000} s` : "unreachable";
      return safe(`${new URL(url).host} ${why}; check the network and run again`);
    }
  }
  let ok = true;
  const record = (passed: boolean, name: string, failure: string) => {
    if (!passed) ok = false;
    say(passed ? `passed: ${name}` : `failed: ${name} (${safe(failure)})`);
  };
  const isGatewayRefusal = (a: Answer) => a.status === 401 && JSON.stringify(a.body).includes("AiGatewayError");
  // Meta's own refusal of a request that carries no Meta key: proof the request crossed the gateway to Meta.
  const isMetaRefusal = (a: Answer) =>
    a.status === 401 &&
    a.headers.has("cf-aig-log-id") &&
    (a.body as { error?: { code?: string } })?.error?.code === "invalid_api_key";
  // The `result` of a Cloudflare answer, or undefined when the body is not the expected shape.
  const result = (a: Answer): unknown =>
    a.body && typeof a.body === "object" ? (a.body as { result?: unknown }).result : undefined;

  const probe = `${endpoints.gateway}/${ACCOUNT_ID}/${GATEWAY}/custom-meta/v1/models`;
  const settings = `${endpoints.api}/accounts/${ACCOUNT_ID}/ai-gateway/gateways/${GATEWAY}`;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  const none = await ask("the gateway with no token", probe);
  record(
    typeof none !== "string" && isGatewayRefusal(none),
    "the gateway refuses a request with no token",
    typeof none === "string" ? none : `HTTP ${none.status}; turn Authenticated Gateway on in the gateway's settings`,
  );
  const madeUp = await ask("the gateway with a made-up token", probe, {
    headers: { "cf-aig-authorization": `Bearer ${"x".repeat(40)}` },
  });
  record(
    typeof madeUp !== "string" && isGatewayRefusal(madeUp),
    "the gateway refuses a made-up token",
    typeof madeUp === "string"
      ? madeUp
      : `HTTP ${madeUp.status}; turn Authenticated Gateway on in the gateway's settings`,
  );
  const run = await ask("the gateway with the Run token", probe, {
    headers: { "cf-aig-authorization": `Bearer ${tokens.run}` },
  });
  record(
    typeof run !== "string" && isMetaRefusal(run),
    "the gateway lets the Run token through to Meta",
    typeof run === "string"
      ? run
      : isGatewayRefusal(run)
        ? `refused by the gateway; "${VAULT.run}" needs AI Gateway Run (create it with the gateway's Create authentication token)`
        : `HTTP ${run.status} was not Meta's answer; check the gateway's meta provider and the gateway's logs`,
  );
  const runReads = await ask("the Run token on the gateway's settings", settings, { headers: bearer(tokens.run) });
  record(
    typeof runReads !== "string" && (runReads.status === 401 || runReads.status === 403),
    "the Run token cannot read the gateway's settings",
    typeof runReads === "string"
      ? runReads
      : `HTTP ${runReads.status}; "${VAULT.run}" holds more than AI Gateway Run: replace it with a Run-only token`,
  );
  const read = await ask("the admin token reading the gateway", settings, { headers: bearer(tokens.admin) });
  const settingsRead = typeof read === "string" ? undefined : result(read);
  const gateway =
    settingsRead && typeof settingsRead === "object" && !Array.isArray(settingsRead)
      ? (settingsRead as Record<string, unknown>)
      : undefined;
  record(
    typeof read !== "string" && read.status === 200 && gateway?.id === GATEWAY,
    "the admin token reads the gateway",
    typeof read === "string" ? read : `HTTP ${read.status}; "${VAULT.admin}" needs AI Gateway Read on this account`,
  );
  const providers = await ask(
    "the admin token reading the providers",
    `${endpoints.api}/accounts/${ACCOUNT_ID}/ai-gateway/custom-providers`,
    {
      headers: bearer(tokens.admin),
    },
  );
  const listed = typeof providers === "string" ? undefined : result(providers);
  const slugs = Array.isArray(listed) ? listed.map((p) => (p as { slug?: unknown })?.slug) : [];
  record(
    typeof providers !== "string" && providers.status === 200 && slugs.includes("meta"),
    "the admin token reads the meta provider",
    typeof providers === "string"
      ? providers
      : providers.status === 200
        ? "the gateway has no meta provider; restore it (D00 T01 §6, §11)"
        : `HTTP ${providers.status}; "${VAULT.admin}" needs AI Gateway Read on this account`,
  );
  // An update with no fields: refused as invalid (400, Cloudflare's validation code 7001) once the token's Edit is
  // accepted, refused as forbidden (403) without it; it cannot change anything either way.
  const edit = await ask("the admin token's Edit permission", settings, {
    method: "PUT",
    headers: bearer(tokens.admin),
    body: "{}",
  });
  const codes =
    typeof edit === "string" || !edit.body || typeof edit.body !== "object"
      ? []
      : (() => {
          const errors = (edit.body as { errors?: unknown }).errors;
          return Array.isArray(errors) ? errors.map((e) => (e as { code?: unknown })?.code) : [];
        })();
  record(
    typeof edit !== "string" && edit.status === 400 && codes.includes(7001),
    "the admin token holds Edit",
    typeof edit === "string"
      ? edit
      : edit.status === 403 || edit.status === 401
        ? `HTTP ${edit.status}; "${VAULT.admin}" needs AI Gateway Edit on this account`
        : `HTTP ${edit.status} to an empty update; read the gateway's settings in the dashboard before relying on this token`,
  );
  return { ok, lines };
}

if (import.meta.filename === process.argv[1]) {
  const read = async (name: keyof Tokens) => {
    try {
      return (
        await runCommand("conclave-op", ["read", `op://Conclave/${VAULT[name]}/credential`], "", Date.now() + 60_000)
      ).trim();
    } catch {
      console.error(
        `failed: reading "${VAULT[name]}" from Conclave (check that the item exists and that conclave-op can reach 1Password)`,
      );
      process.exit(1);
    }
  };
  // Ctrl+C, a termination signal or a closed terminal stops a vault read still running before this exits.
  installSignalCleanup();
  console.log("Reading both tokens from Conclave...");
  const tokens = { run: await read("run"), admin: await read("admin") };
  const outcome = await checkTokens(
    tokens,
    { api: "https://api.cloudflare.com/client/v4", gateway: "https://gateway.ai.cloudflare.com/v1" },
    { log: (line) => console.log(line) },
  );
  process.exit(outcome.ok ? 0 : 1);
}
