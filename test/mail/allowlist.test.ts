import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { isAllowedRecipient } from "../../src/mail/allowlist";
import type { MailKind } from "../../src/mail/smtp2go";
import { addMember } from "../fixtures/auth/members";

// D01 T02 §2: who IsItLegit may mail during the event, by purpose (design spec section 11).
const db = env.DB;
const OPERATOR = "hostmaster@rizonetech.com";
const allowed = (to: string, kind: MailKind) => isAllowedRecipient(db, to, kind, OPERATOR);
const KINDS: MailKind[] = ["signin", "reply", "notice", "renewal", "verify", "alert"];

async function invitation(email: string, status: string, expiresInMs: number) {
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('inviter', 'Inviter', 'inviter@example.com', 1, ?, ?)`,
      )
      .bind(new Date(now).toISOString(), new Date(now).toISOString()),
    db
      .prepare(
        `INSERT OR IGNORE INTO "organization" (id, name, slug, "createdAt") VALUES ('inviting-org', 'Inviting', 'inviting', ?)`,
      )
      .bind(new Date(now).toISOString()),
    db
      .prepare(
        `INSERT OR IGNORE INTO "invitation" (id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId") VALUES (?, 'inviting-org', ?, 'member', ?, ?, ?, 'inviter')`,
      )
      .bind(
        `invitation-${email}`,
        email,
        status,
        new Date(now + expiresInMs).toISOString(),
        new Date(now).toISOString(),
      ),
  ]);
}

beforeEach(async () => {
  await addMember(db, "member@example.com");
  // A user with no organisation: registered, not a member.
  await db
    .prepare(
      `INSERT OR IGNORE INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('loose', 'Loose', 'loose@example.com', 1, ?, ?)`,
    )
    .bind(new Date().toISOString(), new Date().toISOString())
    .run();
  await invitation("invitee@example.com", "pending", 60 * 60_000);
  await invitation("expired@example.com", "pending", -60_000);
  await invitation("cancelled@example.com", "canceled", 60 * 60_000);
});

describe("isAllowedRecipient", () => {
  it("lets a member receive sign-in, reply, notice and renewal mail, but never verify or alert mail", async () => {
    for (const kind of ["signin", "reply", "notice", "renewal"] as const)
      expect(await allowed("member@example.com", kind), kind).toBe(true);
    expect(await allowed("Member@Example.COM", "reply")).toBe(true);
    for (const kind of ["verify", "alert"] as const)
      expect(await allowed("member@example.com", kind), kind).toBe(false);
  });

  it("lets a pending, unexpired invitee receive sign-in mail only", async () => {
    expect(await allowed("invitee@example.com", "signin")).toBe(true);
    for (const kind of ["reply", "notice", "renewal", "verify", "alert"] as const)
      expect(await allowed("invitee@example.com", kind), kind).toBe(false);
    expect(await allowed("expired@example.com", "signin")).toBe(false);
    expect(await allowed("cancelled@example.com", "signin")).toBe(false);
  });

  it("lets the demo aliases receive every kind, and the operator everything but verify", async () => {
    for (const kind of KINDS) {
      expect(await allowed("contact@demo.isitlegit.co.za", kind), kind).toBe(true);
      expect(await allowed("alerts@isitlegit.co.za", kind), kind).toBe(true);
      expect(await allowed(OPERATOR, kind), kind).toBe(kind !== "verify");
    }
  });

  it("refuses an unregistered address, a user with no organisation, and look-alike domains", async () => {
    for (const kind of KINDS) {
      expect(await allowed("someone@example.com", kind), kind).toBe(false);
      expect(await allowed("loose@example.com", kind), kind).toBe(false);
      for (const lookAlike of [
        "x@isitlegit.co.za.evil.example",
        "x@evilisitlegit.co.za",
        "x@demo.isitlegit.co.za.example",
        "x@notdemo.isitlegit.co.za",
      ])
        expect(await allowed(lookAlike, kind), `${lookAlike} ${kind}`).toBe(false);
    }
  });

  it("sends ownership codes (claim) only to a pending claim's recipients, and closed-loop verify mail never there", async () => {
    const now = new Date().toISOString();
    await db.batch([
      db
        .prepare(
          "INSERT OR IGNORE INTO org_domains (id, org_id, domain, token, state, created_at) VALUES ('d-pending', 'o1', 'claimed.co.za', 'tttttttttttttttt', 'pending', ?)",
        )
        .bind(now),
      db
        .prepare(
          "INSERT OR IGNORE INTO org_domains (id, org_id, domain, token, state, created_at) VALUES ('d-done', 'o1', 'done.co.za', 'tttttttttttttttt', 'verified', ?)",
        )
        .bind(now),
      db
        .prepare(
          "INSERT OR IGNORE INTO org_addresses (id, org_id, address, state, created_at) VALUES ('a-pending', 'o1', 'boss@gmail.com', 'pending', ?)",
        )
        .bind(now),
    ]);
    for (const to of ["admin@claimed.co.za", "postmaster@claimed.co.za", "boss@gmail.com"]) {
      expect(await allowed(to, "claim"), to).toBe(true);
      expect(await allowed(to, "verify"), `verify ${to}`).toBe(false);
    }
    for (const to of [
      "sales@claimed.co.za",
      "admin@done.co.za",
      "admin@never.co.za",
      "member@example.com",
      "contact@demo.isitlegit.co.za",
      OPERATOR,
    ])
      expect(await allowed(to, "claim"), to).toBe(false);
  });

  it("lets a forwarder that intake admits receive reply and notice mail, not renewal (D01 T01 §3)", async () => {
    const at = new Date().toISOString();
    await db.batch([
      db
        .prepare(
          "INSERT OR IGNORE INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES ('d-forward', 'o-forward', 'forwarders.co.za', 'tttttttttttttttt', 'verified', 'dns', ?, ?)",
        )
        .bind(at, at),
      db
        .prepare(
          "INSERT OR IGNORE INTO org_domains (id, org_id, domain, token, state, created_at) VALUES ('d-waiting', 'o-forward', 'waiting.co.za', 'tttttttttttttttt', 'pending', ?)",
        )
        .bind(at),
      db
        .prepare(
          "INSERT OR IGNORE INTO org_addresses (id, org_id, address, state, verified_at, created_at) VALUES ('a-forward', 'o-forward', 'owner.personal@gmail.com', 'verified', ?, ?)",
        )
        .bind(at, at),
    ]);
    for (const to of ["accounts@forwarders.co.za", "ceo@mail.forwarders.co.za", "owner.personal@gmail.com"]) {
      expect(await allowed(to, "reply"), to).toBe(true);
      expect(await allowed(to, "notice"), to).toBe(true);
      expect(await allowed(to, "renewal"), to).toBe(false);
    }
    for (const to of ["accounts@waiting.co.za", "someone.else@gmail.com", "accounts@forwarders.co.za.evil.com"]) {
      expect(await allowed(to, "reply"), to).toBe(false);
      expect(await allowed(to, "notice"), to).toBe(false);
    }
  });

  it("admits each of the operator's mailboxes when given a list, for alerts, and no one else (D01 T02 §6)", async () => {
    const both = [OPERATOR, "rizonetech@gmail.com"];
    expect(await isAllowedRecipient(db, "rizonetech@gmail.com", "alert", both)).toBe(true);
    expect(await isAllowedRecipient(db, OPERATOR, "alert", both)).toBe(true);
    expect(await isAllowedRecipient(db, "someone@gmail.com", "alert", both)).toBe(false);
    // A single operator address, as every other sender passes it, does not admit the fallback.
    expect(await isAllowedRecipient(db, "rizonetech@gmail.com", "alert", OPERATOR)).toBe(false);
  });

  it("admits no operator when none is configured", async () => {
    expect(await isAllowedRecipient(db, OPERATOR, "alert", undefined)).toBe(false);
    expect(await isAllowedRecipient(db, OPERATOR, "alert", "")).toBe(false);
  });
});
