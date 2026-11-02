// Monitor training export (D05 T04 §10): copies each finished R2 `training/` copy into Loupe's
// local training store, once. R2 is read-only here: nothing is written or deleted in the bucket
// (no retention is set on training/, operator 2026-10-28). Each exported or skipped copy gets a
// durable receipt in the store, so an interrupted run resumes after it and a stored finding is
// never stored twice; a copy whose screenshot is not a decodable JPEG is skipped with its
// reason recorded, never silently dropped.
//
// Run (operator, from the vault, credentials never printed):
//   CF_API_TOKEN=... R2_ACCOUNT_ID=... R2_BUCKET=isitlegit-artefacts node scripts/monitor-export.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore, type Store } from "./glimmer/store";

export type BucketObject = { key: string };
export type BucketLike = {
  list: (prefix: string) => Promise<BucketObject[]>;
  getText: (key: string) => Promise<string | null>;
  getBytes: (key: string) => Promise<Uint8Array | null>;
};

type Receipt = { page: string | null; outcome: "stored" | "skipped"; reason?: string; at: string };
export type Receipts = Map<string, Receipt>;

export function loadReceipts(path: string): Receipts {
  if (!existsSync(path)) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(path, "utf-8")) as Record<string, Receipt>));
  } catch {
    return new Map();
  }
}
export function saveReceipts(path: string, receipts: Receipts): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(Object.fromEntries(receipts), null, 2)}\n`);
}

type CopyMeta = {
  orgId: string;
  host: string;
  captureKey: string;
  url: string | null;
  label: "lure" | "benign";
  why: string;
  source: string;
};

// Store one finished copy. The mapping follows putPage's schema (scripts/glimmer/store.ts):
// origin "production" (a captured production page), the lure label derived by the monitor's
// own settlement rule, the training identity carried as the store item for provenance.
export async function exportOne(
  bucket: BucketLike,
  store: Store,
  prefix: string,
): Promise<{ outcome: "stored" | "skipped"; page?: string; reason?: string }> {
  const metaText = await bucket.getText(`${prefix}meta.json`);
  if (!metaText) return { outcome: "skipped", reason: "meta.json could not be read" };
  let meta: CopyMeta;
  try {
    meta = JSON.parse(metaText) as CopyMeta;
  } catch {
    return { outcome: "skipped", reason: "meta.json is not valid JSON" };
  }
  const [screenshot, text] = await Promise.all([
    bucket.getBytes(`${prefix}screenshot.jpg`),
    bucket.getText(`${prefix}text.txt`),
  ]);
  if (!screenshot || text === null) return { outcome: "skipped", reason: "the fetched page could not be read" };
  try {
    const page = await store.putPage("monitor", {
      origin: "production",
      licence: "Public lookalike page fetched by the IsItLegit monitor (D05 T04 section 10)",
      host: meta.host,
      template: null,
      south_africa: true,
      labels: { lure: meta.label === "lure" },
      label_source: { lure: "rule" },
      redacted: false,
      ...(meta.url ? { url: meta.url } : {}),
      item: `${meta.orgId}/${meta.host}/${meta.captureKey.split("/").at(3) ?? ""} (${meta.source}: ${meta.why})`.slice(
        0,
        500,
      ),
      screenshot,
      text,
    });
    return { outcome: "stored", page };
  } catch (error) {
    return { outcome: "skipped", reason: `the store refused the page (${(error as Error).message.slice(0, 120)})` };
  }
}

export async function exportMonitorCopies(
  bucket: BucketLike,
  store: Store,
  receipts: Receipts,
  save: () => void,
  now: () => Date = () => new Date(),
): Promise<{ stored: number; skipped: number; already: number }> {
  const objects = await bucket.list("training/");
  const prefixes = [
    ...new Set(
      objects
        .map((o) => o.key)
        .filter((k) => k.endsWith("done.json"))
        .map((k) => k.slice(0, -"done.json".length)),
    ),
  ].sort();
  let stored = 0;
  let skipped = 0;
  let already = 0;
  for (const prefix of prefixes) {
    const id = prefix.replace(/^training\//, "").replace(/\/$/, "");
    if (receipts.has(id)) {
      already++;
      continue;
    }
    const result = await exportOne(bucket, store, prefix);
    receipts.set(id, {
      page: result.page ?? null,
      outcome: result.outcome,
      ...(result.reason ? { reason: result.reason } : {}),
      at: now().toISOString(),
    });
    save();
    if (result.outcome === "stored") stored++;
    else skipped++;
  }
  return { stored, skipped, already };
}

async function main(): Promise<void> {
  const token = process.env.CF_API_TOKEN;
  const account = process.env.R2_ACCOUNT_ID;
  const bucketName = process.env.R2_BUCKET ?? "isitlegit-artefacts";
  if (!token || !account) {
    console.error("CF_API_TOKEN and R2_ACCOUNT_ID are required (from the vault, never printed).");
    process.exit(2);
  }
  const api = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucketName}/objects`;
  const headers = { authorization: `Bearer ${token}` };
  const bucket: BucketLike = {
    list: async (prefix) => {
      const out: BucketObject[] = [];
      let cursor: string | undefined;
      for (;;) {
        const url = `${api}?prefix=${encodeURIComponent(prefix)}&per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error(`R2 list answered ${res.status}`);
        const body = (await res.json()) as { result: { key: string }[]; result_info?: { cursor?: string } };
        out.push(...body.result.map((o) => ({ key: o.key })));
        cursor = body.result_info?.cursor;
        if (!cursor) return out;
      }
    },
    getText: async (key) => {
      const res = await fetch(`${api}/${encodeURIComponent(key)}`, { headers });
      return res.ok ? await res.text() : null;
    },
    getBytes: async (key) => {
      const res = await fetch(`${api}/${encodeURIComponent(key)}`, { headers });
      return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    },
  };
  const store = openStore();
  const receiptsPath = join(store.dir, "monitor-export-receipts.json");
  const receipts = loadReceipts(receiptsPath);
  const result = await exportMonitorCopies(bucket, store, receipts, () => saveReceipts(receiptsPath, receipts));
  console.log(JSON.stringify({ event: "monitor-export", ...result }));
}

if (process.argv[1]?.endsWith("monitor-export.ts")) await main();
