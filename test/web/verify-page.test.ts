import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { setPlan } from "../../src/auth/plans";
import { addAccount, bankKeys } from "../../src/trust/bank";
import { setIdentity } from "../../src/trust/identity";
import { publicSlug } from "../../src/trust/public-slug";
import { authEnv, call } from "../auth/helpers";
import { protectableOrg } from "../trust/helpers";

// The verify page (D05 T02 §6): a protected business's name, verified domains, dates and the forward-as-attachment
// steps; nothing private; the grey Not verified state with 404 for a business not protected now (switched off, a
// prerequisite lost, the plan lapsed), back to protected once restored; the site's 404 for an unknown address, never
// repeating it; and the error page with 503 for a failed read, saying neither.
const db = env.DB;
let n = 0;
async function business(name = "Fynbos Freight (Pty) Ltd") {
  const tag = `${++n}${crypto.randomUUID().slice(0, 6)}`;
  const domain = `vp${tag}.example`;
  const contact = `accounts@${domain}`;
  const orgId = await protectableOrg(domain, contact, name);
  await setIdentity(db, orgId, "owner", {
    displayNames: [name, "FF Express"],
    financeContact: contact,
    protected: true,
  });
  const slug = (await publicSlug(db, orgId)).slug as string;
  return { orgId, domain, contact, slug };
}
const page = async (slug: string) => {
  const res = await call(`/v/${slug}`, { headers: { accept: "text/html" } }, authEnv);
  return { status: res.status, html: (await res.text()).replace(/&#39;/g, "'").replace(/&amp;/g, "&") };
};

describe("a protected business", () => {
  it("shows the name, the verified domains, the dates and the steps, with the verify page's own header", async () => {
    const b = await business();
    const { status, html } = await page(b.slug);
    expect(status).toBe(200);
    expect(html).toContain("Protected by IsItLegit");
    expect(html).toContain(">Fynbos Freight (Pty) Ltd<");
    expect(html).toContain(b.domain);
    expect(html).toContain("Fynbos Freight (Pty) Ltd only sends email from");
    expect(html).toMatch(
      /Identity verified by IsItLegit on [A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} 20\d\d · checked again as this page opened/,
    );
    expect(html).toContain("as an attachment</strong> to <code");
    for (const where of [
      "Outlook on a computer",
      "Gmail on a computer",
      "Outlook app on a phone",
      "Gmail app on a phone",
    ])
      expect(html, where).toContain(where);
    // Each way to forward is at most three actions (D05 T02 §1's completion review, gap 5).
    for (const steps of [
      "Select the email, then More actions, Forward as attachment.",
      "Open the email, then More, Forward as attachment.",
      "Open the email, tap the three dots, then Forward as attachment.",
    ]) {
      expect(html).toContain(steps);
      expect(steps.replace(/\.$/, "").split(/, then |, /), steps).toHaveLength(3);
    }
    expect(html).toContain(
      "The Gmail app cannot forward as an attachment. Forward it from Gmail on a computer instead.",
    );
    expect(html).toContain('data-copy="check@isitlegit.co.za"');
    expect(html).toContain("No reply never means the email is genuine.");
    expect(html).toContain("You are on isitlegit.co.za");
    expect(html).not.toContain("link valid for 7 days");
    expect(html).toContain('href="https://isitlegit.co.za/protect"');
  });

  it("never shows bank details, the finance contact, addresses or the trading names", async () => {
    const b = await business();
    const keys = await bankKeys(env);
    await addAccount(db, keys, b.orgId, "owner", {
      number: "62004417731",
      branchCode: "250655",
      bankName: "Kestrel Bank (fictional)",
      holder: "Fynbos Freight (Pty) Ltd",
    });
    const { html } = await page(b.slug);
    for (const secret of [b.contact, "62004417731", "731", "250655", "Kestrel Bank", "FF Express", "accounts@"])
      expect(html, secret).not.toContain(secret);
  });
});

describe("a business not protected now", () => {
  it("answers Not verified with 404 when protection is switched off, a prerequisite lost or the plan lapsed, and recovers", async () => {
    const b = await business("Outeniqua Paper");
    const notVerified = async (why: string) => {
      const { status, html } = await page(b.slug);
      expect(status, why).toBe(404);
      expect(html, why).toContain("Not verified");
      expect(html, why).toContain("Outeniqua Paper is not protected right now");
      expect(html, why).toContain("Sign in to renew your protection");
      expect(html, why).not.toContain("Protected by IsItLegit");
      expect(html, why).not.toContain("In about a minute you get a reply");
    };
    const protectedNow = async (why: string) => expect((await page(b.slug)).status, why).toBe(200);
    await setIdentity(db, b.orgId, "owner", {
      displayNames: ["Outeniqua Paper"],
      financeContact: b.contact,
      protected: false,
    });
    await notVerified("switched off");
    await setIdentity(db, b.orgId, "owner", {
      displayNames: ["Outeniqua Paper"],
      financeContact: b.contact,
      protected: true,
    });
    await protectedNow("switched back on");
    await db.prepare("UPDATE org_domains SET state = 'pending' WHERE org_id = ?").bind(b.orgId).run();
    await notVerified("last verified domain lost");
    await db.prepare("UPDATE org_domains SET state = 'verified' WHERE org_id = ?").bind(b.orgId).run();
    await protectedNow("domain verified again");
    await db.prepare("UPDATE org_addresses SET state = 'pending' WHERE org_id = ?").bind(b.orgId).run();
    await notVerified("finance contact no longer verified");
    await db.prepare("UPDATE org_addresses SET state = 'verified' WHERE org_id = ?").bind(b.orgId).run();
    await protectedNow("contact verified again");
    await setPlan(db, b.orgId, "free");
    await notVerified("plan without identity");
    await setPlan(db, b.orgId, "protect");
    await protectedNow("plan restored");
  });

  it("answers an unknown address with the site's 404, never repeating it", async () => {
    const { status, html } = await page("totally-unknown-business");
    expect(status).toBe(404);
    expect(html).toContain("This business is not protected by IsItLegit.");
    expect(html).not.toContain("totally-unknown-business");
    expect((await page("Not A Slug!!")).status).toBe(404);
  });
});

describe("a failed read", () => {
  it("answers the error page with a retry and 503, saying neither protected nor not verified", async () => {
    const b = await business("Sunbird Paper");
    await db.prepare("ALTER TABLE org_domains RENAME TO org_domains_away").run();
    try {
      const { status, html } = await page(b.slug);
      expect(status).toBe(503);
      expect(html).toContain("We could not check this business just now.");
      expect(html).toContain(`href="/v/${b.slug}"`);
      expect(html).not.toContain("Protected by IsItLegit");
      expect(html).not.toContain("Not verified");
    } finally {
      await db.prepare("ALTER TABLE org_domains_away RENAME TO org_domains").run();
    }
  });
});
