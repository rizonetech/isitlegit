import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type LedgerEntry, type Result, SuppliersPage, type SuppliersView } from "../../src/web/pages/suppliers-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";
import { member } from "./shell-fixtures";

// The supplier ledger page in Chromium (D06 T01 §4, correction 13), served over HTTP by this process with the shipped
// app script; its posts answered here with the redirect the Worker gives (their own answers are
// test/web/suppliers-page.test.ts). It proves Cancel, a removal confirmed and cancelled, a search with no match and its
// way back, the focus an anchored row gets, an account changed by keyboard in three actions with the outcome announced,
// a refusal announced, and every state readable at 375 px with no sideways scroll and passing the accessibility rules.
const PUBLIC = join(import.meta.dirname, "../../public");
const { children: _children, ...SHELL } = member({ active: "suppliers" });
const AT = "2026-10-31T08:02:00.000Z";
const SUPPLIERS: LedgerEntry[] = [
  {
    id: "01JSUPFYNBOS000000000000AA",
    name: "Fynbos Freight (Pty) Ltd",
    domains: ["fynbosfreight.example"],
    phone: "044 873 0192",

    accounts: [
      {
        id: "acc-fynbos",
        bankName: "Kestrel Bank",
        branchCode: "250655",
        holder: "Fynbos Freight (Pty) Ltd",
        last3: "307",
        verifiedFromCaseId: null,
        source: "hand",
        addedBy: "Thandi Nkosi",
        addedAt: AT,
      },
    ],
  },
  {
    id: "01JSUPOUTENIQUA0000000000B",
    name: "Outeniqua Paper",
    domains: ["outeniquapaper.example"],
    phone: null,

    accounts: [
      {
        id: "acc-outeniqua",
        bankName: "Protea Mutual",
        branchCode: "198765",
        holder: "Outeniqua Paper",
        last3: "821",
        verifiedFromCaseId: "case-1",
        source: "case",
        addedBy: "Ayesha P.",
        addedAt: AT,
      },
    ],
  },
  {
    id: "01JSUPKLEINKAROO000000000C",
    name: "Klein Karoo Packaging",
    domains: ["kkpack.example"],
    phone: null,

    accounts: [],
  },
];
const BASE: SuppliersView = { shell: SHELL, canEdit: true, suppliers: SUPPLIERS, query: "", bankAvailable: true };
const fynbos = SUPPLIERS[0] as LedgerEntry;
const states: Record<string, SuppliersView> = {
  list: BASE,
  empty: { ...BASE, suppliers: [] },
  member: { ...BASE, canEdit: false },
  confirm: { ...BASE, confirm: { supplier: fynbos } },
  "confirm-account": {
    ...BASE,
    confirm: { supplier: fynbos, account: fynbos.accounts[0] as LedgerEntry["accounts"][number] },
  },
  edit: { ...BASE, edit: fynbos },
  "import-problems": {
    ...BASE,
    importReport: {
      fileName: "suppliers-oct.csv",
      rows: 12,
      file: null,
      problems: [
        { row: 4, problem: "account_number has 6 digits; an account number has 7 to 11 digits" },
        { row: 9, problem: "branch_code is empty" },
        { row: 11, problem: 'domain "gmail.com" is a free mail service, not a supplier domain' },
      ],
    },
  },
  refused: {
    ...BASE,
    change: { supplier: fynbos, account: fynbos.accounts[0] as LedgerEntry["accounts"][number] },
    changeValues: { bank: "Kestrel Bank", branchCode: "25" },
    changeErrors: {
      branchCode: "A branch code is 6 digits.",
      confirm: "Tick this to remove the account ending 307 when the new one is saved.",
    },
  },
};

const state = { page: "list", posts: [] as Record<string, string>[], redirect: "/suppliers?r=account-changed" };
afterEach(() => Object.assign(state, { page: "list", posts: [], redirect: "/suppliers?r=account-changed" }));

async function fieldsOf(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("latin1")));
}

let browser: Browser;
let server: Server;
let origin: string;
beforeAll(async () => {
  browser = await launch();
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST") {
      state.posts.push(await fieldsOf(req));
      res.writeHead(303, { location: state.redirect });
      return res.end();
    }
    if (url.pathname === "/suppliers") {
      const base = states[state.page] ?? BASE;
      const r = url.searchParams.get("r");
      const changeId = url.searchParams.get("change");
      const account = changeId
        ? SUPPLIERS.flatMap((s) => s.accounts.map((a) => ({ supplier: s, account: a }))).find(
            (x) => x.account.id === changeId,
          )
        : undefined;
      const view: SuppliersView = {
        ...base,
        query: url.searchParams.get("q") ?? base.query,
        result: r ? (r as Result) : (base.result ?? null),
        ...(account ? { change: account } : {}),
      };
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" });
      return res.end(String(<SuppliersPage {...view} />));
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
      res.writeHead(200, { "content-type": type });
      return res.end(readFileSync(file));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((done) => server?.close(() => done()));
});

async function open(page: string, path = "/suppliers", width = 1280): Promise<{ p: Page; context: BrowserContext }> {
  state.page = page;
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const p = await context.newPage();
  await p.goto(`${origin}${path}`, { waitUntil: "load" });
  return { p, context };
}
const focused = (p: Page) =>
  p.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      tag: el?.tagName ?? "",
      id: el?.id ?? "",
      anchor: el?.dataset.anchorRow ?? "",
      text: el?.textContent?.trim() ?? "",
    };
  });

describe.skipIf(!chromiumPath() && !process.env.CI)("the supplier ledger in Chromium", { timeout: 120_000 }, () => {
  it("cancels an add, leaving the page as it was", async () => {
    const { p, context } = await open("list");
    await p.locator("#add-name").fill("Mossel Bay Couriers");
    await p.locator("#add-supplier").getByRole("link", { name: "Cancel" }).click();
    await p.waitForURL(`${origin}/suppliers`);
    expect(await p.locator("#add-name").inputValue()).toBe("");
    expect(state.posts).toEqual([]);
    await context.close();
  });

  it("confirms a removal before sending it, and Cancel returns to the supplier's row, focused", async () => {
    const { p, context } = await open("confirm");
    expect((await focused(p)).text).toBe("Remove Fynbos Freight (Pty) Ltd?");
    await p
      .getByRole("region", { name: "Remove Fynbos Freight (Pty) Ltd?" })
      .getByRole("link", { name: "Cancel" })
      .click();
    await p.waitForURL(`${origin}/suppliers#${fynbos.id}`);
    expect(await focused(p)).toMatchObject({ tag: "TR", anchor: fynbos.id });
    expect(state.posts).toEqual([]);
    await context.close();
    const confirm = await open("confirm-account");
    state.redirect = "/suppliers?r=account-removed";
    await confirm.p.getByRole("button", { name: "Confirm removal" }).click();
    await confirm.p.waitForURL(`${origin}/suppliers?r=account-removed`);
    expect(state.posts.map((f) => [f.action, f.accountId])).toEqual([["confirm-remove-account", "acc-fynbos"]]);
    expect((await focused(confirm.p)).text).toBe("The account is removed, and the removal is logged.");
    await confirm.context.close();
  });

  it("says when a search matches nothing, and Show all suppliers brings the ledger back", async () => {
    const { p, context } = await open("list", "/suppliers?q=nobody");
    expect(await p.getByRole("heading", { name: "No supplier matches" }).isVisible()).toBe(true);
    await p.getByRole("link", { name: "Show all suppliers" }).click();
    await p.waitForURL(`${origin}/suppliers`);
    expect(await p.getByRole("rowheader", { name: "Outeniqua Paper" }).isVisible()).toBe(true);
    await p.locator("#supplier-search").fill("821");
    await p.keyboard.press("Enter");
    await p.waitForURL(`${origin}/suppliers?q=821`);
    expect(await p.getByRole("rowheader").allTextContents()).toEqual(["Outeniqua Paper"]);
    await context.close();
  });

  for (const width of [1280, 375])
    it(`focuses the row an address names (${width} px)`, async () => {
      const { p, context } = await open("list", `/suppliers#${fynbos.id}`, width);
      expect(await focused(p)).toMatchObject({ tag: width === 1280 ? "TR" : "LI", anchor: fynbos.id });
      await context.close();
    });

  it("changes an account by keyboard in three actions from its row, the outcome announced", async () => {
    const { p, context } = await open("list");
    let actions = 0;
    // 1: the row's Change control.
    await p
      .getByRole("link", { name: "Change the Kestrel Bank account ending 307 for Fynbos Freight (Pty) Ltd" })
      .focus();
    await p.keyboard.press("Enter");
    actions++;
    await p.waitForURL(`${origin}/suppliers?change=acc-fynbos`);
    expect((await focused(p)).text).toBe("Change Fynbos Freight (Pty) Ltd's account ending 307");
    expect(await p.locator("#change-bank").inputValue()).toBe("Kestrel Bank");
    // The details typed (not counted): the new number in the form drawn with the bank and branch prefilled.
    await p.locator("#change-number").focus();
    await p.keyboard.type("1234567890");
    // 2: the confirmation that the old account goes.
    await p.keyboard.press("Tab");
    await p.keyboard.press("Space");
    actions++;
    // 3: Save new account.
    await p.keyboard.press("Tab");
    expect((await focused(p)).text).toBe("Save new account");
    await p.keyboard.press("Enter");
    actions++;
    await p.waitForURL(`${origin}/suppliers?r=account-changed`);
    expect(actions).toBeLessThanOrEqual(3);
    expect(state.posts).toEqual([
      expect.objectContaining({
        action: "change-account",
        accountId: "acc-fynbos",
        accountNumber: "1234567890",
        confirm: "on",
      }),
    ]);
    const announced = await focused(p);
    expect(announced.text).toBe("The account is changed: the new one is saved and the old one removed, both logged.");
    await context.close();
  });

  it("announces a refusal and keeps its field's value", async () => {
    const { p, context } = await open("refused");
    const now = await focused(p);
    expect(now.text).toBe("Change Fynbos Freight (Pty) Ltd's account ending 307");
    expect(await p.getByRole("alert").allTextContents()).toContain(
      "Tick this to remove the account ending 307 when the new one is saved.",
    );
    expect(await p.locator("#change-branch").getAttribute("aria-invalid")).toBe("true");
    expect(await p.locator("#change-branch").inputValue()).toBe("25");
    await context.close();
  });

  for (const theme of ["light", "dark"] as const)
    for (const width of [375, 1280])
      it(`reads every state with no sideways scroll and passes the accessibility rules (${theme}, ${width} px)`, async () => {
        for (const page of Object.keys(states)) {
          const { p, context } = await open(page, "/suppliers", width);
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), page).toBeLessThanOrEqual(width);
          await p.addScriptTag({ path: AXE });
          expect(problems(await scan(p)), page).toEqual([]);
          await context.close();
        }
      });
});
