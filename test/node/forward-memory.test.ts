import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// D01 T01 §4 rounds 1 and 2: extraction stays inside the Worker's 128 MB on the forwards that exhausted it. The
// workers test pool is not held to that limit, so each case runs here in a Node process with a 128 MiB heap.
const FORWARD = join(import.meta.dirname, "../../src/intake/forward.ts");

// Resolves the source's extensionless relative imports in the child process.
const HOOK = join(import.meta.dirname, "ts-extensionless.mjs");

function underHeapLimit(build: string) {
  const script = `
    import { extractOriginal } from ${JSON.stringify(FORWARD)};
    const enc = (t) => new TextEncoder().encode(t);
    const forward = ${build};
    const found = await extractOriginal(forward);
    console.log(JSON.stringify({ path: found.path, bytes: found.original.byteLength }));
  `;
  return spawnSync(
    process.execPath,
    ["--max-old-space-size=128", "--import", HOOK, "--input-type=module", "-e", script],
    {
      encoding: "utf-8",
      // A real clock: a forward that takes longer than this is a denial of service, not a slow message.
      timeout: 10_000,
    },
  );
}

describe("extractOriginal under a 128 MiB heap", () => {
  it("finds the original beside an 8 MB crafted text part", () => {
    const run = underHeapLimit(`enc([
      "From: boss@fictional-recipient.example", 'Content-Type: multipart/mixed; boundary="outer"', "",
      "--outer", 'Content-Type: multipart/alternative; boundary="alt"', "",
      "--alt", "Content-Type: text/plain", "", (("&".repeat(900) + "\\r\\n").repeat(8889)),
      "--alt", "Content-Type: text/html", "", "<p>see</p>", "--alt--",
      "--outer", "Content-Type: message/rfc822", "", "From: a@fictional.example\\r\\n\\r\\nbody\\r\\n", "--outer--", ""
    ].join("\\r\\n"))`);
    expect(run.status, run.stderr.slice(-400)).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ path: "rfc822" });
  });

  it("decodes a 22 MB quoted-printable original", () => {
    const run = underHeapLimit(`enc([
      "From: boss@fictional-recipient.example", 'Content-Type: multipart/mixed; boundary="b"', "",
      "--b", 'Content-Type: application/octet-stream; name="original.eml"', "Content-Transfer-Encoding: quoted-printable", "",
      ("a".repeat(74) + "\\r\\n").repeat(300000) + "--b--", ""
    ].join("\\r\\n"))`);
    expect(run.status, run.stderr.slice(-400)).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ path: "eml", bytes: 76 * 300_000 - 2 });
  });

  it("reads a 60,000-character boundary over five million hyphens within the timeout", () => {
    const run = underHeapLimit(
      `enc('From: boss@fictional-recipient.example\\r\\nContent-Type: multipart/mixed; boundary="' + "-".repeat(60000) + 'X"\\r\\n\\r\\n' + "-".repeat(5000000))`,
    );
    expect(run.status, run.stderr.slice(-400)).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ path: "inline" });
  });
});
