// The site's shared control looks, built from token utilities only, mirroring the app's buttons, pills and focus ring
// (src/web/components/Button.tsx, Pill.tsx, attrs.ts FOCUS; design/SPEC.md 1).
export const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-text";
export const FOCUS_ON_DARK = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-on-dark";

const BOX =
  "inline-flex items-center justify-center gap-8 max-w-full border font-text weight-text-strong leading-none text-center no-underline whitespace-nowrap";
const SMALL = "min-h-control-small py-4 px-16 rounded-control-small text-14";
const LARGE = "min-h-control py-8 px-20 rounded-control text-16";
const PRIMARY = "bg-accent text-on-accent border-transparent hover:bg-accent-hover";
const GHOST = "bg-surface text-ink border-line-strong hover:border-ink";
const DARK = "bg-dark text-on-dark border-transparent hover:bg-dark-active";

export const button = {
  primarySmall: `${BOX} ${SMALL} ${PRIMARY} ${FOCUS}`,
  ghostSmall: `${BOX} ${SMALL} ${GHOST} ${FOCUS}`,
  primary: `${BOX} ${LARGE} ${PRIMARY} ${FOCUS}`,
  ghost: `${BOX} ${LARGE} ${GHOST} ${FOCUS}`,
  dark: `${BOX} ${LARGE} ${DARK} ${FOCUS}`,
};

export const LINK = `text-orange-text underline underline-offset-2 hover:text-ink rounded-small ${FOCUS}`;
export const LINK_ON_DARK = `text-orange-on-dark underline underline-offset-2 hover:text-on-dark rounded-small ${FOCUS_ON_DARK}`;
export const CARD = "rounded-card border border-line bg-surface";
export const PILL = "inline-flex items-center px-12 h-24 rounded-pill text-13 weight-heading whitespace-nowrap";
