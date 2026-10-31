// A sanitised logo draws exactly as the uploaded one (D05 T01 §1's completion review): Chromium renders both as
// images, the way the console shows a logo, and every pixel must agree. A sanitiser that lowercased `viewBox` or
// dropped a gradient or clip would change the picture.
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sanitiseSvg } from "../../src/trust/svg";
import { chromiumPath, launch } from "./browser";

const LOGOS = {
  "gradient and clip": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20" preserveAspectRatio="xMidYMid meet"><defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" x2="40"><stop offset="0" stop-color="#FF4A14"/><stop offset="1" stop-color="#1A1A1A"/></linearGradient><clipPath id="c"><circle cx="20" cy="10" r="9"/></clipPath></defs><g clip-path="url(#c)"><rect width="40" height="20" fill="url(#g)"/></g></svg>`,
  "paths and transforms": `<?xml version="1.0" encoding="UTF-8"?><!-- exported --><svg xmlns="http://www.w3.org/2000/svg" width="64" height="32" viewBox="0 0 64 32"><g transform="translate(4 4) scale(1.5)"><path d="M0 0 L16 0 L8 14 Z" fill="#FF4A14" stroke="#1A1A1A" stroke-width="1.5"/><radialGradient id="r"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#FF4A14"/></radialGradient><circle cx="28" cy="7" r="6" fill="url(#r)"/></g></svg>`,
};

let browser: Browser;
beforeAll(async () => {
  if (chromiumPath()) browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});

async function render(svg: string): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: 320, height: 160 } });
  try {
    const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    await page.setContent(`<body style="margin:0;background:#fff"><img src="${src}" width="320" height="160"></body>`);
    await page.waitForFunction(() => document.images[0]?.complete);
    return await page.screenshot();
  } finally {
    await page.close();
  }
}

// Uploads that once produced documents an XML parser refused (completion review and rounds 1 and 2): every rebuilt
// document must parse as XML in the browser, the parser the logo is finally read by.
const TRICKY = [
  '<s:svg xmlns:s="http://www.w3.org/2000/svg" xmlns="urn:other"><s:path d="M0 0"/></s:svg>',
  '<svg><text x="1">R &amp; D &lt;3</text><path d="M0 0" fill="url(#g)"/></svg>',
  '<svg xmlns:a="urn:a" a:foo="1"><path d="M0 0" a:bar="2" xml:space="preserve"/></svg>',
  "<svg><path d='M0 0' fill='\"red\"'/></svg>",
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:XLINK="http://www.w3.org/1999/xlink"><use XLINK:href="#x"/><rect id="x" width="10" height="10"/></svg>',
  '<svg xmlns:o="urn:other"><o:path d="M9 9"/><path d="M0 0" ViewBox="0 0 1 1"/></svg>',
];

describe.skipIf(!chromiumPath() && !process.env.CI)("rebuilt logos parse as XML", { timeout: 120_000 }, () => {
  it("every tricky upload rebuilds to a document the browser's XML parser accepts", async () => {
    const page = await browser.newPage();
    try {
      for (const svg of TRICKY) {
        const clean = sanitiseSvg(svg);
        const error = await page.evaluate((doc) => {
          const parsed = new DOMParser().parseFromString(doc, "image/svg+xml");
          return parsed.getElementsByTagName("parsererror").length ? parsed.documentElement.textContent : null;
        }, clean);
        expect(error, clean).toBeNull();
      }
    } finally {
      await page.close();
    }
  });
});

describe.skipIf(!chromiumPath() && !process.env.CI)("sanitised logos render as uploaded", { timeout: 120_000 }, () => {
  for (const [name, svg] of Object.entries(LOGOS))
    it(name, async () => {
      const clean = sanitiseSvg(svg);
      expect(Buffer.compare(await render(clean), await render(svg))).toBe(0);
      // And the comparison can fail: a lowercased view box or gradient draws differently.
      const broken =
        name === "gradient and clip"
          ? clean.replace("viewBox", "viewbox")
          : clean.replaceAll("radialGradient", "radialgradient");
      expect(Buffer.compare(await render(broken), await render(svg))).not.toBe(0);
    });
});
