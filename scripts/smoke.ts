// Proves every binding on the deployed Worker (D00 T01 §5, §10): reads the long-lived smoke token from the vault
// (Conclave "IsItLegit Smoke token", through WSL `op` with the service account) and the version serving all traffic
// from `wrangler deployments status`, calls /internal/smoke with it, and passes only on HTTP 200 from that version, at
// the expected commit, with exactly the five checks and every one `ok`, and only if the same version still serves all
// traffic afterwards: a run publishes nothing, so it cannot displace a version a rollback just chose. `--rotate` makes a
// new token, stores it in the vault, then sets it on the Worker (which publishes a version) and checks that version.
// The token is never printed or passed as an argument. It prints each stage as it starts, the elapsed time every 10 s
// while it waits, and the total; one deadline bounds every request and command.
//
//   node scripts/smoke.ts https://isitlegit.<subdomain>.workers.dev [--commit <sha>] [--rotate]
//   (--commit defaults to git rev-parse HEAD)
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CHECKS = ["DB", "ARTEFACTS", "CACHE", "ANALYSIS", "BROWSER"];
export type Outcome = { ok: boolean; lines: string[] };
export type SmokeOptions = {
  commit: string;
  // The long-lived token, and the id of the version serving all traffic, each by `deadline` (epoch ms).
  getToken: (deadline: number) => Promise<string>;
  activeVersion: (deadline: number) => Promise<string>;
  // Only with --rotate: stores a new token in the vault, sets it on the Worker (publishing a version) and answers both.
  rotate?: (deadline: number) => Promise<{ token: string; version: string }>;
  waitMs?: number;
  log?: (line: string) => void;
  pause?: (ms: number) => Promise<unknown>;
  // Where the token may go; the default is destinationProblem (HTTPS to the IsItLegit Worker only).
  checkDestination?: (base: string) => string | null;
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

// The hosts that serve the IsItLegit Worker: its workers.dev address in Rizonetech's account (the subdomain is the
// account's, so `isitlegit.<other>.workers.dev` is someone else's Worker) and the isitlegit.co.za zone Rizonetech owns.
export const WORKER_HOST = "isitlegit.derick-f5a.workers.dev";

// The token goes only over HTTPS to one of those hosts. Checked before the secret is set, so a mistyped, plain-HTTP
// or other account's address never receives, or even causes, a live token.
export function destinationProblem(base: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return `${base} is not a URL`;
  }
  if (url.protocol !== "https:") return `${base} is not HTTPS; the token is never sent in the clear`;
  const host = url.hostname;
  if (host !== WORKER_HOST && host !== "isitlegit.co.za" && !host.endsWith(".isitlegit.co.za"))
    return `${host} is not the IsItLegit Worker (${WORKER_HOST} or isitlegit.co.za)`;
  return null;
}

export async function runSmoke(base: string, options: SmokeOptions): Promise<Outcome> {
  const {
    commit,
    getToken,
    activeVersion,
    rotate,
    waitMs = 90_000,
    log = () => {},
    pause = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = options;
  const refused = (options.checkDestination ?? destinationProblem)(base);
  if (refused) return { ok: false, lines: [`smoke: ${refused}`] };
  const start = Date.now();
  const deadline = start + waitMs;
  const lines: string[] = [];
  const { token, version } = rotate
    ? await withProgress("Rotating SMOKE_TOKEN (Cloudflare publishes a new version)", log, () => rotate(deadline))
    : await withProgress("Reading the smoke token and the version serving all traffic", log, async () => ({
        token: await getToken(deadline),
        version: await activeVersion(deadline),
      }));
  log(rotate ? `The new token is live in version ${version}.` : `Version ${version} serves all traffic.`);
  const url = new URL("/internal/smoke", base);
  const outcome = await withProgress(`Calling ${url}`, log, async (): Promise<Outcome> => {
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return { ok: false, lines: [`smoke: no passing answer within ${waitMs / 1000} s`] };
      let status: number;
      let text: string;
      try {
        // The signal bounds the headers and the body alike.
        // A redirect is refused rather than followed: the token goes to this address only.
        const response = await fetch(url, {
          redirect: "manual",
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(left),
        });
        status = response.status;
        text = await response.text();
      } catch (error) {
        // The run's own deadline, whether it struck between requests or during one, is one failure with one name.
        if ((error as Error).name === "TimeoutError")
          return { ok: false, lines: [`smoke: no passing answer within ${waitMs / 1000} s`] };
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
  // The run published nothing (without --rotate), so the same version must still serve: anything else means something
  // else changed the deployment meanwhile, and the result does not describe what now serves.
  let after: string;
  try {
    after = await activeVersion(Math.max(deadline, Date.now() + 30_000));
  } catch (error) {
    after = `unknown (${(error as Error).message})`;
  }
  const moved = after !== version;
  const ok = outcome.ok && !moved;
  const lines2 = moved
    ? [...outcome.lines, `smoke: the version serving all traffic changed during the run: ${version} to ${after}`]
    : outcome.lines;
  return { ok, lines: [...lines2, `${ok ? "passed" : "failed"} in ${seconds(start)}`] };
}

// Runs a command with `input` on standard input and answers its standard output, or fails when it exits non-zero or
// is still running at `deadline` (epoch ms). It runs in a process group of its own, so the deadline kills everything it
// started (`pnpm exec` starts wrangler as a child), not just the launcher. Asynchronous, so progress keeps printing.
// The process groups of commands still running, so an interrupted run can stop them (installSignalCleanup).
const running = new Set<number>();

// Kills a command and everything it started: its POSIX process group, or on Windows (no process groups) its process
// tree through taskkill.
export function killGroup(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: (command: string, args: string[]) => unknown = (command, args) => spawnSync(command, args, { stdio: "ignore" }),
): void {
  if (platform === "win32") {
    run("taskkill", ["/pid", String(pid), "/T", "/F"]);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group has already gone.
  }
}

// On Ctrl+C, a termination signal or a hangup, kills every command still running before exiting, so an interrupted run cannot
// leave wrangler publishing with no deadline left to stop it.
export function installSignalCleanup(): void {
  // SIGHUP too: a closed terminal or SSH session reaches this process but not the commands' own groups.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(signal, () => {
      for (const pid of running) killGroup(pid);
      console.error(`smoke: interrupted (${signal}); stopped ${running.size} running command(s)`);
      process.exit(130);
    });
}

export function runCommand(
  command: string,
  args: string[],
  input: string,
  deadline: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], detached: true, env });
    if (child.pid) running.add(child.pid);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    let expired = false;
    const timer = setTimeout(
      () => {
        expired = true;
        if (child.pid) killGroup(child.pid);
      },
      Math.max(0, deadline - Date.now()),
    );
    child.on("error", (error) => {
      clearTimeout(timer);
      if (child.pid) running.delete(child.pid);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (child.pid) running.delete(child.pid);
      const what = [command, ...args.slice(0, 3)].join(" ");
      if (expired) return reject(new Error(`${what} did not finish before the deadline`));
      if (code !== 0) return reject(new Error(`${what} failed (exit ${code}): ${stderr.slice(-400)}`));
      resolve(stdout);
    });
    child.stdin.end(input);
  });
}

const VAULT_ITEM = "IsItLegit Smoke token";

// `op` with the 1Password service account the operator's shell profile uses (its token file, read here, never printed).
function opEnv(): NodeJS.ProcessEnv {
  if (process.env.OP_SERVICE_ACCOUNT_TOKEN) return process.env;
  const file = join(homedir(), ".conclave/secrets/op-service-account-token.env");
  const token = /^OP_SERVICE_ACCOUNT_TOKEN=(.+)$/m.exec(readFileSync(file, "utf-8"))?.[1]?.trim();
  if (!token) throw new Error(`no OP_SERVICE_ACCOUNT_TOKEN in ${file}`);
  return { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token };
}

export async function activeVersionFromWrangler(deadline: number): Promise<string> {
  const status = JSON.parse(
    await runCommand("pnpm", ["exec", "wrangler", "deployments", "status", "--json"], "", deadline),
  );
  const live = (status.versions as { version_id: string; percentage: number }[]).find((v) => v.percentage === 100);
  if (!live) throw new Error("no version serves all traffic");
  return live.version_id;
}

export async function tokenFromVault(deadline: number): Promise<string> {
  const token = (
    await runCommand("op", ["read", `op://Conclave/${VAULT_ITEM}/credential`], "", deadline, opEnv())
  ).trim();
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error(`the vault item "${VAULT_ITEM}" holds no 64-hex token`);
  return token;
}

// A new token goes into the vault first (so it is never lost), then onto the Worker through `wrangler secret put` on
// standard input, which publishes the version answered.
async function rotateWithVault(deadline: number): Promise<{ token: string; version: string }> {
  const token = randomBytes(32).toString("hex");
  const env = opEnv();
  const item = JSON.parse(
    await runCommand("op", ["item", "get", VAULT_ITEM, "--vault", "Conclave", "--format", "json"], "", deadline, env),
  );
  const field = (item.fields as { id: string; value?: string }[]).find((f) => f.id === "credential");
  if (!field) throw new Error(`the vault item "${VAULT_ITEM}" has no credential field`);
  field.value = token;
  await runCommand(
    "op",
    ["item", "edit", VAULT_ITEM, "--vault", "Conclave", "--format", "json"],
    JSON.stringify(item),
    deadline,
    env,
  );
  await runCommand("pnpm", ["exec", "wrangler", "secret", "put", "SMOKE_TOKEN"], token, deadline);
  return { token, version: await activeVersionFromWrangler(deadline) };
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
  installSignalCleanup();
  try {
    const outcome = await runSmoke(base, {
      commit,
      getToken: tokenFromVault,
      activeVersion: activeVersionFromWrangler,
      ...(process.argv.includes("--rotate") ? { rotate: rotateWithVault } : {}),
      log: (line) => console.log(line),
    });
    for (const line of outcome.lines) console.log(line);
    process.exit(outcome.ok ? 0 : 1);
  } catch (error) {
    console.error(`smoke: ${(error as Error).message}`);
    process.exit(1);
  }
}
