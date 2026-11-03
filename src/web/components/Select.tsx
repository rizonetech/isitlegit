import type { Child } from "hono/jsx";
import { cx, FIELD_FOCUS, isDisabled, type PassThrough, passThrough } from "./attrs";
import { ChevronIcon } from "./icons";

// Shared combobox (D07 T01 §16; design/SPEC.md 1): a native `<select>` with `appearance-none`, one-border focus
// (`FIELD_FOCUS`), 16 px left padding and 40 px right padding (`pl-16 pr-40`), and a muted 16 px `ChevronIcon` placed
// by the relative wrapper at a 12 px inset (`right-12`) from the right edge so every browser draws the chevron inside
// the control at the same token inset.
export type SelectProps = PassThrough & {
  id: string;
  name: string;
  required?: boolean;
  disabled?: boolean;
  form?: string;
  class?: string;
  children?: Child;
};

const BOX = cx(
  "peer appearance-none w-full h-control pl-16 pr-40 border border-control-border rounded-control font-text text-16 weight-text-strong text-ink bg-surface box-border min-w-0 disabled:opacity-50 disabled:cursor-not-allowed",
  FIELD_FOCUS,
);

export function Select(props: SelectProps) {
  const { id, name, required, form, children } = props;
  const off = isDisabled(props as Record<string, unknown>);
  const given = passThrough(props as Record<string, unknown>, off);
  return (
    <span class={cx("relative inline-flex items-center max-w-full min-w-0", props.class)}>
      <select
        id={id}
        name={name}
        required={required}
        disabled={off || undefined}
        form={form}
        {...given}
        class={cx(BOX, props.class)}
      >
        {children}
      </select>
      <ChevronIcon class="pointer-events-none absolute right-12 top-1/2 -translate-y-1/2 text-muted peer-disabled:opacity-50" />
    </span>
  );
}
