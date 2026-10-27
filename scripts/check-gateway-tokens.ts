// Proves the two AI Gateway tokens in the vault do what their consumers need (D99 T01 §8), never printing either: the
// gateway refuses a request with no token and with a made-up one, and lets the Run token through (the answer then
// comes from the provider, so no model runs and nothing is charged); the Run token cannot read the gateway's
// settings; and the admin token reads gateway `isitlegit` and its `meta` provider and writes the settings back
// unchanged. Any other answer fails, naming the check. Swapped tokens fail too: the admin token holds no Run, and
// the Run token holds no Read.
//
//   node scripts/check-gateway-tokens.ts
import { runCommand } from "./smoke.ts";

const ACCOUNT_ID = "f5a529987f8dc7d52ce7aba3da25e226";
const GATEWAY = "isitlegit";
// The settings a no-op update writes back, as the gateway reports them.
const SETTINGS = [
  "authentication",
  "cache_invalidate_on_update",
  "cache_ttl",
  "collect_logs",
  "rate_limiting_interval",
  "rate_limiting_limit",
  "rate_limiting_technique",
] as const;

export type Endpoints = { api: string; gateway: string };
export type Tokens = { run: string; admin: string };
export type Outcome = { ok: boolean; lines: string[] };

type Answer = { status: number; headers: Headers; body: unknown };
async function ask(url: string, init: RequestInit = {}): Promise<Answer> {
  // Cloudflare's bot rule refuses a client that names no user agent (error 1010) before the gateway sees the token.
  const headers = new Headers(init.headers);
  headers.set("user-agent", "isitlegit-token-check/1.0");
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON: kept as text
  }
  return { status: response.status, headers: response.headers, body };
}
const isGatewayRefusal = (answer: Answer) =>
  answer.status === 401 && JSON.stringify(answer.body).includes("AiGatewayError");
const result = <T>(answer: Answer) => (answer.body as { result?: T }).result;

export async function checkTokens(tokens: Tokens, endpoints: Endpoints): Promise<Outcome> {
  const lines: string[] = [];
  const check = (passed: boolean, name: string, detail: string) => {
    lines.push(`${passed ? "passed" : "failed"}: ${name}${passed ? "" : ` (${detail})`}`);
    return passed;
  };
  const probe = `${endpoints.gateway}/${ACCOUNT_ID}/${GATEWAY}/custom-meta/v1/models`;
  const settings = `${endpoints.api}/accounts/${ACCOUNT_ID}/ai-gateway/gateways/${GATEWAY}`;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  let ok = true;
  try {
    const none = await ask(probe);
    ok = check(isGatewayRefusal(none), "the gateway refuses a request with no token", `HTTP ${none.status}`) && ok;
    const madeUp = await ask(probe, { headers: { "cf-aig-authorization": `Bearer ${"x".repeat(40)}` } });
    ok = check(isGatewayRefusal(madeUp), "the gateway refuses a made-up token", `HTTP ${madeUp.status}`) && ok;
    const run = await ask(probe, { headers: { "cf-aig-authorization": `Bearer ${tokens.run}` } });
    ok =
      check(
        !isGatewayRefusal(run) && run.headers.has("cf-aig-log-id"),
        "the gateway lets the Run token through",
        `HTTP ${run.status}${isGatewayRefusal(run) ? ", refused by the gateway" : ", not logged by the gateway"}`,
      ) && ok;
    const runReads = await ask(settings, { headers: bearer(tokens.run) });
    ok =
      check(
        runReads.status === 401 || runReads.status === 403,
        "the Run token cannot read the gateway's settings",
        `HTTP ${runReads.status}`,
      ) && ok;
    const read = await ask(settings, { headers: bearer(tokens.admin) });
    const gateway = result<Record<string, unknown>>(read);
    ok =
      check(
        read.status === 200 && gateway?.id === GATEWAY,
        "the admin token reads the gateway",
        `HTTP ${read.status}`,
      ) && ok;
    const providers = await ask(`${endpoints.api}/accounts/${ACCOUNT_ID}/ai-gateway/custom-providers`, {
      headers: bearer(tokens.admin),
    });
    const slugs = (result<{ slug?: string }[]>(providers) ?? []).map((p) => p.slug);
    ok =
      check(
        providers.status === 200 && slugs.includes("meta"),
        "the admin token reads the meta provider",
        `HTTP ${providers.status}`,
      ) && ok;
    if (gateway) {
      const unchanged = Object.fromEntries(SETTINGS.filter((k) => k in gateway).map((k) => [k, gateway[k]]));
      const write = await ask(settings, {
        method: "PUT",
        headers: bearer(tokens.admin),
        body: JSON.stringify(unchanged),
      });
      const after = result<Record<string, unknown>>(write) ?? {};
      ok =
        check(
          write.status === 200 && Object.entries(unchanged).every(([k, v]) => after[k] === v),
          "the admin token writes the settings back unchanged",
          `HTTP ${write.status}`,
        ) && ok;
    } else {
      ok = false;
      check(false, "the admin token writes the settings back unchanged", "no settings were read");
    }
  } catch (error) {
    ok = false;
    check(false, "the checks ran", (error as Error).message);
  }
  return { ok, lines };
}

if (import.meta.filename === process.argv[1]) {
  const read = (title: string) =>
    runCommand("conclave-op", ["read", `op://Conclave/${title}/credential`], "", Date.now() + 60_000).then((v) =>
      v.trim(),
    );
  const tokens = {
    run: await read("IsItLegit AI Gateway token"),
    admin: await read("IsItLegit AI Gateway admin token"),
  };
  if (!tokens.run || !tokens.admin || tokens.run === tokens.admin) {
    console.error("check-gateway-tokens: both vault items need their own token");
    process.exit(1);
  }
  const outcome = await checkTokens(tokens, {
    api: "https://api.cloudflare.com/client/v4",
    gateway: "https://gateway.ai.cloudflare.com/v1",
  });
  for (const line of outcome.lines) console.log(line);
  process.exit(outcome.ok ? 0 : 1);
}
