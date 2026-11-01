import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../../src/auth/auth";
import { findMemberBySender } from "../../src/auth/domains";
import { toAddressPage } from "../../src/web/pages/addresses";
import { authEnv, call, ORIGIN, signIn, stubSmtp2go, target } from "../auth/helpers";

// The single-address page (D07 T04 §27; SPEC M8a): an address added from the Domains page, its code mailed and proved on
// a page of its own, every outcome of the send and of the code told truthfully from the stored claim, the controls held
// and freed by the clock, and the verification real: the stored claim, the fresh reads and the sender lookup.
const db = (env as unknown as Env).DB;
afterEach(() => vi.restoreAllMocks());

const tag = () => crypto.randomUUID().slice(0, 8);
async function person(name: string) {
  const email = `addr-${tag()}@demo.isitlegit.co.za`;
  const { cookie } = await signIn(email);
  const id = (await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>())
    ?.id as string;
  await db.prepare(`UPDATE "user" SET name = ? WHERE id = ?`).bind(name, id).run();
  return { cookie, email, id, name };
}
async function organisation(owner: { id: string }, name = "Karoo Couriers") {
  const made = (await createAuth(authEnv).api.createOrganization({
    body: { name, slug: `${name.toLowerCase().replace(/\W+/g, "-")}-${tag()}`, userId: owner.id },
  })) as { id: string };
  await db.prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`).bind(made.id, owner.id).run();
  return made.id;
}
async function join(orgId: string, who: { id: string }, role: "owner" | "admin" | "member") {
  await db
    .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
    .bind(`m-${tag()}${tag()}`, orgId, who.id, role, new Date().toISOString())
    .run();
  await db.prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`).bind(orgId, who.id).run();
}
const get = async (cookie: string, path: string) => {
  const res = await call(path, { headers: { cookie, accept: "text/html" } });
  return { res, html: await res.text() };
};
const form = (cookie: string, path: string, fields: Record<string, string>, origin: string | null = ORIGIN) => {
  const headers = new Headers({ cookie, "content-type": "application/x-www-form-urlencoded", accept: "text/html" });
  headers.set("origin", origin ?? "");
  return call(path, { method: "POST", headers, body: new URLSearchParams(fields).toString() });
};
const text = (h: string) =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
const pathOf = (address: string) => `/settings/addresses/${encodeURIComponent(address)}`;
const claim = (orgId: string, address: string) =>
  db
    .prepare(`SELECT id, state, verified_at FROM org_addresses WHERE org_id = ? AND address = ?`)
    .bind(orgId, address)
    .first<{ id: string; state: string; verified_at: string | null }>();
// The attribute, not the `disabled:` classes every button carries.
const DISABLED_SEND = /<button[^>]*id="send-code"[^>]*\sdisabled(?:=""|\s|>)/;
const codeIn = (sends: { text: string }[]) => /\b(\d{6})\b/.exec(sends.at(-1)?.text ?? "")?.[1] ?? "";
const wrongOf = (code: string) => (code === "000000" ? "111111" : "000000");
// A world with an owner who has the organisation active.
async function world() {
  const owner = await person("Owner");
  const orgId = await organisation(owner);
  return { owner, orgId };
}
const add = (cookie: string, orgId: string, address: string) =>
  form(cookie, "/settings/domains", { action: "add-address", org: orgId, address });
// Add an address, follow its redirect, and read the page.
async function added(cookie: string, orgId: string, address: string) {
  const res = await add(cookie, orgId, address);
  expect(res.status).toBe(303);
  const page = await get(cookie, target(res) ?? "");
  return { redirect: res, ...page };
}

describe("adding a single address", () => {
  it("claims it, mails its code and lands on its page saying so, with Continue on the table", async () => {
    const { owner, orgId } = await world();
    const smtp = stubSmtp2go();
    const address = `accounts-${tag()}@fynbos.example`;
    const { redirect: res, html } = await added(owner.cookie, orgId, address);
    expect(target(res)).toContain(`${pathOf(address)}?r=add-sent`);
    expect(text(html)).toContain(`A code was mailed to ${address}. It works for 30 minutes.`);
    expect(text(html)).toContain(`Prove you own ${address}`);
    expect((await claim(orgId, address))?.state).toBe("pending");
    expect(smtp.sends.at(-1)?.to).toBe(address);
    expect(codeIn(smtp.sends)).toMatch(/^\d{6}$/);
    // An organisation with only an address has no domain table of headers alone: it says there is no domain yet.
    const onlyAddress = (await get(owner.cookie, "/settings/domains")).html;
    expect(text(onlyAddress)).toContain("No domain yet.");
    expect(onlyAddress).not.toContain("How it was proved");
    // The Domains table offers Continue for the pending address, named for it.
    const list = (await get(owner.cookie, "/settings/domains")).html;
    expect(list).toContain(`aria-label="Continue verifying ${address}"`);
    expect(list).toContain(`href="${pathOf(address)}"`);
    // The control sits on the Addresses table, beside its heading, not in the page header.
    const sectionAt = list.indexOf('aria-labelledby="addresses-heading"');
    expect(sectionAt).toBeGreaterThan(-1);
    expect(list.indexOf('id="add-address"')).toBeGreaterThan(sectionAt);
    // The page names where the code went and when, and the code field is ready for it.
    expect(text(html)).toMatch(
      new RegExp(`Sent to ${address} at \\d{2}:\\d{2} SAST\\. It works until \\d{2}:\\d{2} SAST\\.`),
    );
    expect(html).toMatch(/<input[^>]*id="address-code"[^>]*autofocus/);
    // A look at where a slow request stands, without sending anything again, is offered on every form.
    expect(html).toContain(`data-busy-check="${pathOf(address)}"`);
    smtp.restore();
  });

  it("keeps the claim and says so when the send is uncertain or failed, and a fresh read still offers Continue and a new code", async () => {
    let answer: "silent" | "refused" | "sent" = "silent";
    const { owner, orgId } = await world();
    const smtp = stubSmtp2go(() => answer);
    const maybe = `maybe-${tag()}@fynbos.example`;
    const uncertain = await added(owner.cookie, orgId, maybe);
    expect(text(uncertain.html)).toContain(
      `The code may not have gone to ${maybe}. Check that inbox before sending another, because a new code replaces it.`,
    );
    expect(text(uncertain.html)).not.toContain("A code was mailed");
    expect((await claim(orgId, maybe))?.state).toBe("pending");
    answer = "refused";
    const failed = `failed-${tag()}@fynbos.example`;
    const lost = await added(owner.cookie, orgId, failed);
    expect(text(lost.html)).toContain(
      `The code could not be sent to ${failed}. The address is saved as pending: send a new code.`,
    );
    expect(text(lost.html)).not.toContain("A code was mailed");
    expect((await claim(orgId, failed))?.state).toBe("pending");
    // A fresh GET of the page and of the table: the pending claim is there with Continue and a way to send again.
    const fresh = (await get(owner.cookie, pathOf(failed))).html;
    expect(text(fresh)).toContain("Pending");
    expect(fresh).toContain('id="send-code"');
    const list = (await get(owner.cookie, "/settings/domains")).html;
    expect(list).toContain(`aria-label="Continue verifying ${failed}"`);
    // Recovery: a new code goes once the mail works again.
    answer = "sent";
    const resent = await form(owner.cookie, pathOf(failed), { action: "send", org: orgId });
    expect(text((await get(owner.cookie, target(resent) ?? "")).html)).toContain(`A code was mailed to ${failed}.`);
    smtp.restore();
  });

  it("says an address that is already verified is, without sending a code", async () => {
    const { owner, orgId } = await world();
    const smtp = stubSmtp2go();
    const address = `done-${tag()}@fynbos.example`;
    await db
      .prepare(
        `INSERT INTO org_addresses (id, org_id, address, state, verified_at, created_at) VALUES (?, ?, ?, 'verified', ?, ?)`,
      )
      .bind(`a-${tag()}`, orgId, address, new Date().toISOString(), new Date().toISOString())
      .run();
    const { html } = await added(owner.cookie, orgId, address);
    expect(text(html)).toContain(`${address} is already verified.`);
    expect(text(html)).toContain(`${address} is verified`);
    expect(smtp.sends).toHaveLength(0);
    smtp.restore();
  });

  it("refuses under the field with what was typed kept: not an address, taken by another organisation, too many waiting, the send limit", async () => {
    const { owner, orgId } = await world();
    const other = await person("Other");
    const otherOrg = await organisation(other, "Other Couriers");
    const crowd = await world();
    const smtp = stubSmtp2go();
    const refuse = async (typed: string) => {
      const res = await add(owner.cookie, orgId, typed);
      expect(res.status).toBeGreaterThanOrEqual(400);
      const html = await res.text();
      expect(html).toContain(`value="${typed}"`);
      expect(html).toContain('id="add-address-email-error"');
      expect(html).toMatch(/<input[^>]*id="add-address-email"[^>]*aria-invalid="true"/);
      return text(html);
    };
    expect(await refuse("not an address")).toContain("that is not an email address");
    // Taken: verified by another organisation.
    const taken = `taken-${tag()}@fynbos.example`;
    await db
      .prepare(
        `INSERT INTO org_addresses (id, org_id, address, state, verified_at, created_at) VALUES (?, ?, ?, 'verified', ?, ?)`,
      )
      .bind(`a-${tag()}`, otherOrg, taken, new Date().toISOString(), new Date().toISOString())
      .run();
    expect(await refuse(taken)).toContain("that address is verified by another organisation");
    expect(await claim(orgId, taken)).toBeNull();
    // The send limit for one address: five an hour, the sixth is refused with the claim kept.
    const limited = `limit-${tag()}@fynbos.example`;
    await added(owner.cookie, orgId, limited);
    for (let i = 0; i < 4; i++) {
      await db
        .prepare(`UPDATE verification_sends SET sent_at = ? WHERE org_id = ?`)
        .bind(new Date(Date.now() - 3 * 60_000 - i * 1000).toISOString(), orgId)
        .run();
      await form(owner.cookie, pathOf(limited), { action: "send", org: orgId });
    }
    const sixth = await add(owner.cookie, orgId, limited);
    expect(text(await sixth.text())).toContain("at most 5 codes an address an hour");
    // Too many waiting: twenty pending claims, the twenty-first refused.
    for (let i = 0; i < 20; i++) await add(crowd.owner.cookie, crowd.orgId, `p${i}-${tag()}@fynbos.example`);
    const over = await add(crowd.owner.cookie, crowd.orgId, `over-${tag()}@fynbos.example`);
    expect(text(await over.text())).toContain("at most 20 addresses can wait for verification");
    smtp.restore();
  });
});

describe("the address page", () => {
  it("draws a pending claim for an owner and an admin, and the same not-found for another organisation's address and a missing one", async () => {
    const { owner, orgId } = await world();
    const smtp = stubSmtp2go();
    const mine = `mine-${tag()}@fynbos.example`;
    await add(owner.cookie, orgId, mine);
    const admin = await person("Admin");
    await join(orgId, admin, "admin");
    for (const cookie of [owner.cookie, admin.cookie]) {
      const { res, html } = await get(cookie, pathOf(mine));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(text(html)).toContain(`Prove you own ${mine}`);
    }
    // Another organisation's claim, a verified address of another, and a missing one: the same not-found page.
    const other = await person("Other");
    const otherOrg = await organisation(other, "Other Couriers");
    const theirs = `theirs-${tag()}@fynbos.example`;
    await add(other.cookie, otherOrg, theirs);
    const seen = await get(owner.cookie, pathOf(theirs));
    const missing = await get(owner.cookie, pathOf(`missing-${tag()}@fynbos.example`));
    const strip = (h: string) =>
      text(h)
        .replace(/Reference [^ ]+/g, "")
        .replace(/[a-z0-9-]+@fynbos\.example/g, "ADDR");
    expect(seen.res.status).toBe(404);
    expect(missing.res.status).toBe(404);
    expect(strip(seen.html)).toBe(strip(missing.html));
    // A segment with no @ is no claim either.
    expect((await get(owner.cookie, "/settings/addresses/remove")).res.status).toBe(404);
    smtp.restore();
  });

  it("refuses a member with the role page, a post from another origin, and sends the signed out to sign-in", async () => {
    const { owner, orgId } = await world();
    const smtp = stubSmtp2go();
    const mine = `mine-${tag()}@fynbos.example`;
    await add(owner.cookie, orgId, mine);
    const clerk = await person("Clerk");
    await join(orgId, clerk, "member");
    const role = await get(clerk.cookie, pathOf(mine));
    expect(role.res.status).toBe(403);
    expect(text(role.html)).toContain("Only an owner or admin verifies addresses.");
    expect((await form(clerk.cookie, pathOf(mine), { action: "send", org: orgId })).status).toBe(403);
    const foreign = await form(owner.cookie, pathOf(mine), { action: "send", org: orgId }, "https://evil.example");
    expect(foreign.status).toBe(403);
    expect(smtp.sends).toHaveLength(1);
    const anon = await call(pathOf(mine), { headers: { accept: "text/html" } });
    expect(target(anon)).toBe(`/signin?next=${encodeURIComponent(pathOf(mine))}`);
    // A form drawn for another organisation changes nothing and says so.
    const switched = await form(owner.cookie, pathOf(mine), { action: "send", org: "org-elsewhere" });
    expect(text((await get(owner.cookie, target(switched) ?? "")).html)).toContain(
      "Your organisation changed in another tab, so nothing was done.",
    );
    expect(smtp.sends).toHaveLength(1);
    smtp.restore();
  });
});

describe("verifying by the code", () => {
  it("verifies with the code the sender captured: the stored claim, fresh reads of the page and the table, the sender lookup and the audit row", async () => {
    const { owner, orgId } = await world();
    const smtp = stubSmtp2go();
    const address = `proved-${tag()}@fynbos.example`;
    await add(owner.cookie, orgId, address);
    // Before: not recognised as a sender of this organisation.
    expect(await findMemberBySender(db, address)).toBeNull();
    const code = codeIn(smtp.sends);
    const res = await form(owner.cookie, pathOf(address), { action: "verify", org: orgId, code });
    expect(text((await get(owner.cookie, target(res) ?? "")).html)).toContain(`Done: ${address} is verified.`);
    // The stored claim, not a drawn state.
    const stored = await claim(orgId, address);
    expect(stored?.state).toBe("verified");
    expect(stored?.verified_at).not.toBeNull();
    // Fresh reads: the page and the Domains table.
    const fresh = (await get(owner.cookie, pathOf(address))).html;
    expect(text(fresh)).toContain(`${address} is verified`);
    expect(fresh).not.toContain('id="address-code"');
    const list = text((await get(owner.cookie, "/settings/domains")).html);
    expect(list).toContain(address);
    expect(list).toContain("Single address, confirmed by a code");
    // The sender lookup now recognises the address as this organisation's.
    expect(await findMemberBySender(db, address)).toBe(orgId);
    // The attempt is on the trail.
    const events = await db
      .prepare(`SELECT outcome FROM auth_events WHERE org_id = ? AND kind = 'verify-address'`)
      .bind(orgId)
      .all<{ outcome: string }>();
    expect(events.results.map((e) => e.outcome)).toEqual(["verified-code"]);
    smtp.restore();
  });

  it("refuses a wrong code with the tries left, locks at three, and refuses the right code during the lock, verifying nothing", async () => {
    const { owner, orgId } = await world();
    const smtp = stubSmtp2go();
    const address = `wrong-${tag()}@fynbos.example`;
    await add(owner.cookie, orgId, address);
    const right = codeIn(smtp.sends);
    const wrong = wrongOf(right);
    const guess = async (code: string) => {
      const res = await form(owner.cookie, pathOf(address), { action: "verify", org: orgId, code });
      return text((await get(owner.cookie, target(res) ?? "")).html);
    };
    expect(await guess(wrong)).toContain("That code is not right. 2 tries left before this is locked for an hour.");
    expect(await guess("12")).toContain("Type the 6 digits from the email.");
    expect(await guess(wrong)).toContain("1 try left");
    const locked = await guess(wrong);
    expect(locked).toContain("Code entry is locked until");
    const lockedPage = (await get(owner.cookie, pathOf(address))).html;
    expect(text(lockedPage)).toContain("Code entry is locked until");
    // The page reloads itself when the lock ends, and offers Check again without the script.
    expect(lockedPage).toMatch(/data-reload-at="\d+"/);
    expect(text(lockedPage)).toContain("Check again");
    // The right code is refused too while locked, and nothing is verified.
    await guess(right);
    expect((await claim(orgId, address))?.state).toBe("pending");
    smtp.restore();
  });

  it("holds Send a new code with its reason and time once the hour's codes are spent, frees it across the deadline, and a new code replaces the old", async () => {
    const { owner, orgId } = await world();
    const smtp = stubSmtp2go();
    const address = `resend-${tag()}@fynbos.example`;
    await add(owner.cookie, orgId, address);
    const first = codeIn(smtp.sends);
    // Five codes an hour for one address: the fifth is the last. Each earlier one is aged past the send window.
    const age = (minutes: number) =>
      db
        .prepare(`UPDATE verification_sends SET sent_at = ? WHERE org_id = ?`)
        .bind(new Date(Date.now() - minutes * 60_000).toISOString(), orgId)
        .run();
    for (let i = 0; i < 4; i++) {
      await age(3);
      await form(owner.cookie, pathOf(address), { action: "send", org: orgId });
    }
    expect(smtp.sends).toHaveLength(5);
    const held = (await get(owner.cookie, pathOf(address))).html;
    expect(held).toMatch(DISABLED_SEND);
    expect(held).toMatch(/id="send-code-reason"[^>]*>\s*The next code can go at \d{2}:\d{2} SAST\./);
    // The open page frees it at its time (the script's hold), and offers the plain look again without the script.
    expect(held).toMatch(/<button[^>]*data-retry-at="\d+"/);
    expect(held).toContain('data-ready-clear="send-code-reason"');
    expect(held).toContain("Check again");
    // A press anyway (a stale page, or the control freed by script) is refused with the time, and sends nothing.
    const refused = await form(owner.cookie, pathOf(address), { action: "send", org: orgId });
    expect(text((await get(owner.cookie, target(refused) ?? "")).html)).toContain(
      "Five codes an hour can go to one address.",
    );
    expect(smtp.sends).toHaveLength(5);
    // Across the deadline: the hour has passed, the control is free and a new code goes.
    await age(61);
    const freed = (await get(owner.cookie, pathOf(address))).html;
    expect(freed).not.toMatch(DISABLED_SEND);
    expect(freed).not.toContain("send-code-reason");
    const before = codeIn(smtp.sends);
    await form(owner.cookie, pathOf(address), { action: "send", org: orgId });
    expect(smtp.sends).toHaveLength(6);
    const second = codeIn(smtp.sends);
    expect(second).not.toBe(before);
    // Only the newest code verifies: an earlier one is refused.
    const old = await form(owner.cookie, pathOf(address), {
      action: "verify",
      org: orgId,
      code: first === second ? before : first,
    });
    expect(text((await get(owner.cookie, target(old) ?? "")).html)).toContain("That code is not right.");
    const fresh = await form(owner.cookie, pathOf(address), { action: "verify", org: orgId, code: second });
    expect(text((await get(owner.cookie, target(fresh) ?? "")).html)).toContain(`Done: ${address} is verified.`);
    smtp.restore();
  });

  it("says expired, no code waiting and a lock that has ended, each with its next step, and never verifies", async () => {
    const { owner, orgId } = await world();
    const smtp = stubSmtp2go();
    const address = `states-${tag()}@fynbos.example`;
    await add(owner.cookie, orgId, address);
    const code = codeIn(smtp.sends);
    // Expired.
    await db
      .prepare(`UPDATE verification_codes SET expires_at = ? WHERE org_id = ?`)
      .bind(new Date(Date.now() - 1000).toISOString(), orgId)
      .run();
    const expired = text((await get(owner.cookie, pathOf(address))).html);
    expect(expired).toContain("The code we sent has expired. Send a new one.");
    // No code waiting: none was ever issued for a fresh claim.
    await db.prepare(`DELETE FROM verification_codes WHERE org_id = ?`).bind(orgId).run();
    expect(text((await get(owner.cookie, pathOf(address))).html)).toContain("No code is waiting. Send one.");
    const none = await form(owner.cookie, pathOf(address), { action: "verify", org: orgId, code });
    expect(text((await get(owner.cookie, target(none) ?? "")).html)).toContain("No code is waiting.");
    // A lock that has ended: the forms are back, and a new code goes and verifies.
    await db
      .prepare(`UPDATE verification_sends SET sent_at = ? WHERE org_id = ?`)
      .bind(new Date(Date.now() - 3 * 60_000).toISOString(), orgId)
      .run();
    await form(owner.cookie, pathOf(address), { action: "send", org: orgId });
    const fresh = codeIn(smtp.sends);
    for (let i = 0; i < 3; i++)
      await form(owner.cookie, pathOf(address), { action: "verify", org: orgId, code: wrongOf(fresh) });
    expect(text((await get(owner.cookie, pathOf(address))).html)).toContain("Code entry is locked until");
    await db
      .prepare(`UPDATE verification_codes SET locked_until = ?, expires_at = ? WHERE org_id = ?`)
      .bind(new Date(Date.now() - 1000).toISOString(), new Date(Date.now() - 1000).toISOString(), orgId)
      .run();
    await db
      .prepare(`UPDATE verification_sends SET sent_at = ? WHERE org_id = ?`)
      .bind(new Date(Date.now() - 3 * 60_000).toISOString(), orgId)
      .run();
    const after = (await get(owner.cookie, pathOf(address))).html;
    expect(after).toContain('id="send-code"');
    await form(owner.cookie, pathOf(address), { action: "send", org: orgId });
    const renewed = codeIn(smtp.sends);
    const done = await form(owner.cookie, pathOf(address), { action: "verify", org: orgId, code: renewed });
    expect(text((await get(owner.cookie, target(done) ?? "")).html)).toContain(`Done: ${address} is verified.`);
    smtp.restore();
  });

  it("says another organisation took the address meanwhile, and keeps the claim unverified", async () => {
    const mine = await world();
    const rival = await world();
    const smtp = stubSmtp2go();
    const address = `race-${tag()}@fynbos.example`;
    await add(mine.owner.cookie, mine.orgId, address);
    const code = codeIn(smtp.sends);
    await add(rival.owner.cookie, rival.orgId, address);
    const rivalCode = codeIn(smtp.sends);
    // The rival proves it first.
    await form(rival.owner.cookie, pathOf(address), { action: "verify", org: rival.orgId, code: rivalCode });
    expect((await claim(rival.orgId, address))?.state).toBe("verified");
    const lost = await form(mine.owner.cookie, pathOf(address), { action: "verify", org: mine.orgId, code });
    const said = text((await get(mine.owner.cookie, target(lost) ?? "")).html);
    expect(said).toContain(`${address} was verified by another organisation, so this claim cannot be verified.`);
    expect(said).not.toContain("is verified.");
    expect((await claim(mine.orgId, address))?.state).toBe("pending");
    expect(await findMemberBySender(db, address)).toBe(rival.orgId);
    smtp.restore();
  });

  it("never says verified on a signed outcome that the stored claim contradicts, and ignores an outcome signed for another address", async () => {
    const { owner, orgId } = await world();
    const smtp = stubSmtp2go();
    const address = `signed-${tag()}@fynbos.example`;
    await add(owner.cookie, orgId, address);
    const secret = authEnv.BETTER_AUTH_SECRET as string;
    // A result of "verified" signed for this organisation and address, while the claim is still pending.
    const forged = await toAddressPage(secret, orgId, address, { r: "verify-verified" });
    const said = text((await get(owner.cookie, target(forged) ?? "")).html);
    expect(said).not.toContain("is verified");
    expect(said).toContain("Pending");
    // The same result signed for another address is not this page's: it is ignored.
    const other = `other-${tag()}@fynbos.example`;
    const wrongAddress = await toAddressPage(secret, orgId, other, { r: "send-sent" });
    const moved = (target(wrongAddress) ?? "").replace(pathOf(other), pathOf(address));
    expect(text((await get(owner.cookie, moved)).html)).not.toContain("A code was mailed");
    // A tampered signature is ignored too.
    const tampered = (target(forged) ?? "").replace(/s=[^&]+/, "s=AAAA");
    expect(text((await get(owner.cookie, tampered)).html)).not.toContain("Done:");
    smtp.restore();
  });

  it("answers a claim removed meanwhile with the not-found, and an unreadable store as the retryable outage, never a verification", async () => {
    const { owner, orgId } = await world();
    const smtp = stubSmtp2go();
    const address = `gone-${tag()}@fynbos.example`;
    await add(owner.cookie, orgId, address);
    const code = codeIn(smtp.sends);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("FROM org_addresses WHERE org_id = ? AND address = ?")) throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    const down = await get(owner.cookie, pathOf(address));
    vi.restoreAllMocks();
    expect(down.res.status).toBe(503);
    expect(text(down.html)).not.toContain("is verified");
    // Removed meanwhile: a verify answers by sending to the page, which is the not-found.
    await db.prepare(`DELETE FROM org_addresses WHERE org_id = ? AND address = ?`).bind(orgId, address).run();
    const gone = await form(owner.cookie, pathOf(address), { action: "verify", org: orgId, code });
    expect((await get(owner.cookie, target(gone) ?? "")).res.status).toBe(404);
    smtp.restore();
  });
});
