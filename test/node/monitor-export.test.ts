// The monitor training export (D05 T04 §10): finished R2 copies land in the local store once
// with their labels, an interrupted run resumes, a bad screenshot is skipped with its reason,
// and the bucket is only ever read.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openStore } from "../../scripts/glimmer/store";
import {
  type BucketLike,
  exportMonitorCopies,
  loadReceipts,
  type Receipts,
  saveReceipts,
} from "../../scripts/monitor-export";

const scratch = mkdtempSync(join(tmpdir(), "monitor-export-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const jpeg = new Uint8Array(readFileSync("test/fixtures/glimmer/page.jpg"));

function bucketWith(copies: Record<string, { label: string; source: string; shot?: Uint8Array }>) {
  const objects = new Map<string, string | Uint8Array>();
  const writes: string[] = [];
  for (const [id, copy] of Object.entries(copies)) {
    const prefix = `training/monitor/${id}/`;
    objects.set(
      `${prefix}meta.json`,
      JSON.stringify({
        orgId: "org-1",
        host: `${id}.example`,
        captureKey: `monitor/org-1/${id}.example/2026-11-02T03:00:00.000Z/`,
        url: `https://${id}.example/`,
        label: copy.label,
        why: "test",
        source: copy.source,
      }),
    );
    objects.set(`${prefix}screenshot.jpg`, copy.shot ?? jpeg);
    objects.set(`${prefix}text.txt`, `Words from ${id}`);
    objects.set(`${prefix}done.json`, "{}");
  }
  const bucket: BucketLike & { writes: string[] } = {
    writes,
    list: async (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
    getText: async (key) => {
      const value = objects.get(key);
      return typeof value === "string" ? value : null;
    },
    getBytes: async (key) => {
      const value = objects.get(key);
      return value instanceof Uint8Array ? value : null;
    },
  };
  return bucket;
}

describe("monitor export", () => {
  it("stores lure and benign copies once, resumes after interruption, and skips a bad screenshot with its reason", async () => {
    const dir = join(scratch, "store");
    const store = openStore(dir);
    const receiptsPath = join(scratch, "receipts.json");
    const receipts: Receipts = loadReceipts(receiptsPath);
    const save = () => saveReceipts(receiptsPath, receipts);
    const bucket = bucketWith({
      lurehost: { label: "lure", source: "pipeline" },
      calmhost: { label: "benign", source: "dismissal" },
      badhost: { label: "lure", source: "pipeline", shot: new Uint8Array([1, 2, 3]) },
    });
    const first = await exportMonitorCopies(bucket, store, receipts, save);
    expect(first).toEqual({ stored: 2, skipped: 1, already: 0 });
    const pages = store.manifest();
    expect(pages).toHaveLength(2);
    expect(pages.map((p) => p.labels.lure).sort()).toEqual([false, true]);
    expect(pages.every((p) => p.origin === "production")).toBe(true);
    expect(receipts.get("monitor/badhost")?.outcome).toBe("skipped");
    // A rerun stores nothing twice and reads the same receipts back from disk.
    const again = await exportMonitorCopies(bucket, store, loadReceipts(receiptsPath), save);
    expect(again).toEqual({ stored: 0, skipped: 0, already: 3 });
    expect(store.manifest()).toHaveLength(2);
    expect(bucket.writes).toEqual([]);
  });
});
