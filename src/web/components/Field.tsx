import { cx, ids, type PassThrough, passThrough } from "./attrs";

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

// Focus is a solid 2 px orange outline, 3:1 or more against the surface in both themes, kept with the red border of an
// invalid field (the board's 25% ring measured about 1.4:1; a SPEC deviation, design/SPEC.md 1).
const INPUT =
  "h-control px-16 border border-control-border rounded-control font-text text-16 text-ink bg-surface box-border w-full placeholder:text-muted focus:outline-2 focus:outline-offset-2 focus:outline-orange focus:border-orange aria-invalid:border-mal aria-invalid:focus:border-mal";

export function Field(props: FieldProps) {
  const { id, label, name, type = "text", value, placeholder, hint, error, required, autocomplete, inputmode } = props;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const given = passThrough(props as Record<string, unknown>);
  // The control's own hint and error come first; a caller's further descriptions are kept after them. The control's
  // error decides invalid; without one, a caller's aria-invalid stands.
  const describedBy = ids(hintId, errorId, given["aria-describedby"]);
  const invalid = error ? "true" : (given["aria-invalid"] as string | undefined);
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
        {...given}
        id={id}
        name={name}
        type={type}
        value={value}
        placeholder={placeholder}
        required={required}
        autocomplete={autocomplete}
        inputmode={inputmode}
        aria-invalid={invalid}
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
