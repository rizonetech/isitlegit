import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isProtectedAccount } from "../../src/auth/protected";
import {
  OUTCOMES,
  type Outcome,
  type Reader,
  RemoveConfirm,
  type TeamMember,
  TeamPage,
} from "../../src/web/pages/team-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";
import { member as shellOf } from "./shell-fixtures";

// The Team page in Chromium (D07 T04 §3), served by this process with the shipped htmx and app script: a role change by
// keyboard and by Save without JavaScript, a removal confirmed and cancelled on its page with or without JavaScript, a
// refused and a failed change drawn as such and never as done, the busy control, and the accessibility gate's rules.
const PUBLIC = join(import.meta.dirname, "../../public");
const NOW = new Date();
const ORG = { id: "org-karoo", name: "Karoo Couriers" };
const fresh = (): TeamMember[] => [
  {
    memberId: "m-thandi",
    userId: "u-thandi",
    name: "Thandi Nkosi",
    email: "thandi@karoo.example",
    role: "owner",
    lastActive: NOW.toISOString(),
  },
  {
    memberId: "m-ayesha",
    userId: "u-ayesha",
    name: "Ayesha Patel",
    email: "ayesha@karoo.example",
    role: "admin",
    lastActive: null,
  },
  {
    memberId: "m-sipho",
    userId: "u-sipho",
    name: "Sipho Mokoena",
    email: "sipho@karoo.example",
    role: "member",
    lastActive: new Date(NOW.getTime() - 86_400_000).toISOString(),
  },
];
type State = {
  members: TeamMember[];
  reader: Reader;
  answer: null | "locked" | "failed" | "dropped";
  delay: number;
  posts: number;
  // What the page reported of itself while a navigation was pending (`/probe` beacons).
  probes: string[];
};
const state: State = {
  members: fresh(),
  reader: { userId: "u-thandi", role: "owner" },
  answer: null,
  delay: 0,
  posts: 0,
  probes: [],
};

const html = (body: unknown, status = 200) =>
  new Response(String(body), { status, headers: { "content-type": "text/html; charset=utf-8" } });
const shell = () => {
  const { children: _, ...rest } = shellOf({ organization: ORG, active: "team" });
  return rest;
};

async function answer(req: IncomingMessage): Promise<Response> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/probe") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    state.probes.push(Buffer.concat(chunks).toString());
    return new Response(null, { status: 204 });
  }
  if (url.pathname === "/team" && req.method === "POST") {
    state.posts++;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    await new Promise((done) => setTimeout(done, state.delay));
    // As src/web/pages/team.tsx answers a reader who is now a member: the notice as a redirect for htmx, else 403.
    if (state.reader.role === "member")
      return req.headers["hx-request"] === "true"
        ? new Response(null, { status: 303, headers: { location: "/team?r=no-permission" } })
        : html(
            <TeamPage
              shell={shell()}
              members={state.members}
              reader={state.reader}
              outcome={{ r: "no-permission" }}
              now={NOW}
            />,
            403,
          );
    const target = state.members.find((m) => m.memberId === form.get("member"));
    const name = target?.name ?? "";
    const go = (r: Outcome["r"]) =>
      new Response(null, { status: 303, headers: { location: `/team?r=${r}&n=${encodeURIComponent(name)}` } });
    if (state.answer === "failed") return go("failed");
    if (!target) return go("gone");
    if (state.answer === "locked") return go("locked");
    // As the remove-member hook answers (src/auth/auth.ts): a protected account is never removed.
    if (form.get("action") === "remove" && isProtectedAccount(target.email)) return go("protected");
    if (form.get("action") === "remove") {
      state.members = state.members.filter((m) => m !== target);
      return go("removed");
    }
    target.role = form.get("role") as TeamMember["role"];
    return go("role-changed");
  }
  if (url.pathname === "/team") {
    const r = url.searchParams.get("r");
    const outcome =
      r && (OUTCOMES as readonly string[]).includes(r)
        ? ({ r, name: url.searchParams.get("n") ?? undefined } as Outcome)
        : null;
    const lost = url.searchParams.get("unanswered") === "1";
    const historyAction = url.searchParams.get("action") ?? "";
    const allRows = [
      {
        at: "2026-10-28T08:00:00.000Z",
        what: "Member removed",
        who: "You",
        whom: "Sipho Mokoena",
        outcome: "Done, 1 session ended",
      },
      {
        at: "2026-10-27T08:00:00.000Z",
        what: "Role changed, Member to Admin",
        who: "You",
        whom: "Sipho Mokoena",
        outcome: "Done",
      },
    ];
    const rows =
      historyAction === "remove-member"
        ? allRows.slice(0, 1)
        : historyAction === "update-member-role"
          ? allRows.slice(1)
          : allRows;
    return html(
      <TeamPage
        shell={shell()}
        members={state.members}
        reader={state.reader}
        outcome={outcome}
        lost={lost}
        find={url.searchParams.get("find") ?? undefined}
        history={
          state.reader.role === "owner"
            ? {
                rows,
                action: historyAction,
                from: url.searchParams.get("from") ?? "",
                to: url.searchParams.get("to") ?? "",
              }
            : undefined
        }
        now={NOW}
      />,
    );
  }
  if (url.pathname.startsWith("/team/remove/")) {
    const target = state.members.find((m) => m.memberId === url.pathname.split("/").at(-1));
    if (target && isProtectedAccount(target.email))
      return new Response(null, {
        status: 303,
        headers: { location: `/team?r=protected&n=${encodeURIComponent(target.name)}` },
      });
    return target
      ? html(<RemoveConfirm shell={shell()} member={target} />)
      : new Response(null, { status: 303, headers: { location: "/team?r=gone" } });
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
    // The change made, then its answer lost on the way (the connection dropped before any reply).
    // Every attempt dropped: Chromium sends a POST again once when its connection resets before any reply.
    if (state.answer === "dropped" && req.method === "POST") {
      await answer(req);
      return req.socket.destroy();
    }
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
  Object.assign(state, {
    members: fresh(),
    reader: { userId: "u-thandi", role: "owner" },
    answer: null,
    delay: 0,
    posts: 0,
    probes: [],
  });
});

async function open(path = "/team", options: { width?: number; js?: boolean } = {}) {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: options.width ?? 1280, height: 900 },
    javaScriptEnabled: options.js ?? true,
  });
  const p: Page = await context.newPage();
  await p.goto(`${origin}${path}`, { waitUntil: "load" });
  return { p, context };
}
const outcome = (p: Page) => p.locator("#team-outcome").textContent();
const roleOf = (p: Page, id: string) => p.locator(`#role-${id}`).inputValue();

describe.skipIf(!chromiumPath() && !process.env.CI)("the team page in Chromium", { timeout: 120_000 }, () => {
  it("changes a role by keyboard, the select busy while it runs, the change read back", async () => {
    state.delay = 600;
    const { p, context } = await open();
    await p.locator("#role-m-sipho").focus();
    await p.keyboard.press("ArrowUp");
    // While the post runs the select is disabled, so a second change sends nothing.
    await expect.poll(() => p.locator("#role-m-sipho").isDisabled()).toBe(true);
    await expect.poll(() => outcome(p)).toContain("Sipho Mokoena's role was changed.");
    expect(state.posts).toBe(1);
    expect(await roleOf(p, "m-sipho")).toBe("admin");
    await context.close();
  });

  it("draws a held member and a failed change as what happened, never as done", async () => {
    state.answer = "locked";
    const { p, context } = await open();
    await p.locator("#role-m-sipho").selectOption("admin");
    await expect.poll(() => outcome(p)).toContain("Someone else is changing Sipho Mokoena now.");
    expect(await roleOf(p, "m-sipho")).toBe("member");
    state.answer = "failed";
    // The redrawn form is htmx's once it has settled; a change before then would send nothing.
    await p.waitForFunction(() => !document.querySelector(".htmx-settling, .htmx-swapping, .htmx-request"));
    await p.waitForTimeout(50);
    await p.locator("#role-m-sipho").selectOption("admin");
    await expect.poll(() => outcome(p)).toContain("The change to Sipho Mokoena could not be confirmed.");
    expect(await roleOf(p, "m-sipho")).toBe("member");
    expect(state.members.find((m) => m.memberId === "m-sipho")?.role).toBe("member");
    await context.close();
  });

  it("says so when the reader lost the permission since the page was drawn", async () => {
    state.reader = { userId: "u-ayesha", role: "admin" };
    const { p, context } = await open();
    state.reader = { userId: "u-ayesha", role: "member" };
    await p.locator("#role-m-sipho").selectOption("admin");
    await expect.poll(() => outcome(p)).toContain("You can no longer change the team.");
    expect(await p.locator("#role-m-sipho").count()).toBe(0);
    expect(state.members.find((m) => m.memberId === "m-sipho")?.role).toBe("member");
    await context.close();
  });

  it("says a change whose answer was lost may not have been made, and shows the team as stored", async () => {
    const { p, context } = await open();
    state.answer = "dropped";
    await p.locator("#role-m-sipho").selectOption("admin");
    await expect.poll(() => p.url()).toContain("/team?unanswered=1");
    await expect.poll(() => outcome(p)).toContain("Your last change may not have reached us.");
    // The change was in fact made before the answer was lost: the stored role is what the page shows.
    expect(await roleOf(p, "m-sipho")).toBe("admin");
    await context.close();
  });

  it("holds Remove while it runs, offers where it stands, and a stopped removal can be checked", async () => {
    // The removal is made, but its answer is slow: the reader stops waiting.
    state.delay = 15_000;
    const { p, context } = await open("/team/remove/m-sipho");
    // The page reports its own button and the "where it stands" link as they change: a locator or an evaluate would wait
    // for the pending navigation to end.
    await p.evaluate(() => {
      const say = () => {
        const b = document.querySelector<HTMLButtonElement>("form[data-busy] button[type=submit]");
        const link = document.querySelector("[data-busy-check-link]")?.getAttribute("href") ?? "";
        navigator.sendBeacon("/probe", `${b?.disabled} ${b?.getAttribute("aria-busy")} ${b?.textContent} ${link}`);
      };
      new MutationObserver(say).observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    });
    await p.locator("form[data-busy] button[type=submit]").click({ noWaitAfter: true });
    await expect.poll(() => state.probes.join("\n")).toContain("true true Removing Sipho Mokoena");
    await expect.poll(() => state.probes.join("\n"), { timeout: 5000 }).toContain("Removing Sipho Mokoena /team");
    // The reader stops waiting and opens the team (as the offered link does).
    state.delay = 0;
    await p.goto(`${origin}/team`, { waitUntil: "load" });
    expect(await p.locator("h1").textContent()).toBe("Team");
    // The team as stored: the removal the server made, read back; nothing asked twice.
    expect(await p.locator("table").getByText("sipho@karoo.example").count()).toBe(
      state.members.some((m) => m.memberId === "m-sipho") ? 1 : 0,
    );
    await context.close();
  });

  it("removes a member by keyboard through the confirm page, and Cancel keeps them", async () => {
    const { p, context } = await open();
    await p.getByRole("link", { name: "Remove Sipho Mokoena" }).focus();
    await p.keyboard.press("Enter");
    await expect.poll(() => p.locator("h1").textContent()).toBe("Remove Sipho Mokoena?");
    await p.getByRole("link", { name: "Cancel" }).click();
    await expect.poll(() => p.locator("h1").textContent()).toBe("Team");
    expect(state.members).toHaveLength(3);
    await p.getByRole("link", { name: "Remove Sipho Mokoena" }).click();
    await p.getByRole("button", { name: "Remove Sipho Mokoena" }).focus();
    await p.keyboard.press("Enter");
    await expect.poll(() => outcome(p)).toContain("Sipho Mokoena was removed.");
    expect(await p.locator("#role-m-sipho").count()).toBe(0);
    await context.close();
  });

  it("changes a role with Save and removes a member without JavaScript, the stored state read after a reload", async () => {
    const { p, context } = await open("/team", { js: false });
    await p.locator("#role-m-sipho").selectOption("admin");
    await p
      .locator("form", { has: p.locator("#role-m-sipho") })
      .getByRole("button", { name: "Save" })
      .click();
    await expect.poll(() => outcome(p)).toContain("Sipho Mokoena's role was changed.");
    await p.reload();
    expect(await roleOf(p, "m-sipho")).toBe("admin");
    await p.getByRole("link", { name: "Remove Ayesha Patel" }).click();
    await p.getByRole("link", { name: "Cancel" }).click();
    expect(state.members).toHaveLength(3);
    await p.getByRole("link", { name: "Remove Ayesha Patel" }).click();
    await p.getByRole("button", { name: "Remove Ayesha Patel" }).click();
    await expect.poll(() => outcome(p)).toContain("Ayesha Patel was removed.");
    await p.reload();
    expect(await p.getByText("ayesha@karoo.example").count()).toBe(0);
    await context.close();
  });

  const protectedMember = (): TeamMember => ({
    memberId: "m-demo",
    userId: "u-demo",
    name: "Demo Account",
    email: "demo@rizonetech.com",
    role: "member",
    lastActive: null,
  });

  // The matrix the section names: both themes, both widths, and both JavaScript modes.
  for (const theme of ["light", "dark"] as const)
    for (const width of [1280, 360] as const)
      for (const js of [true, false])
        it(`protects an account's Remove (${theme}, ${width} px, ${js ? "with" : "without"} JavaScript): named, described, refused in words, kept`, async () => {
          // The page is drawn before the account is protected (a stale page): its Remove is an active link.
          const stale = { ...protectedMember(), email: "demo-stale@karoo.example" };
          state.members = [...fresh(), stale];
          const { p, context } = await open("/team", { js, width });
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          await p.getByRole("link", { name: "Remove Demo Account" }).click();
          await p.getByRole("button", { name: "Remove Demo Account" }).waitFor();
          // The account becomes protected while the confirmation is open; its Remove is pressed anyway.
          stale.email = "demo@rizonetech.com";
          await p.getByRole("button", { name: "Remove Demo Account" }).click();
          await expect
            .poll(() => outcome(p))
            .toContain("Demo Account is a protected demo account and cannot be removed.");
          expect(state.members.some((m) => m.memberId === "m-demo")).toBe(true);
          expect(await outcome(p)).not.toContain("was removed");
          // The notice is an alert, and with the script it takes the focus.
          expect(await p.locator("#team-outcome").getAttribute("role")).toBe("alert");
          if (js) expect(await p.evaluate(() => document.activeElement?.id)).toBe("team-outcome");
          // Now protected, the row's Remove is a disabled control: named for the member, described by its reason.
          const id = width === 1280 ? "remove-m-demo" : "remove-m-demo-card";
          expect(await p.getByRole("button", { name: "Remove Demo Account", disabled: true }).count()).toBe(1);
          expect(await p.locator(`#${id}`).isDisabled()).toBe(true);
          expect(await p.locator(`#${id}`).getAttribute("aria-label")).toBe("Remove Demo Account");
          expect(await p.locator(`#${id}`).getAttribute("aria-describedby")).toBe(`${id}-reason`);
          expect(await p.locator(`#${id}-reason`).textContent()).toBe("This is a protected demo account");
          // An ordinary member still has an active link.
          expect(await p.getByRole("link", { name: "Remove Sipho Mokoena" }).first().isVisible()).toBe(true);
          expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
          // The rules run in the page; with the script off the same server-rendered markup was checked with it on.
          if (js) {
            await p.addScriptTag({ path: AXE });
            expect(problems(await scan(p)), "notice and disabled Remove").toEqual([]);
          }
          // The typed address says the same, and asks nothing.
          await p.goto(`${origin}/team/remove/m-demo`, { waitUntil: "load" });
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await outcome(p)).toContain("is a protected demo account and cannot be removed.");
          expect(await p.getByRole("button", { name: "Remove Demo Account" }).filter({ visible: true }).count()).toBe(
            1,
          );
          expect(await p.locator("h1").textContent()).toBe("Team");
          if (js) {
            await p.addScriptTag({ path: AXE });
            expect(problems(await scan(p)), "typed address").toEqual([]);
          }
          await context.close();
        });

  for (const theme of ["light", "dark"] as const)
    for (const width of [360, 1280] as const)
      it(`passes the accessibility gate's rules for an owner, an admin and the confirm page (${theme}, ${width} px)`, async () => {
        for (const [reader, path] of [
          [{ userId: "u-thandi", role: "owner" }, "/team"],
          [{ userId: "u-thandi", role: "owner" }, "/team?r=locked&n=Sipho%20Mokoena"],
          [{ userId: "u-ayesha", role: "admin" }, "/team"],
          [{ userId: "u-thandi", role: "owner" }, "/team/remove/m-sipho"],
          [{ userId: "u-thandi", role: "owner" }, "/team?r=protected&n=Demo%20Account"],
        ] as const) {
          state.reader = reader;
          state.members = [...fresh(), protectedMember()];
          const { p, context } = await open(path, { width });
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(width);
          await p.addScriptTag({ path: AXE });
          expect(problems(await scan(p)), `${reader.role} ${path}`).toEqual([]);
          await context.close();
        }
      });
  it("filters the history by action, with scripts off and on (D07 T04 §23)", async () => {
    for (const js of [true, false]) {
      const { p, context } = await open("/team", { js });
      await expect.poll(() => p.locator("#team-history-heading").textContent()).toBe("Team history");
      await expect.poll(() => p.getByText("Member removed").first().textContent()).toBeTruthy();
      await p.locator("#history-action").selectOption("update-member-role");
      await p.getByRole("button", { name: "Apply" }).click();
      await expect.poll(() => p.url()).toContain("action=update-member-role");
      await expect.poll(() => p.getByText("Role changed, Member to Admin").first().textContent()).toBeTruthy();
      expect(await p.getByText("1 session ended").count()).toBe(0);
      await context.close();
    }
  });

  it("finds a person and keeps the focus in the find field (D07 T04 §26)", async () => {
    const { p, context } = await open("/team");
    await p.locator("#team-find").fill("sipho");
    await p.getByRole("button", { name: "Find", exact: true }).click();
    await expect.poll(() => p.url()).toContain("find=sipho");
    await expect.poll(() => p.evaluate(() => document.activeElement?.id)).toBe("team-find");
    expect(await p.getByText("Sipho Mokoena").first().textContent()).toBeTruthy();
    expect(await p.getByText("No one on the team matches.").count()).toBe(0);
    await p.locator("#team-find").fill("nobody-like-this");
    await p.getByRole("button", { name: "Find", exact: true }).click();
    await expect.poll(() => p.getByText("No one on the team matches.").textContent()).toBeTruthy();
    await p.getByRole("link", { name: "Clear" }).click();
    await expect.poll(() => p.url()).not.toContain("find=");
    await context.close();
  });

});
