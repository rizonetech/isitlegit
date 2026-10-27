import { describe, expect, it } from "vitest";
import { MOTION } from "../../src/web/assets";
import {
  EvidenceCard,
  EvidenceFigure,
  EvidenceQuote,
  EvidenceRef,
  type Severity,
  SeverityPill,
} from "../../src/web/components/Evidence";
import { elapsedText, VerdictBadge, VerdictBand, type VerdictBandProps } from "../../src/web/components/Verdict";

// The verdict band and badge, severity and the evidence card (D07 T01 §7) render the boards' words, token classes and
// art, and refuse what the SPEC forbids. The jump from a reason to its card, contrast and the phone width are checked in
// Chromium by verdict-browser.test.tsx.
const html = (node: unknown) => String(node);
const tag = (markup: string, name: string) => new RegExp(`<${name}\\b[^>]*>`).exec(markup)?.[0] ?? "";
const text = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");

describe("VerdictBand", () => {
  // A complete malicious band, with the overrides a test gives; an override of undefined removes that prop.
  const band = (overrides: Record<string, unknown>) => {
    const props = Object.fromEntries(
      Object.entries({
        state: "complete",
        verdict: "malicious",
        confidence: "high",
        headline: "Do not pay this invoice",
        ...overrides,
      }).filter(([, value]) => value !== undefined),
    ) as unknown as Omit<VerdictBandProps, "children">;
    return html(<VerdictBand {...props}>The link asks for your mail password.</VerdictBand>);
  };

  it("renders a complete check in its verdict's band, words and art", () => {
    for (const [verdict, colour, word] of [
      ["malicious", "bg-mal-band", "Malicious"],
      ["suspicious", "bg-sus-band", "Suspicious"],
      ["safe", "bg-safe-band", "Safe"],
    ] as const) {
      const markup = band({ verdict, confidence: "high" });
      expect(tag(markup, "section")).toContain('aria-label="Verdict"');
      expect(tag(markup, "section")).toContain(colour);
      expect(tag(markup, "section")).toContain("text-on-band");
      expect(text(markup)).toContain(`${word} · high confidence`);
      expect(tag(markup, "img")).toContain(`src="${MOTION[verdict]}"`);
      expect(tag(markup, "img")).toContain('alt=""');
      expect(markup).toMatch(/<h2 [^>]*>Do not pay this invoice<\/h2>/);
      expect(text(markup)).toContain("The link asks for your mail password.");
    }
  });

  it("keeps a partial check's verdict and art and says it is partial", () => {
    const markup = band({ state: "partial", verdict: "suspicious", confidence: "medium" });
    expect(tag(markup, "section")).toContain("bg-sus-band");
    expect(text(markup)).toContain("Suspicious · medium confidence · partial check");
    expect(tag(markup, "img")).toContain(`src="${MOTION.suspicious}"`);
  });

  it("shows a failed check in the partial band with the question art and no verdict", () => {
    const markup = band({ state: "failed", verdict: undefined, confidence: undefined });
    expect(tag(markup, "section")).toContain("bg-partial-band");
    expect(text(markup)).toContain("Check failed · no verdict");
    expect(tag(markup, "img")).toContain(`src="${MOTION.question}"`);
    expect(text(markup)).not.toMatch(/Malicious|Suspicious|Safe/);
  });

  it("shows a running check on orange wash with the checking art and the time so far", () => {
    const markup = band({ state: "running", verdict: undefined, confidence: undefined, elapsed: 21 });
    expect(tag(markup, "section")).toContain("bg-orange-wash");
    expect(tag(markup, "section")).toContain("text-ink");
    expect(text(markup)).toContain("Checking · 0:21 so far");
    expect(markup).toMatch(/<p class="[^"]*text-orange-text[^"]*">Checking/);
    expect(markup).toMatch(/<p class="[^"]*text-ink-2[^"]*">The link/);
    expect(tag(markup, "img")).toContain(`src="${MOTION.checking}"`);
    expect([elapsedText(0), elapsedText(59.9), elapsedText(725)]).toEqual(["0:00", "0:59", "12:05"]);
  });

  it("builds the board's sizes at desktop and phone width", () => {
    const markup = band({});
    // Desktop: padding 28 by 32, gap 24, an 88 px tile with 72 px art, a 32 px headline (30 built 32), a 17 px sentence.
    // Phone (`Report-Mobile`): padding 20, gap 16, a 56 px tile with 40 px art, a 24 px headline and a 16 px sentence.
    for (const name of ["md:px-32", "md:py-28", "md:gap-24", "p-20", "gap-16", "rounded-card-large"])
      expect(tag(markup, "section"), name).toContain(name);
    expect(markup).toMatch(/class="[^"]*w-56 h-56[^"]*md:w-88 md:h-88[^"]*"/);
    expect(tag(markup, "img")).toMatch(/w-40 h-40 md:w-72 md:h-72/);
    expect(tag(markup, "h2")).toMatch(/ text-24 .*md:text-32/);
    expect(markup).toMatch(/<p class="[^"]*text-16 md:basis-auto md:text-17/);
    expect(markup).toMatch(/<p class="[^"]*type-eyebrow md:flex-none md:text-14/);
  });

  it("takes the heading level the page sets", () => {
    expect(band({ level: 1 })).toMatch(/<h1 [^>]*>Do not pay this invoice<\/h1>/);
  });

  it("refuses an empty headline, a verdict on a failed or running check, and none on a complete or partial one", () => {
    expect(() => band({ headline: "  " })).toThrow("needs a headline");
    expect(() => band({ state: "failed", confidence: undefined })).toThrow("a failed check has no verdict");
    expect(() => band({ state: "running", elapsed: 3 })).toThrow("a running check has no verdict");
    expect(() => band({ verdict: undefined })).toThrow("a complete check needs its verdict");
    expect(() => band({ state: "partial", verdict: undefined })).toThrow("a partial check needs its verdict");
    expect(() => band({ confidence: undefined })).toThrow("needs its confidence");
    expect(() => band({ state: "running", verdict: undefined, confidence: undefined })).toThrow("elapsed time");
  });
});

describe("VerdictBadge", () => {
  it("shows a complete check's verdict, Partial for a partial or failed one, and Checking while it runs", () => {
    const cases: [Parameters<typeof VerdictBadge>[0], string, string][] = [
      [{ state: "complete", verdict: "malicious" }, "bg-mal-wash", "Malicious"],
      [{ state: "complete", verdict: "suspicious" }, "bg-sus-wash", "Suspicious"],
      [{ state: "complete", verdict: "safe" }, "bg-safe-wash", "Safe"],
      [{ state: "partial", verdict: "suspicious" }, "bg-partial-wash", "Partial"],
      [{ state: "failed" }, "bg-partial-wash", "Partial"],
      [{ state: "running" }, "bg-orange-wash", "Checking"],
    ];
    for (const [props, colour, word] of cases) {
      const markup = html(<VerdictBadge {...props} />);
      expect(tag(markup, "span"), word).toContain(colour);
      expect(text(markup)).toBe(word);
    }
    expect(() => html(<VerdictBadge state="complete" />)).toThrow("needs its verdict");
    expect(() => html(<VerdictBadge state="running" verdict="safe" />)).toThrow("has no verdict");
  });
});

describe("SeverityPill and EvidenceRef", () => {
  const levels: [Severity, string, string][] = [
    ["critical", "bg-mal-wash", "Critical"],
    ["high", "bg-mal-wash", "High"],
    ["medium", "bg-sus-wash", "Medium"],
    ["low", "bg-light", "Low"],
    ["info", "bg-safe-wash", "Info"],
    ["not-checked", "bg-partial-wash", "Not checked"],
  ];

  it("shows every level as the evidence id and the level in words, coloured by level", () => {
    for (const [level, colour, word] of levels) {
      const markup = html(<SeverityPill id="E7" level={level} />);
      expect(tag(markup, "span"), level).toContain(colour);
      expect(text(markup)).toBe(`E7 · ${word}`);
    }
  });

  it("links a reason to its card by id, named for a screen reader with the visible id first, with the focus ring", () => {
    for (const [level, colour, word] of levels) {
      const link = tag(html(<EvidenceRef id="E7" level={level} />), "a");
      expect(link).toContain('href="#e7"');
      expect(link).toContain(`aria-label="Evidence E7, ${word.toLowerCase()}"`);
      expect(link).toContain(colour);
      expect(link).toContain("focus-visible:outline-orange-text");
    }
    expect(text(html(<EvidenceRef id="E12" level="low" />))).toBe("E12");
  });

  it("refuses an id that is not E and a number", () => {
    for (const id of ["7", "e7", "E0", "E7a", ""]) {
      expect(() => html(<SeverityPill id={id} level="low" />), id).toThrow("an evidence id is E and a number");
      expect(() => html(<EvidenceRef id={id} level="low" />), id).toThrow("an evidence id is E and a number");
    }
  });
});

describe("EvidenceCard", () => {
  const split = html(
    <EvidenceCard
      id="E7"
      level="critical"
      title="Muse Wonder walked the link like a victim would"
      meta="6 steps · 31 s · contained browser"
      footnote="Canary values only; no real password was typed."
      layout="split"
    >
      <EvidenceFigure caption='1. Lure page: one button, "View invoice"'>
        <EvidenceQuote>nimbusmai1-login.example/inv</EvidenceQuote>
      </EvidenceFigure>
      <EvidenceFigure caption="2. Fake sign-in, canary values typed" />
      <EvidenceFigure caption="3. Where the password went" />
    </EvidenceCard>,
  );
  const compact = html(
    <EvidenceCard id="E4" level="high" title="Lookalike domain, 3 days old" footnote="Registered 24 Oct 2026 (RDAP)">
      <EvidenceQuote>nimbusmai1-login.example</EvidenceQuote>
    </EvidenceCard>,
  );

  it("renders the split layout: an anchored article, a header bar with pill, title and meta, figures and a footnote", () => {
    const article = tag(split, "article");
    expect(article).toContain('id="e7"');
    expect(article).toMatch(/border border-line rounded-card-large/);
    expect(split).toMatch(/<div class="[^"]*border-b border-line[^"]*">/);
    expect(text(split)).toContain("E7 · Critical");
    expect(split).toMatch(/<h4 [^>]*>Muse Wonder walked the link like a victim would<\/h4>/);
    expect(split).toMatch(/<p class="text-14 text-muted">6 steps · 31 s · contained browser<\/p>/);
    expect(split).toMatch(/<p class="text-13 text-muted">Canary values only; no real password was typed.<\/p>/);
    // Side by side from md, stacked below.
    expect(split).toMatch(/class="grid gap-16 md:grid-flow-col md:auto-cols-fr"/);
    expect(split.match(/<figure /g)).toHaveLength(3);
    expect(split).toMatch(/<div class="[^"]*h-evidence-figure[^"]*border-line bg-subtle[^"]*">/);
    expect(split).toMatch(
      /<figcaption class="text-13 text-muted">1. Lure page: one button, &quot;View invoice&quot;<\/figcaption>/,
    );
    expect(split).toMatch(
      /<blockquote class="font-mono text-14 text-ink wrap-anywhere">nimbusmai1-login.example\/inv<\/blockquote>/,
    );
  });

  it("renders the compact layout as one padded column", () => {
    const article = tag(compact, "article");
    expect(article).toContain('id="e4"');
    expect(article).toMatch(/flex flex-col gap-12 p-24/);
    expect(compact).not.toContain("border-b");
    expect(text(compact)).toContain("E4 · High");
    expect(compact).toMatch(/<h4 [^>]*>Lookalike domain, 3 days old<\/h4>/);
    expect(text(compact)).toContain("Registered 24 Oct 2026 (RDAP)");
  });

  it("takes another heading level, and refuses an empty title, caption or quote", () => {
    expect(html(<EvidenceCard id="E1" level="info" title="Sender passes DMARC" heading={3} />)).toMatch(/<h3 /);
    expect(() => html(<EvidenceCard id="E1" level="info" title=" " />)).toThrow("needs a title");
    expect(() => html(<EvidenceFigure caption="" />)).toThrow("needs a caption");
    expect(() => html(<EvidenceQuote> </EvidenceQuote>)).toThrow("needs text");
  });
});
