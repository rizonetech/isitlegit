import { join } from "node:path";
import type { Page } from "playwright-core";

// axe-core as the accessibility gate runs it (D07 T01 §10, `pnpm test:a11y`), shared by every browser test that checks
// a page against it: the WCAG 2.2 A and AA rules with `target-size` (off by default in 4.11), and a result axe could
// not decide failing unless a person has checked it (CHECKED_INCOMPLETE, with the reason).
export const AXE = join(import.meta.dirname, "../../node_modules/axe-core/axe.min.js");
export const OPTIONS = {
  runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
  rules: { "target-size": { enabled: true } },
  iframes: false,
  resultTypes: ["violations", "incomplete"],
};

// Results axe could not decide that a person has checked: rule, a selector fragment of the target, and why it holds.
export const CHECKED_INCOMPLETE: { rule: string; target: string; reason: string }[] = [
  {
    rule: "color-contrast",
    target: "li:nth-child(7)",
    reason:
      "The provider steps' long last item (D07 T04 §11) is ink-2 on the surface in both themes, a token pair the design tokens test for AA contrast; axe cannot decide it inside the open disclosures.",
  },
  {
    rule: "color-contrast",
    target: "list-decimal",
    // (the same item also reports under the bare target below when axe cannot make its selector unique)
    reason:
      "The provider steps' long last item (D07 T04 §11) is ink-2 on the surface in both themes, a token pair the design tokens test for AA contrast; axe cannot decide it inside the open disclosures.",
  },
];

type Finding = {
  id: string;
  impact: string | null;
  nodes: { target: string[]; failureSummary?: string | undefined }[];
};
export type Scan = { violations: Finding[]; incomplete: Finding[] };

// axe over the page as it is now (it must already hold axe: `page.addScriptTag({ path: AXE })`).
export const scan = (p: Page): Promise<Scan> =>
  p.evaluate(async (options) => {
    const result = await (window as unknown as { axe: { run: (c: Document, o: unknown) => Promise<Scan> } }).axe.run(
      document,
      options,
    );
    const slim = (list: Finding[]) =>
      list.map((f) => ({
        id: f.id,
        impact: f.impact,
        nodes: f.nodes.map((n) => ({ target: n.target, failureSummary: n.failureSummary })),
      }));
    return { violations: slim(result.violations), incomplete: slim(result.incomplete) };
  }, OPTIONS);

// What a scan leaves unresolved: every violation, and every undecided result no person has checked.
export function problems(result: Scan): string[] {
  const unchecked = result.incomplete.flatMap((f) =>
    f.nodes
      .filter((n) => !CHECKED_INCOMPLETE.some((c) => c.rule === f.id && n.target.join(" ").includes(c.target)))
      .map((n) => `incomplete ${f.id} ${n.target.join(" ")}`),
  );
  const violations = result.violations.flatMap((f) =>
    f.nodes.map((n) => `${f.id} ${n.target.join(" ")}: ${n.failureSummary ?? ""}`.slice(0, 300)),
  );
  return [...violations, ...unchecked];
}
