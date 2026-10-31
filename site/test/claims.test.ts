// Product claims (D07 T06 §3): each reaches a page only through the registry, each entry is on a page, and each owner
// is a real section, so §6's deploy can refuse while an owner is unstamped.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { claims } from "../src/lib/claims.ts";
import { DIST, text } from "./lib/page.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const pages = readdirSync(DIST, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".html"));
const rendered = pages.flatMap((name) => {
  const html = readFileSync(join(DIST, name), "utf8");
  return [...html.matchAll(/<(p|span) data-claim="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => ({ page: name, id: m[2], text: text(m[3]) }));
});

describe("product claims", () => {
  it("every claim on a page names a registry entry and prints its text", () => {
    assert.ok(rendered.length > 0, "no claims rendered");
    for (const claim of rendered) {
      const entry = (claims as Record<string, { text: string }>)[claim.id];
      assert.ok(entry, `${claim.page} renders claim ${claim.id}, which the registry does not hold`);
      assert.equal(claim.text, entry.text, `${claim.page} prints ${claim.id} differently from the registry`);
    }
  });

  it("every registry entry is rendered on some page", () => {
    const shown = new Set(rendered.map((c) => c.id));
    const unused = Object.keys(claims).filter((id) => !shown.has(id));
    assert.deepEqual(unused, [], "registry entries no page renders");
  });

  it("every claim names at least one owner, and every owner is a real section of the plan", () => {
    for (const [id, claim] of Object.entries(claims)) assert.ok(claim.owners.length > 0, `${id} names no owner`);
    const owners = [...new Set(Object.values(claims).flatMap((c) => c.owners))];
    for (const owner of owners) {
      const run = spawnSync("python3", [join(ROOT, "scripts/todo-graph.py"), "resolve", owner], { cwd: ROOT, encoding: "utf8" });
      assert.ok([0, 3, 4].includes(run.status ?? -1), `${owner} does not resolve (exit ${run.status}): ${run.stderr.trim()}`);
    }
  });

  it("an unknown claim id fails the build", () => {
    const component = readFileSync(fileURLToPath(new URL("../src/components/Claim.astro", import.meta.url)), "utf8");
    assert.match(component, /if \(!claim\) throw new Error/);
  });
});
