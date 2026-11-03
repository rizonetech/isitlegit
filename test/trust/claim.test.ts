// Claim detection (D05 T02 §2): every route independently and in combination, the 15-line
// signature boundary, runtime VoiceRead states, SAM crop manifest discovery and registered-logo
// comparison (PNG and rasterised SVG, positive, negative and failure paths), real D1/R2
// protectedIdentities + boundProtectedCandidates population (including cross-organisation member
// cases and inactive protection exclusion), CheckRegistry execution, D1 evidence and outcome
// persistence read-back, consumer schema validation, artefact provenance, and privacy.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { bundled } from "../../src/checks/brands";
import {
  boundProtectedCandidates,
  type CaseView,
  caseViewOf,
  MAX_CANDIDATE_DOMAINS,
  MAX_CANDIDATE_NAMES,
  MAX_PROTECTED_CANDIDATES,
} from "../../src/checks/case-view";
import { readCheckOutcomes, readEvidence, saveEvidence } from "../../src/checks/evidence";
import { CheckRegistry } from "../../src/checks/registry";
import { runChecksWithOutcomes } from "../../src/checks/runner";
import { createCase } from "../../src/db/cases";
import { ulid } from "../../src/db/ulid";
import { putArtefact } from "../../src/intake/store";
import { d1Budget } from "../../src/meta/budget";
import { BudgetExceeded } from "../../src/meta/guard";
import {
  type ClaimInput,
  claimEvidence,
  claimInputFromView,
  compareClaimLogos,
  detectClaims,
  fitSvgDimensions,
  readTrustClaimDetail,
  registerClaimCheck,
  runClaimDetectionWithLogos,
  withClaimLogos,
} from "../../src/trust/claim";
import { protectedIdentities, setIdentity } from "../../src/trust/identity";
import { storeLogo } from "../../src/trust/logo";
import { storeCrops } from "../../src/vision/sam";
import type { VoiceRead } from "../../src/voice/schema";
import { makeOrg, protectableOrg } from "./helpers";

const db = env.DB;
const bucket = env.ARTEFACTS;
const kv = env.CACHE;
const store = { db, bucket };
const META = { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" };

const FYNBOS = { orgId: "org-fynbos", names: ["Fynbos Freight"], domains: ["fynbosfreight.co.za"] };
const KAROO = { orgId: "org-karoo", names: ["Karoo Couriers"], domains: ["karoocouriers.co.za"] };

const base: ClaimInput = {
  fromName: null,
  fromDomain: null,
  replyToDomain: null,
  text: null,
  voice: null,
  candidates: [FYNBOS, KAROO],
  logoJudgements: [],
  unavailable: [],
};

const routes = (input: ClaimInput, org = "org-fynbos") =>
  detectClaims(input).find((h) => h.orgId === org)?.routes ?? [];

// Valid PNG generator (IHDR + zlib-compressed IDAT + IEND with valid CRCs) passing pngPixelsProblem.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const pngChunk = (type: string, data: Uint8Array) => {
  const typed = Uint8Array.from([...type].map((c) => c.charCodeAt(0)).concat([...data]));
  return [...be32(data.length), ...typed, ...be32(crc(typed))];
};
async function validPng(width = 16, height = 16, fill = 0): Promise<Uint8Array> {
  const rowLen = 1 + width;
  const raw = new Uint8Array(rowLen * height);
  for (let r = 0; r < height; r++) {
    raw[r * rowLen] = 0;
    raw.fill(fill & 0xff, r * rowLen + 1, (r + 1) * rowLen);
  }
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"));
  const idat = new Uint8Array(await new Response(stream).arrayBuffer());
  const ihdr = Uint8Array.from([...be32(width), ...be32(height), 8, 0, 0, 0, 0]);
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...pngChunk("IHDR", ihdr),
    ...pngChunk("IDAT", idat),
    ...pngChunk("IEND", new Uint8Array(0)),
  ]);
}

const metaReply = (body: unknown, status = 200) =>
  new Response(
    JSON.stringify({
      id: "resp-claim-logo",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(body) }] }],
      usage: { input_tokens: 120, output_tokens: 24 },
    }),
    {
      status,
      headers: { "content-type": "application/json", "cf-aig-log-id": "log-claim", "x-request-id": "req-claim" },
    },
  );

function buildMessageView(overrides: {
  orgId?: string;
  headers?: { name: string; value: string }[];
  text?: string | null;
  headersAvailable?: boolean;
  truncated?: { mediaType: string; charset: string | null; key: string; fullBytes: number; keptBytes: number }[];
  voice?: VoiceRead | null;
}): CaseView {
  const view = caseViewOf(
    {
      headers: overrides.headers ?? [],
      text: overrides.text !== undefined ? overrides.text : "Body line.",
      html: null,
      attachments: [],
      truncated: overrides.truncated ?? [],
      omitted: 0,
      forward: {
        path: overrides.headersAvailable === false ? "inline" : "eml",
        headersAvailable: overrides.headersAvailable ?? true,
        otherOriginals: 0,
      },
    },
    {
      orgId: overrides.orgId ?? "org-member",
      channel: "email",
      receivers: [],
      trusted: { own: [], suppliers: [] },
    },
    "raw/case-claim/message.eml",
    bundled,
  );
  if (overrides.voice !== undefined) view.voice = overrides.voice;
  return view;
}

beforeEach(async () => {
  await db.exec("DROP TRIGGER IF EXISTS fail_trust_events");
  await db.batch(
    [
      "check_outcomes",
      "evidence",
      "artefacts",
      "cases",
      "trust_events",
      "identities",
      "org_domains",
      "org_addresses",
    ].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
});

describe("claim routes", () => {
  it("detects display name, From exact and lookalike, Reply-To exact and lookalike independently", () => {
    expect(routes({ ...base, fromName: "Fynbos Freight" })).toEqual(["display-name"]);
    expect(routes({ ...base, fromName: "Fynbos Freight Accounts" })).toEqual(["display-name"]);
    expect(routes({ ...base, fromDomain: "mail.fynbosfreight.co.za" })).toEqual(["from-domain"]);
    // Lookalike techniques from D02 T03 §2: different TLD, edit distance, skeleton confusable, and added word.
    expect(routes({ ...base, fromDomain: "fynbosfreight.example" })).toEqual(["from-lookalike"]);
    expect(routes({ ...base, fromDomain: "fynb0sfreight.co.za" })).toEqual(["from-lookalike"]);
    expect(routes({ ...base, fromDomain: "fynbosfreight-payments.co.za" })).toEqual(["from-lookalike"]);
    expect(routes({ ...base, replyToDomain: "fynbosfreight.co.za" })).toEqual(["reply-to-domain"]);
    expect(routes({ ...base, replyToDomain: "billing.fynbosfreight.co.za" })).toEqual(["reply-to-domain"]);
    expect(routes({ ...base, replyToDomain: "fynbosfrieght.co.za" })).toEqual(["reply-to-lookalike"]);
    expect(routes({ ...base, replyToDomain: "fynbosfreight-billing.co.za" })).toEqual(["reply-to-lookalike"]);
    expect(routes({ ...base, fromDomain: "unrelated.example", replyToDomain: "also-unrelated.co.za" })).toEqual([]);
  });

  it("reads the signature at the exact 15-line boundary and excludes line -16 outside it", () => {
    // Exactly 15th line from the end (1 line with the name followed by 14 filler lines = 15 lines in the tail).
    const atBoundary15 = [
      ...Array(10).fill("Introductory paragraph line."),
      "Kind regards, Fynbos Freight",
      ...Array(14).fill("Footer disclaimer line."),
    ].join("\n");
    // 16th line from the end (1 line with the name followed by 15 filler lines = outside the 15-line tail).
    const outsideBoundary16 = [
      ...Array(10).fill("Introductory paragraph line."),
      "Kind regards, Fynbos Freight",
      ...Array(15).fill("Footer disclaimer line."),
    ].join("\n");
    const hitAt15 = detectClaims({ ...base, text: atBoundary15 });
    expect(hitAt15).toHaveLength(1);
    expect(hitAt15[0]?.routes).toEqual(["signature"]);
    expect(hitAt15[0]?.support[0]).toContain("Kind regards, Fynbos Freight");
    expect(routes({ ...base, text: outsideBoundary16 })).toEqual([]);
  });

  it("handles runtime VoiceRead states (matched with quote, absent identity, silent, incomplete, and not_checked)", () => {
    const readMatched: VoiceRead = {
      state: "read",
      claim: {
        request: "change_bank_details",
        requestQuote: "Please update our bank account today.",
        claimedIdentity: "Karoo Couriers",
        identityQuote: "Hi, this is Karoo Couriers calling about invoice 104.",
        urgency: "high",
        urgencyQuote: "Do this before two o'clock.",
        paymentQuote: null,
      },
      dropped: 0,
      complete: true,
    };
    const voiceHit = detectClaims({ ...base, voice: readMatched });
    expect(voiceHit).toHaveLength(1);
    expect(voiceHit[0]?.orgId).toBe("org-karoo");
    expect(voiceHit[0]?.routes).toEqual(["voice"]);
    expect(voiceHit[0]?.support[0]).toContain("Hi, this is Karoo Couriers calling about invoice 104.");

    const readAbsent: VoiceRead = {
      ...readMatched,
      claim: { ...readMatched.claim, claimedIdentity: null, identityQuote: null },
    };
    expect(claimEvidence({ ...base, voice: readAbsent })).toEqual([]);

    const silentVoice: VoiceRead = { state: "silent" };
    expect(claimEvidence({ ...base, voice: silentVoice })).toEqual([]);

    const failedVoice: VoiceRead = { state: "not_checked", reason: "model-timeout" };
    const failedItems = claimEvidence({ ...base, voice: failedVoice });
    expect(failedItems).toHaveLength(1);
    expect(failedItems[0]?.detail.checked).toBe(false);
    expect(failedItems[0]?.summary).toContain(
      "the voice note could not be checked (the reading service did not answer)",
    );
    expect(failedItems[0]?.summary).not.toContain("model-timeout");

    const incompleteVoice: VoiceRead = { ...readMatched, complete: false, cut: true };
    const incompleteItems = claimEvidence({ ...base, voice: incompleteVoice });
    expect(incompleteItems).toHaveLength(2);
    expect(incompleteItems[0]?.detail.orgId).toBe("org-karoo");
    expect(incompleteItems[1]?.detail.checked).toBe(false);
    expect(incompleteItems[1]?.detail.unavailable).toEqual(
      expect.arrayContaining([
        "part of the voice note was not transcribed",
        "the voice note was cut short before its end",
      ]),
    );
  });

  it("extracts original headers only when headersAvailable is true, reports truncated plain-text bodies, and never leaks unobserved registered domains on lookalikes", () => {
    const viewWithHeaders = buildMessageView({
      headersAvailable: true,
      headers: [
        { name: "From", value: '"Karoo Couriers" <accounts@fynbosfreight.example>' },
        { name: "Reply-To", value: "billing@fynbosfrieght.co.za, finance@karoocouriers.co.za" },
      ],
      text: "Hello,\nPlease see attached.\nRegards,\nFynbos Freight",
    });
    viewWithHeaders.protectedCandidates = boundProtectedCandidates([
      {
        orgId: "org-fynbos",
        names: ["Fynbos Freight"],
        domains: ["fynbosfreight.co.za", "fynbos-secret-internal.co.za"],
        logo: null,
      },
      { ...KAROO, logo: null },
    ]);

    const input = claimInputFromView(viewWithHeaders);
    const hits = detectClaims(input);
    expect(hits.map((h) => h.orgId).sort()).toEqual(["org-fynbos", "org-karoo"]);

    const fynbosHit = hits.find((h) => h.orgId === "org-fynbos");
    expect(fynbosHit?.routes).toEqual(["from-lookalike", "reply-to-lookalike", "signature"]);
    // Lookalike privacy (G5): unobserved registered domains ("fynbosfreight.co.za", "fynbos-secret-internal.co.za") must never appear in hits or evidence.
    const lookalikeEvidence = claimEvidence(input);
    const serialisedLookalike = JSON.stringify({ hits, lookalikeEvidence });
    expect(serialisedLookalike).not.toContain("fynbosfreight.co.za");
    expect(serialisedLookalike).not.toContain("fynbos-secret-internal.co.za");

    // Domain-only candidate on lookalike still hides the unobserved registered domain.
    const domainOnlyLookalike = claimEvidence({
      ...base,
      fromDomain: "fynb0sfreight.co.za",
      candidates: [{ orgId: "org-fynbos", names: [], domains: ["fynbosfreight.co.za"] }],
    });
    expect(JSON.stringify(domainOnlyLookalike)).not.toContain("fynbosfreight.co.za");
    expect(domainOnlyLookalike[0]?.detail.name).toBe("protected business");

    // Truncated plain-text body reports signature unavailability while retaining header claims.
    const truncatedView = buildMessageView({
      headersAvailable: true,
      headers: [{ name: "From", value: '"Fynbos Freight" <billing@fynbosfreight.example>' }],
      text: "Cut body line.",
      truncated: [
        {
          mediaType: "text/plain",
          charset: "utf-8",
          key: "raw/case-claim/body.txt",
          fullBytes: 120_000,
          keptBytes: 65_536,
        },
      ],
    });
    truncatedView.protectedCandidates = boundProtectedCandidates([{ ...FYNBOS, logo: null }]);
    const truncatedItems = claimEvidence(claimInputFromView(truncatedView));
    expect(truncatedItems).toHaveLength(2);
    expect(truncatedItems[0]?.detail.orgId).toBe("org-fynbos");
    expect(truncatedItems[0]?.detail.routes).toEqual(["display-name", "from-lookalike"]);
    expect(truncatedItems[1]?.detail.checked).toBe(false);
    expect(truncatedItems[1]?.detail.unavailable).toContain(
      "the plain-text body was cut short before its signature block",
    );

    // Inline forward (headersAvailable: false) must not trust headers, still detects signature, and states header unavailability.
    const inlineView = buildMessageView({
      headersAvailable: false,
      headers: [{ name: "From", value: '"Karoo Couriers" <accounts@karoocouriers.co.za>' }],
      text: "Forwarded message\nRegards,\nFynbos Freight",
    });
    inlineView.protectedCandidates = boundProtectedCandidates([
      { ...FYNBOS, logo: null },
      { ...KAROO, logo: null },
    ]);
    const inlineItems = claimEvidence(claimInputFromView(inlineView));
    expect(inlineItems).toHaveLength(2);
    expect(inlineItems[0]?.detail.orgId).toBe("org-fynbos");
    expect(inlineItems[0]?.detail.routes).toEqual(["signature"]);
    expect(inlineItems[1]?.detail.checked).toBe(false);
    expect(inlineItems[1]?.detail.unavailable).toContain("the original's headers were not available");
  });
});

describe("registered logo comparison and SAM crop manifest reading", () => {
  it("compares stored SAM logo crops against registered PNG and rasterised SVG logos, handling positive, negative and failure cases", async () => {
    const fynbosOrgId = await protectableOrg("fynbosfreight.co.za", "finance@fynbosfreight.co.za", "Fynbos Freight");
    await setIdentity(
      db,
      fynbosOrgId,
      "u-fynbos",
      {
        displayNames: ["Fynbos Freight (Pty) Ltd", "Fynbos Freight"],
        financeContact: "finance@fynbosfreight.co.za",
        protected: true,
      },
      new Date("2026-11-01T10:00:00Z"),
    );
    const fynbosLogoBytes = await validPng(24, 24, 0x42);
    await storeLogo(
      bucket,
      db,
      fynbosOrgId,
      "u-fynbos",
      fynbosLogoBytes,
      "image/png",
      new Date("2026-11-01T10:01:00Z"),
    );

    const karooOrgId = await protectableOrg("karoocouriers.co.za", "accounts@karoocouriers.co.za", "Karoo Couriers");
    await setIdentity(
      db,
      karooOrgId,
      "u-karoo",
      {
        displayNames: ["Karoo Couriers"],
        financeContact: "accounts@karoocouriers.co.za",
        protected: true,
      },
      new Date("2026-11-01T10:02:00Z"),
    );
    const svgBytes = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1a4d2e"/></svg>',
    );
    await storeLogo(bucket, db, karooOrgId, "u-karoo", svgBytes, "image/svg+xml", new Date("2026-11-01T10:03:00Z"));

    const memberOrgId = await makeOrg("Checking Member Org");
    const caseId = ulid();
    const created1 = await createCase(db, {
      id: caseId,
      orgId: memberOrgId,
      channel: "email",
      headersAvailable: true,
      forwardedBy: "staff@checking-member.co.za",
    });
    expect(created1.ok).toBe(true);

    // Store two generations of SAM crops for the rendered email so generation 2 supersedes generation 1.
    const staleCropPng = await validPng(16, 16, 0x11);
    const currentCropPng = await validPng(16, 16, 0x88);
    await storeCrops(
      store,
      caseId,
      { name: "desktop.png", key: `art/${caseId}/render/desktop.png`, sha256: "a".repeat(64) },
      [
        {
          box: { concept: "logo", left: 10, top: 10, right: 50, bottom: 50, confidence: 0.9 },
          bytes: staleCropPng,
          width: 40,
          height: 40,
        },
      ],
    );
    const storedGen2 = await storeCrops(
      store,
      caseId,
      { name: "desktop.png", key: `art/${caseId}/render/desktop.png`, sha256: "a".repeat(64) },
      [
        {
          box: { concept: "logo", left: 12, top: 12, right: 60, bottom: 60, confidence: 0.95 },
          bytes: currentCropPng,
          width: 48,
          height: 48,
        },
      ],
    );
    const currentLogoCropKey = storedGen2[0]?.key ?? "";
    expect(currentLogoCropKey).toContain("-logo-1.png");

    // Read real candidates from D1 via protectedIdentities + boundProtectedCandidates (D02 T01 §9).
    const candidates = boundProtectedCandidates(await protectedIdentities(db));
    expect(candidates.candidates.map((c) => c.orgId).sort()).toEqual([fynbosOrgId, karooOrgId].sort());

    const rasterisedSvgPng = await validPng(32, 32, 0xcc);
    let callCount = 0;
    const fetchPositiveFynbosNegativeKaroo = (async () => {
      callCount += 1;
      // Candidates are ordered by orgId; return positive for Fynbos and negative for Karoo.
      const isFynbosFirst = fynbosOrgId < karooOrgId ? callCount === 1 : callCount === 2;
      if (isFynbosFirst) {
        return metaReply({
          same_brand: true,
          brand_seen: "Fynbos Freight",
          differences: [],
          confidence: 0.94,
        });
      }
      return metaReply({
        same_brand: false,
        brand_seen: "Fynbos",
        differences: ["different emblem and wordmark"],
        confidence: 0.89,
      });
    }) as typeof fetch;

    const view = buildMessageView({
      orgId: memberOrgId,
      headers: [{ name: "From", value: '"Accounts" <billing@random-sender.example>' }],
      text: "Please pay the attached invoice.",
    });
    view.protectedCandidates = candidates;

    const { view: enrichedView, items } = await runClaimDetectionWithLogos(
      {
        store,
        meta: {
          env: META,
          budget: d1Budget(db, { caller: "vision", caseId }),
          owner: { kind: "case", caseId, step: "trust-claim" },
          fetch: fetchPositiveFynbosNegativeKaroo,
        },
        kv,
        rasteriseSvg: async () => rasterisedSvgPng,
      },
      caseId,
      view,
    );

    expect(callCount).toBe(2);
    expect(items).toHaveLength(1);
    expect(items[0]?.check).toBe("trust.claim");
    expect(items[0]?.severity).toBe("info");
    expect(items[0]?.artefacts).toEqual([currentLogoCropKey]);
    const reading = readTrustClaimDetail(items[0]?.detail);
    expect(reading.kind).toBe("claim");
    if (reading.kind === "claim") {
      expect(reading.detail.orgId).toBe(fynbosOrgId);
      expect(reading.detail.routes).toEqual(["logo"]);
      expect(reading.detail.logos?.[0]).toMatchObject({
        same: true,
        brandSeen: "Fynbos Freight",
        cropKey: currentLogoCropKey,
      });
    }

    // Run through CheckRegistry and persist to D1 with saveEvidence, then read back via readEvidence and readCheckOutcomes.
    const registry = new CheckRegistry();
    registerClaimCheck(registry);
    const { items: runItems, outcomes } = await runChecksWithOutcomes(enrichedView, registry);
    await saveEvidence(db, caseId, runItems, registry, undefined, outcomes);

    const storedEvidence = await readEvidence(db, caseId);
    expect(storedEvidence).toHaveLength(1);
    expect(storedEvidence[0]?.check).toBe("trust.claim");
    expect(storedEvidence[0]?.artefacts).toEqual([currentLogoCropKey]);
    const storedOutcomes = await readCheckOutcomes(db, caseId);
    expect(storedOutcomes).toEqual([
      expect.objectContaining({
        check: "trust.claim",
        outcome: "ran",
        findings: 1,
        summary: "Claims Fynbos Freight (Pty) Ltd by its logo",
      }),
    ]);

    // Privacy check: no finance contact, bank detail or registered `ident/...` key appears anywhere in evidence or outcomes.
    const serialised = JSON.stringify({ storedEvidence, storedOutcomes });
    expect(serialised).not.toContain("finance@fynbosfreight.co.za");
    expect(serialised).not.toContain("accounts@karoocouriers.co.za");
    expect(serialised).not.toContain(`ident/${fynbosOrgId}`);
    expect(serialised).not.toContain(`ident/${karooOrgId}`);
  });

  it("reports unavailable logo comparison when the model fails or SVG lacks a rasteriser, while keeping textual claims", async () => {
    const fynbosOrgId = await protectableOrg("fynbosfreight.co.za", "finance@fynbosfreight.co.za", "Fynbos Freight");
    await setIdentity(
      db,
      fynbosOrgId,
      "u-fynbos",
      {
        displayNames: ["Fynbos Freight"],
        financeContact: "finance@fynbosfreight.co.za",
        protected: true,
      },
      new Date("2026-11-01T11:00:00Z"),
    );
    const logoBytes = await validPng(20, 20, 0x55);
    await storeLogo(bucket, db, fynbosOrgId, "u-fynbos", logoBytes, "image/png", new Date("2026-11-01T11:01:00Z"));

    const caseId = ulid();
    const created2 = await createCase(db, {
      id: caseId,
      orgId: fynbosOrgId,
      channel: "email",
      headersAvailable: true,
      forwardedBy: "staff@fynbosfreight.co.za",
    });
    expect(created2.ok).toBe(true);
    const cropPng = await validPng(16, 16, 0x77);
    await storeCrops(
      store,
      caseId,
      { name: "desktop.png", key: `art/${caseId}/render/desktop.png`, sha256: "b".repeat(64) },
      [
        {
          box: { concept: "logo", left: 5, top: 5, right: 35, bottom: 35, confidence: 0.91 },
          bytes: cropPng,
          width: 30,
          height: 30,
        },
      ],
    );

    const candidates = boundProtectedCandidates(await protectedIdentities(db));
    const failingFetch = (async () => new Response("gateway error", { status: 502 })) as typeof fetch;

    const logoResult = await compareClaimLogos(
      {
        store,
        meta: {
          env: META,
          budget: d1Budget(db, { caller: "vision", caseId }),
          owner: { kind: "case", caseId, step: "trust-claim" },
          fetch: failingFetch,
        },
        kv,
      },
      caseId,
      candidates.candidates,
    );
    expect(logoResult.logoJudgements).toEqual([]);
    expect(logoResult.unavailable).toContain("a logo comparison could not be completed");
    expect(logoResult.unavailableCodes).toContain("comparison-failed");

    const view = withClaimLogos(
      buildMessageView({
        orgId: fynbosOrgId,
        headers: [{ name: "From", value: '"Fynbos Freight" <scammer@fynbosfreight.example>' }],
      }),
      logoResult,
    );
    view.protectedCandidates = candidates;

    const registry = new CheckRegistry();
    registerClaimCheck(registry);
    const { items, outcomes } = await runChecksWithOutcomes(view, registry);
    expect(items).toHaveLength(2);
    expect(items[0]?.detail.orgId).toBe(fynbosOrgId);
    expect(items[0]?.detail.routes).toEqual(["display-name", "from-lookalike"]);
    expect(items[1]?.detail.checked).toBe(false);
    expect(items[1]?.detail.unavailable).toContain("a logo comparison could not be completed");
    expect(outcomes[0]?.outcome).toBe("partial");
    expect(outcomes[0]?.reason).toBe("a logo comparison could not be completed");

    // Also verify that an unreadable newer manifest generation refuses to fall back to the stale generation.
    await putArtefact(
      store,
      caseId,
      "crop",
      "desktop-manifest-2.json",
      new TextEncoder().encode("{not-valid-json"),
      "application/json",
    );
    const corruptManifestResult = await compareClaimLogos(
      {
        store,
        meta: {
          env: META,
          budget: d1Budget(db, { caller: "vision", caseId }),
          owner: { kind: "case", caseId, step: "trust-claim" },
          fetch: failingFetch,
        },
        kv,
      },
      caseId,
      candidates.candidates,
    );
    expect(corruptManifestResult.unavailable).toContain("the case's logo crop manifest could not be read");
    expect(corruptManifestResult.unavailableCodes).toContain("manifest-unreadable");
  });

  it("distinguishes missing crop production from a completed zero-logo manifest, preserves SVG aspect ratio, and handles missing, oversized, corrupt, refused, budget, timeout, cap and low-confidence logo paths", async () => {
    // 1. SVG aspect-ratio preservation (G2): landscape (1024x256 -> 512x128) and portrait (256x1024 -> 128x512).
    expect(fitSvgDimensions(1024, 256)).toEqual({ width: 512, height: 128 });
    expect(fitSvgDimensions(256, 1024)).toEqual({ width: 128, height: 512 });
    expect(fitSvgDimensions(200, 100)).toEqual({ width: 200, height: 100 });

    const fynbosOrgId = await protectableOrg("fynbosfreight.co.za", "finance@fynbosfreight.co.za", "Fynbos Freight");
    await setIdentity(
      db,
      fynbosOrgId,
      "u-fynbos",
      {
        displayNames: ["Fynbos Freight"],
        financeContact: "finance@fynbosfreight.co.za",
        protected: true,
      },
      new Date("2026-11-01T11:10:00Z"),
    );
    const svgBytes = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 256"><rect width="1024" height="256" fill="#1a4d2e"/></svg>',
    );
    await storeLogo(bucket, db, fynbosOrgId, "u-fynbos", svgBytes, "image/svg+xml", new Date("2026-11-01T11:11:00Z"));
    const candidates = boundProtectedCandidates(await protectedIdentities(db));

    // 2. Missing crop manifest (unrun SAM) -> partial coverage ("logo crops were not produced for this case").
    const unrunCaseId = ulid();
    await createCase(db, {
      id: unrunCaseId,
      orgId: fynbosOrgId,
      channel: "email",
      headersAvailable: true,
      forwardedBy: "staff@fynbosfreight.co.za",
    });
    const unrunRes = await compareClaimLogos(
      {
        store,
        meta: {
          env: META,
          budget: d1Budget(db, { caller: "vision", caseId: unrunCaseId }),
          owner: { kind: "case", caseId: unrunCaseId, step: "trust-claim" },
        },
        kv,
      },
      unrunCaseId,
      candidates.candidates,
    );
    expect(unrunRes.unavailable).toEqual(["logo crops were not produced for this case"]);
    expect(unrunRes.unavailableCodes).toEqual(["no-crop-manifest"]);

    // 3. Completed zero-logo manifest (SAM ran and found 0 crops) -> clean `unavailable: []`.
    await storeCrops(
      store,
      unrunCaseId,
      { name: "desktop.png", key: `art/${unrunCaseId}/render/desktop.png`, sha256: "c".repeat(64) },
      [],
    );
    const zeroLogoRes = await compareClaimLogos(
      {
        store,
        meta: {
          env: META,
          budget: d1Budget(db, { caller: "vision", caseId: unrunCaseId }),
          owner: { kind: "case", caseId: unrunCaseId, step: "trust-claim" },
        },
        kv,
      },
      unrunCaseId,
      candidates.candidates,
    );
    expect(zeroLogoRes.unavailable).toEqual([]);
    expect(zeroLogoRes.logoJudgements).toEqual([]);

    // 4. SVG without rasteriser (`!rasteriseSvg && !launch`) -> "the registered SVG logo could not be rasterised for comparison".
    const cropPng = await validPng(16, 16, 0x33);
    await storeCrops(
      store,
      unrunCaseId,
      { name: "desktop.png", key: `art/${unrunCaseId}/render/desktop.png`, sha256: "c".repeat(64) },
      [
        {
          box: { concept: "logo", left: 4, top: 4, right: 36, bottom: 36, confidence: 0.92 },
          bytes: cropPng,
          width: 32,
          height: 32,
        },
      ],
    );
    const noRasteriserRes = await compareClaimLogos(
      {
        store,
        meta: {
          env: META,
          budget: d1Budget(db, { caller: "vision", caseId: unrunCaseId }),
          owner: { kind: "case", caseId: unrunCaseId, step: "trust-claim" },
        },
        kv,
      },
      unrunCaseId,
      candidates.candidates,
    );
    expect(noRasteriserRes.unavailable).toEqual(["the registered SVG logo could not be rasterised for comparison"]);
    expect(noRasteriserRes.unavailableCodes).toEqual(["registered-logo-svg-unrasterised"]);

    // 5. Default browser SVG rasteriser (`launch`) loads via HTMLImageElement (`img.src = data:image/svg+xml;base64,...`, never `createImageBitmap` on SVG) and preserves aspect ratio for landscape (1024x256 -> 512x128) and portrait (256x1024 -> 128x512).
    const observedCanvasSizes: { width: number; height: number }[] = [];
    const observedImageSources: string[] = [];
    for (const [srcW, srcH] of [
      [1024, 256],
      [256, 1024],
    ] as const) {
      const renderedPng = await validPng(
        Math.round((srcW * 512) / Math.max(srcW, srcH)),
        Math.round((srcH * 512) / Math.max(srcW, srcH)),
        0x44,
      );
      const res = await compareClaimLogos(
        {
          store,
          meta: {
            env: META,
            budget: d1Budget(db, { caller: "vision", caseId: unrunCaseId }),
            owner: { kind: "case", caseId: unrunCaseId, step: "trust-claim" },
            fetch: (async () =>
              metaReply({
                same_brand: false,
                brand_seen: null,
                differences: ["different shape"],
                confidence: 0.9,
              })) as typeof fetch,
          },
          kv,
          launch: async () =>
            ({
              newPage: async () => ({
                evaluate: async (fn: (b64: string, side: number) => Promise<string>, b64: string, side: number) => {
                  const g = globalThis as Record<string, unknown>;
                  const prevCreateImageBitmap = g.createImageBitmap;
                  const prevDocument = g.document;
                  g.createImageBitmap = async () => {
                    throw new Error("createImageBitmap does not support image/svg+xml in Chromium");
                  };
                  g.document = {
                    createElement: (tag: string) => {
                      if (tag === "img") {
                        let currentSrc = "";
                        const img = {
                          naturalWidth: srcW,
                          naturalHeight: srcH,
                          width: srcW,
                          height: srcH,
                          onload: null as (() => void) | null,
                          onerror: null as ((err: unknown) => void) | null,
                          decode: async () => undefined,
                          get src() {
                            return currentSrc;
                          },
                          set src(val: string) {
                            currentSrc = val;
                            observedImageSources.push(val);
                            queueMicrotask(() => img.onload?.());
                          },
                        };
                        return img;
                      }
                      const canvas = {
                        width: 0,
                        height: 0,
                        getContext: () => ({
                          drawImage: (_img: unknown, _x: number, _y: number, w: number, h: number) => {
                            observedCanvasSizes.push({ width: w, height: h });
                          },
                        }),
                        toBlob: (cb: (b: Blob | null) => void) =>
                          cb(new Blob([renderedPng.buffer as ArrayBuffer], { type: "image/png" })),
                      };
                      return canvas;
                    },
                  };
                  try {
                    return await fn(b64, side);
                  } finally {
                    g.createImageBitmap = prevCreateImageBitmap;
                    g.document = prevDocument;
                  }
                },
                close: async () => undefined,
              }),
              close: async () => undefined,
            }) as never,
        },
        unrunCaseId,
        candidates.candidates,
      );
      expect(res.unavailable).toEqual([]);
    }
    expect(observedImageSources).toHaveLength(2);
    expect(observedImageSources[0]).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(observedCanvasSizes).toEqual([
      { width: 512, height: 128 },
      { width: 128, height: 512 },
    ]);

    // 5b. A Browser Run launch that resolves after the phase deadline still has its `close()` called and never starts rasterisation.
    let lateBrowserClosed = false;
    let lateNewPageCalled = false;
    let resolveLateLaunch: ((b: unknown) => void) | undefined;
    let lateClock = 5_000;
    const lateLaunchRes = await compareClaimLogos(
      {
        store,
        meta: {
          env: META,
          budget: d1Budget(db, { caller: "vision", caseId: unrunCaseId }),
          owner: { kind: "case", caseId: unrunCaseId, step: "trust-claim" },
        },
        kv,
        deadlineMs: 25,
        now: () => lateClock,
        launch: () => {
          lateClock += 100;
          return new Promise((resolve) => {
            resolveLateLaunch = resolve;
          }) as never;
        },
      },
      unrunCaseId,
      candidates.candidates,
    );
    expect(lateLaunchRes.unavailable).toContain("logo comparison did not finish in time");
    expect(resolveLateLaunch).toBeTypeOf("function");
    resolveLateLaunch?.({
      newPage: async () => {
        lateNewPageCalled = true;
        throw new Error("should not open page after deadline");
      },
      close: async () => {
        lateBrowserClosed = true;
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(lateBrowserClosed).toBe(true);
    expect(lateNewPageCalled).toBe(false);

    // 6. Low-confidence positive (0.3) and low-confidence negative (0.1) logo answers both report inconclusive coverage (G4).
    const lowPosRes = await compareClaimLogos(
      {
        store,
        meta: {
          env: META,
          budget: d1Budget(db, { caller: "vision", caseId: unrunCaseId }),
          owner: { kind: "case", caseId: unrunCaseId, step: "trust-claim" },
          fetch: (async () =>
            metaReply({
              same_brand: true,
              brand_seen: "Fynbos Freight",
              differences: [],
              confidence: 0.3,
            })) as typeof fetch,
        },
        kv,
        rasteriseSvg: async () => validPng(32, 32, 0xaa),
      },
      unrunCaseId,
      candidates.candidates,
    );
    expect(lowPosRes.unavailable).toContain("a logo comparison had low confidence");
    expect(lowPosRes.logoJudgements[0]?.same).toBe(false);

    const lowNegRes = await compareClaimLogos(
      {
        store,
        meta: {
          env: META,
          budget: d1Budget(db, { caller: "vision", caseId: unrunCaseId }),
          owner: { kind: "case", caseId: unrunCaseId, step: "trust-claim" },
          fetch: (async () =>
            metaReply({
              same_brand: false,
              brand_seen: null,
              differences: ["blurry"],
              confidence: 0.1,
            })) as typeof fetch,
        },
        kv,
        rasteriseSvg: async () => validPng(32, 32, 0xbb),
      },
      unrunCaseId,
      candidates.candidates,
    );
    expect(lowNegRes.unavailable).toContain("a logo comparison had low confidence");
    expect(lowNegRes.logoJudgements[0]?.same).toBe(false);

    // 7. Model refusal, budget exhaustion, and phase deadline timeout across stalled KV/browser cleanup (G3).
    const refusalRes = await compareClaimLogos(
      {
        store,
        meta: {
          env: META,
          budget: d1Budget(db, { caller: "vision", caseId: unrunCaseId }),
          owner: { kind: "case", caseId: unrunCaseId, step: "trust-claim" },
          fetch: (async () =>
            new Response(
              JSON.stringify({
                id: "resp-refused",
                object: "response",
                status: "completed",
                output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "refused" }] }],
                usage: { input_tokens: 50, output_tokens: 5 },
              }),
              {
                status: 200,
                headers: { "content-type": "application/json", "cf-aig-log-id": "l", "x-request-id": "r" },
              },
            )) as typeof fetch,
        },
        kv,
        rasteriseSvg: async () => validPng(32, 32, 0xcc),
      },
      unrunCaseId,
      candidates.candidates,
    );
    expect(refusalRes.unavailable).toEqual(["the logo comparison service refused the image"]);

    const budgetRes = await compareClaimLogos(
      {
        store,
        meta: {
          env: META,
          budget: {
            reserve: async () => {
              throw new BudgetExceeded("day", "Muse-Spark");
            },
            settle: async () => undefined,
            refused: async () => undefined,
            cached: async () => undefined,
            outputFailed: async () => undefined,
            uncertain: async () => undefined,
          },
          owner: { kind: "case", caseId: unrunCaseId, step: "trust-claim" },
        },
        kv,
        rasteriseSvg: async () => validPng(32, 32, 0xdd),
      },
      unrunCaseId,
      candidates.candidates,
    );
    expect(budgetRes.unavailable).toEqual(["the allowance for logo comparison is used up"]);

    let clock = 1_000;
    const stalledKv = {
      get: () =>
        new Promise<string | null>((resolve) => {
          clock += 200;
          setTimeout(() => resolve(null), 50);
        }),
      put: async () => undefined,
    } as unknown as KVNamespace;
    const timeoutRes = await compareClaimLogos(
      {
        store,
        meta: {
          env: META,
          budget: d1Budget(db, { caller: "vision", caseId: unrunCaseId }),
          owner: { kind: "case", caseId: unrunCaseId, step: "trust-claim" },
        },
        kv: stalledKv,
        deadlineMs: 20,
        now: () => clock,
        launch: async () =>
          ({
            newPage: async () => ({
              evaluate: async () => btoa(String.fromCharCode(...(await validPng(16, 16, 0xee)))),
              close: () => new Promise(() => {}),
            }),
            close: () => new Promise(() => {}),
          }) as never,
      },
      unrunCaseId,
      candidates.candidates,
    );
    expect(timeoutRes.unavailable).toContain("logo comparison did not finish in time");

    // 8. Missing, oversized and corrupt crop and registered-logo inputs, plus 4-crop and 8-comparison caps.
    const capCaseId = ulid();
    await createCase(db, {
      id: capCaseId,
      orgId: fynbosOrgId,
      channel: "email",
      headersAvailable: true,
      forwardedBy: "staff@fynbosfreight.co.za",
    });
    // Store 5 logo crops -> triggers 4-crop cap; corrupt crop 1, delete crop 2 from R2, make crop 3 oversized, keep crop 4 valid.
    const fiveCrops = await storeCrops(
      store,
      capCaseId,
      { name: "desktop.png", key: `art/${capCaseId}/render/desktop.png`, sha256: "d".repeat(64) },
      Array.from({ length: 5 }, (_, i) => ({
        box: { concept: "logo" as const, left: i * 10, top: 0, right: i * 10 + 20, bottom: 20, confidence: 0.9 },
        bytes: cropPng,
        width: 20,
        height: 20,
      })),
    );
    await bucket.put(fiveCrops[0]?.key ?? "", new Uint8Array([1, 2, 3, 4]));
    await bucket.delete(fiveCrops[1]?.key ?? "");
    await bucket.put(fiveCrops[2]?.key ?? "", new Uint8Array(5 * 1024 * 1024 + 1));

    // Also test registered-logo failures: missing R2 object, oversized R2 object, and corrupt PNG pixels.
    const missingLogoCandidates = [
      {
        orgId: "org-missing-logo",
        names: ["Missing Logo Co"],
        domains: ["missinglogo.co.za"],
        namesOmitted: 0,
        domainsOmitted: 0,
        logo: { key: "ident/org-missing-logo/logo.png", mediaType: "image/png", sha256: "0".repeat(64) },
      },
      {
        orgId: "org-oversized-logo",
        names: ["Oversized Logo Co"],
        domains: ["oversizedlogo.co.za"],
        namesOmitted: 0,
        domainsOmitted: 0,
        logo: { key: "ident/org-oversized-logo/logo.png", mediaType: "image/png", sha256: "1".repeat(64) },
      },
      {
        orgId: "org-corrupt-logo",
        names: ["Corrupt Logo Co"],
        domains: ["corruptlogo.co.za"],
        namesOmitted: 0,
        domainsOmitted: 0,
        logo: { key: "ident/org-corrupt-logo/logo.png", mediaType: "image/png", sha256: "2".repeat(64) },
      },
    ];
    await bucket.put("ident/org-oversized-logo/logo.png", new Uint8Array(600 * 1024));
    const badPng = await validPng(16, 16, 0x11);
    badPng.set([0xff], badPng.length - 15); // Corrupt IDAT CRC/deflate stream
    await bucket.put("ident/org-corrupt-logo/logo.png", badPng);

    const mixedFailuresRes = await compareClaimLogos(
      {
        store,
        meta: {
          env: META,
          budget: d1Budget(db, { caller: "vision", caseId: capCaseId }),
          owner: { kind: "case", caseId: capCaseId, step: "trust-claim" },
        },
        kv,
      },
      capCaseId,
      missingLogoCandidates,
    );
    expect(mixedFailuresRes.unavailable).toEqual(
      expect.arrayContaining([
        "only the first 4 logo crops were compared",
        "a logo image is not in a supported raster format",
        "a logo crop could not be read",
        "a logo image is larger than the size limit",
        "the registered logo could not be read",
        "the registered logo image is damaged",
      ]),
    );

    // 8-comparison cap: 3 valid logo crops x 3 valid registered-logo candidates = 9 > MAX_CLAIM_LOGO_COMPARISONS (8).
    const eightCapCaseId = ulid();
    await createCase(db, {
      id: eightCapCaseId,
      orgId: fynbosOrgId,
      channel: "email",
      headersAvailable: true,
      forwardedBy: "staff@fynbosfreight.co.za",
    });
    const cropA = await validPng(16, 16, 0x21);
    const cropB = await validPng(16, 16, 0x22);
    const cropC = await validPng(16, 16, 0x23);
    await storeCrops(
      store,
      eightCapCaseId,
      { name: "desktop.png", key: `art/${eightCapCaseId}/render/desktop.png`, sha256: "e".repeat(64) },
      [cropA, cropB, cropC].map((bytes, i) => ({
        box: { concept: "logo" as const, left: i * 10, top: 0, right: i * 10 + 20, bottom: 20, confidence: 0.9 },
        bytes,
        width: 20,
        height: 20,
      })),
    );
    const threeValidLogoCandidates = await Promise.all(
      [1, 2, 3].map(async (n) => {
        const key = `ident/org-cap-${n}/logo.png`;
        await bucket.put(key, await validPng(20, 20, 0x40 + n));
        return {
          orgId: `org-cap-${n}`,
          names: [`Cap Org ${n}`],
          domains: [`cap-${n}.co.za`],
          namesOmitted: 0,
          domainsOmitted: 0,
          logo: { key, mediaType: "image/png", sha256: String(n).repeat(64) },
        };
      }),
    );
    let eightCapCalls = 0;
    const eightCapRes = await compareClaimLogos(
      {
        store,
        meta: {
          env: META,
          budget: d1Budget(db, { caller: "vision", caseId: eightCapCaseId }),
          owner: { kind: "case", caseId: eightCapCaseId, step: "trust-claim" },
          fetch: (async () => {
            eightCapCalls += 1;
            return metaReply({
              same_brand: false,
              brand_seen: null,
              differences: ["different"],
              confidence: 0.91,
            });
          }) as typeof fetch,
        },
        kv,
      },
      eightCapCaseId,
      threeValidLogoCandidates,
    );
    expect(eightCapCalls).toBe(8);
    expect(eightCapRes.unavailable).toContain("only the first 8 logo comparisons were run");
  });
});

describe("effective protection, bounds, and clean outcomes", () => {
  it("excludes identities whose protection is switched off, whose domain is unverified, or whose finance contact is unverified", async () => {
    const fynbosOrgId = await protectableOrg("fynbosfreight.co.za", "finance@fynbosfreight.co.za", "Fynbos Freight");
    await setIdentity(
      db,
      fynbosOrgId,
      "u-fynbos",
      {
        displayNames: ["Fynbos Freight"],
        financeContact: "finance@fynbosfreight.co.za",
        protected: true,
      },
      new Date("2026-11-01T12:00:00Z"),
    );

    const view = buildMessageView({
      headers: [{ name: "From", value: '"Fynbos Freight" <billing@fynbosfreight.co.za>' }],
      text: "Hello from Fynbos Freight.",
    });

    // 1. Active protection -> matches.
    view.protectedCandidates = boundProtectedCandidates(await protectedIdentities(db));
    expect(detectClaims(claimInputFromView(view)).map((h) => h.orgId)).toEqual([fynbosOrgId]);

    // 2. Unverify the finance contact -> excluded at read time by protectedIdentities(db).
    await db.prepare("UPDATE org_addresses SET state = 'pending' WHERE org_id = ?").bind(fynbosOrgId).run();
    view.protectedCandidates = boundProtectedCandidates(await protectedIdentities(db));
    expect(view.protectedCandidates.candidates).toEqual([]);
    expect(detectClaims(claimInputFromView(view))).toEqual([]);

    // Restore finance contact, unverify the domain -> excluded.
    await db.prepare("UPDATE org_addresses SET state = 'verified' WHERE org_id = ?").bind(fynbosOrgId).run();
    await db.prepare("UPDATE org_domains SET state = 'pending' WHERE org_id = ?").bind(fynbosOrgId).run();
    view.protectedCandidates = boundProtectedCandidates(await protectedIdentities(db));
    expect(view.protectedCandidates.candidates).toEqual([]);

    // Restore domain, switch protection off -> excluded.
    await db.prepare("UPDATE org_domains SET state = 'verified' WHERE org_id = ?").bind(fynbosOrgId).run();
    await setIdentity(
      db,
      fynbosOrgId,
      "u-fynbos",
      {
        displayNames: ["Fynbos Freight"],
        financeContact: "finance@fynbosfreight.co.za",
        protected: false,
      },
      new Date("2026-11-01T12:05:00Z"),
    );
    view.protectedCandidates = boundProtectedCandidates(await protectedIdentities(db));
    expect(view.protectedCandidates.candidates).toEqual([]);
  });

  it("records candidate, name and domain bound overflow as partial coverage and persists ran, partial and skipped outcomes with consumer read-back", async () => {
    const registry = new CheckRegistry();
    registerClaimCheck(registry);
    const memberOrgId = await makeOrg("Persistence Check Org");

    // 1. Without protectedCandidates on the view, the check skips with a clear reason, persisted and read back from D1.
    const skipCaseId = ulid();
    await createCase(db, {
      id: skipCaseId,
      orgId: memberOrgId,
      channel: "email",
      headersAvailable: true,
      forwardedBy: "staff@persistence.co.za",
    });
    const unpopulatedView = buildMessageView({
      orgId: memberOrgId,
      headers: [{ name: "From", value: "sender@unrelated.example" }],
    });
    const skippedRun = await runChecksWithOutcomes(unpopulatedView, registry);
    await saveEvidence(db, skipCaseId, skippedRun.items, registry, undefined, skippedRun.outcomes);
    const storedSkippedOutcomes = await readCheckOutcomes(db, skipCaseId);
    expect(storedSkippedOutcomes).toEqual([
      expect.objectContaining({
        check: "trust.claim",
        outcome: "skipped",
        findings: 0,
        reason: "the protected-identity candidates were not read for this case",
      }),
    ]);

    // 2. Clean no-match with an active candidate records outcome "ran", summary, and examined targets, persisted and read back from D1.
    const cleanCaseId = ulid();
    await createCase(db, {
      id: cleanCaseId,
      orgId: memberOrgId,
      channel: "email",
      headersAvailable: true,
      forwardedBy: "staff@persistence.co.za",
    });
    const cleanView = buildMessageView({
      orgId: memberOrgId,
      headers: [
        { name: "From", value: '"Plain Sender" <hello@unrelated.example>' },
        { name: "Reply-To", value: "replies@unrelated.example" },
      ],
      text: "Just a normal message.",
    });
    cleanView.protectedCandidates = boundProtectedCandidates([{ ...FYNBOS, logo: null }]);
    const cleanRun = await runChecksWithOutcomes(cleanView, registry);
    expect(cleanRun.items).toEqual([]);
    await saveEvidence(db, cleanCaseId, cleanRun.items, registry, undefined, cleanRun.outcomes);
    const storedCleanOutcomes = await readCheckOutcomes(db, cleanCaseId);
    expect(storedCleanOutcomes).toEqual([
      expect.objectContaining({
        check: "trust.claim",
        outcome: "ran",
        findings: 0,
        summary: "no protected business claimed",
      }),
    ]);
    expect(storedCleanOutcomes?.[0]?.examined?.targets).toEqual(
      expect.arrayContaining(["Plain Sender", "unrelated.example", "signature block (last 15 lines)"]),
    );

    // 3. Candidate bound overflow (> MAX_PROTECTED_CANDIDATES), name bound overflow (> MAX_CANDIDATE_NAMES) and domain bound overflow (> MAX_CANDIDATE_DOMAINS) report partial, persisted and read back via readTrustClaimDetail.
    const partialCaseId = ulid();
    await createCase(db, {
      id: partialCaseId,
      orgId: memberOrgId,
      channel: "email",
      headersAvailable: true,
      forwardedBy: "staff@persistence.co.za",
    });
    const manyCandidates = Array.from({ length: MAX_PROTECTED_CANDIDATES + 2 }, (_, i) => ({
      orgId: `org-${i}`,
      names:
        i === 0
          ? ["Fynbos Freight", ...Array.from({ length: MAX_CANDIDATE_NAMES + 1 }, (__, n) => `Alias ${n}`)]
          : [`Business ${i}`],
      domains: Array.from({ length: MAX_CANDIDATE_DOMAINS + 1 }, (__, d) => `biz-${i}-${d}.co.za`),
      logo: null,
    }));
    const overflowView = buildMessageView({
      orgId: memberOrgId,
      headers: [{ name: "From", value: '"Fynbos Freight" <hello@unrelated.example>' }],
    });
    overflowView.protectedCandidates = boundProtectedCandidates(manyCandidates);
    expect(overflowView.protectedCandidates.candidates[0]?.namesOmitted).toBe(2);
    expect(overflowView.protectedCandidates.candidates[0]?.domainsOmitted).toBe(1);
    const overflowRun = await runChecksWithOutcomes(overflowView, registry);
    expect(overflowRun.items).toHaveLength(2);
    await saveEvidence(db, partialCaseId, overflowRun.items, registry, undefined, overflowRun.outcomes);

    const storedPartialEvidence = await readEvidence(db, partialCaseId);
    expect(storedPartialEvidence).toHaveLength(2);
    const parsedClaim = readTrustClaimDetail(storedPartialEvidence[0]?.detail);
    expect(parsedClaim).toEqual({
      kind: "claim",
      detail: expect.objectContaining({
        orgId: "org-0",
        name: "Fynbos Freight",
        routes: ["display-name"],
      }),
    });
    const parsedUnavailable = readTrustClaimDetail(storedPartialEvidence[1]?.detail);
    expect(parsedUnavailable).toEqual({
      kind: "unavailable",
      detail: expect.objectContaining({
        checked: false,
        unavailable: expect.arrayContaining([
          `2 protected identities past the candidate bound (${MAX_PROTECTED_CANDIDATES}) could not be compared`,
          "some registered names or domains past the candidate bound could not be compared",
        ]),
      }),
    });
    const storedPartialOutcomes = await readCheckOutcomes(db, partialCaseId);
    expect(storedPartialOutcomes).toEqual([
      expect.objectContaining({
        check: "trust.claim",
        outcome: "partial",
        findings: 2,
        reason: `2 protected identities past the candidate bound (${MAX_PROTECTED_CANDIDATES}) could not be compared`,
      }),
    ]);
  });
});
