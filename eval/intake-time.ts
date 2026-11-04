// Intake time measurement (D08 T02 section 8, D01 T01 section 3): measures `handleEmail` from delivery
// to the Workflow's start (`ANALYSIS.create`) for small forwards (~4 KiB) and near-25 MiB forwards (24 MiB,
// under MAX_MESSAGE_BYTES = 25 MiB), on the real schema in `node:sqlite`.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { IntakeRecord } from "./components.ts";

const NODE_LOADER = `data:text/javascript,${encodeURIComponent(`
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function load(url, context, nextLoad) {
  if (url.endsWith(".json")) {
    return { format: "module", shortCircuit: true, source: "export default " + readFileSync(fileURLToPath(url), "utf8") };
  }
  if (url.endsWith("src/intake/admit.ts")) {
    const raw = readFileSync(fileURLToPath(url), "utf8")
      .replace('override name = "RetryDelivery";', 'override name = "RetryDelivery";\\n  readonly retryAfterMs: number;')
      .replace(
        "readonly retryAfterMs = 5_000,\\n  ) {\\n    super(message);",
        "retryAfterMs = 5_000,\\n  ) {\\n    super(message);\\n    this.retryAfterMs = retryAfterMs;",
      );
    return { format: "module-typescript", shortCircuit: true, source: raw };
  }
  return nextLoad(url, context);
}
`)}`;

let tsResolved = false;
export function ensureTsResolve() {
  if (!tsResolved) {
    tsResolved = true;
    try {
      register("../scripts/lib/ts-resolve.mjs", import.meta.url);
      register(NODE_LOADER, import.meta.url);
    } catch {
      // already registered or running under vitest
    }
  }
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function createSqliteD1(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  const migDir = join(ROOT, "src/db/migrations");
  for (const file of readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(migDir, file), "utf8"));
  }
  const makeStmt = (sql: string, params: unknown[] = []): D1PreparedStatement => {
    const stmt = {
      bind: (...values: unknown[]) => makeStmt(sql, values),
      first: async <T = Record<string, unknown>>(col?: string): Promise<T | null> => {
        const row = sqlite.prepare(sql).get(...(params as (string | number | bigint | Uint8Array | null)[])) as
          | Record<string, unknown>
          | undefined;
        if (!row) return null;
        return (col ? row[col] : row) as T;
      },
      all: async <T = Record<string, unknown>>(): Promise<D1Result<T>> => {
        const results = sqlite.prepare(sql).all(...(params as (string | number | bigint | Uint8Array | null)[])) as T[];
        return { results, success: true, meta: { changes: 0 } as unknown as D1Result<T>["meta"] };
      },
      run: async (): Promise<D1Result<never>> => {
        const res = sqlite.prepare(sql).run(...(params as (string | number | bigint | Uint8Array | null)[]));
        return {
          results: [],
          success: true,
          meta: { changes: Number(res.changes) } as unknown as D1Result<never>["meta"],
        };
      },
      raw: async () => [],
      _sql: sql,
      _params: params,
    };
    return stmt as unknown as D1PreparedStatement;
  };
  return {
    prepare: (sql: string) => makeStmt(sql),
    batch: async <T = unknown>(stmts: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      sqlite.exec("BEGIN");
      try {
        const out: D1Result<T>[] = [];
        for (const s of stmts) {
          const inner = s as unknown as { _sql: string; _params: unknown[] };
          const isReturning = /\bRETURNING\b/i.test(inner._sql);
          if (isReturning) {
            const results = sqlite
              .prepare(inner._sql)
              .all(...(inner._params as (string | number | bigint | Uint8Array | null)[])) as T[];
            out.push({ results, success: true, meta: { changes: results.length } as unknown as D1Result<T>["meta"] });
          } else {
            const res = sqlite
              .prepare(inner._sql)
              .run(...(inner._params as (string | number | bigint | Uint8Array | null)[]));
            out.push({
              results: [],
              success: true,
              meta: { changes: Number(res.changes) } as unknown as D1Result<T>["meta"],
            });
          }
        }
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
    withSession: () => {
      throw new Error("not implemented");
    },
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

const EMAIL_ROUTING_AUTHSERV_ID = "mx.cloudflare.net";

function buildForwardBytes(from: string, messageId: string, targetBytes: number): Uint8Array {
  const domain = from.slice(from.indexOf("@") + 1);
  const auth = `${EMAIL_ROUTING_AUTHSERV_ID}; spf=pass smtp.mailfrom=${from}; dkim=pass header.d=${domain}`;
  const header = [
    `Authentication-Results: ${auth}`,
    `Message-ID: ${messageId}`,
    `From: ${from}`,
    "To: check@isitlegit.co.za",
    "Subject: Fwd: supplier invoice",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "---------- Forwarded message ---------",
    "From: Accounts <accounts@supplier.co.za>",
    "Subject: Invoice 1042",
    "",
  ].join("\r\n");
  const headBytes = new TextEncoder().encode(header);
  const padLen = Math.max(64, targetBytes - headBytes.byteLength - 2);
  const out = new Uint8Array(headBytes.byteLength + padLen + 2);
  out.set(headBytes, 0);
  out.fill(0x41, headBytes.byteLength, headBytes.byteLength + padLen);
  out[headBytes.byteLength + padLen] = 0x0d;
  out[headBytes.byteLength + padLen + 1] = 0x0a;
  return out;
}

export async function scoreIntakeTime(opts?: {
  smallCount?: number;
  largeCount?: number;
  largeBytes?: number;
}): Promise<IntakeRecord[]> {
  ensureTsResolve();
  const { handleEmail } = await import("../src/intake/email.ts");
  const smallCount = opts?.smallCount ?? 5;
  const largeCount = opts?.largeCount ?? 3;
  const largeBytes = opts?.largeBytes ?? 24 * 1024 * 1024;
  const db = createSqliteD1();
  const orgId = "org-intake-bench";
  const domain = "bench.co.za";
  const from = `finance@${domain}`;
  const at = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, ?, ?, 'tttttttttttttttt', 'verified', 'dns', ?, ?)",
    )
    .bind("d-bench", orgId, domain, at, at)
    .run();
  await db.prepare("INSERT INTO org_limits (org_id, daily_cases_override) VALUES (?, ?)").bind(orgId, 500).run();

  const objects = new Map<string, Uint8Array>();
  let workflowStartedAt = 0;
  const env = {
    DB: db,
    ARTEFACTS: {
      put: async (key: string, value: Uint8Array | ArrayBuffer) => {
        objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
      },
      delete: async (key: string) => {
        objects.delete(key);
      },
    },
    ANALYSIS: {
      create: async () => {
        workflowStartedAt = performance.now();
        return {};
      },
    },
  } as unknown as Env;

  const records: IntakeRecord[] = [];
  const specs: { band: "small" | "near-25mib"; bytes: number; count: number }[] = [
    { band: "small", bytes: 4 * 1024, count: smallCount },
    { band: "near-25mib", bytes: largeBytes, count: largeCount },
  ];
  let seq = 0;
  for (const spec of specs) {
    for (let i = 0; i < spec.count; i++) {
      seq++;
      const messageId = `<bench-${spec.band}-${seq}@${domain}>`;
      const rawBytes = buildForwardBytes(from, messageId, spec.bytes);
      const headers = new Headers({ "Message-ID": messageId });
      const forwardable = {
        from,
        to: "check@isitlegit.co.za",
        headers,
        raw: new Response(rawBytes).body as ReadableStream<Uint8Array>,
        rawSize: rawBytes.byteLength,
        setReject: () => {},
        forward: async () => ({ messageId: "" }),
        reply: async () => ({ messageId: "" }),
      } as unknown as ForwardableEmailMessage;
      workflowStartedAt = 0;
      const t0 = performance.now();
      const out = await handleEmail(forwardable, env, new Date(), () => {});
      const tEnd = workflowStartedAt > 0 ? workflowStartedAt : performance.now();
      if (out.kind === "admitted") {
        records.push({
          band: spec.band,
          bytes: rawBytes.byteLength,
          ms: Number((tEnd - t0).toFixed(3)),
          status: "ok",
        });
      } else {
        records.push({
          band: spec.band,
          bytes: rawBytes.byteLength,
          ms: null,
          status: "failed",
        });
      }
      // Clear large raw objects between iterations so RSS stays bounded.
      objects.clear();
    }
  }
  return records;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const records = await scoreIntakeTime();
  const outPath = join(ROOT, "eval/components/intake.json");
  writeFileSync(outPath, `${JSON.stringify(records, null, 1)}\n`);
  console.log(`wrote ${records.length} intake records to ${outPath}`);
}
