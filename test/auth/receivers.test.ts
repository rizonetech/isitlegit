import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  type LookupMx,
  learnReceivers,
  RECEIVERS_STALE_MS,
  RELEARN_DOMAINS,
  receiversForOrg,
  receiversOf,
} from "../../src/auth/receivers";

// D02 T02 §1: an organisation's receiving systems, learned from its verified domains' MX and bound to each claim.
const db = (env as unknown as Env).DB;

async function claim(orgId: string, domain: string, state: "pending" | "verified" = "verified") {
  const id = `claim-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      orgId,
      domain,
      "t".repeat(16),
      state,
      state === "verified" ? "dns" : null,
      state === "verified" ? now : null,
      now,
    )
    .run();
  return id;
}
const rows = async (claimId: string) =>
  (
    await db
      .prepare("SELECT kind, pattern FROM org_receivers WHERE claim_id = ? ORDER BY kind, pattern")
      .bind(claimId)
      .all<{ kind: string; pattern: string }>()
  ).results;
const answering = (mx: Record<string, string[] | null>): LookupMx & { asked: string[] } => {
  const asked: string[] = [];
  return Object.assign(
    async (domain: string) => {
      asked.push(domain);
      return domain in mx ? (mx[domain] ?? null) : [];
    },
    { asked },
  );
};

describe("receiversOf", () => {
  it("knows Microsoft 365, Google and any other system by its host and registrable domain", () => {
    expect(receiversOf(["contoso-com.mail.protection.outlook.com"])).toEqual([
      { kind: "microsoft", pattern: "*.outlook.com" },
    ]);
    expect(receiversOf(["aspmx.l.google.com", "alt2.aspmx.l.google.com", "smtp.google.com"])).toEqual([
      { kind: "google", pattern: "*.google.com" },
    ]);
    expect(receiversOf(["mx1.mailhost.example.co.za"])).toEqual([
      { kind: "other", pattern: "mx1.mailhost.example.co.za" },
      { kind: "other", pattern: "*.example.co.za" },
    ]);
    expect(receiversOf([])).toEqual([]);
  });
});

describe("learnReceivers", () => {
  it("stores each kind for a verified claim, replacing what was there", async () => {
    const id = await claim("org-learn", "learn.co.za");
    expect(
      await learnReceivers(db, id, answering({ "learn.co.za": ["learn-co-za.mail.protection.outlook.com"] })),
    ).toEqual([{ kind: "microsoft", pattern: "*.outlook.com" }]);
    expect(await rows(id)).toEqual([{ kind: "microsoft", pattern: "*.outlook.com" }]);
    await learnReceivers(db, id, answering({ "learn.co.za": ["aspmx.l.google.com"] }));
    expect(await rows(id)).toEqual([{ kind: "google", pattern: "*.google.com" }]);
    await learnReceivers(db, id, answering({ "learn.co.za": ["mx.mailhost.example"] }));
    expect(await rows(id)).toEqual([
      { kind: "other", pattern: "*.mailhost.example" },
      { kind: "other", pattern: "mx.mailhost.example" },
    ]);
  });

  it("keeps the rows already there when the lookup fails, and learns nothing for a pending claim", async () => {
    const id = await claim("org-keep", "keep.co.za");
    await learnReceivers(db, id, answering({ "keep.co.za": ["aspmx.l.google.com"] }));
    expect(await learnReceivers(db, id, answering({ "keep.co.za": null }))).toBeNull();
    expect(await rows(id)).toEqual([{ kind: "google", pattern: "*.google.com" }]);
    const pending = await claim("org-keep", "pending.co.za", "pending");
    const lookup = answering({ "pending.co.za": ["aspmx.l.google.com"] });
    expect(await learnReceivers(db, pending, lookup)).toBeNull();
    expect(lookup.asked).toEqual([]);
    expect(await rows(pending)).toEqual([]);
  });

  it("writes nothing when the claim is removed while its lookup is under way", async () => {
    const id = await claim("org-late", "late.co.za");
    const late: LookupMx = async () => {
      await db.prepare("DELETE FROM org_domains WHERE id = ?").bind(id).run();
      return ["aspmx.l.google.com"];
    };
    await learnReceivers(db, id, late);
    expect(await rows(id)).toEqual([]);
  });
});

describe("receiversForOrg", () => {
  it("learns the claims that have none, reuses fresh ones, and learns stale ones again", async () => {
    const id = await claim("org-for", "for.co.za");
    const lookup = answering({ "for.co.za": ["aspmx.l.google.com"] });
    expect(await receiversForOrg(db, "org-for", lookup)).toEqual([{ kind: "google", pattern: "*.google.com" }]);
    expect(await receiversForOrg(db, "org-for", lookup)).toEqual([{ kind: "google", pattern: "*.google.com" }]);
    expect(lookup.asked).toEqual(["for.co.za"]);
    await db
      .prepare("UPDATE org_receivers SET learned_at = ? WHERE claim_id = ?")
      .bind(new Date(Date.now() - RECEIVERS_STALE_MS - 1000).toISOString(), id)
      .run();
    // Stale, and the lookup now fails: the old receivers stand.
    const failing = answering({ "for.co.za": null });
    expect(await receiversForOrg(db, "org-for", failing)).toEqual([{ kind: "google", pattern: "*.google.com" }]);
    expect(failing.asked).toEqual(["for.co.za"]);
  });

  it("trusts only receivers whose claim is still verified, and bounds the lookups one case makes", async () => {
    const domains = Array.from({ length: RELEARN_DOMAINS + 2 }, (_, i) => `bound${i}.co.za`);
    for (const d of domains) await claim("org-bound", d);
    const lookup = answering(Object.fromEntries(domains.map((d) => [d, ["aspmx.l.google.com"]])));
    await receiversForOrg(db, "org-bound", lookup);
    expect(lookup.asked).toHaveLength(RELEARN_DOMAINS);
    const gone = await claim("org-gone", "gone.co.za");
    await learnReceivers(db, gone, answering({ "gone.co.za": ["aspmx.l.google.com"] }));
    await db.prepare("UPDATE org_domains SET state = 'pending' WHERE id = ?").bind(gone).run();
    expect(await receiversForOrg(db, "org-gone", answering({}))).toEqual([]);
  });
});
