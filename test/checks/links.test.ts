import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CaseView } from "../../src/checks/case-view";
import { readCheckOutcomes, readEvidence } from "../../src/checks/evidence";
import { htmlAttachmentsOf } from "../../src/checks/html-attachment";
import { checks as registry } from "../../src/checks/index";
import {
  type HtmlLink,
  htmlLinks,
  LinkLog,
  type Links,
  linkMismatchEvidence,
  linksOf,
  MAX_LINKS,
  MAX_PDF_BYTES,
  MAX_UNREAD_NAMED,
  pdfLinks,
  refreshUrl,
  shownDomains,
  srcsetUrls,
  TEXT_CHUNK,
  TextLinks,
  trimTextUrl,
} from "../../src/checks/links";
import { createCase } from "../../src/db/cases";
import { parsedKey, putAttachment, putParsed, putRaw, type Store } from "../../src/intake/store";
import { checks } from "../../src/pipeline/analysis-workflow";

// D02 T07 §1: every link in a case, with where it came from, and anchor text that names another domain.
const enc = (text: string) => new TextEncoder().encode(text);
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };

async function linksIn(html: string) {
  const found: HtmlLink[] = [];
  await htmlLinks(html, (l) => found.push(l));
  return found;
}
function textLinks(chunks: string[]) {
  const found: string[] = [];
  const reader = new TextLinks((url) => found.push(url));
  for (const chunk of chunks) reader.feed(chunk);
  reader.end();
  return found;
}
async function pdfUrls(bytes: Uint8Array) {
  const found: string[] = [];
  const outcome = await pdfLinks(bytes, (url) => found.push(url));
  return { found, outcome };
}
async function deflate(text: string) {
  const stream = new Blob([enc(text)]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function join(...parts: (string | Uint8Array)[]) {
  const bytes = parts.map((p) => (typeof p === "string" ? Uint8Array.from(p, (c) => c.charCodeAt(0)) : p));
  const out = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of bytes) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}
// A synthetic PDF: one literal and one hex `/URI` in its objects, a third in a compressed object stream.
async function pdfWithThreeLinks() {
  const objects = "5 0 << /Type /Annot /Subtype /Link /A << /S /URI /URI (https://third.fynbos-pay.top/c) >> >>";
  const packed = await deflate(objects);
  return join(
    "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n",
    "1 0 obj\n<< /Type /Annot /Subtype /Link /A << /S /URI /URI (https://one.fynbos-pay.top/a\\(1\\)) >> >>\nendobj\n",
    `2 0 obj\n<< /Type /Annot /A << /S /URI /URI <${[...enc("https://two.fynbos-pay.top/b")].map((b) => b.toString(16).padStart(2, "0")).join("")}> >> >>\nendobj\n`,
    `3 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${packed.length} >>\nstream\n`,
    packed,
    "\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  );
}

describe("htmlLinks", () => {
  it("reads every kind of link with its anchor text, and only http(s) URLs", async () => {
    const found = await linksIn(`
      <a href="https://fynbosbank.co.za/login">View  &amp; pay<b> invoice</b></a>
      <area href="https://map.fynbosbank.co.za/" alt="Branches">
      <form action="https://collect.fynbos-pay.top/post"><button formaction="https://alt.fynbos-pay.top/x" value="Send">Send</button></form>
      <iframe src="https://frame.fynbos-pay.top/"></iframe><frame src="https://frame2.fynbos-pay.top/">
      <img src="https://img.fynbos-pay.top/a.png" srcset="https://img.fynbos-pay.top/b.png 2x, https://img.fynbos-pay.top/c,d.png 3x">
      <meta http-equiv="Refresh" content="5; URL='https://next.fynbos-pay.top/go'">
      <a href="mailto:x@fynbosbank.co.za">mail</a><a href="javascript:alert(1)">js</a><a href="/relative">rel</a>
      <a href="https&#58;//entity.fynbos-pay.top/">entity</a>`);
    expect(found.map((l) => [l.kind, l.url, l.anchor])).toEqual([
      ["href", "https://fynbosbank.co.za/login", "View & pay invoice"],
      ["href", "https://map.fynbosbank.co.za/", "Branches"],
      ["form", "https://collect.fynbos-pay.top/post", null],
      ["form", "https://alt.fynbos-pay.top/x", "Send"],
      ["frame", "https://frame.fynbos-pay.top/", null],
      ["frame", "https://frame2.fynbos-pay.top/", null],
      ["image", "https://img.fynbos-pay.top/a.png", null],
      ["image", "https://img.fynbos-pay.top/b.png", null],
      ["image", "https://img.fynbos-pay.top/c,d.png", null],
      ["refresh", "https://next.fynbos-pay.top/go", null],
      ["href", "mailto:x@fynbosbank.co.za", "mail"],
      ["href", "javascript:alert(1)", "js"],
      ["href", "https://entity.fynbos-pay.top/", "entity"],
    ]);
    // `mailto:` and `javascript:` are refused when the log parses them.
    const log = new LinkLog();
    for (const l of found) log.add(l.url, l.kind, "summary", l.anchor);
    expect(log.items.map((l) => l.host)).not.toContain("");
    expect(log.items).toHaveLength(11);
  });

  it("resolves relative links and form actions against an absolute base, wherever it stands (plan review)", async () => {
    const found = await linksIn(
      `<form action="/login"></form><a href="pay?x=1">Pay</a><a href="//cdn.fynbos-pay.top/z">z</a><base href="https://evil.fynbos-pay.top/app/"><base href="https://second.example.top/">`,
    );
    expect(found.map((l) => l.url)).toEqual([
      "https://evil.fynbos-pay.top/login",
      "https://evil.fynbos-pay.top/app/pay?x=1",
      "https://cdn.fynbos-pay.top/z",
    ]);
    // Without a base, only the scheme-relative one is a link, as https.
    expect((await linksIn(`<a href="/login">x</a><a href="//cdn.fynbos-pay.top/z">z</a>`)).map((l) => l.url)).toEqual([
      "https://cdn.fynbos-pay.top/z",
    ]);
  });

  it("reads SVG links by href, else xlink:href, with their text (plan review)", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <a xlink:href="https://old.fynbos-pay.top/"><text>Open statement</text></a>
      <a href="https://new.fynbos-pay.top/" xlink:href="https://ignored.fynbos-pay.top/"><text>www.fynbosbank.co.za</text></a></svg>`;
    expect((await linksIn(svg)).map((l) => [l.url, l.anchor])).toEqual([
      ["https://old.fynbos-pay.top/", "Open statement"],
      ["https://new.fynbos-pay.top/", "www.fynbosbank.co.za"],
    ]);
  });

  it("parses srcset and refresh values as HTML does", () => {
    expect(srcsetUrls("a.png 1x,b.png, c.png 640w")).toEqual(["a.png", "b.png", "c.png"]);
    expect(refreshUrl("0;url=https://x.fynbos-pay.top/")).toBe("https://x.fynbos-pay.top/");
    expect(refreshUrl('3, "https://y.fynbos-pay.top/" ')).toBe("https://y.fynbos-pay.top/");
  });
});

describe("plain-text URLs", () => {
  it("leaves off the punctuation around a URL, and keeps brackets it opened", () => {
    expect(trimTextUrl("https://fynbos-pay.top/a.")).toBe("https://fynbos-pay.top/a");
    expect(trimTextUrl("https://fynbos-pay.top/wiki/A_(b))")).toBe("https://fynbos-pay.top/wiki/A_(b)");
    expect(textLinks(['Pay at (https://fynbos-pay.top/x), or www.fynbosbank.co.za. Or "https://q.top/y"!'])).toEqual([
      "https://fynbos-pay.top/x",
      "http://www.fynbosbank.co.za",
      "https://q.top/y",
    ]);
  });

  it("finds a URL split exactly at a chunk edge once, and one in each chunk", () => {
    const url = "https://edge.fynbos-pay.top/pay?invoice=7";
    const text = `${"a ".repeat(TEXT_CHUNK / 2 - 10)}${url} then https://after.fynbos-pay.top/ end`;
    const cut = TEXT_CHUNK - 20 + 12;
    expect(text.slice(cut - 12, cut)).toBe("https://edge");
    expect(textLinks([text.slice(0, cut), text.slice(cut)])).toEqual([url, "https://after.fynbos-pay.top/"]);
    // Split into one-character chunks it reads the same.
    expect(textLinks(Array.from("x https://one.top/a y https://two.top/b"))).toEqual([
      "https://one.top/a",
      "https://two.top/b",
    ]);
  });
});

describe("PDF links", () => {
  it("reads a literal, a hex and an object-stream /URI (plan review)", async () => {
    expect(await pdfUrls(await pdfWithThreeLinks())).toEqual({
      found: ["https://one.fynbos-pay.top/a(1)", "https://two.fynbos-pay.top/b", "https://third.fynbos-pay.top/c"],
      outcome: null,
    });
  });

  it("says an encrypted PDF cannot be read", async () => {
    const encrypted = join("%PDF-1.7\n1 0 obj << /A << /S /URI /URI (x) >> >> endobj\ntrailer << /Encrypt 9 0 R >>");
    expect(await pdfUrls(encrypted)).toEqual({ found: [], outcome: "encrypted" });
  });
});

describe("LinkLog", () => {
  it("keeps two spellings of one URL once, and caps the list, counting the rest", () => {
    const log = new LinkLog();
    log.add("https://FYNBOSBANK.co.za/a", "text", "summary");
    log.add("https://fynbosbank.co.za/a", "text", "summary");
    log.add("https://bücher.de/", "text", "summary");
    log.add("https://xn--bcher-kva.de/", "text", "summary");
    expect(log.items.map((l) => [l.host, l.display])).toEqual([
      ["fynbosbank.co.za", "fynbosbank.co.za"],
      ["xn--bcher-kva.de", "bücher.de"],
    ]);
    for (let i = 0; i < MAX_LINKS + 5; i++) log.add(`https://fynbos-pay.top/${i}`, "text", "summary");
    log.add("https://fynbos-pay.top/0", "text", "summary");
    expect(log.result()).toMatchObject({ more: 7 });
    expect(log.items).toHaveLength(MAX_LINKS);
  });
});

const viewWith = (links: Links | null) => ({ links }) as unknown as CaseView;
const link = (href: string, anchor: string | null) => {
  const log = new LinkLog();
  log.add(href, "href", "summary", anchor);
  return log.items[0] as Links["items"][number];
};

describe("link.text_mismatch", () => {
  it("is medium when anchor text names another registrable domain", () => {
    const items = linkMismatchEvidence(
      viewWith({ items: [link("https://login.fynbos-pay.top/x", "www.fynbosbank.co.za")], more: 0, unread: [] }),
    );
    expect(items).toEqual([
      {
        check: "link.text_mismatch",
        severity: "medium",
        summary: "The link showing www.fynbosbank.co.za goes to login.fynbos-pay.top.",
        detail: {
          shown: "www.fynbosbank.co.za",
          target: "login.fynbos-pay.top",
          href: "https://login.fynbos-pay.top/x",
          kind: "href",
          part: "summary",
        },
        artefacts: [],
      },
    ]);
  });

  it("says nothing for the same registrable domain, its Unicode form, or text naming no domain", () => {
    const items = linkMismatchEvidence(
      viewWith({
        items: [
          link("https://secure.fynbosbank.co.za/", "www.fynbosbank.co.za"),
          link("https://xn--bcher-kva.de/", "Visit bücher.de"),
          link("https://bücher.de/", "BÜCHER.DE"),
          link("https://fynbos-pay.top/", "View invoice"),
          link("https://fynbos-pay.top/", "Open invoice.zip"),
          link("https://fynbos-pay.top/", null),
        ],
        more: 0,
        unread: [],
      }),
    );
    expect(items).toEqual([]);
    expect(shownDomains("Open invoice.zip")).toEqual([]);
    expect(shownDomains("Go to www.invoice.zip")).toMatchObject([{ registrable: "invoice.zip" }]);
  });

  it("is registered, and partial when links were capped or a file was unread", () => {
    expect(registry.names()).toContain("link.text_mismatch");
    const check = registry.all().find((c) => c.name === "link.text_mismatch");
    expect(check?.applies?.(viewWith(null))).toBe("the case has no links");
    expect(check?.partial?.(viewWith({ items: [], more: 3, unread: [{ key: "k", why: "encrypted" }] }))).toBe(
      `3 links past the first ${MAX_LINKS} were not checked; 1 parts or files could not be read for links`,
    );
  });
});

type Files = { name: string; type: string; body: Uint8Array | null }[];
async function storedCase(body: {
  html?: string;
  text?: string;
  cut?: (string | { type: string; full: string })[];
  files?: Files;
}) {
  const made = await createCase(env.DB, { orgId: "org-links", channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  const id = made.value.id;
  await putRaw(store, id, enc("From: x@fynbos-pay.top\r\n\r\nHello.\r\n"));
  const attachments = [];
  for (const f of body.files ?? []) {
    const stored = f.body
      ? await putAttachment(store, id, f.name, f.body, f.type)
      : { key: `raw/${id}/attachments/missing-${f.name}`, bytes: 10 };
    attachments.push({
      key: stored.key,
      filename: f.name,
      mediaType: f.type,
      contentId: null,
      disposition: "attachment",
      bytes: stored.bytes,
    });
  }
  const truncated = [];
  for (const [i, cut] of (body.cut ?? []).entries()) {
    const { type, full } = typeof cut === "string" ? { type: "text/plain", full: cut } : cut;
    const stored = await putAttachment(store, id, `body-${i + 1}.txt`, enc(full), type);
    truncated.push({
      mediaType: type,
      charset: "utf-8",
      key: stored.key,
      fullBytes: full.length,
      keptBytes: 9,
    });
  }
  await putParsed(store, id, {
    headers: [],
    text: body.text ?? null,
    html: body.html ?? null,
    attachments,
    truncated,
    omitted: 0,
    forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
  });
  return id;
}
const run = (id: string) => checks(store, id, parsedKey(id), { orgId: "org-links", channel: "email" }, async () => []);
const mismatches = async (id: string) =>
  (await readEvidence(env.DB, id)).filter((e) => e.check === "link.text_mismatch");
const outcome = async (id: string) =>
  (await readCheckOutcomes(env.DB, id))?.find((o) => o.check === "link.text_mismatch");

describe("the checks step (plan review: through the real entry point)", () => {
  it("finds a link past the cut, a login page's form action, an SVG link and a PDF's links", async () => {
    const past = `${"filler ".repeat(160_000)}https://past-the-cut.fynbos-pay.top/pay`;
    const id = await storedCase({
      text: "Short kept text.",
      cut: [past],
      files: [
        {
          name: "login.html",
          type: "text/html",
          body: enc(`<form action="https://collect.fynbos-pay.top/post"><input type="password"></form>`),
        },
        {
          name: "logo.svg",
          type: "image/svg+xml",
          body: enc(`<svg><a xlink:href="https://svg.fynbos-pay.top/">x</a></svg>`),
        },
        { name: "statement.pdf", type: "application/pdf", body: await pdfWithThreeLinks() },
      ],
    });
    const summary = JSON.parse(await ((await env.ARTEFACTS.get(parsedKey(id))) as R2ObjectBody).text());
    const read = await linksOf(env.ARTEFACTS, {
      source: { kind: "message", path: "rfc822", otherOriginals: 0 },
      text: summary.text,
      html: null,
      truncated: summary.truncated,
      attachments: summary.attachments,
      attachmentHeads: null,
      htmlAttachments: await htmlAttachmentsOf(env.ARTEFACTS, {
        attachments: summary.attachments,
        attachmentHeads: null,
      }),
    });
    expect(read?.items.map((l) => [l.kind, l.host])).toEqual([
      ["text", "past-the-cut.fynbos-pay.top"],
      ["form", "collect.fynbos-pay.top"],
      ["href", "svg.fynbos-pay.top"],
      ["pdf", "one.fynbos-pay.top"],
      ["pdf", "two.fynbos-pay.top"],
      ["pdf", "third.fynbos-pay.top"],
    ]);
    expect(read?.items[0]?.part).toBe(summary.truncated[0].key);
    await run(id);
    expect(await outcome(id)).toMatchObject({ outcome: "ran", findings: 0 });
  });

  it("stores a mismatch naming its part, medium, and stores it once when the step is retried", async () => {
    const id = await storedCase({
      html: `<p>Your statement</p><a href="https://login.fynbos-pay.top/s">www.fynbosbank.co.za</a>`,
      files: [
        {
          name: "page.svg",
          type: "image/svg+xml",
          body: enc(`<svg><a xlink:href="https://svg.fynbos-pay.top/"><text>fynbosbank.co.za</text></a></svg>`),
        },
      ],
    });
    await run(id);
    await run(id);
    const items = await mismatches(id);
    expect(items.map((i) => [i.severity, i.detail.target, i.detail.part])).toEqual([
      ["medium", "login.fynbos-pay.top", "summary"],
      ["medium", "svg.fynbos-pay.top", expect.stringContaining("page.svg")],
    ]);
    expect(items[1]?.artefacts).toEqual([items[1]?.detail.part]);
    expect(await outcome(id)).toMatchObject({ outcome: "ran", findings: 2 });
  });

  it("is partial when the links were capped, or a PDF was encrypted, missing or too large", async () => {
    const many = Array.from({ length: MAX_LINKS + 2 }, (_, i) => `https://l${i}.fynbos-pay.top/`).join(" ");
    const capped = await storedCase({ text: many });
    await run(capped);
    expect(await outcome(capped)).toMatchObject({ outcome: "partial" });
    expect((await mismatches(capped)).at(-1)?.detail).toMatchObject({ checked: false, more: 2 });

    const big = new Uint8Array(MAX_PDF_BYTES + 10);
    big.set(enc("%PDF-1.7\n"));
    const unread = await storedCase({
      files: [
        { name: "locked.pdf", type: "application/pdf", body: enc("%PDF-1.7\ntrailer << /Encrypt 9 0 R >>") },
        { name: "gone.pdf", type: "application/pdf", body: null },
        { name: "huge.pdf", type: "application/pdf", body: big },
      ],
    });
    await run(unread);
    expect(await outcome(unread)).toMatchObject({ outcome: "partial" });
    const info = (await mismatches(unread)).at(-1)?.detail as { unread: { why: string }[] };
    expect(info.unread.map((u) => u.why)).toEqual(["encrypted", "missing", "too-large"]);
  });

  it("skips a case with no links", async () => {
    const id = await storedCase({ text: "No links here." });
    await run(id);
    expect(await outcome(id)).toMatchObject({ outcome: "skipped", reason: "the case has no links" });
  });
});

describe("after the completion review", () => {
  it("reads a /URI key written with escapes, past a comment, or given by reference, in the file or an object stream", async () => {
    const packed = await deflate("7 0 (https://packed-ref.fynbos-pay.top/)");
    const pdf = join(
      "%PDF-1.7\n",
      "1 0 obj << /A << /S /URI /U#52I (https://escaped.fynbos-pay.top/) >> >> endobj\n",
      "2 0 obj << /A << /S /URI /URI % a comment\n (https://commented.fynbos-pay.top/) >> >> endobj\n",
      "3 0 obj << /A << /S /URI /URI 4 0 R >> >> endobj\n4 0 obj\n(https://direct-ref.fynbos-pay.top/)\nendobj\n",
      "5 0 obj << /A << /S /URI /URI 7 0 R >> >> endobj\n",
      `6 0 obj << /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${packed.length} >> stream\n`,
      packed,
      "\nendstream endobj\n",
    );
    expect(await pdfUrls(pdf)).toEqual({
      found: [
        "https://escaped.fynbos-pay.top/",
        "https://commented.fynbos-pay.top/",
        "https://direct-ref.fynbos-pay.top/",
        "https://packed-ref.fynbos-pay.top/",
      ],
      outcome: null,
    });
  });

  it("says a PDF whose object stream does not inflate, or whose reference names no string, is damaged", async () => {
    const broken = join(
      "%PDF-1.7\n1 0 obj << /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length 9 >> stream\nnot zlib!\nendstream endobj\n",
    );
    expect((await pdfUrls(broken)).outcome).toBe("damaged");
    expect((await pdfUrls(join("%PDF-1.7\n1 0 obj << /A << /S /URI /URI 9 0 R >> >> endobj\n"))).outcome).toBe(
      "damaged",
    );
  });

  it("compares every domain anchor text shows, not only the first", () => {
    const items = linkMismatchEvidence(
      viewWith({
        items: [link("https://evil.fynbos-pay.top/", "evil.fynbos-pay.top: sign in to fynbosbank.co.za")],
        more: 0,
        unread: [],
      }),
    );
    expect(items.map((i) => i.detail.shown)).toEqual(["fynbosbank.co.za"]);
  });

  it("counts a page's links after validating and deduplicating them, and the relative ones past its bound", async () => {
    const filler = `${'<a href="mailto:x@fynbosbank.co.za">m</a>'.repeat(50)}${'<a href="https://same.fynbos-pay.top/">s</a>'.repeat(50)}`;
    const id = await storedCase({
      files: [
        {
          name: "a.html",
          type: "text/html",
          body: enc(`${filler}<a href="https://login.fynbos-pay.top/">fynbosbank.co.za</a>`),
        },
        {
          name: "b.html",
          type: "text/html",
          body: enc(Array.from({ length: 52 }, (_, i) => `<a href="https://b${i}.fynbos-pay.top/">b</a>`).join("")),
        },
      ],
    });
    const summary = JSON.parse(await ((await env.ARTEFACTS.get(parsedKey(id))) as R2ObjectBody).text());
    const read = await htmlAttachmentsOf(env.ARTEFACTS, { attachments: summary.attachments, attachmentHeads: null });
    expect(read?.items[0]?.links.items.map((l) => l.host)).toEqual(["same.fynbos-pay.top", "login.fynbos-pay.top"]);
    expect(read?.items[1]?.links).toMatchObject({ more: 2 });
    await run(id);
    expect((await mismatches(id)).map((i) => i.detail.target)).toContain("login.fynbos-pay.top");
    expect(await outcome(id)).toMatchObject({ outcome: "partial" });
    const relative = Array.from({ length: 502 }, (_, i) => `<a href="/p${i}">p</a>`).join("");
    expect(await htmlLinks(`<base href="https://x.fynbos-pay.top/">${relative}`, () => {})).toBe(2);
    // Through the log: 500 resolved (50 kept, 450 counted) and the 2 past the bound counted too.
    const log = new LinkLog();
    await log.html(`<base href="https://x.fynbos-pay.top/">${relative}`, "summary");
    expect(log.result()).toMatchObject({ more: 452 });
  });

  it("is partial when an HTML attachment was missing, one too many, or read only in part", async () => {
    const pages = Array.from({ length: 11 }, (_, i) => ({
      name: `p${i}.html`,
      type: "text/html",
      body: enc(`<p>page ${i}</p>`),
    }));
    const many = await storedCase({ files: [...pages, { name: "gone.html", type: "text/html", body: null }] });
    await run(many);
    expect(await outcome(many)).toMatchObject({ outcome: "partial" });
    const last = (await mismatches(many)).at(-1);
    const why = ((last?.detail.unread ?? []) as { why: string }[]).map((u) => u.why);
    expect(why.sort()).toEqual(["too-many", "too-many"]);
  });

  it("reads an uploaded PDF and a cut HTML part", async () => {
    // An uploaded file's object, stored under any case: only its key is read.
    const pdf = await pdfWithThreeLinks();
    const stored = await putAttachment(store, await storedCase({}), "statement.pdf", pdf, "application/pdf");
    const upload = await linksOf(env.ARTEFACTS, {
      source: {
        kind: "upload",
        fileKind: "document",
        mediaType: "application/pdf",
        key: stored.key,
        bytes: pdf.length,
      },
      text: null,
      html: null,
      truncated: [],
      attachments: [],
      attachmentHeads: null,
      htmlAttachments: null,
    });
    expect(upload?.items.map((l) => [l.kind, l.part === stored.key])).toEqual([
      ["pdf", true],
      ["pdf", true],
      ["pdf", true],
    ]);
    const id = await storedCase({
      cut: [
        {
          type: "text/html",
          full: `${"<p>filler</p>".repeat(200)}<a href="https://late.fynbos-pay.top/">www.fynbosbank.co.za</a>`,
        },
      ],
    });
    await run(id);
    expect((await mismatches(id)).map((i) => i.detail.target)).toEqual(["late.fynbos-pay.top"]);
  });

  it("throws a storage failure so the step is retried, never reading it as no links", async () => {
    const failing = { get: async () => Promise.reject(new Error("R2 down")) } as unknown as R2Bucket;
    await expect(
      linksOf(failing, {
        source: { kind: "message", path: "rfc822", otherOriginals: 0 },
        text: null,
        html: null,
        truncated: [{ mediaType: "text/plain", charset: "utf-8", key: "k", fullBytes: 1, keptBytes: 1 }],
        attachments: [],
        attachmentHeads: null,
        htmlAttachments: null,
      }),
    ).rejects.toThrow("R2 down");
  });

  it("names the first twenty unread files and counts the rest (D07 T03 §31's completion review)", () => {
    const unread = Array.from({ length: MAX_UNREAD_NAMED + 1 }, (_, i) => ({
      key: `f${i}.pdf`,
      why: "encrypted" as const,
    }));
    const [info] = linkMismatchEvidence(viewWith({ items: [], more: 0, unread }));
    expect(info?.detail).toEqual({ checked: false, more: 0, unread: unread.slice(0, 20), unreadMore: 1 });
    expect(info?.summary).toBe("21 parts or files could not be read for links.");
  });
});

describe("after round 1", () => {
  it("trims thousands of closing brackets in linear time", () => {
    const long = `https://fynbos-pay.top/a${")".repeat(40_000)}`;
    const started = performance.now();
    expect(trimTextUrl(long)).toBe("https://fynbos-pay.top/a");
    expect(textLinks([`see ${long} now`])).toEqual([]);
    expect(trimTextUrl("https://fynbos-pay.top/w/(a)(b))).")).toBe("https://fynbos-pay.top/w/(a)(b)");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("reads an object stream whose names are written with escapes", async () => {
    const packed = await deflate("9 0 << /A << /S /URI /URI (https://escaped-stream.fynbos-pay.top/) >> >>");
    const pdf = join(
      `%PDF-1.7\n3 0 obj << /Type /Obj#53tm /N 1 /First 4 /Filter /Flate#44ecode /Length ${packed.length} >> stream\n`,
      packed,
      "\nendstream endobj\n",
    );
    expect(await pdfUrls(pdf)).toEqual({ found: ["https://escaped-stream.fynbos-pay.top/"], outcome: null });
  });

  it("reads a reference named after a hundred repeats of another", async () => {
    const pdf = join(
      "%PDF-1.7\n",
      "1 0 obj (https://benign.fynbos-pay.top/) endobj\n2 0 obj (https://harmful.fynbos-pay.top/) endobj\n",
      "<< /A << /S /URI /URI 1 0 R >> >>\n".repeat(100),
      "<< /A << /S /URI /URI 2 0 R >> >>\n",
    );
    expect(await pdfUrls(pdf)).toEqual({
      found: ["https://benign.fynbos-pay.top/", "https://harmful.fynbos-pay.top/"],
      outcome: null,
    });
  });
});

describe("after round 2", () => {
  it("reads an object stream with a comment in its dictionary, or with an indirect length", async () => {
    const packed = await deflate("9 0 << /A << /S /URI /URI (https://stream.fynbos-pay.top/) >> >>");
    const commented = join(
      `%PDF-1.7\n3 0 obj << /Type % a note\n /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${packed.length} >> stream\n`,
      packed,
      "\nendstream endobj\n",
    );
    const indirect = join(
      "%PDF-1.7\n3 0 obj << /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length 12 0 R >> stream\n",
      packed,
      `\nendstream endobj\n12 0 obj ${packed.length} endobj\n`,
    );
    for (const pdf of [commented, indirect])
      expect(await pdfUrls(pdf)).toEqual({ found: ["https://stream.fynbos-pay.top/"], outcome: null });
  });
});
