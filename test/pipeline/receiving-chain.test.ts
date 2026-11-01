import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { learnReceivers } from "../../src/auth/receivers";
import type { Resolve } from "../../src/auth/receiving-chains";
import { NO_TRUSTED_RESULTS } from "../../src/checks/auth";
import { bundled } from "../../src/checks/brands";
import { readCheckOutcomes, readEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { parsedKey, putParsed, putRaw, type Store } from "../../src/intake/store";
import { checks } from "../../src/pipeline/analysis-workflow";

// D02 T02 §6, end to end in the checks step: the organisation's receiving chain is read from its own DNS (its MX the
// gateway's, its records naming the provider), stored, and the case's stored `auth.results` evidence trusts the
// provider's stamp from the first message, the alignment check reading those results. Hosts and addresses are fictional.
const db = env.DB;
const store: Store = { bucket: env.ARTEFACTS, db };
const DNS: Record<string, string[] | null> = {
  "mx1.gw.filter.example A": ["192.0.2.10"],
  "filter.example TXT": ["v=spf1 ip4:198.51.100.0/24 -all"],
};
// The claimed domain's own records (its label is random): Microsoft 365's, unless a test names Google's or none.
let claimRecords: string[] | null = ["MS=ms12345678", "v=spf1 include:spf.protection.outlook.com -all"];
const resolving =
  (answers: Record<string, string[] | null> = DNS): Resolve =>
  async (name, type) => {
    if (name.endsWith("-fynbos.example") && type === "TXT") return claimRecords;
    const key = `${name} ${type}`;
    return key in answers ? (answers[key] ?? null) : [];
  };
const gatewayMx = async () => ["mx1.gw.filter.example"];
const date = () => new Date(Date.now() - 60_000).toUTCString();
const microsoft = (from: string) => [
  {
    name: "Received",
    value: `from AM6PR02.eurprd02.prod.outlook.com (2603:10a6:20b:1::12) by DB9PR02.eurprd02.prod.outlook.com with HTTPS; ${date()}`,
  },
  {
    name: "Authentication-Results",
    value:
      "spf=fail smtp.mailfrom=sender.example; dkim=none; dmarc=fail action=none header.from=sender.example; compauth=fail reason=000",
  },
  {
    name: "Received",
    value: `${from} by AM5EUR01FT001.mail.protection.outlook.com with Microsoft SMTP Server; ${date()}`,
  },
  { name: "Received", value: `from mail.sender.example (203.0.113.5) by mx1.gw.filter.example with ESMTPS; ${date()}` },
  { name: "From", value: "Accounts <accounts@sender.example>" },
];
const google = (from: string) => [
  { name: "Received", value: `by 2002:a05:6a10:1234::5 with SMTP id y; ${date()}` },
  { name: "Received", value: `${from} by mx.google.com with ESMTPS id z; ${date()}` },
  {
    name: "Authentication-Results",
    value: "mx.google.com; spf=fail smtp.mailfrom=sender.example; dkim=none; dmarc=fail header.from=sender.example",
  },
  { name: "Received", value: `from mail.sender.example (203.0.113.5) by mx1.gw.filter.example with ESMTPS; ${date()}` },
  { name: "From", value: "Accounts <accounts@sender.example>" },
];

async function organisation() {
  const orgId = `org-${crypto.randomUUID()}`;
  const claimId = `claim-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, ?, ?, ?, 'verified', 'dns', ?, ?)",
    )
    .bind(claimId, orgId, `${crypto.randomUUID().slice(0, 8)}-fynbos.example`, "t".repeat(16), now, now)
    .run();
  await learnReceivers(db, claimId, gatewayMx);
  return orgId;
}

// Runs the checks step for a case (a new one, or `caseId` again, as a retry would), and reads its stored evidence.
async function run(orgId: string, headers: { name: string; value: string }[], resolve = resolving(), caseId?: string) {
  let id = caseId;
  if (!id) {
    const made = await createCase(db, { orgId, channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    id = made.value.id;
    await putRaw(store, id, new TextEncoder().encode("From: x@y.example\r\n\r\nSee below.\r\n"));
    await putParsed(store, id, {
      headers,
      text: "Please pay the attached invoice.",
      html: null,
      attachments: [],
      truncated: [],
      omitted: 0,
      forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
    });
  }
  await checks(store, id, parsedKey(id), { orgId, channel: "email" }, gatewayMx, bundled, null, null, null, resolve);
  const item = (await readEvidence(db, id)).find((e) => e.check === "auth.results");
  const results = item?.detail;
  const words = item?.summary;
  const alignment = ((await readCheckOutcomes(db, id)) ?? []).find((o) => o.check === "auth.alignment");
  return { id, results, words, alignment };
}
const VIA = "from relay-out.gw.filter.example (198.51.100.20)";

describe("a receiving chain in the checks step", () => {
  it("is read from the organisation's DNS, stored, and trusted on the first case's stored evidence and alignment", async () => {
    claimRecords = ["MS=ms12345678", "v=spf1 include:spf.protection.outlook.com -all"];
    const orgId = await organisation();
    const first = await run(orgId, microsoft(VIA));
    expect(first.results).toMatchObject({ trusted: true, receiver: "microsoft" });
    // Alignment read Microsoft 365's results (DMARC failed): it ran, with its finding, not skipped for want of results.
    // Its summary (D02 T01 §7) says what it read: Microsoft 365's failing results, nothing aligned.
    expect(first.alignment).toEqual({
      check: "auth.alignment",
      outcome: "ran",
      reason: null,
      findings: 1,
      summary: "not aligned by a passing result",
    });
    const rows = await db
      .prepare("SELECT gateway, provider, status FROM org_receiving_chains WHERE org_id = ?")
      .bind(orgId)
      .all<{ gateway: string; provider: string; status: string }>();
    expect(rows.results).toEqual([{ gateway: "*.filter.example", provider: "microsoft", status: "proven" }]);
    // The same case run again, as a retry: the same reading.
    expect((await run(orgId, [], resolving(), first.id)).results).toMatchObject({
      trusted: true,
      receiver: "microsoft",
    });
    // Handed to Microsoft 365 directly: no boundary, and alignment has nothing trusted to read.
    const direct = await run(orgId, microsoft("from attacker.example (203.0.113.9)"));
    expect(direct.results).toMatchObject({ trusted: false, reason: "no-boundary" });
    expect(direct.alignment?.reason).toBe(NO_TRUSTED_RESULTS);
  });

  it("reads a Google chain the same way", async () => {
    claimRecords = ["v=spf1 include:_spf.google.com ~all"];
    const orgId = await organisation();
    const via = "from relay-out.gw.filter.example (relay-out.gw.filter.example. [198.51.100.20])";
    expect((await run(orgId, google(via))).results).toMatchObject({ trusted: true, receiver: "google" });
  });

  it("stores chain-unverified when the gateway's addresses could not be read, then recovers", async () => {
    claimRecords = ["MS=ms12345678"];
    const orgId = await organisation();
    expect((await run(orgId, microsoft(VIA), resolving({ ...DNS, "filter.example TXT": null }))).results).toMatchObject(
      {
        trusted: false,
        reason: "chain-unverified",
      },
    );
    expect((await run(orgId, microsoft(VIA))).results).toMatchObject({ trusted: true, receiver: "microsoft" });
  });

  it("tells a gateway record it can never read from a lookup that failed, in the stored chain and the evidence (D02 T02 §6, correction 18)", async () => {
    claimRecords = ["MS=ms12345678"];
    const reasons = async (orgId: string) =>
      (
        await db
          .prepare("SELECT status, reason FROM org_receiving_chains WHERE org_id = ? ORDER BY provider")
          .bind(orgId)
          .all<{ status: string; reason: string | null }>()
      ).results.map((r) => [r.status, r.reason]);
    // A lookup that failed: tried again on the next case, and the words say "this time".
    const failed = await organisation();
    const lookup = await run(failed, microsoft(VIA), resolving({ ...DNS, "filter.example TXT": null }));
    expect(lookup.results).toMatchObject({ trusted: false, reason: "chain-unverified" });
    expect(lookup.words).toContain("could not be looked up");
    expect(await reasons(failed)).toEqual([["unverified", "unavailable"]]);
    // A record it does not read (`exists`), the same on every try: its own state and words.
    const unsupported = await organisation();
    const odd = resolving({ ...DNS, "filter.example TXT": ["v=spf1 exists:%{i}.probe.example -all"] });
    const record = await run(unsupported, microsoft(VIA), odd);
    expect(record.results).toMatchObject({ trusted: false, reason: "chain-unsupported" });
    expect(record.words).toContain("does not read");
    expect(record.words).not.toContain("could not be looked up");
    expect(await reasons(unsupported)).toEqual([["unverified", "unsupported"]]);
    expect((await run(unsupported, microsoft(VIA), odd)).results).toMatchObject({ reason: "chain-unsupported" });
    // Both at once: the record it can never read wins, since asking again cannot cure it.
    const both = await organisation();
    const bothDns = resolving({
      ...DNS,
      "filter.example TXT": ["v=spf1 include:failed.filter.example exists:%{i}.probe.example -all"],
      "failed.filter.example TXT": null,
    });
    expect((await run(both, microsoft(VIA), bothDns)).results).toMatchObject({ reason: "chain-unsupported" });
    // Proven again once the record reads: no reason kept.
    expect((await run(unsupported, microsoft(VIA))).results).toMatchObject({ trusted: true });
    expect(await reasons(unsupported)).toEqual([["proven", null]]);
  });
});
