import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium } from "playwright-core";

// The Chromium every browser test uses, as design/tools/export-mockups.py picks it: MOCKUP_CHROMIUM, else Playwright's
// headless shell, else chromium or google-chrome on PATH. CI names Google Chrome, whose sandbox works on the runner.
export function chromiumPath(): string | undefined {
  if (process.env.MOCKUP_CHROMIUM) return process.env.MOCKUP_CHROMIUM;
  const cache = join(process.env.HOME ?? "", ".cache/ms-playwright");
  const shell = existsSync(cache)
    ? readdirSync(cache)
        .filter((d) => d.startsWith("chromium_headless_shell-"))
        .sort()
        .map((d) => join(cache, d, "chrome-headless-shell-linux64/chrome-headless-shell"))
        .filter(existsSync)
        .pop()
    : undefined;
  if (shell) return shell;
  for (const name of ["chromium", "chromium-browser", "google-chrome"]) {
    const found = spawnSync("which", [name], { encoding: "utf-8" }).stdout.trim();
    if (found) return found;
  }
  return undefined;
}

// Chromium driven by playwright-core (real keyboard and mouse input), sandboxed and offline: every request but loopback
// goes to a proxy nothing listens on.
export function launch(): Promise<Browser> {
  const executablePath = chromiumPath();
  if (!executablePath) throw new Error("no headless Chromium found; set MOCKUP_CHROMIUM");
  return chromium.launch({
    executablePath,
    chromiumSandbox: true,
    args: ["--proxy-server=127.0.0.1:9", "--no-first-run"],
  });
}
