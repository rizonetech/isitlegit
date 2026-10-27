// Proves the two AI Gateway tokens in the vault do what their consumers need (D99 T01 §8), never printing either.
// The Run token: the gateway lets it through to the `meta` provider (Meta then refuses the missing provider key, so no
// model runs and nothing is charged), while it cannot read the gateway's settings or create a gateway. The admin
// token reads gateway `isitlegit` and its `meta` provider (enabled, at
// `https://api.meta.ai`), and it holds Edit, shown by creating a throwaway gateway and deleting it again with the
// documented API, which never touches `isitlegit`. The gateway refuses a request with no token and with a made-up
// one. Any other answer fails, naming the check, the permission it needs and one next step. Each check is announced
// before it waits and printed as it ends. Requests go only to Cloudflare's two hosts over HTTPS, never follow a
// redirect, and read at most 1 MiB of any answer.
//
//   node scripts/check-gateway-tokens.ts
import { installSignalCleanup, runCommand } from "./smoke.ts";

const ACCOUNT_ID = "f5a529987f8dc7d52ce7aba3da25e226";
const GATEWAY = "isitlegit";
const META_BASE = "https://api.meta.ai";
const VAULT = { run: "IsItLegit AI Gateway token", admin: "IsItLegit AI Gateway admin token" } as const;
export const CLOUDFLARE: Endpoints = {
  api: "https://api.cloudflare.com/client/v4",
  gateway: "https://gateway.ai.cloudflare.com/v1",
};
// A Cloudflare token: letters, digits and a few separators, nothing that could break a header or a line.
const TOKEN = /^[A-Za-z0-9._-]{20,200}$/;
const BODY_LIMIT = 1024 * 1024;

export type Endpoints = { api: string; gateway: string };
export type Tokens = { run: string; admin: string };
export type Outcome = { ok: boolean; lines: string[] };
export type Options = {
  log?: (line: string) => void;
  timeoutMs?: number;
  // Tests point the checks at a local stand-in; anything else must be Cloudflare's own hosts.
  allowEndpoints?: boolean;
  probeId?: string;
  // Told the throwaway gateway that may exist while it is being created and removed, and null once it is gone, so an
  // interrupted run can name it.
  onPending?: (id: string | null) => void;
};

type Answer = { status: number; headers: Headers; body: unknown };

// Reads at most `limit` bytes of a body; a larger one is refused rather than held in memory.
async function boundedText(response: Response, limit: number): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function checkTokens(tokens: Tokens, endpoints: Endpoints, options: Options = {}): Promise<Outcome> {
  const { log = () => {}, timeoutMs = 30_000, allowEndpoints = false, onPending = () => {} } = options;
  const probeId = options.probeId ?? `isitlegit-token-check-${crypto.randomUUID().slice(0, 8)}`;
  const lines: string[] = [];
  const say = (line: string) => {
    lines.push(line);
    log(line);
  };
  // Every message passes through here, so no token reaches the output even inside an error text.
  const safe = (text: string) =>
    [tokens.run, tokens.admin].reduce((t, token) => (token ? t.split(token).join("[token]") : t), text);
  if (!allowEndpoints && (endpoints.api !== CLOUDFLARE.api || endpoints.gateway !== CLOUDFLARE.gateway)) {
    say(
      "failed: the endpoints are Cloudflare's (the tokens go only to api.cloudflare.com and gateway.ai.cloudflare.com)",
    );
    return { ok: false, lines };
  }
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
      // A redirect is never followed: the token would go with it to wherever it points.
      const response = await fetch(url, {
        ...init,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return `${new URL(url).host} answered with a redirect (HTTP ${response.status}), which is not followed`;
      }
      const text = await boundedText(response, BODY_LIMIT);
      if (text === null) return `${new URL(url).host} answered with more than 1 MiB, which is not read`;
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
  // Meta's own refusal of a request that carries no Meta key: proof the request crossed the gateway to the provider,
  // whose address the provider check below confirms is Meta's.
  const isMetaRefusal = (a: Answer) =>
    a.status === 401 &&
    a.headers.has("cf-aig-log-id") &&
    (a.body as { error?: { code?: string } } | null)?.error?.code === "invalid_api_key";
  const isForbidden = (a: Answer) => a.status === 401 || a.status === 403;
  // The `result` of a Cloudflare answer, or undefined when the body is not the expected shape.
  const result = (a: Answer): unknown =>
    a.body && typeof a.body === "object" ? (a.body as { result?: unknown }).result : undefined;
  const why = (a: Answer | string, otherwise: string) => (typeof a === "string" ? a : otherwise);

  const probe = `${endpoints.gateway}/${ACCOUNT_ID}/${GATEWAY}/custom-meta/v1/models`;
  const gateways = `${endpoints.api}/accounts/${ACCOUNT_ID}/ai-gateway/gateways`;
  const settings = `${gateways}/${GATEWAY}`;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const gatewayToken = (token: string) => ({ "cf-aig-authorization": `Bearer ${token}` });
  const turnOn = (a: Answer | string) =>
    why(a, `HTTP ${(a as Answer).status}; turn Authenticated Gateway on in the gateway's settings`);

  // The gateway refuses what it should.
  const none = await ask("the gateway with no token", probe);
  record(
    typeof none !== "string" && isGatewayRefusal(none),
    "the gateway refuses a request with no token",
    turnOn(none),
  );
  const madeUp = await ask("the gateway with a made-up token", probe, { headers: gatewayToken("x".repeat(40)) });
  record(typeof madeUp !== "string" && isGatewayRefusal(madeUp), "the gateway refuses a made-up token", turnOn(madeUp));

  // The Run token: through the gateway, and nothing else.
  const run = await ask("the gateway with the Run token", probe, { headers: gatewayToken(tokens.run) });
  record(
    typeof run !== "string" && isMetaRefusal(run),
    "the gateway lets the Run token through to Meta",
    why(
      run,
      typeof run !== "string" && isGatewayRefusal(run)
        ? `refused by the gateway; "${VAULT.run}" needs AI Gateway Run (create it with the gateway's Create authentication token)`
        : `HTTP ${(run as Answer).status} was not Meta's answer; check the gateway's meta provider and the gateway's logs`,
    ),
  );
  const runReads = await ask("the Run token on the gateway's settings", settings, { headers: bearer(tokens.run) });
  record(
    typeof runReads !== "string" && isForbidden(runReads),
    "the Run token cannot read the gateway's settings",
    why(
      runReads,
      `HTTP ${(runReads as Answer).status}; "${VAULT.run}" holds more than AI Gateway Run: replace it with a Run-only token`,
    ),
  );
  const throwaway = (id: string) =>
    JSON.stringify({
      id,
      cache_ttl: 0,
      cache_invalidate_on_update: false,
      collect_logs: false,
      rate_limiting_interval: 0,
      rate_limiting_limit: 0,
      rate_limiting_technique: "fixed",
    });
  // A create whose answer was lost may still have happened, so after anything but a clear refusal the throwaway
  // gateway is deleted and read back as gone; one that cannot be confirmed gone is named for the operator.
  async function removeProbe(id: string): Promise<boolean> {
    await ask(`removing gateway ${id}`, `${gateways}/${id}`, { method: "DELETE", headers: bearer(tokens.admin) });
    const gone = await ask(`reading gateway ${id} back`, `${gateways}/${id}`, { headers: bearer(tokens.admin) });
    const removed = typeof gone !== "string" && gone.status === 404;
    if (removed) onPending(null);
    return removed;
  }
  const leftover = (id: string) => `; gateway ${id} may exist: delete it in the dashboard (AI, AI Gateway)`;
  onPending(`${probeId}-run`);
  const runCreates = await ask("the Run token creating a gateway", gateways, {
    method: "POST",
    headers: bearer(tokens.run),
    body: throwaway(`${probeId}-run`),
  });
  const runRefused = typeof runCreates !== "string" && isForbidden(runCreates);
  if (runRefused) onPending(null);
  const runLeft = !runRefused && !(await removeProbe(`${probeId}-run`));
  record(
    runRefused && !runLeft,
    "the Run token cannot change the gateways",
    why(
      runCreates,
      `HTTP ${(runCreates as Answer).status}; "${VAULT.run}" holds AI Gateway Edit: replace it with a Run-only token`,
    ) + (runLeft ? leftover(`${probeId}-run`) : ""),
  );

  // The admin token: Read and Edit. (The gateway also lets it send requests: on Cloudflare a token with AI Gateway
  // Edit is accepted as Run too, observed 2026-10-27, so that is not checked; it is one more reason the admin token
  // never goes in the Worker.)
  const read = await ask("the admin token reading the gateway", settings, { headers: bearer(tokens.admin) });
  const gateway = typeof read === "string" ? undefined : result(read);
  record(
    typeof read !== "string" && read.status === 200 && (gateway as { id?: unknown } | undefined)?.id === GATEWAY,
    "the admin token reads the gateway",
    why(read, `HTTP ${(read as Answer).status}; "${VAULT.admin}" needs AI Gateway Read on this account`),
  );
  // Every page of the account's custom providers, until `meta` is found or the pages end.
  let meta: { enable?: unknown; base_url?: unknown } | undefined;
  let providers: Answer | string = "the providers were not read";
  for (let page = 1; page <= 20 && !meta; page++) {
    providers = await ask(
      `the admin token reading the providers (page ${page})`,
      `${endpoints.api}/accounts/${ACCOUNT_ID}/ai-gateway/custom-providers?page=${page}&per_page=50`,
      { headers: bearer(tokens.admin) },
    );
    if (typeof providers === "string" || providers.status !== 200) break;
    const listed = result(providers);
    if (!Array.isArray(listed)) break;
    meta = listed.find((p) => (p as { slug?: unknown })?.slug === "meta") as typeof meta;
    const info = (providers.body as { result_info?: { total_pages?: unknown } }).result_info;
    if (typeof info?.total_pages !== "number" || page >= info.total_pages) break;
  }
  record(
    typeof providers !== "string" && providers.status === 200 && meta?.enable === true && meta?.base_url === META_BASE,
    "the admin token reads the meta provider, enabled at Meta's address",
    why(
      providers,
      (providers as Answer).status !== 200
        ? `HTTP ${(providers as Answer).status}; "${VAULT.admin}" needs AI Gateway Read on this account`
        : !meta
          ? "the gateway has no meta provider; restore it (D00 T01 §6, §11)"
          : `the meta provider is ${meta.enable === true ? "enabled" : "disabled"} at ${String(meta.base_url)}; it should be enabled at ${META_BASE} (D00 T01 §6)`,
    ),
  );
  // Edit, by the documented API: a throwaway gateway created and deleted, and read back as gone.
  onPending(probeId);
  const created = await ask("the admin token creating a throwaway gateway", gateways, {
    method: "POST",
    headers: bearer(tokens.admin),
    body: throwaway(probeId),
  });
  const adminRefused = typeof created !== "string" && isForbidden(created);
  const madeIt =
    typeof created !== "string" &&
    created.status === 200 &&
    (result(created) as { id?: unknown } | undefined)?.id === probeId;
  // Removed after a success and after any uncertain answer; only a clear refusal created nothing.
  if (adminRefused) onPending(null);
  const left = !adminRefused && !(await removeProbe(probeId));
  let editProblem = "";
  if (left) editProblem = `gateway ${probeId} may exist: delete it in the dashboard (AI, AI Gateway)`;
  else if (adminRefused)
    editProblem = `HTTP ${(created as Answer).status}; "${VAULT.admin}" needs AI Gateway Edit on this account`;
  else if (!madeIt)
    editProblem = typeof created === "string" ? created : `HTTP ${created.status} creating gateway ${probeId}`;
  record(editProblem === "", "the admin token holds Edit", editProblem);
  return { ok, lines };
}

if (import.meta.filename === process.argv[1]) {
  // Ctrl+C, a termination signal or a closed terminal stops a vault read still running before this exits.
  installSignalCleanup("check-gateway-tokens");
  // Said before the cleanup exits: a throwaway gateway being created or removed when the run stopped may remain.
  let pending: string | null = null;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.prependOnceListener(signal, () => {
      if (pending)
        console.error(
          `check-gateway-tokens: gateway ${pending} may exist; delete it in the dashboard (AI, AI Gateway)`,
        );
    });
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
  console.log("Reading both tokens from Conclave...");
  const tokens = { run: await read("run"), admin: await read("admin") };
  const outcome = await checkTokens(tokens, CLOUDFLARE, {
    log: (line) => console.log(line),
    onPending: (id) => {
      pending = id;
    },
  });
  process.exit(outcome.ok ? 0 : 1);
}
