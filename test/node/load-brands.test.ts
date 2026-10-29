import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LoadRefused, loadBrands, type Run } from "../../scripts/load-brands.ts";
import { BRANDS_KEY, BRANDS_PREVIOUS_KEY } from "../../src/checks/brand-schema.ts";

// D02 T03 §3: the loader validates, keeps the previous value, writes, and reads the key back whole.
const ROOT = join(import.meta.dirname, "../..");
const table = (revision: string) =>
  JSON.stringify({
    version: 1,
    revision,
    brands: [
      {
        name: "Fynbos Freight",
        display_names: ["Fynbos Freight"],
        domains: ["fynbosfreight.example"],
        user_content: [],
        sources: [
          {
            url: "https://fynbosfreight.example/s",
            read: "2026-10-29",
            names: ["fynbosfreight.example"],
            evidence: "Ours.",
          },
        ],
      },
    ],
    excluded: [],
  });

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
function file(content: string) {
  dir = mkdtempSync(join(tmpdir(), "load-brands-"));
  const path = join(dir, "brands.json");
  writeFileSync(path, content);
  return path;
}
// A fake Wrangler over an in-memory namespace; `stale` reads return the old value that many times after a write.
function fakeKv(
  initial: Record<string, string> = {},
  { stale = 0, refuse = false, remote404 = false, puts = Number.POSITIVE_INFINITY, hang = false } = {},
) {
  const store = new Map(Object.entries(initial));
  const calls: string[][] = [];
  let lagging = 0;
  let old: string | undefined;
  let written = 0;
  const bounds: number[] = [];
  const run: Run = (args, timeoutMs) => {
    calls.push(args);
    bounds.push(timeoutMs);
    const key = args[5] as string;
    if (args[2] === "put") {
      if (refuse || written >= puts) return { status: 1, stdout: "", stderr: "denied" };
      written += 1;
      if (key === BRANDS_KEY) {
        old = store.get(key);
        lagging = stale;
      }
      store.set(key, readFileSync(args[args.indexOf("--path") + 1] as string, "utf8"));
      return { status: 0, stdout: "", stderr: "" };
    }
    if (hang && written > 0) return { status: null, stdout: "", stderr: "" };
    if (key === BRANDS_KEY && lagging > 0) {
      lagging -= 1;
      return { status: 0, stdout: old ?? "Value not found", stderr: "" };
    }
    const value = store.get(key);
    // The remote API answers a missing key 404, and Wrangler exits 1; local storage prints "Value not found".
    if (value === undefined && remote404)
      return { status: 1, stdout: "", stderr: "✘ [ERROR] Failed to fetch ... - 404: Not Found" };
    return { status: 0, stdout: value ?? "Value not found", stderr: "" };
  };
  return { store, calls, run, bounds };
}
const noSleep = async () => {};

describe("loadBrands", () => {
  it("writes the table to the named target, keeping the value it replaces, and reads it back", async () => {
    for (const target of ["local", "remote"] as const) {
      const fake = fakeKv({ [BRANDS_KEY]: table("2026-10-01") });
      const result = await loadBrands({ target, table: file(table("2026-10-29")), run: fake.run, sleep: noSleep });
      expect(result).toEqual({ revision: "2026-10-29", key: BRANDS_KEY });
      expect(
        fake.calls.every((c) => c.at(-1) === `--${target}` && c.includes("--binding") && c.includes("CACHE")),
      ).toBe(true);
      expect(JSON.parse(fake.store.get(BRANDS_KEY) as string).revision).toBe("2026-10-29");
      expect(JSON.parse(fake.store.get(BRANDS_PREVIOUS_KEY) as string).revision).toBe("2026-10-01");
      // The table travels in a file, never as an argument.
      expect(fake.calls.some((c) => c.some((a) => a.includes("Fynbos")))).toBe(false);
    }
  });

  it("reads a remote 404 as a missing key, and any other failed read as a failure", async () => {
    const first = fakeKv({}, { remote404: true });
    const done = await loadBrands({
      target: "remote",
      table: file(table("2026-10-29")),
      run: first.run,
      sleep: noSleep,
    });
    expect(done.revision).toBe("2026-10-29");
    expect(first.store.has(BRANDS_PREVIOUS_KEY)).toBe(false);
    const failing: Run = () => ({ status: 1, stdout: "", stderr: "✘ [ERROR] Authentication error [code: 10000]" });
    await expect(loadBrands({ target: "remote", table: file(table("2026-10-29")), run: failing })).rejects.toThrow(
      /reading brands:v1 failed/,
    );
  });

  it("waits out KV's eventual consistency, then gives up on a read-back that never matches", async () => {
    const lagging = fakeKv({}, { stale: 3 });
    const done = await loadBrands({
      target: "local",
      table: file(table("2026-10-29")),
      run: lagging.run,
      sleep: noSleep,
    });
    expect(done.revision).toBe("2026-10-29");
    const never = fakeKv({}, { stale: 10_000 });
    await expect(
      loadBrands({ target: "local", table: file(table("2026-10-29")), run: never.run, sleep: noSleep, verifyMs: 0 }),
    ).rejects.toThrow(/did not read back/);
  });

  it("refuses an invalid table before any write, and a refused write", async () => {
    const fake = fakeKv();
    await expect(
      loadBrands({
        target: "local",
        table: file(JSON.stringify({ version: 1, revision: "x", brands: [] })),
        run: fake.run,
      }),
    ).rejects.toThrow(LoadRefused);
    expect(fake.calls.some((c) => c[2] === "put")).toBe(false);
    const refusing = fakeKv({}, { refuse: true });
    await expect(loadBrands({ target: "remote", table: file(table("2026-10-29")), run: refusing.run })).rejects.toThrow(
      /writing brands:v1 failed/,
    );
  });

  it("restores the previous value and leaves it the rollback copy, so a retried restore restores the same revision", async () => {
    const fake = fakeKv({ [BRANDS_KEY]: table("2026-11-05"), [BRANDS_PREVIOUS_KEY]: table("2026-10-29") });
    for (let attempt = 0; attempt < 2; attempt++)
      expect((await loadBrands({ target: "local", restore: true, run: fake.run, sleep: noSleep })).revision).toBe(
        "2026-10-29",
      );
    expect(JSON.parse(fake.store.get(BRANDS_KEY) as string).revision).toBe("2026-10-29");
    expect(JSON.parse(fake.store.get(BRANDS_PREVIOUS_KEY) as string).revision).toBe("2026-10-29");
    await expect(loadBrands({ target: "local", restore: true, run: fakeKv().run })).rejects.toThrow(
      /no brands:v1:previous/,
    );
  });

  it("keeps the revision being restored when the restore is refused partway, so a retry works", async () => {
    const start = { [BRANDS_KEY]: table("2026-11-05"), [BRANDS_PREVIOUS_KEY]: table("2026-10-29") };
    // The first write (the live key) refused: nothing changed.
    const refused = fakeKv(start, { puts: 0 });
    await expect(loadBrands({ target: "local", restore: true, run: refused.run, sleep: noSleep })).rejects.toThrow();
    expect(JSON.parse(refused.store.get(BRANDS_PREVIOUS_KEY) as string).revision).toBe("2026-10-29");
    // The write commits but its answer is lost: the run fails, and a retry restores the same revision.
    const lost = fakeKv(start);
    let first = true;
    const losing: Run = (args, ms) => {
      const done = lost.run(args, ms);
      if (args[2] === "put" && first) {
        first = false;
        return { status: 1, stdout: "", stderr: "connection reset" };
      }
      return done;
    };
    await expect(loadBrands({ target: "local", restore: true, run: losing, sleep: noSleep })).rejects.toThrow();
    const retried = await loadBrands({ target: "local", restore: true, run: losing, sleep: noSleep });
    expect(retried.revision).toBe("2026-10-29");
    expect(JSON.parse(lost.store.get(BRANDS_PREVIOUS_KEY) as string).revision).toBe("2026-10-29");
    // A load refused partway keeps the live value live.
    const loading = fakeKv({ [BRANDS_KEY]: table("2026-10-29") }, { puts: 1 });
    await expect(
      loadBrands({ target: "local", table: file(table("2026-11-05")), run: loading.run, sleep: noSleep }),
    ).rejects.toThrow();
    expect(JSON.parse(loading.store.get(BRANDS_KEY) as string).revision).toBe("2026-10-29");
  });

  it("bounds every Wrangler command, and ends when one stalls", async () => {
    const stalled = fakeKv({}, { hang: true });
    await expect(
      loadBrands({
        target: "remote",
        table: file(table("2026-10-29")),
        run: stalled.run,
        sleep: noSleep,
        verifyMs: 5_000,
      }),
    ).rejects.toThrow(/did not finish in time/);
    expect(stalled.bounds.every((ms) => ms >= 1 && ms <= 30_000)).toBe(true);
    // Verification commands get no more than the time left in the window.
    expect(stalled.bounds.at(-1)).toBeLessThanOrEqual(5_000);
  });

  it("validates the committed table", async () => {
    const fake = fakeKv();
    const done = await loadBrands({
      target: "local",
      table: join(ROOT, "data/brands.json"),
      run: fake.run,
      sleep: noSleep,
    });
    expect(done.revision).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
