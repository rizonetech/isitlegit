import { describe, expect, it } from "vitest";
import {
  anchorOf,
  GALLERY_FRAMES,
  GALLERY_STATES,
  GalleryFrame,
  GalleryPage,
  GalleryState,
} from "../../src/web/dev/gallery";

// The component gallery (D07 T01 §10) shows every state of every shared component and every frame of the shell. The
// lists below are this test's own, written from §6 to §9 and §3, so a state dropped from the gallery fails here even
// when its component's other states remain.
const html = (node: unknown) => String(node);
const pills = ["safe", "suspicious", "malicious", "partial", "running", "neutral", "brand", "alert"];
const bands = ["complete-malicious", "complete-suspicious", "complete-safe", "partial", "failed", "running"];
const EXPECTED_STATES = [
  ...["primary", "dark", "ghost", "danger", "link", "small", "icon", "small-icon", "disabled", "disabled-link"].map(
    (s) => `button/${s}`,
  ),
  ...["plain", "focused", "hint", "error", "hint-and-error", "code"].map((s) => `field/${s}`),
  ...["default", "disabled"].map((s) => `select/${s}`),
  ...["unchecked", "checked", "required", "disabled"].map((s) => `checkbox/${s}`),
  ...pills.flatMap((p) => [`pill/${p}`, `pill/${p}-compact`]),
  ...bands.map((b) => `verdict-band/${b}`),
  ...bands.map((b) => `verdict-badge/${b}`),
  ...["critical", "high", "medium", "low", "info", "not-checked"].map((l) => `severity/${l}`),
  "evidence-ref",
  "evidence-card/split",
  "evidence-card/compact",
  "empty/first-run",
  "empty/filtered",
  "empty/filtered-without-action",
  "loading",
  ...["403", "404", "410", "429", "500", "maintenance"].map((c) => `error/${c}`),
  "partial/one",
  "partial/two",
  "copy-group",
];
const EXPECTED_FRAMES = [
  ...["cases", "suppliers", "protect", "monitor", "team", "domains", "account", "plan"].map((p) => `member-${p}`),
  "member-several-orgs",
  "member-trial-findings",
  ...["overview", "orgs", "invites", "feedback", "eval"].map((p) => `admin-${p}`),
  "public",
];

// Each state's own markup, so an item that renders the wrong thing (or nothing) fails.
// Each state's own markup, the thing that sets it apart from its siblings, so an item drawn as the wrong state fails.
const MARK: [RegExp, RegExp][] = [
  [/^button\/primary$/, /<button[^>]*class="[^"]*bg-accent/],
  [/^button\/dark$/, /<button[^>]*class="[^"]*bg-dark/],
  [/^button\/ghost$/, /<button[^>]*class="[^"]*border-line-strong/],
  [/^button\/danger$/, /<button[^>]*class="[^"]*text-mal/],
  [/^button\/link$/, /<button[^>]*class="[^"]*underline/],
  [/^button\/small$/, /<button[^>]*class="[^"]*min-h-control-small/],
  [/^button\/icon$/, /<button(?=[^>]*aria-label="Copy the check address")(?=[^>]*class="[^"]*\bw-32\b)/],
  [/^button\/small-icon$/, /<button(?=[^>]*aria-label="Menu")(?=[^>]*class="[^"]*\bw-40\b)/],
  [/^button\/disabled$/, /<button(?=[^>]*\sdisabled="")(?=[^>]*aria-describedby="gallery-remove-reason")/],
  [/^button\/disabled-link$/, /<a(?![^>]*\shref=)(?=[^>]*role="link")(?=[^>]*aria-disabled="true")/],
  [/^field\/code$/, /maxlength="7"/],
  [/^field\/hint-and-error$/, /aria-describedby="g-both-hint g-both-error"/],
  [/^field\/error$/, /aria-invalid="true"/],
  [/^field\/hint$/, /aria-describedby="g-hint-hint"/],
  [/^field\/plain$/, /<input(?![^>]*aria-describedby)[^>]*>/],
  [/^field\/focused$/, /<input(?=[^>]*\sautofocus="")(?=[^>]*class="[^"]*focus:border-orange-text)/],
  [/^select\/disabled$/, /<select(?=[^>]*\sdisabled="")(?=[^>]*class="[^"]*appearance-none)[\s\S]*<svg/],
  [/^select\/default$/, /<select(?![^>]*\sdisabled="")(?=[^>]*class="[^"]*appearance-none)[\s\S]*<svg/],
  [/^checkbox\/checked$/, /checked=""/],
  [/^checkbox\/required$/, /required=""/],
  [/^checkbox\/disabled$/, /disabled=""/],
  [/^checkbox\/unchecked$/, /<input(?![^>]*(checked|disabled|required))[^>]*type="checkbox"/],
  [/^pill\/.*-compact$/, /h-24/],
  [/^pill\//, /h-28/],
  [/^verdict-band\/complete-malicious$/, /bg-mal-band/],
  [/^verdict-band\/complete-suspicious$/, /bg-sus-band[\s\S]*Suspicious · medium confidence</],
  [/^verdict-band\/complete-safe$/, /bg-safe-band/],
  [/^verdict-band\/partial$/, /partial check/],
  [/^verdict-band\/failed$/, /Check failed · no verdict/],
  [/^verdict-band\/running$/, /Checking · 0:21 so far/],
  [/^verdict-badge\/complete-malicious$/, />Malicious</],
  [/^verdict-badge\/complete-suspicious$/, />Suspicious</],
  [/^verdict-badge\/complete-safe$/, />Safe</],
  [/^verdict-badge\/(partial|failed)$/, />Partial</],
  [/^verdict-badge\/running$/, />Checking</],
  [/^severity\/not-checked$/, /E7 · Not checked/],
  [/^severity\/(.+)$/, /E7 · [A-Z][a-z]+</],
  [/^evidence-ref$/, /href="#e7"/],
  [/^evidence-card\/split$/, /<figure\b[\s\S]*<figure\b/],
  [/^evidence-card\/compact$/, /<article(?![\s\S]*<figure)/],
  [/^empty\/first-run$/, /type-eyebrow/],
  [/^empty\/filtered$/, /Clear filters/],
  [/^empty\/filtered-without-action$/, /<h3\b(?![\s\S]*<(a|button)\b)/],
  [/^loading$/, /role="status"/],
  [/^error\/404$/, /Go to your cases[\s\S]*Check a file[\s\S]*Forwarding still works/],
  [/^error\/403$/, /signed in as <strong[^>]*>ayesha@outeniquapaper\.example/],
  [/^error\/410$/, /Sign in to see the case[\s\S]*No account\?/],
  [/^error\/429$/, /See your plan[\s\S]*Back to cases[\s\S]*bg-subtle[\s\S]*Too many requests at once\?/],
  [/^error\/500$/, /Try again[\s\S]*Email support[\s\S]*Forwarding still works/],
  [/^error\/maintenance$/, /Planned maintenance[\s\S]*Reload/],
  [/^partial\/two$/, /Two checks did not run/],
  [/^partial\/one$/, /One check did not run/],
  [/^copy-group$/, /data-copy="check@isitlegit\.co\.za"/],
];

const DESTINATION: Record<string, string> = {
  "member-cases": "/cases",
  "member-suppliers": "/suppliers",
  "member-protect": "/protect",
  "member-monitor": "/monitor",
  "member-team": "/team",
  "member-domains": "/settings/domains",
  "member-account": "/settings/account",
  "member-plan": "/settings/plan",
  "admin-overview": "/admin",
  "admin-orgs": "/admin#organisations",
  "admin-invites": "/admin/invites",
  "admin-feedback": "/admin/feedback",
  "admin-eval": "/admin/eval",
};

const page = html(<GalleryPage />);
const stateDocs = new Map(GALLERY_STATES.map((s) => [s.id, html(GalleryState(anchorOf("state", s.id)))]));
const item = (id: string) => stateDocs.get(id) ?? "";
const ids = (markup: string) => [...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

describe("the component gallery", () => {
  it("lists exactly the states this test expects, each once", () => {
    expect(GALLERY_STATES.map((s) => s.id).sort()).toEqual([...EXPECTED_STATES].sort());
    for (const id of EXPECTED_STATES) expect(page.split(`data-gallery-state="${id}"`).length - 1, id).toBe(1);
  });

  it("draws each state with its own markup", () => {
    // Each severity pill carries its own level's word.
    for (const level of ["critical", "high", "medium", "low", "info"])
      expect(item(`severity/${level}`), level).toContain(`E7 · ${level[0]?.toUpperCase()}${level.slice(1)}<`);
    // An error's actions, one or two as its board draws them.
    const actions = (id: string) => (item(id).match(/<a\b[^>]*class="[^"]*min-h-control /g) ?? []).length;
    expect(["404", "403", "410", "429", "500", "maintenance"].map((c) => actions(`error/${c}`))).toEqual([
      2, 2, 1, 2, 2, 1,
    ]);
    for (const id of EXPECTED_STATES) {
      const mark = MARK.find(([pattern]) => pattern.test(id))?.[1];
      expect(mark, `${id} has a check`).toBeDefined();
      expect(item(id), id).toMatch(mark as RegExp);
    }
  });

  it("links every state and frame from its index to a shareable anchor", () => {
    const index = /<nav aria-label="Gallery index"[\s\S]*?<\/nav>/.exec(page)?.[0] ?? "";
    for (const state of GALLERY_STATES) {
      const anchor = anchorOf("state", state.id);
      expect(index, state.id).toContain(`href="#${anchor}"`);
      expect(page, state.id).toMatch(new RegExp(`<section id="${anchor}" data-gallery-state="${state.id}"`));
    }
    for (const frame of GALLERY_FRAMES) {
      expect(index, frame.id).toContain(`href="#${anchorOf("frame", frame.id)}"`);
      expect(page, frame.id).toContain(`<section id="${anchorOf("frame", frame.id)}"`);
    }
    // Frames load as they near the screen.
    expect((page.match(/<iframe\b[^>]*loading="lazy"/g) ?? []).length).toBe(
      GALLERY_FRAMES.length + GALLERY_STATES.length,
    );
  });

  it("repeats no id on the gallery page", () => {
    const all = ids(page);
    expect(all.filter((id, i) => all.indexOf(id) !== i)).toEqual([]);
  });

  it("frames every shell state in a document of its own, each with its state drawn", () => {
    expect(GALLERY_FRAMES.map((f) => f.id).sort()).toEqual([...EXPECTED_FRAMES].sort());
    for (const id of EXPECTED_FRAMES) {
      expect(page, id).toContain(`src="/dev/components/frame/${id}"`);
      const doc = html(GalleryFrame(id));
      const all = ids(doc);
      expect(
        all.filter((x, i) => all.indexOf(x) !== i),
        `${id}: no repeated id`,
      ).toEqual([]);
      // The one current link is the frame's own page.
      const current = [...doc.matchAll(/<a href="([^"]*)" aria-current="page"/g)].map((m) => m[1]);
      if (id !== "public") expect(current, id).toEqual([DESTINATION[id] ?? DESTINATION["member-cases"]]);
    }
    // The switcher with several organisations, a plain label with one; the trial pill and the Monitor pill.
    expect(html(GalleryFrame("member-several-orgs"))).toContain("Swartberg Transport");
    expect(html(GalleryFrame("member-cases"))).not.toContain("Swartberg Transport");
    expect(html(GalleryFrame("member-trial-findings"))).toMatch(/Trial, 11 days/);
    expect(html(GalleryFrame("member-trial-findings"))).toMatch(/3 new/);
    expect(html(GalleryFrame("member-cases"))).toContain("Business");
    expect(html(GalleryFrame("member-cases"))).not.toMatch(/\d new/);
    expect(GalleryFrame("no-such-frame")).toBeNull();
  });
});
