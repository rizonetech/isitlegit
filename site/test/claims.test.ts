// Product claims (D07 T06 §3): each reaches a page only through the registry and each entry is on a page. That each owner
// is a real section is checked against the plan in tests/scripts/test_site_claims.py, where the graph's history exists.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { planState } from "../scripts/check-claims.ts";
import { claims } from "../src/lib/claims.ts";
import { isProven } from "../src/lib/proven.ts";
import { DIST, text } from "./lib/page.ts";

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

  it("renders every proven entry and publishes no blocked one (proven-only, D07 T06 §20)", () => {
    const plan = readFileSync(join(DIST, "..", "..", "todo", "implementation-plan.md"), "utf8");
    const state = planState(plan);
    const shown = new Set(rendered.map((c) => c.id));
    const proven = Object.keys(claims).filter((id) => isProven(claims[id as keyof typeof claims].owners, state));
    const blocked = Object.keys(claims).filter((id) => !isProven(claims[id as keyof typeof claims].owners, state));
    assert.ok(proven.length > 0, "the plan proves no claim");
    for (const id of proven) assert.ok(shown.has(id), `proven claim ${id} renders nowhere`);
    for (const id of blocked) assert.ok(!shown.has(id), `blocked claim ${id} is published`);
  });

  it("every claim names at least one owner (tests/scripts/test_site_claims.py checks each is a section of the plan)", () => {
    for (const [id, claim] of Object.entries(claims)) assert.ok(claim.owners.length > 0, `${id} names no owner`);
  });

  it("an unknown claim id fails the build", () => {
    const component = readFileSync(fileURLToPath(new URL("../src/components/Claim.astro", import.meta.url)), "utf8");
    assert.match(component, /if \(!claim\) throw new Error/);
  });

  it("proves an entry only when every owner is stamped", () => {
    const state = (ref: string) => (ref === "D01 T01 §1" ? "stamped" : "open") as "stamped" | "open";
    assert.equal(isProven(["D01 T01 §1"], state), true);
    assert.equal(isProven(["D01 T01 §1", "D04 T02 §4"], state), false);
    assert.equal(isProven([], state), true);
    assert.equal(isProven(undefined, state), true);
  });
});
