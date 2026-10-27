import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_CSS, FONTS } from "../../src/web/assets.ts";

// The browser actually loads the self-hosted fonts: public/ is served from a loopback HTTP server, a page links the
// shipped stylesheet, and headless Chromium (offline but for loopback) reports which faces `document.fonts` loaded at
// each weight. A stylesheet with a broken font URL or a misspelt family must come back empty.
const ROOT = join(import.meta.dirname, "../..");
const PUBLIC = join(ROOT, "public");
const WEIGHTS = [400, 700, 900];
const TYPES: Record<string, string> = { ".css": "text/css", ".woff2": "font/woff2", ".html": "text/html" };

function chromium(): string | undefined {
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

const BROWSER = chromium();
const shipped = readFileSync(join(PUBLIC, APP_CSS), "utf-8");
// Variants the server answers alongside public/: the shipped stylesheet with its font URLs broken, or with the families
// misspelt.
const VARIANTS: Record<string, string> = {
  "/broken.css": shipped.replaceAll("/static/fonts/", "/static/fonts/missing-"),
  // The minifier writes `Exo` unquoted and `"Exo 2"` quoted; either spelling is renamed.
  "/misspelt.css": shipped
    .replace(/font-family:"?Exo"?(?=[;}])/g, "font-family:Exo1")
    .replace(/font-family:"Exo 2"(?=[;}])/g, 'font-family:"Exo3"'),
};
const page = (
  css: string,
) => `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${css}"></head>
<body><p style="font-family: Exo">a</p><p style="font-family: 'Exo 2'">b</p><pre id="out"></pre><script>
(async () => {
  const out = {};
  for (const family of ${JSON.stringify(Object.keys(FONTS))}) {
    out[family] = {};
    for (const weight of ${JSON.stringify(WEIGHTS)}) {
      const faces = await document.fonts.load(weight + ' 16px "' + family + '"').catch(() => []);
      out[family][weight] = faces.filter((f) => f.status === "loaded").length;
    }
  }
  document.getElementById("out").textContent = JSON.stringify(out);
})();
</script></body></html>`;

let server: Server;
let origin = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const fixture = /^\/page(\/.*\.css)$/.exec(path);
    if (fixture) return res.writeHead(200, { "content-type": "text/html" }).end(page(fixture[1] as string));
    if (VARIANTS[path] !== undefined) return res.writeHead(200, { "content-type": "text/css" }).end(VARIANTS[path]);
    const file = normalize(join(PUBLIC, path));
    if (!file.startsWith(PUBLIC) || !existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));

// Opens the page for one stylesheet and returns {family: {weight: loaded faces}}. Asynchronous, so this process keeps
// serving while Chromium fetches.
function measure(css: string): Promise<Record<string, Record<string, number>>> {
  const profile = mkdtempSync(join(tmpdir(), "fonts-profile-"));
  return new Promise((resolve, reject) => {
    const child = spawn(
      BROWSER as string,
      [
        "--headless",
        "--proxy-server=127.0.0.1:9",
        "--no-first-run",
        `--user-data-dir=${profile}`,
        "--virtual-time-budget=5000",
        "--dump-dom",
        `${origin}/page${css}`,
      ],
      { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: profile } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      rmSync(profile, { recursive: true, force: true });
      const json = /<pre id="out">([^<]*)<\/pre>/.exec(stdout)?.[1];
      if (!json)
        return reject(
          new Error(`Chromium measured nothing (exit ${code}): ${stderr.split("\n").slice(-3).join(" | ")}`),
        );
      resolve(JSON.parse(json.replaceAll("&quot;", '"').replaceAll("&amp;", "&")));
    });
  });
}

describe.skipIf(!BROWSER && !process.env.CI)("self-hosted fonts in Chromium", () => {
  it("loads Exo and Exo 2 from the shipped stylesheet at every weight", async () => {
    expect(BROWSER, "CI must have a Chromium (set MOCKUP_CHROMIUM)").toBeTruthy();
    const loaded = await measure(APP_CSS);
    for (const family of Object.keys(FONTS))
      for (const weight of WEIGHTS) expect(loaded[family]?.[weight], `${family} ${weight}`).toBe(1);
  }, 90_000);

  it("loads nothing when a font URL is broken or a family is misspelt", async () => {
    for (const css of ["/broken.css", "/misspelt.css"]) {
      const loaded = await measure(css);
      for (const family of Object.keys(FONTS))
        for (const weight of WEIGHTS) expect(loaded[family]?.[weight], `${css} ${family} ${weight}`).toBe(0);
    }
  }, 150_000);
});
