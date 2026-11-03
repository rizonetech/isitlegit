// A visible pointer for the demo capture (D09 T02 §3). Playwright's recorded video has no mouse cursor, so a page
// looked static in the demo even while the rig clicked and typed. Every recorded page gets a drawn arrow that follows
// the real mouse events Playwright sends, a ring on every press, and helpers that glide the mouse to a control before
// pressing it, so the video shows each click and keystroke as a person would make them. The overlay is built with
// DOM calls only (no innerHTML), so it also runs under Outlook's Trusted Types policy, and it never takes a click.
import type { BrowserContext, Locator, Page } from "playwright-core";

/** Runs in every page before its own scripts: draws the pointer and its press ring. */
function installPointer(): void {
  const NS = "http://www.w3.org/2000/svg";
  const mount = () => {
    if (document.getElementById("__demo-pointer")) return;
    const root = document.documentElement;
    const pointer = document.createElementNS(NS, "svg");
    pointer.id = "__demo-pointer";
    pointer.setAttribute("width", "30");
    pointer.setAttribute("height", "30");
    pointer.setAttribute("viewBox", "0 0 24 24");
    const arrow = document.createElementNS(NS, "path");
    arrow.setAttribute("d", "M3 2 L3 19 L7.6 14.8 L10.6 21.4 L13.4 20.2 L10.5 13.7 L16.8 13.7 Z");
    arrow.setAttribute("fill", "#111");
    arrow.setAttribute("stroke", "#fff");
    arrow.setAttribute("stroke-width", "1.4");
    arrow.setAttribute("stroke-linejoin", "round");
    pointer.appendChild(arrow);
    const ring = document.createElement("div");
    ring.id = "__demo-ring";
    for (const [el, z] of [[ring, "2147483646"], [pointer, "2147483647"]] as const) {
      const st = (el as HTMLElement).style;
      st.position = "fixed";
      st.left = "0px";
      st.top = "0px";
      st.pointerEvents = "none";
      st.zIndex = z;
    }
    pointer.style.transform = "translate(-100px, -100px)";
    pointer.style.filter = "drop-shadow(0 2px 3px rgba(0,0,0,0.45))";
    Object.assign(ring.style, {
      width: "44px",
      height: "44px",
      marginLeft: "-22px",
      marginTop: "-22px",
      borderRadius: "50%",
      border: "3px solid #FF4A14",
      background: "rgba(255,74,20,0.18)",
      opacity: "0",
      transition: "opacity 420ms ease-out, transform 420ms ease-out",
    });
    root.appendChild(ring);
    root.appendChild(pointer);
    let x = -100;
    let y = -100;
    addEventListener(
      "mousemove",
      (e) => {
        x = e.clientX;
        y = e.clientY;
        pointer.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
      },
      true,
    );
    addEventListener(
      "mousedown",
      () => {
        ring.style.transition = "none";
        ring.style.transform = `translate(${x}px, ${y}px) scale(0.4)`;
        ring.style.opacity = "1";
        void ring.offsetWidth;
        ring.style.transition = "opacity 420ms ease-out, transform 420ms ease-out";
        ring.style.transform = `translate(${x}px, ${y}px) scale(1.25)`;
        ring.style.opacity = "0";
      },
      true,
    );
  };
  if (document.documentElement) mount();
  else addEventListener("DOMContentLoaded", mount);
}

/** Draw the pointer on every page this context opens from now on. */
export async function showPointer(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(installPointer);
}

const where = new WeakMap<Page, { x: number; y: number }>();
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Glide the mouse to (x, y) along an eased path, about as fast as a hand moves, so the pointer is seen travelling. */
export async function glide(page: Page, x: number, y: number, ms?: number): Promise<void> {
  const from = where.get(page) ?? { x: 960, y: 620 };
  const dist = Math.hypot(x - from.x, y - from.y);
  const duration = ms ?? Math.min(900, 280 + dist * 0.55);
  const steps = Math.max(8, Math.round(duration / 16));
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    await page.mouse.move(from.x + (x - from.x) * t, from.y + (y - from.y) * t);
    await page.waitForTimeout(duration / steps);
  }
  where.set(page, { x, y });
}

/** Bring a control into view and glide onto it; returns false when it is not on the page. */
export async function hoverOn(target: Locator, hold = 500): Promise<boolean> {
  const page = target.page();
  const el = target.first();
  if (!(await el.count())) return false;
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const b = await el.boundingBox();
  if (!b) return false;
  await glide(page, b.x + Math.min(b.width / 2, 160), b.y + b.height / 2);
  await page.waitForTimeout(hold);
  return true;
}

/** Glide onto a control and press it, with the pause before the press a person makes. */
export async function clickOn(target: Locator, hold = 260): Promise<void> {
  const page = target.page();
  if (!(await hoverOn(target, hold))) throw new Error(`nothing to click for ${target}`);
  await page.mouse.down();
  await page.waitForTimeout(70);
  await page.mouse.up();
}

/** Press a field, then type into it at a readable pace. */
export async function typeInto(target: Locator, text: string, delay = 45): Promise<void> {
  await clickOn(target);
  await target.page().waitForTimeout(200);
  await target.page().keyboard.type(text, { delay });
}

/** Scroll by dy pixels in small wheel steps, so the page is seen moving rather than jumping. */
export async function smoothScroll(page: Page, dy: number, step = 80, pause = 45): Promise<void> {
  const n = Math.max(1, Math.round(Math.abs(dy) / step));
  for (let i = 0; i < n; i++) {
    await page.mouse.wheel(0, Math.sign(dy) * step);
    await page.waitForTimeout(pause);
  }
}
