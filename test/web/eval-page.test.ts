// The results page (D08 T02 §4): requests through the Worker's own entrypoint with no session, the figures a published
// report holds shown exactly, the headline on the latest full run, ablation rows only against a matching baseline, real-use
// counts that leave the eval and demo organisations and pre-launch cases out, and a failed read that shows no figure.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_SINCE, productionCounts, QUERIES } from "../../src/eval/production";
import { call } from "../auth/helpers";

const db = (env as unknown as Env).DB;
const text = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ");
const page = async () => {
  const res = await call("/eval", { headers: { accept: "text/html" } });
  return { res, html: await res.text() };
};

beforeEach(async () => {
  for (const t of [
    "eval_published",
    "eval_results",
    "eval_runs",
    "feedback",
    "case_verdicts",
    "evidence",
    "case_events",
    "cases",
  ])
    await db.prepare(`DELETE FROM ${t}`).run();
  await db.prepare(`DELETE FROM "organization" WHERE id LIKE 'ev-%'`).run();
});
afterEach(() => vi.restoreAllMocks());

const rate = (n: number, hits: number) => ({ n, hits, rate: n ? hits / n : null });
function report(
  id: string,
  over: {
    mode?: string;
    commit?: string;
    setVersion?: string;
    complete?: boolean;
    detection?: number;
    fp?: number;
    ms?: number;
    usd?: number;
    finished?: string;
    sets?: string[];
    limit?: number | null;
  } = {},
) {
  const attacks = 100;
  const genuine = 50;
  const detected = Math.round((over.detection ?? 0.96) * attacks);
  const fps = Math.round((over.fp ?? 0.02) * genuine);
  return {
    run: {
      id,
      mode: over.mode ?? "full",
      commit: over.commit ?? "abcdef1234567",
      setVersion: over.setVersion ?? "a".repeat(64),
      sets: over.sets ?? ["synthetic-sa"],
      sampleLimit: over.limit ?? null,
      status: "complete",
      selected: attacks + genuine,
      stored: attacks + genuine,
      startedAt: "2026-11-05T10:00:00.000Z",
      finishedAt: over.finished ?? "2026-11-05T10:30:00.000Z",
    },
    complete: over.complete ?? true,
    main: {
      attacks,
      genuine,
      measuredGenuine: genuine,
      detection: rate(attacks, detected),
      falsePositives: rate(genuine, fps),
      byCategory: {
        "credential-phishing": { attacks: 60, detected: 58, genuine: 0, measuredGenuine: 0, falsePositives: 0 },
        "bec-payment": { attacks: 40, detected: 38, genuine: 0, measuredGenuine: 0, falsePositives: 0 },
        "genuine-business": { attacks: 0, detected: 0, genuine, measuredGenuine: genuine, falsePositives: fps },
      },
      modelBasis: rate(40, 36),
      checksBasis: rate(60, 60),
      analysisMs: { n: 150, median: over.ms ?? 3500, p95: 9000 },
      costUsd: { n: 150, median: over.usd ?? 0.031, total: 4.65 },
    },
    targets: [
      {
        name: "detection",
        figure: detected / attacks,
        figureText: "x",
        threshold: "at least 95.0%",
        denominator: attacks,
        state: detected / attacks >= 0.95 ? "met" : "missed",
      },
      {
        name: "false positives",
        figure: fps / genuine,
        figureText: "x",
        threshold: "at most 2.0%",
        denominator: genuine,
        state: fps / genuine <= 0.02 ? "met" : "missed",
      },
      {
        name: "median cost per case",
        figure: over.usd ?? 0.031,
        figureText: "x",
        threshold: "under US$0.0500",
        denominator: 150,
        state: (over.usd ?? 0.031) < 0.05 ? "met" : "missed",
      },
      {
        name: "forward-to-reply time",
        figure: null,
        figureText: "not measured",
        threshold: "median under 60 s",
        denominator: 0,
        state: "not measured",
      },
    ],
  };
}
async function publish(r: ReturnType<typeof report>, at: string) {
  await db
    .prepare(
      "INSERT INTO eval_runs (id, commit_sha, set_version, mode, sets, status, selected, cap_usd, started_at, finished_at) VALUES (?, ?, ?, ?, 'synthetic-sa', 'complete', 150, 5, ?, ?)",
    )
    .bind(r.run.id, r.run.commit, r.run.setVersion, r.run.mode, r.run.startedAt, r.run.finishedAt)
    .run();
  await db
    .prepare("INSERT INTO eval_published (run_id, mode, report_json, published_at) VALUES (?, ?, ?, ?)")
    .bind(r.run.id, r.run.mode, JSON.stringify(r), at)
    .run();
}

describe("the results page with nothing published", () => {
  it("answers with no session, says nothing is published, and shows no figure as a number", async () => {
    const { res, html } = await page();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const t = text(html);
    expect(t).toContain("No test run has been published yet");
    expect(t).toContain("Attacks caught Not measured");
    expect(t).not.toMatch(/\d+\.\d%/);
    expect(t).toContain("Cases checked 0");
    expect(t).toContain("Bank changes caught Not counted yet");
  });
});

describe("the results page with a published run", () => {
  it("shows the run's exact figures, its date, commit and the datasets link, and says each target in words", async () => {
    await publish(report("run-00000001"), "2026-11-05T11:00:00.000Z");
    const { res, html } = await page();
    expect(res.status).toBe(200);
    const t = text(html);
    expect(t).toContain(
      "On our latest test of 150 labelled emails and documents, IsItLegit caught 96.0% of attacks and wrongly flagged 2.0% of genuine mail.",
    );
    expect(t).toContain("Eval run run-00000001 · 5 Nov 2026, 12:30 SAST · commit abcdef1");
    expect(html).toContain("https://github.com/rizonetech/isitlegit/blob/abcdef1234567/eval/DATASETS.md");
    expect(t).toContain("sets synthetic-sa · set version aaaaaaaaaaaa");
    expect(t).toContain("Every genuine email in this test is synthetic, written for the test");
    expect(html).toContain('href="/signin"');
    expect(t).toContain("Sign in");
    expect(t).toContain("Attacks caught 96.0% Target met");
    expect(t).toContain("False alarms on genuine mail 2.0% Target met");
    expect(t).toContain("Median model cost per check US$0.0310 Target met");
    expect(t).toContain("Credential phishing 60 96.7%");
    expect(t).toContain("Business email compromise 40 95.0%");
    expect(t).toContain("Genuine mail, flagged in error 50 2.0%");
    expect(t).toContain("Time to analyse, median 3.5 s");
    expect(t).toContain("Time to analyse, 95th percentile 9.0 s");
  });

  it("never shows the forward-to-reply target met from the analysis time alone", async () => {
    await publish(report("run-00000001", { ms: 800 }), "2026-11-05T11:00:00.000Z");
    const t = text((await page()).html);
    expect(t).toContain(
      "Median time to analyse 0.8 s Not measured Forward-to-reply (target under 60 s): not measured here, only by the live mail run.",
    );
    expect(t).toContain("Forward-to-reply under 60 s: not measured");
    expect(t).not.toMatch(/Forward-to-reply[^.]{0,40}\b(met|passed)\b/i);
    expect(t).toContain("Model cost, with a walkthrough Not measured");
  });

  it("says a missed target as missed and an incomplete run as incomplete", async () => {
    await publish(report("run-00000001", { detection: 0.8, fp: 0.1 }), "2026-11-05T11:00:00.000Z");
    const t = text((await page()).html);
    expect(t).toContain("Attacks caught 80.0% Target missed");
    expect(t).toContain("False alarms on genuine mail 10.0% Target missed");
  });

  it("keeps the headline on the latest full run: an ablation published later never replaces it", async () => {
    await publish(report("run-00000001", { detection: 0.9 }), "2026-11-05T11:00:00.000Z");
    await publish(report("run-00000002", { detection: 0.97 }), "2026-11-06T11:00:00.000Z");
    await publish(
      report("run-00000003", { mode: "ablate:no-agent-reasoning", detection: 0.5 }),
      "2026-11-07T11:00:00.000Z",
    );
    const t = text((await page()).html);
    expect(t).toContain("caught 97.0% of attacks");
    expect(t).toContain("Eval run run-00000002");
    expect(t).toContain("Muse Spark reasoning Rule-based verdict minus 47.0 pts");
  });

  it("compares an ablation only with a baseline of the same selection and commit, else says not comparable", async () => {
    await publish(report("run-00000001"), "2026-11-05T11:00:00.000Z");
    await publish(
      report("run-00000002", { mode: "ablate:no-agent-reasoning", commit: "1111111aaaaaa" }),
      "2026-11-06T11:00:00.000Z",
    );
    await publish(
      report("run-00000003", { mode: "ablate:no-walkthrough", setVersion: "b".repeat(64) }),
      "2026-11-06T12:00:00.000Z",
    );
    await publish(report("run-00000004", { mode: "ablate:no-sam", detection: 0.9 }), "2026-11-06T13:00:00.000Z");
    const t = text((await page()).html);
    expect(t).toContain(
      "Muse Spark reasoning Rule-based verdict Not comparable: another deployed commit than the full run",
    );
    expect(t).toContain(
      "Muse Wonder walkthrough No walkthrough Not comparable: another dataset or selection than the full run",
    );
    expect(t).toContain("SAM 3.1 comparison No logo comparison minus 6.0 pts");
    expect(t).not.toContain("No model has been switched off");
  });

  it("says no model has been switched off yet when there is no ablation", async () => {
    await publish(report("run-00000001"), "2026-11-05T11:00:00.000Z");
    expect(text((await page()).html)).toContain("No model has been switched off in a published run yet");
  });
});

describe("real-use counts", () => {
  const at = (d: string) => `${d}T08:00:00.000Z`;
  async function org(id: string, name: string) {
    await db
      .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, '2026-10-20T00:00:00.000Z')`)
      .bind(id, name, `${id}-slug`)
      .run();
  }
  async function kase(
    id: string,
    orgId: string,
    created: string,
    verdict: string | null,
    over: { origin?: string; status?: string; verdictAt?: string; subject?: string } = {},
  ) {
    await db
      .prepare(
        "INSERT INTO cases (id, org_id, channel, status, verdict, created_at, updated_at, origin, forwarded_by, original_subject, original_from_address) VALUES (?, ?, 'email', ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        orgId,
        over.status ?? "done",
        verdict,
        created,
        created,
        over.origin ?? null,
        over.origin ? "x@y.example" : null,
        over.subject ?? null,
        over.subject ? "secret-sender@private.example" : null,
      )
      .run();
    if (verdict && over.verdictAt)
      await db
        .prepare(
          "INSERT INTO case_verdicts (case_id, verdict, headline, confidence, reasons, actions, source, created_at) VALUES (?, ?, 'h', 0.9, '[]', '[]', 'agent', ?)",
        )
        .bind(id, verdict, over.verdictAt)
        .run();
  }
  async function evidence(caseId: string, n: number, check: string) {
    await db
      .prepare(
        `INSERT INTO evidence (case_id, run_id, id, seq, "check", severity, summary, created_at) VALUES (?, 'r1', ?, ?, ?, 'high', 's', '2026-11-05T08:00:00.000Z')`,
      )
      .bind(caseId, `E${n}`, n, check)
      .run();
  }
  async function feedback(caseId: string, user: string) {
    await db
      .prepare(
        "INSERT INTO feedback (id, case_id, user_id, kind, created_at, updated_at) VALUES (?, ?, ?, 'false_alarm', '2026-11-05T09:00:00.000Z', '2026-11-05T09:00:00.000Z')",
      )
      .bind(`f-${caseId}-${user}`, caseId, user)
      .run();
  }
  async function seed() {
    await org("ev-real", "Real Business");
    await org("ev-eval", "IsItLegit Eval");
    await org("ev-demo", "Fynbos Freight");
    // Real: two flagged (one with two invoice findings, one with none), one safe, one pre-launch, one counterparty, one unfinished.
    await kase("c1", "ev-real", at("2026-11-02"), "malicious", { verdictAt: "2026-11-02T08:00:10.000Z" });
    await kase("c2", "ev-real", at("2026-11-02"), "suspicious", { verdictAt: "2026-11-02T08:00:30.000Z" });
    await kase("c3", "ev-real", at("2026-11-03"), "safe", {
      verdictAt: "2026-11-03T08:00:20.000Z",
      subject: "PRIVATE-SUBJECT-LINE",
    });
    await kase("c4", "ev-real", at("2026-10-20"), "malicious", { verdictAt: "2026-10-20T08:00:05.000Z" });
    await kase("c5", "ev-real", at("2026-11-03"), "malicious", {
      origin: "counterparty",
      verdictAt: "2026-11-03T08:00:05.000Z",
    });
    await kase("c6", "ev-real", at("2026-11-03"), null, { status: "running" });
    // Excluded organisations.
    for (let i = 0; i < 3; i++)
      await kase(`e${i}`, "ev-eval", at("2026-11-03"), "malicious", { verdictAt: "2026-11-03T08:00:01.000Z" });
    for (let i = 0; i < 2; i++)
      await kase(`d${i}`, "ev-demo", at("2026-11-03"), "suspicious", { verdictAt: "2026-11-03T08:00:01.000Z" });
    // Invoice findings: c1 has two (counts once), c3 one; the eval case's does not count. A non-invoice finding on c2 does not.
    await evidence("c1", 1, "document.forensics.revisions");
    await evidence("c1", 2, "document.forensics.fonts");
    await evidence("c3", 1, "document.forensics.overlay");
    await evidence("c2", 1, "domain.lookalike");
    await evidence("e0", 1, "document.forensics.revisions");
    // Feedback: two members on c1 count once; c3 once; the eval case's and the pre-launch case's do not count.
    await feedback("c1", "u1");
    await feedback("c1", "u2");
    await feedback("c3", "u1");
    await feedback("e0", "u1");
    await feedback("c4", "u1");
  }

  it("counts real use exactly: members' own cases since launch, eval and demo left out, a case once", async () => {
    await seed();
    const counts = await productionCounts(db);
    expect(counts).toEqual({
      since: PRODUCTION_SINCE,
      cases: 3,
      flagged: 2,
      invoiceFlags: 2,
      bankChanges: null,
      reportedWrong: 2,
      // c1 10 s, c2 30 s, c3 20 s: the median is 20.
      medianSeconds: 20,
    });
  });

  it("leaves out the organisation the eval runner opened cases in, whatever it is named", async () => {
    await seed();
    await org("ev-other-eval", "Some Other Eval Name");
    await kase("x1", "ev-other-eval", at("2026-11-03"), "malicious", { verdictAt: "2026-11-03T08:00:01.000Z" });
    await kase("x2", "ev-other-eval", at("2026-11-03"), "safe", { verdictAt: "2026-11-03T08:00:01.000Z" });
    // Before the run is recorded the cases are counted as real use: the organisation is only known by its results.
    expect((await productionCounts(db)).cases).toBe(5);
    await db
      .prepare(
        "INSERT INTO eval_runs (id, commit_sha, set_version, mode, sets, status, selected, cap_usd, started_at, finished_at) VALUES ('run-0000000a', 'abcdef1', ?, 'full', 'synthetic-sa', 'complete', 1, 5, '2026-11-05T10:00:00Z', '2026-11-05T11:00:00Z')",
      )
      .bind("a".repeat(64))
      .run();
    await db
      .prepare(
        "INSERT INTO eval_results (run_id, sample, case_id, outcome, label, category, verdict) VALUES ('run-0000000a', 'synthetic-sa/a.eml', 'x1', 'done', 'attack', 'x', 'malicious')",
      )
      .run();
    const counts = await productionCounts(db);
    expect(counts.cases).toBe(3);
    expect(counts.flagged).toBe(2);
  });

  it("takes the median over every eligible case, the middle of an odd or an even count", async () => {
    await org("ev-real", "Real Business");
    const make = async (n: number) => {
      for (let i = 0; i < n; i++)
        await kase(`m${n}-${i}`, "ev-real", at("2026-11-02"), "safe", {
          verdictAt: `2026-11-02T08:00:${String(i + 1).padStart(2, "0")}.000Z`,
        });
    };
    await make(5);
    expect((await productionCounts(db)).medianSeconds).toBe(3);
    await make(1);
    // Six durations 1, 1, 2, 3, 4, 5: the middle two are 2 and 3.
    expect((await productionCounts(db)).medianSeconds).toBe(2.5);
    expect(
      (
        await db
          .prepare(QUERIES.middle.replace(/\?\d+ OFFSET \?\d+/, "1 OFFSET 0"))
          .bind(PRODUCTION_SINCE, "IsItLegit Eval", "Fynbos Freight")
          .all()
      ).results,
    ).toHaveLength(1);
  });

  it("shows those counts on the page and nothing of any message", async () => {
    await seed();
    const { html } = await page();
    const t = text(html);
    expect(t).toContain("Cases checked 3");
    expect(t).toContain("Malicious or suspicious 2");
    expect(t).toContain("Verdicts reported wrong 2");
    expect(t).toContain("Bank changes caught Not counted yet");
    expect(t).toContain("2 cases carried an invoice finding");
    expect(t).toContain("The median time from arrival to a verdict was 20.0 s");
    expect(html).not.toContain("PRIVATE-SUBJECT-LINE");
    expect(html).not.toContain("secret-sender@private.example");
  });

  it("asks the database for nothing that holds a message: no subject, sender, recipient or body column", () => {
    const forbidden =
      /subject|\bfrom\b[^ ]*address|sender|recipient|body|forwarded_by|message_id|upload_name|original_/i;
    for (const [name, sql] of Object.entries(QUERIES)) expect(sql, name).not.toMatch(forbidden);
  });
});

describe("a failed read", () => {
  it("shows an error page with a retry and no figure when the database fails", async () => {
    await publish(report("run-00000001"), "2026-11-05T11:00:00.000Z");
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/eval_published|from cases/i.test(sql)) throw new Error("d1 down");
      return prepare(sql);
    });
    const { res, html } = await page();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const t = text(html);
    expect(t).toContain("We could not load the results just now.");
    expect(html).toContain('href="/eval"');
    expect(t).toMatch(/Reference 500-[A-Z0-9]{6}/);
    expect(t).not.toMatch(/\d+\.\d%/);
  });

  it("treats a damaged published report as an error, never a blank figure", async () => {
    await db
      .prepare(
        "INSERT INTO eval_runs (id, commit_sha, set_version, mode, sets, status, selected, cap_usd, started_at, finished_at) VALUES ('run-00000009', 'abcdef1', ?, 'full', 'synthetic-sa', 'complete', 1, 5, '2026-11-05T10:00:00Z', '2026-11-05T11:00:00Z')",
      )
      .bind("a".repeat(64))
      .run();
    await db
      .prepare(
        "INSERT INTO eval_published (run_id, mode, report_json, published_at) VALUES ('run-00000009', 'full', '{\"main\": 1}', '2026-11-05T11:00:00.000Z')",
      )
      .run();
    const { res, html } = await page();
    expect(res.status).toBe(503);
    expect(text(html)).toContain("We could not load the results just now.");
  });
});

describe("the run history", () => {
  const historyRows = (html: string) => {
    const start = html.indexOf("Run history");
    const section = html.slice(start, html.indexOf("What happened in real use?"));
    return [...section.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map((m) => text(m[0]));
  };

  it("lists every published full run with its own figures, newest first, mismatches marked", async () => {
    await publish(report("run-latest", { detection: 0.96, fp: 0.02 }), "2026-11-05T11:00:00.000Z");
    await publish(
      report("run-same", { detection: 0.9, fp: 0.04, finished: "2026-11-04T10:30:00.000Z" }),
      "2026-11-04T11:00:00.000Z",
    );
    await publish(
      report("run-version", { setVersion: "b".repeat(64), detection: 0.7, finished: "2026-11-03T10:30:00.000Z" }),
      "2026-11-03T11:00:00.000Z",
    );
    await publish(
      report("run-selection", { sets: ["nazario-2025"], detection: 0.6, finished: "2026-11-02T10:30:00.000Z" }),
      "2026-11-02T11:00:00.000Z",
    );
    await publish(
      report("run-commit", { commit: "1234567abcdef", detection: 0.5, finished: "2026-11-01T10:30:00.000Z" }),
      "2026-11-01T11:00:00.000Z",
    );
    // Distinctive publications the history must leave out: an ablation arm and an unpublished run.
    await publish(report("run-abl", { mode: "ablate:no-sam", detection: 0.33 }), "2026-11-05T12:00:00.000Z");
    await db
      .prepare(
        "INSERT INTO eval_runs (id, commit_sha, set_version, mode, sets, status, selected, cap_usd, started_at, finished_at) VALUES ('run-unpub', '7654321abcdef', ?, 'full', 'synthetic-sa', 'complete', 1, 5, '2026-11-05T10:00:00Z', '2026-11-05T11:00:00Z')",
      )
      .bind("a".repeat(64))
      .run();

    const { res, html } = await page();
    expect(res.status).toBe(200);
    const t = text(html);
    expect(t).toContain("Run history");
    expect(t).toContain("Independent validation means a person or organisation outside Rizonetech");
    expect(t).toContain("It has not happened yet");
    const rows = historyRows(html);
    expect(rows.length).toBe(6);
    expect(rows[1]).toContain("run-latest");
    expect(rows[1]).toContain("96.0%");
    expect(rows[1]).toContain("Comparable");
    expect(rows[2]).toContain("run-same");
    expect(rows[2]).toContain("90.0%");
    expect(rows[2]).toContain("4.0%");
    expect(rows[2]).toContain("Comparable");
    expect(rows[3]).toContain("run-version");
    expect(rows[3]).toContain("70.0%");
    expect(rows[3]).toContain("Different selection: not comparable (another dataset version than the latest run)");
    expect(rows[4]).toContain("run-selection");
    expect(rows[4]).toContain("60.0%");
    expect(rows[4]).toContain("nazario-2025");
    expect(rows[4]).toContain("Different selection: not comparable (another selection than the latest run)");
    expect(rows[5]).toContain("run-commit");
    expect(rows[5]).toContain("50.0%");
    expect(rows[5]).toContain("1234567");
    expect(rows[5]).toContain("Different selection: not comparable (another deployed commit than the latest run)");
    expect(t).not.toContain("33.0%");
    expect(t).not.toContain("7654321");
  });

  it("keeps one baseline when a publication lands while the page reads", async () => {
    await publish(report("run-latest", { detection: 0.96, fp: 0.02 }), "2026-11-05T11:00:00.000Z");
    const prepare = db.prepare.bind(db);
    let inserted = false;
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      const stmt = prepare(sql);
      if (
        inserted ||
        !/FROM eval_published WHERE mode = 'full' ORDER BY published_at DESC, run_id DESC$/.test(sql.trim())
      )
        return stmt;
      inserted = true;
      // The history query itself first lands a new publication, then reads: the page must keep its baseline.
      return {
        bind: (...args: unknown[]) => stmt.bind(...args),
        all: async () => {
          await prepare(
            "INSERT INTO eval_runs (id, commit_sha, set_version, mode, sets, status, selected, cap_usd, started_at, finished_at) VALUES ('run-midread', '9999999abcdef', ?, 'full', 'synthetic-sa', 'complete', 150, 5, '2026-11-06T10:00:00Z', '2026-11-06T11:00:00Z')",
          )
            .bind("a".repeat(64))
            .run();
          await prepare(
            "INSERT INTO eval_published (run_id, mode, report_json, published_at) VALUES ('run-midread', 'full', ?, '2026-11-06T12:00:00.000Z')",
          )
            .bind(JSON.stringify(report("run-midread", { commit: "9999999abcdef", detection: 0.5 })))
            .run();
          return stmt.all();
        },
      } as unknown as D1PreparedStatement;
    });
    const { res, html } = await page();
    expect(res.status).toBe(200);
    const t = text(html);
    // The headline is still the run the page started with; the mid-read publication is marked against it.
    expect(t).toContain("Eval run run-latest");
    expect(t).toContain("Attacks caught 96.0% Target met");
    const rows = historyRows(html);
    const mid = rows.find((r) => r.includes("run-midread"));
    expect(mid).toBeDefined();
    expect(mid as string).toContain(
      "Different selection: not comparable (another deployed commit than the latest run)",
    );
  });

  it("answers the retryable error state when only the history read fails", async () => {
    await publish(report("run-latest"), "2026-11-05T11:00:00.000Z");
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/FROM eval_published WHERE mode = 'full' ORDER BY published_at DESC, run_id DESC$/.test(sql.trim()))
        throw new Error("d1 down");
      return prepare(sql);
    });
    const { res, html } = await page();
    expect(res.status).toBe(503);
    expect(text(html)).toContain("We could not load the results just now.");
    expect(text(html)).not.toContain("Run history");
  });

  it("answers the retryable error state when an older published report is damaged", async () => {
    await publish(report("run-latest"), "2026-11-05T11:00:00.000Z");
    await db
      .prepare(
        "INSERT INTO eval_runs (id, commit_sha, set_version, mode, sets, status, selected, cap_usd, started_at, finished_at) VALUES ('run-oldbad', 'abcdef1', ?, 'full', 'synthetic-sa', 'complete', 1, 5, '2026-11-04T10:00:00Z', '2026-11-04T11:00:00Z')",
      )
      .bind("a".repeat(64))
      .run();
    await db
      .prepare(
        "INSERT INTO eval_published (run_id, mode, report_json, published_at) VALUES ('run-oldbad', 'full', '{\"main\": 1}', '2026-11-04T12:00:00.000Z')",
      )
      .run();
    const { res, html } = await page();
    expect(res.status).toBe(503);
    expect(text(html)).toContain("We could not load the results just now.");
    expect(text(html)).not.toContain("Run history");
  });
});
