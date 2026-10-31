// The encoding and encryption fixtures (D06 T02 §5) as bytes inside workerd, which has no file system: Vite inlines each
// file as a data URL, as test/fixtures/pdf-forensics/load.ts does.
import a85ContentBin from "./a85-content.bin?inline";
import a85EditedBin from "./a85-edited.bin?inline";
import a85XmpBin from "./a85-xmp.bin?inline";
import ahxContentBin from "./ahx-content.bin?inline";
import ahxEditedBin from "./ahx-edited.bin?inline";
import ahxXmpBin from "./ahx-xmp.bin?inline";
import chainContentBin from "./chain-content.bin?inline";
import chainEditedBin from "./chain-edited.bin?inline";
import chainXmpBin from "./chain-xmp.bin?inline";
import lzwContentBin from "./lzw-content.bin?inline";
import lzwEditedBin from "./lzw-edited.bin?inline";
import lzwXmpBin from "./lzw-xmp.bin?inline";
import lzwZerosBin from "./lzw-zeros.bin?inline";
import rc4PasswordPdf from "./rc4-password.pdf?inline";
import rc4R2Pdf from "./rc4-r2.pdf?inline";
import rc4R2EditedPdf from "./rc4-r2-edited.pdf?inline";
import rc4R3Pdf from "./rc4-r3.pdf?inline";
import rc4R3EditedPdf from "./rc4-r3-edited.pdf?inline";
import rlContentBin from "./rl-content.bin?inline";
import rlEditedBin from "./rl-edited.bin?inline";
import rlXmpBin from "./rl-xmp.bin?inline";
import rlZerosBin from "./rl-zeros.bin?inline";

const URLS: Record<string, string> = {
  "a85-content.bin": a85ContentBin,
  "a85-edited.bin": a85EditedBin,
  "a85-xmp.bin": a85XmpBin,
  "ahx-content.bin": ahxContentBin,
  "ahx-edited.bin": ahxEditedBin,
  "ahx-xmp.bin": ahxXmpBin,
  "chain-content.bin": chainContentBin,
  "chain-edited.bin": chainEditedBin,
  "chain-xmp.bin": chainXmpBin,
  "lzw-content.bin": lzwContentBin,
  "lzw-edited.bin": lzwEditedBin,
  "lzw-xmp.bin": lzwXmpBin,
  "lzw-zeros.bin": lzwZerosBin,
  "rc4-password.pdf": rc4PasswordPdf,
  "rc4-r2-edited.pdf": rc4R2EditedPdf,
  "rc4-r2.pdf": rc4R2Pdf,
  "rc4-r3-edited.pdf": rc4R3EditedPdf,
  "rc4-r3.pdf": rc4R3Pdf,
  "rl-content.bin": rlContentBin,
  "rl-edited.bin": rlEditedBin,
  "rl-xmp.bin": rlXmpBin,
  "rl-zeros.bin": rlZerosBin,
};

const bytes = (dataUrl: string) =>
  Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0));

// A fixture by its file name; a missing one throws, so a test never reads an empty file as a fixture.
export function fixture(name: string): Uint8Array {
  const url = URLS[name];
  if (!url) throw new Error(`no fixture ${name}`);
  return bytes(url);
}
