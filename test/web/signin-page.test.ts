import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { CODE_COOKIE } from "../../src/auth/signin-code";
import { call, signIn, stubSmtp2go, target } from "../auth/helpers";

// The sign-in page (D07 T02 §7): `/signin` on A1's frame, `next` normalised once and carried by every way out, the
// failed-link state with the return path kept, and a sign-in by link or by code landing on the Cases list with a
// session the gate reads.
const db = (env as unknown as Env).DB;
let restore = () => {};
afterEach(() => restore());
const mailed = () => {
  const smtp = stubSmtp2go();
  restore = smtp.restore;
  return smtp;
};
const unique = (who: string) => `${who}-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;

// A browser: its cookies kept from every answer and sent with every request; an address of its own for the limits.
let nextIp = 1;
function browser(ip = `203.0.${Math.floor(nextIp / 250)}.${(nextIp++ % 250) + 1}`) {
  const cookies = new Map<string, string>();
  const keep = (answer: Response) => {
    for (const cookie of answer.headers.getSetCookie()) {
      const [pair = "", ...attributes] = cookie.split(";");
      const [name = "", ...value] = pair.trim().split("=");
      if (attributes.some((a) => /^\s*max-age=0\s*$/i.test(a))) cookies.delete(name);
      else cookies.set(name, value.join("="));
    }
    return answer;
  };
  const headers = (extra: Record<string, string> = {}) => ({
    ...extra,
    accept: "text/html",
    "cf-connecting-ip": ip,
    ...(cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
  });
  return {
    cookies,
    get: async (path: string) => keep(await call(path, { headers: headers() })),
    post: async (path: string, fields: Record<string, string>) =>
      keep(await call(path, { method: "POST", body: new URLSearchParams(fields), headers: headers() })),
  };
}
const field = (html: string, name: string) =>
  (new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "").replace(/&amp;/g, "&");
const codeIn = (text: string) => /\n\n(\d{3}) (\d{3})\n\n/.exec(text)?.slice(1).join("") ?? "";
const linkIn = (text: string) => /https?:\/\/\S+/.exec(text)?.[0] ?? "";

// A member of an organisation, signed up once so the address can sign in again.
async function member() {
  const email = unique("signin");
  await signIn(email);
  const orgId = `org-signin-${crypto.randomUUID().slice(0, 8)}`;
  await db
    .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, 'Karoo Couriers', ?, ?)`)
    .bind(orgId, orgId, new Date().toISOString())
    .run();
  const user = await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>();
  await db
    .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, 'owner', ?)`)
    .bind(`m-${crypto.randomUUID()}`, orgId, user?.id, new Date().toISOString())
    .run();
  return email;
}

describe("the sign-in page", () => {
  it("draws A1's frame and form, each control by its name, with the return path ready", async () => {
    const res = await browser().get("/signin");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("Every suspicious email, investigated. Every reason, cited.");
    expect(html).toContain("IsItLegit by Rizonetech · George, South Africa");
    expect(html).toMatch(/<h1[^>]*>Sign in<\/h1>/);
    expect(html).toMatch(/<label[^>]*for="signin-email"[^>]*>Work email<\/label>/);
    expect(html).toContain('<form method="post" action="/signin/link"');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Email me a sign-in link<\/button>/);
    expect(html).toMatch(/<a href="\/signup"[^>]*>Create an account<\/a>/);
    expect(field(html, "callbackURL")).toBe("/cases");
    // The logo goes home, by its name, on both layouts.
    expect(html.match(/<a href="https:\/\/isitlegit.co.za"[^>]*><img[^>]*alt="IsItLegit home"/g)).toHaveLength(2);
  });

  it("keeps a requested fragment (a report's evidence anchor) through a sign-in by code", async () => {
    const email = await member();
    const smtp = mailed();
    const b = browser();
    await b.post("/signin/link", { email, callbackURL: "/cases/42#e1" });
    const landed = await b.post("/signin/code", {
      email,
      code: codeIn(smtp.sends.at(-1)?.text ?? ""),
      callbackURL: "/cases/42#e1",
    });
    expect(landed.status).toBe(303);
    expect(landed.headers.get("location")).toMatch(/\/cases\/42#e1$/);
  });

  it("normalises next once: anything off this site is the default, a path here is kept whole", async () => {
    for (const hostile of [
      "https://attacker.example",
      "//attacker.example",
      "/\\attacker.example",
      "/%2F%2Fattacker.example",
      "/../..//attacker.example",
    ]) {
      const html = await (await browser().get(`/signin?next=${encodeURIComponent(hostile)}`)).text();
      expect(field(html, "callbackURL"), hostile).toBe("/cases");
      expect(html, hostile).not.toContain("attacker.example");
    }
    const kept = await (await browser().get(`/signin?next=${encodeURIComponent("/cases/42?tab=evidence")}`)).text();
    expect(field(kept, "callbackURL")).toBe("/cases/42?tab=evidence");
    // An encoded slash in the query (a report link's signature may hold one) is no way off the site, and is kept.
    const report = "/r/01J0000000000000000000000A?o=org&e=1&s=ab%2Fcd";
    expect(field(await (await browser().get(`/signin?next=${encodeURIComponent(report)}`)).text(), "callbackURL")).toBe(
      report,
    );
  });

  it("says why a link failed, keeps the return path for the new one, and never shows a raw code", async () => {
    const email = await member();
    const smtp = mailed();
    const b = browser();
    const html = await (await b.get("/signin?next=%2Fcases%2F42&error=INVALID_TOKEN")).text();
    expect(html).toMatch(/<h1[^>]*>That link no longer works<\/h1>/);
    expect(html).toMatch(/role="alert"/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Email me a new link<\/button>/);
    expect(field(html, "callbackURL")).toBe("/cases/42");
    // A new link from it returns to the same page.
    await b.post("/signin/link", { email, callbackURL: field(html, "callbackURL") });
    expect(new URL(linkIn(smtp.sends.at(-1)?.text ?? "")).searchParams.get("callbackURL")).toBe("/cases/42");
    for (const code of ["WEIRD_%3Cscript%3E", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const odd = await (await b.get(`/signin?error=${code}`)).text();
      expect(odd, code).toContain("This sign-in link did not work.");
      expect(odd, code).not.toContain("WEIRD");
    }
  });

  it("gives a fresh browser its code handle when it is served, so links asked at once share it", async () => {
    const b = browser();
    await b.get("/signin");
    const handle = b.cookies.get(CODE_COOKIE);
    expect(handle).toBeTruthy();
    const [one, two] = [await member(), await member()];
    const smtp = mailed();
    await Promise.all([
      b.post("/signin/link", { email: one, callbackURL: "/cases" }),
      b.post("/signin/link", { email: two, callbackURL: "/cases" }),
    ]);
    expect(b.cookies.get(CODE_COOKIE)).toBe(handle);
    // Both codes work in this browser: the last one signs in.
    const code = codeIn(smtp.sends.find((s) => s.to === two)?.text ?? "");
    const done = await b.post("/signin/code", { email: two, code, callbackURL: "/cases" });
    expect(done.status).toBe(303);
  });

  for (const how of ["link", "code"] as const)
    it(`lands a sign-in by ${how} with no next on the Cases list, signed in`, async () => {
      const email = await member();
      const smtp = mailed();
      const b = browser();
      const page = await (await b.get("/signin")).text();
      const asked = await b.post("/signin/link", { email, callbackURL: field(page, "callbackURL") });
      expect(asked.status).toBe(200);
      const mail = smtp.sends.at(-1)?.text ?? "";
      let landed: Response;
      if (how === "link") {
        const confirm = await b.get(new URL(linkIn(mail)).pathname + new URL(linkIn(mail)).search);
        const html = await confirm.text();
        landed = await b.post("/signin/confirm", {
          token: field(html, "token"),
          callbackURL: field(html, "callbackURL"),
        });
      } else {
        landed = await b.post("/signin/code", { email, code: codeIn(mail), callbackURL: "/cases" });
      }
      expect(landed.status).toBe(303);
      expect(landed.headers.get("location")).toMatch(/\/cases$/);
      expect(landed.headers.getSetCookie().some((c) => c.startsWith("isitlegit_signed_in=1;"))).toBe(true);
      expect(target(landed)).toBe("/cases");
      const cases = await b.get("/cases");
      expect(cases.status).toBe(200);
      expect(await cases.text()).toMatch(/<h1[^>]*>Cases<\/h1>/);
    });
});
