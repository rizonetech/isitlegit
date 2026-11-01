// What the page holds that a text read cannot show (D05 T04 §3, correction 10), counted at capture time: its input fields
// (not the hidden, submit, button, image or reset kinds), its password fields, forms and frames, and its components.
// The parking rules (./parked.ts) park a page only when it has none, however few words it says.
//
// The counts come from the browser's own document tree over the DevTools protocol (`DOM.getDocument` with `pierce`),
// never from script run in the page: that tree includes every shadow root, closed ones too, and the frames' documents,
// and nothing the page does (patching `querySelectorAll`, `slice` or `attachShadow`, hiding a root from an expression,
// attaching one through another frame's native function) can change what the Worker is sent (completion review G1 and
// round 1). Custom elements are counted as components besides, a doubt that always screens the page. A tree too big to
// walk is no signals, which screens the page.
import type { Signals } from "./parked";

// The part of the protocol's node this reads: its name, attributes as a flat name, value list, and every place a child
// document can sit.
export type DomNode = {
  nodeType?: number;
  nodeValue?: string;
  nodeName?: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
  templateContent?: DomNode;
  pseudoElements?: DomNode[];
  importedDocument?: DomNode;
  // A shadow root's kind: the browser's own (`user-agent`, inside an input or a video, nothing a page wrote), `open` or
  // `closed`.
  shadowRootType?: string;
};
export type Cdp = { send: (method: string, params?: object) => Promise<unknown> };

// A page with more nodes than this is not walked: it is screened.
export const MAX_NODES = 50_000;
const SKIPPED_INPUTS = new Set(["hidden", "submit", "button", "image", "reset"]);

// An attribute's value, or null when the node has none (an attribute present with no value is the empty string).
function attributeOf(node: DomNode, name: string): string | null {
  const a = node.attributes ?? [];
  for (let i = 0; i + 1 < a.length; i += 2) if ((a[i] as string).toLowerCase() === name) return a[i + 1] as string;
  return null;
}

// Whether a visitor can type into this element: a text area or a menu, an input of a kind that takes typing, or anything
// marked editable (any value but `false`, since an invalid one is read as editable here, the doubtful way).
function takesTyping(node: DomNode, name: string, inputType: string): boolean {
  if (name.startsWith("#")) return false;
  if (name === "TEXTAREA" || name === "SELECT") return true;
  if (name === "INPUT" && !SKIPPED_INPUTS.has(inputType)) return true;
  const editable = attributeOf(node, "contenteditable");
  return editable !== null && editable.toLowerCase() !== "false";
}

// Text from these never shows on the page, so it is not the page's text.
const NOT_TEXT = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD"]);
// Enough text to tell a short page from a long one: the parking rules read nothing past 2,000 characters.
export const TEXT_CAP = 5_000;

// What one walk of the tree finds: the counts, and how many characters of text the document holds (hidden or not), which
// the browser's rendered text is taken from the total of to say how much the page hides.
type Walk = { found: Omit<Signals, "hidden">; chars: number };

// A node and everything beneath it, or null past `MAX_NODES`. An explicit stack, so a deep tree cannot overflow the
// call stack; each entry says whether its text counts as the page's text (not under a script, a style or the head).
function walk(root: DomNode): Walk | null {
  const found = { inputs: 0, passwords: 0, forms: 0, iframes: 0, components: 0 };
  // Every character of the page's text in the tree, hidden or not: what the browser renders is taken from its
  // accessibility tree, and the difference is what the page hides.
  let chars = 0;
  const stack: { node: DomNode; shows: boolean }[] = [{ node: root, shows: true }];
  let seen = 0;
  while (stack.length) {
    const { node, shows } = stack.pop() as { node: DomNode; shows: boolean };
    if (++seen > MAX_NODES) return null;
    const name = (node.nodeName ?? "").toUpperCase();
    if (shows && node.nodeType === 3 && typeof node.nodeValue === "string")
      chars += node.nodeValue.replace(/\s+/g, " ").trim().length;
    // A custom element's name has a hyphen; a node such as `#document-fragment` is no element.
    if (!name.startsWith("#") && name.includes("-")) found.components++;
    // Only an `input` has a type that decides whether it takes typing; a textarea or a select always does, whatever
    // `type` its markup claims, and an element made editable does too (round 2).
    const type = name === "INPUT" ? (attributeOf(node, "type") ?? "").toLowerCase() : "";
    if (takesTyping(node, name, type)) found.inputs++;
    if (type === "password") found.passwords++;
    if (name === "FORM") found.forms++;
    if (name === "IFRAME") found.iframes++;
    const below = shows && !NOT_TEXT.has(name);
    const groups = [
      node.children,
      // The browser's own shadow roots are its internals, not the page's: only a root a script attached is walked.
      node.shadowRoots?.filter((root) => root.shadowRootType !== "user-agent"),
      node.pseudoElements,
      node.contentDocument ? [node.contentDocument] : undefined,
      node.templateContent ? [node.templateContent] : undefined,
      node.importedDocument ? [node.importedDocument] : undefined,
    ];
    // Pushed last first, so the stack gives the children back in document order.
    for (let g = groups.length - 1; g >= 0; g--) {
      const group = groups[g];
      if (group) for (let k = group.length - 1; k >= 0; k--) stack.push({ node: group[k] as DomNode, shows: below });
    }
  }
  return { found, chars };
}

// The counts over a node and everything beneath it, or null past `MAX_NODES`.
export function countNodes(root: DomNode): Signals | null {
  const walked = walk(root);
  return walked ? { ...walked.found, hidden: 0 } : null;
}

// The page's counts, or null when the protocol fails or answers anything but a document: no signals, which screens the
// page, never zero counts, which could park it.
export async function pageSignals(cdp: Cdp): Promise<Signals | null> {
  return (await snapshot(cdp)).signals;
}

// A node of the browser's accessibility tree: it leaves out what the browser does not render (`display:none`, the
// `hidden` attribute, `visibility:hidden`, `aria-hidden`), marking such nodes ignored.
type AxNode = { ignored?: boolean; role?: { value?: unknown }; name?: { value?: unknown } };

// The text the browser renders: the names of its accessibility tree's text nodes that are not ignored, whitespace
// collapsed and capped, and how many characters there are of it (past the cap too).
function renderedText(nodes: AxNode[]): { text: string; chars: number } {
  const pieces: string[] = [];
  let chars = 0;
  let length = 0;
  for (const node of nodes) {
    if (node.ignored || node.role?.value !== "StaticText" || typeof node.name?.value !== "string") continue;
    const piece = node.name.value.replace(/\s+/g, " ").trim();
    if (!piece) continue;
    chars += piece.length;
    if (length < TEXT_CAP) {
      pieces.push(piece);
      length += piece.length + 1;
    }
  }
  return { text: pieces.join(" ").slice(0, TEXT_CAP), chars };
}

// One snapshot of the page over the protocol: its counts, how much of its text it hides, and the text it renders (from
// the accessibility tree, which leaves out what is hidden), or nulls when the protocol fails or the tree is too big to
// walk, which screens the page (completion review rounds 3 and 4).
export async function snapshot(cdp: Cdp): Promise<{ signals: Signals | null; text: string | null }> {
  try {
    const document = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as { root?: DomNode } | null;
    const walked = document?.root && typeof document.root === "object" ? walk(document.root) : null;
    const tree = (await cdp.send("Accessibility.getFullAXTree", {})) as { nodes?: AxNode[] } | null;
    if (!walked || !Array.isArray(tree?.nodes)) return { signals: null, text: null };
    const shown = renderedText(tree.nodes);
    return {
      signals: { ...walked.found, hidden: Math.max(0, walked.chars - shown.chars) },
      text: shown.text,
    };
  } catch {
    return { signals: null, text: null };
  }
}

// What a capture keeps of a page for the parking decision, and in what order it is gathered (completion review round 3):
// the page can run script of its own at any moment, and reading `innerText` runs a getter it may have redefined to
// delete its form on the spot. So the structure is read twice over the protocol, either side of the screenshot, a field
// counted if it was there at either moment; the parking text comes from that same trusted tree; and the page-controlled
// `innerText`, which only the model reads, comes last, after nothing is left to hide.
export type Evidence = { screenshot: Uint8Array; text: string; signals: Signals | null; parkText: string | null };
export async function collectEvidence(io: {
  cdp: Cdp;
  screenshot: () => Promise<Uint8Array>;
  text: () => Promise<string>;
}): Promise<Evidence> {
  const before = await snapshot(io.cdp);
  const screenshot = await io.screenshot();
  const after = await snapshot(io.cdp);
  const signals = mostOf(before.signals, after.signals);
  // The longer text of the two, so a page that shortened itself between them is not taken for a short one.
  const parkText =
    signals && before.text !== null && after.text !== null
      ? after.text.length > before.text.length
        ? after.text
        : before.text
      : null;
  return { screenshot, signals, parkText, text: await io.text() };
}

// The larger of each count, null if either snapshot could not be read.
function mostOf(a: Signals | null, b: Signals | null): Signals | null {
  if (!a || !b) return null;
  return {
    inputs: Math.max(a.inputs, b.inputs),
    passwords: Math.max(a.passwords, b.passwords),
    forms: Math.max(a.forms, b.forms),
    iframes: Math.max(a.iframes, b.iframes),
    components: Math.max(a.components, b.components),
    hidden: Math.max(a.hidden, b.hidden),
  };
}

// Five whole counts as signals, or null: what the stored `signals.json` is read through.
export function readCounts(value: unknown): Signals | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const count = (k: string) => (Number.isInteger(v[k]) && (v[k] as number) >= 0 ? (v[k] as number) : null);
  const inputs = count("inputs");
  const passwords = count("passwords");
  const forms = count("forms");
  const iframes = count("iframes");
  const components = count("components");
  const hidden = count("hidden");
  return inputs === null ||
    passwords === null ||
    forms === null ||
    iframes === null ||
    components === null ||
    hidden === null
    ? null
    : { inputs, passwords, forms, iframes, components, hidden };
}
