// Rolls the live Worker back to a known-good version and proves it (D00 T01 §10, §12). It reads the versions serving
// traffic from `wrangler deployments status` (a split deployment needs `--to`; whether anything changed is judged on
// the whole deployment) and the deployment history from `wrangler deployments list` (never from
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
  // Every version serving traffic and its percentage, from `wrangler deployments status`.
  deployment: (deadline: number) => Promise<Serving>;
  // Oldest first, as `wrangler deployments list --json` answers.
  deployments: (deadline: number) => Promise<Deployment[]>;
  // The version's commit (null when it carries none) and its upload number, or null when the version is gone.
  view: (version: string, deadline: number) => Promise<{ commit: string | null; number: number } | null>;
  // Puts the version on 100% of traffic; throws SecretsChanged when Cloudflare refuses because secrets differ.
  rollback: (version: string, message: string, deadline: number) => Promise<void>;
};
export type Checks = {
  // The commit /health reports, or the reason it did not answer.
  health: (deadline: number) => Promise<{ commit: string } | { error: string }>;
  // Pinned to `version`: the smoke run fails if another version serves while it checks.
  smoke: (commit: string, version: string, deadline: number) => Promise<{ ok: boolean; lines: string[] }>;
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
  // Whether commit `older` is an ancestor of `newer` (git); false when either is unknown. A roll-forward is a target
  // whose code descends from every serving version's, not merely a later upload.
  isAncestor?: (older: string, newer: string) => Promise<boolean>;
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
  const strings = (list: unknown): list is string[] =>
    Array.isArray(list) && list.every((item) => typeof item === "string" && item !== "");
  if (!strings(data.versions) || !strings(data.commits))
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

// The deployment as served: every version and its share of traffic. One version at 100% is the usual case; a gradual
// deployment splits traffic between two.
// A version listed at 0% serves nothing and is left out, as `scripts/smoke.ts` reads it.
export type Serving = { version_id: string; percentage: number }[];
const live = (serving: Serving) => serving.filter((v) => v.percentage > 0);
const single = (serving: Serving) => {
  const serving_ = live(serving);
  return serving_.length === 1 && serving_[0]?.percentage === 100 ? (serving_[0].version_id as string) : null;
};
const describe = (serving: Serving) =>
  single(serving) ??
  live(serving)
    .map((v) => `${v.version_id} ${v.percentage}%`)
    .join(", ");
// A status answer that is not a whole deployment (no serving version, shares that do not add up to 100%, a missing id)
// is refused rather than read as one.
function checked(serving: Serving): Serving {
  const valid =
    Array.isArray(serving) &&
    serving.every(
      (v) =>
        typeof v?.version_id === "string" &&
        v.version_id &&
        typeof v.percentage === "number" &&
        v.percentage >= 0 &&
        v.percentage <= 100,
    ) &&
    live(serving).length > 0 &&
    Math.abs(serving.reduce((sum, v) => sum + v.percentage, 0) - 100) < 0.001;
  if (!valid) throw new Error(`the deployment status is not a whole deployment: ${JSON.stringify(serving)}`);
  return serving;
}
const sameDeployment = (a: Serving, b: Serving) => {
  const key = (s: Serving) =>
    live(s)
      .map((v) => `${v.version_id}@${v.percentage}`)
      .sort()
      .join(",");
  return key(a) === key(b);
};

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
    isAncestor = async () => false,
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
  let before: Serving = [];
  let chosen: string | undefined;
  let commit: string | null = null;
  let rejected: Rejected = { versions: [], commits: [] };
  let clearOnSuccess = false;
  try {
    rejected = readRejected(rejectedFile);
    const views = await withProgress("Reading the versions serving traffic", log, async () => {
      before = checked(await wrangler.deployment(deadline));
      return Promise.all(before.map((v) => wrangler.view(v.version_id, deadline)));
    });
    const active = single(before);
    const servingCommits = views.map((v) => v?.commit ?? null);
    // The active version's own commit, found by its id: a version listed at 0% may come first.
    const activeCommit = active ? (servingCommits[before.findIndex((v) => v.version_id === active)] ?? null) : null;
    lines.push(
      active
        ? `active: ${active} (commit ${activeCommit ?? "unknown"})`
        : `split: ${before.map((v, i) => `${v.version_id} ${v.percentage}% (commit ${servingCommits[i] ?? "unknown"})`).join(", ")}`,
    );
    let forward = false;
    if (target) {
      if (target === active) return finish(false, "no", `rollback: ${target} already serves all traffic`);
      const targetView = await wrangler.view(target, deadline);
      commit = targetView?.commit ?? null;
      if (!targetView)
        return finish(
          false,
          "no",
          `rollback: version ${target} is gone (Cloudflare keeps the 100 most recent); redeploy a known-good commit (docs/operations.md)`,
        );
      if (!commit)
        return finish(
          false,
          "no",
          `rollback: version ${target} carries no COMMIT_SHA, so /health and the smoke check cannot prove it; redeploy a known-good commit (docs/operations.md)`,
        );
      // A roll-forward is a target whose code descends from every serving version's: what it leaves is not judged
      // broken. Unknown commits, or the same commit, count as a rollback, which records.
      const targetCommit = commit;
      const servingLive = before.map((v, i) => ({ v, commit: servingCommits[i] })).filter(({ v }) => v.percentage > 0);
      forward =
        servingLive.every(({ commit: c }) => !!c && c !== targetCommit) &&
        (await Promise.all(servingLive.map(({ commit: c }) => isAncestor(c as string, targetCommit)))).every(Boolean);
      chosen = target;
    } else {
      if (!active)
        return finish(
          false,
          "no",
          `rollback: a split deployment serves (${describe(before)}); name the version to restore with --to (docs/operations.md)`,
        );
      await withProgress("Choosing a version from the deployment history", log, async () => {
        const history = await wrangler.deployments(deadline);
        const seen = new Set<string>();
        for (const deployment of [...history].reverse()) {
          for (const { version_id: version } of deployment.versions) {
            if (seen.has(version) || version === active || rejected.versions.includes(version)) continue;
            seen.add(version);
            const candidate = (await wrangler.view(version, deadline))?.commit;
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
    // The deployment is read again just before anything is written or deployed: one that changed while this run was
    // choosing (another operator's deploy) is refused, so a split never reaches the call and nothing goes unrecorded.
    const again = checked(await wrangler.deployment(deadline));
    if (!sameDeployment(again, before))
      return finish(
        false,
        "no",
        `rollback: the deployment changed while this run was preparing (${describe(before)}, now ${describe(again)}); this run changed nothing: read it and run again`,
      );
    // A rollback records, before the call, every serving version other than the target with its commit (unless it is
    // the target's), so a retry never goes back to the code it is leaving. A roll-forward records nothing now and
    // clears its target only once the target is verified.
    const goingTo = chosen as string;
    const left = live(before)
      .map((v) => ({ version: v.version_id, commit: servingCommits[before.indexOf(v)] }))
      .filter((v) => v.version !== goingTo);
    if (!forward)
      writeRejected(rejectedFile, {
        versions: [...new Set([...rejected.versions, ...left.map((v) => v.version)])],
        commits: [
          ...new Set([
            ...rejected.commits,
            ...left.map((v) => v.commit).filter((c): c is string => !!c && c !== commit),
          ]),
        ],
      });
    clearOnSuccess = forward;
    lines.push(
      forward
        ? `recorded: nothing (a roll-forward); ${goingTo} is cleared from ${rejectedFile} once verified`
        : `recorded: ${left
            .map((v) =>
              v.commit && v.commit === commit
                ? `${v.version} (its commit is the target's, so only the version)`
                : `${v.version} (commit ${v.commit ?? "unknown"})`,
            )
            .join(", ")} as rolled away from, in ${rejectedFile}; delete it once a good deploy is live`,
    );
  } catch (error) {
    return finish(false, "no", `rollback: ${(error as Error).message}`);
  }

  const version = chosen as string;
  const expected = commit as string;
  // What serves now against what served before: the same deployment is `no`, any other is `yes`.
  const changedSince = (now: Serving) => (sameDeployment(now, before) ? "no" : "yes");
  const notTarget = (now: Serving) =>
    single(now)
      ? `${single(now)} serves all traffic, not ${version}`
      : `the deployment is split (${describe(now)}), not ${version} at 100%`;
  try {
    await withProgress(`Rolling back to ${version} (commit ${expected})`, log, () =>
      wrangler.rollback(version, reason, deadline),
    );
    const now = await wrangler.deployment(deadline);
    const changed = changedSince(now);
    if (single(now) !== version) return finish(false, changed, `rollback: ${notTarget(now)}`);
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
    // Every later exit reports the deployment as it now reads against what served before, since something else may
    // have changed it meanwhile (an unreadable deployment is uncertain).
    const settle = async (ok: boolean, last: string) => {
      let latest: RollbackOutcome["changed"] = "uncertain";
      try {
        latest = changedSince(await wrangler.deployment(end));
      } catch {
        // stays uncertain
      }
      return finish(ok, latest, last);
    };
    if ("error" in health) return settle(false, `rollback: /health gave no answer: ${health.error}`);
    if (health.commit !== expected)
      return settle(false, `rollback: /health reports commit ${health.commit}, expected ${expected}`);
    log("Running the smoke check...");
    const smoke = await checks.smoke(expected, version, deadline);
    lines.push(...smoke.lines);
    let after: Serving;
    try {
      after = await wrangler.deployment(end);
    } catch (error) {
      return finish(
        false,
        "uncertain",
        `rollback: the deployment could not be read after the checks: ${(error as Error).message}`,
      );
    }
    if (single(after) !== version)
      return finish(false, changedSince(after), `rollback: after the checks, ${notTarget(after)}`);
    if (smoke.ok && clearOnSuccess) {
      const current = readRejected(rejectedFile);
      writeRejected(rejectedFile, {
        versions: current.versions.filter((v) => v !== version),
        commits: current.commits.filter((c) => c !== expected),
      });
      lines.push(`cleared: ${version} (commit ${expected}) from ${rejectedFile}`);
    }
    return smoke.ok
      ? finish(true, changedSince(after), `rolled back to ${version}, verified`)
      : finish(false, changedSince(after), "rollback: the smoke check failed");
  } catch (error) {
    // Whether the deployment moved is read again inside the kept time; a failed read leaves it uncertain.
    let changed: RollbackOutcome["changed"] = "uncertain";
    try {
      const now = await wrangler.deployment(end);
      changed = changedSince(now);
      lines.push(`active after the failure: ${describe(now)}`);
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
export const USAGE = `node scripts/rollback.ts --reason "<why>" [--to <version id>]

Rolls the live Worker back and verifies it (docs/operations.md).
  --reason "<why>"     required; recorded on the deployment
  --to <version id>    the version to put on 100% of traffic; without it, the newest earlier version with
                       another commit that no earlier run rolled away from
  --help               this text

See what serves first:  pnpm exec wrangler deployments status
A split deployment (two versions sharing traffic) is never guessed at: name the version to keep with --to.
A rollback across changed secrets is refused; redeploy a known-good commit instead (docs/operations.md).
It ends with "deployment changed: no | yes | uncertain"; when uncertain, read wrangler deployments status.`;

export function parseRollbackArgs(argv: string[]): { reason: string; target?: string } | { help: true } {
  const { values } = parseArgs({
    args: argv,
    options: { reason: { type: "string" }, to: { type: "string" }, help: { type: "boolean", short: "h" } },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) return { help: true };
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
  deployment: async (deadline) =>
    (JSON.parse(await wrangler(["deployments", "status", "--json"], deadline)) as { versions: Serving }).versions.map(
      ({ version_id, percentage }) => ({ version_id, percentage }),
    ),
  deployments: async (deadline) => JSON.parse(await wrangler(["deployments", "list", "--json"], deadline)),
  view: async (version, deadline) => {
    try {
      const view = JSON.parse(await wrangler(["versions", "view", version, "--json"], deadline));
      const binding = (view.resources?.bindings ?? []).find((b: { name: string }) => b.name === "COMMIT_SHA");
      return { commit: binding?.text ?? null, number: view.number as number };
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
    smoke: async (commit, version, deadline) =>
      runSmoke(base, {
        commit,
        getToken: tokenFromVault,
        // Read at the start and the end of the run: any other version serving then fails the check.
        activeVersion: async (by) => {
          const serving = await activeVersionFromWrangler(by);
          if (serving !== version) throw new Error(`${serving} serves, not ${version}`);
          return serving;
        },
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
  if ("help" in args) {
    console.log(USAGE);
    process.exit(0);
  }
  installSignalCleanup();
  registerInterruptNotice();
  const outcome = await runRollback({
    ...args,
    wrangler: realWrangler,
    checks: checksFor(`https://${WORKER_HOST}`),
    // The checkout's own build/, wherever the script is run from; ROLLBACK_RECORD points elsewhere (the tests).
    rejectedFile: process.env.ROLLBACK_RECORD ?? join(import.meta.dirname, "../build/rollback-rejected.json"),
    isAncestor: (older, newer) =>
      runCommand(
        "git",
        ["-C", join(import.meta.dirname, ".."), "merge-base", "--is-ancestor", older, newer],
        "",
        Date.now() + 10_000,
      ).then(
        () => true,
        () => false,
      ),
    log: (line) => console.log(line),
  });
  for (const line of outcome.lines) console.log(line);
  console.log(`deployment changed: ${outcome.changed}`);
  process.exit(outcome.ok ? 0 : 1);
}
