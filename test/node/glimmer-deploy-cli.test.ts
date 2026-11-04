import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function command(args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "glimmer-cli-entry-"));
  dirs.push(dir);
  const preload = join(dir, "offline.mjs");
  writeFileSync(
    preload,
    `
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
cp.execFileSync = (command, args) => {
  if (command === 'git' && args[0] === 'rev-parse') return '0123456789012345678901234567890123456789\\n';
  if (command === 'git' && args[0] === 'status') return ' M offline-fixture\\n';
  throw new Error('offline test forbids external command');
};
cp.spawn = () => { throw new Error('offline test forbids external process'); };
syncBuiltinESMExports();
globalThis.fetch = async () => { throw new Error('offline test forbids network'); };
`,
  );
  return spawnSync(process.execPath, ["--import", preload, "scripts/glimmer/deploy.ts", ...args], {
    cwd: join(import.meta.dirname, "../.."),
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, GLIMMER_DATA_DIR: dir },
  });
}
it("release loads its promotion dependency and reaches the offline preflight without an unsettled module cycle", () => {
  const result = command(["release"]);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    outcome: "refused",
    stage: "preflight",
    serving: "unchanged",
    detail: "the working tree is not clean; commit the release first",
  });
  expect(result.stderr).not.toContain("unsettled top-level await");
});
it.each([["promote", "1.1"], ["rollback"]])(
  "%s loads its promotion dependency before the blocked credential command",
  (...args) => {
    const result = command(args);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('deploy: reading the vault item "IsItLegit Fireworks Admin" failed');
    expect(result.stderr).not.toContain("unsettled top-level await");
  },
);
it("keeps ordinary CLI usage errors unchanged", () => {
  const result = command(["not-a-command"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("usage:");
});
