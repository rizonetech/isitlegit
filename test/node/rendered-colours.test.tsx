import { describe, expect, it } from "vitest";
import { Pill } from "../../src/web/components/Pill";
import { GALLERY_FRAMES, GalleryFrame, GalleryPage } from "../../src/web/dev/gallery";

// Every colour the rendered components put in their HTML is a token (D07 T01 §10; D07 T01 §2 round 2): the source scan
// in no-raw-colours.test.ts matches text, while this reads what Hono actually renders, the gallery and every frame. A
// colour in a `style` attribute or in an SVG paint or colour attribute must be `var(--color-*)`, `transparent` or
// `currentcolor`; `fill` and `stroke` may also be `none`, SVG's no-paint value.
const ATTRIBUTES = ["fill", "stroke", "stop-color", "flood-color", "lighting-color", "color"] as const;
const COLOUR_PROPERTIES = new Set([
  "color",
  "background",
  "background-color",
  "border-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "outline-color",
  "fill",
  "stroke",
  "stop-color",
  "flood-color",
  "lighting-color",
  "caret-color",
  "text-decoration-color",
  "box-shadow",
]);

const allowed = (property: string, value: string) => {
  const v = value.trim().toLowerCase();
  if (/^var\(--color-[a-z0-9-]+\)$/.test(v) || v === "transparent" || v === "currentcolor") return true;
  return (property === "fill" || property === "stroke") && v === "none";
};

// Every colour this markup sets that is not a token, as `property: value`.
function rawColours(markup: string): string[] {
  const found: string[] = [];
  for (const name of ATTRIBUTES)
    for (const m of markup.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g")))
      if (!allowed(name, m[1] ?? "")) found.push(`${name}="${m[1]}"`);
  for (const m of markup.matchAll(/\sstyle="([^"]*)"/g))
    for (const declaration of (m[1] ?? "").replace(/&quot;/g, '"').split(";")) {
      const [property = "", ...rest] = declaration.split(":");
      const p = property.trim().toLowerCase();
      if (COLOUR_PROPERTIES.has(p) && !allowed(p, rest.join(":"))) found.push(`${p}:${rest.join(":").trim()}`);
    }
  return found;
}

describe("rendered colours", () => {
  it("are tokens on the gallery page and in every frame, the icons' fill none included", () => {
    const pages = [String(<GalleryPage />), ...GALLERY_FRAMES.map((f) => String(GalleryFrame(f.id)))];
    expect(pages.some((page) => page.includes('fill="none"'))).toBe(true);
    for (const page of pages) expect(rawColours(page)).toEqual([]);
  });

  it("refuses a raw colour in a style, a fill or a stroke", () => {
    expect(rawColours(String(<span style={{ color: "red" }}>x</span>))).toEqual(["color:red"]);
    expect(rawColours(String(<svg fill="red" />))).toEqual(['fill="red"']);
    expect(rawColours(String(<path stroke="#000" />))).toEqual(['stroke="#000"']);
    expect(rawColours('<p style="background-color: rgb(1, 2, 3)">x</p>')).toEqual(["background-color:rgb(1, 2, 3)"]);
    expect(rawColours('<stop stop-color="white"/>')).toEqual(['stop-color="white"']);
    // A component that rendered one would be caught where it is drawn.
    expect(
      rawColours(String(<div style={{ color: "red" }}>{Pill({ variant: "safe", children: "Safe" })}</div>)),
    ).toEqual(["color:red"]);
  });

  it("accepts tokens, transparent, currentcolor and a no-paint fill or stroke", () => {
    expect(
      rawColours(
        '<svg fill="none" stroke="currentColor"><path fill="var(--color-ink)"/></svg><p style="color: var(--color-muted); background: transparent">x</p>',
      ),
    ).toEqual([]);
    expect(rawColours('<p style="color: none">x</p>')).toEqual(["color:none"]);
  });
});
