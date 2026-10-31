// The demo capture rig's shared pieces (D09 T02 §3; docs/specs/2026-10-31-demo-video-design.md): the browser, the
// live service it records, and the on-screen boxes Remotion zooms to. Every capture drives the live service with
// synthetic fixtures only (media/capture/fixtures/), signed in as the demo mailbox through one persistent profile kept
// outside the repository, so no password ever passes through a script after the first sign-in.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright-core";
import { showPointer } from "./cursor.ts";

export const APP = process.env.CAPTURE_APP ?? "https://app.isitlegit.co.za";
export const MAILBOX = "demo@rizonetech.com";
export const ORGANISATION = "Fynbos Freight";
export const PROFILE = process.env.CAPTURE_PROFILE ?? join(homedir(), "isitlegit-data", "media", "demo-profile");
// Every video is 1920 x 1080 (media/README.md), and so is every capture: a clip drops into a scene unscaled.
export const SIZE = { width: 1920, height: 1080 };

export type Box = { x: number; y: number; width: number; height: number };

/** The Chromium to drive: CAPTURE_CHROME, else the newest one Playwright has cached. */
export function chrome(cache = join(homedir(), ".cache", "ms-playwright")): string {
  if (process.env.CAPTURE_CHROME) return process.env.CAPTURE_CHROME;
  const builds = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)) : [];
  builds.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const build of builds) {
    for (const dir of ["chrome-linux64", "chrome-linux"]) {
      const path = join(cache, build, dir, "chrome");
      if (existsSync(path)) return path;
    }
  }
  throw new Error(`no Chromium under ${cache}; set CAPTURE_CHROME`);
}

/** The persistent browser, recording each new page to videoDir when one is given, with a visible pointer. */
export async function open(videoDir?: string): Promise<BrowserContext> {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: chrome(),
    headless: true,
    viewport: SIZE,
    deviceScaleFactor: 1,
    locale: "en-ZA",
    timezoneId: "Africa/Johannesburg",
    colorScheme: "light",
    ...(videoDir ? { recordVideo: { dir: videoDir, size: SIZE } } : {}),
  });
  // A recording has no mouse cursor of its own: draw one, so each click and keystroke is seen (capture/cursor.ts).
  if (videoDir) await showPointer(ctx);
  return ctx;
}

/** Where an element sits on screen, for a scene's zoom and callout; null when it is not on the page. */
export async function box(page: Page, selector: string): Promise<Box | null> {
  const el = page.locator(selector).first();
  if (!(await el.count())) return null;
  const b = await el.boundingBox();
  return b ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : null;
}

/** The commit the live Worker reports, recorded with every capture as proof it is the live service. */
export async function liveCommit(): Promise<string | null> {
  const res = await fetch(`${APP}/health`);
  if (!res.ok) return null;
  const body = (await res.json()) as { commit?: string };
  return body.commit ?? null;
}
