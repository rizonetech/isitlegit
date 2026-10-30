import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { readEvidence } from "../../src/checks/evidence";
import { observeSender, senderHash } from "../../src/checks/senders-seen";
import { createCase } from "../../src/db/cases";
import { parsedKey, putParsed, putRaw, rawKey, type Store } from "../../src/intake/store";
import { checks } from "../../src/pipeline/analysis-workflow";

// D02 T02 §5: a sender an organisation's earlier IsItLegit checks never had, kept only as a salted hash, classified once
// per case.
const db = env.DB;
const store: Store = { bucket: env.ARTEFACTS, db };
beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sender_observations"), db.prepare("DELETE FROM org_sender_salts")]);
});

describe("observeSender", () => {
  it("is first for a new sender, seen for a known one, and the same answer again for the case that asked", async () => {
    expect(await observeSender(db, "org-a", "case-1", "billing@supplier.example")).toBe("first");
    expect(await observeSender(db, "org-a", "case-2", "billing@supplier.example")).toBe("seen");
    expect(await observeSender(db, "org-a", "case-1", "billing@supplier.example")).toBe("first");
    expect(await observeSender(db, "org-a", "case-2", "billing@supplier.example")).toBe("seen");
    const count = await db.prepare("SELECT COUNT(*) AS n FROM sender_observations").first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it("makes exactly one of two overlapping first cases first", async () => {
    const answers = await Promise.all([
      observeSender(db, "org-a", "case-x", "new@supplier.example"),
      observeSender(db, "org-a", "case-y", "new@supplier.example"),
    ]);
    expect(answers.sort()).toEqual(["first", "seen"]);
  });

  it("keeps two organisations apart: each first, each with its own 32-byte salt and hash", async () => {
    expect(await observeSender(db, "org-a", "c-a", "billing@supplier.example")).toBe("first");
    expect(await observeSender(db, "org-b", "c-b", "billing@supplier.example")).toBe("first");
    const salts = (
      await db.prepare("SELECT org_id, salt FROM org_sender_salts ORDER BY org_id").all<{ salt: string }>()
    ).results;
    expect(salts).toHaveLength(2);
    expect(salts[0]?.salt).not.toBe(salts[1]?.salt);
    for (const s of salts) expect(s.salt).toMatch(/^[0-9a-f]{64}$/);
    const hashes = (await db.prepare("SELECT sender_hash FROM sender_observations").all<{ sender_hash: string }>())
      .results;
    expect(new Set(hashes.map((h) => h.sender_hash)).size).toBe(2);
  });

  it("never replaces a salt in use, so history survives a second first use", async () => {
    await observeSender(db, "org-a", "c1", "billing@supplier.example");
    const before = await db.prepare("SELECT salt FROM org_sender_salts").first<{ salt: string }>();
    const hash = await senderHash(db, "org-a", "billing@supplier.example");
    await Promise.all([senderHash(db, "org-a", "x@y.example"), senderHash(db, "org-a", "z@y.example")]);
    expect((await db.prepare("SELECT salt FROM org_sender_salts").first<{ salt: string }>())?.salt).toBe(before?.salt);
    expect(await senderHash(db, "org-a", "billing@supplier.example")).toBe(hash);
  });

  it("stores no address in clear", async () => {
    await observeSender(db, "org-a", "c1", "billing@supplier.example");
    const dump = JSON.stringify([
      ...(await db.prepare("SELECT * FROM sender_observations").all()).results,
      ...(await db.prepare("SELECT * FROM org_sender_salts").all()).results,
    ]);
    expect(dump).not.toContain("billing");
    expect(dump).not.toContain("supplier");
  });
});

// A stored message for an organisation, run through the Workflow's checks step.
async function stepWith(org: string, headers: { name: string; value: string }[], headersAvailable = true) {
  const made = await createCase(env.DB, { orgId: org, channel: "email", headersAvailable });
  if (!made.ok) throw new Error(made.error.message);
  const id = made.value.id;
  await putRaw(store, id, new TextEncoder().encode("From: a@b.example\r\n\r\nPay.\r\n"));
  await putParsed(store, id, {
    headers,
    text: "Pay.",
    html: null,
    attachments: [],
    truncated: [],
    omitted: 0,
    forward: { path: headersAvailable ? "rfc822" : "inline", headersAvailable, otherOriginals: 0 },
  });
  const run = () => checks(store, id, parsedKey(id), { orgId: org, channel: "email" }, async () => []);
  return { id, run };
}
const firstTime = async (id: string) => (await readEvidence(env.DB, id)).filter((e) => e.check === "sender.first_time");

describe("sender.first_time through the checks step", () => {
  it("is stored for the first case, the same on a retry, and absent for a second case, with honest wording", async () => {
    const from = { name: "From", value: "Accounts <billing@bücher.example>" };
    const one = await stepWith("org-step", [from]);
    await one.run();
    await one.run();
    const [item, ...more] = await firstTime(one.id);
    expect(more).toEqual([]);
    expect(item).toMatchObject({
      severity: "low",
      artefacts: [rawKey(one.id)],
      detail: { headers: [`From: ${from.value}`] },
    });
    expect(item?.summary).toContain("has not appeared in your organisation's earlier IsItLegit checks");
    expect(item?.summary).toContain("Mail you received without checking it is not counted.");
    expect(await env.ARTEFACTS.head(rawKey(one.id))).not.toBeNull();
    // The same mailbox in its A-label form is the same sender.
    const two = await stepWith("org-step", [{ name: "From", value: "billing@xn--bcher-kva.example" }]);
    await two.run();
    expect(await firstTime(two.id)).toEqual([]);
  });

  it("gives no item and records nothing without the original's headers or a single valid From", async () => {
    const cases = [
      await stepWith("org-none", [{ name: "From", value: "Member <member@member.example>" }], false),
      await stepWith("org-none", []),
      await stepWith("org-none", [{ name: "From", value: "a@x.example, b@y.example" }]),
      await stepWith("org-none", [
        { name: "From", value: "a@x.example" },
        { name: "From", value: "b@y.example" },
      ]),
      await stepWith("org-none", [{ name: "From", value: "not an address" }]),
    ];
    for (const c of cases) {
      await c.run();
      expect(await firstTime(c.id)).toEqual([]);
    }
    const rows = await db
      .prepare("SELECT COUNT(*) AS n FROM sender_observations WHERE org_id = 'org-none'")
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("keeps the item when the display name is oversized", async () => {
    const big = await stepWith("org-big", [{ name: "From", value: `"${"x".repeat(70_000)}" <billing@big.example>` }]);
    await big.run();
    const items = await readEvidence(env.DB, big.id);
    expect(items.some((e) => e.check === "not_checked")).toBe(false);
    expect(items.filter((e) => e.check === "sender.first_time")).toHaveLength(1);
  });
});
