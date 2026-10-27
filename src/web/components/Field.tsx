import { cx, type PassThrough, passThrough } from "./attrs";

// A labelled text field (design/SPEC.md 1, ui.css `.field`, `.input`): label, optional hint, optional error. The error
// state sets aria-invalid and both hint and error describe the input, by ids derived from the required, page-unique id.
export type FieldProps = PassThrough & {
  id: string;
  label: string;
  name: string;
  type?: "text" | "email" | "password" | "search" | "tel" | "url" | "number";
  value?: string;
  placeholder?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  autocomplete?: string;
  inputmode?: "text" | "email" | "numeric" | "decimal" | "tel" | "url" | "search";
  class?: string;
};

const INPUT =
  "h-control px-16 border border-control-border rounded-control font-text text-16 text-ink bg-surface box-border w-full placeholder:text-muted focus:outline-3 focus:outline-orange/25 focus:border-orange aria-invalid:border-mal";

export function Field(props: FieldProps) {
  const { id, label, name, type = "text", value, placeholder, hint, error, required, autocomplete, inputmode } = props;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div class={cx("flex flex-col gap-8", props.class)}>
      <label for={id} class="text-14 weight-text-strong text-ink">
        {label}
      </label>
      {hint && (
        <p id={hintId} class="text-13 text-muted">
          {hint}
        </p>
      )}
      <input
        {...passThrough(props as Record<string, unknown>)}
        id={id}
        name={name}
        type={type}
        value={value}
        placeholder={placeholder}
        required={required}
        autocomplete={autocomplete}
        inputmode={inputmode}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={describedBy}
        class={INPUT}
      />
      {error && (
        <p id={errorId} class="text-13 text-mal weight-text-strong">
          {error}
        </p>
      )}
    </div>
  );
}
