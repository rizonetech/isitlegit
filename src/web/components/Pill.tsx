import { cx, type PassThrough, passThrough } from "./attrs";

// Status pills (design/SPEC.md 1, ui.css `.pill`), carrying their meaning in words, never colour alone: "Malicious",
// "Checking", "E7 · Critical", "Owner". 26 px on the boards, built 28 (the step above); the 22 px navigation size 24.
export type PillVariant = "safe" | "suspicious" | "malicious" | "partial" | "running" | "neutral";

const VARIANT: Record<PillVariant, string> = {
  safe: "bg-safe-wash text-safe",
  suspicious: "bg-sus-wash text-sus",
  malicious: "bg-mal-wash text-mal",
  partial: "bg-partial-wash text-partial",
  running: "bg-orange-wash text-orange-text",
  neutral: "bg-light text-ink-2",
};

export type PillProps = PassThrough & {
  variant: PillVariant;
  size?: "default" | "compact";
  class?: string;
  children: string;
};

export function Pill(props: PillProps) {
  const { variant, size = "default", children } = props;
  if (!children.trim()) throw new Error("Pill: a pill needs words");
  return (
    <span
      {...passThrough(props as Record<string, unknown>)}
      class={cx(
        "inline-flex items-center gap-8 px-12 rounded-pill text-13 weight-heading whitespace-nowrap",
        size === "compact" ? "h-24" : "h-28",
        VARIANT[variant],
        props.class,
      )}
    >
      {children}
    </span>
  );
}
