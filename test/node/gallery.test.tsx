import { describe, expect, it } from "vitest";
import { GALLERY_FRAMES, GALLERY_STATES, GalleryFrame, GalleryPage } from "../../src/web/dev/gallery";

// The component gallery (D07 T01 §10) shows every state of every shared component and every frame of the shell. The
// lists below are this test's own, written from §6 to §9 and §3, so a state dropped from the gallery fails here even
// when its component's other states remain.
const html = (node: unknown) => String(node);
const pills = ["safe", "suspicious", "malicious", "partial", "running", "neutral", "brand", "alert"];
const bands = ["complete-malicious", "complete-suspicious", "complete-safe", "partial", "failed", "running"];
const EXPECTED_STATES = [
  ...["primary", "dark", "ghost", "danger", "link", "small", "icon", "small-icon", "disabled"].map(
    (s) => `button/${s}`,
  ),
  ...["plain", "hint", "error", "hint-and-error", "code"].map((s) => `field/${s}`),
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
const MARK: [RegExp, RegExp][] = [
  [/^button\/(icon|small-icon)$/, /<button[^>]*aria-label="[^"]+"/],
  [/^button\/disabled$/, /<button[^>]*disabled=""/],
  [/^button\//, /<(button|a)\b/],
  [/^field\/code$/, /maxlength="7"/],
  [/^field\/(error|hint-and-error)$/, /aria-invalid="true"/],
  [/^field\//, /<input\b/],
  [/^checkbox\/checked$/, /checked=""/],
  [/^checkbox\/required$/, /required=""/],
  [/^checkbox\/disabled$/, /disabled=""/],
  [/^checkbox\//, /type="checkbox"/],
  [/^pill\/.*-compact$/, /h-24/],
  [/^pill\//, /h-28/],
  [/^verdict-band\//, /aria-label="Verdict"/],
  [/^verdict-badge\//, /rounded-pill/],
  [/^severity\//, /E7 ·/],
  [/^evidence-ref$/, /href="#e7"/],
  [/^evidence-card\/split$/, /<figure\b/],
  [/^evidence-card\//, /<article\b/],
  [/^empty\/first-run$/, /type-eyebrow/],
  [/^empty\/filtered$/, /Clear filters/],
  [/^empty\//, /<h3\b/],
  [/^loading$/, /role="status"/],
  [/^error\//, /type-eyebrow/],
  [/^partial\/two$/, /<li\b[\s\S]*<li\b/],
  [/^partial\//, /role="note"/],
  [/^copy-group$/, /data-copy="check@isitlegit\.co\.za"/],
];

const page = html(<GalleryPage />);
const item = (id: string) => {
  const open = page.indexOf(`data-gallery-state="${id}"`);
  if (open < 0) return "";
  const end = page.indexOf("data-gallery-state=", open + 20);
  return page.slice(open, end < 0 ? page.indexOf("data-gallery-frame=") : end);
};
const ids = (markup: string) => [...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

describe("the component gallery", () => {
  it("lists exactly the states this test expects, each once", () => {
    expect(GALLERY_STATES.map((s) => s.id).sort()).toEqual([...EXPECTED_STATES].sort());
    for (const id of EXPECTED_STATES) expect(page.split(`data-gallery-state="${id}"`).length - 1, id).toBe(1);
  });

  it("draws each state with its own markup", () => {
    for (const id of EXPECTED_STATES) {
      const mark = MARK.find(([pattern]) => pattern.test(id))?.[1];
      expect(mark, `${id} has a check`).toBeDefined();
      expect(item(id), id).toMatch(mark as RegExp);
    }
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
      const active = /^(member|admin)-(.+)$/.exec(id)?.[2];
      if (id.startsWith("admin-")) expect(doc, id).toMatch(/aria-current="page"/);
      if (id.startsWith("member-") && active && !["several-orgs", "trial-findings"].includes(active))
        expect(doc, id).toMatch(/aria-current="page"/);
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
