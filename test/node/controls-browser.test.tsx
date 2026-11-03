import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Button } from "../../src/web/components/Button";
import { Checkbox } from "../../src/web/components/Checkbox";
import { Field } from "../../src/web/components/Field";
import { Select } from "../../src/web/components/Select";
import { chromiumPath, focused, launch } from "./browser";

// The controls in a real browser (D07 T01 §6): focus is visible, the keyboard activates what a mouse does, disabled
// controls do nothing, forms submit what they should, and the hover states are the board's, in both themes.
const ROOT = join(import.meta.dirname, "../..");
const DIR = join(ROOT, `build/test-controls-${process.pid}`);
const colors = JSON.parse(readFileSync(join(ROOT, "design/tokens/colors.json"), "utf-8")).themes;
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

// Every variant and size sits on each background the boards place controls on, so the focus ring is measured against
// what is really beside it. The backgrounds come from token variables (inline here, since a test's own classes are not
// compiled into the stylesheet).
const BACKGROUNDS = ["subtle", "light", "orange-wash"];
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
    <Button id="offlink" href="#never" disabled data-action="offlink">
      Previous
    </Button>
    <Button id="ariaoff" aria-disabled="true" data-action="ariaoff">
      Marked
    </Button>
    {BACKGROUNDS.map((bg) => (
      <div style={`background: var(--color-${bg}); padding: 8px`}>
        <Button id={`${bg}-primary`} variant="primary">
          P
        </Button>
        <Button id={`${bg}-danger`} variant="danger">
          D
        </Button>
        <Button id={`${bg}-small`} size="small">
          S
        </Button>
        <Button id={`${bg}-link`} variant="link">
          L
        </Button>
      </div>
    ))}
    <form id="form">
      <Field id="email" name="email" label="Email" value="a@b.example" />
      <Field id="notes" name="notes" label="Notes" rows={2} value="Check this" />
      <Field id="bad" name="bad" label="Bad" error="Enter a value" />
      <div id="select-row" class="flex items-center gap-8">
        <label for="verdict" class="text-14">
          Verdict
        </label>
        <Select id="verdict" name="verdict">
          <option value="all" selected>
            All verdicts
          </option>
          <option value="malicious">Malicious</option>
          <option value="safe">Safe</option>
        </Select>
      </div>
      <div id="select-col" class="flex flex-col gap-6" style="width: 260px">
        <label for="locked-select" class="text-14">
          Locked select
        </label>
        <Select id="locked-select" name="lockedSelect" disabled>
          <option value="owner" selected>
            Owner
          </option>
          <option value="member">Member</option>
        </Select>
      </div>
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
    // The body carries the theme surface, as every page's document does, so contrast is measured against it.
    `<!doctype html><html data-theme="${theme}"><head><style>${css}</style></head><body class="bg-surface text-ink">${BODY}<script>${SCRIPT}</script></body></html>`,
  );
  return page;
}
const events = (page: Page) => page.evaluate(() => (window as unknown as { events: string[] }).events);

// A real browser on a loaded CI runner can take longer than Vitest's 5 s default for one test (run 40481145558).
describe.skipIf(!chromiumPath() && !process.env.CI)("controls in Chromium", { timeout: 30_000 }, () => {
  for (const theme of ["light", "dark"] as const)
    it(`shows a 3:1+ focus indicator on every control reached with Tab: outline on buttons/links/checkboxes and one-border on fields/selects, invalid fields included (${theme})`, async () => {
      const page = await open(theme);
      const t = colors[theme];
      const reached: Record<string, { outline: string; border: string; borderColor: string; contrast: number }> = {};
      for (let i = 0; i < 35; i++) {
        await page.keyboard.press("Tab");
        const focus = await focused(page);
        // Past the last control focus returns to the document itself, which has nothing behind it to measure.
        if (!focus) continue;
        const id = focus.key;
        expect(focus.opaque, `an opaque background behind ${id}`).toBe(true);
        reached[id] = {
          outline: focus.outline,
          border: focus.border,
          borderColor: focus.borderColor,
          contrast: focus.contrast,
        };
      }
      const placed = BACKGROUNDS.flatMap((bg) => ["primary", "danger", "small", "link"].map((v) => `${bg}-${v}`));
      for (const id of ["primary", "ghost", "dark", "go", ...placed, "consent", "plain", "submit"]) {
        expect(reached[id], `${id} reached`).toBeDefined();
        expect(reached[id]?.outline, `${id} focus ring`).toMatch(/^solid [1-9]/);
        expect(reached[id]?.contrast, `${id} focus contrast`).toBeGreaterThanOrEqual(3);
      }
      for (const id of ["email", "notes", "bad", "verdict"]) {
        expect(reached[id], `${id} reached`).toBeDefined();
        expect(reached[id]?.outline, `${id} has no second outline`).toMatch(/^none\b/);
        expect(reached[id]?.border, `${id} keeps its 1 px solid border`).toBe("solid 1px");
        expect(reached[id]?.borderColor, `${id} switches its border to orange-text`).toBe(rgb(t["orange-text"]));
        expect(reached[id]?.contrast, `${id} focus border contrast`).toBeGreaterThanOrEqual(3);
      }
      for (const id of ["off", "offlink", "ariaoff", "locked", "locked-select"])
        expect(Object.keys(reached)).not.toContain(id);
      await page.close();
    });

  for (const theme of ["light", "dark"] as const)
    it(`visibly switches an invalid field's border from mal to orange-text on focus and restores mal on blur while keeping aria-invalid and the error message (${theme})`, async () => {
      const page = await open(theme);
      const t = colors[theme];
      const state = () =>
        page.evaluate(() => {
          const el = document.getElementById("bad") as HTMLElement;
          const err = document.getElementById("bad-error") as HTMLElement;
          const s = getComputedStyle(el);
          return {
            outline: s.outlineStyle,
            border: s.borderTopColor,
            ariaInvalid: el.getAttribute("aria-invalid"),
            errorText: err?.textContent,
            errorVisible: err ? getComputedStyle(err).display !== "none" : false,
          };
        });
      expect(await state()).toEqual({
        outline: "none",
        border: rgb(t.mal),
        ariaInvalid: "true",
        errorText: "Enter a value",
        errorVisible: true,
      });
      await page.focus("#bad");
      expect(await state()).toEqual({
        outline: "none",
        border: rgb(t["orange-text"]),
        ariaInvalid: "true",
        errorText: "Enter a value",
        errorVisible: true,
      });
      await page.focus("#email");
      expect(await state()).toEqual({
        outline: "none",
        border: rgb(t.mal),
        ariaInvalid: "true",
        errorText: "Enter a value",
        errorVisible: true,
      });
      await page.close();
    });

  it("restores a 2 px solid outline on focused valid and invalid fields and selects in forced-colors mode", async () => {
    const context = await browser.newContext({ forcedColors: "active" });
    const page = await context.newPage();
    await page.setContent(
      `<!doctype html><html data-theme="light"><head><style>${css}</style></head><body class="bg-surface text-ink">${BODY}</body></html>`,
    );
    for (const id of ["email", "notes", "bad", "verdict"]) {
      await page.focus(`#${id}`);
      const outline = await page.evaluate((sel) => {
        const s = getComputedStyle(document.getElementById(sel) as HTMLElement);
        return `${s.outlineStyle} ${s.outlineWidth}`;
      }, id);
      expect(outline, `${id} in forced-colors mode`).toBe("solid 2px");
    }
    await context.close();
  });

  for (const theme of ["light", "dark"] as const)
    it(`draws Select with appearance: none and its ChevronIcon inset 12 px from the right edge in both row and column layouts (${theme})`, async () => {
      const page = await open(theme);
      for (const id of ["verdict", "locked-select"]) {
        const box = await page.evaluate((sel) => {
          const select = document.getElementById(sel) as HTMLSelectElement;
          const svg = select.parentElement?.querySelector("svg") as SVGElement;
          const sr = select.getBoundingClientRect();
          const vr = svg.getBoundingClientRect();
          return {
            appearance: getComputedStyle(select).appearance,
            pointerEvents: getComputedStyle(svg).pointerEvents,
            rightInset: Math.round(sr.right - vr.right),
            insideVertically: vr.top >= sr.top && vr.bottom <= sr.bottom,
            insideHorizontally: vr.left >= sr.left && vr.right <= sr.right,
          };
        }, id);
        expect(box, `${id} in ${theme}`).toEqual({
          appearance: "none",
          pointerEvents: "none",
          rightInset: 12,
          insideVertically: true,
          insideHorizontally: true,
        });
      }
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
    // A pointer reaches none of them, so neither a native handler nor a delegated one on their data hooks fires.
    for (const id of ["off", "offlink", "ariaoff"]) await page.click(`#${id}`, { force: true });
    // The keyboard cannot reach them either: focus stays where it was, and Enter and Space do nothing.
    for (const id of ["off", "offlink", "ariaoff"]) {
      await page.focus("#go");
      expect(
        await page.evaluate(
          (i) => (document.getElementById(i) as HTMLElement).focus() ?? document.activeElement?.id,
          id,
        ),
      ).toBe("go");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Space");
    }
    expect(await page.evaluate(() => location.hash)).toBe("#arrived");
    expect(await events(page)).toEqual(["primary", "ghost"]);
    expect(await page.evaluate(() => location.hash)).toBe("#arrived");
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
    await page.focus("#verdict");
    await page.keyboard.press("ArrowDown");
    expect(await page.inputValue("#verdict")).toBe("malicious");
    await page.click("#submit");
    expect(await events(page)).toEqual([
      "plain",
      "submit:email=a%40b.example&notes=Check+this&bad=&verdict=malicious&consent=yes",
    ]);
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
  // D07 T01 §8: a button was `whitespace-nowrap` at a fixed height, so at 200% text "Go to your own cases" ran past a
  // 360 px window. It keeps the control height on one line and wraps, growing taller, only when its words cannot fit.
  it("keeps one line at the control heights and wraps long words inside a narrow container", async () => {
    const page = await browser.newPage();
    await page.setContent(
      `<!doctype html><html data-theme="light"><head><style>${css}</style></head><body class="bg-surface text-ink">${String(
        <div>
          <Button id="one">Go</Button>
          <Button id="small" size="small">
            Go
          </Button>
          <div style="width: 200px">
            <Button id="long" variant="dark">
              Go to your own cases
            </Button>
          </div>
        </div>,
      )}</body></html>`,
    );
    const size = (id: string) =>
      page.evaluate((sel) => {
        const r = (document.getElementById(sel) as HTMLElement).getBoundingClientRect();
        return { width: r.width, height: r.height };
      }, id);
    expect((await size("one")).height).toBe(48);
    expect((await size("small")).height).toBe(36);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    const long = await size("long");
    expect(long.width, "never wider than its container").toBeLessThanOrEqual(200);
    expect(long.height, "taller, with its words wrapped").toBeGreaterThan(48);
    const fits = await page.evaluate(() => {
      const el = document.getElementById("long") as HTMLElement;
      return el.scrollWidth <= el.clientWidth;
    });
    expect(fits, "its words stay inside it").toBe(true);
    await page.close();
  });
});
