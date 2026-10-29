import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../../src/auth/auth";
import { LINK_MAX, LINK_WINDOW_SECONDS } from "../../src/auth/ratelimit";
import { SIGNIN_PER_ADDRESS } from "../../src/mail/smtp2go";
import { authEnv, call, pathOf, stubSmtp2go } from "./helpers";

// Sign-in rate limits (D07 T02 §6): Better Auth's per-IP limiter counted in D1, and sendMail's per-address limit. Every
// request here carries `cf-connecting-ip`, as Cloudflare sets it on every request from the internet.
const db = (env as unknown as Env).DB;
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  vi.restoreAllMocks();
});

let ipCount = 0;
const freshIp = () => `198.51.100.${(ipCount++ % 250) + 1}`;
const DEMO = "member@demo.isitlegit.co.za";

const askLink = (ip: string, email = `nobody${Math.random().toString(36).slice(2)}@example.org`) =>
  call("/api/auth/sign-in/magic-link", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ email }),
  });
const confirm = (ip: string, token: string) =>
  call("/signin/confirm", {
    method: "POST",
    headers: { "cf-connecting-ip": ip },
    body: new URLSearchParams({ token, callbackURL: "/cases" }),
  });
const linkForm = (ip: string, email: string) =>
  call("/signin/link", {
    method: "POST",
    headers: { "cf-connecting-ip": ip },
    body: new URLSearchParams({ email, callbackURL: "/cases" }),
  });
// The limiter's window moved back past its end, as ten minutes passing would.
const expireWindows = () =>
  db
    .prepare("UPDATE rate_limits SET window_start = window_start - ?")
    .bind(LINK_WINDOW_SECONDS + 1)
    .run();
const rateRows = async (outcome: string) =>
  (
    await db
      .prepare("SELECT COUNT(*) AS n FROM auth_events WHERE kind = 'rate-limited' AND outcome = ?")
      .bind(outcome)
      .first<{ n: number }>()
  )?.n ?? 0;

describe("the per-IP limit on link requests", () => {
  it("admits twenty from one IP, refuses the 21st with its retry time, serves another IP, and admits again later", async () => {
    restore = stubSmtp2go().restore;
    const ip = freshIp();
    for (let i = 0; i < LINK_MAX; i++) expect((await askLink(ip)).status).toBe(200);
    const refused = await askLink(ip);
    expect(refused.status).toBe(429);
    const retry = Number(refused.headers.get("x-retry-after"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(LINK_WINDOW_SECONDS);
    expect((await askLink(freshIp())).status).toBe(200);
    await expireWindows();
    expect((await askLink(ip)).status).toBe(200);
    expect(await rateRows("per-ip")).toBeGreaterThanOrEqual(1);
  });

  it("counts the same across two separately built auth instances, and admits exactly the rest when requests race", async () => {
    restore = stubSmtp2go().restore;
    const ip = freshIp();
    const viaInstance = () =>
      createAuth(authEnv).handler(
        new Request("http://localhost/api/auth/sign-in/magic-link", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost", "cf-connecting-ip": ip },
          body: JSON.stringify({ email: `x${Math.random().toString(36).slice(2)}@example.org` }),
        }),
      );
    for (let i = 0; i < 10; i++) expect((await viaInstance()).status).toBe(200);
    const raced = await Promise.all(Array.from({ length: 15 }, () => viaInstance()));
    expect(raced.filter((r) => r.status === 200)).toHaveLength(LINK_MAX - 10);
    expect(raced.filter((r) => r.status === 429)).toHaveLength(5);
  });

  it("shows the link form's refusal with the time new links resume, keeping the address, and works after the window", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    const ip = freshIp();
    for (let i = 0; i < LINK_MAX; i++) await askLink(ip);
    const refused = await linkForm(ip, DEMO);
    expect(refused.status).toBe(429);
    const html = await refused.text();
    expect(html).toContain("again in 10 minutes");
    expect(html).toContain(`value="${DEMO}"`);
    await expireWindows();
    const sent = await linkForm(ip, DEMO);
    expect(sent.status).toBe(200);
    expect(await sent.text()).toContain("Check your inbox");
  });
});

describe("the per-IP limit on link verifications", () => {
  it("is counted apart from link requests, refuses the 21st, says when, and leaves a real link usable", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    const ip = freshIp();
    // Link requests from this IP do not use up its verifications.
    for (let i = 0; i < 5; i++) await askLink(ip);
    await askLink(freshIp(), DEMO);
    const real = new URL(smtp.sends.at(-1)?.link ?? "").searchParams.get("token") ?? "";
    for (let i = 0; i < LINK_MAX; i++) expect((await confirm(ip, `not-a-token-${i}`)).status).toBe(400);
    const refused = await confirm(ip, real);
    expect(refused.status).toBe(429);
    expect(await refused.text()).toMatch(/Wait \d+ minutes|Wait a minute/);
    expect((await confirm(freshIp(), "not-a-token")).status).toBe(400);
    await expireWindows();
    const signedIn = await confirm(ip, real);
    expect(signedIn.status).toBe(303);
  });
});

describe("the per-address limit", () => {
  it("answers the sixth request in ten minutes as the first, from six IPs, sends nothing more, and records it", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    await db.prepare("DELETE FROM mail_sends WHERE kind = 'signin'").run();
    const before = await rateRows("per-address");
    const answers: number[] = [];
    for (let i = 0; i <= SIGNIN_PER_ADDRESS; i++) answers.push((await askLink(freshIp(), DEMO)).status);
    expect(answers).toEqual(Array(SIGNIN_PER_ADDRESS + 1).fill(200));
    expect(smtp.sends).toHaveLength(SIGNIN_PER_ADDRESS);
    expect(await rateRows("per-address")).toBe(before + 1);
    // Once its oldest send is past ten minutes, a request sends again.
    await db
      .prepare("UPDATE mail_sends SET created_at = ? WHERE kind = 'signin'")
      .bind(new Date(Date.now() - 11 * 60_000).toISOString())
      .run();
    await askLink(freshIp(), DEMO);
    expect(smtp.sends).toHaveLength(SIGNIN_PER_ADDRESS + 1);
  });
});

describe("the limiter's lifecycle", () => {
  it("sweeps an expired bucket and keeps a live one", async () => {
    const { sweepAuthTables } = await import("../../src/auth/audit");
    const now = Math.floor(Date.now() / 1000);
    await db.batch([
      db
        .prepare("INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES ('old', 3, ?)")
        .bind(now - 3_600),
      db.prepare("INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES ('live', 3, ?)").bind(now - 60),
    ]);
    await sweepAuthTables(db);
    const keys = (await db.prepare("SELECT key FROM rate_limits WHERE key IN ('old', 'live')").all()).results;
    expect(keys).toEqual([{ key: "live" }]);
  });
});

// Never the raw address of a client in the limiter's own table.
it("keeps no client address in rate_limits", async () => {
  restore = stubSmtp2go().restore;
  const ip = freshIp();
  await askLink(ip);
  const rows = (await db.prepare("SELECT key FROM rate_limits").all<{ key: string }>()).results;
  expect(rows.some((r) => r.key.includes(ip))).toBe(false);
  expect(pathOf("http://localhost/x")).toBe("/x");
});
