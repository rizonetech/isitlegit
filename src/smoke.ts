import puppeteer from "@cloudflare/puppeteer";

// GET /internal/smoke (D00 T01 §5): proves every binding works on the deployed Worker by using each once with
// synthetic data and cleaning up. It answers 404, as if it were not there, unless the bearer token equals the
// SMOKE_TOKEN secret, which scripts/smoke.ts mints for each run.

export type Check = "DB" | "ARTEFACTS" | "CACHE" | "ANALYSIS" | "BROWSER";
export type SmokeResult = { ok: boolean; commit: string; checks: Record<Check, string> };

const LIMIT_MS = 30_000;

// Equal-length digests compared in constant time, so the comparison leaks neither the token nor its length.
async function tokenMatches(given: string, secret: string): Promise<boolean> {
  const digest = async (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return crypto.subtle.timingSafeEqual(await digest(given), await digest(secret));
}

function within<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${LIMIT_MS / 1000} s`)), LIMIT_MS);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const CHECKS: Record<Check, (env: Env, id: string) => Promise<void>> = {
  async DB(env) {
    const row = await env.DB.prepare("select 1 as one").first<{ one: number }>();
    if (row?.one !== 1) throw new Error(`select 1 answered ${JSON.stringify(row)}`);
  },
  async ARTEFACTS(env, id) {
    const key = `smoke/${id}`;
    try {
      await env.ARTEFACTS.put(key, id);
      const read = await (await env.ARTEFACTS.get(key))?.text();
      if (read !== id) throw new Error(`read back ${JSON.stringify(read)}`);
    } finally {
      await env.ARTEFACTS.delete(key);
    }
  },
  async CACHE(env, id) {
    const key = `smoke:${id}`;
    try {
      await env.CACHE.put(key, id, { expirationTtl: 60 });
      const read = await env.CACHE.get(key);
      if (read !== id) throw new Error(`read back ${JSON.stringify(read)}`);
    } finally {
      await env.CACHE.delete(key);
    }
  },
  async ANALYSIS(env, id) {
    const instance = await env.ANALYSIS.create({ id: `smoke-${id}`, params: { caseId: `smoke-${id}` } });
    for (;;) {
      const { status, error } = await instance.status();
      if (status === "complete") return;
      if (status === "errored" || status === "terminated")
        throw new Error(`instance ${status}: ${error?.message ?? ""}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  },
  async BROWSER(env) {
    const browser = await puppeteer.launch(env.BROWSER);
    await browser.close();
  },
};

export async function smoke(env: Env, request: Request): Promise<Response> {
  const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!env.SMOKE_TOKEN || !given || !(await tokenMatches(given, env.SMOKE_TOKEN)))
    return new Response("Not Found", { status: 404 });
  const id = crypto.randomUUID();
  const entries = await Promise.all(
    (Object.keys(CHECKS) as Check[]).map(async (name) => {
      try {
        await within(CHECKS[name](env, id), name);
        return [name, "ok"] as const;
      } catch (error) {
        return [name, (error as Error).message || String(error)] as const;
      }
    }),
  );
  const checks = Object.fromEntries(entries) as Record<Check, string>;
  const ok = entries.every(([, result]) => result === "ok");
  const body: SmokeResult = { ok, commit: env.COMMIT_SHA, checks };
  return Response.json(body, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
