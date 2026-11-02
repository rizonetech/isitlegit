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
import { parseArgs } from "node:util";

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
export async function withProgress<T>(what: string, log: (line: string) => void, work: () => Promise<T>): Promise<T> {
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

// The two hosts that serve the IsItLegit Worker: its workers.dev address in Rizonetech's account (the subdomain is the
// account's, so `isitlegit.<other>.workers.dev` is someone else's Worker) and its custom domain (D07 T06 §9). Nothing
// else on the zone is the Worker: the apex and `www` are the marketing site (D07 T06 §6), and any other name could be
// pointed elsewhere.
export const WORKER_HOST = "isitlegit.derick-f5a.workers.dev";
export const APP_HOST = "app.isitlegit.co.za";

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
  if (host !== WORKER_HOST && host !== APP_HOST)
    return `${host} is not the IsItLegit Worker (${WORKER_HOST} or ${APP_HOST})`;
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
  // One budget for the whole run: the checks stop at `deadline`, which keeps back time for the last read of the
  // active version, so even a stalled read ends by `start + waitMs`.
  const deadline = start + waitMs - Math.min(30_000, waitMs / 4);
  const lines: string[] = [];
  let token: string;
  let version: string;
  try {
    ({ token, version } = rotate
      ? await withProgress("Rotating SMOKE_TOKEN (Cloudflare publishes a new version)", log, () => rotate(deadline))
      : await withProgress("Reading the smoke token and the version serving all traffic", log, async () => ({
          token: await getToken(deadline),
          version: await activeVersion(deadline),
        })));
  } catch (error) {
    return { ok: false, lines: [`smoke: ${(error as Error).message}`, `failed in ${seconds(start)}`] };
  }
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
        // Any answer from another version (a 503 from the broken one being left, say) means the change has not
        // reached this location yet.
        if (body.version && body.version !== version) {
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
    after = await activeVersion(start + waitMs);
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
export function installSignalCleanup(name = "smoke"): void {
  // SIGHUP too: a closed terminal or SSH session reaches this process but not the commands' own groups.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(signal, () => {
      for (const pid of running) killGroup(pid);
      console.error(`${name}: interrupted (${signal}); stopped ${running.size} running command(s)`);
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
    // A command may finish without reading its input; the broken pipe that leaves is not a failure (the exit code
    // decides), and unhandled it would end this whole process.
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(input);
  });
}

const VAULT_ITEM = "IsItLegit Smoke token";

// The operator's 1Password wrapper: it loads the service account's token from its file after checking the file's
// owner and mode, then runs `op`, so this script never reads or passes the token itself.
const OP = "conclave-op";

export type Runner = (
  command: string,
  args: string[],
  input: string,
  deadline: number,
  env?: NodeJS.ProcessEnv,
) => Promise<string>;

async function activeVersionWith(run: Runner, deadline: number): Promise<string> {
  const status = JSON.parse(await run("pnpm", ["exec", "wrangler", "deployments", "status", "--json"], "", deadline));
  const live = (status.versions as { version_id: string; percentage: number }[]).find((v) => v.percentage === 100);
  if (!live) throw new Error("no version serves all traffic");
  return live.version_id;
}

// The newest version uploaded (the highest number), which `wrangler secret put` builds on.
async function newestVersionWith(run: Runner, deadline: number): Promise<string> {
  const versions = JSON.parse(await run("pnpm", ["exec", "wrangler", "versions", "list", "--json"], "", deadline)) as {
    id: string;
    number: number;
  }[];
  const newest = versions.reduce(
    (a, b) => (b.number > a.number ? b : a),
    versions[0] as { id: string; number: number },
  );
  if (!newest) throw new Error("the Worker has no versions");
  return newest.id;
}

export const activeVersionFromWrangler = (deadline: number) => activeVersionWith(runCommand, deadline);

// One fixture page screened through the deployed Worker itself (D03 T04 §36): reads the SCREEN check a release
// asked for (`?screen=1`) and answers which screener and Loupe version served it, or throws naming what came back.
export async function screenThroughWorker(
  base: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<{ screener: string; version: string }> {
  const url = new URL("/internal/smoke?screen=1", base);
  const response = await fetcher(url, { headers: { authorization: `Bearer ${token}` } });
  const body = (await response.json().catch(() => null)) as { checks?: Record<string, string> } | null;
  const screen = body?.checks?.SCREEN;
  const matched = /^ok (\S+) (\S+)$/.exec(screen ?? "");
  if (!matched) throw new Error(`the deployed Worker's SCREEN check did not pass (${screen ?? "absent"})`);
  return { screener: matched[1] as string, version: matched[2] as string };
}

export async function tokenFromVault(deadline: number): Promise<string> {
  const token = (await runCommand(OP, ["read", `op://Conclave/${VAULT_ITEM}/credential`], "", deadline)).trim();
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error(`the vault item "${VAULT_ITEM}" holds no 64-hex token`);
  return token;
}

// A new token goes into the vault first (so it is never lost), then onto the Worker through `wrangler secret put` on
// standard input, which publishes the version answered. If the Worker step fails or is interrupted, the vault holds a
// token the Worker does not: running `--rotate` again reconciles them, and its smoke run proves it.
// WORKAROUND: `op` reads an item template from standard input only when that is a pipe, and Node gives a child a
// socket, so `op item edit` given the template that way silently changes nothing. `cat` hands it on through a real pipe;
// the value stays in memory and off the command line.
function opWithInput(args: string[]): [string, string[]] {
  return ["sh", ["-c", `cat | exec ${OP} "$@"`, "sh", ...args]];
}

export function rotateWith(run: Runner) {
  return async (deadline: number): Promise<{ token: string; version: string }> => {
    // Wrangler refuses to set a secret while the version serving is not the newest (a rollback is in effect), so that
    // is checked before the vault changes: a refusal then leaves the vault and the Worker agreeing.
    const [active, newest] = [await activeVersionWith(run, deadline), await newestVersionWith(run, deadline)];
    if (active !== newest)
      throw new Error(
        `a rollback is in effect (${active} serves, the newest version is ${newest}), and Cloudflare sets secrets only ` +
          "on the newest; nothing was changed: rotate once a good commit is deployed again (docs/operations.md)",
      );
    const token = randomBytes(32).toString("hex");
    const item = JSON.parse(
      await run(OP, ["item", "get", VAULT_ITEM, "--vault", "Conclave", "--format", "json"], "", deadline),
    );
    const field = (item.fields as { id: string; value?: string }[]).find((f) => f.id === "credential");
    if (!field) throw new Error(`the vault item "${VAULT_ITEM}" has no credential field`);
    const old = field.value ?? "";
    field.value = token;
    await run(
      ...opWithInput(["item", "edit", VAULT_ITEM, "--vault", "Conclave", "--format", "json"]),
      JSON.stringify(item),
      deadline,
    );
    // Read back before the Worker changes: a vault that did not take the token must stop the rotation here, while the
    // two still agree.
    const stored = (await run(OP, ["read", `op://Conclave/${VAULT_ITEM}/credential`], "", deadline)).trim();
    if (stored !== token) throw new Error("the vault did not take the new token; the Worker was not changed");
    try {
      await run("pnpm", ["exec", "wrangler", "secret", "put", "SMOKE_TOKEN"], token, deadline);
    } catch (error) {
      // A failed command does not prove the secret failed: Cloudflare may have published it before the answer was
      // lost. A new newest version means it landed (the smoke run that follows then checks it with the new token); no
      // new version means the Worker kept the old token, so the vault goes back to it; no answer leaves it uncertain.
      const why = (error as Error).message;
      let landed: boolean | undefined;
      try {
        landed = (await newestVersionWith(run, deadline)) !== newest;
      } catch {
        landed = undefined;
      }
      if (landed) return { token, version: await activeVersionWith(run, deadline) };
      if (landed === undefined)
        throw new Error(
          `could not tell whether the Worker took the new token (${why}); the vault holds the new one, and plain smoke ` +
            "runs fail if the Worker does not: run `--rotate` again (docs/operations.md)",
        );
      let restored = false;
      try {
        field.value = old;
        await run(
          ...opWithInput(["item", "edit", VAULT_ITEM, "--vault", "Conclave", "--format", "json"]),
          JSON.stringify(item),
          deadline,
        );
        restored = (await run(OP, ["read", `op://Conclave/${VAULT_ITEM}/credential`], "", deadline)).trim() === old;
      } catch {
        // restored stays false
      }
      if (restored)
        throw new Error(
          `the Worker did not take the new token (${why}); the vault was put back to the old one, so nothing changed`,
        );
      throw new Error(
        `the vault has the new token but the Worker did not take it (${why}), and putting the old token back failed; ` +
          "plain smoke runs will fail until `--rotate` runs again and passes (docs/operations.md)",
      );
    }
    return { token, version: await activeVersionWith(run, deadline) };
  };
}

const rotateWithVault = rotateWith(runCommand);

// The command line, checked whole before anything runs: an unknown flag or a flag without its value is refused.
export function parseSmokeArgs(argv: string[]): { base: string; commit?: string; rotate: boolean } {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { commit: { type: "string" }, rotate: { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length !== 1) throw new Error("give exactly one deployed Worker URL");
  if (values.commit !== undefined && !/^[0-9a-f]{40}$/.test(values.commit))
    throw new Error("--commit needs a full 40-hex commit");
  return { base: positionals[0] as string, rotate: values.rotate, ...(values.commit ? { commit: values.commit } : {}) };
}

if (import.meta.filename === process.argv[1]) {
  let args: ReturnType<typeof parseSmokeArgs>;
  try {
    args = parseSmokeArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`smoke: ${(error as Error).message}`);
    process.exit(2);
  }
  const { base, rotate } = args;
  const commit = args.commit ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  installSignalCleanup();
  try {
    const outcome = await runSmoke(base, {
      commit,
      getToken: tokenFromVault,
      activeVersion: activeVersionFromWrangler,
      ...(rotate ? { rotate: rotateWithVault } : {}),
      log: (line) => console.log(line),
    });
    for (const line of outcome.lines) console.log(line);
    process.exit(outcome.ok ? 0 : 1);
  } catch (error) {
    console.error(`smoke: ${(error as Error).message}`);
    process.exit(1);
  }
}
