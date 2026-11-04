// Loading the brand fonts before any frame renders, with a failure that names the font. Kept free of Remotion and the
// DOM so `node --test` can prove it: brand.tsx passes FontFace loading in as `load`, continueRender as `done` and
// cancelRender as `fail`, so a missing or damaged font file stops the render at once with its path instead of holding
// the render delay until Remotion's timeout.

export type Font = readonly [family: string, file: string];

export async function loadFonts(
  fonts: readonly Font[],
  load: (family: string, file: string) => Promise<unknown>,
  done: () => void,
  fail: (err: Error) => void,
): Promise<void> {
  try {
    await Promise.all(
      fonts.map(async ([family, file]) => {
        try {
          await load(family, file);
        } catch (err) {
          throw new Error(`font ${family} (${file}) failed to load: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
  } catch (err) {
    fail(err as Error);
    return;
  }
  done();
}
