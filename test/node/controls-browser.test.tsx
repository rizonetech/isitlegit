import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Button } from "../../src/web/components/Button";
import { Checkbox } from "../../src/web/components/Checkbox";
import { Field } from "../../src/web/components/Field";
import { chromiumPath, launch } from "./browser";

// The controls in a real browser (D07 T01 §6): focus is visible, the keyboard activates what a mouse does, disabled
// controls do nothing, forms submit what they should, and the hover states are the board's, in both themes.
const ROOT = join(import.meta.dirname, "../..");
const DIR = join(ROOT, `build/test-controls-${process.pid}`);
const colors = JSON.parse(readFileSync(join(ROOT, "design/tokens/colors.json"), "utf-8")).themes;
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

const BODY = String(
  <main>
    <Button id="primary" variant="primary" data-action="primary">
      Primary
    </Button>
    <Button id="ghost" data-action="ghost">
      Ghost
    </Button>
    <Button id="dark" variant="dark" data-action="dark">
      Dark
    </Button>
    <Button id="go" href="#arrived" variant="link">
      Go
    </Button>
    <Button id="off" disabled disabledReason="The last owner cannot be removed" data-action="off">
      Remove
    </Button>
    <Button id="offlink" href="#never" disabled>
      Previous
    </Button>
    <form id="form">
      <Field id="email" name="email" label="Email" value="a@b.example" />
      <Checkbox id="consent" name="consent" value="yes" required>
        I agree
      </Checkbox>
      <Checkbox id="locked" name="locked" disabled>
        Locked
      </Checkbox>
      <Button id="plain" data-action="plain">
        Plain
      </Button>
      <Button id="submit" type="submit" variant="primary">
        Save
      </Button>
    </form>
  </main>,
);
const SCRIPT = `
window.events = [];
document.addEventListener("click", (e) => { const a = e.target.closest("[data-action]"); if (a) window.events.push(a.dataset.action); });
document.getElementById("form").addEventListener("submit", (e) => {
  e.preventDefault();
  window.events.push("submit:" + new URLSearchParams(new FormData(e.target)).toString());
});`;

let browser: Browser;
let css = "";

beforeAll(async () => {
  mkdirSync(DIR, { recursive: true });
  const out = join(DIR, "app.css");
  const run = spawnSync(process.execPath, [join(ROOT, "scripts/build-css.ts"), "--no-tokens", "--out", out], {
    encoding: "utf-8",
  });
  expect(run.status, run.stderr).toBe(0);
  css = readFileSync(out, "utf-8");
  browser = await launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  rmSync(DIR, { recursive: true, force: true });
});

async function open(theme: "light" | "dark" = "light"): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(
    `<!doctype html><html data-theme="${theme}"><head><style>${css}</style></head><body>${BODY}<script>${SCRIPT}</script></body></html>`,
  );
  return page;
}
const events = (page: Page) => page.evaluate(() => (window as unknown as { events: string[] }).events);

describe.skipIf(!chromiumPath() && !process.env.CI)("controls in Chromium", () => {
  it("shows a visible focus ring on every control reached with Tab", async () => {
    const page = await open();
    const reached: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Tab");
      const focus = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        const s = getComputedStyle(el);
        return { id: el.id, outline: `${s.outlineStyle} ${s.outlineWidth}` };
      });
      if (focus.id) reached[focus.id] = focus.outline;
    }
    for (const id of ["primary", "ghost", "dark", "go", "email", "consent", "plain", "submit"]) {
      expect(reached[id], `${id} reached`).toBeDefined();
      expect(reached[id], `${id} focus ring`).toMatch(/^solid [1-9]/);
    }
    expect(Object.keys(reached)).not.toContain("off");
    await page.close();
  });

  it("activates buttons with Enter and Space, follows a link with Enter, and does nothing when disabled", async () => {
    const page = await open();
    await page.focus("#primary");
    await page.keyboard.press("Enter");
    await page.focus("#ghost");
    await page.keyboard.press("Space");
    await page.focus("#go");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => location.hash)).toBe("#arrived");
    await page.click("#off", { force: true });
    await page.click("#offlink", { force: true });
    expect(await page.evaluate(() => location.hash)).toBe("#arrived");
    expect(await events(page)).toEqual(["primary", "ghost"]);
    expect(await page.getAttribute("#off", "aria-describedby")).toBe("off-reason");
    expect(await page.textContent("#off-reason")).toBe("The last owner cannot be removed");
    await page.close();
  });

  it("submits only from the submit button, with the checkbox's value only when checked and required", async () => {
    const page = await open();
    await page.click("#plain");
    await page.click("#submit"); // the required box is unchecked: the browser blocks the submission
    expect(await events(page)).toEqual(["plain"]);
    await page.click("text=I agree"); // the label toggles the box
    expect(await page.isChecked("#consent")).toBe(true);
    await page.focus("#consent");
    await page.keyboard.press("Space");
    expect(await page.isChecked("#consent")).toBe(false);
    await page.keyboard.press("Space");
    await page.click("text=Locked", { force: true });
    expect(await page.isChecked("#locked")).toBe(false);
    await page.click("#submit");
    expect(await events(page)).toEqual(["plain", "submit:email=a%40b.example&consent=yes"]);
    await page.close();
  });

  it("re-renders a checked box as checked", async () => {
    const page = await browser.newPage();
    await page.setContent(
      String(
        <Checkbox id="c" name="c" checked>
          x
        </Checkbox>,
      ),
    );
    expect(await page.isChecked("#c")).toBe(true);
    await page.close();
  });

  for (const theme of ["light", "dark"] as const)
    it(`uses the board's hover colours in the ${theme} theme`, async () => {
      const page = await open(theme);
      const t = colors[theme];
      const after = async (id: string, prop: "backgroundColor" | "borderTopColor") => {
        await page.hover(`#${id}`);
        return page.evaluate(
          ([i, p]) => getComputedStyle(document.getElementById(i as string) as Element)[p as "color"],
          [id, prop],
        );
      };
      expect(await after("primary", "backgroundColor")).toBe(rgb(t["accent-hover"]));
      expect(await after("ghost", "borderTopColor")).toBe(rgb(t.ink));
      expect(await after("dark", "backgroundColor")).toBe(rgb(t["dark-active"]));
      await page.close();
    });
});
