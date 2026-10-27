// Rolls the live Worker back to a known-good version and proves it (D00 T01 §10). It reads the version serving all
// traffic from `wrangler deployments status` and the deployment history from `wrangler deployments list` (never from
// /health, which a broken version may not answer), each version's commit from `wrangler versions view` (`COMMIT_SHA`),
// and chooses the version named, or the newest earlier deployment's version whose commit differs from the active one
// and that no earlier run rolled away from, by version or by commit (`build/rollback-rejected.json`). It refuses before
// changing anything when no version is eligible, the named one is gone (Cloudflare keeps the 100 most recent; then
// redeploy a known-good commit, docs/operations.md), or a secret changed since the target was deployed: the deployment
// goes to Cloudflare's API without `force`, so Cloudflare refuses rather than restore old secret values (Wrangler's own
// `rollback` says yes to that on its own when it runs unattended). After the change it reads back the active version,
// waits for /health to report the chosen commit, runs the smoke check, and reads back the active version again. It
// never touches D1, R2 or KV. One deadline bounds the whole run, keeping back time to report, and every outcome,
// failures and Ctrl+C included, says whether the deployment changed.
//
//   node scripts/rollback.ts --reason "<why>" [--to <version id>]
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  activeVersionFromWrangler,
  installSignalCleanup,
  runCommand,
  runSmoke,
  tokenFromVault,
  WORKER_HOST,
  withProgress,
} from "./smoke.ts";

export type Deployment = { created_on: string; versions: { version_id: string; percentage: number }[] };
export type Wrangler = {
  activeVersion: (deadline: number) => Promise<string>;
  // Oldest first, as `wrangler deployments list --json` answers.
  deployments: (deadline: number) => Promise<Deployment[]>;
  // The version's commit, or null when the version is gone.
  commitOf: (version: string, deadline: number) => Promise<string | null>;
  // Puts the version on 100% of traffic; throws SecretsChanged when Cloudflare refuses because secrets differ.
  rollback: (version: string, message: string, deadline: number) => Promise<void>;
};
export type Checks = {
  // The commit /health reports, or the reason it did not answer.
  health: (deadline: number) => Promise<{ commit: string } | { error: string }>;
  smoke: (commit: string, deadline: number) => Promise<{ ok: boolean; lines: string[] }>;
};
export type RollbackOptions = {
  reason: string;
  target?: string;
  wrangler: Wrangler;
  checks: Checks;
  rejectedFile: string;
  waitMs?: number;
  log?: (line: string) => void;
  pause?: (ms: number) => Promise<unknown>;
};
export type RollbackOutcome = { ok: boolean; changed: "no" | "yes" | "uncertain"; lines: string[] };

export class SecretsChanged extends Error {
  readonly secrets: string[];
  constructor(secrets: string[]) {
    super(`secrets changed since that version was deployed: ${secrets.join(", ")}`);
    this.secrets = secrets;
  }
}

// Versions and commits earlier runs rolled away from. A missing file is an empty list; a damaged one is refused, since
// guessing could send a retry back to a broken version.
type Rejected = { versions: string[]; commits: string[] };

function readRejected(file: string): Rejected {
  if (!existsSync(file)) return { versions: [], commits: [] };
  const data = JSON.parse(readFileSync(file, "utf-8")) as Partial<Rejected>;
  if (!Array.isArray(data.versions) || !Array.isArray(data.commits))
    throw new Error(`${file} is not a rejected-versions record; fix or delete it (docs/operations.md)`);
  return { versions: data.versions, commits: data.commits };
}

// Written to a temporary file and renamed, so an interrupted run never leaves a half-written list.
function writeRejected(file: string, rejected: Rejected): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rejected, null, 1)}\n`);
  renameSync(tmp, file);
}

const seconds = (start: number) => `${Math.round((Date.now() - start) / 1000)} s`;

export async function runRollback(options: RollbackOptions): Promise<RollbackOutcome> {
  const {
    reason,
    target,
    wrangler,
    checks,
    rejectedFile,
    waitMs = 240_000,
    log = () => {},
    pause = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = options;
  const start = Date.now();
  const end = start + waitMs;
  // The work stops here; the rest of the budget is kept for reading back the deployment after a failure.
  const deadline = end - Math.min(30_000, waitMs / 4);
  const lines: string[] = [];
  const finish = (ok: boolean, changed: RollbackOutcome["changed"], last: string): RollbackOutcome => ({
    ok,
    changed,
    lines: [...lines, last, `rollback ${ok ? "finished" : "stopped"} in ${seconds(start)}`],
  });

  // Until the deployment call is made nothing has changed, whatever fails.
  let active = "";
  let chosen: string | undefined;
  let commit: string | null = null;
  let rejected: Rejected;
  try {
    rejected = readRejected(rejectedFile);
    const activeCommit = await withProgress("Reading the version serving all traffic", log, async () => {
      active = await wrangler.activeVersion(deadline);
      return wrangler.commitOf(active, deadline);
    });
    lines.push(`active: ${active} (commit ${activeCommit ?? "unknown"})`);
    if (target) {
      if (target === active) return finish(false, "no", `rollback: ${target} already serves all traffic`);
      commit = await wrangler.commitOf(target, deadline);
      if (!commit)
        return finish(
          false,
          "no",
          `rollback: version ${target} is gone (Cloudflare keeps the 100 most recent); redeploy a known-good commit (docs/operations.md)`,
        );
      chosen = target;
    } else {
      await withProgress("Choosing a version from the deployment history", log, async () => {
        const history = await wrangler.deployments(deadline);
        const seen = new Set<string>();
        for (const deployment of [...history].reverse()) {
          for (const { version_id: version } of deployment.versions) {
            if (seen.has(version) || version === active || rejected.versions.includes(version)) continue;
            seen.add(version);
            const candidate = await wrangler.commitOf(version, deadline);
            if (candidate && candidate !== activeCommit && !rejected.commits.includes(candidate)) {
              chosen = version;
              commit = candidate;
              return;
            }
          }
        }
      });
      if (!chosen || !commit)
        return finish(
          false,
          "no",
          "rollback: no earlier version with another commit is left to roll back to; redeploy a known-good commit (docs/operations.md)",
        );
    }
    lines.push(`chosen: ${chosen} (commit ${commit})`);
    // Recorded before the rollback, so a retry after this run never goes back to the code it is leaving.
    writeRejected(rejectedFile, {
      versions: [...new Set([...rejected.versions, active])],
      commits: activeCommit ? [...new Set([...rejected.commits, activeCommit])] : rejected.commits,
    });
  } catch (error) {
    return finish(false, "no", `rollback: ${(error as Error).message}`);
  }

  const version = chosen as string;
  const expected = commit as string;
  try {
    await withProgress(`Rolling back to ${version} (commit ${expected})`, log, () =>
      wrangler.rollback(version, reason, deadline),
    );
    const now = await wrangler.activeVersion(deadline);
    const changed = now === active ? "no" : "yes";
    if (now !== version) return finish(false, changed, `rollback: ${now} serves all traffic, not ${version}`);
    // A rollback takes seconds to reach every Cloudflare location; until then /health still answers the old commit, so
    // it is asked again until it reports the chosen commit or the deadline passes.
    const health = await withProgress("Waiting for /health to report the chosen commit", log, async () => {
      let answer = await checks.health(deadline);
      while (("error" in answer || answer.commit !== expected) && Date.now() < deadline) {
        log(`  /health: ${"error" in answer ? answer.error : `commit ${answer.commit}`}`);
        await pause(Math.min(2_000, deadline - Date.now()));
        answer = await checks.health(deadline);
      }
      return answer;
    });
    if ("error" in health) return finish(false, changed, `rollback: /health gave no answer: ${health.error}`);
    if (health.commit !== expected)
      return finish(false, changed, `rollback: /health reports commit ${health.commit}, expected ${expected}`);
    log("Running the smoke check...");
    const smoke = await checks.smoke(expected, deadline);
    lines.push(...smoke.lines);
    const after = await wrangler.activeVersion(end);
    if (after !== version)
      return finish(false, changed, `rollback: ${after} serves all traffic after the checks, not ${version}`);
    return smoke.ok
      ? finish(true, changed, `rolled back to ${version}, verified`)
      : finish(false, changed, "rollback: the smoke check failed");
  } catch (error) {
    // Whether the deployment moved is read again inside the kept time; a failed read leaves it uncertain.
    let changed: RollbackOutcome["changed"] = "uncertain";
    try {
      const now = await wrangler.activeVersion(end);
      changed = now === active ? "no" : "yes";
      lines.push(`active after the failure: ${now}`);
    } catch {
      // stays uncertain
    }
    const message =
      error instanceof SecretsChanged
        ? `Cloudflare refused: ${error.message}, and rolling back would restore their old values; redeploy a known-good commit instead (docs/operations.md)`
        : (error as Error).message;
    return finish(false, changed, `rollback: ${message}`);
  }
}

// Said on Ctrl+C, a termination signal or a hangup, before the smoke script's cleanup stops the commands: an
// interrupted run cannot know whether its rollback landed.
export function registerInterruptNotice(): void {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.prependOnceListener(signal, () =>
      console.error(
        "rollback: interrupted; whether the deployment changed is uncertain: check `wrangler deployments status`",
      ),
    );
}

// The command line, checked whole before anything runs: an unknown flag, a flag without its value or a stray word is
// refused, so a mistyped `--to` can never become a default rollback.
export function parseRollbackArgs(argv: string[]): { reason: string; target?: string } {
  const { values } = parseArgs({
    args: argv,
    options: { reason: { type: "string" }, to: { type: "string" } },
    strict: true,
    allowPositionals: false,
  });
  if (!values.reason?.trim()) throw new Error('give the reason, --reason "<why>"');
  if (values.to !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(values.to))
    throw new Error(`--to needs a version id, got "${values.to}"`);
  return { reason: values.reason, ...(values.to ? { target: values.to } : {}) };
}

const ACCOUNT_ID = "f5a529987f8dc7d52ce7aba3da25e226";
const WORKER_NAME = "isitlegit";

// One deployment of `version` at 100%, through Cloudflare's API without `force`: Cloudflare answers error 10220 when a
// secret changed since that version was deployed, and that becomes SecretsChanged instead of a silent yes.
export async function deployVersion(
  api: string,
  token: string,
  version: string,
  message: string,
  deadline: number,
): Promise<void> {
  const response = await fetch(`${api}/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/deployments`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      strategy: "percentage",
      versions: [{ version_id: version, percentage: 100 }],
      annotations: { "workers/message": message.slice(0, 100) },
    }),
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
  });
  const body = (await response.json()) as { success?: boolean; errors?: { code: number; message: string }[] };
  if (response.ok && body.success) return;
  const errors = body.errors ?? [];
  const secrets = errors.find((e) => e.code === 10220);
  if (secrets) {
    const named = secrets.message.split("The following secrets have changed:")[1] ?? "";
    throw new SecretsChanged(
      named
        .replace(/\s*\[code: \d+\]\s*$/, "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    );
  }
  throw new Error(
    `Cloudflare refused the deployment: HTTP ${response.status} ${errors.map((e) => `${e.code} ${e.message}`).join("; ")}`,
  );
}

const wrangler = (args: string[], deadline: number) => runCommand("pnpm", ["exec", "wrangler", ...args], "", deadline);

export const realWrangler: Wrangler = {
  activeVersion: activeVersionFromWrangler,
  deployments: async (deadline) => JSON.parse(await wrangler(["deployments", "list", "--json"], deadline)),
  commitOf: async (version, deadline) => {
    try {
      const view = JSON.parse(await wrangler(["versions", "view", version, "--json"], deadline));
      const binding = (view.resources?.bindings ?? []).find((b: { name: string }) => b.name === "COMMIT_SHA");
      return binding?.text ?? null;
    } catch (error) {
      if (/not found|10007|does not exist/i.test((error as Error).message)) return null;
      throw error;
    }
  },
  rollback: async (version, message, deadline) => {
    // Wrangler's login token, read here and never printed.
    const { token } = JSON.parse(await wrangler(["auth", "token", "--json"], deadline)) as { token: string };
    await deployVersion("https://api.cloudflare.com/client/v4", token, version, message, deadline);
  },
};

export function checksFor(base: string): Checks {
  return {
    health: async (deadline) => {
      try {
        // The signal bounds the headers and the body alike.
        const response = await fetch(`${base}/health`, {
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });
        const body = (await response.json()) as { commit?: string };
        return response.ok && body.commit ? { commit: body.commit } : { error: `HTTP ${response.status}` };
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
    smoke: async (commit, deadline) =>
      runSmoke(base, {
        commit,
        getToken: tokenFromVault,
        activeVersion: activeVersionFromWrangler,
        waitMs: Math.max(1_000, deadline - Date.now()),
        log: (line) => console.log(`  ${line}`),
      }),
  };
}

if (import.meta.filename === process.argv[1]) {
  let args: ReturnType<typeof parseRollbackArgs>;
  try {
    args = parseRollbackArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`rollback: ${(error as Error).message}`);
    console.error("deployment changed: no");
    process.exit(2);
  }
  installSignalCleanup();
  registerInterruptNotice();
  const outcome = await runRollback({
    ...args,
    wrangler: realWrangler,
    checks: checksFor(`https://${WORKER_HOST}`),
    rejectedFile: join(process.cwd(), "build/rollback-rejected.json"),
    log: (line) => console.log(line),
  });
  for (const line of outcome.lines) console.log(line);
  console.log(`deployment changed: ${outcome.changed}`);
  process.exit(outcome.ok ? 0 : 1);
}
