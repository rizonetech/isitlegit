import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_CSS, LOGO_MARK, MOTION } from "../../src/web/assets";
import { Button } from "../../src/web/components/Button";
import {
  EmptyState,
  type EmptyStateProps,
  ErrorState,
  type ErrorStateProps,
  LoadingState,
  PartialNotice,
  referenceLine,
} from "../../src/web/components/States";
import { ERRORS } from "./states-fixtures";

// The empty, loading, error and partial states (D07 T01 §8) render their boards' words, structure and token classes,
// and refuse what the boards cannot show. The live region, reduced motion, contrast and the phone width are checked in
// Chromium by states-browser.test.tsx.
const html = (node: unknown) => String(node);
const tag = (markup: string, name: string) => new RegExp(`<${name}\\b[^>]*>`).exec(markup)?.[0] ?? "";
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
const buttons = (markup: string) => [...markup.matchAll(/<a\b[^>]*>|<button\b[^>]*>/g)].map((m) => m[0]);

describe("EmptyState", () => {
  const firstRun = (children?: unknown) =>
    html(
      <EmptyState
        layout="first-run"
        eyebrow="No cases yet"
        title="Check your first suspicious email."
        sentence="Forward it as an attachment, so its original headers come along."
      >
        {children as string}
      </EmptyState>,
    );

  it("draws the first run: the question art beside the eyebrow, heading, sentence and the page's own content", () => {
    const markup = firstRun(<p id="forward-box">Forward it, as an attachment, to check@isitlegit.co.za</p>);
    expect(tag(markup, "img")).toContain(`src="${MOTION.question}"`);
    expect(tag(markup, "img")).toContain('alt=""');
    expect(tag(markup, "img")).toContain("md:w-empty-art");
    expect(markup).toMatch(/<p class="[^"]*type-eyebrow[^"]*">No cases yet<\/p>/);
    expect(markup).toMatch(/<h2 [^>]*>Check your first suspicious email\.<\/h2>/);
    expect(markup).toMatch(/<p class="[^"]*text-18[^"]*text-muted[^"]*">Forward it as an attachment/);
    expect(markup).toContain('id="forward-box"');
    expect(tag(markup, "section")).toContain("rounded-card-large");
    expect(tag(markup, "section")).toContain("md:p-48");
  });

  it("draws the filtered state with and without its action", () => {
    const props: EmptyStateProps = {
      layout: "filtered",
      title: 'No cases match "statement", Malicious, last 7 days.',
      sentence: "64 cases in total. Try a wider date range or another verdict.",
    };
    const bare = html(<EmptyState {...props} />);
    expect(bare).toMatch(/<h3 [^>]*>No cases match &quot;statement&quot;, Malicious, last 7 days\.<\/h3>/);
    expect(text(bare)).toContain("64 cases in total. Try a wider date range or another verdict.");
    expect(buttons(bare)).toHaveLength(0);
    const withAction = html(
      <EmptyState
        {...props}
        action={
          <Button variant="ghost" href="/cases">
            Clear filters
          </Button>
        }
      />,
    );
    expect(buttons(withAction)).toHaveLength(1);
    expect(text(withAction)).toContain("Clear filters");
    expect(tag(withAction, "section")).toContain("md:p-32");
  });

  it("sets the heading level the page asks for", () => {
    const markup = html(<EmptyState layout="filtered" level={2} title="No suppliers yet." sentence="Add one." />);
    expect(markup).toMatch(/<h2 [^>]*>No suppliers yet\.<\/h2>/);
  });

  it("refuses a blank heading, sentence or first-run eyebrow", () => {
    expect(() => html(<EmptyState layout="filtered" title=" " sentence="Try again." />)).toThrow(/heading/);
    expect(() => html(<EmptyState layout="filtered" title="Nothing" sentence="" />)).toThrow(/sentence/);
    expect(() => html(<EmptyState layout="first-run" eyebrow=" " title="Nothing" sentence="Forward one." />)).toThrow(
      /eyebrow/,
    );
  });
});

describe("LoadingState", () => {
  it("is a polite live region with its words and a square that pulses only when motion is allowed", () => {
    const markup = html(<LoadingState>Running</LoadingState>);
    const region = tag(markup, "p");
    expect(region).toContain('role="status"');
    expect(region).toContain('aria-live="polite"');
    expect(region).toContain("text-orange-text");
    expect(text(markup)).toBe("Running");
    expect(tag(markup, "span")).toContain('aria-hidden="true"');
    expect(tag(markup, "span")).toContain("motion-safe:animate-pulse");
    expect(tag(markup, "span")).not.toMatch(/(^|\s|")animate-pulse/);
  });

  it("ships the pulse only inside the no-preference media query, with its keyframes", () => {
    const css = readFileSync(join(import.meta.dirname, "../../public", APP_CSS), "utf8");
    expect(css).toMatch(/@keyframes pulse\s*\{/);
    // Minified: the media query wraps the rule, and no other rule animates the square.
    expect(css).toMatch(
      /@media \(prefers-reduced-motion:\s*no-preference\)\s*\{\s*\.motion-safe\\:animate-pulse\s*\{\s*animation:\s*var\(--animate-pulse\)/,
    );
    expect(css).not.toMatch(/(^|[^:])\.animate-pulse\s*\{/);
    expect(css).toMatch(/--animate-pulse:\s*pulse 2s ease-in-out infinite/);
  });

  it("refuses blank words", () => {
    expect(() => html(<LoadingState> </LoadingState>)).toThrow(/words/);
  });
});

describe("referenceLine", () => {
  it("writes the id and the time in South Africa", () => {
    // The boards print "Mon 27 Oct 2026", sample data: 27 October 2026 is a Tuesday.
    expect(referenceLine("404-7F3K2Q", new Date("2026-10-27T08:12:30Z"))).toBe(
      "Reference 404-7F3K2Q · Tue 27 Oct 2026, 10:12 SAST",
    );
    // Past midnight in South Africa while still the day before in UTC.
    expect(referenceLine("500-8K1V3P", new Date("2026-10-27T22:05:00Z"))).toBe(
      "Reference 500-8K1V3P · Wed 28 Oct 2026, 00:05 SAST",
    );
  });

  it("refuses a blank id or an invalid time", () => {
    expect(() => referenceLine(" ", new Date())).toThrow(/id/);
    expect(() => referenceLine("404-1", new Date("nope"))).toThrow(/time/);
  });
});

describe("ErrorState", () => {
  const BOARDS: [string, string, string, string[]][] = [
    // [composition, art, eyebrow colour, action variants]
    ["404", MOTION.question, "text-orange-text", ["bg-dark", "bg-surface"]],
    ["403", LOGO_MARK, "text-orange-text", ["bg-dark", "bg-surface"]],
    ["410", MOTION.question, "text-orange-text", ["bg-dark"]],
    ["429", MOTION.suspicious, "text-sus", ["bg-dark", "bg-surface"]],
    ["500", MOTION.question, "text-mal", ["bg-dark", "bg-surface"]],
    ["maintenance", MOTION.checking, "text-orange-text", ["bg-surface"]],
  ];

  for (const [key, art, colour, variants] of BOARDS)
    it(`draws the ${key} board: its art, eyebrow, title, sentence, actions and reference`, () => {
      const props = ERRORS[key] as ErrorStateProps;
      const markup = html(<ErrorState {...props} />);
      expect(tag(markup, "img")).toContain(`src="${art}"`);
      expect(tag(markup, "img")).toContain('alt=""');
      const eyebrow = key === "maintenance" ? "Planned maintenance" : `Error ${key}`;
      expect(markup).toMatch(new RegExp(`<p class="type-eyebrow ${colour}">${eyebrow}</p>`));
      expect(text(tag(markup, "h1") + markup.split(/<h1[^>]*>/)[1]?.split("</h1>")[0])).toBe(props.title);
      const found = buttons(markup);
      expect(found).toHaveLength(variants.length);
      found.forEach((button, i) => {
        expect(button).toContain(variants[i]);
      });
      expect(text(markup)).toContain(props.footer);
      expect(text(markup)).toContain("IsItLegit by Rizonetech");
      expect(markup).toContain("md:w-state-art");
    });

  it("keeps 403's signed-in address inline in its sentence", () => {
    const markup = html(<ErrorState {...(ERRORS[403] as ErrorStateProps)} />);
    expect(text(markup)).toContain(
      "You are signed in as ayesha@outeniquapaper.example, which has no access here. Ask an owner",
    );
  });

  it("draws 429's burst limit as a panel and the forwarding reminder as a plain note", () => {
    const busy = html(<ErrorState {...(ERRORS[429] as ErrorStateProps)} />);
    expect(busy).toMatch(/<div class="[^"]*bg-subtle[^"]*border-line[^"]*rounded-card-large[^"]*">/);
    expect(text(busy)).toContain("Too many requests at once? The same page also covers a short burst limit");
    const missing = html(<ErrorState {...(ERRORS[404] as ErrorStateProps)} />);
    expect(missing).not.toContain("bg-subtle");
    expect(text(missing)).toContain("Forwarding still works: send suspicious mail to check@isitlegit.co.za as usual.");
  });

  it("has no slot for an error's own text: every word is one the page chose", () => {
    // Only these props reach the page; there is no `error`, `message` or `stack` prop to pass a thrown error through.
    const keys: (keyof ErrorStateProps)[] = ["code", "title", "children", "actions", "note", "panel", "footer"];
    const props = { ...(ERRORS[500] as ErrorStateProps), stack: "TypeError: at x.ts:1" } as ErrorStateProps;
    expect(Object.keys(ERRORS[500] as object).every((key) => keys.includes(key as keyof ErrorStateProps))).toBe(true);
    expect(html(<ErrorState {...props} />)).not.toContain("TypeError");
  });

  it("refuses a blank title, no actions, more than two, or an error without its reference", () => {
    const base = ERRORS[404] as ErrorStateProps;
    expect(() => html(<ErrorState {...base} title=" " />)).toThrow(/title/);
    expect(() => html(<ErrorState {...base} actions={[]} />)).toThrow(/one or two actions/);
    const three = [...base.actions, <Button href="/">Home</Button>];
    expect(() => html(<ErrorState {...base} actions={three} />)).toThrow(/one or two actions/);
    expect(() => html(<ErrorState {...base} footer="" />)).toThrow(/reference line/);
    expect(() => html(<ErrorState {...base} footer="Mon 27 Oct 2026" />)).toThrow(/referenceLine/);
    expect(() => html(<ErrorState {...base}> </ErrorState>)).toThrow(/sentence/);
  });
});

describe("PartialNotice", () => {
  const TWO = [
    {
      name: "Walkthrough (Muse Wonder)",
      reason:
        "today's model limit was reached at 15:20. We could not see where the sign-in form sends passwords. The limit resets at 00:00 SAST.",
    },
    {
      name: "Google Web Risk",
      reason: "the service did not answer within 10 seconds. The link was not checked against its list.",
    },
  ];

  it("names two checks that did not run, why, and what that means for the verdict", () => {
    const markup = html(<PartialNotice skipped={TWO} ran={6} />);
    expect(tag(markup, "section")).toContain('role="note"');
    expect(tag(markup, "section")).toContain('aria-label="Partial check"');
    expect(tag(markup, "section")).toContain("bg-partial-wash");
    expect(tag(markup, "section")).toContain("border-l-partial");
    expect(markup).toMatch(/<h4 [^>]*>Two checks did not run, so this verdict rests on the six that did\.<\/h4>/);
    expect(markup).toContain("<strong>Walkthrough (Muse Wonder):</strong> today&#39;s model limit");
    expect(markup).toContain("<strong>Google Web Risk:</strong> the service did not answer");
    expect([...markup.matchAll(/<li\b/g)]).toHaveLength(2);
    expect(text(markup)).toContain(
      "What this means: the verdict could be stronger with the missing checks, never weaker. We will not guess what they would have found.",
    );
    expect(tag(markup, "svg")).toContain('aria-hidden="true"');
  });

  it("counts one check in the singular", () => {
    const markup = html(<PartialNotice skipped={TWO.slice(1)} ran={7} />);
    expect(text(markup)).toContain("One check did not run, so this verdict rests on the seven that did.");
  });

  it("refuses an empty list, a negative or fractional count, or a check without its name or reason", () => {
    expect(() => html(<PartialNotice skipped={[]} ran={6} />)).toThrow(/did not run/);
    expect(() => html(<PartialNotice skipped={TWO} ran={-1} />)).toThrow(/zero or more/);
    expect(() => html(<PartialNotice skipped={TWO} ran={1.5} />)).toThrow(/zero or more/);
    expect(() => html(<PartialNotice skipped={[{ name: " ", reason: "x" }]} ran={1} />)).toThrow(/name and reason/);
  });
});
