import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMap } from "../../scripts/build-confusables.ts";

// D02 T03 §1: the lookalike module's Unicode data is built from the vendored 18.0.0 tables and nothing else, and the
// check mode refuses a stale, missing or wrongly sourced map without writing.
const ROOT = join(import.meta.dirname, "../..");
const VENDOR = join(ROOT, "vendor/unicode");
const SCRIPT = join(ROOT, "scripts/build-confusables.ts");
const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

let scratch: string | undefined;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});
// A copy of the vendored tables and the committed map, to break one at a time.
function copied() {
  scratch = mkdtempSync(join(tmpdir(), "confusables-"));
  for (const name of ["confusables.txt", "DerivedBidiClass.txt", "SHA256SUMS"])
    copyFileSync(join(VENDOR, name), join(scratch, name));
  const out = join(scratch, "map.json");
  copyFileSync(join(ROOT, "src/checks/confusables-map.json"), out);
  return { vendor: scratch, out };
}
const resum = (vendor: string) =>
  writeFileSync(
    join(vendor, "SHA256SUMS"),
    ["confusables.txt", "DerivedBidiClass.txt"].map((n) => `${sha256(join(vendor, n))}  ${n}\n`).join(""),
  );

describe("the confusables map", () => {
  it("is committed current, from the recorded digests", () => {
    const done = run("--check");
    expect(done.status, done.stderr).toBe(0);
    const map = JSON.parse(readFileSync(join(ROOT, "src/checks/confusables-map.json"), "utf8"));
    expect(map.version).toBe("18.0.0");
    expect(map.sources.confusables).toBe(sha256(join(VENDOR, "confusables.txt")));
    expect(map.prototypes["а"]).toBe("a");
    expect(map.prototypes.m).toBe("rn");
  });

  it("refuses a stale map and a missing one, writing nothing", () => {
    const { vendor, out } = copied();
    writeFileSync(out, '{"stale":true}\n');
    const before = statSync(out).mtimeMs;
    const stale = run("--check", "--vendor", vendor, "--out", out);
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toMatch(/differs from a fresh build/);
    expect(readFileSync(out, "utf8")).toBe('{"stale":true}\n');
    expect(statSync(out).mtimeMs).toBe(before);
    rmSync(out);
    const missing = run("--check", "--vendor", vendor, "--out", out);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/missing/);
  });

  it("refuses a source of another version, and one whose digest is not the recorded one", () => {
    const { vendor, out } = copied();
    const original = readFileSync(join(vendor, "confusables.txt"), "utf8");
    writeFileSync(join(vendor, "confusables.txt"), original.replace("# Version: 18.0.0", "# Version: 17.0.0"));
    resum(vendor);
    expect(() => buildMap(vendor)).toThrow(/not version 18\.0\.0/);
    const versioned = run("--vendor", vendor, "--out", out);
    expect(versioned.status).not.toBe(0);
    // Same version line, one mapping changed, digests not updated.
    writeFileSync(join(vendor, "confusables.txt"), original.replace("0430 ;\t0061 ;", "0430 ;\t0062 ;"));
    copyFileSync(join(VENDOR, "SHA256SUMS"), join(vendor, "SHA256SUMS"));
    const written = readFileSync(out, "utf8");
    const tampered = run("--vendor", vendor, "--out", out);
    expect(tampered.status).not.toBe(0);
    expect(tampered.stderr).toMatch(/digest is not the one recorded/);
    expect(readFileSync(out, "utf8")).toBe(written);
  });
});
