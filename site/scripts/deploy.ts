// The site's deploy (D07 T06 §6): build, type check, tests, the claims gate and the link gate, then Wrangler. Any step
// that fails stops the deploy before Wrangler runs, and a Wrangler failure is a failure of the deploy.
//
//   pnpm --filter site run deploy [--dry-run]
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export type Step = { name: string; command: string; args: string[]; cwd: string };
export type Runner = (step: Step) => number;

export function steps(root: string, dryRun: boolean): { gates: Step[]; wrangler: Step } {
  const site = join(root, "site");
  const pnpm = (name: string, ...args: string[]): Step => ({ name, command: "pnpm", args, cwd: root });
  return {
    gates: [
      pnpm("build", "--filter", "site", "build"),
      pnpm("check", "--filter", "site", "check"),
      pnpm("test", "--filter", "site", "test"),
      { name: "claims", command: "node", args: ["scripts/check-claims.ts"], cwd: site },
      { name: "links", command: "node", args: ["scripts/check-links.ts"], cwd: site },
    ],
    wrangler: {
      name: "wrangler",
      command: "pnpm",
      args: ["exec", "wrangler", "deploy", "--config", "site/wrangler.jsonc", ...(dryRun ? ["--dry-run"] : [])],
      cwd: root,
    },
  };
}

export function deploy(root: string, dryRun: boolean, run: Runner): number {
  const plan = steps(root, dryRun);
  for (const step of plan.gates) {
    const code = run(step);
    if (code !== 0) {
      console.error(`deploy: refusing, ${step.name} failed (exit ${code}); wrangler was not run`);
      return 1;
    }
  }
  const code = run(plan.wrangler);
  if (code !== 0) {
    console.error(`deploy: wrangler failed (exit ${code})`);
    return 1;
  }
  console.log(dryRun ? "deploy: dry run passed" : "deploy: deployed");
  return 0;
}

if (import.meta.filename === process.argv[1]) {
  const root = join(import.meta.dirname, "../..");
  const code = deploy(root, process.argv.includes("--dry-run"), (step) => {
    console.log(`deploy: ${step.name}`);
    return spawnSync(step.command, step.args, { cwd: step.cwd, stdio: "inherit" }).status ?? 1;
  });
  process.exit(code);
}
