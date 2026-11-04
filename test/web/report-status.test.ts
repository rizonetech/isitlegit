import { env, introspectWorkflowInstance } from "cloudflare:test";
import { jsx } from "hono/jsx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAuthChecks } from "../../src/checks/auth";
import { registerAuthResultsCheck } from "../../src/checks/auth-results";
import { bundled } from "../../src/checks/brands";
import type { CaseView } from "../../src/checks/case-view";
import { saveEvidence } from "../../src/checks/evidence";
import { CheckRegistry } from "../../src/checks/registry";
import { runChecksWithOutcomes } from "../../src/checks/runner";
import { createCase } from "../../src/db/cases";
import { admitDelivery, RetryDelivery } from "../../src/intake/admit";
import { putAttachment, type Store } from "../../src/intake/store";
import { replyAwaited } from "../../src/web/components/model-trace";
import { type Coverage, ReportLive } from "../../src/web/pages/report-live";
import { admissionFailed, progressOf, type StepEvent } from "../../src/web/pages/report-progress";
import { signReportLink } from "../../src/web/report-link";
import { call, signIn } from "../auth/helpers";
import { toneOgg } from "../fixtures/audio/load";
import { oggPackets, oggStream } from "../fixtures/audio/ogg";
import { putStoredVerdict } from "./stored-verdict";

// The report's live status, partial and failed states (D07 T03 §4): step attempts reduced per step, the poll answering
// the live region while a case runs and the finished report once with no trigger, coverage read from the stored check
// outcomes apart from the lifecycle, a reply failure its own notice, the failed state with its step and reference.
const db = (env as unknown as Env).DB;
const SECRET = (env as unknown as Env).REPORT_LINK_SECRET;
afterEach(() => vi.restoreAllMocks());

const at = (s: number) => new Date(Date.UTC(2026, 9, 31, 8, 0, s)).toISOString();
const ev = (step: string, status: StepEvent["status"], s: number, error: string | null = null): StepEvent => ({
  step,
  status,
  startedAt: at(s),
  ms: status === "started" ? null : 500,
  error,
});

describe("progress from step events", () => {
  it("reduces a retried step that recovers to done, and exhausted retries to failed", () => {
    const recovered = progressOf([
      ev("admit", "started", 0),
      ev("admit", "done", 0),
      ev("parse", "started", 1),
      ev("parse", "error", 1, "Error"),
      ev("parse", "started", 3),
      ev("parse", "done", 3),
    ]);
    expect(recovered.steps.find((s) => s.step === "parse")?.state).toBe("done");
    expect(recovered.failed).toBeNull();
    const exhausted = progressOf([
      ev("admit", "done", 0),
      ev("parse", "error", 1, "ParseError"),
      ev("parse", "failed", 1, "ParseError"),
    ]);
    expect(exhausted.failed?.step).toBe("parse");
    expect(exhausted.failed?.error).toBe("ParseError");
  });

  it("shows a step between attempts as trying again, and a running one as running", () => {
    const p = progressOf([ev("admit", "done", 0), ev("parse", "started", 1), ev("parse", "error", 1, "Error")]);
    expect(p.steps.find((s) => s.step === "parse")?.state).toBe("retrying");
    expect(p.current).toBe(2);
    const q = progressOf([ev("admit", "done", 0), ev("parse", "done", 1), ev("checks", "started", 2)]);
    expect(q.steps.find((s) => s.step === "checks")?.state).toBe("running");
    expect(q.current).toBe(3);
    expect(q.startedAt).toBe(at(0));
  });

  it("names the first failed step when a check failure is followed by a reply failure", () => {
    const p = progressOf([ev("checks", "failed", 1, "Timeout"), ev("reply", "failed", 2, "Error")]);
    expect(p.failed?.step).toBe("checks");
  });

  it("keeps a step it does not know, in its recorded order after the known ones", () => {
    const p = progressOf([ev("admit", "done", 0), ev("glimmer", "done", 1)]);
    expect(p.steps.map((s) => s.step).at(-1)).toBe("glimmer");
    expect(p.steps.at(-1)?.words).toBe("Another step");
  });

  // D07 T09 §7: the walkthrough is a conditional step after checks, only when recorded.
  it("names the walkthrough between checks and verdict in each state, and omits it when unrecorded", () => {
    const words = "Sign-in page walk in a contained browser";
    const base = [ev("admit", "done", 0), ev("parse", "done", 1), ev("checks", "done", 2)];
    expect(progressOf(base).steps.some((s) => s.step === "walkthrough")).toBe(false);
    const order = progressOf([...base, ev("walkthrough", "started", 3)]).steps.map((s) => s.step);
    expect(order.indexOf("checks")).toBeLessThan(order.indexOf("walkthrough"));
    expect(order.indexOf("walkthrough")).toBeLessThan(order.indexOf("verdict"));
    expect(
      progressOf([...base, ev("walkthrough", "started", 3)]).steps.find((s) => s.step === "walkthrough"),
    ).toMatchObject({ words, state: "running" });
    expect(
      progressOf([...base, ev("walkthrough", "error", 3, "Error")]).steps.find((s) => s.step === "walkthrough")?.state,
    ).toBe("retrying");
    expect(
      progressOf([...base, ev("walkthrough", "error", 3, "Error"), ev("walkthrough", "done", 4)]).steps.find(
        (s) => s.step === "walkthrough",
      )?.state,
    ).toBe("done");
    expect(
      progressOf([...base, ev("walkthrough", "failed", 3, "Timeout")]).steps.find((s) => s.step === "walkthrough"),
    ).toMatchObject({ words, state: "failed" });
  });
});

const VERDICT = {
  verdict: "suspicious" as const,
  headline: "A stored headline.",
  confidence: 0.6,
  reasons: ["A reason."],
  actions: ["An action."],
};
const live = (props: Partial<Parameters<typeof ReportLive>[0]>) =>
  String(
    jsx(ReportLive, {
      caseId: "01JCASE0000000000000000000",
      status: "done",
      verdict: VERDICT,
      sourceKind: "mail",
      channel: "email",
      delivery: "sent",
      evidence: [],
      progress: progressOf([]),
      coverage: [],
      view: "member",
      now: new Date(at(30)),
      ...props,
    }),
  );
const outcome = (check: string, o: NonNullable<Coverage>[number]["outcome"], reason: string | null = null) => ({
  check,
  outcome: o,
  reason,
  findings: 0,
});

describe("coverage apart from the lifecycle", () => {
  // Check versions on each terminal placement (D07 T03 §39, completion review): a partial report (a skipped check)
  // and a failed report both carry the disclosure, including with zero findings.
  it("carries Check versions on a partial report and on a failed one", () => {
    const partial = live({
      coverage: [
        { ...outcome("domain.lookalike", "ran"), revision: "v-part" },
        outcome("domain.age", "skipped", "no whois"),
      ],
    });
    expect(partial).toContain("Check versions");
    expect(partial).toContain("Lookalike domains: v-part");
    const failed = live({
      verdict: null,
      progress: progressOf([ev("admit", "done", 0), ev("checks", "failed", 1, "Timeout")]),
      coverage: [{ ...outcome("domain.lookalike", "ran"), revision: "v-fail" }],
      evidence: [],
    });
    expect(failed, "failed placement").toContain("Check versions");
    expect(failed).toContain("Lookalike domains: v-fail");
    // Zero findings still lists them: an outcome list with no finding at all.
    const zero = live({
      coverage: [{ ...outcome("content.hidden_text", "ran"), revision: "v-zero" }],
      evidence: [],
    });
    expect(zero).toContain("Hidden text: v-zero");
  });

  // D07 T09 §11: every outcome beside its version, inside the disclosure, reasons in plain words.
  it("words every outcome beside its version in the Check versions disclosure", () => {
    const html = live({
      coverage: [
        { ...outcome("sender.first_time", "ran"), revision: "v1" },
        { ...outcome("content.hidden_text", "partial", "a cut body part"), revision: "v2" },
        { ...outcome("auth.spf", "skipped", "the original's headers were not available"), revision: "v3" },
        { ...outcome("domain.age", "failed", "Timeout"), revision: "v4" },
        { ...outcome("domain.lookalike", "failed", "EvidenceRefused"), revision: "v5" },
      ],
    });
    const disclosure = html.slice(html.indexOf("Check versions"), html.indexOf("</details>"));
    expect(disclosure).toContain("Whether this sender has written before: v1 · ran");
    expect(disclosure).toContain("Hidden text: v2 · read part of its input: a cut body part");
    expect(disclosure).toContain(
      "The sending server check (SPF): v3 · did not run: the original&#39;s headers were not available",
    );
    expect(disclosure).toContain("How old the domain is: v4 · failed: it ran out of time");
    expect(disclosure).toContain("Lookalike domains: v5 · failed: its findings could not be stored");
  });

  it("says a failed check on a done case, partly checked", () => {
    const html = live({ coverage: [outcome("auth.spf", "ran"), outcome("domain.age", "failed", "Timeout")] });
    expect(html).toContain("One check did not run, so this verdict rests on the one that did.");
    expect(html).toContain("How old the domain is:");
    expect(html).toContain("it ran out of time.");
    expect(html).toContain("Suspicious · medium confidence · partial check");
  });

  it("names grouped missing inputs and a partial read, counting ran and partial as run", () => {
    const html = live({
      coverage: [
        outcome("auth.spf", "skipped", "the original's headers were not available"),
        outcome("auth.dkim", "skipped", "the original's headers were not available"),
        outcome("content.hidden_text", "partial", "a cut body part"),
        outcome("sender.first_time", "ran"),
      ],
    });
    // Two did not run; the partial read ran, so it is named apart and counted with the one that ran in full.
    expect(html).toContain("Two checks did not run, so this verdict rests on the two that did.");
    expect(html).toContain("The sending server check (SPF):");
    expect(html).toContain("it had nothing to check (the original&#39;s headers were not available).");
    expect(html).toContain("Read only part of what they were given:");
    expect(html).toContain("<strong>Hidden text:</strong> a cut body part.");
  });

  it("says checks that only read part of their input without calling them not run", () => {
    const html = live({
      coverage: [outcome("content.hidden_text", "partial", "a cut body part"), outcome("auth.spf", "ran")],
    });
    expect(html).toContain("One check read only part of what it was given, so this verdict rests on what they read.");
    expect(html).not.toContain("did not run");
  });

  it("calls a partial case whose only gap is the reply checked, with the delivery said apart", () => {
    const html = live({
      status: "partial",
      coverage: [outcome("auth.spf", "ran")],
      delivery: "failed",
      progress: progressOf([ev("admit", "done", 0), ev("reply", "failed", 5, "Error")]),
    });
    expect(html).toContain("We could not email this answer. It is here, and it is complete.");
    expect(html).toContain("Suspicious · medium confidence</p>");
    expect(html).not.toContain("did not run");
  });

  it("says coverage was not recorded for a case with no stored outcomes, never complete", () => {
    expect(live({ coverage: null })).toContain("Coverage not recorded for this check");
  });
});

describe("delivery apart from coverage", () => {
  it("says each reply outcome that did not plainly go, and nothing for one that went or an upload", () => {
    const cases: [Parameters<typeof live>[0], string | null][] = [
      [{ delivery: "refused" }, "We could not email this answer. It is here, and it is complete."],
      [{ delivery: "failed" }, "We could not email this answer."],
      [{ delivery: "uncertain" }, "We may not have emailed this answer: the mail service did not confirm it."],
      [{ delivery: "pending" }, "This answer is still being emailed."],
      [
        { delivery: null, progress: progressOf([ev("reply", "started", 1), ev("reply", "done", 1)]) },
        "This answer was not emailed: we had no address to send it to.",
      ],
      [{ delivery: "sent" }, null],
      [{ delivery: null, channel: "upload" }, null],
    ];
    for (const [props, words] of cases) {
      const html = live(props);
      if (words) expect(html, JSON.stringify(props)).toContain(words);
      else expect(html, JSON.stringify(props)).not.toContain('role="note" class="px-16');
    }
  });

  it("never calls an answer complete when its checks were not", () => {
    const html = live({ delivery: "failed", coverage: [outcome("domain.age", "failed", "Timeout")] });
    expect(html).toContain("We could not email this answer. It is here.");
    expect(html).not.toContain("it is complete");
    expect(live({ delivery: "failed", coverage: null })).not.toContain("it is complete");
  });

  it("promises an upload no email while it runs", () => {
    const upload = live({
      status: "running",
      verdict: null,
      channel: "upload",
      progress: progressOf([ev("admit", "started", 0)]),
    });
    expect(upload).toContain("You can leave this page and come back: the answer stays on this report.");
    expect(upload).not.toContain("email");
    const mail = live({ status: "running", verdict: null, progress: progressOf([ev("admit", "started", 0)]) });
    expect(mail).toContain("we also email you the verdict");
  });

  it("keeps waiting for the reply of a case whose own Workflow failed its admission, and not for one the intake kept", () => {
    // The Workflow's admit step can fail (a database outage) and still runs the reply: the report keeps asking. Only the
    // intake's RawMissing (no Workflow ever ran) is settled at once (D07 T03 §48 round 1).
    const workflow = live({
      status: "partial",
      verdict: null,
      delivery: null,
      progress: progressOf([ev("admit", "failed", 0, "Error"), ev("reply", "started", 1)]),
    });
    expect(workflow).toContain('hx-trigger="every 2s"');
    const intake = live({
      status: "partial",
      verdict: null,
      delivery: null,
      progress: progressOf([ev("admit", "failed", 0, "RawMissing")]),
    });
    expect(intake).not.toContain('hx-trigger="every 2s"');
    expect(admissionFailed(progressOf([ev("admit", "failed", 0, "Error")]))).toBe(false);
    expect(admissionFailed(progressOf([ev("admit", "failed", 0, "RawMissing")]))).toBe(true);
    // The same class of failure at the parse step is the Workflow's, which still replies.
    expect(admissionFailed(progressOf([ev("admit", "done", 0), ev("parse", "failed", 1, "RawMissing")]))).toBe(false);
    // The trace's mail section awaits the Workflow's reply, and not the intake-kept case's.
    const now = new Date(at(30));
    expect(replyAwaited("email", "partial", progressOf([ev("admit", "failed", 0, "Error")]), now)).toBe(true);
    expect(replyAwaited("email", "partial", progressOf([ev("admit", "failed", 0, "RawMissing")]), now)).toBe(false);
  });

  it("keeps a failed check live while its reply is still being sent, then stops", () => {
    const failed = [ev("admit", "done", 0), ev("parse", "failed", 1, "ParseError")];
    const settling = live({
      status: "partial",
      verdict: null,
      delivery: null,
      progress: progressOf([...failed, ev("reply", "started", 2)]),
    });
    expect(settling).toContain('hx-trigger="every 2s"');
    const settled = live({
      status: "partial",
      verdict: null,
      delivery: "sent",
      progress: progressOf([...failed, ev("reply", "started", 2), ev("reply", "done", 2)]),
    });
    expect(settled).not.toContain("hx-trigger");
    expect(
      live({
        status: "partial",
        verdict: null,
        delivery: "refused",
        progress: progressOf([...failed, ev("reply", "failed", 2)]),
      }),
    ).toContain("We could not email this answer. It is here.");
  });

  it("keeps a failed check live before its reply starts, for a while, and only for an email", () => {
    const failed = [ev("admit", "done", 0), ev("parse", "failed", 1, "ParseError")];
    expect(live({ status: "partial", verdict: null, delivery: null, progress: progressOf(failed) })).toContain(
      'hx-trigger="every 2s"',
    );
    const later = live({
      status: "partial",
      verdict: null,
      delivery: null,
      progress: progressOf(failed),
      now: new Date(Date.parse(at(1)) + 11 * 60 * 1000),
    });
    expect(later).not.toContain("hx-trigger");
    expect(
      live({ status: "partial", verdict: null, delivery: null, channel: "upload", progress: progressOf(failed) }),
    ).not.toContain("hx-trigger");
  });

  it("keeps polling through a failed send while the reply step is still trying", () => {
    const failed = [ev("admit", "done", 0), ev("parse", "failed", 1, "ParseError")];
    for (const delivery of ["failed", "refused", "pending"] as const) {
      const html = live({
        status: "partial",
        verdict: null,
        delivery,
        progress: progressOf([...failed, ev("reply", "started", 2), ev("reply", "error", 2, "ReplyNotSent")]),
      });
      expect(html, delivery).toContain('hx-trigger="every 2s"');
    }
  });

  it("takes the stored send over an earlier failed reply step, as after a resend", () => {
    const html = live({
      delivery: "sent",
      progress: progressOf([ev("reply", "failed", 1, "Error"), ev("finish", "done", 5)]),
    });
    expect(html).not.toContain("We could not email this answer");
  });

  it("says a step being tried again as such", () => {
    const html = live({
      status: "running",
      verdict: null,
      progress: progressOf([ev("admit", "done", 0), ev("parse", "started", 1), ev("parse", "error", 1, "Error")]),
    });
    expect(html).toContain('data-announce="Step 2 of 7: Opened the message and its attachments (trying again)"');
  });

  it("shows the early authentication results while running, from the stored items (D07 T03 §37)", () => {
    const item = (id: string, check: string, state: string, summary: string, results: unknown[] = []) => ({
      id,
      check,
      severity: "info" as const,
      summary,
      detail: { state, results },
      artefacts: [],
    });
    const running = {
      status: "running" as const,
      verdict: null,
      progress: progressOf([ev("admit", "done", 0), ev("checks", "started", 1)]),
    };
    const html = live({
      ...running,
      coverage: [outcome("auth.spf", "ran"), outcome("auth.dkim", "ran"), outcome("auth.dmarc", "ran")],
      evidence: [
        item("E1", "auth.spf", "failed", "SPF failed for sender.example, as your receiving system recorded."),
        item("E2", "auth.dkim", "unavailable", "DKIM was not available, as your receiving system recorded.", [
          { result: "none", identifier: null },
        ]),
        item("E3", "auth.dmarc", "passed", "DMARC passed for sender.example, as your receiving system recorded."),
      ],
    });
    const card = html.indexOf("What the receiving mail system recorded");
    expect(card).toBeGreaterThan(html.indexOf("We are investigating this message."));
    expect(card).toBeLessThan(html.indexOf("Progress"));
    expect(html).toContain("Early result");
    expect(html).toContain("Read at 10:00:30 · before the investigation ends");
    expect(html).toContain("Sending server (SPF)");
    expect(html).toContain("Signature (DKIM)");
    expect(html).toContain("Domain policy (DMARC)");
    expect(html).toContain("Failed");
    expect(html).toContain("Not signed");
    expect(html).toContain("Passed");
    expect(html).toContain("SPF failed for sender.example, as your receiving system recorded.");
    expect(html).toContain(
      "These are what the receiving system recorded when the message arrived. They are not the verdict, and a later step may add to them.",
    );
    expect(html).toContain("Early authentication results are in.");
    // A DKIM the receiver did not report at all is not "Not signed".
    const absent = live({
      ...running,
      coverage: [outcome("auth.dkim", "ran")],
      evidence: [item("E2", "auth.dkim", "unavailable", "DKIM was not available, as your receiving system recorded.")],
    });
    expect(absent).toContain("Not reported");
    expect(absent).not.toContain("Not signed");
    // A failed auth check has its own row and invents no result.
    const failed = live({
      ...running,
      coverage: [outcome("auth.spf", "failed", "Timeout")],
      evidence: [],
    });
    expect(failed).toContain("Sending server (SPF)");
    expect(failed).toContain("Could not be checked");
    expect(failed).toContain("This check did not finish, so there is no result for it yet.");
    // Before the outcomes are stored there is no card, and a finished report has none either.
    expect(live({ ...running, coverage: [], evidence: [] })).not.toContain("What the receiving mail system recorded");
    expect(live({ coverage: [outcome("auth.spf", "ran")], evidence: [] })).not.toContain(
      "What the receiving mail system recorded",
    );
  });

  it("says why no authentication results were trusted, from the stored explanation (D07 T03 §37)", () => {
    const running = {
      status: "running" as const,
      verdict: null,
      progress: progressOf([ev("admit", "done", 0), ev("checks", "started", 1)]),
    };
    const skipped = [outcome("auth.spf", "skipped"), outcome("auth.dkim", "skipped"), outcome("auth.dmarc", "skipped")];
    const explained = live({
      ...running,
      coverage: skipped,
      evidence: [
        {
          id: "E1",
          check: "auth.results",
          severity: "info" as const,
          summary:
            "Your organisation's receiving system is not known yet, so no Authentication-Results header could be trusted.",
          detail: { trusted: false, reason: "unknown-receiver" },
          artefacts: [],
        },
      ],
    });
    expect(explained).toContain("What the receiving mail system recorded");
    expect(explained).toContain("receiving system is not known yet");
    expect(explained).not.toContain("Sending server (SPF)");
    expect(explained).toContain("No trusted authentication results were stored.");
    const unexplained = live({ ...running, coverage: skipped, evidence: [] });
    expect(unexplained).toContain("No authentication results from a receiving system this service trusts were stored.");
  });

  // D07 T09 §19: diagnostic detail beside each method's result on the early card, from auth.spf, auth.dkim,
  // auth.dmarc and auth.results (including compauth, mixed pass/fail signatures, missing reasons, and hostile text).
  it("draws diagnostic detail for SPF, DKIM, DMARC and compauth, pairs mixed results, and renders hostile text inertly (D07 T09 §19)", () => {
    const running = {
      status: "running" as const,
      verdict: null,
      progress: progressOf([ev("admit", "done", 0), ev("checks", "started", 1)]),
    };
    const withAll = live({
      ...running,
      coverage: [
        outcome("auth.results", "ran"),
        outcome("auth.spf", "ran"),
        outcome("auth.dkim", "ran"),
        outcome("auth.dmarc", "ran"),
      ],
      evidence: [
        {
          id: "E1",
          check: "auth.results",
          severity: "info" as const,
          summary: "Microsoft 365, your receiving system, recorded spf fail, dkim pass, dkim fail, dmarc fail.",
          detail: {
            trusted: true,
            receiver: "microsoft",
            authservId: "mx.outlook.com",
            results: [
              {
                method: "spf",
                result: "fail",
                props: {
                  "smtp.mailfrom": "spoof@bounce.sender.example",
                  "client-ip": "198.51.100.42",
                },
              },
              {
                method: "spf",
                result: "pass",
                props: {
                  "smtp.helo": "helo.sender.example",
                  "client-ip": "198.51.100.42",
                },
              },
              {
                method: "dkim",
                result: "pass",
                props: { "header.d": "good.example", "header.i": "@good.example", "header.s": "sel1" },
              },
              {
                method: "dkim",
                result: "fail",
                props: {
                  "header.d": "bad.example",
                  "header.i": "billing@bad.example",
                  "header.s": "sel2",
                  reason: "bad signature",
                },
              },
              {
                method: "dmarc",
                result: "fail",
                props: { "header.from": "sender.example", action: "oreject" },
              },
              {
                method: "compauth",
                result: "fail",
                props: { reason: "000" },
              },
            ],
          },
          artefacts: [],
        },
        {
          id: "E2",
          check: "auth.spf",
          severity: "medium" as const,
          summary: "SPF failed for bounce.sender.example, as your receiving system recorded.",
          detail: {
            state: "failed",
            helo: true,
            results: [
              {
                result: "fail",
                identifier: "bounce.sender.example",
                comment: "domain does not designate 198.51.100.42 as permitted sender",
              },
              {
                result: "pass",
                identifier: "helo.sender.example",
                comment: null,
              },
            ],
          },
          artefacts: [],
        },
        {
          id: "E3",
          check: "auth.dkim",
          severity: "info" as const,
          summary: "DKIM passed for good.example and failed for bad.example, as your receiving system recorded.",
          detail: {
            state: "passed",
            results: [
              { result: "pass", identifier: "good.example", comment: null },
              {
                result: "fail",
                identifier: "bad.example",
                comment: "body hash did not verify <script>alert(1)</script>",
              },
            ],
          },
          artefacts: [],
        },
        {
          id: "E4",
          check: "auth.dmarc",
          severity: "high" as const,
          summary: "DMARC failed for sender.example, as your receiving system recorded. Its policy is reject.",
          detail: {
            state: "failed",
            from: "sender.example",
            policy: { certain: "reject" },
            results: [{ result: "fail", comment: "p=REJECT dis=REJECT" }],
          },
          artefacts: [],
        },
      ],
    });
    // SPF diagnostic detail: MAIL FROM result carries smtp.mailfrom (not HELO), and HELO result carries (HELO) + smtp.helo.
    expect(withAll).toContain(
      "bounce.sender.example, smtp.mailfrom=spoof@bounce.sender.example, IP 198.51.100.42: fail · domain does not designate 198.51.100.42 as permitted sender",
    );
    expect(withAll).not.toContain("bounce.sender.example (HELO)");
    expect(withAll).toContain("helo.sender.example (HELO), smtp.helo=helo.sender.example, IP 198.51.100.42: pass");
    // DKIM mixed results: passing signer has no invented failure reason; failing signer keeps both props.reason and comment, escaped.
    expect(withAll).toContain(
      '<li class="wrap-anywhere">good.example, header.i=@good.example, selector sel1: pass</li>',
    );
    expect(withAll).toContain(
      '<li class="wrap-anywhere">bad.example, header.i=billing@bad.example, selector sel2: fail · reason bad signature · body hash did not verify &lt;script&gt;alert(1)&lt;/script&gt;</li>',
    );
    expect(withAll).not.toContain("<script>alert(1)</script>");
    // DMARC diagnostic detail: From domain, Policy, and Result with action and comment.
    expect(withAll).toContain("From domain: sender.example");
    expect(withAll).toContain("Policy: reject");
    expect(withAll).toContain("Result: fail · action oreject · p=REJECT dis=REJECT");
    // Composite authentication from auth.results explains documented reason codes in plain English.
    expect(withAll).toContain(
      "Composite authentication (compauth): fail · reason 000 (explicit authentication failed)",
    );

    // Missing diagnostic reasons on failed results explicitly say "reason not recorded" even when DMARC policy/action exist,
    // HELO-only SPF says "(HELO)", and undocumented compauth codes say "(reason code not documented)".
    const missingReasons = live({
      ...running,
      coverage: [
        outcome("auth.results", "ran"),
        outcome("auth.spf", "ran"),
        outcome("auth.dkim", "ran"),
        outcome("auth.dmarc", "ran"),
      ],
      evidence: [
        {
          id: "E1",
          check: "auth.results",
          severity: "info" as const,
          summary: "Microsoft 365 recorded authentication results.",
          detail: {
            trusted: true,
            receiver: "microsoft",
            authservId: "mx.outlook.com",
            results: [
              { method: "dmarc", result: "fail", props: { "header.from": "sender.example", action: "oreject" } },
              { method: "compauth", result: "fail", props: { reason: "999" } },
            ],
          },
          artefacts: [],
        },
        {
          id: "E2",
          check: "auth.spf",
          severity: "info" as const,
          summary: "SPF passed for helo.example, as your receiving system recorded.",
          detail: {
            state: "passed",
            helo: true,
            results: [{ result: "pass", identifier: "helo.example", comment: null }],
          },
          artefacts: [],
        },
        {
          id: "E3",
          check: "auth.dkim",
          severity: "medium" as const,
          summary: "DKIM failed for a signature naming no signer, as your receiving system recorded.",
          detail: {
            state: "failed",
            results: [{ result: "fail", identifier: null, comment: null }],
          },
          artefacts: [],
        },
        {
          id: "E4",
          check: "auth.dmarc",
          severity: "medium" as const,
          summary: "DMARC failed for sender.example, as your receiving system recorded.",
          detail: {
            state: "failed",
            from: "sender.example",
            policy: { certain: "reject" },
            results: [{ result: "fail", comment: null }],
          },
          artefacts: [],
        },
      ],
    });
    expect(missingReasons).toContain('<li class="wrap-anywhere">helo.example (HELO): pass</li>');
    expect(missingReasons).toContain("no signer named: fail · reason not recorded");
    expect(missingReasons).toContain("Policy: reject");
    expect(missingReasons).toContain("Result: fail · action oreject · reason not recorded");
    expect(missingReasons).toContain(
      "Composite authentication (compauth): fail · reason 999 (reason code not documented)",
    );

    // Every documented Microsoft compauth code renders its exact documented explanation, and unknown codes stay marked.
    for (const [res, code, expected] of [
      ["fail", "000", "reason 000 (explicit authentication failed)"],
      ["fail", "001", "reason 001 (implicit authentication failed)"],
      ["fail", "002", "reason 002 (spoofed mail blocked by organisation policy)"],
      ["fail", "010", "reason 010 (DMARC failed with reject or quarantine policy for an organisation accepted domain)"],
      ["pass", "100", "reason 100 (explicit authentication passed)"],
      ["pass", "101", "reason 101 (DKIM signed by the From domain)"],
      ["pass", "102", "reason 102 (MAIL FROM and From domains aligned and SPF passed)"],
      ["pass", "103", "reason 103 (From domain aligned with the source IP PTR record)"],
      ["pass", "104", "reason 104 (source IP PTR record aligned with the From domain)"],
      ["pass", "108", "reason 108 (DKIM failed due to message body modification at an earlier legitimate hop)"],
      ["pass", "109", "reason 109 (authentication would pass despite no DMARC record)"],
      ["pass", "111", "reason 111 (SPF or DKIM aligned with the From domain despite a DMARC error)"],
      ["pass", "112", "reason 112 (DNS timeout prevented retrieving the DMARC record)"],
      [
        "pass",
        "115",
        "reason 115 (sent from a Microsoft 365 organisation where the From domain is an accepted domain)",
      ],
      ["pass", "116", "reason 116 (From domain MX record aligned with the connecting IP PTR record)"],
      ["pass", "130", "reason 130 (trusted ARC seal overrode a DMARC failure)"],
      ["softpass", "201", "reason 201 (From domain PTR record aligned with the connecting IP PTR subnet)"],
      ["softpass", "202", "reason 202 (From domain aligned with the connecting IP PTR domain)"],
      ["none", "501", "reason 501 (DMARC not enforced for a valid non-delivery report with established contact)"],
      [
        "none",
        "502",
        "reason 502 (DMARC not enforced for a valid non-delivery report of a message sent from this organisation)",
      ],
      ["fail", "601", "reason 601 (implicit authentication failed for an organisation accepted domain)"],
      ["pass", "701", "reason 701 (DMARC not enforced due to sender infrastructure history)"],
      ["pass", "702", "reason 702 (DMARC not enforced due to sender infrastructure history)"],
      ["pass", "703", "reason 703 (DMARC not enforced due to sender infrastructure history)"],
      ["pass", "704", "reason 704 (DMARC not enforced due to sender infrastructure history)"],
      ["none", "905", "reason 905 (DMARC not enforced due to complex routing)"],
      ["none", "888", "reason 888 (reason code not documented)"],
    ] as const) {
      const html = live({
        ...running,
        coverage: [
          outcome("auth.results", "ran"),
          outcome("auth.spf", "ran"),
          outcome("auth.dkim", "ran"),
          outcome("auth.dmarc", "ran"),
        ],
        evidence: [
          {
            id: "E1",
            check: "auth.results",
            severity: "info" as const,
            summary: "Microsoft 365 recorded authentication results.",
            detail: {
              trusted: true,
              receiver: "microsoft",
              authservId: "mx.outlook.com",
              results: [{ method: "compauth", result: res, props: { reason: code } }],
            },
            artefacts: [],
          },
          {
            id: "E2",
            check: "auth.spf",
            severity: "info" as const,
            summary: "SPF passed.",
            detail: { state: "passed", results: [{ result: "pass", identifier: "sender.example", comment: null }] },
            artefacts: [],
          },
          {
            id: "E3",
            check: "auth.dkim",
            severity: "info" as const,
            summary: "DKIM passed.",
            detail: { state: "passed", results: [{ result: "pass", identifier: "sender.example", comment: null }] },
            artefacts: [],
          },
          {
            id: "E4",
            check: "auth.dmarc",
            severity: "info" as const,
            summary: "DMARC passed.",
            detail: {
              state: "passed",
              from: "sender.example",
              policy: null,
              results: [{ result: "pass", comment: null }],
            },
            artefacts: [],
          },
        ],
      });
      expect(html).toContain(`Composite authentication (compauth): ${res} · ${expected}`);
    }
  });

  it("renders actual producer output for HELO-only and mixed SPF results alongside compauth 010 and 109 (D07 T09 §19)", async () => {
    const running = {
      status: "running" as const,
      verdict: null,
      progress: progressOf([ev("admit", "done", 0), ev("checks", "started", 1)]),
    };
    const reg = new CheckRegistry();
    registerAuthResultsCheck(reg);
    registerAuthChecks(reg);
    const makeView = (authHeader: string): CaseView => ({
      tenant: {
        orgId: "org-auth",
        channel: "email",
        receivers: [{ kind: "microsoft", pattern: "*.outlook.com" }],
        headersAvailable: true,
        trusted: { own: [], suppliers: [] },
      },
      raw: "raw/case-auth/message.eml",
      brands: bundled,
      senderHistory: null,
      domainAges: null,
      attachmentHeads: null,
      hiddenText: null,
      htmlAttachments: null,
      attachmentRisks: null,
      instructions: null,
      invisibleText: null,
      links: null,
      expansions: null,
      source: { kind: "message", path: "rfc822", otherOriginals: 0 },
      headers: [
        {
          name: "Received",
          value: "from AM6PR01.eurprd01.prod.outlook.com by AM6PR02.eurprd01.prod.outlook.com with HTTPS",
        },
        { name: "Authentication-Results", value: authHeader },
        {
          name: "Received",
          value: "from mail.sender.example (198.51.100.42) by AM5EUR01FT001.mail.protection.outlook.com with ESMTP",
        },
        { name: "From", value: "billing@sender.example" },
      ],
      text: null,
      html: null,
      attachments: [],
      truncated: [],
      omitted: 0,
    });

    // 1. Real producer output for a single HELO-only SPF result with stored smtp.helo and compauth=pass reason=109.
    const heloOnlyRun = await runChecksWithOutcomes(
      makeView(
        "spf=pass (sender IP is 198.51.100.42) smtp.helo=helo.sender.example; dkim=none; dmarc=bestguesspass action=none header.from=sender.example; compauth=pass reason=109",
      ),
      reg,
    );
    const heloOnlyHtml = live({
      ...running,
      coverage: heloOnlyRun.outcomes.map((o) => outcome(o.check, o.outcome)),
      evidence: heloOnlyRun.items.map((e, i) => ({ ...e, id: `E${i + 1}` })),
    });
    expect(heloOnlyHtml).toContain(
      "helo.sender.example (HELO), smtp.helo=helo.sender.example: pass · sender IP is 198.51.100.42",
    );
    expect(heloOnlyHtml).toContain(
      "Composite authentication (compauth): pass · reason 109 (authentication would pass despite no DMARC record)",
    );

    // 2. Real producer output for mixed MAIL FROM + HELO SPF results and compauth=fail reason=010.
    const mixedRun = await runChecksWithOutcomes(
      makeView(
        "spf=fail (sender IP is 198.51.100.42) smtp.mailfrom=spoof@bounce.sender.example; spf=pass smtp.helo=helo.sender.example; dkim=pass header.d=sender.example header.i=@sender.example header.s=s1; dmarc=fail action=oreject header.from=sender.example; compauth=fail reason=010",
      ),
      reg,
    );
    const mixedHtml = live({
      ...running,
      coverage: mixedRun.outcomes.map((o) => outcome(o.check, o.outcome)),
      evidence: mixedRun.items.map((e, i) => ({ ...e, id: `E${i + 1}` })),
    });
    expect(mixedHtml).toContain(
      "bounce.sender.example, smtp.mailfrom=spoof@bounce.sender.example: fail · sender IP is 198.51.100.42",
    );
    expect(mixedHtml).not.toContain("bounce.sender.example (HELO)");
    expect(mixedHtml).toContain("helo.sender.example (HELO), smtp.helo=helo.sender.example: pass");
    expect(mixedHtml).toContain(
      "Composite authentication (compauth): fail · reason 010 (DMARC failed with reject or quarantine policy for an organisation accepted domain)",
    );
  });
});

describe("the failed state", () => {
  it("names the failed step in words, with the reference and Upload it instead", () => {
    const html = live({
      status: "partial",
      verdict: null,
      progress: progressOf([ev("admit", "done", 0), ev("parse", "failed", 1, "ParseError")]),
    });
    expect(html).toContain("Check failed · no verdict");
    expect(html).toContain("The message could not be opened: its file is damaged or not a message.");
    expect(html).toContain("Reference 01JCASE0000000000000000000 · failed at step 2 of 7 · 10:00 SAST");
    // Read again a day later: the failure keeps its own time.
    const later = live({
      status: "partial",
      verdict: null,
      now: new Date(Date.UTC(2026, 10, 1, 15, 0)),
      progress: progressOf([ev("admit", "done", 0), ev("parse", "failed", 1, "ParseError")]),
    });
    expect(later).toContain("failed at step 2 of 7 · 10:00 SAST");
    expect(html).toMatch(/<a[^>]*href="\/upload"[^>]*>Upload it instead<\/a>/);
    expect(html).not.toContain("hx-trigger");
  });

  it("says a check that did not finish, naming no step, when no step recorded its failure", () => {
    const html = live({ status: "partial", verdict: null, progress: progressOf([ev("admit", "done", 0)]) });
    expect(html).toContain("The check did not finish.");
    expect(html).not.toContain("failed at step");
  });
});

describe("the status poll", () => {
  async function setup() {
    const orgId = `org-status-${crypto.randomUUID().slice(0, 8)}`;
    await db
      .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
      .bind(orgId, "Status Co", orgId, new Date().toISOString())
      .run();
    const email = `status-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
    const { cookie } = await signIn(email);
    const user = await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>();
    await db
      .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
      .bind(`m-${crypto.randomUUID()}`, orgId, user?.id, "member", new Date().toISOString())
      .run();
    const made = await createCase(db, { orgId, channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    await db.prepare("UPDATE cases SET status = 'running' WHERE id = ?").bind(id).run();
    return { orgId, cookie, id };
  }
  const event = (id: string, step: string, status: string) =>
    db
      .prepare("INSERT INTO case_events (case_id, step, status, started_at, ms) VALUES (?, ?, ?, ?, ?)")
      .bind(id, step, status, new Date().toISOString(), status === "started" ? null : 400)
      .run();
  const poll = (id: string, cookie?: string, search = "") =>
    call(`/r/${id}/status${search}`, { headers: cookie ? { cookie } : {} });

  it("answers the live region while running, the steps advancing and findings appearing, then the finished report once", async () => {
    const { cookie, id } = await setup();
    await event(id, "admit", "started");
    let html = await (await poll(id, cookie)).text();
    expect(html).toMatch(/^<div id="report-live"/);
    expect(html).toContain('hx-trigger="every 2s"');
    expect(html).toContain("Step 1 of 7");
    expect(html).toContain("Nothing found yet.");
    await event(id, "admit", "done");
    await event(id, "parse", "done");
    await event(id, "checks", "started");
    await saveEvidence(db, id, [
      {
        check: "sender.first_time",
        severity: "low",
        summary: "A first-time sender",
        detail: { history: "first", from: "x@y.example", headers: [] },
        artefacts: [],
      },
    ]);
    html = await (await poll(id, cookie)).text();
    expect(html).toContain("Step 3 of 7");
    expect(html).toContain("Found so far");
    expect(html.match(/id="e1"/g)?.length).toBe(1);
    await putStoredVerdict(db, id, { ...VERDICT, source: "rules" });
    await db.prepare("UPDATE cases SET status = 'done', verdict = 'suspicious' WHERE id = ?").bind(id).run();
    html = await (await poll(id, cookie)).text();
    expect(html).toMatch(/^<div id="report-live"/);
    expect(html).not.toContain("hx-trigger");
    expect(html).toContain("A stored headline.");
    expect(html).toContain('data-announce="Checked: Suspicious"');
  });

  // D07 T03 §18: the count line and the safe board's clean list are inside the polled region, so a report a reader
  // watched while it ran finishes with both, through the status route alone, for a member and a link holder.
  it("finishes a watched report with its count line and its clean checks, for a member and a link holder", async () => {
    const { orgId, cookie, id } = await setup();
    const link = new URL(await signReportLink(SECRET, id, orgId), "http://localhost").search;
    await event(id, "admit", "started");
    for (const html of [await (await poll(id, cookie)).text(), await (await poll(id, undefined, link)).text()]) {
      expect(html).not.toContain("checks ran");
      expect(html).not.toContain("Checks that found nothing");
    }
    await saveEvidence(
      db,
      id,
      [
        {
          check: "sender.first_time",
          severity: "info",
          summary: "A sender who has written before",
          detail: { history: "known", from: "x@y.example", headers: [] },
          artefacts: [],
        },
      ],
      undefined,
      undefined,
      [
        { check: "sender.first_time", outcome: "ran", reason: null, findings: 1 },
        { check: "domain.lookalike", outcome: "ran", reason: null, findings: 0 },
        { check: "content.hidden_text", outcome: "ran", reason: null, findings: 0 },
      ],
    );
    await putStoredVerdict(db, id, { ...VERDICT, verdict: "safe", source: "rules" });
    await db.prepare("UPDATE cases SET status = 'done', verdict = 'safe' WHERE id = ?").bind(id).run();
    for (const html of [await (await poll(id, cookie)).text(), await (await poll(id, undefined, link)).text()]) {
      expect(html).toMatch(/^<div id="report-live"/);
      expect(html).toContain("1 finding · 3 checks ran · nothing skipped");
      expect(html).toContain("Checks that found nothing");
      expect(html).toContain("Lookalike domains: nothing found");
      expect(html).toContain("Hidden text: nothing found");
      expect(html).not.toContain("Whether this sender has written before: nothing found");
    }
  });

  // D07 T09 §10: a stored examined set reaches the finished report through storage, for both readers.
  it("reads a clean check's examined set from storage into the finished report", async () => {
    const { cookie, id, orgId } = await setup();
    await saveEvidence(db, id, [], undefined, undefined, [
      {
        check: "domain.lookalike",
        outcome: "ran",
        reason: null,
        findings: 0,
        examined: { targets: ["one.example", "last.example"], omitted: 2 },
      },
    ]);
    await putStoredVerdict(db, id, { ...VERDICT, verdict: "safe", source: "rules" });
    await db.prepare("UPDATE cases SET status = 'done', verdict = 'safe' WHERE id = ?").bind(id).run();
    const link = new URL(await signReportLink(SECRET, id, orgId), "http://localhost").search;
    for (const html of [await (await poll(id, cookie)).text(), await (await poll(id, undefined, link)).text()]) {
      expect(html).toContain("See what this check examined");
      expect(html).toContain("one.example");
      expect(html).toContain("last.example");
      expect(html).toContain("2 more targets were examined but are not listed.");
    }
    // The finished page itself, on its first read and the next, for a member.
    for (let i = 0; i < 2; i++) {
      const page = await (await call(`/r/${id}`, { headers: { cookie, accept: "text/html" } })).text();
      expect(page).toContain("See what this check examined");
      expect(page).toContain("last.example");
      expect(page).toContain("2 more targets were examined but are not listed.");
    }
  });

  // D07 T03 §44: a clean outcome's stored summary reaches the report through storage, on the first read and the
  // next; if the report drops the summary the clean check falls back to "nothing found" and this fails.
  it("reads a clean check's summary from storage into the report, twice", async () => {
    const { cookie, id } = await setup();
    await saveEvidence(
      db,
      id,
      [
        {
          check: "sender.first_time",
          severity: "info",
          summary: "A sender who has written before",
          detail: { history: "known", from: "x@y.example", headers: [] },
          artefacts: [],
        },
      ],
      undefined,
      undefined,
      [
        { check: "sender.first_time", outcome: "ran", reason: null, findings: 1 },
        {
          check: "domain.lookalike",
          outcome: "ran",
          reason: null,
          findings: 0,
          summary: "No lookalike of karoo.example among the hosts read",
        },
        { check: "content.hidden_text", outcome: "ran", reason: null, findings: 0 },
      ],
    );
    await putStoredVerdict(db, id, { ...VERDICT, verdict: "safe", source: "rules" });
    await db.prepare("UPDATE cases SET status = 'done', verdict = 'safe' WHERE id = ?").bind(id).run();
    for (let read = 0; read < 2; read++) {
      const html = await (await poll(id, cookie)).text();
      expect(html).toContain("Lookalike domains: No lookalike of karoo.example among the hosts read");
      expect(html).not.toContain("Lookalike domains: nothing found");
      expect(html).toContain("Hidden text: nothing found");
    }
  });

  // D07 T03 §39: the count line's Check versions disclosure lists each check of the run shown with the Worker
  // version that ran it, "version not recorded" for a row stored before versions were kept, nothing when no
  // outcomes were stored, and the newer run's versions after a retry.
  it("lists each check's version for the run shown, and follows a retry", async () => {
    const { cookie, id } = await setup();
    const finish = async (revision: string | null) => {
      await saveEvidence(
        db,
        id,
        [
          {
            check: "sender.first_time",
            severity: "info",
            summary: "A sender who has written before",
            detail: { history: "known", from: "x@y.example", headers: [] },
            artefacts: [],
          },
        ],
        undefined,
        undefined,
        [
          { check: "sender.first_time", outcome: "ran", reason: null, findings: 1 },
          { check: "domain.lookalike", outcome: "ran", reason: null, findings: 0 },
        ],
        revision,
      );
      await putStoredVerdict(db, id, { ...VERDICT, verdict: "safe", source: "rules" });
      await db.prepare("UPDATE cases SET status = 'done', verdict = 'safe' WHERE id = ?").bind(id).run();
    };
    // Stored before versions were kept: no revision on the row.
    await finish(null);
    let html = await (await poll(id, cookie)).text();
    expect(html).toContain("Check versions");
    expect(html).toContain("Lookalike domains: version not recorded");
    // A retry (a new run id) with its own outcomes: the list is the newer run's.
    await db.prepare("UPDATE cases SET run_id = 'run-2' WHERE id = ?").bind(id).run();
    await finish("v-2026-11-02-9f2c");
    html = await (await poll(id, cookie)).text();
    expect(html).toContain("Lookalike domains: v-2026-11-02-9f2c");
    expect(html).not.toContain("version not recorded");
  });

  // D07 T09 §11: the outcomes and reasons as read back from storage, inside the disclosure.
  it("reads the outcome and reason beside each version back from storage", async () => {
    const { cookie, id } = await setup();
    await saveEvidence(
      db,
      id,
      [
        {
          check: "sender.first_time",
          severity: "info",
          summary: "A sender who has written before",
          detail: { history: "known", from: "x@y.example", headers: [] },
          artefacts: [],
        },
      ],
      undefined,
      undefined,
      [
        { check: "sender.first_time", outcome: "ran", reason: null, findings: 1 },
        { check: "content.hidden_text", outcome: "partial", reason: "a cut body part", findings: 0 },
        { check: "auth.spf", outcome: "skipped", reason: "the original's headers were not available", findings: 0 },
        { check: "domain.age", outcome: "failed", reason: "Timeout", findings: 0 },
      ],
      "v-stored",
    );
    await putStoredVerdict(db, id, { ...VERDICT, verdict: "safe", source: "rules" });
    await db.prepare("UPDATE cases SET status = 'done', verdict = 'safe' WHERE id = ?").bind(id).run();
    const html = await (await poll(id, cookie)).text();
    const disclosure = html.slice(html.indexOf("Check versions"), html.indexOf("</details>"));
    expect(disclosure).toContain("Whether this sender has written before: v-stored · ran");
    expect(disclosure).toContain("Hidden text: v-stored · read part of its input: a cut body part");
    expect(disclosure).toContain("The sending server check (SPF): v-stored · did not run");
    expect(disclosure).toContain("How old the domain is: v-stored · failed: it ran out of time");
  });

  // D07 T09 §12: detection data beside the version, from storage, only for brand-table checks, per run.
  it("reads detection data beside the version back from storage, per run", async () => {
    const { cookie, id } = await setup();
    const items = [
      {
        check: "sender.first_time",
        severity: "info" as const,
        summary: "A sender who has written before",
        detail: { history: "known", from: "x@y.example", headers: [] },
        artefacts: [],
      },
    ];
    const outcomes = [
      { check: "domain.lookalike", outcome: "ran" as const, reason: null, findings: 0 },
      { check: "auth.spf", outcome: "ran" as const, reason: null, findings: 0 },
    ];
    const finish = async (data: { revision: string; id: string; source: "kv" | "bundled" } | null) => {
      await saveEvidence(db, id, items, undefined, undefined, outcomes, "v-same", data);
      await putStoredVerdict(db, id, { ...VERDICT, verdict: "safe", source: "rules" });
      await db.prepare("UPDATE cases SET status = 'done', verdict = 'safe' WHERE id = ?").bind(id).run();
    };
    const disclosureOf = async () => {
      const html = await (await poll(id, cookie)).text();
      return html.slice(html.indexOf("Check versions"), html.indexOf("</details>"));
    };
    await finish({ revision: "rev-1", id: "brands-a", source: "kv" });
    let disclosure = await disclosureOf();
    expect(disclosure).toContain("Lookalike domains: v-same · ran · data rev-1 (brands-a, KV)");
    // An unrelated check carries no data claim, though its stored row holds the same provenance.
    expect(disclosure).not.toContain("The sending server check (SPF): v-same · ran · data");
    // A newer run under the same Worker version: different revision, then the same revision, another identity.
    await db.prepare("UPDATE cases SET run_id = 'run-2' WHERE id = ?").bind(id).run();
    await finish({ revision: "rev-2", id: "brands-a", source: "kv" });
    disclosure = await disclosureOf();
    expect(disclosure).toContain("data rev-2 (brands-a, KV)");
    expect(disclosure).not.toContain("rev-1");
    await finish({ revision: "rev-2", id: "brands-b", source: "bundled" });
    disclosure = await disclosureOf();
    expect(disclosure).toContain("data rev-2 (brands-b, bundled)");
    // The earlier run still reads its own provenance.
    await db.prepare("UPDATE cases SET run_id = NULL WHERE id = ?").bind(id).run();
    disclosure = await disclosureOf();
    expect(disclosure).toContain("data rev-1 (brands-a, KV)");
    // No provenance stored: an applicable check says so, never today's table.
    await db.prepare("UPDATE cases SET run_id = 'run-3' WHERE id = ?").bind(id).run();
    await finish(null);
    disclosure = await disclosureOf();
    expect(disclosure).toContain("Lookalike domains: v-same · ran · data not recorded");
    // A hostile stored identity is drawn as text.
    await finish({ revision: "rev-3", id: '<script>alert("x")</script>', source: "kv" });
    const html = await (await poll(id, cookie)).text();
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain("&lt;script&gt;alert");
  });

  it("draws no Check versions disclosure when no outcomes were stored", async () => {
    const { cookie, id } = await setup();
    await putStoredVerdict(db, id, { ...VERDICT, verdict: "safe", source: "rules" });
    await db.prepare("UPDATE cases SET status = 'done', verdict = 'safe' WHERE id = ?").bind(id).run();
    const html = await (await poll(id, cookie)).text();
    expect(html).not.toContain("Check versions");
  });

  // D07 T03 §49: the real Workflow producer's own events (D01 T03 §3's drive, Meta stubbed at fetch) read through
  // both report routes with §38's steps and words. The events are the producer's: if the step stops recording
  // them, the step and its words leave both routes and these fail.
  it("reads a real voice note's steps and refusal words from the producer's events", async () => {
    const store: Store = { bucket: (env as unknown as Env).ARTEFACTS, db };
    const voiceReply = () =>
      new Response(
        JSON.stringify({
          id: "r",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    request: "none",
                    request_quote: null,
                    claimed_identity: null,
                    identity_quote: null,
                    urgency: "low",
                    urgency_quote: null,
                    payment_quote: null,
                  }),
                },
              ],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
        { headers: { "content-type": "application/json", "cf-aig-log-id": "log-voice" } },
      );
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/responses")) return voiceReply();
      if (!url.endsWith("/asr/transcribe")) return real(input, init);
      return new Response(
        JSON.stringify({
          sessionId: "s-1",
          transcript: "Pay the new account today.",
          audioDurationMs: 3000,
          turns: [{ turnId: 1, startMs: 100, endMs: 2000, transcript: "Pay the new account today.", speaker: "A" }],
        }),
        { status: 200, headers: { "content-type": "application/json", "cf-aig-log-id": "log-1" } },
      );
    });
    await db.prepare("DELETE FROM model_spend").run();
    const runVoice = async (bytes: Uint8Array, mediaType = "audio/ogg") => {
      // The Workflow runs before any sign-in: a SELF dispatch moves step execution into the main isolate,
      // where this test's fetch stub does not apply (the producer's drive in test/voice/transcribe-step.test.ts
      // signs nobody in). The member is made after the run, before the routes are read.
      const orgId = `org-status-${crypto.randomUUID().slice(0, 8)}`;
      await db
        .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
        .bind(orgId, "Status Co", orgId, new Date().toISOString())
        .run();
      const made = await createCase(db, {
        orgId,
        channel: "upload",
        headersAvailable: false,
        uploadedBy: "user-status",
        sourceKind: "audio",
        uploadName: "voice-note.ogg",
        uploadMediaType: mediaType,
      });
      if (!made.ok) throw new Error(made.error.message);
      const id = made.value.id;
      await putAttachment(store, id, "voice-note.ogg", bytes, mediaType);
      const instance = await introspectWorkflowInstance((env as unknown as Env).ANALYSIS, id);
      try {
        await instance.modify(async (m) => {
          await m.disableRetryDelays();
          await m.disableSleeps();
        });
        await (env as unknown as Env).ANALYSIS.create({ id, params: { caseId: id } });
        await instance.waitForStatus("complete");
      } finally {
        await instance.dispose();
      }
      const steps = (
        await db
          .prepare("SELECT step, status FROM case_events WHERE case_id = ? ORDER BY id")
          .bind(id)
          .all<{ step: string; status: string }>()
      ).results.map((e) => `${e.step}:${e.status}`);
      return { steps, id, orgId };
    };
    // Every Workflow run finishes before the first sign-in (see runVoice), then one member reads every case.
    const voiceOrgs: string[] = [];
    let reader: string | null = null;
    const bothFor = async (run: { id: string; orgId: string }) => {
      if (!reader) {
        const email = `status-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
        const { cookie } = await signIn(email);
        const user = await db
          .prepare(`SELECT id FROM "user" WHERE lower(email) = ?`)
          .bind(email)
          .first<{ id: string }>();
        reader = cookie;
        for (const orgId of voiceOrgs) {
          await db
            .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
            .bind(`m-${crypto.randomUUID()}`, orgId, user?.id, "member", new Date().toISOString())
            .run();
        }
      }
      return [
        await (await call(`/r/${run.id}`, { headers: { cookie: reader, accept: "text/html" } })).text(),
        await (await poll(run.id, reader)).text(),
      ];
    };
    // A good recording: the producer's own done event carries the step into both routes, before the checks.
    const good = await runVoice(toneOgg);
    voiceOrgs.push(good.orgId);
    expect(good.steps).toContain("transcribe:done");
    // A damaged, an overlong and an unsupported recording: each partial case reads its own fix, from the class
    // the producer recorded, never as a failure on our side.
    const packets = oggPackets(toneOgg);
    const overlong = oggStream(
      packets.slice(0, 2).map((p) => p.packet),
      Array.from({ length: 620 }, () => packets.slice(2).map((p) => p.packet)).flat(),
      960,
    );
    const refusals: [Uint8Array, string, string, string][] = [
      [
        toneOgg.slice(0, toneOgg.length - 200),
        "audio/ogg",
        "CorruptAudio",
        "The recording is damaged, so it could not be transcribed. Replace it and upload it again.",
      ],
      [
        overlong,
        "audio/ogg",
        "AudioTooLong",
        "The recording is longer than 30 minutes, so it could not be transcribed. Shorten it to 30 minutes or less and upload it again.",
      ],
      [
        new Uint8Array([1, 2, 3]),
        "audio/amr",
        "UnsupportedAudio",
        "We cannot transcribe this recording's format. Send it as an Ogg, Opus, WAV or MP3 voice note.",
      ],
    ];
    const refusedRuns: { run: Awaited<ReturnType<typeof runVoice>>; errorClass: string; words: string }[] = [];
    for (const [bytes, mediaType, errorClass, words] of refusals) {
      const refused = await runVoice(bytes, mediaType);
      voiceOrgs.push(refused.orgId);
      expect(refused.steps, errorClass).toContain("transcribe:failed");
      refusedRuns.push({ run: refused, errorClass, words });
    }
    const goodPages = await bothFor(good);
    for (const html of goodPages) expect(html).toContain("Transcribed the voice note");
    for (const { run, errorClass, words } of refusedRuns) {
      for (const raw of await bothFor(run)) {
        const seen = raw.replaceAll("&#39;", "'");
        expect(seen, errorClass).toContain(words);
        expect(raw, errorClass).not.toContain("on our side");
        expect(raw, errorClass).not.toContain("/retry");
      }
    }
  });

  // D07 T03 §37: the early authentication card through the real routes, from stored outcomes and items, gone at the finish.
  it("draws the early authentication card through the status route while running, and not once finished", async () => {
    const { cookie, id } = await setup();
    await event(id, "admit", "done");
    await event(id, "checks", "started");
    let html = await (await poll(id, cookie)).text();
    expect(html).not.toContain("What the receiving mail system recorded");
    await saveEvidence(
      db,
      id,
      [
        {
          check: "auth.spf",
          severity: "medium",
          summary: "SPF failed for sender.example, as your receiving system recorded.",
          detail: { state: "failed", results: [{ result: "fail", identifier: "sender.example" }] },
          artefacts: [],
        },
        {
          check: "auth.dkim",
          severity: "info",
          summary: "DKIM was not available, as your receiving system recorded.",
          detail: { state: "unavailable", results: [{ result: "none", identifier: null }] },
          artefacts: [],
        },
      ],
      undefined,
      undefined,
      [
        { check: "auth.spf", outcome: "ran", reason: null, findings: 1 },
        { check: "auth.dkim", outcome: "ran", reason: null, findings: 1 },
      ],
    );
    html = await (await poll(id, cookie)).text();
    expect(html).toContain("What the receiving mail system recorded");
    expect(html).toContain("Not signed");
    expect(html).toContain("Early authentication results are in.");
    await putStoredVerdict(db, id, { ...VERDICT, source: "rules" });
    await db.prepare("UPDATE cases SET status = 'done', verdict = 'suspicious' WHERE id = ?").bind(id).run();
    html = await (await poll(id, cookie)).text();
    expect(html).not.toContain("What the receiving mail system recorded");
  });

  // D07 T09 §1, §19: from the producer's early save alone (D01 T01 §23), while the slower checks still run,
  // reading back full supporting details and missing-reason markers on both initial page load and status polling.
  it("draws the early card from only the auth outcomes the producer stored first, while checks still run", async () => {
    const { cookie, id } = await setup();
    await event(id, "admit", "done");
    await event(id, "checks", "started");
    await saveEvidence(
      db,
      id,
      [
        {
          check: "auth.results",
          severity: "info",
          summary: "Microsoft 365, your receiving system, recorded spf fail, dkim pass, dkim fail, dmarc fail.",
          detail: {
            trusted: true,
            receiver: "microsoft",
            authservId: "mx.outlook.com",
            results: [
              {
                method: "spf",
                result: "fail",
                props: { "smtp.mailfrom": "spoof@sender.example", "client-ip": "198.51.100.42" },
              },
              {
                method: "dkim",
                result: "pass",
                props: { "header.d": "sender.example", "header.i": "@sender.example", "header.s": "sel1" },
              },
              {
                method: "dkim",
                result: "fail",
                props: {
                  "header.d": "bad.example",
                  "header.i": "billing@bad.example",
                  "header.s": "sel2",
                  reason: "bad signature",
                },
              },
              { method: "dmarc", result: "fail", props: { "header.from": "sender.example", action: "oreject" } },
              { method: "compauth", result: "fail", props: { reason: "000" } },
            ],
          },
          artefacts: [],
        },
        {
          check: "auth.spf",
          severity: "medium",
          summary: "SPF failed for sender.example, as your receiving system recorded.",
          detail: { state: "failed", results: [{ result: "fail", identifier: "sender.example", comment: null }] },
          artefacts: [],
        },
        {
          check: "auth.dkim",
          severity: "info",
          summary: "DKIM passed for sender.example and failed for bad.example, as your receiving system recorded.",
          detail: {
            state: "passed",
            results: [
              { result: "pass", identifier: "sender.example", comment: null },
              { result: "fail", identifier: "bad.example", comment: "body hash did not verify" },
            ],
          },
          artefacts: [],
        },
        {
          check: "auth.dmarc",
          severity: "high",
          summary: "DMARC failed for sender.example, as your receiving system recorded.",
          detail: {
            state: "failed",
            from: "sender.example",
            policy: null,
            results: [{ result: "fail", comment: null }],
          },
          artefacts: [],
        },
      ],
      undefined,
      undefined,
      [
        { check: "auth.results", outcome: "ran", reason: null, findings: 1 },
        { check: "auth.spf", outcome: "ran", reason: null, findings: 1 },
        { check: "auth.dkim", outcome: "ran", reason: null, findings: 1 },
        { check: "auth.dmarc", outcome: "ran", reason: null, findings: 1 },
      ],
    );
    const initialHtml = await (await call(`/r/${id}`, { headers: { cookie } })).text();
    const pollHtml = await (await poll(id, cookie)).text();
    for (const html of [initialHtml, pollHtml]) {
      expect(html).toContain("What the receiving mail system recorded");
      expect(html).toContain("Early authentication results are in.");
      // Still running: the page is still investigating, with no finished verdict drawn.
      expect(html).toContain("We are investigating this message.");
      // D07 T09 §19: stored supporting details and missing-reason markers read back through both routes.
      expect(html).toContain(
        "sender.example, smtp.mailfrom=spoof@sender.example, IP 198.51.100.42: fail · reason not recorded",
      );
      expect(html).toContain(
        '<li class="wrap-anywhere">sender.example, header.i=@sender.example, selector sel1: pass</li>',
      );
      expect(html).toContain(
        '<li class="wrap-anywhere">bad.example, header.i=billing@bad.example, selector sel2: fail · reason bad signature · body hash did not verify</li>',
      );
      expect(html).toContain("From domain: sender.example");
      expect(html).toContain("Policy: not recorded");
      expect(html).toContain("Result: fail · action oreject · reason not recorded");
      expect(html).toContain("Composite authentication (compauth): fail · reason 000 (explicit authentication failed)");
    }
  });

  // D07 T09 §5: the stored per-provider rows read back through the status route, for a member and a link holder.
  it("draws the stored per-provider reputation rows through the status route for both views", async () => {
    const { cookie, id, orgId } = await setup();
    await event(id, "admit", "done");
    await event(id, "checks", "started");
    await saveEvidence(
      db,
      id,
      [
        {
          check: "reputation.listing",
          severity: "high",
          summary: "A reputation provider lists this address.",
          detail: {
            provider: "Web Risk",
            listed: "https://pay.example/reset",
            granularity: "url",
            corroborated: false,
          },
          artefacts: [],
        },
      ],
      undefined,
      undefined,
      [{ check: "reputation.listing", outcome: "ran", reason: null, findings: 1 }],
    );
    const run = await db
      .prepare("SELECT COALESCE(run_id, id) AS run FROM cases WHERE id = ?")
      .bind(id)
      .first<{ run: string }>();
    for (const [provider, subject, state, cached] of [
      ["google-web-risk", "https://pay.example/reset", "listed", 0],
      ["cloudflare", "pay.example", "clear", 1],
      ["well-known", "pay.example", "known", 0],
    ] as const)
      await db
        .prepare(
          "INSERT INTO reputation_results (case_id, run_id, provider, subject, state, obtained_at, cached, note) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
        )
        .bind(id, run?.run, provider, subject, state, "2026-10-27T08:00:00Z", cached)
        .run();
    const member = await (await poll(id, cookie)).text();
    expect(member).toContain("Google Web Risk</strong>: Listed");
    expect(member).toContain("Well-known list</strong>: On the well-known list");
    expect(member).toContain("from cache");
    const link = new URL(await signReportLink(SECRET, id, orgId), "http://localhost").search;
    const holder = await (await poll(id, undefined, link)).text();
    expect(holder).toContain("Google Web Risk</strong>: Listed");
    // Another case's rows never join this report.
    const other = await setup();
    const otherRun = await db
      .prepare("SELECT COALESCE(run_id, id) AS run FROM cases WHERE id = ?")
      .bind(other.id)
      .first<{ run: string }>();
    await db
      .prepare(
        "INSERT INTO reputation_results (case_id, run_id, provider, subject, state, obtained_at, cached, note) VALUES (?, ?, 'cloudflare', 'other.example', 'listed', '2026-10-27T08:00:00Z', 0, NULL)",
      )
      .bind(other.id, otherRun?.run)
      .run();
    const again = await (await poll(id, cookie)).text();
    expect(again).not.toContain("other.example");
    // Rows stored under another run of this same case never join this run's report.
    await db
      .prepare(
        "INSERT INTO reputation_results (case_id, run_id, provider, subject, state, obtained_at, cached, note) VALUES (?, 'another-run', 'cloudflare', 'stale.example', 'listed', '2026-10-27T08:00:00Z', 0, NULL)",
      )
      .bind(id)
      .run();
    expect(await (await poll(id, cookie)).text()).not.toContain("stale.example");
    // A retry's new run replaces the answers: the old run's rows go, the new run's rows arrive.
    await db.prepare("UPDATE cases SET run_id = 'run-b' WHERE id = ?").bind(id).run();
    await saveEvidence(
      db,
      id,
      [
        {
          check: "reputation.listing",
          severity: "high",
          summary: "A reputation provider lists this address.",
          detail: {
            provider: "Web Risk",
            listed: "https://new.example/reset",
            granularity: "url",
            corroborated: false,
          },
          artefacts: [],
        },
      ],
      undefined,
      undefined,
      [{ check: "reputation.listing", outcome: "ran", reason: null, findings: 1 }],
    );
    await db
      .prepare(
        "INSERT INTO reputation_results (case_id, run_id, provider, subject, state, obtained_at, cached, note) VALUES (?, 'run-b', 'google-web-risk', 'https://new.example/reset', 'clear', '2026-10-27T09:00:00Z', 0, NULL)",
      )
      .bind(id)
      .run();
    const retried = await (await poll(id, cookie)).text();
    expect(retried).not.toContain("pay.example");
    expect(retried).toContain("Not listed by this provider");
  });

  // D07 T03 §40: a case whose admission failed before its file was stored ends partial with `admit` failed (RawMissing);
  // the report words it by how the case came and offers that channel's own next step, never a retry that cannot succeed.
  async function failedAdmission(
    opts: { channel: "email" | "upload"; sourceKind: "mail" | "document" | "image" | "audio"; uploadName?: string },
    error = "RawMissing",
    step = "admit",
  ) {
    const orgId = `org-gone-${crypto.randomUUID().slice(0, 8)}`;
    await db
      .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
      .bind(orgId, "Gone Co", orgId, new Date().toISOString())
      .run();
    const email = `gone-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
    const { cookie } = await signIn(email);
    const user = await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>();
    await db
      .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
      .bind(`m-${crypto.randomUUID()}`, orgId, user?.id, "member", new Date().toISOString())
      .run();
    const made = await createCase(db, {
      orgId,
      channel: opts.channel,
      headersAvailable: false,
      sourceKind: opts.sourceKind,
      ...(opts.channel === "upload" ? { uploadedBy: user?.id as string } : {}),
      ...(opts.uploadName ? { uploadName: opts.uploadName } : {}),
    });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    await db.prepare("UPDATE cases SET status = 'partial' WHERE id = ?").bind(id).run();
    if (step !== "admit") {
      await event(id, "admit", "done");
      await event(id, "parse", "done");
    }
    await event(id, step, "started");
    await db
      .prepare(
        "INSERT INTO case_events (case_id, step, status, started_at, ms, error) VALUES (?, ?, 'failed', ?, 400, ?)",
      )
      .bind(id, step, new Date().toISOString(), error)
      .run();
    await event(id, "reply", "done");
    return { id, cookie, orgId };
  }

  it("words a file that never arrived by how it came, through the page and the poll", async () => {
    const hostile = '<script>alert("x")</script>.pdf';
    const cases = [
      { channel: "upload", sourceKind: "document", uploadName: "invoice-2026.pdf" },
      { channel: "upload", sourceKind: "image", uploadName: hostile },
      { channel: "upload", sourceKind: "audio", uploadName: "voicenote.mp3" },
      { channel: "upload", sourceKind: "document" },
      { channel: "email", sourceKind: "mail" },
    ] as const;
    for (const c of cases) {
      const { id, cookie } = await failedAdmission(c);
      const page = await (await call(`/r/${id}`, { headers: { cookie, accept: "text/html" } })).text();
      const polled = await (await poll(id, cookie)).text();
      for (const html of [page, polled]) {
        if (c.channel === "upload") {
          const named = "uploadName" in c ? c.uploadName : null;
          expect(html).toContain(
            named
              ? `The file &quot;${named.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")}&quot; did not arrive in full`
              : "The file did not arrive in full",
          );
          expect(html).not.toContain("<script>alert");
          expect(html).toContain(">Upload again<");
          expect(html).not.toContain("Upload it instead");
          expect(html).not.toContain("Forward it again");
        } else {
          expect(html).toContain("The message did not arrive in full, so it could not be checked.");
          expect(html).toContain("Forward it again.");
          expect(html).toContain(">Upload it instead<");
          expect(html).not.toContain(">Upload again<");
        }
        // The original is gone: no retry that could not succeed, and none of the old storage words.
        expect(html).not.toContain("/retry");
        expect(html).not.toContain("not found in storage");
      }
    }
  });

  // D07 T03 §16: the voice check's limits, beside a failed transcription, for an upload and a forwarded recording.
  it("states the voice limits beside a failed transcription, and not beside another failure", async () => {
    for (const c of [
      { channel: "upload", sourceKind: "audio", uploadName: "voicenote.mp3" },
      { channel: "email", sourceKind: "mail" },
    ] as const) {
      const { id, cookie } = await failedAdmission(c, "Timeout", "transcribe");
      for (const html of [
        await (await call(`/r/${id}`, { headers: { cookie, accept: "text/html" } })).text(),
        await (await poll(id, cookie)).text(),
      ]) {
        expect(html).toContain("The words would have been the speaker");
        expect(html).toContain("cloned or synthetic voices, are not detected");
      }
    }
    // A partial verdict with the same failed step shows it too, through the page and the poll.
    const partial = await failedAdmission(
      { channel: "upload", sourceKind: "audio", uploadName: "voicenote.mp3" },
      "Timeout",
      "transcribe",
    );
    await putStoredVerdict(db, partial.id, { ...VERDICT, source: "rules" });
    await db.prepare("UPDATE cases SET verdict = 'suspicious' WHERE id = ?").bind(partial.id).run();
    for (const html of [
      await (await call(`/r/${partial.id}`, { headers: { cookie: partial.cookie, accept: "text/html" } })).text(),
      await (await poll(partial.id, partial.cookie)).text(),
    ])
      expect(html).toContain("There is no transcript, so the recording");
    const { id, cookie } = await failedAdmission(
      { channel: "upload", sourceKind: "audio", uploadName: "voicenote.mp3" },
      "Timeout",
      "parse",
    );
    const html = await (await poll(id, cookie)).text();
    expect(html).not.toContain("cloned or synthetic voices");
  });

  // D07 T03 §48: §40's words are proven against the case the intake itself keeps (D01 T03 §12), not one set by hand: the
  // raw store refuses the write, `admitDelivery` ends the case partial with its admit step failed, and the report reads it.
  it("words a real failed admission, kept by the intake, through the page and the poll, for an email and an upload", async () => {
    const orgId = `org-real-${crypto.randomUUID().slice(0, 8)}`;
    await db
      .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
      .bind(orgId, "Real Co", orgId, new Date().toISOString())
      .run();
    const email = `real-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
    const { cookie } = await signIn(email);
    const user = await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>();
    await db
      .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
      .bind(`m-${crypto.randomUUID()}`, orgId, user?.id, "member", new Date().toISOString())
      .run();
    const refuse = async () => {
      throw new Error("R2 is down");
    };
    const common = { orgId, headersAvailable: false, store: refuse } as const;
    const failures = [
      admitDelivery(env as unknown as Env, {
        ...common,
        key: `real-mail-${crypto.randomUUID()}`,
        channel: "email",
        sourceKind: "mail",
      }),
      admitDelivery(env as unknown as Env, {
        ...common,
        key: `real-upload-${crypto.randomUUID()}`,
        channel: "upload",
        sourceKind: "document",
        uploadedBy: user?.id as string,
        uploadName: "invoice-2026.pdf",
      }),
    ];
    // Each delivery is refused for a retry, and neither case is removed.
    for (const outcome of await Promise.allSettled(failures)) {
      expect(outcome.status).toBe("rejected");
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(RetryDelivery);
    }
    const kept = await db
      .prepare("SELECT id, channel, status FROM cases WHERE org_id = ? ORDER BY channel")
      .bind(orgId)
      .all<{ id: string; channel: string; status: string }>();
    expect(kept.results.map((c) => [c.channel, c.status])).toEqual([
      ["email", "partial"],
      ["upload", "partial"],
    ]);
    for (const c of kept.results) {
      const failed = await db
        .prepare("SELECT step, status, error FROM case_events WHERE case_id = ? AND status = 'failed'")
        .bind(c.id)
        .all<{ step: string; status: string; error: string }>();
      expect(failed.results, c.channel).toEqual([{ step: "admit", status: "failed", error: "RawMissing" }]);
      const page = await (await call(`/r/${c.id}`, { headers: { cookie, accept: "text/html" } })).text();
      const polled = await (await poll(c.id, cookie)).text();
      for (const html of [page, polled]) {
        if (c.channel === "upload") {
          expect(html).toContain("The file &quot;invoice-2026.pdf&quot; did not arrive in full");
          expect(html).toContain(">Upload again<");
          expect(html).not.toContain("Forward it again");
        } else {
          expect(html).toContain("The message did not arrive in full, so it could not be checked.");
          expect(html).toContain("Forward it again.");
          expect(html).toContain(">Upload it instead<");
        }
        expect(html).not.toContain("/retry");
        expect(html).not.toContain("not found in storage");
        // Nothing is left to wait for: neither route keeps the page polling (no Workflow ran, no reply is coming).
        expect(html, c.channel).not.toContain("hx-trigger");
        expect(html, c.channel).not.toContain("hx-get");
      }
    }
  });

  // D07 T03 §38: the voice note's transcription is a step of its own, after parse, drawn only when the case recorded it.
  it("shows the transcribe step in each state through the page and the poll, advancing to the checks", async () => {
    const { cookie, id } = await setup();
    // The full page and the poll, as a reader opening the report and as one watching it.
    const both = async () => [
      await (await call(`/r/${id}`, { headers: { cookie, accept: "text/html" } })).text(),
      await (await poll(id, cookie)).text(),
    ];
    await event(id, "admit", "done");
    await event(id, "parse", "done");
    // No transcription recorded: seven steps, none of its words.
    for (const html of await both()) {
      expect(html).not.toContain("Transcribed the voice note");
      expect(html).toContain("Step 3 of 7");
    }
    await event(id, "transcribe", "started");
    for (const html of await both()) {
      expect(html).toContain("Transcribed the voice note");
      expect(html).toContain('data-announce="Step 3 of 8: Transcribed the voice note"');
      // In the step list (not the announcement above it): after parse, before the checks.
      const list = html.slice(html.indexOf("<ol"));
      expect(list.indexOf("Opened the message")).toBeLessThan(list.indexOf("Transcribed the voice note"));
      expect(list.indexOf("Transcribed the voice note")).toBeLessThan(list.indexOf("Checked the sender"));
    }
    // An error awaits another attempt: retrying; the next start is running again.
    await db
      .prepare(
        "INSERT INTO case_events (case_id, step, status, started_at, ms, error) VALUES (?, 'transcribe', 'error', ?, 300, 'Timeout')",
      )
      .bind(id, new Date().toISOString())
      .run();
    for (const html of await both()) expect(html).toContain("(trying again)");
    await event(id, "transcribe", "started");
    for (const html of await both()) expect(html).not.toContain("(trying again)");
    // Done clears the earlier error, and the report moves on to the checks.
    await event(id, "transcribe", "done");
    await event(id, "checks", "started");
    for (const html of await both()) {
      expect(html).toContain('data-announce="Step 4 of 8: Checked the sender');
      expect(html).not.toContain("Trying again");
      expect(html).not.toContain("trying again");
    }
  });

  // D07 T09 §7: the walkthrough step through the page and the poll, announced, between checks and verdict.
  it("shows the walkthrough step through the page and the poll, announced, advancing to the verdict", async () => {
    const { cookie, id } = await setup();
    const both = async () => [
      await (await call(`/r/${id}`, { headers: { cookie, accept: "text/html" } })).text(),
      await (await poll(id, cookie)).text(),
    ];
    await event(id, "admit", "done");
    await event(id, "parse", "done");
    await event(id, "checks", "done");
    await event(id, "walkthrough", "started");
    for (const html of await both()) {
      expect(html).toContain("Sign-in page walk in a contained browser");
      expect(html).toContain('data-announce="Step 4 of 8: Sign-in page walk in a contained browser"');
      const list = html.slice(html.indexOf("<ol"));
      expect(list.indexOf("Checked the sender")).toBeLessThan(list.indexOf("Sign-in page walk"));
      expect(list.indexOf("Sign-in page walk")).toBeLessThan(list.indexOf("Weighed the evidence"));
    }
    await event(id, "walkthrough", "done");
    await event(id, "verdict", "started");
    for (const html of await both()) {
      expect(html).toContain('data-announce="Step 5 of 8: Weighed the evidence');
    }
  });

  it("words each audio refusal as the member's to fix, by channel, with their own next step and no retry", async () => {
    const cases = [
      ["CorruptAudio", "The recording is damaged, so it could not be transcribed. Replace it and"],
      [
        "AudioTooLong",
        "The recording is longer than 30 minutes, so it could not be transcribed. Shorten it to 30 minutes or less and",
      ],
      [
        "UnsupportedAudio",
        "We cannot transcribe this recording's format. Send it as an Ogg, Opus, WAV or MP3 voice note.",
      ],
    ] as const;
    for (const [error, words] of cases)
      for (const channel of ["email", "upload"] as const) {
        const { id, cookie } = await failedAdmission(
          channel === "email"
            ? { channel, sourceKind: "mail" }
            : { channel, sourceKind: "audio", uploadName: "note.ogg" },
          error,
          "transcribe",
        );
        const page = await (await call(`/r/${id}`, { headers: { cookie, accept: "text/html" } })).text();
        for (const html of [page, await (await poll(id, cookie)).text()]) {
          // The page escapes an apostrophe as an entity; the words are compared as a reader sees them.
          const seen = html.replaceAll("&#39;", "'");
          expect(seen, `${error} ${channel}`).toContain(words);
          if (error !== "UnsupportedAudio")
            expect(seen).toContain(channel === "upload" ? "upload it again." : "forward it again.");
          expect(html).not.toContain("on our side");
          expect(html).not.toContain("/retry");
          expect(html).toContain(channel === "upload" ? ">Upload again<" : ">Upload it instead<");
        }
      }
  });

  it("keeps the retry and the other failures' words for a failure a second run can mend", async () => {
    const { id, cookie } = await failedAdmission({ channel: "email", sourceKind: "mail" }, "ParseError");
    const html = await (await poll(id, cookie)).text();
    expect(html).toContain("The message could not be opened");
    expect(html).toContain(`action="/r/${id}/retry"`);
    expect(html).toContain(">Upload it instead<");
    expect(html).not.toContain("Upload again");
  });

  // §18's plan review on app-demo-suffix: a finished case whose verdict row is missing and whose outcomes were never
  // kept draws its findings count beside the coverage sentence that explains why it counts nothing else.
  it("counts a no-verdict report's findings beside the coverage sentence, its outcomes not kept", async () => {
    const { cookie, id } = await setup();
    await saveEvidence(db, id, [
      { check: "sender.first_time", severity: "low", summary: "A first-time sender", detail: {}, artefacts: [] },
      { check: "domain.age", severity: "medium", summary: "A young domain", detail: {}, artefacts: [] },
    ]);
    await db.prepare("UPDATE cases SET status = 'done', verdict = 'suspicious' WHERE id = ?").bind(id).run();
    const html = await (await call(`/r/${id}`, { headers: { cookie, accept: "text/html" } })).text();
    expect(html).toContain("2 findings");
    expect(html).not.toContain("checks ran");
    expect(html).toContain("Coverage not recorded for this check");
  });

  // §18's completion review on app-demo-suffix: a failed report explains its coverage as every terminal report does,
  // the checks that did not run named, or coverage not recorded, for a member and a link holder.
  it("explains a failed report's coverage beside its count, for both readers", async () => {
    const { orgId, cookie, id } = await setup();
    const link = new URL(await signReportLink(SECRET, id, orgId), "http://localhost").search;
    await saveEvidence(db, id, [
      { check: "sender.first_time", severity: "low", summary: "A first-time sender", detail: {}, artefacts: [] },
    ]);
    await db.prepare("UPDATE cases SET status = 'partial' WHERE id = ?").bind(id).run();
    for (const html of [await (await poll(id, cookie)).text(), await (await poll(id, undefined, link)).text()]) {
      expect(html).toContain("We could not finish checking this message.");
      expect(html).toContain("1 finding");
      // Round 1: a check that failed before any outcome was stored is not an old case's missing record.
      expect(html).toContain("No check recorded an outcome before it stopped.");
      expect(html).not.toContain("it ran before each check's outcome was kept");
    }
    await saveEvidence(db, id, [], undefined, undefined, [
      { check: "domain.lookalike", outcome: "ran", reason: null, findings: 0 },
      { check: "domain.age", outcome: "failed", reason: "Timeout", findings: 0 },
    ]);
    for (const html of [await (await poll(id, cookie)).text(), await (await poll(id, undefined, link)).text()]) {
      expect(html).toContain("How old the domain is");
      expect(html).toContain("it ran out of time");
      expect(html).not.toContain("No check recorded an outcome");
    }
  });

  // The clean list is the safe board's alone: a suspicious or malicious verdict with checks that found nothing draws none.
  it("draws no clean list on a suspicious or malicious verdict whose checks found nothing", async () => {
    for (const verdict of ["suspicious", "malicious"] as const) {
      const { cookie, id } = await setup();
      await saveEvidence(db, id, [], undefined, undefined, [
        { check: "domain.lookalike", outcome: "ran", reason: null, findings: 0 },
        { check: "content.hidden_text", outcome: "ran", reason: null, findings: 0 },
      ]);
      await putStoredVerdict(db, id, { ...VERDICT, verdict, source: "rules" });
      await db.prepare("UPDATE cases SET status = 'done', verdict = ? WHERE id = ?").bind(verdict, id).run();
      const html = await (await poll(id, cookie)).text();
      expect(html, verdict).toContain("0 findings · 2 checks ran · nothing skipped");
      expect(html, verdict).not.toContain("Checks that found nothing");
    }
  });

  // §18's completion review: a check that stops after its outcomes were stored still says how much ran.
  it("keeps the count line on a report whose check failed after its outcomes were stored, for both readers", async () => {
    const { orgId, cookie, id } = await setup();
    const link = new URL(await signReportLink(SECRET, id, orgId), "http://localhost").search;
    await saveEvidence(db, id, [], undefined, undefined, [
      { check: "domain.lookalike", outcome: "ran", reason: null, findings: 0 },
      { check: "domain.age", outcome: "failed", reason: "Timeout", findings: 0 },
    ]);
    // A failed check is a case left partial with no verdict.
    await db.prepare("UPDATE cases SET status = 'partial' WHERE id = ?").bind(id).run();
    for (const html of [await (await poll(id, cookie)).text(), await (await poll(id, undefined, link)).text()]) {
      expect(html).toContain("We could not finish checking this message.");
      expect(html).toContain("0 findings · 1 check ran · 1 failed");
      expect(html).toContain("Nothing was found before the check stopped.");
      expect(html).not.toContain("Checks that found nothing");
    }
  });

  it("serves a link holder, keeping the link on the next poll", async () => {
    const { orgId, id } = await setup();
    const link = new URL(await signReportLink(SECRET, id, orgId), "http://localhost");
    const html = await (await poll(id, undefined, link.search)).text();
    expect(html).toContain(`hx-get="/r/${id}/status${link.search.replaceAll("&", "&amp;")}"`);
  });

  it("sends a poll with no access to the full report, and answers an outage with 503 to poll through", async () => {
    const { id, cookie } = await setup();
    const stranger = (await signIn(`other-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`)).cookie;
    for (const res of [await poll(id, stranger), await poll(id)]) {
      expect(res.status).toBe(204);
      expect(res.headers.get("hx-redirect")).toBe(`/r/${id}`);
    }
    // A link past its expiry, or with another case's signature, sends the page to the full report too.
    const { orgId: other } = await setup();
    const expired = new URL(
      await signReportLink(SECRET, id, other, Date.now() - 8 * 24 * 3600 * 1000),
      "http://localhost",
    );
    const forged = new URL(await signReportLink(SECRET, id, other), "http://localhost");
    for (const search of [expired.search, forged.search]) {
      const res = await poll(id, undefined, search);
      expect(res.status, search).toBe(204);
      expect(res.headers.get("hx-redirect"), search).toBe(`/r/${id}${search}`);
    }
    const prepare = db.prepare.bind(db);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/FROM case_events/.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    expect((await poll(id, cookie)).status).toBe(503);
  });
});
