import { MOTION } from "../assets";
import { cx, nonBlank } from "./attrs";
import { Pill } from "./Pill";

// The verdict band and badge (D07 T01 §7; design/SPEC.md M3; boards `Main`, `Report-Safe`, `Report-Partial`,
// `Report-Running`, `Report-Mobile`, `Cases`). The verdict is always in words as well as colour; the art is decorative
// (`alt=""`) and the words carry the meaning. A check's state, its verdict and its confidence are separate inputs:
// a partial check keeps the verdict it reached, while a failed or running one has none.
export type CheckState = "complete" | "partial" | "failed" | "running";
export type VerdictName = "malicious" | "suspicious" | "safe";
export type Confidence = "high" | "medium" | "low";

// The band colour per verdict: the tokens are named `mal`, `sus` and `safe`.
const BAND: Record<VerdictName, string> = {
  malicious: "bg-mal-band text-on-band",
  suspicious: "bg-sus-band text-on-band",
  safe: "bg-safe-band text-on-band",
};
const WORD: Record<VerdictName, string> = { malicious: "Malicious", suspicious: "Suspicious", safe: "Safe" };

// A verdict a state requires (complete, partial) or forbids (failed, running), refused otherwise.
function checkVerdict(component: string, state: CheckState, verdict: VerdictName | undefined): void {
  const has = verdict !== undefined;
  if ((state === "complete" || state === "partial") && !has)
    throw new Error(`${component}: a ${state} check needs its verdict`);
  if ((state === "failed" || state === "running") && has)
    throw new Error(`${component}: a ${state} check has no verdict`);
}

// "0:21", "12:05": minutes and seconds of a running check.
export function elapsedText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("VerdictBand: elapsed time must be zero or more");
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export type VerdictBandProps = {
  state: CheckState;
  verdict?: VerdictName;
  confidence?: Confidence;
  // Seconds since a running check began.
  elapsed?: number;
  headline: string;
  // The page sets the heading level that fits its outline; the report's band is an h2.
  level?: 1 | 2 | 3 | 4;
  children: string;
};

export function VerdictBand(props: VerdictBandProps) {
  const { state, verdict, confidence, elapsed, level = 2, children } = props;
  const headline = nonBlank(props.headline);
  if (!headline) throw new Error("VerdictBand: the band needs a headline");
  if (!children.trim()) throw new Error("VerdictBand: the band needs its sentence");
  checkVerdict("VerdictBand", state, verdict);
  if ((state === "complete" || state === "partial") && !confidence)
    throw new Error(`VerdictBand: a ${state} check needs its confidence`);
  if (state === "running" && elapsed === undefined)
    throw new Error("VerdictBand: a running check needs its elapsed time");
  const running = state === "running";
  const eyebrow =
    state === "running"
      ? `Checking · ${elapsedText(elapsed ?? 0)} so far`
      : state === "failed"
        ? "Check failed · no verdict"
        : `${WORD[verdict as VerdictName]} · ${confidence} confidence${state === "partial" ? " · partial check" : ""}`;
  const art = running ? MOTION.checking : state === "failed" ? MOTION.question : MOTION[verdict as VerdictName];
  const Heading = `h${level}` as "h2";
  return (
    // Below `md` (`Report-Mobile`) the tile and the eyebrow share the first row and the headline and sentence take a row
    // each; from `md` the tile sits beside the three. The text column's box is dropped below `md` (`contents`) so its
    // children wrap with the tile.
    <section
      aria-label="Verdict"
      class={cx(
        "flex flex-wrap items-center gap-16 p-20 rounded-card-large md:flex-nowrap md:gap-24 md:px-32 md:py-28",
        running
          ? "bg-orange-wash text-ink"
          : state === "failed"
            ? "bg-partial-band text-on-band"
            : BAND[verdict as VerdictName],
      )}
    >
      {/* White in both themes, as the boards draw it: the art is made for white. */}
      <div class="flex shrink-0 items-center justify-center w-56 h-56 rounded-card-large bg-on-band md:w-88 md:h-88">
        <img src={art} alt="" class="w-40 h-40 md:w-72 md:h-72" />
      </div>
      <div class="contents md:flex md:flex-col md:gap-4 md:min-w-0">
        <p class={cx("flex-1 min-w-0 type-eyebrow md:flex-none md:text-14", running && "text-orange-text")}>
          {eyebrow}
        </p>
        <Heading class="basis-full font-heading weight-heading text-24 md:basis-auto md:text-32">{headline}</Heading>
        <p class={cx("basis-full text-16 md:basis-auto md:text-17", running && "text-ink-2")}>{children}</p>
      </div>
    </section>
  );
}

export type VerdictBadgeProps = { state: CheckState; verdict?: VerdictName };

// The verdict pill of a case row (board `Cases`): a complete check's verdict, "Partial" for a partial or failed check,
// "Checking" while it runs.
export function VerdictBadge(props: VerdictBadgeProps) {
  const { state, verdict } = props;
  checkVerdict("VerdictBadge", state, verdict);
  if (state === "running") return <Pill variant="running">Checking</Pill>;
  if (state !== "complete") return <Pill variant="partial">Partial</Pill>;
  return <Pill variant={verdict as VerdictName}>{WORD[verdict as VerdictName]}</Pill>;
}
