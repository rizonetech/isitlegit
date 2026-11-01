// The encoding and encryption fixtures (D06 T02 §5) as bytes inside workerd, which has no file system: Vite inlines each
// file as a data URL, as test/fixtures/pdf-forensics/load.ts does.

import a85ContentBin from "./a85-content.bin?inline";
import a85EditedBin from "./a85-edited.bin?inline";
import a85XmpBin from "./a85-xmp.bin?inline";
import aesPasswordPdf from "./aes-password.pdf?inline";
import aesR4Pdf from "./aes-r4.pdf?inline";
import aesR4CryptIdentityPdf from "./aes-r4-crypt-identity.pdf?inline";
import aesR4EditedPdf from "./aes-r4-edited.pdf?inline";
import aesR4NometaPdf from "./aes-r4-nometa.pdf?inline";
import aesR4ObjstmPdf from "./aes-r4-objstm.pdf?inline";
import aesR4ObjstmResavedPdf from "./aes-r4-objstm-resaved.pdf?inline";
import aesR4ResavedPdf from "./aes-r4-resaved.pdf?inline";
import aesR4StringsOnlyPdf from "./aes-r4-strings-only.pdf?inline";
import aesR4UnknownFilterPdf from "./aes-r4-unknown-filter.pdf?inline";
import aesR6Pdf from "./aes-r6.pdf?inline";
import aesR6EditedPdf from "./aes-r6-edited.pdf?inline";
import aesR6NometaPdf from "./aes-r6-nometa.pdf?inline";
import aesR6ObjstmPdf from "./aes-r6-objstm.pdf?inline";
import aesR6ObjstmResavedPdf from "./aes-r6-objstm-resaved.pdf?inline";
import aesR6ResavedPdf from "./aes-r6-resaved.pdf?inline";
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
import png1Bin from "./png-1.bin?inline";
import png2Bin from "./png-2.bin?inline";
import png4Bin from "./png-4.bin?inline";
import rc4PasswordPdf from "./rc4-password.pdf?inline";
import rc4R2Pdf from "./rc4-r2.pdf?inline";
import rc4R2EditedPdf from "./rc4-r2-edited.pdf?inline";
import rc4R3Pdf from "./rc4-r3.pdf?inline";
import rc4R3EditedPdf from "./rc4-r3-edited.pdf?inline";
import rlContentBin from "./rl-content.bin?inline";
import rlEditedBin from "./rl-edited.bin?inline";
import rlXmpBin from "./rl-xmp.bin?inline";
import rlZerosBin from "./rl-zeros.bin?inline";
import tiff1Bin from "./tiff-1.bin?inline";
import tiff2Bin from "./tiff-2.bin?inline";
import tiff4Bin from "./tiff-4.bin?inline";
import tiff8Bin from "./tiff-8.bin?inline";
import tiff16Bin from "./tiff-16.bin?inline";

const URLS: Record<string, string> = {
  "aes-r4-objstm.pdf": aesR4ObjstmPdf,
  "aes-r4-objstm-resaved.pdf": aesR4ObjstmResavedPdf,
  "aes-r6-objstm.pdf": aesR6ObjstmPdf,
  "aes-r6-objstm-resaved.pdf": aesR6ObjstmResavedPdf,
  "aes-r4-crypt-identity.pdf": aesR4CryptIdentityPdf,
  "aes-r4-strings-only.pdf": aesR4StringsOnlyPdf,
  "aes-r4-unknown-filter.pdf": aesR4UnknownFilterPdf,
  "aes-password.pdf": aesPasswordPdf,
  "aes-r4.pdf": aesR4Pdf,
  "aes-r4-edited.pdf": aesR4EditedPdf,
  "aes-r4-nometa.pdf": aesR4NometaPdf,
  "aes-r4-resaved.pdf": aesR4ResavedPdf,
  "aes-r6.pdf": aesR6Pdf,
  "aes-r6-edited.pdf": aesR6EditedPdf,
  "aes-r6-nometa.pdf": aesR6NometaPdf,
  "aes-r6-resaved.pdf": aesR6ResavedPdf,
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
  "png-1.bin": png1Bin,
  "png-2.bin": png2Bin,
  "png-4.bin": png4Bin,
  "rc4-password.pdf": rc4PasswordPdf,
  "rc4-r2-edited.pdf": rc4R2EditedPdf,
  "rc4-r2.pdf": rc4R2Pdf,
  "rc4-r3-edited.pdf": rc4R3EditedPdf,
  "rc4-r3.pdf": rc4R3Pdf,
  "rl-content.bin": rlContentBin,
  "rl-edited.bin": rlEditedBin,
  "rl-xmp.bin": rlXmpBin,
  "rl-zeros.bin": rlZerosBin,
  "tiff-1.bin": tiff1Bin,
  "tiff-16.bin": tiff16Bin,
  "tiff-2.bin": tiff2Bin,
  "tiff-4.bin": tiff4Bin,
  "tiff-8.bin": tiff8Bin,
};

const bytes = (dataUrl: string) =>
  Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0));

// A fixture by its file name; a missing one throws, so a test never reads an empty file as a fixture.
export function fixture(name: string): Uint8Array {
  const url = URLS[name];
  if (!url) throw new Error(`no fixture ${name}`);
  return bytes(url);
}
