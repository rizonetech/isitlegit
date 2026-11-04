import { describe, expect, it } from "vitest";
import { Button, type ButtonVariant } from "../../src/web/components/Button";
import { Checkbox } from "../../src/web/components/Checkbox";
import { Field } from "../../src/web/components/Field";
import { Pill, type PillVariant } from "../../src/web/components/Pill";
import { Select } from "../../src/web/components/Select";

// The shared controls (D07 T01 §6) render the board's structure with token classes, refuse what the SPEC forbids, and
// pass through the attributes forms and htmx need. Browser behaviour (focus, keyboard, hover, submission) is
// controls-browser.test.ts.
const html = (node: unknown) => String(node);
// The element's opening tag, for attribute assertions.
const tag = (markup: string, name: string) => new RegExp(`<${name}\\b[^>]*>`).exec(markup)?.[0] ?? "";

describe("Button", () => {
  const variants: Record<ButtonVariant, string[]> = {
    primary: ["bg-accent", "text-on-accent", "hover:bg-accent-hover"],
    dark: ["bg-dark", "text-on-dark", "hover:bg-dark-active"],
    ghost: ["bg-surface", "text-ink", "border-line-strong", "hover:border-ink"],
    danger: ["bg-surface", "text-mal", "border-mal"],
    link: ["text-orange-text", "underline", "hover:text-ink"],
  };

  it("renders every variant with the token classes of ui.css .btn", () => {
    for (const [variant, classes] of Object.entries(variants)) {
      const markup = html(<Button variant={variant as ButtonVariant}>Go</Button>);
      for (const name of classes) expect(markup, `${variant} ${name}`).toContain(name);
      if (variant !== "link") expect(markup).toContain("min-h-control ");
      expect(markup).toContain(
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-text",
      );
    }
  });

  it("renders the 48 px and the small 36 px size", () => {
    expect(html(<Button>Go</Button>)).toMatch(/min-h-control py-8 px-20 rounded-control text-16/);
    // The board's 14 px padding of `.btn-sm` is built as the step above, 16 (design/SPEC.md 1).
    expect(html(<Button size="small">Go</Button>)).toMatch(
      /min-h-control-small py-4 px-16 rounded-control-small text-14/,
    );
  });

  it("is a button of type button by default, a submit button when asked, and a link with href", () => {
    expect(tag(html(<Button>Go</Button>), "button")).toContain('type="button"');
    expect(
      tag(
        html(
          <Button type="submit" name="intent" value="save">
            Save
          </Button>,
        ),
        "button",
      ),
    ).toMatch(/type="submit".*name="intent".*value="save"/);
    const link = tag(
      html(
        <Button href="/upload" variant="primary">
          Check a file
        </Button>,
      ),
      "a",
    );
    expect(link).toContain('href="/upload"');
  });

  it("passes aria, data and htmx attributes through to the element", () => {
    const markup = tag(
      html(
        <Button aria-controls="list" data-copy="check@isitlegit.co.za" hx-post="/x" hx-target="#list">
          Copy
        </Button>,
      ),
      "button",
    );
    for (const attribute of [
      'aria-controls="list"',
      'data-copy="check@isitlegit.co.za"',
      'hx-post="/x"',
      'hx-target="#list"',
    ])
      expect(markup).toContain(attribute);
  });

  it("keeps a caller's contextual name and merges a caller's description with the disabled reason", () => {
    expect(
      tag(html(<Button aria-label="Remove Alice" label="Remove" icon={<svg aria-hidden="true" />} />), "button"),
    ).toContain('aria-label="Remove Alice"');
    const markup = html(
      <Button id="rm" aria-describedby="owner-note" disabled disabledReason="The last owner cannot be removed">
        Remove
      </Button>,
    );
    expect(tag(markup, "button")).toContain('aria-describedby="owner-note rm-reason"');
  });

  it("names an icon-only button by its label and refuses one without", () => {
    expect(tag(html(<Button icon={<svg aria-hidden="true" />} label="Copy the check address" />), "button")).toContain(
      'aria-label="Copy the check address"',
    );
    // A type-level test, not a suppression: it fails if the types ever stop refusing a label-less icon-only button.
    // @ts-expect-error an icon-only button without a label is refused by the types as well
    expect(() => html(<Button icon={<svg aria-hidden="true" />} />)).toThrow("needs a label");
  });

  it("refuses an icon written as children, an icon component, a blank label and a blank caller name", () => {
    const Icon = () => <svg aria-hidden="true" />;
    expect(() => html(<Button>{<svg aria-hidden="true" />}</Button>)).toThrow("needs a label");
    expect(() => html(<Button>{<Icon />}</Button>)).toThrow("needs a label");
    expect(() => html(<Button icon={<Icon />} label=" " />)).toThrow("needs a label");
    expect(() => html(<Button aria-label=" ">{<Icon />}</Button>)).toThrow("needs a label");
    // Named by hidden text, by a caller's labelledby, or by visible text (a blank caller name is then left off).
    expect(() => html(<Button>{[<Icon />, <span class="sr-only">Copy</span>]}</Button>)).not.toThrow();
    expect(() => html(<Button aria-labelledby="copy-title">{<Icon />}</Button>)).not.toThrow();
    // biome-ignore lint/a11y/useValidAriaValues: the blank name is the caller input under test, which the control drops
    expect(tag(html(<Button aria-label="">Copy</Button>), "button")).not.toMatch(/\saria-label=/);
  });

  it("disables a button natively and a link without its href, and describes the reason", () => {
    const button = html(
      <Button id="remove" variant="danger" disabled disabledReason="The last owner cannot be removed">
        Remove
      </Button>,
    );
    expect(tag(button, "button")).toMatch(/disabled/);
    expect(tag(button, "button")).toContain('aria-describedby="remove-reason"');
    expect(button).toContain(
      '<span id="remove-reason" class="text-13 text-muted">The last owner cannot be removed</span>',
    );
    const link = tag(
      html(
        <Button href="/cases?page=0" disabled>
          Previous
        </Button>,
      ),
      "a",
    );
    expect(link).toContain('aria-disabled="true"');
    expect(link).not.toContain("href=");
    expect(() =>
      html(
        <Button disabled disabledReason="why">
          Remove
        </Button>,
      ),
    ).toThrow("needs an id");
    const htmx = tag(
      html(
        <Button href="/cases?page=0" hx-get="/cases?page=0" hx-target="#list" disabled>
          Previous
        </Button>,
      ),
      "a",
    );
    expect(htmx).not.toMatch(/\shx-/);
    expect(
      tag(
        html(
          <Button hx-post="/x" disabled>
            Go
          </Button>,
        ),
        "button",
      ),
    ).not.toMatch(/\shx-/);
  });

  it("drops htmx in the data-hx- spelling too, and reads a caller's aria-disabled as disabled", () => {
    const link = tag(
      html(
        <Button href="/cases?page=0" data-hx-get="/cases?page=0" data-action="page" disabled>
          Previous
        </Button>,
      ),
      "a",
    );
    expect(link).not.toMatch(/\s(data-)?hx-/);
    // Announced as an unavailable link, and out of the pointer's reach (its data hooks cannot be clicked).
    expect(link).toMatch(/role="link"/);
    expect(link).toContain("pointer-events-none");
    const marked = tag(
      html(
        <Button aria-disabled="true" data-hx-post="/x" hx-post="/x">
          Remove
        </Button>,
      ),
      "button",
    );
    expect(marked).toMatch(/\sdisabled[\s=>]/);
    expect(marked).not.toMatch(/\s(data-)?hx-/);
  });
});

describe("Pill", () => {
  const variants: Record<PillVariant, string> = {
    safe: "bg-safe-wash text-safe",
    suspicious: "bg-sus-wash text-sus",
    malicious: "bg-mal-wash text-mal",
    partial: "bg-partial-wash text-partial",
    running: "bg-orange-wash text-orange-text",
    neutral: "bg-light text-ink-2",
    brand: "bg-orange text-dark",
    alert: "bg-mal-band text-on-band",
  };

  it("renders every variant with its words and token colours, at both sizes", () => {
    for (const [variant, classes] of Object.entries(variants)) {
      const markup = html(<Pill variant={variant as PillVariant}>E7 · Critical</Pill>);
      expect(markup).toContain(classes);
      expect(markup).toContain(">E7 · Critical</span>");
      expect(markup).toContain("h-28");
    }
    expect(
      html(
        <Pill variant="malicious" size="compact">
          1 new
        </Pill>,
      ),
    ).toContain("h-24");
  });

  it("refuses a pill without words", () => {
    expect(() => html(<Pill variant="safe"> </Pill>)).toThrow("needs words");
  });
});

describe("Field", () => {
  // D07 T02 §11: the sign-in code field limits its length ("123 456" is 7 characters) and its characters.
  it("renders maxlength, pattern and autofocus on its input only when given", () => {
    const limited = html(
      <Field id="code" label="Code from the email" name="code" maxlength={7} pattern="[0-9 \-]*" inputmode="numeric" />,
    );
    const input = /<input\b[^>]*>/.exec(limited)?.[0] ?? "";
    expect(input).toContain('maxlength="7"');
    expect(input).toContain('pattern="[0-9 \\-]*"');
    const plain = /<input\b[^>]*>/.exec(html(<Field id="email" label="Email" name="email" />))?.[0] ?? "";
    expect(plain).not.toContain("maxlength");
    expect(plain).not.toContain("pattern");
    expect(input).not.toContain("autofocus");
    const focused = /<input\b[^>]*>/.exec(html(<Field id="c2" label="Code" name="c2" autofocus />))?.[0] ?? "";
    expect(focused).toContain("autofocus");
  });

  it("ties the label to its input and forwards the form attributes", () => {
    const markup = html(
      <Field
        id="email"
        name="email"
        label="Work email"
        type="email"
        required
        autocomplete="email"
        inputmode="email"
        hx-get="/check"
      />,
    );
    expect(markup).toContain('<label for="email"');
    const input = tag(markup, "input");
    for (const attribute of [
      'id="email"',
      'name="email"',
      'type="email"',
      "required",
      'autocomplete="email"',
      'inputmode="email"',
      'hx-get="/check"',
    ])
      expect(input).toContain(attribute);
    expect(input).not.toMatch(/\saria-invalid=/);
    expect(input).not.toMatch(/\saria-describedby=/);
  });

  it("describes the input by its hint and its error, by ids that exist, and marks it invalid", () => {
    const markup = html(
      <Field id="email" name="email" label="Work email" hint="Your work address" error="Enter an email address" />,
    );
    const input = tag(markup, "input");
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('aria-describedby="email-hint email-error"');
    expect(markup).toContain('<p id="email-hint" class="text-13 text-muted">Your work address</p>');
    expect(markup).toContain(
      '<p id="email-error" role="alert" class="text-13 text-mal weight-text-strong">Enter an email address</p>',
    );
    expect(input).toContain("aria-invalid:border-mal");
  });

  it("keeps a caller's descriptions after its own, and a caller's invalid state unless its own error decides", () => {
    const own = tag(
      html(<Field id="iban" name="iban" label="Account" hint="h" aria-describedby="bank-help" />),
      "input",
    );
    expect(own).toContain('aria-describedby="iban-hint bank-help"');
    expect(tag(html(<Field id="a" name="a" label="A" aria-invalid="true" />), "input")).toContain(
      'aria-invalid="true"',
    );
    const withError = tag(html(<Field id="b" name="b" label="B" aria-invalid="false" error="Wrong" />), "input");
    expect(withError).toContain('aria-invalid="true"');
    expect(withError).toContain('aria-describedby="b-error"');
  });

  it("gives two fields on one page distinct ids for every relationship", () => {
    const markup = html(
      <>
        <Field id="first" name="first" label="First" hint="h" error="e" />
        <Field id="second" name="second" label="Second" hint="h" error="e" />
      </>,
    );
    const ids = [...markup.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["first-hint", "first", "first-error", "second-hint", "second", "second-error"]);
  });

  it("uses one-border focus with forced-colours outline fallback on both input and textarea", () => {
    const input = tag(html(<Field id="email" name="email" label="Email" />), "input");
    const textarea = tag(html(<Field id="notes" name="notes" label="Notes" rows={3} />), "textarea");
    for (const control of [input, textarea]) {
      for (const cls of [
        "focus:outline-none",
        "focus-visible:outline-none",
        "focus:border-orange-text",
        "focus-visible:border-orange-text",
        "aria-invalid:border-mal",
        "aria-invalid:focus:border-orange-text",
        "aria-invalid:focus-visible:border-orange-text",
        "forced-colors:focus:outline-solid",
        "forced-colors:focus:outline-2",
        "forced-colors:focus:outline-offset-2",
      ])
        expect(control).toContain(cls);
    }
  });
});

describe("Select", () => {
  it("renders a native select with appearance-none, one-border focus and an inset ChevronIcon inside a relative wrapper", () => {
    const markup = html(
      <Select
        id="verdict"
        name="verdict"
        class="w-auto"
        required
        form="filter-form"
        aria-label="Verdict"
        data-filter="v"
        hx-get="/cases"
      >
        <option value="">All verdicts</option>
        <option value="malicious">Malicious</option>
      </Select>,
    );
    expect(markup.startsWith('<span class="relative inline-flex items-center max-w-full min-w-0 w-auto">')).toBe(true);
    const select = tag(markup, "select");
    for (const part of [
      'id="verdict"',
      'name="verdict"',
      "required",
      'form="filter-form"',
      'aria-label="Verdict"',
      'data-filter="v"',
      'hx-get="/cases"',
      "appearance-none",
      "pl-16 pr-40",
      "w-full",
      "focus:outline-none",
      "focus-visible:outline-none",
      "focus:border-orange-text",
      "focus-visible:border-orange-text",
      "forced-colors:focus:outline-solid",
    ])
      expect(select).toContain(part);
    const svg = tag(markup, "svg");
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain(
      "pointer-events-none absolute right-12 top-1/2 -translate-y-1/2 text-muted peer-disabled:opacity-50",
    );
  });

  it("disables the select, dims the chevron via peer-disabled, and drops htmx attributes in both spellings", () => {
    const off = tag(
      html(
        <Select id="role" name="role" disabled hx-post="/role" data-hx-get="/role">
          <option value="owner">Owner</option>
        </Select>,
      ),
      "select",
    );
    expect(off).toMatch(/\sdisabled[\s=>]/);
    expect(off).not.toMatch(/\s(data-)?hx-/);
    const ariaOff = tag(
      html(
        <Select id="role2" name="role2" aria-disabled="true" hx-post="/role">
          <option value="owner">Owner</option>
        </Select>,
      ),
      "select",
    );
    expect(ariaOff).toMatch(/\sdisabled[\s=>]/);
    expect(ariaOff).not.toMatch(/\shx-/);
  });
});

describe("Checkbox", () => {
  it("is a native checkbox inside its label, with name, value and states", () => {
    const markup = html(
      <Checkbox name="consent" value="yes" checked required>
        I agree to the privacy notice
      </Checkbox>,
    );
    expect(markup.startsWith("<label")).toBe(true);
    const input = tag(markup, "input");
    for (const attribute of ['type="checkbox"', 'name="consent"', 'value="yes"', "checked", "required"])
      expect(input).toContain(attribute);
    expect(
      tag(
        html(
          <Checkbox name="c" disabled>
            x
          </Checkbox>,
        ),
        "input",
      ),
    ).toContain("disabled");
    expect(tag(html(<Checkbox name="c">x</Checkbox>), "input")).not.toMatch(/\schecked/);
  });

  it("drops htmx from a disabled box, in both spellings, and reads a caller's aria-disabled as disabled", () => {
    const off = tag(
      html(
        <Checkbox name="c" disabled hx-post="/x" hx-trigger="load" data-hx-get="/y">
          x
        </Checkbox>,
      ),
      "input",
    );
    expect(off).not.toMatch(/\s(data-)?hx-/);
    const marked = tag(
      html(
        <Checkbox name="c" aria-disabled="true" hx-post="/x">
          x
        </Checkbox>,
      ),
      "input",
    );
    expect(marked).toMatch(/\sdisabled[\s=>]/);
    expect(marked).not.toMatch(/\shx-/);
  });
});
