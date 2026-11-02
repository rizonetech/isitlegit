// The admin eval runs page (D08 T02 §9; design/SPEC.md X5): every run in a table with its own published figures,
// the five target tiles of the latest published report with their states kept honest, the ablation table, the
// CLI guidance that replaces the board's Start a run button, and the two document links. Behind Access: without
// a valid Access JWT the page is refused; a failed or damaged read is the error page, never a figure.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authEnv, call } from "../auth/helpers";

const db = env.DB;

const TEAM = "team.example.cloudflareaccess.com";
const AUD = "test-aud-tag";
const OPERATOR = "hostmaster@rizonetech.com";
const SIGNIN = "derick@rizonetech.com";
const workerEnv = {
  ...authEnv,
  CF_ACCESS_AUD: AUD,
  CF_ACCESS_TEAM_DOMAIN: TEAM,
  CF_ACCESS_EMAIL: SIGNIN,
  OPERATOR_EMAIL: OPERATOR,
} as unknown as Env;

const b64url = (bytes: Uint8Array | string) => {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return btoa(String.fromCharCode(...raw))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};
async function makeKey(kid: string) {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } as JsonWebKey };
}
const key = await makeKey("kid-1");
const outerFetch: typeof fetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith(`https://${TEAM}/cdn-cgi/access/certs`)) return Response.json({ keys: [key.jwk] });
  return outerFetch(input, init);
}) as typeof fetch;
async function jwt(): Promise<string> {
  const head = b64url(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT" }));
  const body = b64url(
    JSON.stringify({ aud: AUD, iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 600, email: SIGNIN }),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${head}.${body}`)),
  );
  return `${head}.${body}.${b64url(sig)}`;
}

const get = async (path: string, withAccess = true) =>
  call(
    path,
    { headers: { accept: "text/html", ...(withAccess ? { "cf-access-jwt-assertion": await jwt() } : {}) } },
    workerEnv,
  );
const words = (html: string) =>
  html
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const text = (html: string) =>
  words(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

beforeEach(async () => {
  for (const t of ["eval_published", "eval_results", "eval_runs", "feedback"])
    await db.prepare(`DELETE FROM ${t}`).run();
});
afterEach(() => vi.restoreAllMocks());

const rate = (n: number, hits: number) => ({ n, hits, rate: n ? hits / n : null });
function report(
  id: string,
  over: { commit?: string; complete?: boolean; detection?: number; fp?: number; started?: string } = {},
) {
  const attacks = 100;
  const genuine = 50;
  const detected = Math.round((over.detection ?? 0.96) * attacks);
  const fps = Math.round((over.fp ?? 0) * genuine);
  const complete = over.complete ?? true;
  const state = (ok: boolean) => (complete ? (ok ? "met" : "missed") : "incomplete");
  return {
    run: {
      id,
      mode: "full",
      commit: over.commit ?? "abcdef1234567",
      setVersion: "a".repeat(64),
      sets: ["synthetic-sa"],
      sampleLimit: null,
      status: complete ? "complete" : "incomplete",
      selected: attacks + genuine,
      stored: attacks + genuine,
      startedAt: over.started ?? "2026-11-05T10:00:00.000Z",
      finishedAt: "2026-11-05T10:30:00.000Z",
    },
    complete,
    main: {
      attacks,
      genuine,
      measuredGenuine: genuine,
      detection: rate(attacks, detected),
      falsePositives: rate(genuine, fps),
      byCategory: {},
      modelBasis: rate(40, 36),
      checksBasis: rate(60, 60),
      analysisMs: { n: 150, median: 3500, p95: 9000 },
      costUsd: { n: 150, median: 0.031, total: 4.65 },
    },
    targets: [
      {
        name: "detection",
        figure: detected / attacks,
        figureText: `${((detected / attacks) * 100).toFixed(1)}%`,
        threshold: "at least 95.0%",
        denominator: attacks,
        state: state(detected / attacks >= 0.95),
      },
      {
        name: "false positives",
        figure: fps / genuine,
        figureText: `${((fps / genuine) * 100).toFixed(1)}%`,
        threshold: "at most 2.0%",
        denominator: genuine,
        state: state(fps / genuine <= 0.02),
      },
      {
        name: "median cost per case",
        figure: 0.031,
        figureText: "US$0.0310",
        threshold: "under US$0.0500",
        denominator: 150,
        state: state(0.031 < 0.05),
      },
      {
        name: "forward-to-reply time",
        figure: null,
        figureText: "not measured",
        threshold: "median under 60 s, p95 under 180 s",
        denominator: 0,
        state: "not measured",
        note: "measured by the live mail run (D09 T01 §1)",
      },
    ],
  };
}

async function seedRun(
  id: string,
  status: "running" | "complete" | "incomplete" | "aborted",
  started: string,
  finished: string | null = "2026-11-05T10:30:00.000Z",
) {
  await db
    .prepare(
      "INSERT INTO eval_runs (id, commit_sha, set_version, mode, sets, status, selected, cap_usd, started_at, finished_at, cost_usd) VALUES (?, 'abcdef1234567', ?, 'full', 'synthetic-sa', ?, 150, 13, ?, ?, 1.5)",
    )
    .bind(id, "a".repeat(64), status, started, status === "running" ? null : finished)
    .run();
}
async function publish(r: ReturnType<typeof report>, at: string) {
  await db
    .prepare("INSERT INTO eval_published (run_id, mode, report_json, published_at) VALUES (?, 'full', ?, ?)")
    .bind(r.run.id, JSON.stringify(r), at)
    .run();
}

describe("the admin eval runs page", () => {
  it("refuses the page without Access", async () => {
    const res = await get("/admin/eval", false);
    expect(res.status).toBe(403);
  });

  it("lists every run with its own figures and keeps the tiles honest", async () => {
    await seedRun("run-new", "complete", "2026-11-05T10:00:00.000Z");
    await publish(report("run-new", { detection: 0.96, fp: 0 }), "2026-11-05T11:00:00.000Z");
    await seedRun("run-old", "complete", "2026-11-04T10:00:00.000Z");
    await publish(
      report("run-old", { detection: 0.5, fp: 0.1, started: "2026-11-04T10:00:00.000Z" }),
      "2026-11-04T11:00:00.000Z",
    );
    await seedRun("run-draft", "incomplete", "2026-11-05T12:00:00.000Z");
    await seedRun("run-live", "running", "2026-11-05T13:00:00.000Z", null);

    const res = await get("/admin/eval");
    expect(res.status).toBe(200);
    const html = words(await res.text());
    const t = text(html);
    // Each published row carries its own figures, never the latest run's repeated.
    expect(t).toContain("96.0%");
    expect(t).toContain("50.0%");
    expect(t).toContain("10.0%");
    expect(t).toContain("Not published");
    expect(t).toContain("incomplete");
    expect(t).toContain("running");
    // The five tiles of the latest published report, with states in words.
    expect(t).toContain("Detection on attacks");
    expect(t).toContain("False alarms on genuine");
    expect(t).toContain("Median to reply");
    expect(t).toContain("95th percentile");
    expect(t).toContain("Median model cost");
    expect(t).toContain("Target met");
    // Reply time is not measured by these runs: its tiles say so, and no tile borrows the analysis time.
    expect(t).toContain("Not measured");
    expect(t).toContain("Median to reply Not measured");
    // The board's two links and the CLI guidance that replaces the Start a run button.
    expect(html).toContain("eval/RESULTS.md");
    expect(html).toContain("blob/abcdef1234567/eval/RESULTS.md");
    expect(html).toContain("docs/frontier-log.md");
    expect(t).toContain("pnpm eval:run");
    expect(t).toContain("US$13.00");
  });

  it("shows runs without figures and Not measured tiles when nothing is published", async () => {
    await seedRun("run-only", "complete", "2026-11-05T10:00:00.000Z");
    const res = await get("/admin/eval");
    expect(res.status).toBe(200);
    const t = text(await res.text());
    expect(t).toContain("run-only".slice(0, 4));
    expect(t).toContain("Not published");
    expect(t).toContain("Not measured");
    expect(t).not.toContain("96.0%");
  });

  it("shows the placeholder before the first run", async () => {
    const res = await get("/admin/eval");
    expect(res.status).toBe(200);
    const t = text(await res.text());
    expect(t).toContain("No eval runs yet");
  });

  it("never reads Target met from an incomplete report", async () => {
    await seedRun("run-half", "incomplete", "2026-11-05T10:00:00.000Z");
    await publish(report("run-half", { complete: false }), "2026-11-05T11:00:00.000Z");
    const res = await get("/admin/eval");
    const t = text(await res.text());
    expect(t).toContain("Run incomplete");
    expect(t).not.toContain("Target met");
  });

  it("shows the error page with a retry when the database fails, and no figure", async () => {
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/eval_runs|eval_published/.test(sql)) throw new Error("d1 down");
      return prepare(sql);
    });
    const res = await get("/admin/eval");
    expect(res.status).toBe(503);
    const html = words(await res.text());
    expect(html).toContain('href="/admin/eval"');
    expect(text(html)).not.toMatch(/\d+\.\d%/);
  });

  it("treats a damaged published report as an error, never a figure", async () => {
    await seedRun("run-bad", "complete", "2026-11-05T10:00:00.000Z");
    await db
      .prepare(
        "INSERT INTO eval_published (run_id, mode, report_json, published_at) VALUES ('run-bad', 'full', '{\"main\": 1}', '2026-11-05T11:00:00.000Z')",
      )
      .run();
    const res = await get("/admin/eval");
    expect(res.status).toBe(503);
    expect(text(await res.text())).not.toMatch(/\d+\.\d%/);
  });
});
