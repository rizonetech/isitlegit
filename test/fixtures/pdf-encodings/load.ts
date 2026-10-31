// The encoding and encryption fixtures (D06 T02 §5) as bytes inside workerd, which has no file system: Vite inlines each
// file as a data URL, as test/fixtures/pdf-forensics/load.ts does.
const urls = import.meta.glob(["./*.bin", "./*.pdf"], { query: "?inline", import: "default", eager: true }) as Record<
  string,
  string
>;

const bytes = (dataUrl: string) =>
  Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0));

// A fixture by its file name; a missing one throws, so a test never reads an empty file as a fixture.
export function fixture(name: string): Uint8Array {
  const url = urls[`./${name}`];
  if (!url) throw new Error(`no fixture ${name}`);
  return bytes(url);
}
