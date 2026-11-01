import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth, SIGNIN_FROM } from "../../src/auth/auth";
import { CLAIM_FROM, sendClaimCode } from "../../src/auth/claim-mail";
import { MAGIC_LINK_SECONDS } from "../../src/auth/schema";
import { CODE_COOKIE } from "../../src/auth/signin-code";
import { SMTP2GO_URL } from "../../src/mail/smtp2go";
import { claimCodeEmail, inviteEmail, signinEmail, trialNoticeEmail } from "../../src/mail/templates/auth-mail";
import { authEnv, call, requestLink, signIn, target } from "../auth/helpers";

// The sign-in, invitation and verification-code emails (D07 T08 §6; N2 to N4): both parts complete, every outside value
// escaped, the link the first URL of the text, the code in both parts, the expiries from their owners, each sent from the
// right address through the real senders, and the layout lint.
const db = (env as unknown as Env).DB;
afterEach(() => vi.restoreAllMocks());

type Payload = { sender: string; to: string[]; subject: string; text_body: string; html_body?: string };
function capture() {
  const sent: Payload[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== SMTP2GO_URL) return real(input, init);
    sent.push(JSON.parse(String(init?.body ?? "{}")) as Payload);
    return Response.json({ data: { succeeded: 1, failed: 0, email_id: `email-${sent.length}` } });
  });
  return sent;
}
const tag = () => crypto.randomUUID().slice(0, 8);
const firstUrl = (text: string) => /https?:\/\/\S+/.exec(text)?.[0] ?? "";
const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

// The layout rules the reply email keeps: tables for layout, no flex, grid, position or float, an `alt` on every image,
// no script, form or tracking pixel.
function emailLint(html: string): string[] {
  const problems: string[] = [];
  for (const m of html.matchAll(/(display\s*:\s*(flex|grid)|position\s*:|float\s*:)/gi)) problems.push(m[0]);
  for (const m of html.matchAll(/<img\b[^>]*>/gi))
    if (!/\balt=/.test(m[0])) problems.push(`image without alt: ${m[0]}`);
  for (const m of html.matchAll(/<(script|form|iframe|link)\b/gi)) problems.push(`forbidden element: ${m[0]}`);
  for (const m of html.matchAll(/<img\b[^>]*\bwidth="1"[^>]*>/gi)) problems.push(`tracking pixel: ${m[0]}`);
  return problems;
}

const APP = "https://app.isitlegit.co.za";
const HOSTILE = `<script>alert("x")</script> & "O'Brien"`;

describe("the templates", () => {
  const at = new Date("2026-10-27T07:14:00.000Z"); // 09:14 SAST

  it("says the sign-in link, its code in both parts, and its expiry from the lifetime it is given", () => {
    const mail = signinEmail({
      appUrl: APP,
      email: `a${HOSTILE}@example.com`,
      link: `${APP}/auth/confirm?token=a&b=2`,
      code: "482 917",
      lifetimeSeconds: MAGIC_LINK_SECONDS,
      requestedAt: at,
    });
    expect(firstUrl(mail.text)).toBe(`${APP}/auth/confirm?token=a&b=2`);
    expect(mail.text).toContain("482 917");
    expect(plain(mail.html)).toContain("482 917");
    for (const part of [mail.text, plain(mail.html)]) {
      expect(part).toContain("Expires in 15 minutes, at 09:29 SAST. Requested at 09:14 SAST.");
      expect(part).toContain("never pass either on");
      expect(part).toContain("we never ask for a password or for the code");
      expect(part).toContain("We never ask for passwords, PINs or bank details by email.");
    }
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).toContain(`href="${APP}/auth/confirm?token=a&amp;b=2"`);
    expect(mail.html).toContain(`src="${APP}/static/brand/email/logo.`);
    expect(emailLint(mail.html)).toEqual([]);
  });

  it("says the invitation with who sent it and for what, the 48-hour expiry in SAST, and escapes every name", () => {
    const mail = inviteEmail({
      appUrl: APP,
      inviter: HOSTILE,
      organisation: `Karoo ${HOSTILE}`,
      role: "admin",
      link: `${APP}/invite/inv_3Jd82kQp`,
      expiresAt: new Date("2026-10-29T08:02:00.000Z"),
      lifetimeSeconds: 48 * 3600,
    });
    expect(firstUrl(mail.text)).toBe(`${APP}/invite/inv_3Jd82kQp`);
    // A name that is itself a URL never comes before the real link.
    const urlName = inviteEmail({
      appUrl: APP,
      inviter: "https://help.example/pay",
      organisation: "http://evil.example",
      role: "member",
      link: `${APP}/invite/inv_x`,
      expiresAt: new Date("2026-10-29T08:02:00.000Z"),
      lifetimeSeconds: 48 * 3600,
    });
    expect(firstUrl(urlName.text)).toBe(`${APP}/invite/inv_x`);
    for (const part of [mail.text, plain(mail.html)]) {
      expect(part).toContain("Expires in 48 hours, on Thu 29 Oct 2026 at 10:02 SAST.");
      expect(part).toContain("As an admin you can forward anything you are unsure of to check@isitlegit.co.za");
    }
    expect(mail.html).not.toContain("<script>");
    expect(emailLint(mail.html)).toEqual([]);
  });

  it("says the code for a domain and for an address, each with the right reason, the digits whole in the text", () => {
    for (const kind of ["domain", "address"] as const) {
      const what = kind === "domain" ? `karoo${HOSTILE}.example` : "owner.personal@gmail.com";
      const mail = claimCodeEmail({
        appUrl: APP,
        kind,
        what,
        code: "482917",
        lifetimeSeconds: 1800,
        expiresAt: new Date(at.getTime() + 1800_000),
      });
      expect(mail.text).toContain("\n\n482917\n\n");
      expect(plain(mail.html)).toContain("482 917");
      for (const part of [mail.text, plain(mail.html)]) {
        expect(part).toContain(
          "Expires in 30 minutes, at 09:44 SAST. Three wrong tries lock verification for an hour.",
        );
        expect(part).toContain(kind === "domain" ? "admin@ or postmaster@" : "Only the address itself");
        expect(part).toContain("There is nothing to click in this email.");
      }
      expect(mail.html).not.toContain("<script>");
      expect(emailLint(mail.html)).toEqual([]);
    }
  });

  it("lints the trial notice's layout too", () => {
    for (const kind of ["ending", "ended"] as const) {
      const mail = trialNoticeEmail({
        appUrl: APP,
        kind,
        organisation: HOSTILE,
        endsAt: new Date("2026-11-13T08:00:00.000Z"),
        link: `${APP}/settings/plan`,
        freePerDay: 5,
      });
      expect(emailLint(mail.html)).toEqual([]);
      expect(firstUrl(mail.text)).toBe(`${APP}/settings/plan`);
    }
  });

  it("lints: passes the layout, fails a planted flex, grid and an image without alt", () => {
    const good = signinEmail({
      appUrl: APP,
      email: "a@b.example",
      link: `${APP}/x`,
      code: "111 222",
      lifetimeSeconds: 900,
      requestedAt: at,
    }).html;
    expect(emailLint(good)).toEqual([]);
    expect(emailLint(good.replace("display: block", "display:grid")).length).toBeGreaterThan(0);
    expect(emailLint(good.replace("display: block", "display:flex")).length).toBeGreaterThan(0);
    expect(emailLint(good.replace('alt="IsItLegit"', "")).length).toBeGreaterThan(0);
    expect(emailLint(`${good}<img src="https://t.example/p.gif" width="1" height="1" alt="">`).length).toBeGreaterThan(
      0,
    );
  });
});

describe("through the real senders", () => {
  it("sends the sign-in link from the sign-in sender with both parts, and the code in the HTML signs in the asking browser", async () => {
    const sent = capture();
    const email = `mail-${tag()}@demo.isitlegit.co.za`;
    const asked = await requestLink(email, "/cases");
    expect(asked.status).toBe(200);
    expect(sent).toHaveLength(1);
    const mail = sent[0] as Payload;
    expect(mail.sender).toBe(SIGNIN_FROM);
    expect(mail.subject).toBe("Your IsItLegit sign-in link");
    expect(mail.html_body).toBeTruthy();
    const textCode = /\n\n(\d{3}) (\d{3})\n\n/.exec(mail.text_body)?.slice(1).join("") ?? "";
    const htmlCode =
      /letter-spacing: 0\.12em[^>]*>(\d{3}) (\d{3})</
        .exec(mail.html_body ?? "")
        ?.slice(1)
        .join("") ?? "";
    expect(textCode).toMatch(/^\d{6}$/);
    expect(htmlCode).toBe(textCode);
    const handle = /(?:^|,\s*)?${CODE_COOKIE}=([^;]+)/.exec(asked.headers.getSetCookie().join("\n"))?.[1];
    const cookie = asked.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(cookie).toContain(`${CODE_COOKIE}=`);
    expect(handle === undefined || handle.length > 0).toBe(true);
    const signedIn = await call("/signin/code", {
      method: "POST",
      body: new URLSearchParams({ code: htmlCode, email, callbackURL: "/cases" }),
      headers: { cookie },
    });
    expect(signedIn.status).toBe(303);
    expect(target(signedIn)).toBe("/cases");
  });

  it("sends the invitation from the sign-in sender with the inviter, organisation and role the invitation holds", async () => {
    const owner = `owner-${tag()}@demo.isitlegit.co.za`;
    const { cookie } = await signIn(owner);
    const ownerId = (
      await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(owner).first<{ id: string }>()
    )?.id as string;
    await db.prepare(`UPDATE "user" SET name = ? WHERE id = ?`).bind("Thandi Nkosi", ownerId).run();
    const org = (await createAuth(authEnv).api.createOrganization({
      body: { name: "Karoo Couriers", slug: `karoo-${tag()}`, userId: ownerId },
    })) as { id: string };
    await db.prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`).bind(org.id, ownerId).run();
    const sent = capture();
    const invitee = `inv-${tag()}@example.com`;
    const res = await call("/api/auth/organization/invite-member", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: invitee, role: "admin" }),
    });
    expect(res.status).toBe(200);
    const mail = sent.at(-1) as Payload;
    expect(mail.sender).toBe(SIGNIN_FROM);
    expect(mail.to).toEqual([invitee]);
    expect(mail.subject).toBe("You are invited to Karoo Couriers on IsItLegit");
    expect(mail.text_body).toContain("Thandi Nkosi invited you to Karoo Couriers on IsItLegit");
    expect(mail.text_body).toContain("As an admin");
    expect(plain(mail.html_body ?? "")).toContain("Accept the invitation");
    expect(firstUrl(mail.text_body)).toMatch(/\/invite\/[A-Za-z0-9_-]+$/);
    expect(emailLint(mail.html_body ?? "")).toEqual([]);
    // A resent invitation keeps its first creation time but is open for a new 48 hours: the mail says so.
    await db
      .prepare(`UPDATE "invitation" SET "createdAt" = ? WHERE email = ?`)
      .bind(new Date(Date.now() - 24 * 3_600_000).toISOString(), invitee)
      .run();
    const again = await call("/api/auth/organization/invite-member", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: invitee, role: "admin", resend: true }),
    });
    expect(again.status).toBe(200);
    expect((sent.at(-1) as Payload).text_body).toContain("Expires in 48 hours, on ");
    // The deadline and the length it states are the stored invitation's own.
    const stored = await db
      .prepare(
        `SELECT "expiresAt" AS e, "createdAt" AS c FROM "invitation" WHERE email = ? ORDER BY "createdAt" DESC LIMIT 1`,
      )
      .bind(invitee)
      .first<{ e: string | number; c: string | number }>();
    expect(stored?.c).toBeDefined();
    const clock = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Johannesburg",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(stored?.e ?? 0));
    expect((sent.at(-1) as Payload).text_body).toContain(`at ${clock} SAST.`);
  });

  it("sends a verification code from verify@ for a domain and for an address, each worded for what it proves", async () => {
    // A pending claim is what makes a recipient allowed for a code (src/mail/allowlist.ts).
    const owner = `claimer-${tag()}@demo.isitlegit.co.za`;
    await signIn(owner);
    const ownerId = (
      await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(owner).first<{ id: string }>()
    )?.id as string;
    const org = (await createAuth(authEnv).api.createOrganization({
      body: { name: "Claim Co", slug: `claim-${tag()}`, userId: ownerId },
    })) as { id: string };
    const domain = `karoo-${tag()}.example`;
    const address = `owner.${tag()}@gmail.com`;
    await db
      .prepare(
        "INSERT INTO org_domains (id, org_id, domain, token, state, created_at) VALUES (?, ?, ?, 'tttttttttttttttt', 'pending', ?)",
      )
      .bind(`d-${tag()}`, org.id, domain, new Date().toISOString())
      .run();
    await db
      .prepare("INSERT INTO org_addresses (id, org_id, address, state, created_at) VALUES (?, ?, ?, 'pending', ?)")
      .bind(`a-${tag()}`, org.id, address, new Date().toISOString())
      .run();
    const sent = capture();
    for (const [kind, what] of [
      ["domain", domain],
      ["address", address],
    ] as const) {
      const outcome = await sendClaimCode(authEnv, {
        to: kind === "domain" ? `admin@${domain}` : what,
        claimId: `claim-${tag()}`,
        codeId: `code-${tag()}`,
        code: "482917",
        what,
        kind,
        lifetimeMs: 30 * 60_000,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      });
      expect(outcome).toBe("sent");
      const mail = sent.at(-1) as Payload;
      expect(mail.sender).toBe(CLAIM_FROM);
      expect(mail.subject).toBe("Your IsItLegit verification code");
      expect(mail.text_body).toContain("\n\n482917\n\n");
      expect(mail.html_body).toBeTruthy();
      expect(mail.text_body).toContain(kind === "domain" ? "admin@ or postmaster@" : "Only the address itself");
    }
  });
});
