import { cx, FIELD_FOCUS, ids, type PassThrough, passThrough } from "./attrs";

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
  // Length and pattern limits the browser enforces before submitting (a sign-in code's 7 characters, D07 T02 §11).
  maxlength?: number;
  pattern?: string;
  // The one field a single-task page is for (a sign-in code, D07 T02 §11): focused when the page opens.
  autofocus?: boolean;
  // The id of a form this input belongs to when it sits outside it (the protected identity page's Names card, whose
  // form closes in a later card, D05 T01 §3).
  form?: string;
  // Draws a multi-line box of this many rows in the same styling (the identity page's trading names, one per line).
  rows?: number;
  class?: string;
};

// One-border focus (attrs.ts FIELD_FOCUS, D07 T01 §16; design/SPEC.md 1): the 1 px border switches to `orange-text` on
// `:focus` and `:focus-visible` with no separate outline ring, and an invalid field shows `mal` at rest and switches to
// `orange-text` while focused. `INLINE_INPUT` is shared by compact filter-bar date and search inputs.
export const INLINE_INPUT = cx(
  "h-control px-16 border border-control-border rounded-control font-text text-16 text-ink bg-surface box-border min-w-0 placeholder:text-muted",
  FIELD_FOCUS,
);

const INPUT = cx(INLINE_INPUT, "w-full");

const TEXTAREA = INPUT.replace("h-control", "py-12 leading-normal");

export function Field(props: FieldProps) {
  const { id, label, name, type = "text", value, placeholder, hint, error, required, autocomplete, inputmode } = props;
  const { maxlength, pattern, autofocus, form, rows } = props;
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
      {rows !== undefined ? (
        <textarea
          {...given}
          id={id}
          name={name}
          rows={rows}
          placeholder={placeholder}
          required={required}
          autocomplete={autocomplete}
          maxlength={maxlength}
          autofocus={autofocus}
          form={form}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          class={TEXTAREA}
        >
          {value}
        </textarea>
      ) : (
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
          maxlength={maxlength}
          pattern={pattern}
          autofocus={autofocus}
          form={form}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          class={INPUT}
        />
      )}
      {/* Announced as the page that carries it arrives (a refused code, a wrong address), and the field's description. */}
      {error && (
        <p id={errorId} role="alert" class="text-13 text-mal weight-text-strong">
          {error}
        </p>
      )}
    </div>
  );
}
