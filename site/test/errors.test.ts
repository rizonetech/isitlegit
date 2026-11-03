// The site's 404 and 500 (D07 T08 §9, design/SPEC.md S11): each page's sentence, way back and check@ address, the
// sign-up qualification, the 500 as one standalone file, and the 404 wired into the Worker's config.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { app, CHECK_ADDRESS, contact, HELLO_ADDRESS, site } from "../src/lib/links.ts";
import { claims } from "../src/lib/claims.ts";
import { DIST, has, hrefs, linkTo, page, region, text } from "./lib/page.ts";

const read = (name: string) => readFileSync(join(DIST, name), "utf8");

describe("404", () => {
  const html = read("404.html");
  const error = () => region(html, "error");

  it("is built as a file, in the site layout, saying what happened and the way back", () => {
    assert.ok(statSync(join(DIST, "404.html")).isFile());
    assert.match(html, /<h1[^>]*>That page isn't here\.<\/h1>/);
    has(error(), "The address may be mistyped, or the page has moved. Here is the way back.", "404");
    for (const [label, href] of [["Home", site.home], ["How it works", site.howItWorks], ["Pricing", site.pricing]] as const) linkTo(error(), href, label, "404");
    assert.match(html, /<header|SiteHeader|<nav/i, "the page is not in the site layout");
  });

  it("offers the check@ address with the sign-up qualification, never an unconditional reply", () => {
    has(error(), `Forward it as an attachment to ${CHECK_ADDRESS}`, "404");
    has(error(), "Sign up first: we answer mail from the address or domain you verify.", "404");
    linkTo(error(), app.signup, "Sign up first", "404");
    assert.doesNotMatch(text(error()), /we will reply|you will get a reply/i);
  });

  it("is what the site Worker serves for an unknown address", () => {
    const config = readFileSync(join(DIST, "../wrangler.jsonc"), "utf8");
    assert.match(config, /"not_found_handling": "404-page"/);
  });
});

describe("500", () => {
  const html = read("500.html");

  it("is one standalone file, not a directory", () => {
    assert.ok(existsSync(join(DIST, "500.html")) && statSync(join(DIST, "500.html")).isFile());
  });

  it("depends on nothing: no script, stylesheet link, web font, image or external request", () => {
    assert.doesNotMatch(html, /<script|<link|\ssrc=|url\(|@import|@font-face|<img|<iframe/i);
    const external = hrefs(html).filter((h) => /^[a-z]+:/i.test(h));
    assert.deepEqual(external, [app.signup, contact], "a link leaves the site other than the sign-up and the help mailto");
  });

  it("says what happened, offers Try again and Home, the check@ address, the qualification and its reference", () => {
    const body = text(html);
    assert.match(html, /<h1[^>]*>This page didn't load\.<\/h1>/);
    assert.ok(body.includes("That's on us, not you. Try again in a minute."), body.slice(0, 300));
    assert.ok(body.includes(claims["errors.mail"].text), "the mail line is not the registry's");
    assert.match(html, /<a class="btn dark" href="" data-retry>Try again<\/a>/, "Try again does not reload the failed address");
    assert.match(html, /<a class="btn" href="\/">Home<\/a>/);
    assert.ok(body.includes(`Forward it as an attachment to ${CHECK_ADDRESS}.`));
    assert.ok(body.includes("Sign up first: we answer mail from the address or domain you verify."));
    assert.ok(body.includes("Reference 500-site"));
  });

  it("offers a person: the help link is the contact mailto and the address is visible to copy", () => {
    linkTo(html, contact, HELLO_ADDRESS, "500 help");
    assert.ok(text(html).includes(HELLO_ADDRESS), "the contact address is not visible as selectable text");
  });

  it("defines every class it uses in its own inline CSS, so it needs no stylesheet", () => {
    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    const body = html.slice(html.indexOf("</head>"));
    const used = new Set([...body.matchAll(/\bclass="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/).filter(Boolean)));
    const missing = [...used].filter((name) => !style.includes(`.${name}`));
    assert.deepEqual(missing, [], "classes with no rule in the page's own CSS");
  });

  it("carries the app's tokens as compiled CSS custom properties, not Tailwind theme source", () => {
    assert.match(html, /:root,:host\{[^}]*--color-surface:/, "the tokens are not plain :root declarations");
    assert.doesNotMatch(html, /@theme|@import|@source|@utility/, "uncompiled Tailwind source reached the page");
  });

  it("carries the app's tokens and no colour literal of its own", () => {
    assert.match(html, /--color-orange-text:/);
    const own = html.slice(html.indexOf("}", html.lastIndexOf("--spacing")) );
    // `#0000` is how the compiled reset writes `transparent`; every other colour comes from a token.
    assert.doesNotMatch(own.replace(/--[a-z0-9-]+:[^;]+;/g, ""), /#(?!0000\b)[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});
