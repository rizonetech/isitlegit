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

// D02 T02 §6, end to end in the checks step: one case proves the organisation's receiving chain, the chain is stored,
// and the next case is read with it, its stored `auth.results` evidence trusting the provider's stamp and the alignment
// check reading those results. A retried case reads what its first run read. Hosts and addresses are fictional.
const db = env.DB;
const store: Store = { bucket: env.ARTEFACTS, db };
const DNS: Record<string, string[] | null> = {
  "mx1.gw.filter.example A": ["192.0.2.10"],
  "filter.example TXT": ["v=spf1 ip4:198.51.100.0/24 -all"],
};
const resolving =
  (answers: Record<string, string[] | null> = DNS): Resolve =>
  async (name, type) => {
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
  await checks(store, id, parsedKey(id), { orgId, channel: "email" }, gatewayMx, bundled, null, null, resolve);
  const results = (await readEvidence(db, id)).find((e) => e.check === "auth.results")?.detail;
  const alignment = ((await readCheckOutcomes(db, id)) ?? []).find((o) => o.check === "auth.alignment");
  return { id, results, alignment };
}
const VIA = "from relay-out.gw.filter.example (198.51.100.20)";

describe("a receiving chain in the checks step", () => {
  it("is learned from one case, read back, and trusted on the next case's stored evidence and alignment", async () => {
    const orgId = await organisation();
    const first = await run(orgId, microsoft(VIA));
    expect(first.results).toMatchObject({ trusted: false, reason: "no-boundary" });
    expect(first.alignment?.reason).toBe(NO_TRUSTED_RESULTS);
    const rows = await db
      .prepare("SELECT gateway, provider, status FROM org_receiving_chains WHERE org_id = ?")
      .bind(orgId)
      .all<{ gateway: string; provider: string; status: string }>();
    expect(rows.results).toEqual([{ gateway: "*.filter.example", provider: "microsoft", status: "proven" }]);
    // The first case run again, as a retry: what it read the first time, not the chain it proved.
    expect((await run(orgId, [], resolving(), first.id)).results).toMatchObject({
      trusted: false,
      reason: "no-boundary",
    });
    const next = await run(orgId, microsoft(VIA));
    expect(next.results).toMatchObject({ trusted: true, receiver: "microsoft" });
    expect(next.alignment?.reason).not.toBe(NO_TRUSTED_RESULTS);
    // Handed to Microsoft 365 directly: no boundary.
    expect((await run(orgId, microsoft("from attacker.example (203.0.113.9)"))).results).toMatchObject({
      trusted: false,
      reason: "no-boundary",
    });
  });

  it("learns a Google chain the same way", async () => {
    const orgId = await organisation();
    const via = "from relay-out.gw.filter.example (relay-out.gw.filter.example. [198.51.100.20])";
    await run(orgId, google(via));
    expect((await run(orgId, google(via))).results).toMatchObject({ trusted: true, receiver: "google" });
  });

  it("stores chain-unverified when the gateway's addresses could not be learned, then recovers", async () => {
    const orgId = await organisation();
    await run(orgId, microsoft(VIA), resolving({ ...DNS, "filter.example TXT": null }));
    expect((await run(orgId, microsoft(VIA), resolving({ ...DNS, "filter.example TXT": null }))).results).toMatchObject(
      {
        trusted: false,
        reason: "chain-unverified",
      },
    );
    await run(orgId, microsoft(VIA));
    expect((await run(orgId, microsoft(VIA))).results).toMatchObject({ trusted: true, receiver: "microsoft" });
  });
});
