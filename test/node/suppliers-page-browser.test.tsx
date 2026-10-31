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
const THOUSAND: LedgerEntry[] = Array.from({ length: 1000 }, (_, i) => ({
  id: `01JSUPMANY${String(i).padStart(16, "0")}`,
  name: `Supplier ${i}`,
  domains: [`s${i}.example`],
  phone: null,
  accounts: [
    {
      id: `acc-many-${i}`,
      bankName: "Kestrel Bank",
      branchCode: "250655",
      holder: `Supplier ${i}`,
      last3: String(i % 1000).padStart(3, "0"),
      verifiedFromCaseId: null,
      source: "csv" as const,
      addedBy: "Thandi Nkosi",
      addedAt: AT,
    },
  ],
}));
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
      const base = state.page === "thousand" ? { ...BASE, suppliers: THOUSAND } : (states[state.page] ?? BASE);
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

  it("confirms a removal before sending it, and Cancel returns to the ledger without the question", async () => {
    const { p, context } = await open("confirm");
    expect((await focused(p)).text).toBe("Remove Fynbos Freight (Pty) Ltd?");
    state.page = "list";
    await p
      .getByRole("region", { name: "Remove Fynbos Freight (Pty) Ltd?" })
      .getByRole("link", { name: "Cancel" })
      .click();
    await p.waitForURL(`${origin}/suppliers`);
    expect(await p.getByRole("heading", { name: "Remove Fynbos Freight (Pty) Ltd?" }).count()).toBe(0);
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
      // The row is focused by the app script's `load` handler, which may run just after Playwright sees the page load
      // (a slower CI runner showed the race), so the assertion waits for it.
      await expect
        .poll(async () => {
          const f = await focused(p);
          return `${f.tag} ${f.anchor}`;
        })
        .toBe(`${width === 1280 ? "TR" : "LI"} ${fynbos.id}`);
      await context.close();
    });

  it("changes an account by keyboard alone in three activations from its row, the outcome announced", async () => {
    // From the supplier's row, focused as a ledger link lands on it, using only the keyboard: Tab moves (navigation,
    // counted apart), Enter and Space activate (at most three), and the typed number is not counted (completion review).
    const { p, context } = await open("list", `/suppliers#${fynbos.id}`);
    await expect
      .poll(async () => {
        const f = await focused(p);
        return `${f.tag} ${f.anchor}`;
      })
      .toBe(`TR ${fynbos.id}`);
    let tabs = 0;
    let activations = 0;
    const tabTo = async (done: (f: Awaited<ReturnType<typeof focused>> & { label: string }) => boolean) => {
      for (let i = 0; i < 40; i++) {
        await p.keyboard.press("Tab");
        tabs++;
        const f = {
          ...(await focused(p)),
          label: await p.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""),
        };
        if (done(f)) return;
      }
      throw new Error("the control was not reached by Tab");
    };
    await tabTo((f) => f.label === "Change the Kestrel Bank account ending 307 for Fynbos Freight (Pty) Ltd");
    await p.keyboard.press("Enter");
    activations++;
    await p.waitForURL(`${origin}/suppliers?change=acc-fynbos`);
    expect((await focused(p)).text).toBe("Change Fynbos Freight (Pty) Ltd's account ending 307");
    expect(await p.locator("#change-bank").inputValue()).toBe("Kestrel Bank");
    await tabTo((f) => f.id === "change-number");
    await p.keyboard.type("1234567890");
    await tabTo((f) => f.tag === "INPUT" && f.id === "" && f.text === "");
    expect(await p.evaluate(() => (document.activeElement as HTMLInputElement).name)).toBe("confirm");
    await p.keyboard.press("Space");
    activations++;
    await tabTo((f) => f.text === "Save new account");
    await p.keyboard.press("Enter");
    activations++;
    await p.waitForURL(`${origin}/suppliers?r=account-changed`);
    expect(activations).toBe(3);
    // Every control between is a Tab away: the row's own controls first, then the form's three fields in order.
    expect(tabs).toBeLessThanOrEqual(12);
    expect(state.posts).toEqual([
      expect.objectContaining({
        action: "change-account",
        accountId: "acc-fynbos",
        accountNumber: "1234567890",
        confirm: "on",
      }),
    ]);
    expect((await focused(p)).text).toBe(
      "The account is changed: the new one is saved and the old one removed, both logged.",
    );
    await context.close();
  });

  it("asks before a link drops a typed supplier, keeps it when declined, and lets Cancel discard at once", async () => {
    const { p, context } = await open("list");
    const asked: string[] = [];
    let answer = false;
    p.on("dialog", (d) => {
      asked.push(d.message());
      void (answer ? d.accept() : d.dismiss());
    });
    await p.locator("#add-name").fill("Mossel Bay Couriers");
    const change = p.getByRole("link", {
      name: "Change the Kestrel Bank account ending 307 for Fynbos Freight (Pty) Ltd",
    });
    await change.click();
    await p.waitForTimeout(300);
    expect(asked).toEqual(["You have unsaved changes in the new supplier. Discard them?"]);
    expect(p.url()).toBe(`${origin}/suppliers`);
    expect(await p.locator("#add-name").inputValue()).toBe("Mossel Bay Couriers");
    answer = true;
    await change.click();
    await p.waitForURL(`${origin}/suppliers?change=acc-fynbos`);
    expect(asked).toHaveLength(2);
    await p.goto(`${origin}/suppliers`, { waitUntil: "load" });
    await p.locator("#add-name").fill("Mossel Bay Couriers");
    await p.locator("#add-supplier").getByRole("link", { name: "Cancel" }).click();
    await p.waitForURL(`${origin}/suppliers`);
    expect(asked).toHaveLength(2);
    expect(await p.locator("#add-name").inputValue()).toBe("");
    await context.close();
  });

  it("still asks about other unsaved work when a form's own Cancel is followed (round 1)", async () => {
    const { p, context } = await open("edit");
    const asked: string[] = [];
    p.on("dialog", (d) => {
      asked.push(d.message());
      void d.dismiss();
    });
    await p.locator("#add-name").fill("Mossel Bay Couriers");
    await p.locator("#edit").getByRole("link", { name: "Cancel" }).first().click();
    await p.waitForTimeout(300);
    expect(asked).toEqual(["You have unsaved changes in the new supplier. Discard them?"]);
    expect(await p.locator("#add-name").inputValue()).toBe("Mossel Bay Couriers");
    await context.close();
  });

  it("opens a ledger of 1,000 suppliers and answers a search quickly on a throttled phone profile", async () => {
    const context = await browser.newContext({ viewport: { width: 375, height: 800 } });
    const p = await context.newPage();
    const cdp = await context.newCDPSession(p);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    state.page = "thousand";
    const started = Date.now();
    await p.goto(`${origin}/suppliers`, { waitUntil: "load" });
    const opened = Date.now() - started;
    // First usable: the ledger painted (first contentful paint), as the review's target reads; `load` is recorded too.
    const painted = await p.evaluate(
      () => performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? Number.POSITIVE_INFINITY,
    );
    expect(await p.locator("[data-anchor-row]").count()).toBe(2000);
    const asked = Date.now();
    await p.locator("#supplier-search").fill("Supplier 777");
    await p.keyboard.press("Enter");
    await p.waitForURL(`${origin}/suppliers?q=Supplier+777`, { waitUntil: "load" });
    const searched = Date.now() - asked;
    expect(await p.locator("li[data-anchor-row]").count()).toBe(1);
    console.log(
      JSON.stringify({
        event: "ledger-timing",
        suppliers: 1000,
        cpu: "4x",
        paintedMs: Math.round(painted),
        loadedMs: opened,
        searchedMs: searched,
      }),
    );
    // The targets are 2 s to first paint and 1 s to a search's answer, measured on a quiet machine and recorded in
    // docs/frontier-log.md; the machine and CI runners are shared, so the search bound here is a backstop at three times
    // its target, as the forensics tests treat wall-clock.
    expect(painted).toBeLessThan(2000);
    expect(searched).toBeLessThan(3000);
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
