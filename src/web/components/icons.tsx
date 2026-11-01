import { cx } from "./attrs";

// The line icons the frames draw (boards `AppNav`, `Report-Mobile`): 24-unit paths stroked in the current text colour,
// hidden from assistive technology because the control beside or around them carries the name. 18 px on the boards is
// built 20, and 14 px 16 (the step above, design/SPEC.md 1).
type IconProps = { class?: string };

function icon(paths: string[], size = "w-20 h-20", stroke = "2") {
  return ({ class: extra }: IconProps) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={stroke}
      aria-hidden="true"
      class={cx("shrink-0", size, extra)}
    >
      {paths.map((d) => (
        <path d={d} />
      ))}
    </svg>
  );
}

export const PlusIcon = icon(["M12 5v14M5 12h14"], "w-20 h-20", "2.2");
export const CasesIcon = icon(["M4 6h16M4 12h16M4 18h10"]);
export const SuppliersIcon = icon(["M3 21h18M5 21V8l7-4 7 4v13M9 21v-6h6v6"]);
export const ProtectIcon = icon(["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18", "M8 12l3 3 5-6"]);
export const MonitorIcon = icon(["M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14", "M16 16l5 5"]);
export const TeamIcon = icon([
  "M9 4.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7",
  "M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.6c2 .7 3.2 2.5 3.6 5.4",
]);
export const ChevronIcon = icon(["M7 10l5 5 5-5"], "w-16 h-16");
export const CopyIcon = icon(
  ["M11 9h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2", "M5 15V5a2 2 0 0 1 2-2h8"],
  "w-16 h-16",
);
export const CheckIcon = icon(["M5 12.5l4.5 4.5L19 7.5"], "w-20 h-20", "3");
export const MenuIcon = icon(["M4 7h16M4 12h16M4 17h16"]);
// The sign-in states' tiles (board `Signin-States`): the inbox, the expired link, the limit, the passkey.
export const MailIcon = icon(["M4 6h16v12H4z", "M4 7l8 6 8-6"]);
export const ClockIcon = icon(["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18", "M12 7v5l3 2"]);
export const StopIcon = icon(["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18", "M8 12h8"]);
export const KeyIcon = icon(["M8 7a4 4 0 1 0 0 8a4 4 0 1 0 0-8", "M11.5 12.5L20 21", "M16 17l2-2", "M18 19l2-2"]);
