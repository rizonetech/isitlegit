import puppeteer from "@cloudflare/puppeteer";

// GET /internal/smoke (D00 T01 §5): proves every binding works on the deployed Worker by using each once with
// synthetic data and cleaning up. It answers 404, as if it were not there, unless the bearer token equals the
// SMOKE_TOKEN secret, which scripts/smoke.ts reads from the vault (and replaces with `--rotate`). Each check has a time limit; whatever a check left
// behind is still cleaned up after the answer has gone (`waitUntil`), and what cleanup cannot remove expires on its
// own: KV keys after 60 s, R2 objects under smoke/ after a day (the bucket's smoke-1-day rule), Browser Run sessions
// after their idle timeout, and a Workflow instance past its limit is terminated.

export const CHECKS = ["DB", "ARTEFACTS", "CACHE", "ANALYSIS", "BROWSER"] as const;
export type Check = (typeof CHECKS)[number];
// A screening probe through the deployed Worker's own path (D03 T04 §36), run only when a release asks for it.
export type ScreenProbe = (runId: string) => Promise<{ screener: string; version: string }>;
export type SmokeResult = { ok: boolean; commit: string; version: string; checks: Record<string, string> };

// All the route needs of the request's context: keeping cleanup alive after the answer.
type Ctx = Pick<ExecutionContext, "waitUntil">;
type Run = { id: string; ctx: Ctx; limitMs: number };

// Equal-length digests compared in constant time, so the comparison leaks neither the token nor its length.
async function tokenMatches(given: string, secret: string): Promise<boolean> {
  const digest = async (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return crypto.subtle.timingSafeEqual(await digest(given), await digest(secret));
}

function within<T>(work: Promise<T>, what: string, limitMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${limitMs / 1000} s`)), limitMs);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// Runs `work`, then `cleanup` whatever happened, and fails with both causes when both fail; the whole trip is kept
// alive past the answer so a write that lands after a timeout is still removed.
function trip(run: Run, work: () => Promise<void>, cleanup: () => Promise<unknown>): Promise<void> {
  const done = (async () => {
    let failure: Error | undefined;
    try {
      await work();
    } catch (error) {
      failure = error as Error;
    }
    try {
      await cleanup();
    } catch (error) {
      const cleanupFailure = `cleanup failed: ${(error as Error).message}`;
      throw new Error(failure ? `${failure.message}; ${cleanupFailure}` : cleanupFailure);
    }
    if (failure) throw failure;
  })();
  run.ctx.waitUntil(done.catch(() => undefined));
  return done;
}

const RUNS: Record<Check, (env: Env, run: Run) => Promise<void>> = {
  async DB(env) {
    const row = await env.DB.prepare("select 1 as one").first<{ one: number }>();
    if (row?.one !== 1) throw new Error(`select 1 answered ${JSON.stringify(row)}`);
  },
  ARTEFACTS(env, run) {
    const key = `smoke/${run.id}`;
    return trip(
      run,
      async () => {
        await env.ARTEFACTS.put(key, run.id);
        const read = await (await env.ARTEFACTS.get(key))?.text();
        if (read !== run.id) throw new Error(`read back ${JSON.stringify(read)}`);
      },
      () => env.ARTEFACTS.delete(key),
    );
  },
  CACHE(env, run) {
    const key = `smoke:${run.id}`;
    return trip(
      run,
      async () => {
        await env.CACHE.put(key, run.id, { expirationTtl: 60 });
        const read = await env.CACHE.get(key);
        if (read !== run.id) throw new Error(`read back ${JSON.stringify(read)}`);
      },
      () => env.CACHE.delete(key),
    );
  },
  ANALYSIS(env, run) {
    let instance: WorkflowInstance | undefined;
    let complete = false;
    // Created inside the guard, so an instance whose creation answers after the limit is still terminated; an
    // instance that did not complete (past the limit, or its status could not be read) is terminated, and a
    // termination that fails is reported as a failed cleanup.
    return trip(
      run,
      async () => {
        const deadline = Date.now() + run.limitMs - 1_000;
        instance = await env.ANALYSIS.create({ id: `smoke-${run.id}`, params: { caseId: `smoke-${run.id}` } });
        while (Date.now() < deadline) {
          const { status, error } = await instance.status();
          if (status === "complete") {
            complete = true;
            return;
          }
          if (status === "errored" || status === "terminated")
            throw new Error(`instance ${status}: ${error?.message ?? ""}`);
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error(`instance did not complete within ${(run.limitMs - 1_000) / 1000} s`);
      },
      async () => {
        if (instance && !complete) await instance.terminate();
      },
    );
  },
  BROWSER(env, run) {
    let session: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
    return trip(
      run,
      async () => {
        session = await puppeteer.launch(env.BROWSER);
      },
      async () => session?.close(),
    );
  },
};

export async function smoke(
  env: Env,
  request: Request,
  ctx: Ctx,
  limitMs = 30_000,
  screen?: ScreenProbe,
): Promise<Response> {
  const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!env.SMOKE_TOKEN || !given || !(await tokenMatches(given, env.SMOKE_TOKEN)))
    return new Response("Not Found", { status: 404 });
  const run: Run = { id: crypto.randomUUID(), ctx, limitMs };
  const entries: [string, string][] = await Promise.all(
    CHECKS.map(async (name) => {
      try {
        await within(RUNS[name](env, run), name, limitMs);
        return [name, "ok"] as [string, string];
      } catch (error) {
        return [name, (error as Error).message || String(error)] as [string, string];
      }
    }),
  );
  // The SCREEN check runs only for a release that asks for it: no plain smoke run pays screening spend, and a
  // release reads the screener and the deployed version back from the deployed Worker itself.
  if (screen && new URL(request.url).searchParams.get("screen") === "1") {
    try {
      const probed = await within(screen(run.id), "SCREEN", limitMs);
      entries.push(["SCREEN", `ok ${probed.screener} ${probed.version}`]);
    } catch (error) {
      entries.push(["SCREEN", (error as Error).message || String(error)]);
    }
  }
  const checks = Object.fromEntries(entries) as Record<string, string>;
  const ok = entries.every(([, result]) => result === "ok");
  const body: SmokeResult = { ok, commit: env.COMMIT_SHA, version: env.CF_VERSION_METADATA.id, checks };
  return Response.json(body, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
