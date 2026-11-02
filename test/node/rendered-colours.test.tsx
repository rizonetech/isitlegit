import { describe, expect, it } from "vitest";
import { Pill } from "../../src/web/components/Pill";
import {
  anchorOf,
  GALLERY_FRAMES,
  GALLERY_STATES,
  GalleryFrame,
  GalleryPage,
  GalleryState,
} from "../../src/web/dev/gallery";

// Every colour the rendered components put in their HTML is a token (D07 T01 §10; D07 T01 §2 round 2): the source scan
// in no-raw-colours.test.ts matches text, while this reads what Hono actually renders, the gallery and every frame. A
// colour in a `style` attribute or in an SVG paint or colour attribute must be `var(--color-*)`, `transparent` or
// `currentcolor`; `fill` and `stroke` may also be `none`, SVG's no-paint value.
const ATTRIBUTES = ["fill", "stroke", "stop-color", "flood-color", "lighting-color", "color"] as const;
// The CSS named colours (CSS Color 4, 6.1), any of which in a colour position is a raw colour.
const NAMED = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood " +
    "cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray " +
    "darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue " +
    "firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew " +
    "hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
    "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue " +
    "mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred " +
    "midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid " +
    "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple " +
    "rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue " +
    "slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white " +
    "whitesmoke yellow yellowgreen canvas canvastext linktext visitedtext activetext buttonface buttontext " +
    "buttonborder field fieldtext highlight highlighttext mark marktext graytext accentcolor accentcolortext"
  ).split(" "),
);
// Every property that can carry a colour, its shorthands included: each is read whole, so a colour anywhere in it (a
// border's colour, a shadow's) is found.
const COLOUR_PROPERTY =
  /^(color|background(-color|-image)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?|outline(-color)?|column-rule(-color)?|text-decoration(-color)?|text-emphasis(-color)?|text-shadow|box-shadow|caret-color|accent-color|fill|stroke|stop-color|flood-color|lighting-color|scrollbar-color)$/;

// The raw colours in one value: what is left once tokens, `transparent` and `currentcolor` (and, for `fill` and
// `stroke`, `none`) are taken out, if it holds a hex colour, a colour function or a named colour.
function raw(property: string, value: string): boolean {
  let rest = value
    .toLowerCase()
    .replace(/var\(--color-[a-z0-9-]+\)/g, " ")
    .replace(/\b(transparent|currentcolor)\b/g, " ");
  if (property === "fill" || property === "stroke") rest = rest.replace(/\bnone\b/g, " ");
  if (/#[0-9a-f]{3,8}\b/.test(rest)) return true;
  if (/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/.test(rest)) return true;
  return rest.split(/[^a-z-]+/).some((word) => NAMED.has(word));
}

// Every colour this markup sets that is not a token, as `property: value`.
function rawColours(markup: string): string[] {
  const found: string[] = [];
  for (const name of ATTRIBUTES)
    for (const m of markup.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g")))
      if (raw(name, m[1] ?? "")) found.push(`${name}="${m[1]}"`);
  for (const m of markup.matchAll(/\sstyle="([^"]*)"/g))
    for (const declaration of (m[1] ?? "")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .split(";")) {
      const [property = "", ...rest] = declaration.split(":");
      const p = property.trim().toLowerCase();
      const value = rest.join(":").trim();
      if ((COLOUR_PROPERTY.test(p) || p.startsWith("--")) && raw(p, value)) found.push(`${p}:${value}`);
    }
  return found;
}

describe("rendered colours", () => {
  it("are tokens on the gallery page and in every frame, the icons' fill none included", () => {
    const pages = [
      String(<GalleryPage />),
      ...GALLERY_FRAMES.map((f) => String(GalleryFrame(f.id))),
      ...GALLERY_STATES.map((s) => String(GalleryState(anchorOf("state", s.id)))),
    ];
    expect(pages.some((page) => page.includes('fill="none"'))).toBe(true);
    for (const page of pages) expect(rawColours(page)).toEqual([]);
  });

  it("refuses a raw colour in a style, a fill or a stroke", () => {
    expect(rawColours(String(<span style={{ color: "red" }}>x</span>))).toEqual(["color:red"]);
    expect(rawColours(String(<svg fill="red" />))).toEqual(['fill="red"']);
    expect(rawColours(String(<path stroke="#000" />))).toEqual(['stroke="#000"']);
    expect(rawColours('<p style="background-color: rgb(1, 2, 3)">x</p>')).toEqual(["background-color:rgb(1, 2, 3)"]);
    expect(rawColours('<stop stop-color="white"/>')).toEqual(['stop-color="white"']);
    // Shorthands and the less common colour properties, and a colour that reached the markup through a variable.
    const tone = "red";
    expect(rawColours(String(<p style={{ border: `1px solid ${tone}` }}>x</p>))).toEqual(["border:1px solid red"]);
    expect(rawColours('<p style="text-shadow: 0 1px 2px #333">x</p>')).toEqual(["text-shadow:0 1px 2px #333"]);
    expect(rawColours('<input style="accent-color: hotpink">')).toEqual(["accent-color:hotpink"]);
    expect(rawColours('<p style="border-inline-start-color: oklch(0.6 0.1 30)">x</p>')).toEqual([
      "border-inline-start-color:oklch(0.6 0.1 30)",
    ]);
    expect(rawColours('<p style="outline: 2px solid blue">x</p>')).toEqual(["outline:2px solid blue"]);
    expect(rawColours('<p style="--brand: tomato">x</p>')).toEqual(["--brand:tomato"]);
    // A component that rendered one would be caught where it is drawn.
    expect(
      rawColours(String(<div style={{ color: "red" }}>{Pill({ variant: "safe", children: "Safe" })}</div>)),
    ).toEqual(["color:red"]);
  });

  it("accepts tokens, transparent, currentcolor and a no-paint fill or stroke", () => {
    expect(
      rawColours(
        '<svg fill="none" stroke="currentColor"><path fill="var(--color-ink)"/></svg><p style="color: var(--color-muted); background: transparent; border: 1px solid var(--color-line); box-shadow: 0 1px 2px var(--color-line)">x</p>',
      ),
    ).toEqual([]);
  });
});
