// The claims gate (D07 T06 §6): refuses naming each claim while an owner is open or not a section, passes when every owner
// is stamped, reads the generated plan's states, and the real registry is read without error.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkClaims, type Registry, planState } from "../scripts/check-claims.ts";
import { claims } from "../src/lib/claims.ts";

const PLAN = [
  "| [x]    | D01 T01 §1  | Core                | none | 1 |",
  "| [ ]    | D04 T02 §4  | Muse Wonder loop    | meta-api, cloudflare | 5 |",
].join("\n");
const state = planState(PLAN);

describe("check-claims", () => {
  it("reads stamped, open and missing sections from the generated plan", () => {
    assert.equal(state("D01 T01 §1"), "stamped");
    assert.equal(state("D04 T02 §4"), "open");
    assert.equal(state("D99 T99 §9"), "missing");
  });

  it("refuses a registry naming an open section and a section that does not exist, naming each claim", () => {
    const registry: Registry = {
      "home.ok": { text: "a", owners: ["D01 T01 §1"] },
      "home.phishing": { text: "b", owners: ["D04 T02 §4"] },
      "home.ghost": { text: "c", owners: ["D99 T99 §9"] },
    };
    const { problems } = checkClaims(registry, state);
    assert.deepEqual(problems, ["home.phishing: D04 T02 §4 is not stamped", "home.ghost: D99 T99 §9 is not a section of the plan"]);
  });

  it("passes when every owner is stamped, and a claim with no owner is not a problem", () => {
    const registry: Registry = { "a.one": { text: "a", owners: ["D01 T01 §1"] }, "a.two": { text: "b" } };
    const { rows, problems } = checkClaims(registry, state);
    assert.deepEqual(problems, []);
    assert.equal(rows.length, 2);
  });

  it("lists the real registry against the real plan, one row per claim", () => {
    const plan = readFileSync(join(import.meta.dirname, "../../todo/implementation-plan.md"), "utf8");
    const { rows } = checkClaims(claims as Registry, planState(plan));
    assert.equal(rows.length, Object.keys(claims).length);
    for (const row of rows) for (const owner of row.owners) assert.notEqual(owner.state, "missing", `${row.id}: ${owner.ref} is not in the plan`);
  });

  it("lists every omitted claim by id and exits 0 in proven-only mode, never silently", () => {
    const dir = mkdtempSync(join(tmpdir(), "claims-proven-"));
    try {
      writeFileSync(join(dir, "claims.ts"), `export const claims = { "p.ok": { text: "t", owners: ["D01 T01 §1"] }, "p.out": { text: "u", owners: ["D04 T02 §4"] } };\n`);
      writeFileSync(join(dir, "plan.md"), PLAN + "\n");
      const script = join(import.meta.dirname, "../scripts/check-claims.ts");
      const out = spawnSync("node", [script, "--proven-only", "--plan", join(dir, "plan.md"), "--claims", join(dir, "claims.ts")], {
        encoding: "utf8",
      });
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /proven-only: omitting p\.out/);
      assert.doesNotMatch(out.stdout, /proven-only: omitting p\.ok/);
      assert.match(out.stdout, /proven-only: 1 proven, 1 omitted of 2 claims/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
