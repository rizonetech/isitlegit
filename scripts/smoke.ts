// Proves every binding on the deployed Worker (D00 T01 §5): mints a random token, sets it as the Worker's SMOKE_TOKEN
// secret through `wrangler secret put` (on standard input; it is never printed or stored), calls /internal/smoke with
// it, prints each check, and exits non-zero on a refused call or any failed check.
//
//   node scripts/smoke.ts https://isitlegit.<subdomain>.workers.dev
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export type Outcome = { ok: boolean; lines: string[] };

// A new secret takes a few seconds to reach every location, so a 404 is retried for up to `waitMs`.
export async function runSmoke(
  base: string,
  putSecret: (token: string) => void,
  waitMs = 60_000,
  pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Outcome> {
  const token = randomBytes(32).toString("hex");
  putSecret(token);
  const url = new URL("/internal/smoke", base);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (response.status === 404 && Date.now() < deadline) {
      await pause(2_000);
      continue;
    }
    if (response.status !== 200 && response.status !== 503)
      return { ok: false, lines: [`smoke: ${url} answered ${response.status}`] };
    const body = (await response.json()) as { ok: boolean; commit: string; checks: Record<string, string> };
    const lines = Object.entries(body.checks).map(([name, result]) => `${name}: ${result}`);
    return { ok: body.ok && lines.length > 0, lines: [`commit: ${body.commit}`, ...lines] };
  }
}

function putWithWrangler(token: string): void {
  const run = spawnSync("pnpm", ["exec", "wrangler", "secret", "put", "SMOKE_TOKEN"], {
    input: token,
    encoding: "utf-8",
    timeout: 120_000,
  });
  if (run.status !== 0) throw new Error(`wrangler secret put failed (exit ${run.status}): ${run.stderr.slice(-400)}`);
}

if (import.meta.filename === process.argv[1]) {
  const base = process.argv[2];
  if (!base) {
    console.error("smoke: give the deployed Worker's URL");
    process.exit(2);
  }
  try {
    const outcome = await runSmoke(base, putWithWrangler);
    for (const line of outcome.lines) console.log(line);
    process.exit(outcome.ok ? 0 : 1);
  } catch (error) {
    console.error(`smoke: ${(error as Error).message}`);
    process.exit(1);
  }
}
