// The admin organisation detail and feedback queue (D07 T08 §5): the triage state machine behind the New,
// Triaged and Closed tabs. A member edit after triage reopens the item, a stale operator POST is refused, and a
// withdrawn row leaves the queue; the counts follow the triage state while notices still follow notified_at.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createCase } from "../../src/db/cases";
import { saveFeedback, withdrawFeedback } from "../../src/db/feedback";
import { listTriage, moveTriage, saveTriageNote, triageCounts } from "../../src/db/feedback-triage";
import { makeOrg } from "../trust/helpers";

const db = env.DB;
// The file shares one database across its tests, so every count asserts the move it made, not an absolute total.
const moveOf = async (work: () => Promise<unknown>) => {
  const before = await triageCounts(db);
  await work();
  const after = await triageCounts(db);
  return { new: after.new - before.new, triaged: after.triaged - before.triaged, closed: after.closed - before.closed };
};

const seedFeedback = async (orgId: string, userId: string, kind: "false_alarm" | "missed" = "false_alarm") => {
  const made = await createCase(db, { orgId, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  const saved = await saveFeedback(db, {
    caseId: made.value.id,
    userId,
    kind,
    note: "Should have been flagged",
    providers: [],
  });
  // `Feedback` carries no revision: the operator POST carries what the row holds.
  const revision = await db
    .prepare("SELECT updated_at AS updatedAt FROM feedback WHERE id = ?")
    .bind(saved.id)
    .first<{ updatedAt: string }>();
  return { ...saved, updatedAt: revision?.updatedAt ?? "" };
};

describe("feedback triage", () => {
  it("moves new to triaged to closed with the note kept, and counts each tab", async () => {
    const orgId = await makeOrg("Triage Org (fictional)");
    expect(
      await moveOf(async () => {
        await seedFeedback(orgId, "user-triage-1");
        await seedFeedback(orgId, "user-triage-2");
        await seedFeedback(orgId, "user-triage-3", "missed");
      }),
    ).toEqual({ new: 3, triaged: 0, closed: 0 });
    const first = (await listTriage(db, "new")).find((row) => row.userId === "user-triage-1");
    expect(first?.id).toBeDefined();
    if (!first) throw new Error("seeded feedback missing from the new tab");
    const noted = await saveTriageNote(db, { id: first.id, note: "Ledger was empty", knownUpdatedAt: first.updatedAt });
    expect(noted?.triage).toBe("triaged");
    expect(noted?.triageNote).toBe("Ledger was empty");
    const closed = await moveTriage(db, { id: first.id, to: "closed", knownUpdatedAt: noted?.updatedAt ?? "" });
    expect(closed?.triage).toBe("closed");
    expect(closed?.triageNote).toBe("Ledger was empty");
    // The tabs list their own rows, newest first.
    expect((await listTriage(db, "new")).map((row) => row.id)).not.toContain(first.id);
    expect((await listTriage(db, "closed")).map((row) => row.id)).toContain(first.id);
  });

  it("refuses a stale operator POST and keeps the row untouched", async () => {
    const orgId = await makeOrg("Stale Org (fictional)");
    const row = await seedFeedback(orgId, "user-stale-1");
    const moved = await moveTriage(db, { id: row.id, to: "closed", knownUpdatedAt: row.updatedAt });
    expect(moved?.triage).toBe("closed");
    const stale = await saveTriageNote(db, { id: row.id, note: "Too late", knownUpdatedAt: row.updatedAt });
    expect(stale).toBeNull();
    const kept = (await listTriage(db, "closed")).find((item) => item.id === row.id);
    expect(kept?.triageNote).toBeNull();
  });

  it("reopens a settled item when the member edits it, keeping the operator note", async () => {
    const orgId = await makeOrg("Reopen Org (fictional)");
    const row = await seedFeedback(orgId, "user-reopen-1");
    const noted = await saveTriageNote(db, { id: row.id, note: "Check the ledger", knownUpdatedAt: row.updatedAt });
    expect(
      await moveOf(async () => {
        await moveTriage(db, { id: row.id, to: "closed", knownUpdatedAt: noted?.updatedAt ?? "" });
      }),
    ).toEqual({ new: 0, triaged: -1, closed: 1 });
    // The member's words change: the item reads as new again with the operator's note kept.
    expect(
      await moveOf(async () => {
        await db
          .prepare("UPDATE feedback SET kind = ?, note = ?, updated_at = ? WHERE id = ?")
          .bind("missed", "Actually it should be safe", "2026-11-03T00:00:00.000Z", row.id)
          .run();
      }),
    ).toEqual({ new: 1, triaged: 0, closed: -1 });
    const reopened = (await listTriage(db, "new")).find((item) => item.id === row.id);
    expect(reopened?.triageNote).toBe("Check the ledger");
    // The member flow never clobbers triage columns it does not own.
    await saveFeedback(db, {
      caseId: row.caseId,
      userId: row.userId,
      kind: "missed",
      note: "Actually it should be safe",
      providers: [],
    });
    expect((await listTriage(db, "new")).find((item) => item.id === row.id)?.triageNote).toBe("Check the ledger");
  });

  it("drops a withdrawn row from the queue and the counts", async () => {
    const orgId = await makeOrg("Withdraw Org (fictional)");
    const row = await seedFeedback(orgId, "user-withdraw-1");
    await saveTriageNote(db, { id: row.id, note: "Kept", knownUpdatedAt: row.updatedAt });
    expect(
      await moveOf(async () => {
        expect(await withdrawFeedback(db, row.caseId, row.userId)).toBe(true);
      }),
    ).toEqual({ new: 0, triaged: -1, closed: 0 });
    expect((await listTriage(db, "triaged")).find((item) => item.id === row.id)).toBeUndefined();
  });

  it("pages the queue fifty at a time with every record reachable", async () => {
    const orgId = await makeOrg("Paging Org (fictional)");
    const ids: string[] = [];
    for (let i = 0; i < 52; i += 1) ids.push((await seedFeedback(orgId, `user-page-${i}`)).id);
    const mine = (rows: { id: string }[]) => rows.filter((row) => ids.includes(row.id));
    const first = mine(await listTriage(db, "new", 0));
    const second = mine(await listTriage(db, "new", 1));
    expect(first).toHaveLength(50);
    expect(second).toHaveLength(2);
    expect(new Set([...first, ...second].map((row) => row.id))).toEqual(new Set(ids));
  });
});
