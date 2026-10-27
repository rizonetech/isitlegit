import type { Child } from "hono/jsx";
import { cx, FOCUS, hasText, ids, isDisabled, nonBlank, type PassThrough, passThrough } from "./attrs";

// The app's buttons (design/SPEC.md 1, design/mockups/source/ui.css `.btn`): primary, dark, ghost, danger and link, at
// the 48 px control height or the 36 px small one. Token classes only; a board value between two scale steps is built
// as the step above (the 14 px padding of `.btn-sm` is 16; see the SPEC's shared parts).
export type ButtonVariant = "primary" | "dark" | "ghost" | "danger" | "link";
// `icon` is the 32 px square of the sidebar's copy button (board `AppNav`, 30 px built 32); `small-icon` the 36 by 40 px
// Menu button of the phone header (board `Report-Mobile`).
export type ButtonSize = "default" | "small" | "icon" | "small-icon";

type Content =
  | { children: Child; icon?: Child; label?: string }
  // An icon-only button must carry a label, its accessible name.
  | { children?: undefined; icon: Child; label: string };

type Target =
  | { href: string; type?: never; name?: never; value?: never; form?: never }
  | {
      href?: undefined;
      type?: "button" | "submit";
      name?: string;
      value?: string;
      form?: string;
      // The id of a popover this button opens and closes, with no script (the phone menu).
      popovertarget?: string;
    };

export type ButtonProps = PassThrough &
  Content &
  Target & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    id?: string;
    class?: string;
    disabled?: boolean;
    // Why the control is disabled, shown beside it and given as its description (needs `id`).
    disabledReason?: string;
  };

const DISABLED =
  "disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50";
const BOX =
  "inline-flex items-center justify-center gap-8 border border-transparent font-text weight-text-strong leading-none no-underline cursor-pointer whitespace-nowrap box-border";
const SIZE: Record<ButtonSize, string> = {
  default: "h-control px-20 rounded-control text-16",
  small: "h-control-small px-16 rounded-control-small text-14",
  icon: "h-32 w-32 px-0 rounded-control-small text-14",
  "small-icon": "h-control-small w-40 px-0 rounded-control-small text-14",
};
const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover",
  dark: "bg-dark text-on-dark hover:bg-dark-active",
  ghost: "bg-surface text-ink border-line-strong hover:border-ink",
  danger: "bg-surface text-mal border-mal",
  link: "",
};
const LINK =
  "inline-flex items-center gap-8 bg-transparent border-0 p-0 font-text weight-text-strong text-orange-text underline underline-offset-2 cursor-pointer hover:text-ink";

export function buttonClass(variant: ButtonVariant = "ghost", size: ButtonSize = "default"): string {
  return variant === "link" ? cx(LINK, FOCUS, DISABLED) : cx(BOX, SIZE[size], VARIANT[variant], FOCUS, DISABLED);
}

export function Button(props: ButtonProps) {
  const { variant = "ghost", size = "default", id, disabledReason, icon, label, children } = props;
  const disabled = isDisabled(props as Record<string, unknown>);
  const given = passThrough(props as Record<string, unknown>, disabled);
  // A caller's contextual name ("Remove Alice") wins over the generic label; a blank one is no name.
  const name = nonBlank(given["aria-label"]) ?? nonBlank(label);
  if (!name && !nonBlank(given["aria-labelledby"]) && !hasText(children))
    throw new Error("Button: an icon-only button needs a label");
  if (disabledReason && !id) throw new Error("Button: a disabled reason needs an id to describe the control");
  const reasonId = disabledReason && id ? `${id}-reason` : undefined;
  const common = {
    ...given,
    id,
    class: cx(buttonClass(variant, size), props.class),
    "aria-label": name,
    "aria-describedby": ids(given["aria-describedby"], reasonId),
  };
  const body = (
    <>
      {icon}
      {children}
    </>
  );
  const control =
    props.href !== undefined ? (
      disabled ? (
        // A link with no href: role keeps it announced as a link, unavailable; no pointer reaches it, so a delegated
        // click handler on its data hooks cannot fire, as none fires on a native disabled button.
        <a {...common} class={cx(common.class, "pointer-events-none")} role="link" aria-disabled="true">
          {body}
        </a>
      ) : (
        <a {...common} href={props.href}>
          {body}
        </a>
      )
    ) : (
      <button
        {...common}
        type={props.type ?? "button"}
        name={props.name}
        value={props.value}
        form={props.form}
        popovertarget={props.popovertarget}
        disabled={disabled}
      >
        {body}
      </button>
    );
  return reasonId ? (
    <>
      {control}
      <span id={reasonId} class="text-13 text-muted">
        {disabledReason}
      </span>
    </>
  ) : (
    control
  );
}
