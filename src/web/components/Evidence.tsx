import { cx, FOCUS, nonBlank } from "./attrs";
import { Pill, type PillVariant, pillClass } from "./Pill";

// A finding's severity and its proof (D07 T01 §7; design/SPEC.md M3; boards `Main`, `Report-Safe`, `Report-Partial`,
// `Report-Running`). Severity is a pill carrying the evidence id and the level in words ("E7 · Critical"), coloured by
// level; each reason links to its card with an "E7" pill, and the card carries that id as its anchor.
export type Severity = "critical" | "high" | "medium" | "low" | "info" | "not-checked";

const LEVEL: Record<Severity, { variant: PillVariant; word: string }> = {
  critical: { variant: "malicious", word: "Critical" },
  high: { variant: "malicious", word: "High" },
  medium: { variant: "suspicious", word: "Medium" },
  low: { variant: "neutral", word: "Low" },
  info: { variant: "safe", word: "Info" },
  "not-checked": { variant: "partial", word: "Not checked" },
};

// An evidence id ("E7"), and its anchor on the page ("e7").
function anchor(component: string, id: string): string {
  if (!/^E[1-9]\d*$/.test(id)) throw new Error(`${component}: an evidence id is E and a number, such as E7`);
  return id.toLowerCase();
}

export type SeverityPillProps = { id: string; level: Severity };

export function SeverityPill(props: SeverityPillProps) {
  anchor("SeverityPill", props.id);
  const { variant, word } = LEVEL[props.level];
  return <Pill variant={variant}>{`${props.id} · ${word}`}</Pill>;
}

export type EvidenceRefProps = { id: string; level: Severity };

// The reasons' link to a card: "E7" in the level's colour, named "Evidence E7, critical" for a screen reader (the
// visible "E7" first, so speech input that says what it sees still finds it), with the shared focus ring.
export function EvidenceRef(props: EvidenceRefProps) {
  const target = anchor("EvidenceRef", props.id);
  const { variant, word } = LEVEL[props.level];
  return (
    <a
      href={`#${target}`}
      aria-label={`Evidence ${props.id}, ${word.toLowerCase()}`}
      class={cx(pillClass(variant), "no-underline", FOCUS)}
    >
      {props.id}
    </a>
  );
}

export type EvidenceCardProps = {
  id: string;
  level: Severity;
  title: string;
  // Facts about the check on the right of the header ("6 steps · 31 s · contained browser").
  meta?: string;
  footnote?: string;
  layout?: "split" | "compact";
  // The card's heading level in the page's outline; the report's cards are h4 under its section headings.
  heading?: 3 | 4 | 5;
  children?: unknown;
};

// One finding: `split` (a header bar over a padded body, `Main` E7) for a finding with figures, `compact` (one padded
// column, `Main` E4) for a short one. Its words come from findings and may hold a long domain or file name, so every
// line wraps anywhere rather than widening or clipping the card. A split card's body puts its parts side by side from `md` and stacks them below.
export function EvidenceCard(props: EvidenceCardProps) {
  const { id, level, meta, footnote, layout = "compact", heading = 4, children } = props;
  const target = anchor("EvidenceCard", id);
  const title = nonBlank(props.title);
  if (!title) throw new Error("EvidenceCard: a card needs a title");
  const Heading = `h${heading}` as "h4";
  const head = (
    <div class="flex min-w-0 items-center gap-12">
      <SeverityPill id={id} level={level} />
      <Heading class="min-w-0 font-heading weight-heading text-16 wrap-anywhere">{title}</Heading>
    </div>
  );
  const metaLine = nonBlank(meta) && <p class="text-14 text-muted wrap-anywhere">{meta}</p>;
  const foot = nonBlank(footnote) && <p class="text-13 text-muted wrap-anywhere">{footnote}</p>;
  // Scrolled into view below the page's top edge when its pill is followed, and focused then (tabindex -1: reached by
  // its pill, not by Tab), so a keyboard or screen reader user lands on the finding.
  const card = "scroll-mt-24 bg-surface border border-line rounded-card-large";
  if (layout === "split")
    return (
      <article id={target} tabindex={-1} class={cx(card, "overflow-hidden")}>
        <div class="flex flex-wrap items-center justify-between gap-12 px-24 py-20 border-b border-line">
          {head}
          {metaLine}
        </div>
        <div class="flex flex-col gap-16 px-24 py-20">
          <div class="grid gap-16 md:grid-flow-col md:auto-cols-fr">{children}</div>
          {foot}
        </div>
      </article>
    );
  return (
    <article id={target} tabindex={-1} class={cx(card, "flex flex-col gap-12 p-24")}>
      {head}
      {metaLine}
      {children}
      {foot}
    </article>
  );
}

export type EvidenceFigureProps = { caption: string; children?: unknown };

// A framed proof (a page's screenshot, where a password went) and its caption, as the boards repeat it inside a split
// card: 150 px high on the board, built 152 (`evidence-figure`).
export function EvidenceFigure(props: EvidenceFigureProps) {
  const caption = nonBlank(props.caption);
  if (!caption) throw new Error("EvidenceFigure: a figure needs a caption");
  return (
    <figure class="flex min-w-0 flex-col gap-8">
      <div class="flex h-evidence-figure flex-col overflow-hidden rounded-control border border-line bg-subtle">
        {props.children}
      </div>
      <figcaption class="text-13 text-muted wrap-anywhere">{caption}</figcaption>
    </figure>
  );
}

// Text quoted from the message or the page (a subject line, a domain, a request) in the board's code panel (ui.css
// `.code`: `light`, an 8 px radius, the cards' 10 px padding built 12), set apart from the report's own words. It wraps
// anywhere, where the board scrolls sideways, so a long domain is read whole and never widens the card.
export function EvidenceQuote(props: { children: string }) {
  if (!props.children.trim()) throw new Error("EvidenceQuote: a quote needs text");
  return (
    <blockquote class="p-12 rounded-control-small bg-light font-mono text-14 text-ink wrap-anywhere">
      {props.children}
    </blockquote>
  );
}
