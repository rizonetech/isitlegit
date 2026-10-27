// Proves every binding on the deployed Worker (D00 T01 §5): mints a random token, sets it as the Worker's SMOKE_TOKEN
// secret through `wrangler secret put` (on standard input; it is never printed or stored), which publishes a new
// version, reads that version's id from `wrangler deployments status`, calls /internal/smoke on it, and passes only on
// HTTP 200 from that version, at the expected commit, with exactly the five checks and every one `ok`. It prints each
// stage as it starts, the elapsed time every 10 s while it waits, and the total; one deadline bounds every request.
//
//   node scripts/smoke.ts https://isitlegit.<subdomain>.workers.dev [--commit <sha>]   (default: git rev-parse HEAD)
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

export const CHECKS = ["DB", "ARTEFACTS", "CACHE", "ANALYSIS", "BROWSER"];
export type Outcome = { ok: boolean; lines: string[] };
export type SmokeOptions = {
  commit: string;
  // Sets the secret and answers the id of the version that now serves the Worker.
  putSecret: (token: string, log: (line: string) => void) => Promise<string>;
  waitMs?: number;
  log?: (line: string) => void;
  pause?: (ms: number) => Promise<unknown>;
};

const seconds = (since: number) => `${Math.round((Date.now() - since) / 1000)} s`;

// Calls `work` and logs the elapsed time every 10 s until it settles.
async function withProgress<T>(what: string, log: (line: string) => void, work: () => Promise<T>): Promise<T> {
  const start = Date.now();
  log(`${what}...`);
  const timer = setInterval(() => log(`  still ${what.toLowerCase()}, ${seconds(start)}`), 10_000);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

// Every way an answer can fall short, in words, or null when it is a clean pass.
export function refusal(status: number, text: string, commit: string, version: string): string | null {
  if (status !== 200) return `answered HTTP ${status}`;
  let body: { ok?: unknown; commit?: unknown; version?: unknown; checks?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return "answered a body that is not JSON";
  }
  const checks = body.checks as Record<string, unknown> | undefined;
  if (!checks || typeof checks !== "object") return "answered no checks";
  const names = Object.keys(checks).sort();
  if (names.join() !== [...CHECKS].sort().join()) return `answered checks ${names.join(", ") || "none"}, not all five`;
  const failed = CHECKS.filter((name) => checks[name] !== "ok");
  if (failed.length) return `failed ${failed.map((name) => `${name} (${String(checks[name])})`).join(", ")}`;
  if (body.ok !== true) return "answered ok: false with every check ok";
  if (body.commit !== commit) return `served commit ${String(body.commit)}, expected ${commit}`;
  if (body.version !== version) return `served version ${String(body.version)}, expected ${version}`;
  return null;
}

export async function runSmoke(base: string, options: SmokeOptions): Promise<Outcome> {
  const {
    commit,
    putSecret,
    waitMs = 90_000,
    log = () => {},
    pause = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = options;
  const start = Date.now();
  const deadline = start + waitMs;
  const lines: string[] = [];
  const token = randomBytes(32).toString("hex");
  const version = await withProgress("Setting a fresh SMOKE_TOKEN (Cloudflare publishes a new version)", log, () =>
    putSecret(token, log),
  );
  log(`The secret is live in version ${version}.`);
  const url = new URL("/internal/smoke", base);
  const outcome = await withProgress(`Calling ${url}`, log, async (): Promise<Outcome> => {
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return { ok: false, lines: [`smoke: no passing answer within ${waitMs / 1000} s`] };
      let status: number;
      let text: string;
      try {
        // The signal bounds the headers and the body alike.
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(left),
        });
        status = response.status;
        text = await response.text();
      } catch (error) {
        return { ok: false, lines: [`smoke: ${url} gave no answer: ${(error as Error).message}`] };
      }
      // The new version can take a few seconds to reach every location: until then the old one answers 404.
      if (status === 404) {
        await pause(2_000);
        continue;
      }
      try {
        const body = JSON.parse(text) as { version?: string; checks?: Record<string, string> };
        if (body.version && body.version !== version && status === 200) {
          await pause(2_000);
          continue;
        }
        lines.push(
          `version: ${String(body.version)}`,
          ...Object.entries(body.checks ?? {}).map(([n, r]) => `${n}: ${r}`),
        );
      } catch {
        // refusal() names the malformed body.
      }
      const problem = refusal(status, text, commit, version);
      return { ok: problem === null, lines: problem ? [...lines, `smoke: ${problem}`] : lines };
    }
  });
  return { ok: outcome.ok, lines: [...outcome.lines, `${outcome.ok ? "passed" : "failed"} in ${seconds(start)}`] };
}

// `wrangler secret put SMOKE_TOKEN` with the token on standard input, then the version `deployments status` names.
function putWithWrangler(token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "wrangler", "secret", "put", "SMOKE_TOKEN"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`wrangler secret put failed (exit ${code}): ${stderr.slice(-400)}`));
      const status = JSON.parse(
        execFileSync("pnpm", ["exec", "wrangler", "deployments", "status", "--json"], { encoding: "utf-8" }),
      );
      const live = (status.versions as { version_id: string; percentage: number }[]).find((v) => v.percentage === 100);
      if (!live) return reject(new Error("no version serves all traffic after the secret was set"));
      resolve(live.version_id);
    });
    child.stdin.end(token);
  });
}

if (import.meta.filename === process.argv[1]) {
  const base = process.argv[2];
  if (!base || base.startsWith("--")) {
    console.error("smoke: give the deployed Worker's URL");
    process.exit(2);
  }
  const at = process.argv.indexOf("--commit");
  const commit =
    at > 0 ? (process.argv[at + 1] ?? "") : execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    console.error("smoke: --commit needs a full 40-hex commit");
    process.exit(2);
  }
  try {
    const outcome = await runSmoke(base, { commit, putSecret: putWithWrangler, log: (line) => console.log(line) });
    for (const line of outcome.lines) console.log(line);
    process.exit(outcome.ok ? 0 : 1);
  } catch (error) {
    console.error(`smoke: ${(error as Error).message}`);
    process.exit(1);
  }
}
