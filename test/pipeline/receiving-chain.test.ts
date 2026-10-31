import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { learnReceivers } from "../../src/auth/receivers";
import type { Resolve } from "../../src/auth/receiving-chains";
import { bundled } from "../../src/checks/brands";
import { readEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { parsedKey, putParsed, putRaw, type Store } from "../../src/intake/store";
import { checks } from "../../src/pipeline/analysis-workflow";

// D02 T02 §6, end to end in the checks step: one case proves the organisation's receiving chain, the chain is stored,
// and the next case is read with it, its stored `auth.results` evidence trusting Microsoft 365's stamp. Hosts and
// addresses are fictional.
const db = env.DB;
const store: Store = { bucket: env.ARTEFACTS, db };
const DNS: Record<string, string[]> = {
  "mx1.gw.filter.example A": ["192.0.2.10"],
  "filter.example TXT": ["v=spf1 ip4:198.51.100.0/24 -all"],
};
const resolve: Resolve = async (name, type) => DNS[`${name} ${type}`] ?? [];
const gatewayMx = async () => ["mx1.gw.filter.example"];
const trace = (from: string) => [
  {
    name: "Received",
    value:
      "from AM6PR02.eurprd02.prod.outlook.com (2603:10a6:20b:1::12) by DB9PR02.eurprd02.prod.outlook.com with HTTPS; Fri, 31 Oct 2026 09:00:01 +0000",
  },
  {
    name: "Authentication-Results",
    value:
      "spf=fail smtp.mailfrom=sender.example; dkim=none; dmarc=fail action=none header.from=sender.example; compauth=fail reason=000",
  },
  {
    name: "Received",
    value: `${from} by AM5EUR01FT001.mail.protection.outlook.com with Microsoft SMTP Server; Fri, 31 Oct 2026 09:00:01 +0000`,
  },
  {
    name: "Received",
    value:
      "from mail.sender.example (203.0.113.5) by mx1.gw.filter.example with ESMTPS; Fri, 31 Oct 2026 09:00:00 +0000",
  },
  { name: "From", value: "Accounts <accounts@sender.example>" },
];

async function caseFor(orgId: string, from: string) {
  const made = await createCase(db, { orgId, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  const caseId = made.value.id;
  await putRaw(store, caseId, new TextEncoder().encode("From: x@y.example\r\n\r\nSee below.\r\n"));
  await putParsed(store, caseId, {
    headers: trace(from),
    text: "Please pay the attached invoice.",
    html: null,
    attachments: [],
    truncated: [],
    omitted: 0,
    forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
  });
  await checks(store, caseId, parsedKey(caseId), { orgId, channel: "email" }, gatewayMx, bundled, null, null, resolve);
  const [item] = (await readEvidence(db, caseId)).filter((e) => e.check === "auth.results");
  return item?.detail;
}

describe("a receiving chain in the checks step", () => {
  it("is learned from one case, read back, and trusted on the next case's stored evidence", async () => {
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
    const via = "from relay-out.gw.filter.example (198.51.100.20)";
    // The first case proves the chain but is read without it.
    expect(await caseFor(orgId, via)).toMatchObject({ trusted: false, reason: "no-boundary" });
    const rows = await db
      .prepare("SELECT gateway, provider FROM org_receiving_chains WHERE org_id = ?")
      .bind(orgId)
      .all<{ gateway: string; provider: string }>();
    expect(rows.results).toEqual([{ gateway: "*.filter.example", provider: "microsoft" }]);
    // The next case is read with it.
    expect(await caseFor(orgId, via)).toMatchObject({ trusted: true, receiver: "microsoft" });
    // A message handed to Microsoft 365 directly keeps no boundary.
    expect(await caseFor(orgId, "from attacker.example (203.0.113.9)")).toMatchObject({
      trusted: false,
      reason: "no-boundary",
    });
  });
});
