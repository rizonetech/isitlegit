import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// No contributor model ID anywhere in the code (D03 T01 §1; spec 4.8): Meta may train on a `-contributor` model's
// input, so only Standard IDs are ever named. A contributor ID is a name ending `-contributor` whose `-contributor`
// follows a letter, digit or dot (`muse-spark-1.3-contributor`); the defensive check's bare "-contributor" literal
// (scripts/meta-smoke.ts, refuseContributor) and the reviewer's `--contributor-mode off` switch
// (scripts/review-dispatch.py) enforce the rule and are not IDs.
const REPO = join(import.meta.dirname, "../..");
const ROOTS = ["src", "scripts", "eval"] as const;
const CONTRIBUTOR_ID = /[a-z0-9.]-contributor\b/i;

function contributorIds(base: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // a root this checkout does not have
    }
    for (const name of names) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      const bytes = readFileSync(path);
      if (bytes.includes(0)) continue; // binary (a decoder's wasm, a fixture)
      const lines = bytes.toString("utf-8").split("\n");
      lines.forEach((line, i) => {
        if (CONTRIBUTOR_ID.test(line)) found.push(`${relative(base, path)}:${i + 1}`);
      });
    }
  };
  for (const root of ROOTS) walk(join(base, root));
  return found;
}

const TMP = join(REPO, `build/test-no-contributor-${process.pid}`);
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("no contributor model ID", () => {
  it("is named anywhere in src/, scripts/ or eval/", () => {
    expect(contributorIds(REPO)).toEqual([]);
  });

  it.each(ROOTS)("is caught when planted in %s/", (root) => {
    const base = join(TMP, root);
    rmSync(base, { recursive: true, force: true });
    mkdirSync(join(base, root, "deep"), { recursive: true });
    writeFileSync(join(base, root, "deep", "call.ts"), 'const model = "muse-spark-1.3-contributor";\n');
    expect(contributorIds(base)).toEqual([`${root}/deep/call.ts:1`]);
  });

  it("leaves the rule's own enforcement alone: the bare suffix and the reviewer's switch", () => {
    const base = join(TMP, "enforcement");
    mkdirSync(join(base, "scripts"), { recursive: true });
    writeFileSync(
      join(base, "scripts", "rule.ts"),
      'export const refused = (model: string) => model.endsWith("-contributor");\nconst args = ["--contributor-mode", "off"];\n',
    );
    expect(contributorIds(base)).toEqual([]);
  });
});
