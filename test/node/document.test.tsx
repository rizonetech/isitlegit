import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";
import { APP_CSS, FONTS, LOGO, LOGO_MARK, LOGO_ON_DARK } from "../../src/web/assets";
import { AppShell } from "../../src/web/components/AppShell";
import { Document } from "../../src/web/components/Document";
import { admin, member } from "./shell-fixtures";

// The document every page renders into (D07 T01 §3): its head names the shipped stylesheet, fonts and icon, and every
// URL a framed page names answers 200 from the Worker as wrangler.jsonc serves it. (No route renders a page until
// D07 T02, so the document is rendered here and its URLs are fetched from the Worker: they are what goes stale.)
const ROOT = join(import.meta.dirname, "../..");
const html = (node: unknown) => String(node);
let worker: Awaited<ReturnType<typeof unstable_startWorker>>;

beforeAll(async () => {
  worker = await unstable_startWorker({
    config: join(ROOT, "wrangler.jsonc"),
    dev: { server: { port: 0 }, inspector: false, logLevel: "error" },
  });
  await worker.ready;
}, 120_000);
// Stopping workerd can outlast the default 10 s hook budget on the CI runner while another Worker test shuts down beside
// it (run 40457777968), so teardown gets the same explicit budget as startup.
afterAll(async () => {
  await worker?.dispose();
}, 120_000);

describe("Document", () => {
  const page = html(
    <Document title="Cases" scripts={<script src="/static/app.000000000000.js" />}>
      <p id="body">x</p>
    </Document>,
  );

  it("is an English HTML document with its charset, viewport and the page's title", () => {
    expect(page.startsWith('<!doctype html><html lang="en">')).toBe(true);
    expect(page).toContain('<meta charset="utf-8"/>');
    expect(page).toContain('<meta name="viewport" content="width=device-width, initial-scale=1"/>');
    expect(page).toContain("<title>Cases · IsItLegit</title>");
  });

  it("loads the shipped stylesheet, preloads both fonts and names the mark as its icon", () => {
    expect(page).toContain(`<link rel="stylesheet" href="${APP_CSS}"/>`);
    for (const href of Object.values(FONTS))
      expect(page).toContain(
        `<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin="anonymous"/>`,
      );
    expect(page).toContain(`<link rel="icon" href="${LOGO_MARK}" type="image/svg+xml"/>`);
  });

  it("puts the page in the body and the scripts slot after it", () => {
    expect(page).toMatch(
      /<body class="bg-surface text-ink[^"]*"><p id="body">x<\/p><script src="\/static\/app\.000000000000\.js"><\/script><\/body>/,
    );
  });

  it("refuses a page without a title", () => {
    expect(() => html(<Document title=" ">x</Document>)).toThrow("needs a title");
  });

  it("names only URLs the Worker serves, in every frame", async () => {
    const pages = [
      html(
        <Document title="Cases">
          <AppShell {...member()} />
        </Document>,
      ),
      html(
        <Document title="Overview">
          <AppShell {...admin()} />
        </Document>,
      ),
      html(
        <Document title="Report">
          <AppShell variant="public">
            <h1>Report</h1>
          </AppShell>
        </Document>,
      ),
    ].join("");
    const named = [...new Set([...pages.matchAll(/(?:href|src)="(\/static\/[^"]+)"/g)].map((m) => m[1] as string))];
    for (const url of [APP_CSS, ...Object.values(FONTS), LOGO, LOGO_ON_DARK, LOGO_MARK]) expect(named).toContain(url);
    for (const url of named) expect((await worker.fetch(`http://localhost${url}`)).status, url).toBe(200);
  });
});
