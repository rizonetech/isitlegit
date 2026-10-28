import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// D01 T01 §6 round 1: a .msg whose Unicode body fits the 25 MiB admission limit but would exhaust the Worker's 128 MB
// if msgreader decoded it (it builds strings a character at a time) is read and cut inside it. The workers test pool is
// not held to that limit, so the case runs here in a Node process with a 128 MiB heap and a real clock.
const MSG = join(import.meta.dirname, "../../src/intake/msg.ts");
const BUILDER = join(import.meta.dirname, "../../scripts/fixtures/msg-builder.ts");

// Resolves the source's extensionless relative imports and msgreader's default export in the child process.
const HOOK = join(import.meta.dirname, "ts-extensionless.mjs");

function underHeapLimit(variant: string, rename = "") {
  const script = `
    import { parseMsg } from ${JSON.stringify(MSG)};
    import { makeMsg, renameEntry } from ${JSON.stringify(BUILDER)};
    let msg = makeMsg(${variant});
    ${rename}
    const bytes = msg.byteLength;
    const { parsed } = await parseMsg(msg);
    console.log(JSON.stringify({ bytes, text: parsed.text.length, truncated: parsed.truncated.map((t) => t.charset) }));
  `;
  return spawnSync(
    process.execPath,
    ["--max-old-space-size=128", "--import", HOOK, "--input-type=module", "-e", script],
    { encoding: "utf-8", timeout: 30_000 },
  );
}

describe("parseMsg under a 128 MiB heap", () => {
  it("cuts a 17 MB Unicode body without decoding all of it", () => {
    const run = underHeapLimit("{ transportHeaders: true, bodyRepeat: 150000 }");
    expect(run.status, run.stderr.slice(-400)).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.bytes).toBeGreaterThan(16_000_000);
    expect(result).toMatchObject({ text: 512 * 1024, truncated: ["utf-16le"] });
  });

  it("refuses a 1 MiB named-property name that sixteen entries refer to, before decoding any", () => {
    const run = underHeapLimit("{ transportHeaders: true, names: { nameBytes: 1024 * 1024, references: 16 } }");
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/ParseError: the .msg's text properties hold/);
  });

  it("refuses a 17 MB body under a spelling msgreader still reads, before decoding it", () => {
    const run = underHeapLimit(
      "{ transportHeaders: true, bodyRepeat: 150000 }",
      'msg = renameEntry(msg, "__substg1.0_1000001F", "__substg1.X_1000001F");',
    );
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/ParseError: an entry of the .msg has a malformed name/);
  });
});
