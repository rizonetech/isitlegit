import { expect, it } from "vitest";
import type { PublicEvidence } from "../../eval/paired-evidence.ts";

it("aligns repeated summaries without losing duplicate findings or severity changes", async () => {
  const { alignEvidence } = await import("../../eval/paired-evidence.ts");
  const source: PublicEvidence[] = [
    { id: "E2", check: "bank.change", severity: "high", summary: "Changed account" },
    { id: "E1", check: "bank.change", severity: "high", summary: "Changed account" },
  ];
  const replay: PublicEvidence[] = [
    { id: "E9", check: "bank.change", severity: "critical", summary: "Changed account" },
    { id: "E8", check: "bank.change", severity: "high", summary: "Changed account" },
  ];
  expect(alignEvidence(source, replay)).toEqual([
    {
      check: "bank.change",
      changes: [
        { kind: "unchanged", source: source[1], replay: replay[1] },
        { kind: "severity-changed", source: source[0], replay: replay[0] },
      ],
    },
  ]);
});

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { compareRuns, comparisonText, pairedEvidenceCommand } from "../../eval/metrics.ts";
import {
  alignEvidence,
  liveEvidenceReader,
  type PairedDeps,
  pairedCommand,
  renderPaired,
  type Snapshot,
} from "../../eval/paired-evidence.ts";
import type { ResultRow, RunRow } from "../../eval/run.ts";
import { inline } from "../../src/meta/budget-sql.ts";

function fixture() {
  const sample = "synthetic-sa/invoice.eml";
  const run = (id: string, mode: string): RunRow => ({
    id,
    mode,
    commitSha: "b".repeat(40),
    setVersion: "a".repeat(64),
    sets: ["synthetic-sa"],
    sampleLimit: null,
    status: "complete",
    selected: 1,
    capUsd: 1,
    costUsd: 0,
    startedAt: "2026-11-04T08:00:00.000Z",
    finishedAt: "2026-11-04T08:01:00.000Z",
  });
  const row = (runId: string, caseId: string, verdict: ResultRow["verdict"]): ResultRow => ({
    runId,
    caseId,
    sample,
    verdict,
    outcome: "done",
    label: "attack",
    category: "invoice",
    ms: 1000,
    costUsd: 0,
    criticalFound: false,
    httpStatus: 201,
    detail: null,
  });
  const source = { run: run("source-0001", "full"), results: [row("source-0001", "case-source", "safe")] };
  const replay = {
    run: run("replay-0001", "replay:source-0001"),
    results: [row("replay-0001", "case-replay", "suspicious")],
  };
  const snapshots = new Map<string, Snapshot>(
    [source, replay].map((r) => {
      const item = r.results[0];
      if (!item?.caseId) throw new Error("fixture");
      return [
        item.caseId,
        {
          caseId: item.caseId,
          analysisRun: item.caseId,
          verdict: item.verdict,
          status: "done",
          createdAt: "2026-11-04T08:00:00.000Z",
          updatedAt: "2026-11-04T08:00:01.000Z",
          evidence: [
            { id: "E1", check: "bank.change", severity: r === source ? "info" : "high", summary: "Changed account" },
          ],
        },
      ];
    }),
  );
  const reads: string[] = [];
  const d: PairedDeps = {
    api: { whoami: async () => "member-1" },
    db: {
      orgId: async () => "eval-org",
      memberships: async () => ["eval-org"],
      readRun: async (id) => (id === source.run.id ? source : id === replay.run.id ? replay : null),
    },
    evidence: async (_org, _user, id) => {
      reads.push(id);
      return snapshots.get(id) ?? null;
    },
  };
  const args = ["--replay", replay.run.id, "--sample", sample];
  return { source, replay, snapshots, reads, d, args, sample };
}

it("renders a deterministic public projection and explicit severity-only alignment in text and JSON", async () => {
  const t = fixture();
  const out = await pairedCommand([...t.args, "--json"], t.d);
  expect(out.code).toBe(0);
  expect(out.stderr).toBe("");
  const value = JSON.parse(out.stdout);
  expect(value.source.verdict).toBe("safe");
  expect(value.replay.verdict).toBe("suspicious");
  expect(value.alignment[0].changes[0].kind).toBe("severity-changed");
  expect(value.notice).toContain("do not prove why");
  const text = await pairedCommand(t.args, t.d);
  expect(text.stdout).toBe(renderPaired(value));
  expect(text.stdout).toContain("bank.change: severity-changed; source E1; replay E1");
  expect((await pairedCommand([...t.args, "--json"], t.d)).stdout).toBe(out.stdout);
});

it("preserves multiplicity and exact alignment regardless of incoming row order", () => {
  const a: PublicEvidence = { id: "E1", check: "bank.change", severity: "high", summary: "same" };
  const b = { ...a, id: "E2" };
  const c = { ...a, id: "E3", summary: "old" };
  const x = { ...a, id: "E8" };
  const y = { ...a, id: "E9", summary: "new" };
  const expected = [
    {
      check: "bank.change",
      changes: [
        { kind: "unchanged", source: a, replay: x },
        { kind: "removed", source: c, replay: null },
        { kind: "removed", source: b, replay: null },
        { kind: "added", source: null, replay: y },
      ],
    },
  ];
  expect(alignEvidence([a, b, c], [x, y])).toEqual(expected);
  expect(alignEvidence([c, b, a], [y, x])).toEqual(expected);
});

it.each([
  "denied",
  "missing",
  "read-error",
  "stale",
  "null-verdict",
  "changed-status",
  "duplicate-evidence",
  "unsafe-summary",
])("keeps the allowed side and hides all unavailable %s content", async (fault) => {
  const t = fixture();
  const original = t.d.evidence;
  const snap = t.snapshots.get("case-source");
  if (!snap) throw new Error("fixture");
  if (fault === "denied" || fault === "missing") t.snapshots.delete("case-source");
  if (fault === "read-error")
    t.d.evidence = async (o, u, id) => {
      if (id === "case-source") throw new Error("SECRET SQL RAW PAYLOAD");
      return original(o, u, id);
    };
  if (fault === "stale") {
    snap.analysisRun = "retry-source";
    snap.updatedAt = "2026-11-04T08:02:00.000Z";
  }
  if (fault === "null-verdict") snap.verdict = null;
  if (fault === "changed-status") snap.status = "running";
  if (fault === "duplicate-evidence") snap.evidence.push({ ...snap.evidence[0] } as PublicEvidence);
  if (fault === "unsafe-summary" && snap.evidence[0]) snap.evidence[0].summary = "\u001b[2JSECRET";
  const out = await pairedCommand([...t.args, "--json"], t.d);
  expect(out.code).toBe(2);
  expect(out.stdout).not.toContain("SECRET");
  const value = JSON.parse(out.stdout);
  expect(value.source).toMatchObject({
    status: "unavailable",
    verdict: null,
    evidence: [],
    caseId: null,
    report: null,
  });
  expect(value.replay.verdict).toBe("suspicious");
  expect(value.alignment).toBeNull();
});

it("refuses an unchanged, unknown, duplicate or mismatched population before evidence access", async () => {
  for (const fault of ["unchanged", "unknown", "duplicate", "population", "foreign-result"]) {
    const t = fixture();
    const row = t.replay.results[0];
    if (!row) throw new Error("fixture");
    if (fault === "unchanged") row.verdict = "safe";
    if (fault === "unknown") t.args[t.args.length - 1] = "synthetic-sa/unknown.eml";
    if (fault === "duplicate") {
      t.replay.results.push({ ...row });
      t.replay.run.selected = 2;
    }
    if (fault === "population") t.replay.run.setVersion = "c".repeat(64);
    if (fault === "foreign-result") row.runId = "foreign-0001";
    expect((await pairedCommand(t.args, t.d)).code).toBe(3);
    expect(t.reads).toEqual([]);
  }
});
it("refuses unauthenticated or multiple-organisation sessions without reading reports", async () => {
  const t = fixture();
  t.d.api.whoami = async () => null;
  expect((await pairedCommand(t.args, t.d)).code).toBe(3);
  t.d.api.whoami = async () => "member-1";
  t.d.db.memberships = async () => ["eval-org", "other-org"];
  expect((await pairedCommand(t.args, t.d)).code).toBe(3);
  expect(t.reads).toEqual([]);
});
it("renders empty permitted evidence without inventing changes", async () => {
  const t = fixture();
  for (const s of t.snapshots.values()) s.evidence = [];
  const out = await pairedCommand(t.args, t.d);
  expect(out.code).toBe(0);
  expect(out.stdout).toContain("source evidence: empty");
  expect(out.stdout).toContain("replay evidence: empty");
});
it("does not echo a failed database read into diagnostics", async () => {
  const t = fixture();
  t.d.db.readRun = async () => {
    throw new Error("SECRET COOKIE SQL");
  };
  const out = await pairedCommand(t.args, t.d);
  expect(out.code).toBe(3);
  expect(out.stderr).not.toContain("SECRET");
});
it("follows the shell-quoted command printed by comparisonText with literal hostile sample characters", async () => {
  const t = fixture();
  const sample = "synthetic-sa/it's $(printf INJECTED).eml";
  for (const r of [t.source, t.replay]) {
    const row = r.results[0];
    if (row) row.sample = sample;
  }
  const line = comparisonText(compareRuns(t.source, t.replay))
    .split("\n")
    .find((l) => l.includes("paired command: "));
  const command = line?.split("paired command: ")[1];
  expect(command).toBe(pairedEvidenceCommand(t.replay.run.id, sample));
  if (!command) throw new Error("missing command");
  // Execute only the generated argument words via a printing shim, then dispatch those exact parsed arguments.
  const shell = spawnSync("sh", ["-c", `set -- ${command}; shift 2; printf '%s\\0' "$@"`], { encoding: "utf8" });
  expect(shell.status).toBe(0);
  const args = shell.stdout.split("\0").filter(Boolean);
  expect(args).toEqual(["--replay", t.replay.run.id, "--sample", sample]);
  expect((await pairedCommand(args, t.d)).code).toBe(0);
});

it("scopes the real SQL projection to membership and one current analysis without selecting private details", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const dir = join(import.meta.dirname, "../../src/db/migrations");
    for (const name of readdirSync(dir)
      .filter((n) => n.endsWith(".sql"))
      .sort())
      db.exec(readFileSync(join(dir, name), "utf8"));
    const at = "2026-11-04T08:00:00.000Z";
    db.exec(`INSERT INTO organization(id,name,slug,createdAt) VALUES('eval-org','IsItLegit Eval','eval','${at}'),('other-org','Other','other','${at}');
      INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('member-1','Member','member@example.test',1,'${at}','${at}');
      INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES('m1','eval-org','member-1','owner','${at}');
      INSERT INTO cases(id,org_id,channel,status,verdict,created_at,updated_at,run_id) VALUES
      ('case-source','eval-org','upload','done','safe','${at}','2026-11-04T08:00:01.000Z','retry-source'),
      ('case-other','other-org','upload','done','safe','${at}','2026-11-04T08:00:01.000Z',NULL);
      INSERT INTO evidence(case_id,run_id,id,seq,"check",severity,summary,detail_json,artefact_keys_json,created_at) VALUES
      ('case-source','case-source','E1',1,'bank.change','critical','old analysis','{}','[]','${at}'),
      ('case-source','retry-source','E1',1,'bank.change','high','Public finding','{"registeredBank":"SECRET BANK"}','["SECRET SIGNED URL"]','${at}'),
      ('case-other','case-other','E1',1,'bank.change','high','FOREIGN SECRET','{}','[]','${at}');`);
    const reader = liveEvidenceReader(async (s) => ({
      results: db.prepare(inline(s)).all() as Record<string, unknown>[],
    }));
    const snapshot = await reader("eval-org", "member-1", "case-source");
    expect(snapshot?.analysisRun).toBe("retry-source");
    expect(snapshot?.evidence).toEqual([
      { id: "E1", check: "bank.change", severity: "high", summary: "Public finding" },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("SECRET");
    expect(JSON.stringify(snapshot)).not.toContain("old analysis");
    expect(await reader("eval-org", "member-1", "case-other")).toBeNull();
    expect(await reader("other-org", "member-1", "case-other")).toBeNull();
    db.exec("DELETE FROM member WHERE id='m1'");
    expect(await reader("eval-org", "member-1", "case-source")).toBeNull();
  } finally {
    db.close();
  }
});
it("runs help and safe refusals through the actual Node entrypoint without credentials", () => {
  const command = join(import.meta.dirname, "../../eval/paired-evidence.ts");
  const env = { ...process.env };
  delete env.EVAL_SESSION_COOKIE;
  const help = spawnSync(process.execPath, [command, "--help"], { env, encoding: "utf8" });
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("--replay");
  const refused = spawnSync(process.execPath, [command, "--replay", "replay-0001", "--sample", "synthetic-sa/a.eml"], {
    env,
    encoding: "utf8",
  });
  expect(refused.status).toBe(3);
  expect(refused.stdout).toBe("");
  expect(refused.stderr).toContain("EVAL_SESSION_COOKIE is required");
});
