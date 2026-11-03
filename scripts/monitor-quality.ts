// Live monitor pipeline quality and ablation evaluator (D05 T04 §12): runs the production
// `monitorPipeline` entrypoint across `full`, `no_reading`, `no_logo`, and `no_walkthrough` on the
// 40-page versioned corpus (`data/monitor/quality-corpus.json`), enforcing the pre-stated USD spend
// cap through `localBudget` and `metaLedger()`, and writing `data/monitor/quality-run.json`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

if (!process.execArgv.includes("--experimental-transform-types")) {
  const res = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  process.exit(res.status ?? 1);
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (
        (specifier.startsWith("./") || specifier.startsWith("../")) &&
        !specifier.endsWith(".ts") &&
        !specifier.endsWith(".js") &&
        !specifier.endsWith(".json")
      ) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw err;
    }
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".json")) {
      return {
        format: "module",
        shortCircuit: true,
        source: `export default ${readFileSync(fileURLToPath(url), "utf-8")};`,
      };
    }
    return nextLoad(url, context);
  },
});

import { sastDay } from "../src/meta/day.ts";
import { type Budget, BudgetExceeded } from "../src/meta/guard.ts";
import { localBudget } from "./lib/meta-budget.ts";
import {
  GATEWAY_URL,
  metaLedger,
  readLedger,
  readSecretsFromVault,
  reserveSpend,
  type Spend,
  settleSpend,
} from "./meta-smoke.ts";

type QualityArm = "full" | "no_reading" | "no_logo" | "no_walkthrough";
type CorpusItem = {
  id: string;
  screenshotPath: string;
  textPath: string;
  referenceScreenPath: string;
};

type SegmentBox = {
  concept: "logo" | "stamp" | "signature";
  left: number;
  top: number;
  right: number;
  bottom: number;
  confidence: number | null;
};

type MetaBaseCtx = {
  env: Record<string, string>;
  budget: Budget;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

const qualityModuleUrl = new URL("../src/monitor/quality.ts", import.meta.url).href;
const detectorModuleUrl = new URL("../src/vision/detector.ts", import.meta.url).href;
const samModuleUrl = new URL("../src/vision/sam.ts", import.meta.url).href;

const { evaluateMonitorCorpus, QualityCorpusSchema } = (await import(qualityModuleUrl)) as {
  evaluateMonitorCorpus: (
    corpus: unknown,
    deps: {
      createArmStorage: (arm: QualityArm) => Promise<unknown>;
      artefacts: {
        loadReferenceLogo: (item: CorpusItem, meta?: MetaBaseCtx) => Promise<Uint8Array>;
        loadCandidateScreenshot: (item: CorpusItem) => Promise<Uint8Array | null>;
        loadCandidateText: (item: CorpusItem) => Promise<string>;
        cropCandidateLogo: (
          item: CorpusItem,
          screenshot: Uint8Array,
          dataUrl: string,
          meta: MetaBaseCtx,
        ) => Promise<{ bytes: Uint8Array; mediaType: string; label: string } | null>;
      };
      metaEnv: Record<string, string>;
      fetch: typeof fetch;
      budget: Budget & { spentUsd: () => number };
      maxSpendUsd: number;
      isInterrupted?: () => boolean;
    },
  ) => Promise<{ complete: boolean; totalSpendUsd: number; stoppedReason?: string }>;
  QualityCorpusSchema: { parse: (raw: unknown) => unknown };
};

const { DETECTOR, groundLogos } = (await import(detectorModuleUrl)) as {
  DETECTOR: "sam" | "grounding";
  groundLogos: (
    ctx: MetaBaseCtx & {
      owner: { kind: "monitor"; run: string; host: string; step: string };
      waitUntil: (p: Promise<unknown>) => void;
    },
    imageDataUrl: string,
    size: { width: number; height: number },
  ) => Promise<SegmentBox[]>;
};

const { CROP_PADDING_PX, segment, selectBoxes } = (await import(samModuleUrl)) as {
  CROP_PADDING_PX: number;
  segment: (
    ctx: MetaBaseCtx & { owner: { kind: "monitor"; run: string; host: string; step: string } },
    imageDataUrl: string,
    concept: "logo",
  ) => Promise<SegmentBox[]>;
  selectBoxes: (boxes: readonly SegmentBox[], source?: { width: number; height: number }) => SegmentBox[];
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadDevVars(root = ROOT): Record<string, string> {
  const out: Record<string, string> = {};
  const file = join(root, ".dev.vars");
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, "utf-8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const val = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    out[key] = val;
  }
  return out;
}

type SqliteStmt = {
  bind: (...values: unknown[]) => SqliteStmt;
  first: <T = Record<string, unknown>>(colName?: string) => Promise<T | null>;
  all: <T = Record<string, unknown>>() => Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }>;
  run: () => Promise<{ results: unknown[]; success: boolean; meta: Record<string, unknown> }>;
  raw: <T = unknown[]>() => Promise<T[]>;
};

function createSqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  const migrationsDir = join(ROOT, "src/db/migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const sql = readFileSync(join(migrationsDir, f), "utf-8");
    sqlite.exec(sql);
  }

  const makeStmt = (sql: string, bound: unknown[] = []): SqliteStmt => {
    const normalizeVal = (v: unknown) => (v === undefined ? null : v);
    const params = bound.map(normalizeVal) as (string | number | bigint | Uint8Array | null)[];
    return {
      bind: (...values: unknown[]) => makeStmt(sql, values),
      first: async <T = Record<string, unknown>>(colName?: string): Promise<T | null> => {
        const stmt = sqlite.prepare(sql);
        const row = stmt.get(...params) as Record<string, unknown> | undefined;
        if (!row) return null;
        if (colName) return (row[colName] as T) ?? null;
        return row as T;
      },
      all: async <T = Record<string, unknown>>() => {
        const stmt = sqlite.prepare(sql);
        const isReader = /^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
        if (isReader) {
          const rows = stmt.all(...params) as T[];
          return {
            results: rows,
            success: true,
            meta: {
              duration: 0,
              changes: 0,
              last_row_id: 0,
              changed_db: false,
              size_after: 0,
              rows_read: rows.length,
              rows_written: 0,
            },
          };
        }
        const info = stmt.run(...params);
        return {
          results: [] as T[],
          success: true,
          meta: {
            duration: 0,
            changes: Number(info.changes),
            last_row_id: Number(info.lastInsertRowid),
            changed_db: Number(info.changes) > 0,
            size_after: 0,
            rows_read: 0,
            rows_written: Number(info.changes),
          },
        };
      },
      run: async () => {
        const stmt = sqlite.prepare(sql);
        const info = stmt.run(...params);
        return {
          results: [],
          success: true,
          meta: {
            duration: 0,
            changes: Number(info.changes),
            last_row_id: Number(info.lastInsertRowid),
            changed_db: Number(info.changes) > 0,
            size_after: 0,
            rows_read: 0,
            rows_written: Number(info.changes),
          },
        };
      },
      raw: async <T = unknown[]>(): Promise<T[]> => {
        const stmt = sqlite.prepare(sql);
        const rows = stmt.all(...params) as Record<string, unknown>[];
        return rows.map((r) => Object.values(r) as unknown as T);
      },
    };
  };

  return {
    prepare: (sql: string) => makeStmt(sql),
    batch: async <T = unknown>(statements: SqliteStmt[]) => {
      const out: { results: T[]; success: boolean; meta: Record<string, unknown> }[] = [];
      for (const s of statements) {
        out.push(await s.all<T>());
      }
      return out;
    },
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
    withSession: () => {
      throw new Error("not implemented");
    },
    dump: async () => new ArrayBuffer(0),
  };
}

function createMemoryR2() {
  const objects = new Map<string, Uint8Array>();
  return {
    put: async (key: string, value: unknown) => {
      const bytes =
        value instanceof Uint8Array
          ? new Uint8Array(value)
          : typeof value === "string"
            ? new TextEncoder().encode(value)
            : value instanceof ArrayBuffer
              ? new Uint8Array(value)
              : new Uint8Array();
      objects.set(key, bytes);
      return { key, size: bytes.byteLength };
    },
    get: async (key: string) => {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return {
        key,
        size: bytes.byteLength,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        text: async () => new TextDecoder().decode(bytes),
        json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      };
    },
    head: async (key: string) => {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return { key, size: bytes.byteLength };
    },
    delete: async (key: string | string[]) => {
      for (const k of Array.isArray(key) ? key : [key]) objects.delete(k);
    },
    list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }),
  };
}

function createMemoryKv() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

async function createArmStorage(_arm: QualityArm) {
  const db = createSqliteD1();
  const bucket = createMemoryR2();
  const kv = createMemoryKv();
  return {
    db,
    bucket,
    store: { bucket, db },
    kv,
  };
}

const refLogoCache = new Map<string, Uint8Array>();

async function detectAndCropLogo(
  screenshot: Uint8Array,
  dataUrl: string,
  meta: MetaBaseCtx,
): Promise<Uint8Array | null> {
  const metadata = await sharp(screenshot).metadata();
  const size = { width: metadata.width ?? 1280, height: metadata.height ?? 800 };
  const owner = { kind: "monitor" as const, run: "quality", host: "page", step: "logo" };
  const samBoxes = await segment({ ...meta, owner }, dataUrl, "logo").catch(() => []);
  const boxes =
    samBoxes.length > 0 || DETECTOR === "sam"
      ? samBoxes
      : await groundLogos({ ...meta, owner, waitUntil: () => {} }, dataUrl, size).catch(() => []);
  const selected = selectBoxes(boxes, size);
  const box = selected[0];
  if (!box) return null;
  const left = Math.max(0, box.left - CROP_PADDING_PX);
  const top = Math.max(0, box.top - CROP_PADDING_PX);
  const right = Math.min(size.width, box.right + CROP_PADDING_PX);
  const bottom = Math.min(size.height, box.bottom + CROP_PADDING_PX);
  if (right <= left || bottom <= top) return null;
  const buf = await sharp(screenshot)
    .extract({ left, top, width: right - left, height: bottom - top })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

async function main() {
  let maxSpendUsd = 2.5;
  let outPath = join(ROOT, "data/monitor/quality-run.json");
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--cap-usd") {
      maxSpendUsd = Number(process.argv[++i]);
    } else if (arg === "--out") {
      outPath = resolve(process.argv[++i] ?? outPath);
    }
  }
  if (!Number.isFinite(maxSpendUsd) || maxSpendUsd <= 0 || maxSpendUsd > 3.0) {
    throw new Error(`Invalid --cap-usd ${maxSpendUsd}: must be in (0, 3.00]`);
  }

  const devVars = loadDevVars();
  const vault =
    process.env.META_API_KEY && process.env.CF_AIG_TOKEN
      ? { meta: process.env.META_API_KEY, run: process.env.CF_AIG_TOKEN, admin: "" }
      : devVars.META_API_KEY && devVars.CF_AIG_TOKEN
        ? { meta: devVars.META_API_KEY, run: devVars.CF_AIG_TOKEN, admin: "" }
        : await readSecretsFromVault();
  const metaEnv = {
    META_API_KEY: process.env.META_API_KEY || devVars.META_API_KEY || vault.meta || "",
    CF_AIG_TOKEN: process.env.CF_AIG_TOKEN || devVars.CF_AIG_TOKEN || vault.run || "",
    META_GATEWAY_URL: process.env.META_GATEWAY_URL || devVars.META_GATEWAY_URL || GATEWAY_URL,
  };
  if (!metaEnv.META_API_KEY || !metaEnv.CF_AIG_TOKEN) {
    throw new Error("META_API_KEY and CF_AIG_TOKEN are required in environment, .dev.vars, or vault");
  }

  const corpusRaw = JSON.parse(readFileSync(join(ROOT, "data/monitor/quality-corpus.json"), "utf-8"));
  const corpus = QualityCorpusSchema.parse(corpusRaw);

  const d1Budget = localBudget("monitor-quality");
  const d1RunId = crypto.randomUUID();
  const d1Call = { callId: crypto.randomUUID(), owner: { kind: "script" as const, name: "monitor-quality" } };
  await d1Budget.reserve("muse-spark-1.3", maxSpendUsd, 1, d1RunId, d1Call);

  const ledgerFile = metaLedger();
  const ledger = readLedger(ledgerFile);
  const runId = `monitor-quality:${new Date().toISOString()}`;
  const reservations = new Map<string, Spend>();
  let callSeq = 0;
  let runSpentUsd = 0;
  let hadUncertain = false;

  const trackedBudget: Budget & { spentUsd: () => number } = {
    reserve: async (model, estimateUsd) => {
      if (runSpentUsd + estimateUsd > maxSpendUsd) {
        throw new BudgetExceeded("day", model);
      }
      const id = `mq-${++callSeq}`;
      const reserved = reserveSpend(ledgerFile, ledger, {
        date: sastDay(new Date()),
        run: runId,
        call: `${id}:${model}`,
        estimate: estimateUsd,
      });
      if ("refused" in reserved) {
        throw new Error(reserved.refused);
      }
      reservations.set(id, reserved.entry);
      return id;
    },
    settle: async (id, actualUsd) => {
      const entry = reservations.get(id);
      reservations.delete(id);
      if (entry) {
        settleSpend(ledgerFile, ledger, entry, actualUsd);
      }
      runSpentUsd += actualUsd;
    },
    uncertain: async (id) => {
      hadUncertain = true;
      const entry = reservations.get(id);
      reservations.delete(id);
      if (entry) {
        settleSpend(ledgerFile, ledger, entry, null);
        runSpentUsd += entry.estimate;
      }
    },
    refused: async () => {},
    outputFailed: async () => {},
    cached: async () => {},
    spentUsd: () => runSpentUsd,
  };

  let interrupted = false;
  process.once("SIGINT", () => {
    interrupted = true;
  });

  const startedAt = Date.now();
  let report: Awaited<ReturnType<typeof evaluateMonitorCorpus>>;
  try {
    report = await evaluateMonitorCorpus(corpus, {
      createArmStorage: async (arm) => {
        console.error(`[monitor-quality] starting arm: ${arm} (spent so far: $${runSpentUsd.toFixed(4)})`);
        return createArmStorage(arm);
      },
      artefacts: {
        loadReferenceLogo: async (item, meta) => {
          const abs = join(ROOT, item.referenceScreenPath);
          const cached = refLogoCache.get(abs);
          if (cached) return cached;
          const raw = new Uint8Array(readFileSync(abs));
          const b64 = Buffer.from(raw).toString("base64");
          const detected = meta ? await detectAndCropLogo(raw, `data:image/jpeg;base64,${b64}`, meta) : null;
          const out =
            detected ??
            new Uint8Array(await sharp(abs).extract({ left: 32, top: 12, width: 320, height: 64 }).png().toBuffer());
          refLogoCache.set(abs, out);
          return out;
        },
        loadCandidateScreenshot: async (item) => {
          const p = join(ROOT, item.screenshotPath);
          return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
        },
        loadCandidateText: async (item) => readFileSync(join(ROOT, item.textPath), "utf-8"),
        cropCandidateLogo: async (_item, screenshot, dataUrl, meta) => {
          const bytes = await detectAndCropLogo(screenshot, dataUrl, meta);
          return bytes ? { bytes, mediaType: "image/png", label: "the page's logo crop" } : null;
        },
      },
      metaEnv,
      fetch: globalThis.fetch,
      budget: trackedBudget,
      maxSpendUsd,
      isInterrupted: () => interrupted,
    });
  } catch (err) {
    await d1Budget.uncertain(d1RunId, {
      ms: Date.now() - startedAt,
      outcome: "error",
      certainty: "estimated",
      source: "estimate",
    });
    throw err;
  }

  if (report.complete && !hadUncertain) {
    await d1Budget.settle(d1RunId, report.totalSpendUsd, {
      ms: Date.now() - startedAt,
      outcome: "ok",
      certainty: "measured",
      source: "meta-usage",
    });
  } else {
    await d1Budget.uncertain(d1RunId, {
      ms: Date.now() - startedAt,
      outcome: "error",
      certainty: "estimated",
      source: "estimate",
    });
  }

  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(tmp, outPath);
  console.log(
    JSON.stringify({
      event: "monitor-quality",
      complete: report.complete,
      totalSpendUsd: report.totalSpendUsd,
      outPath,
    }),
  );
  if (!report.complete) process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
