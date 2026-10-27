// Rolls the live Worker back to a known-good version and proves it (D00 T01 §10). It reads the version serving all
// traffic from `wrangler deployments status` and the deployment history from `wrangler deployments list` (never from
// /health, which a broken version may not answer), each version's commit from `wrangler versions view` (`COMMIT_SHA`),
// and chooses the version named, or the newest earlier deployment's version whose commit differs from the active one
// and that no earlier run rolled away from (`build/rollback-rejected.json`). It refuses before changing anything when no
// version is eligible or the named one is gone (Cloudflare keeps the 100 most recent; then redeploy a known-good commit,
// docs/operations.md). After `wrangler rollback` it reads back the active version, checks /health and runs the smoke
// check for that commit, and reads back the active version again. It never touches D1, R2 or KV. Every command runs
// under one deadline with the smoke script's process-group cleanup, and any failure says whether the deployment changed.
//
//   node scripts/rollback.ts --reason "<why>" [--to <version id>]
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { activeVersionFromWrangler, installSignalCleanup, runCommand, runSmoke, WORKER_HOST } from "./smoke.ts";

export type Deployment = { created_on: string; versions: { version_id: string; percentage: number }[] };
export type Wrangler = {
  activeVersion: (deadline: number) => Promise<string>;
  // Oldest first, as `wrangler deployments list --json` answers.
  deployments: (deadline: number) => Promise<Deployment[]>;
  // The version's commit, or null when the version is gone.
  commitOf: (version: string, deadline: number) => Promise<string | null>;
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

function readRejected(file: string): Set<string> {
  if (!existsSync(file)) return new Set();
  return new Set(JSON.parse(readFileSync(file, "utf-8")) as string[]);
}

// Written to a temporary file and renamed, so an interrupted run never leaves a half-written list.
function writeRejected(file: string, versions: Set<string>): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify([...versions], null, 1)}\n`);
  renameSync(tmp, file);
}

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
  const deadline = Date.now() + waitMs;
  const lines: string[] = [];
  const refuse = (why: string): RollbackOutcome => ({
    ok: false,
    changed: "no",
    lines: [...lines, `rollback: ${why}`],
  });

  log("Reading the version serving all traffic and the deployment history...");
  const active = await wrangler.activeVersion(deadline);
  const activeCommit = await wrangler.commitOf(active, deadline);
  lines.push(`active: ${active} (commit ${activeCommit ?? "unknown"})`);
  const rejected = readRejected(rejectedFile);

  let chosen: string | undefined;
  let commit: string | null = null;
  if (target) {
    if (target === active) return refuse(`${target} already serves all traffic`);
    commit = await wrangler.commitOf(target, deadline);
    if (!commit)
      return refuse(
        `version ${target} is gone (Cloudflare keeps the 100 most recent); redeploy a known-good commit (docs/operations.md)`,
      );
    chosen = target;
  } else {
    const history = await wrangler.deployments(deadline);
    const seen = new Set<string>();
    for (const deployment of [...history].reverse()) {
      for (const { version_id: version } of deployment.versions) {
        if (seen.has(version) || version === active || rejected.has(version)) continue;
        seen.add(version);
        const candidate = await wrangler.commitOf(version, deadline);
        if (candidate && candidate !== activeCommit) {
          chosen = version;
          commit = candidate;
          break;
        }
      }
      if (chosen) break;
    }
    if (!chosen || !commit)
      return refuse(
        "no earlier version with another commit is left to roll back to; redeploy a known-good commit (docs/operations.md)",
      );
  }
  lines.push(`chosen: ${chosen} (commit ${commit})`);

  // Recorded before the rollback, so a retry after this run never chooses the version it is leaving.
  rejected.add(active);
  writeRejected(rejectedFile, rejected);

  let changed: RollbackOutcome["changed"] = "uncertain";
  try {
    log(`Rolling back to ${chosen} (commit ${commit})...`);
    await wrangler.rollback(chosen, reason, deadline);
    const now = await wrangler.activeVersion(deadline);
    changed = now === active ? "no" : "yes";
    if (now !== chosen)
      return { ok: false, changed, lines: [...lines, `rollback: ${now} serves all traffic, not ${chosen}`] };
    // A rollback takes seconds to reach every Cloudflare location; until then /health still answers the old commit, so
    // it is asked again until it reports the chosen commit or the deadline passes.
    log("Checking /health...");
    let health = await checks.health(deadline);
    while (("error" in health || health.commit !== commit) && Date.now() < deadline) {
      await pause(Math.min(2_000, deadline - Date.now()));
      health = await checks.health(deadline);
    }
    if ("error" in health)
      return { ok: false, changed, lines: [...lines, `rollback: /health gave no answer: ${health.error}`] };
    if (health.commit !== commit)
      return {
        ok: false,
        changed,
        lines: [...lines, `rollback: /health reports commit ${health.commit}, expected ${commit}`],
      };
    log("Running the smoke check...");
    const smoke = await checks.smoke(commit, deadline);
    lines.push(...smoke.lines);
    const after = await wrangler.activeVersion(deadline);
    if (after !== chosen)
      return {
        ok: false,
        changed,
        lines: [...lines, `rollback: ${after} serves all traffic after the checks, not ${chosen}`],
      };
    return {
      ok: smoke.ok,
      changed,
      lines: [...lines, smoke.ok ? `rolled back to ${chosen}, verified` : "rollback: the smoke check failed"],
    };
  } catch (error) {
    // Whether the deployment moved is read again where possible; a failed read leaves it uncertain.
    try {
      const now = await wrangler.activeVersion(Date.now() + 30_000);
      changed = now === active ? "no" : "yes";
      lines.push(`active after the failure: ${now}`);
    } catch {
      changed = "uncertain";
    }
    return { ok: false, changed, lines: [...lines, `rollback: ${(error as Error).message}`] };
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
    await wrangler(["rollback", version, "--message", message], deadline);
  },
};

const BASE = `https://${WORKER_HOST}`;

export const realChecks: Checks = {
  health: async (deadline) => {
    try {
      const response = await fetch(`${BASE}/health`, {
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      const body = (await response.json()) as { commit?: string };
      return response.ok && body.commit ? { commit: body.commit } : { error: `HTTP ${response.status}` };
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
  smoke: async (commit, deadline) => {
    const smoke = await import("./smoke.ts");
    return runSmoke(BASE, {
      commit,
      getToken: smoke.tokenFromVault,
      activeVersion: activeVersionFromWrangler,
      waitMs: Math.max(1_000, deadline - Date.now()),
      log: (line) => console.log(`  ${line}`),
    });
  },
};

if (import.meta.filename === process.argv[1]) {
  const at = (flag: string) => {
    const i = process.argv.indexOf(flag);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const reason = at("--reason");
  if (!reason) {
    console.error('rollback: give the reason, --reason "<why>"');
    process.exit(2);
  }
  installSignalCleanup();
  registerInterruptNotice();
  const outcome = await runRollback({
    reason,
    ...(at("--to") ? { target: at("--to") as string } : {}),
    wrangler: realWrangler,
    checks: realChecks,
    rejectedFile: join(process.cwd(), "build/rollback-rejected.json"),
    log: (line) => console.log(line),
  });
  for (const line of outcome.lines) console.log(line);
  console.log(`deployment changed: ${outcome.changed}`);
  process.exit(outcome.ok ? 0 : 1);
}
