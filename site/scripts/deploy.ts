// The site's deploy (D07 T06 §6): build, type check, tests, the claims gate and the link gate, then Wrangler. Any step
// that fails stops the deploy before Wrangler runs, and a Wrangler failure is a failure of the deploy.
//
//   pnpm --filter site run deploy [--dry-run]
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export type Step = { name: string; command: string; args: string[]; cwd: string };
export type Runner = (step: Step) => number;
// Where the gates look; the defaults are the real site, a test points them at a fixture. provenOnly is the interim
// deploy mode (D07 T06 §20): the claims gate lists every omitted claim by id and passes instead of refusing.
export type Options = { claimsArgs?: string[]; linksArgs?: string[]; wranglerConfig?: string; heavy?: Step[]; provenOnly?: boolean };

export const USAGE = "usage: pnpm --filter site run deploy [--dry-run] [--proven-only] | --help";

export function steps(root: string, dryRun: boolean, options: Options = {}): { gates: Step[]; wrangler: Step } {
  const site = join(root, "site");
  const pnpm = (name: string, ...args: string[]): Step => ({ name, command: "pnpm", args, cwd: root });
  const [build, check, test] = options.heavy ?? [
    pnpm("build", "--filter", "site", "build"),
    pnpm("check", "--filter", "site", "check"),
    pnpm("test", "--filter", "site", "test"),
  ];
  return {
    // The claims gate reads source and the plan only, so it runs first: the blockers are reported before the build.
    gates: [
      {
        name: "claims",
        command: "node",
        args: ["scripts/check-claims.ts", ...(options.claimsArgs ?? []), ...(options.provenOnly ? ["--proven-only"] : [])],
        cwd: site,
      },
      build as Step,
      check as Step,
      test as Step,
      { name: "links", command: "node", args: ["scripts/check-links.ts", ...(options.linksArgs ?? [])], cwd: site },
    ],
    wrangler: {
      name: "wrangler",
      command: "pnpm",
      args: [
        "exec",
        "wrangler",
        "deploy",
        "--config",
        options.wranglerConfig ?? "site/wrangler.jsonc",
        ...(dryRun ? ["--dry-run"] : []),
      ],
      cwd: root,
    },
  };
}

export function deploy(root: string, dryRun: boolean, run: Runner, options: Options = {}): number {
  const plan = steps(root, dryRun, options);
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

// Arguments are checked before any step runs: help and a mistyped option never reach a build or a deploy.
export function parse(argv: string[]): { dryRun: boolean; provenOnly: boolean } | { help: true } | { error: string } {
  const unknown = argv.filter((a) => a !== "--dry-run" && a !== "--proven-only" && a !== "--help");
  if (unknown.length) return { error: `unknown argument ${unknown.map((a) => JSON.stringify(a)).join(", ")}\n${USAGE}` };
  if (argv.includes("--help")) return { help: true };
  return { dryRun: argv.includes("--dry-run"), provenOnly: argv.includes("--proven-only") };
}

if (import.meta.filename === process.argv[1]) {
  const root = join(import.meta.dirname, "../..");
  const parsed = parse(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`deploy: ${parsed.error}`);
    process.exit(2);
  }
  if ("help" in parsed) {
    console.log(USAGE);
    process.exit(0);
  }
  process.exit(
    deploy(
      root,
      parsed.dryRun,
      (step) => {
        console.log(`deploy: ${step.name}`);
        return spawnSync(step.command, step.args, { cwd: step.cwd, stdio: "inherit" }).status ?? 1;
      },
      { provenOnly: parsed.provenOnly },
    ),
  );
}
