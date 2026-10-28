import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// D01 T01 §5: parsing stays inside the Worker's 128 MB on bodies that exhaust it unbounded. The workers test pool is not
// held to that limit, so each case runs here in a Node process with a 128 MiB heap and a real clock.
const PARSE = join(import.meta.dirname, "../../src/intake/parse.ts");

// Resolves the source's extensionless relative imports in the child process.
const HOOK = join(import.meta.dirname, "ts-extensionless.mjs");

function underHeapLimit(build: string, call = "parseMessage(message)") {
  const script = `
    import PostalMime from "postal-mime";
    import { parseMessage } from ${JSON.stringify(PARSE)};
    const message = new TextEncoder().encode(${build});
    const parsed = await ${call};
    console.log(JSON.stringify({ truncated: (parsed.truncated ?? []).length, text: (parsed.text ?? "").length }));
  `;
  return spawnSync(
    process.execPath,
    ["--max-old-space-size=128", "--import", HOOK, "--input-type=module", "-e", script],
    {
      encoding: "utf-8",
      timeout: 30_000,
    },
  );
}

const TWENTY = `[
  "From: billing@fictional-supplier.example", 'Content-Type: multipart/mixed; boundary="b"', "",
  ...Array.from({ length: 20 }, () => ["--b", "Content-Type: text/plain", "", ("&".repeat(78) + "\\r\\n").repeat(10000)]).flat(),
  "--b", "Content-Type: text/html", "", "<p>last</p>", "--b--", ""
].join("\\r\\n")`;

describe("parseMessage under a 128 MiB heap", () => {
  it("parses twenty text parts under the per-part limit and an HTML part, bounded together", () => {
    const run = underHeapLimit(TWENTY);
    expect(run.status, run.stderr.slice(-400)).toBe(0);
    expect(JSON.parse(run.stdout).truncated).toBeGreaterThan(0);
  });

  it("parses an 8 MB crafted text part", () => {
    const run = underHeapLimit(
      `"From: billing@fictional-supplier.example\\r\\nContent-Type: text/plain\\r\\n\\r\\n" + ("&".repeat(900) + "\\r\\n").repeat(8889)`,
    );
    expect(run.status, run.stderr.slice(-400)).toBe(0);
    expect(JSON.parse(run.stdout).truncated).toBe(1);
  });

  it("is what keeps the twenty parts alive: postal-mime's unbounded parse dies on them", () => {
    const run = underHeapLimit(TWENTY, "PostalMime.parse(message)");
    expect(run.status).not.toBe(0);
  });
});
