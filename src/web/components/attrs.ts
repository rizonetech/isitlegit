// Attributes every shared control passes through to its element (D07 T01 §6): accessibility, data hooks for the app
// script, and htmx. Anything else a page needs is a prop of the control, not a raw attribute.
export type PassThrough = {
  [key: `aria-${string}`]: string | boolean | undefined;
  [key: `data-${string}`]: string | undefined;
  [key: `hx-${string}`]: string | undefined;
};

// The pass-through attributes of a props object, to spread onto the rendered element. A disabled control keeps no htmx
// action in either spelling (`hx-` or `data-hx-`): htmx ignores aria-disabled and would still send the request.
export function passThrough(props: Record<string, unknown>, disabled = false): PassThrough {
  return Object.fromEntries(
    Object.entries(props).filter(([key]) => /^(aria|data|hx)-/.test(key) && !(disabled && /^(data-)?hx-/.test(key))),
  ) as PassThrough;
}

// Disabled by the control's own prop or by a caller's aria-disabled: a control that looks disabled must also act it.
export const isDisabled = (props: Record<string, unknown>) =>
  props.disabled === true || props["aria-disabled"] === true || props["aria-disabled"] === "true";

// The focus indicator of every control: a solid 2 px outline 2 px outside it in `orange-text`, 4.7:1 or more against
// every background the boards place controls on, in both themes (a SPEC deviation, design/SPEC.md 1).
export const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-text";
// The same ring on the dark admin sidebar, where `orange-text` measures 3.41:1 and `orange-on-dark` 6.17:1 or more.
export const FOCUS_ON_DARK =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-on-dark";

// A string with something in it, or undefined: a blank name is no name.
export const nonBlank = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);

// Whether content names a control: text that is not inside an aria-hidden element. Function components are expanded,
// so an icon component (an aria-hidden svg) is not taken for text; an async one cannot be seen into and counts.
export function hasText(node: unknown): boolean {
  if (node === null || node === undefined || typeof node === "boolean") return false;
  if (typeof node === "string" || node instanceof String) return node.trim() !== "";
  if (typeof node === "number") return true;
  if (Array.isArray(node)) return node.some(hasText);
  if (node instanceof Promise) return true;
  const {
    tag,
    props = {},
    children = [],
  } = node as { tag?: unknown; props?: Record<string, unknown>; children?: unknown };
  if (props["aria-hidden"] === true || props["aria-hidden"] === "true") return false;
  return typeof tag === "function" ? hasText(tag(props)) : hasText(children);
}

export const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" ");

// Space-separated id lists merged without repeats (aria-describedby from the caller and from the control), or undefined.
export function ids(...lists: (string | boolean | undefined)[]): string | undefined {
  const all = lists.flatMap((list) => (typeof list === "string" ? list.split(/\s+/) : [])).filter(Boolean);
  return all.length ? [...new Set(all)].join(" ") : undefined;
}
