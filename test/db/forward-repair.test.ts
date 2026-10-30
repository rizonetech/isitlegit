import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// D01 T02 §9: migration 0040 repairs the rows §6's first deployment wrote for probe 3 (bracketed domains, and the second
// notice's false "not found" incident), as the fixed code would have written them.
const db = env.DB;
const repair = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0040_"));
const apply = async () => {
  if (!repair) throw new Error("migration 0040 is missing");
  for (const query of repair.queries) await db.prepare(query).run();
};
const hex = (prefix: string) => prefix.padEnd(64, "0");
const SUBJECT_3 = hex("5b3");
const SUBJECT_4 = hex("5b4");

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM forward_incidents"),
    db.prepare("DELETE FROM forward_notices"),
    db.prepare("DELETE FROM forward_seen"),
  ]);
  const incident = db.prepare(
    "INSERT INTO forward_incidents (key, kind, subject_hash, alias, sender_domain, destination_domain, forward_hash, received_at, occurred_at, detected_at, state, alert, alert_tries) VALUES (?, 'refused', ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'sent', 1)",
  );
  const notice = db.prepare("INSERT INTO forward_notices (notice_hash, incident_key) VALUES (?, ?)");
  await db.batch([
    // Probe 3 as live D1 held it: the refusal, its domains bracketed, and the second notice's false incident.
    incident.bind(
      hex("130199c1f8fb"),
      SUBJECT_3,
      "hello@isitlegit.co.za",
      "isitlegit.co.za>",
      "rizonetech.com>",
      hex("f3"),
      "2026-10-30T16:40:59Z",
      "2026-10-30T16:41:08Z",
      "2026-10-30T17:00:30Z",
    ),
    incident.bind(
      hex("43a48a16bf6d"),
      SUBJECT_3,
      null,
      null,
      "rizonetech.com>",
      null,
      null,
      "2026-10-30T16:41:09Z",
      "2026-10-30T17:00:30Z",
    ),
    // Probe 4, written by the fixed code.
    incident.bind(
      hex("be3d4494b769"),
      SUBJECT_4,
      "hello@isitlegit.co.za",
      "isitlegit.co.za",
      "rizonetech.com",
      hex("f4"),
      "2026-10-30T18:28:01Z",
      "2026-10-30T18:28:07Z",
      "2026-10-30T18:45:34Z",
    ),
    notice.bind(hex("a1"), hex("130199c1f8fb")),
    notice.bind(hex("a2"), hex("43a48a16bf6d")),
    notice.bind(hex("b1"), hex("be3d4494b769")),
    notice.bind(hex("b2"), hex("be3d4494b769")),
    db
      .prepare("INSERT INTO forward_seen (message_hash, subject_hash, alias, sender_domain, at) VALUES (?, ?, ?, ?, ?)")
      .bind(hex("f3"), SUBJECT_3, "hello@isitlegit.co.za", "isitlegit.co.za>", "2026-10-30T16:40:59Z"),
  ]);
});

const snapshot = async () => ({
  incidents: (
    await db
      .prepare("SELECT key, alias, sender_domain, destination_domain FROM forward_incidents ORDER BY occurred_at")
      .all()
  ).results,
  notices: (await db.prepare("SELECT notice_hash, incident_key FROM forward_notices ORDER BY notice_hash").all())
    .results,
  seen: (await db.prepare("SELECT sender_domain FROM forward_seen").all()).results,
});

describe("migration 0040", () => {
  it("leaves two incidents, four notices and clean domains", async () => {
    await apply();
    const after = await snapshot();
    expect(after.incidents).toEqual([
      {
        key: hex("130199c1f8fb"),
        alias: "hello@isitlegit.co.za",
        sender_domain: "isitlegit.co.za",
        destination_domain: "rizonetech.com",
      },
      {
        key: hex("be3d4494b769"),
        alias: "hello@isitlegit.co.za",
        sender_domain: "isitlegit.co.za",
        destination_domain: "rizonetech.com",
      },
    ]);
    expect(after.notices).toEqual([
      { notice_hash: hex("a1"), incident_key: hex("130199c1f8fb") },
      { notice_hash: hex("a2"), incident_key: hex("130199c1f8fb") },
      { notice_hash: hex("b1"), incident_key: hex("be3d4494b769") },
      { notice_hash: hex("b2"), incident_key: hex("be3d4494b769") },
    ]);
    expect(after.seen).toEqual([{ sender_domain: "isitlegit.co.za" }]);
  });

  it("changes nothing on a second run", async () => {
    await apply();
    const once = await snapshot();
    await apply();
    expect(await snapshot()).toEqual(once);
  });

  it("never folds an incident tied to a forward, nor one far from its sibling", async () => {
    await db.batch([
      db.prepare("UPDATE forward_incidents SET forward_hash = ? WHERE key = ?").bind(hex("f9"), hex("43a48a16bf6d")),
    ]);
    await apply();
    expect((await snapshot()).incidents).toHaveLength(3);
    await db.batch([
      db
        .prepare("UPDATE forward_incidents SET forward_hash = NULL, occurred_at = ? WHERE key = ?")
        .bind("2026-10-30T16:41:20Z", hex("43a48a16bf6d")),
    ]);
    await apply();
    expect((await snapshot()).incidents).toHaveLength(3);
  });
});
