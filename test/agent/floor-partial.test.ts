import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  applyFloor,
  ensurePartialAttachmentEvidence,
  FLOOR_PARTIAL_REVISION,
  FLOOR_REVISION,
  floorFor,
  MAX_FLOOR_IDS,
  replayFloor,
  sanitizePartialReason,
} from "../../src/agent/floor";
import { runAgent, SPARK } from "../../src/agent/loop";
import { ruleVerdict } from "../../src/agent/rule-verdict";
import { createToolExecutor, type ToolDeps } from "../../src/agent/tools";
import { attachmentRisksOf, MAX_MEMBERS_READ } from "../../src/checks/attachment-risk";
import { bundled } from "../../src/checks/brands";
import { caseViewOf } from "../../src/checks/case-view";
import { type Evidence, type EvidenceDraft, readEvidence, saveEvidence } from "../../src/checks/evidence";
import { checks } from "../../src/checks/index";
import { type CheckOutcome, runChecksWithOutcomes } from "../../src/checks/runner";
import { attachmentHeadsOf } from "../../src/checks/sniff";
import { createCase } from "../../src/db/cases";
import { ulid } from "../../src/db/ulid";
import { getVerdict, Reason, saveVerdict, storeVerdict, VerdictView } from "../../src/db/verdicts";
import type { Store } from "../../src/intake/store";
import { d1Budget } from "../../src/meta/budget";
import { verdict as runVerdictStep } from "../../src/pipeline/analysis-workflow";

const META = { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" };

const enc = (text: string) => new TextEncoder().encode(text);
const pdfBytes = enc("%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF");

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i] as number;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = enc(entry.name);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + nameBytes.length + entry.data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, entry.data.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(entry.data, 30 + nameBytes.length);
    parts.push(local);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);
    offset += local.length;
  }
  const cdLength = central.reduce((sum, b) => sum + b.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdLength, true);
  ev.setUint32(16, offset, true);

  const total = offset + cdLength + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of [...parts, ...central, eocd]) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

async function seedCaseWithId(headersAvailable = 1): Promise<{ caseId: string; orgId: string }> {
  const orgId = `org_${ulid()}`;
  const created = await createCase(env.DB, {
    orgId,
    channel: "email",
    headersAvailable: headersAvailable === 1,
  });
  if (!created.ok) throw new Error(created.error.message);
  return { caseId: created.value.id, orgId };
}

function stubTools(): ToolDeps {
  return {
    expand: async () => [],
    screenshot: async () => [],
    lookupDomain: async () => [],
    ledger: async () => [],
    walk: async () => [],
  };
}

function stubMetaFetch(answer: {
  verdict: "safe" | "suspicious" | "malicious";
  confidence?: number;
  headline?: string;
  explanation?: string;
  cited_evidence_ids: string[];
  recommended_actions?: string[];
  meaning?: string;
}): typeof fetch {
  let turn = 0;
  return async () => {
    turn += 1;
    const payload =
      turn === 1
        ? {
            id: "resp_turn_1",
            object: "response",
            status: "completed",
            model: SPARK,
            output: [
              { type: "message", role: "assistant", content: [{ type: "output_text", text: "Ready to answer." }] },
            ],
            usage: { input_tokens: 40, output_tokens: 10 },
          }
        : {
            id: "resp_final",
            object: "response",
            status: "completed",
            model: SPARK,
            output: [
              {
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      verdict: answer.verdict,
                      confidence: answer.confidence ?? 0.85,
                      headline: answer.headline ?? "Model headline for the case",
                      explanation:
                        answer.explanation ??
                        `The case was reviewed using ${answer.cited_evidence_ids.map((id) => `[${id}]`).join(" ")}.`,
                      cited_evidence_ids: answer.cited_evidence_ids,
                      recommended_actions: answer.recommended_actions ?? ["Verify with the sender independently."],
                      meaning: answer.meaning ?? "Model meaning sentence without markers.",
                    }),
                  },
                ],
              },
            ],
            usage: { input_tokens: 50, output_tokens: 30 },
          };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", "x-request-id": "req-1" },
    });
  };
}

describe("D04 T01 §8: partial attachment checks weigh on the verdict", () => {
  it("gives an archive with members not read suspicious (unsure) and the same archive read whole safe (legit)", async () => {
    const store: Store = { bucket: env.ARTEFACTS, db: env.DB };

    const runArchiveCase = async (memberCount: number) => {
      const { caseId, orgId } = await seedCaseWithId(1);
      await env.CACHE.put(`ablate:${orgId}`, "no-agent-reasoning");
      const zipBytes = makeZip(
        Array.from({ length: memberCount }, (_, i) => ({ name: `doc-${i + 1}.pdf`, data: pdfBytes })),
      );
      const attKey = `art/${caseId}/attachment/bundle.zip`;
      await env.ARTEFACTS.put(attKey, zipBytes);
      const summary = {
        headers: [{ name: "From", value: "billing@example.org" }],
        text: "Please find the attached archive.",
        html: null,
        attachments: [
          {
            key: attKey,
            filename: "bundle.zip",
            mediaType: "application/zip",
            contentId: null,
            disposition: "attachment",
            charset: null,
            bytes: zipBytes.byteLength,
          },
        ],
        truncated: [] as [],
        omitted: 0,
        forward: { path: "inline" as const, headersAvailable: true, otherOriginals: 0 },
      };
      const baseView = caseViewOf(
        summary,
        {
          orgId,
          channel: "email",
          receivers: [],
          trusted: { own: [], suppliers: [] },
        },
        `raw/${caseId}/parsed.json`,
        bundled,
      );
      const heads = await attachmentHeadsOf(env.ARTEFACTS, baseView.attachments);
      const risks = await attachmentRisksOf(env.ARTEFACTS, { ...baseView, attachmentHeads: heads });
      const view = {
        ...baseView,
        attachmentHeads: heads,
        attachmentRisks: risks,
      };
      const { items, outcomes } = await runChecksWithOutcomes(view, checks);
      await saveEvidence(env.DB, caseId, items, undefined, undefined, outcomes);
      await env.DB.prepare("UPDATE cases SET status = 'running' WHERE id = ?").bind(caseId).run();
      const result = await runVerdictStep(env, env.DB, store, caseId);
      const saved = await storeVerdict(env.DB, orgId, caseId, result.view);
      expect(saved.ok).toBe(true);
      const readBack = await getVerdict(env.DB, caseId);
      if (!readBack || !readBack.ok) throw new Error("expected stored verdict");
      return { caseId, outcomes, verdict: readBack.value, evidence: await readEvidence(env.DB, caseId) };
    };

    const partialCase = await runArchiveCase(MAX_MEMBERS_READ + 2);
    expect(partialCase.outcomes.filter((o) => o.check.startsWith("attachment.") && o.outcome === "partial")).toEqual([
      expect.objectContaining({
        check: "attachment.macro",
        outcome: "partial",
        reason: "2 archive members not read by content",
      }),
      expect.objectContaining({
        check: "attachment.executable",
        outcome: "partial",
        reason: "2 archive members not read by content",
      }),
    ]);
    expect(partialCase.verdict.verdict).toBe("suspicious");
    expect(partialCase.verdict.reasons[0]).toEqual({
      text: "Attachment check partial (attachment.macro, attachment.executable: 2 archive members not read by content).",
      evidenceIds: expect.any(Array),
    });
    const citedIds = partialCase.verdict.reasons[0]?.evidenceIds ?? [];
    expect(citedIds.length).toBeGreaterThanOrEqual(1);
    const byId = new Map(partialCase.evidence.map((e) => [e.id, e]));
    for (const id of citedIds) {
      const item = byId.get(id);
      expect(item?.check).toBe("agent.partial_check");
      expect(item?.detail.checked).toBe(false);
    }

    const wholeCase = await runArchiveCase(2);
    expect(wholeCase.outcomes.filter((o) => o.check.startsWith("attachment.") && o.outcome === "partial")).toEqual([]);
    expect(wholeCase.verdict.verdict).toBe("safe");
  });

  it("persists supporting partial-check evidence on unrelated-only or empty evidence and never cites an unrelated row", async () => {
    // 1. Unrelated SPF row only
    const { caseId: unrelatedCase } = await seedCaseWithId(1);
    const spfDraft: EvidenceDraft = {
      check: "auth.spf",
      severity: "info",
      summary: "SPF passed for example.org.",
      detail: { result: "pass" },
      artefacts: [],
    };
    const outcomes: CheckOutcome[] = [
      { check: "auth.spf", outcome: "ran", reason: null, findings: 1 },
      {
        check: "attachment.macro",
        outcome: "partial",
        reason: "2 archive members not read by content",
        findings: 0,
      },
    ];
    await saveEvidence(env.DB, unrelatedCase, [spfDraft], undefined, undefined, outcomes);
    const initial = await readEvidence(env.DB, unrelatedCase);
    expect(initial).toHaveLength(1);
    expect(initial[0]?.id).toBe("E1");

    const withSupport = await ensurePartialAttachmentEvidence(env.DB, unrelatedCase, initial, outcomes);
    expect(withSupport).toHaveLength(2);
    expect(withSupport[1]?.id).toBe("E2");
    expect(withSupport[1]?.check).toBe("agent.partial_check");

    const rules = ruleVerdict(withSupport, { headersAvailable: true, outcomes });
    expect(rules.verdict).toBe("suspicious");
    expect(rules.reasons[0]).toEqual({
      text: "Attachment check partial (attachment.macro: 2 archive members not read by content).",
      evidenceIds: ["E2"],
    });
    expect(rules.reasons[0]?.evidenceIds).not.toContain("E1");

    // 2. Empty initial evidence
    const { caseId: emptyCase } = await seedCaseWithId(1);
    await saveEvidence(env.DB, emptyCase, [], undefined, undefined, [outcomes[1] as CheckOutcome]);
    const fromEmpty = await ensurePartialAttachmentEvidence(env.DB, emptyCase, [], [outcomes[1] as CheckOutcome]);
    expect(fromEmpty).toHaveLength(1);
    expect(fromEmpty[0]?.id).toBe("E1");
    expect(fromEmpty[0]?.check).toBe("agent.partial_check");
    const emptyVerdict = ruleVerdict(fromEmpty, { headersAvailable: true, outcomes: [outcomes[1] as CheckOutcome] });
    expect(emptyVerdict.verdict).toBe("suspicious");
    expect(emptyVerdict.reasons[0]?.evidenceIds).toEqual(["E1"]);
    const saved = await saveVerdict(env.DB, emptyCase, emptyVerdict);
    expect(saved.ok).toBe(true);
    const readBack = await getVerdict(env.DB, emptyCase);
    if (!readBack || !readBack.ok) throw new Error("expected stored verdict");
    expect(readBack.value.reasons[0]).toEqual({
      text: "Attachment check partial (attachment.macro: 2 archive members not read by content).",
      evidenceIds: ["E1"],
    });
  });

  it("retains revision 1 behavior in replayFloor and reproduces partial-only raises under revision 2", () => {
    const evidence: Evidence[] = [
      {
        id: "E1",
        check: "auth.spf",
        severity: "info",
        summary: "SPF passed.",
        detail: {},
        artefacts: [],
      },
      {
        id: "E2",
        check: "agent.partial_check",
        severity: "info",
        summary: "Attachment check attachment.macro was partial: 2 archive members not read by content.",
        detail: { checked: false, check: "attachment.macro", reason: "2 archive members not read by content" },
        artefacts: [],
      },
    ];
    const outcomes: CheckOutcome[] = [
      {
        check: "attachment.macro",
        outcome: "partial",
        reason: "2 archive members not read by content",
        findings: 0,
      },
    ];
    expect(FLOOR_REVISION).toBe("1");
    expect(FLOOR_PARTIAL_REVISION).toBe("2");

    // Revision 1 replays severity-only (safe on info items, even when partial outcomes or agent.partial_check exist).
    expect(replayFloor(FLOOR_REVISION, evidence, undefined, outcomes)).toEqual({
      verdict: "safe",
      evidenceIds: [],
    });

    // Revision 2 reproduces the suspicious raise from outcomes or from persisted agent.partial_check evidence alone.
    const floorV2 = floorFor(evidence, outcomes);
    expect(floorV2.verdict).toBe("suspicious");
    expect(floorV2.evidenceIds).toEqual(["E2"]);
    expect(floorV2.revision).toBe("2");
    expect(replayFloor(FLOOR_PARTIAL_REVISION, evidence, undefined, outcomes)).toEqual(floorV2);
    expect(replayFloor(FLOOR_PARTIAL_REVISION, evidence)).toEqual(floorV2);

    const applied = applyFloor("safe", floorV2);
    expect(applied).toEqual({
      verdict: "suspicious",
      floorApplied: {
        from: "safe",
        to: "suspicious",
        evidenceIds: ["E2"],
        revision: "2",
      },
    });
  });

  it("sanitizes markers, control characters, null reasons, and bounds long reasons and >10 IDs for persistence", async () => {
    expect(sanitizePartialReason(null)).toBe("part of the attachment could not be read");
    expect(sanitizePartialReason("   [E12]   ")).toBe("part of the attachment could not be read");
    expect(sanitizePartialReason("unread [E4] member\u0000\nnext")).toBe("unread member next");

    const manyOutcomes: CheckOutcome[] = Array.from({ length: 14 }, (_, i) => ({
      check: `attachment.check_${i + 1}`,
      outcome: "partial",
      reason: `unread segment ${i + 1} [E${i + 1}] ${"x".repeat(220)}`,
      findings: 0,
    }));
    const { caseId } = await seedCaseWithId(1);
    await saveEvidence(env.DB, caseId, [], undefined, undefined, manyOutcomes);
    const supported = await ensurePartialAttachmentEvidence(env.DB, caseId, [], manyOutcomes);
    expect(supported).toHaveLength(14);

    const floor = floorFor(supported, manyOutcomes);
    expect(floor.verdict).toBe("suspicious");
    expect(floor.evidenceIds).toHaveLength(MAX_FLOOR_IDS);
    expect(floor.partialReason?.evidenceIds).toHaveLength(MAX_FLOOR_IDS);
    expect(floor.partialReason?.text.length).toBeLessThanOrEqual(900);
    expect(floor.partialReason?.text).not.toMatch(/\[E\d+\]/);
    expect(Reason.safeParse(floor.partialReason).success).toBe(true);

    const view = ruleVerdict(supported, { headersAvailable: true, outcomes: manyOutcomes });
    expect(VerdictView.safeParse(view).success).toBe(true);
    const saved = await saveVerdict(env.DB, caseId, view);
    expect(saved.ok).toBe(true);
  });

  it("covers agent safe (floored), agent already suspicious (unfloored), 3 existing reasons, malicious, fallback, null outcomes, and outcomes-read failure", async () => {
    const partialOutcome: CheckOutcome = {
      check: "attachment.executable",
      outcome: "partial",
      reason: "the archive is longer than is walked",
      findings: 1,
    };

    // 1. Agent answers safe -> floored to suspicious with revision 2 and partial reason persisted
    {
      const { caseId } = await seedCaseWithId(1);
      const drafts: EvidenceDraft[] = [
        {
          check: "attachment.executable",
          severity: "info",
          summary: "many.rar was not fully checked because the archive is longer than is walked.",
          detail: { checked: false, filename: "many.rar" },
          artefacts: [],
        },
      ];
      await saveEvidence(env.DB, caseId, drafts, undefined, undefined, [partialOutcome]);
      const executor = createToolExecutor({ db: env.DB, caseId, urls: [] }, stubTools());
      const view = await runAgent(
        {
          db: env.DB,
          meta: {
            env: META,
            budget: d1Budget(env.DB, { caller: "verdict-agent", caseId }),
            fetch: stubMetaFetch({ verdict: "safe", cited_evidence_ids: ["E1"] }),
          },
          summary: "Archive check",
          headersAvailable: true,
          executor,
        },
        caseId,
      );
      expect(view.verdict).toBe("suspicious");
      expect(view.floorApplied).toEqual({
        from: "safe",
        to: "suspicious",
        evidenceIds: ["E1"],
        revision: "2",
      });
      expect(view.reasons[0]).toEqual({
        text: "Attachment check partial (attachment.executable: the archive is longer than is walked).",
        evidenceIds: ["E1"],
      });
      const stored = await getVerdict(env.DB, caseId);
      if (!stored || !stored.ok) throw new Error("expected stored verdict");
      expect(stored.value.reasons[0]?.text).toBe(
        "Attachment check partial (attachment.executable: the archive is longer than is walked).",
      );
    }

    // 2. Agent already answers suspicious with 3 existing reasons -> floorApplied is null, partial warning stays in reasons
    {
      const { caseId } = await seedCaseWithId(1);
      const drafts: EvidenceDraft[] = [
        {
          check: "auth.spf",
          severity: "medium",
          summary: "SPF softfail on sender domain.",
          detail: {},
          artefacts: [],
        },
        {
          check: "auth.dkim",
          severity: "medium",
          summary: "DKIM signature did not verify.",
          detail: {},
          artefacts: [],
        },
        {
          check: "sender.first_time",
          severity: "low",
          summary: "First time seeing this sender.",
          detail: {},
          artefacts: [],
        },
        {
          check: "attachment.executable",
          severity: "info",
          summary: "many.rar was not fully checked.",
          detail: { checked: false },
          artefacts: [],
        },
      ];
      await saveEvidence(env.DB, caseId, drafts, undefined, undefined, [partialOutcome]);
      const executor = createToolExecutor({ db: env.DB, caseId, urls: [] }, stubTools());
      const view = await runAgent(
        {
          db: env.DB,
          meta: {
            env: META,
            budget: d1Budget(env.DB, { caller: "verdict-agent", caseId }),
            fetch: stubMetaFetch({
              verdict: "suspicious",
              cited_evidence_ids: ["E1", "E2", "E3"],
            }),
          },
          summary: "Three reasons plus partial attachment",
          headersAvailable: true,
          executor,
        },
        caseId,
      );
      expect(view.verdict).toBe("suspicious");
      expect(view.floorApplied).toBeNull();
      expect(view.reasons).toHaveLength(3);
      expect(view.reasons[2]).toEqual({
        text: "Attachment check partial (attachment.executable: the archive is longer than is walked).",
        evidenceIds: ["E4"],
      });
      const stored = await getVerdict(env.DB, caseId);
      if (!stored || !stored.ok) throw new Error("expected stored verdict");
      expect(stored.value.reasons[2]?.evidenceIds).toEqual(["E4"]);
    }

    // 3. Malicious result alongside partial attachment check stays malicious
    {
      const { caseId } = await seedCaseWithId(1);
      const drafts: EvidenceDraft[] = [
        {
          check: "attachment.executable",
          severity: "critical",
          summary: "run.exe is a Windows program.",
          detail: { filename: "run.exe" },
          artefacts: [],
        },
        {
          check: "attachment.executable",
          severity: "info",
          summary: "broken.zip was not fully checked.",
          detail: { checked: false },
          artefacts: [],
        },
      ];
      await saveEvidence(env.DB, caseId, drafts, undefined, undefined, [partialOutcome]);
      const view = ruleVerdict(await readEvidence(env.DB, caseId), {
        headersAvailable: true,
        outcomes: [partialOutcome],
      });
      expect(view.verdict).toBe("malicious");
      expect(view.reasons[0]?.evidenceIds).toEqual(["E1"]);
    }

    // 4. Forced fallback when model fails stores suspicious with the partial reason
    {
      const { caseId } = await seedCaseWithId(1);
      const drafts: EvidenceDraft[] = [
        {
          check: "attachment.executable",
          severity: "info",
          summary: "many.rar was not fully checked.",
          detail: { checked: false },
          artefacts: [],
        },
      ];
      await saveEvidence(env.DB, caseId, drafts, undefined, undefined, [partialOutcome]);
      const executor = createToolExecutor({ db: env.DB, caseId, urls: [] }, stubTools());
      const view = await runAgent(
        {
          db: env.DB,
          meta: {
            env: META,
            budget: d1Budget(env.DB, { caller: "verdict-agent", caseId }),
            fetch: async () => new Response("error", { status: 500 }),
          },
          summary: "Fallback with partial attachment",
          headersAvailable: true,
          executor,
        },
        caseId,
      );
      expect(view.source).toBe("rules");
      expect(view.verdict).toBe("suspicious");
      expect(view.reasons[0]).toEqual({
        text: "Attachment check partial (attachment.executable: the archive is longer than is walked).",
        evidenceIds: ["E1"],
      });
      const storedFallback = await getVerdict(env.DB, caseId);
      if (!storedFallback || !storedFallback.ok) throw new Error("expected stored fallback verdict");
      expect(storedFallback.value.source).toBe("rules");
      expect(storedFallback.value.verdict).toBe("suspicious");
      expect(storedFallback.value.floorApplied).toBeNull();
      expect(storedFallback.value.reasons[0]).toEqual({
        text: "Attachment check partial (attachment.executable: the archive is longer than is walked).",
        evidenceIds: ["E1"],
      });
    }

    // 5. Null outcomes do not raise the floor
    expect(
      floorFor(
        [
          {
            id: "E1",
            check: "auth.spf",
            severity: "info",
            detail: {},
          },
        ],
        null,
      ),
    ).toEqual({ verdict: "safe", evidenceIds: [] });

    // 6. Outcomes-read failure rejects rather than storing a safe verdict
    {
      const { caseId } = await seedCaseWithId(1);
      const brokenDb = new Proxy(env.DB, {
        get(target, prop, receiver) {
          if (prop === "prepare") {
            return (sql: string) => {
              if (sql.includes("check_outcomes")) {
                return {
                  bind: () => ({
                    all: async () => {
                      throw new Error("check_outcomes table unreadable");
                    },
                  }),
                };
              }
              return target.prepare(sql);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      const executor = createToolExecutor({ db: brokenDb, caseId, urls: [] }, stubTools());
      await expect(
        runAgent(
          {
            db: brokenDb,
            meta: {
              env: META,
              budget: d1Budget(env.DB, { caller: "verdict-agent", caseId }),
              fetch: stubMetaFetch({ verdict: "safe", cited_evidence_ids: ["E1"] }),
            },
            summary: "Broken outcomes DB",
            headersAvailable: true,
            executor,
          },
          caseId,
        ),
      ).rejects.toThrow("check_outcomes table unreadable");
      const stored = await getVerdict(env.DB, caseId);
      expect(stored).toBeNull();
    }
  });
});
