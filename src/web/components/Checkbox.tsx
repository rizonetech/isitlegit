import type { Child } from "hono/jsx";
import { cx, type PassThrough, passThrough } from "./attrs";

// A native checkbox inside its label (ui.css `.checkbox`): the label toggles it, Space toggles it, a form submits
// name=value only when it is checked. 18 px on the boards, built 20 (the step above).
export type CheckboxProps = PassThrough & {
  name: string;
  value?: string;
  checked?: boolean;
  required?: boolean;
  disabled?: boolean;
  id?: string;
  class?: string;
  children: Child;
};

export function Checkbox(props: CheckboxProps) {
  const { name, value = "on", checked, required, disabled, id, children } = props;
  return (
    <label class={cx("flex gap-12 items-start text-14", disabled && "opacity-50 cursor-not-allowed", props.class)}>
      <input
        {...passThrough(props as Record<string, unknown>)}
        type="checkbox"
        id={id}
        name={name}
        value={value}
        checked={checked}
        required={required}
        disabled={disabled}
        class="w-20 h-20 mt-2 accent-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-orange"
      />
      <span>{children}</span>
    </label>
  );
}
