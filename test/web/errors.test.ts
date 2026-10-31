import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { maintenanceFrom, maintenancePage, slowDownPage } from "../../src/web/pages/errors";
import { authEnv, call, ORIGIN } from "../auth/helpers";

// The app's error pages (D07 T08 §1; design/SPEC.md E1 to E6): an unmatched path and an uncaught throw answered with
// the pages, never the framework's text, the 429 and maintenance pages built from the boards, and the maintenance switch.
afterEach(() => vi.restoreAllMocks());

const SECRET = "SECRET-sk-live-4242 at /srv/app/src/db.ts:17";
const text = (h: string) =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ");
// An environment whose named property throws a message holding a secret and a path when the app reads it.
const throwing = (name: "COMMIT_SHA" | "APP_URL"): Env => {
  const e = { ...authEnv };
  Object.defineProperty(e, name, {
    get() {
      throw new Error(SECRET);
    },
  });
  return e;
};
const withMaintenance = (value: string): Env => ({ ...authEnv, MAINTENANCE: value });
const html = { accept: "text/html" };

describe("the 404 and 500 pages", () => {
  it("answers an unmatched path with the 404 page, not the framework's text, and HEAD or non-HTML with no body", async () => {
    const res = await call("/no/such/page", { headers: html });
    const body = await res.text();
    expect(res.status).toBe(404);
    expect(text(body)).toContain("We can't show you that page.");
    expect(body).not.toContain("404 Not Found");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const head = await call("/no/such/page", { method: "HEAD", headers: html });
    expect(head.status).toBe(404);
    expect(await head.text()).toBe("");
    const json = await call("/no/such/page", { headers: { accept: "application/json" } });
    expect(json.status).toBe(404);
    expect(await json.text()).toBe("");
  });

  it("answers an uncaught throw with the 500 page and a reference, logging the class and the reference, never the message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call("/health?x=1", { headers: html }, throwing("COMMIT_SHA"));
    const body = await res.text();
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(text(body)).toContain("Sorry, something broke on our side.");
    expect(body).not.toContain("SECRET");
    expect(body).not.toContain("db.ts");
    const ref = /Reference (500-[0-9A-F]{6})/.exec(text(body))?.[1];
    expect(ref).toBeDefined();
    const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain(`"reference":"${ref}"`);
    expect(JSON.parse(logged)).toMatchObject({ event: "unhandled-error", error: "Error" });
    expect(logged).not.toContain("SECRET");
    // Try again repeats a read at the same address.
    expect(body).toContain('href="/health?x=1"');
    const head = await call("/health", { method: "HEAD", headers: html }, throwing("COMMIT_SHA"));
    expect(head.status).toBe(503);
    expect(await head.text()).toBe("");
  });

  it("sends a failed submission's Try again to the Cases list, never to repeat the submission", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call(
      "/auth/sign-out",
      { method: "POST", headers: { ...html, origin: ORIGIN } },
      throwing("APP_URL"),
    );
    const body = await res.text();
    expect(res.status).toBe(503);
    expect(body).toContain('href="/cases"');
    expect(body).not.toContain('href="/auth/sign-out"');
    expect(body).not.toContain("SECRET");
  });
});

describe("the 429 page", () => {
  const now = new Date("2026-10-27T16:48:00.000Z"); // 18:48 SAST
  it("says the daily cap, the reset time in words, the way forward and no raw text", async () => {
    const res = slowDownPage({
      kind: "daily",
      orgName: "Karoo <b>Couriers",
      limit: 50,
      resetsAt: new Date("2026-10-27T22:00:00.000Z"),
      ref: "429-2B6W5R",
      now,
    });
    const body = await res.text();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe(String(5 * 3600 + 12 * 60));
    expect(text(body)).toContain("You've reached today's limit of 50 checks.");
    expect(text(body)).toContain("The limit resets at 00:00 SAST, in 5 h 12 min.");
    expect(text(body)).toContain("Reference 429-2B6W5R · Tue 27 Oct 2026, 18:48 SAST");
    expect(body).toContain('href="/settings/plan"');
    expect(body).toContain('href="/cases"');
    expect(body).not.toContain("<b>Couriers");
  });

  it("says a paused organisation is paused, promising no reset time", async () => {
    const res = slowDownPage({ kind: "daily", orgName: "Karoo Couriers", limit: 0, resetsAt: now, now });
    const body = text(await res.text());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(body).toContain("Checks are paused for Karoo Couriers.");
    expect(body).not.toMatch(/resets at \d/);
    expect(body).toContain("check@isitlegit.co.za");
  });

  it("says a burst limit's seconds, with retry-after", async () => {
    const res = slowDownPage({ kind: "burst", retryInSeconds: 30, now });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(text(await res.text())).toContain("Try again in 30 seconds.");
  });
});

describe("the maintenance page and its switch", () => {
  const window = { from: new Date("2026-10-28T00:00:00Z"), to: new Date("2026-10-28T00:30:00Z") };
  it("draws the board's notice with the window, 503 and retry-after", async () => {
    const res = maintenancePage({ window, now: new Date("2026-10-28T00:10:00Z") });
    const body = await res.text();
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1200");
    expect(text(body)).toContain("We're upgrading IsItLegit. Back by 02:30 SAST.");
    expect(text(body)).toContain("offline from 02:00 SAST to 02:30 SAST on Wed 28 Oct 2026");
    expect(text(body)).toContain("Started 02:00 SAST · expected back 02:30 SAST");
    expect(text(body)).toContain("check@isitlegit.co.za");
    const none = await maintenancePage().text();
    expect(text(none)).toContain("Back shortly.");
  });

  it("says where the work stands: before, at the end and past it, and a window across midnight with both dates", async () => {
    const say = async (at: string, w = window) => text(await maintenancePage({ window: w, now: new Date(at) }).text());
    expect(await say("2026-10-27T22:00:00Z")).toContain("going offline from 02:00 SAST to 02:30 SAST");
    expect(await say("2026-10-27T22:00:00Z")).toContain("Starts 02:00 SAST · expected back 02:30 SAST");
    expect(await say("2026-10-28T00:30:00Z")).toContain("Back by 02:30 SAST.");
    // Past the expected end: no return time already gone is promised, and Reload is still offered.
    const late = await maintenancePage({ window, now: new Date("2026-10-28T00:31:00Z") });
    const lateText = text(await late.text());
    expect(lateText).toContain("It is taking longer than planned.");
    expect(lateText).not.toContain("Back by");
    expect(lateText).toContain("was expected back 02:30 SAST");
    expect(late.headers.get("retry-after")).toBe("60");
    // 22:00 to 01:00 SAST across midnight: each end carries its own date.
    const night = { from: new Date("2026-10-28T20:00:00Z"), to: new Date("2026-10-28T23:00:00Z") };
    const across = await say("2026-10-28T21:00:00Z", night);
    expect(across).toContain("22:00 SAST on Wed 28 Oct 2026 to 01:00 SAST on Thu 29 Oct 2026");
    expect(across).toContain("Back by 01:00 SAST on Thu 29 Oct 2026.");
  });

  it("draws the boards' header, the linked logo and the hostname, on every error page", async () => {
    const pages = [
      maintenancePage(),
      slowDownPage({ kind: "burst", retryInSeconds: 5 }),
      await call("/no/such/page", { headers: html }),
    ];
    for (const res of pages) {
      const body = await res.text();
      expect(body).toMatch(/<a href="\/"[^>]*>\s*<img[^>]*alt="IsItLegit"/);
      expect(text(body)).toContain("app.isitlegit.co.za");
    }
  });

  it("keeps the query on Reload through the Worker, so a signed report link is not lost", async () => {
    const on = withMaintenance("on");
    const res = await call("/r/01ABC?o=org&e=1&s=sig%2Bx", { headers: html }, on);
    expect(await res.text()).toContain('href="/r/01ABC?o=org&amp;e=1&amp;s=sig%2Bx"');
  });

  it("reads the variable: empty is normal, a window is parsed, other text is on without one", () => {
    expect(maintenanceFrom(undefined).on).toBe(false);
    expect(maintenanceFrom("  ").on).toBe(false);
    expect(maintenanceFrom("2026-10-28T00:00:00Z/2026-10-28T00:30:00Z").window?.to.toISOString()).toBe(
      "2026-10-28T00:30:00.000Z",
    );
    expect(maintenanceFrom("2026-10-28T00:30:00Z/2026-10-28T00:00:00Z")).toEqual({ on: true });
    expect(maintenanceFrom("yes")).toEqual({ on: true });
  });

  it("answers every request but /static/ with it, runs no route, and leaves the app alone once cleared", async () => {
    const on = withMaintenance("2030-01-01T00:00:00Z/2030-01-02T00:00:00Z");
    for (const path of ["/cases?q=1", "/r/01ABC", "/signin"]) {
      const res = await call(path, { headers: html }, on);
      const body = await res.text();
      expect(res.status).toBe(503);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(30);
      expect(text(body)).toContain("We're upgrading IsItLegit.");
      expect(body).toContain(`href="${path}"`);
    }
    // A submission is refused before any route runs: nothing is written, and its handler never starts.
    const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_events").first<{ n: number }>())?.n;
    const post = await call("/orgs/switch", { method: "POST", headers: { ...html, origin: ORIGIN } }, on);
    expect(post.status).toBe(503);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_events").first<{ n: number }>())?.n).toBe(before);
    // Static files stay out of it: whatever answers them, it is not the maintenance page.
    const asset = await call("/static/missing.css", { headers: html }, on);
    expect(text(await asset.text())).not.toContain("We're upgrading IsItLegit.");
    // Cleared, the same request is the app again.
    const cleared = await call("/signin", { headers: html }, withMaintenance(""));
    expect(cleared.status).toBe(200);
    expect(text(await cleared.text())).not.toContain("We're upgrading IsItLegit.");
  });
});
