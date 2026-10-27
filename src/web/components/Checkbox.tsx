import type { Child } from "hono/jsx";
import { cx, FOCUS, isDisabled, type PassThrough, passThrough } from "./attrs";

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
  const { name, value = "on", checked, required, id, children } = props;
  const disabled = isDisabled(props as Record<string, unknown>);
  return (
    <label class={cx("flex gap-12 items-start text-14", disabled && "opacity-50 cursor-not-allowed", props.class)}>
      <input
        {...passThrough(props as Record<string, unknown>, disabled)}
        type="checkbox"
        id={id}
        name={name}
        value={value}
        checked={checked}
        required={required}
        disabled={disabled}
        class={cx("w-20 h-20 mt-2 accent-ink", FOCUS)}
      />
      <span>{children}</span>
    </label>
  );
}
