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

function attribute(node: DomNode, name: string): string {
  const a = node.attributes ?? [];
  for (let i = 0; i + 1 < a.length; i += 2) if ((a[i] as string).toLowerCase() === name) return a[i + 1] as string;
  return "";
}

// The counts over a node and everything beneath it, or null past `MAX_NODES`. An explicit stack, so a deep tree cannot
// overflow the call stack.
export function countNodes(root: DomNode): Signals | null {
  const found = { inputs: 0, passwords: 0, forms: 0, iframes: 0, components: 0 };
  const stack: DomNode[] = [root];
  let seen = 0;
  while (stack.length) {
    const node = stack.pop() as DomNode;
    if (++seen > MAX_NODES) return null;
    const name = (node.nodeName ?? "").toUpperCase();
    // A custom element's name has a hyphen; a node such as `#document-fragment` is no element.
    if (!name.startsWith("#") && name.includes("-")) found.components++;
    if (name === "INPUT" || name === "TEXTAREA" || name === "SELECT") {
      const type = attribute(node, "type").toLowerCase();
      if (!SKIPPED_INPUTS.has(type)) found.inputs++;
      if (type === "password") found.passwords++;
    } else if (name === "FORM") found.forms++;
    else if (name === "IFRAME") found.iframes++;
    for (const group of [
      node.children,
      // The browser's own shadow roots are its internals, not the page's: only a root a script attached is walked.
      node.shadowRoots?.filter((root) => root.shadowRootType !== "user-agent"),
      node.pseudoElements,
      node.contentDocument ? [node.contentDocument] : undefined,
      node.templateContent ? [node.templateContent] : undefined,
      node.importedDocument ? [node.importedDocument] : undefined,
    ])
      if (group) for (const child of group) stack.push(child);
  }
  return found;
}

// The page's counts, or null when the protocol fails or answers anything but a document: no signals, which screens the
// page, never zero counts, which could park it.
export async function pageSignals(cdp: Cdp): Promise<Signals | null> {
  try {
    const answer = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as { root?: DomNode } | null;
    return answer?.root && typeof answer.root === "object" ? countNodes(answer.root) : null;
  } catch {
    return null;
  }
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
  return inputs === null || passwords === null || forms === null || iframes === null || components === null
    ? null
    : { inputs, passwords, forms, iframes, components };
}
