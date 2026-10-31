import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type InviteDraft,
  OUTCOMES,
  type Outcome,
  type PendingInvite,
  type TeamMember,
  TeamPage,
} from "../../src/web/pages/team-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";
import { member as shellOf } from "./shell-fixtures";

// The Team page's invitations in Chromium (D07 T04 §21), served by this process: the panel and the pending list by
// keyboard with JavaScript and the same posts without it, Resend, Send again and Revoke, a refusal keeping the address
// under its field, and the accessibility gate's rules at 360 and 1280 px in both themes.
const PUBLIC = join(import.meta.dirname, "../../public");
const NOW = new Date();
const ORG = { id: "org-karoo", name: "Karoo Couriers" };
const members: TeamMember[] = [
  {
    memberId: "m-thandi",
    userId: "u-thandi",
    name: "Thandi Nkosi",
    email: "thandi@karoo.example",
    role: "owner",
    lastActive: NOW.toISOString(),
  },
];
const fresh = (): PendingInvite[] => [
  {
    id: "i-1",
    email: "dispatch@karoo.example",
    role: "member",
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 2 * 86_400_000).toISOString(),
    inviter: "Thandi Nkosi",
    delivery: "sent",
  },
  {
    id: "i-2",
    email: "ops@karoo.example",
    role: "admin",
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    inviter: "Thandi Nkosi",
    delivery: "not-sent",
  },
];
const state = { invites: fresh() };
const html = (body: unknown, status = 200) =>
  new Response(String(body), { status, headers: { "content-type": "text/html; charset=utf-8" } });
const shell = () => {
  const { children: _, ...rest } = shellOf({ organization: ORG, active: "team" });
  return rest;
};
const page = (outcome: Outcome | null, draft?: InviteDraft, status = 200) =>
  html(
    <TeamPage
      shell={shell()}
      members={members}
      reader={{ userId: "u-thandi", role: "owner" }}
      outcome={outcome}
      invites={state.invites}
      {...(draft ? { draft } : {})}
      now={NOW}
    />,
    status,
  );

async function answer(req: IncomingMessage): Promise<Response> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/team" && req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    const go = (r: string, n: string) =>
      new Response(null, { status: 303, headers: { location: `/team?r=${r}&n=${encodeURIComponent(n)}` } });
    const email = (form.get("email") ?? "").trim();
    if (form.get("action") === "invite") {
      if (email === "ayesha@karoo.example")
        return page(
          null,
          { email, role: "member", error: "That person is already a member of this organisation." },
          400,
        );
      state.invites.push({
        id: `i-${state.invites.length + 1}`,
        email,
        role: form.get("role") as PendingInvite["role"],
        createdAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 2 * 86_400_000).toISOString(),
        inviter: "Thandi Nkosi",
        delivery: "sent",
      });
      return go("invited", email);
    }
    const row = state.invites.find((i) => i.id === form.get("invitation"));
    if (!row) return go("invite-gone", "");
    if (form.get("action") === "revoke") {
      state.invites = state.invites.filter((i) => i !== row);
      return go("revoked", row.email);
    }
    row.delivery = "sent";
    row.expiresAt = new Date(NOW.getTime() + 2 * 86_400_000).toISOString();
    return go("resent", row.email);
  }
  if (url.pathname === "/team") {
    const r = url.searchParams.get("r");
    const outcome =
      r && (OUTCOMES as readonly string[]).includes(r)
        ? ({ r, name: url.searchParams.get("n") ?? undefined } as Outcome)
        : null;
    return page(outcome);
  }
  const file = join(PUBLIC, url.pathname);
  if (url.pathname.startsWith("/static/") && existsSync(file)) {
    const type = url.pathname.endsWith(".css")
      ? "text/css"
      : url.pathname.endsWith(".js")
        ? "text/javascript"
        : url.pathname.endsWith(".svg")
          ? "image/svg+xml"
          : "font/woff2";
    return new Response(readFileSync(file), { headers: { "content-type": type } });
  }
  return new Response("not found", { status: 404 });
}

let browser: Browser;
let server: Server;
let origin: string;
beforeAll(async () => {
  browser = await launch();
  server = createServer(async (req, res) => {
    const out = await answer(req);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((done) => server?.close(() => done()));
});
afterEach(() => {
  state.invites = fresh();
});

async function open(options: { width?: number; js?: boolean } = {}) {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: options.width ?? 1280, height: 900 },
    javaScriptEnabled: options.js ?? true,
  });
  const p: Page = await context.newPage();
  await p.goto(`${origin}/team`, { waitUntil: "load" });
  return { p, context };
}

describe.skipIf(!chromiumPath() && !process.env.CI)(
  "the team page's invitations in Chromium",
  { timeout: 120_000 },
  () => {
    for (const js of [true, false]) {
      it(`sends an invitation, sends one again and revokes one by keyboard ${js ? "with" : "without"} JavaScript`, async () => {
        const { p, context } = await open({ js });
        await p.getByLabel("Email address").focus();
        await p.keyboard.type("driver@karoo.example");
        await p.keyboard.press("Tab");
        await p.keyboard.press("ArrowUp");
        await p.keyboard.press("Tab");
        await Promise.all([p.waitForNavigation(), p.keyboard.press("Enter")]);
        expect(await p.locator("#team-outcome").textContent()).toContain("Invitation sent to driver@karoo.example.");
        expect(state.invites.find((i) => i.email === "driver@karoo.example")?.role).toBe("admin");
        // Send again on the row whose email did not go.
        await p.getByRole("button", { name: "Send again invitation to ops@karoo.example" }).focus();
        await Promise.all([p.waitForNavigation(), p.keyboard.press("Enter")]);
        expect(await p.locator("#team-outcome").textContent()).toContain("sent again to ops@karoo.example");
        expect(await p.getByText("Email not sent.").count()).toBe(0);
        await p.getByRole("button", { name: "Revoke invitation to dispatch@karoo.example" }).focus();
        await Promise.all([p.waitForNavigation(), p.keyboard.press("Enter")]);
        expect(await p.locator("#team-outcome").textContent()).toContain("dispatch@karoo.example was revoked");
        expect(state.invites.map((i) => i.email)).not.toContain("dispatch@karoo.example");
        await context.close();
      });
    }

    it("keeps the address under its field on a refusal, announced to assistive technology", async () => {
      const { p, context } = await open();
      await p.getByLabel("Email address").fill("ayesha@karoo.example");
      await Promise.all([
        p.waitForNavigation(),
        p.getByRole("button", { name: "Send invitation", exact: true }).click(),
      ]);
      expect(await p.getByLabel("Email address").inputValue()).toBe("ayesha@karoo.example");
      expect(await p.getByText("already a member").count()).toBeGreaterThan(0);
      expect(await p.locator("#invite-email").getAttribute("aria-invalid")).toBe("true");
      await context.close();
    });

    for (const width of [360, 1280]) {
      it(`passes the accessibility rules in both themes with no sideways scroll at ${width} px`, async () => {
        const { p, context } = await open({ width });
        await p.addScriptTag({ path: AXE });
        for (const theme of ["light", "dark"] as const) {
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), theme).toBeLessThanOrEqual(width);
          expect(problems(await scan(p)), theme).toEqual([]);
        }
        await context.close();
      });
    }
  },
);
