import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

// D03 T01 §5: a model's output is validated, never coerced into shape, so no schema under src/ uses z.coerce.
describe("no coercion", () => {
  it("finds no z.coerce under src/", () => {
    const found: string[] = [];
    const walk = (dir: URL) => {
      for (const name of readdirSync(dir)) {
        const path = new URL(name, dir);
        if (statSync(path).isDirectory()) walk(new URL(`${name}/`, dir));
        else if (/\.tsx?$/.test(name) && readFileSync(path, "utf-8").includes("z.coerce")) found.push(path.pathname);
      }
    };
    walk(new URL("../../src/", import.meta.url));
    expect(found).toEqual([]);
  });
});
