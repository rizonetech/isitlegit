// The monitor training export (D05 T04 §10): finished R2 copies land in the local store once
// with their labels through real `putPage` validation and `readVerifiedPage` read-back,
// label overrides (confirmation -> dismissal -> export -> restore -> export) update and retract
// local store eligibility, authorised `removed.json` tombstones remove local pages and prevent
// reimport on store rebuild, per-item receipts reconcile against local disk integrity and
// recover after local data loss or interrupted receipt saves, shared-content provenance uses
// `addItem`, post-form walkthrough / member-account items are skipped with durable skip records
// in `monitor-export-skips.json`, `exportBeforeRetraining` verifies store integrity, and R2 is
// strictly read-only.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openStore } from "../../scripts/glimmer/store";
import {
  type BucketLike,
  exportBeforeRetraining,
  exportMonitorCopies,
  loadReceipts,
  type Receipts,
  readSkipManifest,
  saveReceipts,
} from "../../scripts/monitor-export";

const scratch = mkdtempSync(join(tmpdir(), "monitor-export-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const jpeg = new Uint8Array(readFileSync("test/fixtures/glimmer/page.jpg"));

type CopySpec = {
  orgId?: string;
  host?: string;
  moment?: string;
  captureKey?: string;
  label: string;
  source: string;
  sourceRef?: string;
  why?: string;
  shot?: Uint8Array;
  text?: string;
  retracted?: boolean;
  updatedAt?: string;
};

function bucketWith(copies: Record<string, CopySpec>) {
  const objects = new Map<string, string | Uint8Array>();
  const writes: string[] = [];
  const putCopy = (id: string, copy: CopySpec) => {
    const orgId = copy.orgId ?? "org-1";
    const host = copy.host ?? `${id}.example`;
    const moment = copy.moment ?? "2026-11-02T03:00:00.000Z";
    const trainingId = `monitor/${orgId}/${host}/${moment}`;
    const prefix = `training/${trainingId}/`;
    const captureKey = copy.captureKey ?? `monitor/${orgId}/${host}/${moment}/`;
    objects.set(
      `${prefix}meta.json`,
      JSON.stringify({
        trainingId,
        orgId,
        host,
        captureKey,
        url: `https://${host}/`,
        fetchedAt: moment,
        label: copy.label,
        why: "test",
        source: copy.source,
        sourceRef: copy.sourceRef ?? `${copy.source}:${orgId}:${captureKey}`,
        copiedAt: moment,
        updatedAt: copy.updatedAt ?? moment,
        retracted: copy.retracted ?? false,
      }),
    );
    objects.set(`${prefix}screenshot.jpg`, copy.shot ?? jpeg);
    objects.set(`${prefix}text.txt`, copy.text ?? `Words from ${id}`);
    objects.set(
      `${prefix}done.json`,
      JSON.stringify({ at: copy.updatedAt ?? moment, retracted: copy.retracted ?? false }),
    );
    return { trainingId, prefix };
  };
  for (const [id, copy] of Object.entries(copies)) {
    putCopy(id, copy);
  }
  const bucket: BucketLike & {
    writes: string[];
    objects: Map<string, string | Uint8Array>;
    putCopy: typeof putCopy;
  } = {
    writes,
    objects,
    putCopy,
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
  it("stores lure, second-look and dismissal copies once with verified read-back, skips bad screenshots, and keeps R2 read-only", async () => {
    const dir = join(scratch, "store-basic");
    const store = openStore(dir);
    const receiptsPath = join(dir, "monitor-export-receipts.json");
    const receipts: Receipts = loadReceipts(receiptsPath);
    const save = () => saveReceipts(receiptsPath, receipts);
    const bucket = bucketWith({
      lurehost: { label: "lure", source: "pipeline" },
      declinedhost: { label: "benign", source: "second-look" },
      calmhost: { label: "benign", source: "dismissal" },
      badhost: { label: "lure", source: "pipeline", shot: new Uint8Array([1, 2, 3]) },
    });
    const first = await exportMonitorCopies(bucket, store, receipts, save);
    expect(first).toEqual({ stored: 3, skipped: 1, already: 0 });
    const pages = store.manifest();
    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.labels.lure).sort()).toEqual([false, false, true]);
    expect(pages.every((p) => p.origin === "production" && p.label_source.lure === "rule")).toBe(true);
    for (const p of pages) {
      expect(store.readVerifiedPage(p.id)).not.toBeNull();
    }
    const badId = "monitor/org-1/badhost.example/2026-11-02T03:00:00.000Z";
    expect(receipts.get(badId)?.outcome).toBe("skipped");
    const skips = readSkipManifest(dir);
    expect(skips).toEqual([
      expect.objectContaining({
        id: badId,
        outcome: "skipped",
        reason: expect.stringContaining("not a JPEG"),
      }),
    ]);

    // A rerun stores nothing twice and reads the same receipts back from disk.
    const again = await exportMonitorCopies(bucket, store, loadReceipts(receiptsPath), save);
    expect(again).toEqual({ stored: 0, skipped: 0, already: 4 });
    expect(store.manifest()).toHaveLength(3);
    expect(bucket.writes).toEqual([]);
  });

  it("handles confirmation -> export -> dismissal -> export -> restore -> export in the local store", async () => {
    const dir = join(scratch, "store-lifecycle");
    const store = openStore(dir);
    const receiptsPath = join(dir, "monitor-export-receipts.json");
    const receipts = loadReceipts(receiptsPath);
    const save = () => saveReceipts(receiptsPath, receipts);
    const bucket = bucketWith({
      flipped: { label: "lure", source: "pipeline", text: "Lifecycle page text" },
    });
    const id = "monitor/org-1/flipped.example/2026-11-02T03:00:00.000Z";

    // 1. Confirmed lure exported.
    expect(await exportMonitorCopies(bucket, store, receipts, save)).toEqual({ stored: 1, skipped: 0, already: 0 });
    expect(store.manifest()).toHaveLength(1);
    expect(store.manifest()[0]?.labels.lure).toBe(true);

    // 2. Business dismisses as not a fake: next export updates the local page to benign (lure: false).
    bucket.putCopy("flipped", {
      label: "benign",
      source: "dismissal",
      text: "Lifecycle page text",
      updatedAt: "2026-11-02T04:00:00.000Z",
    });
    expect(await exportMonitorCopies(bucket, store, receipts, save)).toEqual({ stored: 1, skipped: 0, already: 0 });
    expect(store.manifest()).toHaveLength(1);
    expect(store.manifest()[0]?.labels.lure).toBe(false);
    expect(receipts.get(id)?.label).toBe("benign");

    // 3. Business restores the finding: next export retracts local training eligibility.
    bucket.putCopy("flipped", {
      label: "benign",
      source: "restore",
      text: "Lifecycle page text",
      retracted: true,
      updatedAt: "2026-11-02T05:00:00.000Z",
    });
    expect(await exportMonitorCopies(bucket, store, receipts, save)).toEqual({ stored: 0, skipped: 1, already: 0 });
    expect(store.manifest()).toHaveLength(0);
    expect(receipts.get(id)?.outcome).toBe("retracted");
    expect(readSkipManifest(dir)).toContainEqual(expect.objectContaining({ id, outcome: "retracted" }));
  });

  it("removes local pages on removed.json tombstones and prevents reimport on store rebuild", async () => {
    const dir = join(scratch, "store-removal");
    const store = openStore(dir);
    const receiptsPath = join(dir, "monitor-export-receipts.json");
    const receipts = loadReceipts(receiptsPath);
    const save = () => saveReceipts(receiptsPath, receipts);
    const bucket = bucketWith({
      keepme: { label: "lure", source: "pipeline", text: "Keep this lure" },
      purgeme: { label: "lure", source: "pipeline", text: "Purge this host" },
    });
    const purgeId = "monitor/org-1/purgeme.example/2026-11-02T03:00:00.000Z";

    expect(await exportMonitorCopies(bucket, store, receipts, save)).toEqual({ stored: 2, skipped: 0, already: 0 });
    expect(store.manifest()).toHaveLength(2);

    // Simulate removeTrainingCopiesForHost in R2: delete copy files and write removed.json tombstones.
    for (const suffix of ["done.json", "meta.json", "screenshot.jpg", "text.txt"]) {
      bucket.objects.delete(`training/${purgeId}/${suffix}`);
    }
    bucket.objects.set(`training/${purgeId}/removed.json`, JSON.stringify({ trainingId: purgeId }));
    bucket.objects.set(
      "training/monitor/org-1/purgeme.example/removed.json",
      JSON.stringify({ orgId: "org-1", host: "purgeme.example" }),
    );

    // Export reconciles removal and deletes the local page.
    expect(await exportMonitorCopies(bucket, store, receipts, save)).toEqual({ stored: 0, skipped: 1, already: 1 });
    expect(store.manifest().map((p) => p.host)).toEqual(["keepme.example"]);
    expect(receipts.get(purgeId)?.outcome).toBe("removed");

    // Rebuild into a brand-new store: only keepme is imported, purgeme stays removed.
    const rebuiltDir = join(scratch, "store-rebuilt");
    const rebuiltStore = openStore(rebuiltDir);
    const rebuiltReceiptsPath = join(rebuiltDir, "monitor-export-receipts.json");
    const rebuiltReceipts = loadReceipts(rebuiltReceiptsPath);
    expect(
      await exportMonitorCopies(bucket, rebuiltStore, rebuiltReceipts, () =>
        saveReceipts(rebuiltReceiptsPath, rebuiltReceipts),
      ),
    ).toEqual({ stored: 1, skipped: 1, already: 0 });
    expect(rebuiltStore.manifest().map((p) => p.host)).toEqual(["keepme.example"]);
    expect(rebuiltReceipts.get(purgeId)?.outcome).toBe("removed");
    expect(bucket.writes).toEqual([]);
  });

  it("handles late arrivals, interrupted receipt persistence, local data loss recovery, transient read failures, and duplicate-content provenance", async () => {
    const dir = join(scratch, "store-resilience");
    const store = openStore(dir);
    const receiptsPath = join(dir, "monitor-export-receipts.json");
    const receipts = loadReceipts(receiptsPath);
    const save = () => saveReceipts(receiptsPath, receipts);
    const bucket = bucketWith({
      later: {
        orgId: "org-2",
        host: "zzz.example",
        moment: "2026-11-02T09:00:00.000Z",
        label: "lure",
        source: "pipeline",
        text: "Shared lure content",
      },
    });

    expect(await exportMonitorCopies(bucket, store, receipts, save)).toEqual({ stored: 1, skipped: 0, already: 0 });

    // 1. Late arrival sorting before `later` and sharing identical screenshot+text bytes (`addItem` provenance).
    bucket.putCopy("earlier", {
      orgId: "org-1",
      host: "aaa.example",
      moment: "2026-11-01T01:00:00.000Z",
      label: "lure",
      source: "pipeline",
      text: "Shared lure content",
    });
    expect(await exportMonitorCopies(bucket, store, receipts, save)).toEqual({ stored: 1, skipped: 0, already: 1 });
    expect(store.manifest()).toHaveLength(1);
    expect(store.manifest()[0]?.items).toHaveLength(2);

    // 1b. Relabelling one capture on a shared page replaces its previous provenance entry instead of duplicating it.
    bucket.putCopy("earlier", {
      orgId: "org-1",
      host: "aaa.example",
      moment: "2026-11-01T01:00:00.000Z",
      label: "benign",
      source: "dismissal",
      sourceRef: "finding:org-1:aaa.example:monitor/org-1/aaa.example/2026-11-01T01:00:00.000Z/",
      why: "dismissed as not a fake: our own site",
      text: "Shared lure content",
      updatedAt: "2026-11-02T10:00:00.000Z",
    });
    expect(await exportMonitorCopies(bucket, store, receipts, save)).toEqual({ stored: 1, skipped: 0, already: 1 });
    const sharedItems = store.manifest()[0]?.items ?? [];
    expect(sharedItems).toHaveLength(2);
    expect(sharedItems.filter((e) => e.id.startsWith("monitor/org-1/aaa.example/2026-11-01T01:00:00.000Z ("))).toEqual([
      expect.objectContaining({ lure: false }),
    ]);

    // 2. Interruption after `putPage` before receipt persistence: delete receipt for `earlier` while page stays in store.
    receipts.delete("monitor/org-1/aaa.example/2026-11-01T01:00:00.000Z");
    save();
    expect(await exportMonitorCopies(bucket, store, receipts, save)).toEqual({ stored: 1, skipped: 0, already: 1 });
    expect(store.manifest()).toHaveLength(1);
    expect(store.manifest()[0]?.items).toHaveLength(2);

    // 2b. Retraction after receipt loss: if receipt for `earlier` is lost and `earlier` is then retracted in R2,
    // export still removes `earlier` from the stored page's provenance.
    receipts.delete("monitor/org-1/aaa.example/2026-11-01T01:00:00.000Z");
    save();
    bucket.putCopy("earlier", {
      orgId: "org-1",
      host: "aaa.example",
      moment: "2026-11-01T01:00:00.000Z",
      label: "benign",
      source: "restore",
      text: "Shared lure content",
      retracted: true,
      updatedAt: "2026-11-02T11:00:00.000Z",
    });
    expect(await exportMonitorCopies(bucket, store, receipts, save)).toEqual({ stored: 0, skipped: 1, already: 1 });
    expect(store.manifest()).toHaveLength(1);
    expect(store.manifest()[0]?.items).toBeUndefined();
    expect(store.manifest()[0]?.labels.lure).toBe(true);

    // 2c. Retrying removal when a capture's provenance was already narrowed off a shared page does not delete the remaining capture's page.
    const sharedPageId = store.manifest()[0]?.id ?? "";
    receipts.set("monitor/org-1/aaa.example/2026-11-01T01:00:00.000Z", {
      page: sharedPageId,
      outcome: "stored",
      label: "benign",
      at: "2026-11-02T10:00:00.000Z",
    });
    save();
    expect(await exportMonitorCopies(bucket, store, receipts, save)).toEqual({ stored: 0, skipped: 1, already: 1 });
    expect(store.manifest()).toHaveLength(1);
    expect(store.manifest()[0]?.id).toBe(sharedPageId);

    // Re-confirm `earlier` so both items are present again for subsequent checks.
    bucket.putCopy("earlier", {
      orgId: "org-1",
      host: "aaa.example",
      moment: "2026-11-01T01:00:00.000Z",
      label: "lure",
      source: "pipeline",
      text: "Shared lure content",
      retracted: false,
      updatedAt: "2026-11-02T12:00:00.000Z",
    });
    expect(await exportMonitorCopies(bucket, store, receipts, save)).toEqual({ stored: 1, skipped: 0, already: 1 });

    // 3. Local data loss recovery: corrupt the stored page's text on disk; next export detects via readVerifiedPage and repairs it.
    const pageId = store.manifest()[0]?.id ?? "";
    writeFileSync(join(dir, "pages", pageId, "text.txt"), "corrupted disk bytes");
    expect(store.readVerifiedPage(pageId)).toBeNull();
    expect(await exportMonitorCopies(bucket, store, receipts, save)).toEqual({ stored: 2, skipped: 0, already: 0 });
    expect(store.readVerifiedPage(pageId)).not.toBeNull();

    // 4. Transient read failure and transient local write failure (ENOSPC) leave item unreceipted (`failed: 1`) and retry on the next run.
    bucket.putCopy("flaky", {
      orgId: "org-3",
      host: "flaky.example",
      label: "benign",
      source: "second-look",
      text: "Flaky read text",
    });
    let failOnce = true;
    const origGetBytes = bucket.getBytes;
    bucket.getBytes = async (key) => {
      if (failOnce && key.includes("flaky.example")) {
        failOnce = false;
        throw new Error("transient R2 socket reset");
      }
      return origGetBytes(key);
    };
    expect(await exportMonitorCopies(bucket, store, receipts, save)).toEqual({
      stored: 0,
      skipped: 0,
      already: 2,
      failed: 1,
    });
    expect(receipts.has("monitor/org-3/flaky.example/2026-11-02T03:00:00.000Z")).toBe(false);

    let failWriteOnce = true;
    const origPutPage = store.putPage;
    store.putPage = async (src, p) => {
      if (failWriteOnce && p.host === "flaky.example") {
        failWriteOnce = false;
        const err = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
        err.code = "ENOSPC";
        throw err;
      }
      return origPutPage(src, p);
    };
    expect(await exportMonitorCopies(bucket, store, receipts, save)).toEqual({
      stored: 0,
      skipped: 0,
      already: 2,
      failed: 1,
    });
    expect(receipts.has("monitor/org-3/flaky.example/2026-11-02T03:00:00.000Z")).toBe(false);

    // Next run succeeds and stores `flaky`.
    expect(await exportMonitorCopies(bucket, store, receipts, save)).toEqual({
      stored: 1,
      skipped: 0,
      already: 2,
    });
    expect(receipts.get("monitor/org-3/flaky.example/2026-11-02T03:00:00.000Z")?.outcome).toBe("stored");
  });

  it("excludes post-form walkthrough and member-account artefacts with durable skip records and runs exportBeforeRetraining", async () => {
    const dir = join(scratch, "store-retraining");
    const store = openStore(dir);
    const bucket = bucketWith({
      fetched: {
        label: "lure",
        source: "pipeline",
        text: "Fetched public landing page",
      },
      walked: {
        label: "lure",
        source: "pipeline",
        captureKey: "monitor/org-1/walked.example/walkthrough/step-2/",
        text: "Post-form walkthrough capture",
      },
    });
    // Also place a non-monitor prefix in `training/` to prove boundary exclusion.
    bucket.objects.set("training/walkthrough/case-9/done.json", "{}");
    bucket.objects.set("training/walkthrough/case-9/meta.json", "{}");

    const summary = await exportBeforeRetraining(bucket, store, () => new Date("2026-11-03T12:00:00.000Z"));
    expect(summary).toEqual({ stored: 1, skipped: 2, already: 0, intact: 1 });
    expect(store.manifest()).toHaveLength(1);
    expect(store.manifest()[0]?.host).toBe("fetched.example");

    const skips = readSkipManifest(dir);
    expect(skips).toHaveLength(2);
    expect(skips.map((s) => s.id).sort()).toEqual([
      "monitor/org-1/walked.example/2026-11-02T03:00:00.000Z",
      "walkthrough/case-9",
    ]);
    const status = JSON.parse(readFileSync(join(dir, "monitor-export-status.json"), "utf-8")) as {
      state: string;
      intact: number;
    };
    expect(status).toMatchObject({ state: "ok", intact: 1 });
  });
});
