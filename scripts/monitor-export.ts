// Monitor training export (D05 T04 §10): copies each finished R2 `training/` copy into Loupe's
// local training store, once. R2 is read-only here: nothing is written or deleted in the bucket
// (no retention is set on training/, operator 2026-10-28). Each exported, skipped, retracted or
// removed copy gets an atomic per-item receipt in `monitor-export-receipts.json` reconciled
// against `store.readVerifiedPage` on every run, and skipped/retracted/removed items are also
// listed in `monitor-export-skips.json` in the store directory.
//
// Run (operator or systemd timer, credentials from the vault or local Wrangler OAuth, never printed):
//   node scripts/monitor-export.ts [--for-retraining] [--print-root]
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { openStore, revokeProductionAdmission, type Store, storeDir } from "./glimmer/store.ts";

export type BucketObject = { key: string };
export type BucketLike = {
  list: (prefix: string) => Promise<BucketObject[]>;
  getText: (key: string) => Promise<string | null>;
  getBytes: (key: string) => Promise<Uint8Array | null>;
};

export type ReceiptOutcome = "stored" | "skipped" | "retracted" | "removed";
export type Receipt = {
  page: string | null;
  outcome: ReceiptOutcome;
  label?: "lure" | "benign";
  updatedAt?: string;
  item?: string;
  reason?: string;
  at: string;
};
export type Receipts = Map<string, Receipt>;

export type SkipEntry = {
  id: string;
  outcome: "skipped" | "retracted" | "removed";
  reason: string;
  at: string;
};

function writeJsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

export function loadReceipts(path: string): Receipts {
  if (!existsSync(path)) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(path, "utf-8")) as Record<string, Receipt>));
  } catch {
    return new Map();
  }
}

export function saveReceipts(path: string, receipts: Receipts): void {
  writeJsonAtomic(path, Object.fromEntries(receipts));
  const skips: SkipEntry[] = [];
  for (const [id, receipt] of receipts.entries()) {
    if (receipt.outcome !== "stored") {
      skips.push({
        id,
        outcome: receipt.outcome,
        reason: receipt.reason ?? receipt.outcome,
        at: receipt.at,
      });
    }
  }
  const skipsPath = join(dirname(path), "monitor-export-skips.json");
  writeJsonAtomic(skipsPath, { skips });
}

export function readSkipManifest(dir: string): SkipEntry[] {
  const skipsPath = join(dir, "monitor-export-skips.json");
  if (!existsSync(skipsPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(skipsPath, "utf-8")) as { skips?: SkipEntry[] };
    return Array.isArray(parsed.skips) ? parsed.skips : [];
  } catch {
    return [];
  }
}

type CopyMeta = {
  trainingId?: string;
  orgId: string;
  host: string;
  captureKey: string;
  url: string | null;
  fetchedAt?: string | null;
  label: "lure" | "benign";
  why: string;
  source: string;
  sourceRef?: string;
  copiedAt?: string;
  updatedAt?: string;
  retracted?: boolean;
};

const TRAINING_PREFIX_PATTERN = /^training\/(monitor\/([^/]+)\/([^/]+)\/([^/]+))\/$/;

function buildItemId(meta: CopyMeta, id: string): string {
  const provenance = meta.sourceRef ?? `${meta.source}:${id}`;
  return `${id} (${meta.label} via ${provenance}: ${meta.why})`.slice(0, 500);
}

function removeOrNarrowPage(store: Store, pageId: string, itemIdPrefix: string, nowIso: string): void {
  const page = store.manifest({ tolerant: true }).find((p) => p.id === pageId);
  if (!page) return;
  const items = page.items ?? (page.item ? [{ id: page.item, lure: page.labels.lure }] : []);
  if (!items.some((entry) => entry.id.startsWith(itemIdPrefix))) return;
  const remaining = items.filter((entry) => !entry.id.startsWith(itemIdPrefix));
  if (remaining.length > 0) {
    const first = remaining[0];
    if (first?.lure !== undefined && page.labels.lure !== first.lure) {
      store.setLabels(pageId, { lure: first.lure }, { lure: "rule" });
    }
    if (page.items && page.items.length > 1) {
      store.keepItems(
        pageId,
        remaining.map((entry) => entry.id),
      );
    }
  } else {
    revokeProductionAdmission(store, [pageId], "monitor-export", nowIso);
    store.removePage(pageId);
  }
}

function removeCaptureFromStore(store: Store, id: string, pageHint: string | null | undefined, nowIso: string): void {
  const itemPrefix = `${id} (`;
  if (pageHint) {
    removeOrNarrowPage(store, pageHint, itemPrefix, nowIso);
  }
  for (const page of store.manifest({ tolerant: true }).filter((p) => p.source === "monitor")) {
    const entries = page.items ?? (page.item ? [{ id: page.item }] : []);
    if (entries.some((e) => e.id.startsWith(itemPrefix))) {
      removeOrNarrowPage(store, page.id, itemPrefix, nowIso);
    }
  }
}

function isValidHttpUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Store one finished copy. The mapping follows putPage's schema (scripts/glimmer/store.ts):
// source "monitor", origin "production" (a captured production page), boolean `labels: { lure }`,
// `label_source: { lure: "rule" }`, and the training identity + sourceRef carried in `item` and
// `items` (via `addItem` when two captures share content).
export async function exportOne(
  bucket: BucketLike,
  store: Store,
  prefix: string,
  now: () => Date = () => new Date(),
): Promise<{
  outcome: ReceiptOutcome;
  page?: string;
  label?: "lure" | "benign";
  updatedAt?: string;
  item?: string;
  reason?: string;
}> {
  const match = TRAINING_PREFIX_PATTERN.exec(prefix);
  if (!match || prefix.includes("..")) {
    return {
      outcome: "skipped",
      reason: "ineligible prefix: only monitor/<org>/<host>/<fetchedAt>/ public page captures are exported",
    };
  }
  const [, id, prefixOrg, prefixHost] = match;
  const metaText = await bucket.getText(`${prefix}meta.json`);
  if (!metaText) return { outcome: "skipped", reason: "meta.json could not be read" };
  let meta: CopyMeta;
  try {
    meta = JSON.parse(metaText) as CopyMeta;
  } catch {
    return { outcome: "skipped", reason: "meta.json is not valid JSON" };
  }
  if (!meta || typeof meta.orgId !== "string" || typeof meta.host !== "string" || typeof meta.captureKey !== "string") {
    return { outcome: "skipped", reason: "meta.json is missing required identity fields" };
  }
  if (meta.orgId !== prefixOrg) {
    return { outcome: "skipped", reason: "meta.json orgId does not match the training prefix" };
  }
  if (
    !meta.captureKey.startsWith(`monitor/${meta.orgId}/${meta.host}/`) ||
    /\/(walkthrough|art|raw)\//.test(meta.captureKey)
  ) {
    return {
      outcome: "skipped",
      reason: "ineligible captureKey: post-form walkthrough and member-account artefacts are excluded",
    };
  }
  if (meta.retracted) {
    const updatedAt = meta.updatedAt ?? meta.copiedAt;
    return {
      outcome: "retracted",
      ...(updatedAt ? { updatedAt } : {}),
      reason: meta.why || "retracted after finding restore",
    };
  }
  if (meta.label !== "lure" && meta.label !== "benign") {
    return { outcome: "skipped", reason: "meta.json has an invalid training label" };
  }
  const [screenshot, text] = await Promise.all([
    bucket.getBytes(`${prefix}screenshot.jpg`),
    bucket.getText(`${prefix}text.txt`),
  ]);
  if (!screenshot || text === null) return { outcome: "skipped", reason: "the fetched page could not be read" };
  const item = buildItemId(meta, id ?? `${meta.orgId}/${meta.host}`);
  const lure = meta.label === "lure";
  try {
    const page = await store.putPage("monitor", {
      origin: "production",
      licence: "Public lookalike page fetched by the IsItLegit monitor (D05 T04 section 10)",
      host: meta.host || prefixHost || null,
      template: null,
      south_africa: true,
      labels: { lure },
      label_source: { lure: "rule" },
      redacted: false,
      ...(isValidHttpUrl(meta.url) ? { url: meta.url } : {}),
      item,
      screenshot,
      text,
    });
    const current = store.manifest({ tolerant: true }).find((p) => p.id === page);
    if (current) {
      const sameIdPrefix = `${id ?? `${meta.orgId}/${meta.host}`} (`;
      const existingEntries = current.items ?? (current.item ? [{ id: current.item, lure: current.labels.lure }] : []);
      if (!existingEntries.some((entry) => entry.id === item && entry.lure === lure)) {
        store.addItem(page, { id: item, lure });
      }
      const keepIds: string[] = [];
      let placed = false;
      for (const entry of existingEntries) {
        if (entry.id.startsWith(sameIdPrefix)) {
          if (!placed) {
            keepIds.push(item);
            placed = true;
          }
        } else {
          keepIds.push(entry.id);
        }
      }
      if (!placed) keepIds.push(item);
      const afterAdd = store.manifest({ tolerant: true }).find((p) => p.id === page);
      if (
        afterAdd?.items &&
        (afterAdd.items.length !== keepIds.length || afterAdd.items.some((entry, idx) => entry.id !== keepIds[idx]))
      ) {
        store.keepItems(page, keepIds);
      }
      const afterKeep = store.manifest({ tolerant: true }).find((p) => p.id === page);
      if (afterKeep) {
        const activeEntries =
          afterKeep.items ?? (afterKeep.item ? [{ id: afterKeep.item, lure }] : [{ id: item, lure }]);
        const reconciledLure = activeEntries.every((e) => e.lure === activeEntries[0]?.lure)
          ? (activeEntries[0]?.lure ?? lure)
          : lure;
        if (afterKeep.labels.lure !== reconciledLure) {
          store.setLabels(page, { lure: reconciledLure }, { lure: "rule" });
        }
      }
    }
    const verified = store.readVerifiedPage(page);
    if (!verified) {
      throw new Error("the stored page failed read-back verification");
    }
    return {
      outcome: "stored",
      page,
      label: meta.label,
      updatedAt: meta.updatedAt ?? meta.copiedAt ?? now().toISOString(),
      item,
    };
  } catch (error) {
    if (
      error instanceof TypeError ||
      error instanceof RangeError ||
      (error as { name?: string } | null)?.name === "ZodError"
    ) {
      return { outcome: "skipped", reason: `the store refused the page (${(error as Error).message.slice(0, 120)})` };
    }
    throw error;
  }
}

export async function exportMonitorCopies(
  bucket: BucketLike,
  store: Store,
  receipts: Receipts,
  save: () => void,
  now: () => Date = () => new Date(),
): Promise<{ stored: number; skipped: number; already: number; failed?: number }> {
  const objects = await bucket.list("training/");
  const removedKeys = objects.map((o) => o.key).filter((k) => k.endsWith("removed.json"));
  const removedHostPrefixes = new Set<string>();
  const removedCaptureIds = new Set<string>();
  for (const key of removedKeys) {
    const withoutMarker = key.slice(0, -"removed.json".length);
    const id = withoutMarker.replace(/^training\//, "").replace(/\/$/, "");
    const parts = id.split("/");
    if (parts[0] === "monitor" && parts.length === 3) {
      removedHostPrefixes.add(`${id}/`);
    } else if (parts[0] === "monitor" && parts.length >= 4) {
      removedCaptureIds.add(id);
    }
  }

  let stored = 0;
  let skipped = 0;
  let already = 0;
  let failed = 0;
  const nowIso = () => now().toISOString();

  // Reconcile any removals against existing receipts and local store pages first.
  const allKnownIds = new Set<string>([...receipts.keys(), ...removedCaptureIds]);
  for (const page of store.manifest({ tolerant: true }).filter((p) => p.source === "monitor")) {
    const entries = page.items ?? (page.item ? [{ id: page.item }] : []);
    for (const entry of entries) {
      const idPart = entry.id.split(" (")[0];
      if (idPart) allKnownIds.add(idPart);
    }
  }
  for (const id of [...allKnownIds].sort()) {
    const isRemovedCapture =
      removedCaptureIds.has(id) || [...removedHostPrefixes].some((hp) => id.startsWith(hp) || `${id}/`.startsWith(hp));
    if (!isRemovedCapture) continue;
    const existing = receipts.get(id);
    if (existing?.outcome === "removed") {
      removeCaptureFromStore(store, id, existing.page, nowIso());
      already++;
      continue;
    }
    removeCaptureFromStore(store, id, existing?.page, nowIso());
    receipts.set(id, {
      page: null,
      outcome: "removed",
      reason: "removed at the business's request",
      at: nowIso(),
    });
    save();
    skipped++;
  }

  const prefixes = [
    ...new Set(
      objects
        .map((o) => o.key)
        .filter((k) => k.endsWith("done.json"))
        .map((k) => k.slice(0, -"done.json".length)),
    ),
  ].sort();

  for (const prefix of prefixes) {
    const id = prefix.replace(/^training\//, "").replace(/\/$/, "");
    if (
      removedCaptureIds.has(id) ||
      [...removedHostPrefixes].some((hp) => id.startsWith(hp) || `${id}/`.startsWith(hp))
    ) {
      continue;
    }
    const existing = receipts.get(id);
    if (existing) {
      if (existing.outcome === "skipped" || existing.outcome === "removed") {
        already++;
        continue;
      }
      let currentMeta: CopyMeta | null = null;
      try {
        const rawMeta = await bucket.getText(`${prefix}meta.json`);
        currentMeta = rawMeta ? (JSON.parse(rawMeta) as CopyMeta) : null;
      } catch {
        failed++;
        continue;
      }
      if (existing.outcome === "retracted") {
        if (!currentMeta || currentMeta.retracted) {
          removeCaptureFromStore(store, id, existing.page, nowIso());
          already++;
          continue;
        }
      } else if (existing.outcome === "stored") {
        if (currentMeta?.retracted) {
          removeCaptureFromStore(store, id, existing.page, nowIso());
          receipts.set(id, {
            page: null,
            outcome: "retracted",
            reason: currentMeta.why || "retracted after finding restore",
            ...(currentMeta.updatedAt ? { updatedAt: currentMeta.updatedAt } : {}),
            at: nowIso(),
          });
          save();
          skipped++;
          continue;
        }
        const verified = existing.page ? store.readVerifiedPage(existing.page) : null;
        const pageEntries = verified
          ? (verified.page.items ??
            (verified.page.item ? [{ id: verified.page.item, lure: verified.page.labels.lure }] : []))
          : [];
        const ownEntries = pageEntries.filter((entry) => entry.id.startsWith(`${id} (`));
        const hasOwnItem =
          verified !== null && ownEntries.length === 1 && (!existing.item || ownEntries[0]?.id === existing.item);
        const storedItemLure = ownEntries[0]?.lure ?? verified?.page.labels.lure;
        const expectedLabel = existing.label ?? (storedItemLure ? "lure" : "benign");
        const r2Label = currentMeta?.label ?? expectedLabel;
        if (verified && hasOwnItem && r2Label === expectedLabel && storedItemLure === (r2Label === "lure")) {
          already++;
          continue;
        }
      }
    }

    let result: Awaited<ReturnType<typeof exportOne>>;
    try {
      result = await exportOne(bucket, store, prefix, now);
    } catch {
      // Transient transport or local persistence failure: leave unreceipted so the next run retries it.
      failed++;
      continue;
    }

    if (result.outcome === "retracted") {
      removeCaptureFromStore(store, id, existing?.page, nowIso());
    }
    receipts.set(id, {
      page: result.page ?? null,
      outcome: result.outcome,
      ...(result.label ? { label: result.label } : {}),
      ...(result.updatedAt ? { updatedAt: result.updatedAt } : {}),
      ...(result.item ? { item: result.item } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      at: nowIso(),
    });
    save();
    if (result.outcome === "stored") stored++;
    else skipped++;
  }
  return failed > 0 ? { stored, skipped, already, failed } : { stored, skipped, already };
}

export async function exportBeforeRetraining(
  bucket: BucketLike,
  store: Store = openStore(),
  now: () => Date = () => new Date(),
): Promise<{ stored: number; skipped: number; already: number; intact: number }> {
  const receiptsPath = join(store.dir, "monitor-export-receipts.json");
  const receipts = loadReceipts(receiptsPath);
  const result = await exportMonitorCopies(bucket, store, receipts, () => saveReceipts(receiptsPath, receipts), now);
  if (result.failed && result.failed > 0) {
    throw new Error(`monitor-export: ${result.failed} training copies failed to read from R2`);
  }
  const verified = store.verify("monitor");
  if (verified.damaged.length > 0) {
    throw new Error(`monitor-export: ${verified.damaged.length} stored monitor pages failed verification`);
  }
  writeJsonAtomic(join(store.dir, "monitor-export-status.json"), {
    at: now().toISOString(),
    state: "ok",
    stored: result.stored,
    skipped: result.skipped,
    already: result.already,
    intact: verified.intact,
  });
  return {
    stored: result.stored,
    skipped: result.skipped,
    already: result.already,
    intact: verified.intact,
  };
}

async function resolveCloudflareCredentials(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ token: string; account: string } | null> {
  let token = env.CF_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
  let account = env.R2_ACCOUNT_ID || env.CF_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID;
  if (token && account) return { token, account };

  const home = env.HOME || homedir();
  const candidates = [
    join(home, ".config", ".wrangler", "config", "default.toml"),
    join(home, ".wrangler", "config", "default.toml"),
  ];
  const readTomlToken = () => {
    for (const file of candidates) {
      if (!existsSync(file)) continue;
      try {
        const raw = readFileSync(file, "utf-8");
        const match = /oauth_token\s*=\s*"([^"]+)"/.exec(raw);
        if (match?.[1]) return match[1];
      } catch {
        // continue
      }
    }
    return undefined;
  };
  if (!token) token = readTomlToken();
  if (!token) return null;

  const fetchAccount = async (bearer: string) => {
    const res = await fetch("https://api.cloudflare.com/client/v4/accounts", {
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { id?: string }[] };
    return body.result?.[0]?.id ?? null;
  };

  if (!account) {
    account = (await fetchAccount(token)) ?? undefined;
    if (!account) {
      // Refresh OAuth token via wrangler whoami and retry once.
      spawnSync("pnpm", ["exec", "wrangler", "whoami"], { stdio: "ignore", timeout: 30_000 });
      token = readTomlToken();
      if (token) account = (await fetchAccount(token)) ?? undefined;
    }
  }
  return token && account ? { token, account } : null;
}

export function createCloudflareR2Bucket(
  token: string,
  account: string,
  bucketName = "isitlegit-artefacts",
): BucketLike {
  const api = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucketName}/objects`;
  const headers = { authorization: `Bearer ${token}` };
  return {
    list: async (prefix) => {
      const out: BucketObject[] = [];
      let cursor: string | undefined;
      for (;;) {
        const url = `${api}?prefix=${encodeURIComponent(prefix)}&per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error(`R2 list answered ${res.status}`);
        const body = (await res.json()) as { result?: { key: string }[]; result_info?: { cursor?: string } };
        out.push(...(body.result ?? []).map((o) => ({ key: o.key })));
        cursor = body.result_info?.cursor;
        if (!cursor) return out;
      }
    },
    getText: async (key) => {
      const res = await fetch(`${api}/${encodeURIComponent(key)}`, { headers });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 getText answered ${res.status}`);
      return await res.text();
    },
    getBytes: async (key) => {
      const res = await fetch(`${api}/${encodeURIComponent(key)}`, { headers });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 getBytes answered ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

async function main(): Promise<void> {
  if (process.argv.includes("--print-root")) {
    console.log(storeDir());
    return;
  }
  const creds = await resolveCloudflareCredentials();
  const bucketName = process.env.R2_BUCKET ?? "isitlegit-artefacts";
  if (!creds) {
    console.error("CF_API_TOKEN and R2_ACCOUNT_ID (or local Wrangler OAuth login) are required, never printed.");
    process.exit(2);
  }
  const bucket = createCloudflareR2Bucket(creds.token, creds.account, bucketName);
  const store = openStore();
  if (process.argv.includes("--for-retraining")) {
    const summary = await exportBeforeRetraining(bucket, store);
    console.log(JSON.stringify({ event: "monitor-export", mode: "retraining", ...summary }));
    return;
  }
  const receiptsPath = join(store.dir, "monitor-export-receipts.json");
  const receipts = loadReceipts(receiptsPath);
  const result = await exportMonitorCopies(bucket, store, receipts, () => saveReceipts(receiptsPath, receipts));
  writeJsonAtomic(join(store.dir, "monitor-export-status.json"), {
    at: new Date().toISOString(),
    state: result.failed ? "partial" : "ok",
    ...result,
  });
  console.log(JSON.stringify({ event: "monitor-export", ...result }));
  if (result.failed) process.exit(1);
}

if (process.argv[1]?.endsWith("monitor-export.ts")) await main();
