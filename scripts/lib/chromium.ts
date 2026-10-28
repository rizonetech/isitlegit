import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The Chromium the browser tests and the Loupe data scripts use (D03 T04 §5, §6), as design/tools/export-mockups.py picks it: MOCKUP_CHROMIUM, else Playwright's
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
