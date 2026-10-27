// Attributes every shared control passes through to its element (D07 T01 §6): accessibility, data hooks for the app
// script, and htmx. Anything else a page needs is a prop of the control, not a raw attribute.
export type PassThrough = {
  [key: `aria-${string}`]: string | boolean | undefined;
  [key: `data-${string}`]: string | undefined;
  [key: `hx-${string}`]: string | undefined;
};

// The pass-through attributes of a props object, to spread onto the rendered element.
export function passThrough(props: Record<string, unknown>): PassThrough {
  return Object.fromEntries(Object.entries(props).filter(([key]) => /^(aria|data|hx)-/.test(key))) as PassThrough;
}

export const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" ");
