// The Outlook .msg fixtures (D01 T01 §6) as bytes inside workerd, which has no file system: Vite inlines each binary
// file as a data URL, and the .eml twin as text.

import ansiUrl from "./ansi.msg?inline";
import cyrillicUrl from "./cyrillic-html.msg?inline";
import emptyUrl from "./empty.msg?inline";
import forgedUrl from "./forged-size.msg?inline";
import twinText from "./invoice-request.eml?raw";
import fullUrl from "./invoice-request.msg?inline";
import draftUrl from "./invoice-request-draft.msg?inline";
import malformedUrl from "./malformed-headers.msg?inline";
import notAMsgUrl from "./not-a-msg.msg?inline";
import rtfOnlyUrl from "./rtf-only.msg?inline";
import truncatedUrl from "./truncated.msg?inline";

const bytes = (dataUrl: string) =>
  Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0));

export const msgs = {
  full: bytes(fullUrl),
  draft: bytes(draftUrl),
  rtfOnly: bytes(rtfOnlyUrl),
  notAMsg: bytes(notAMsgUrl),
  truncated: bytes(truncatedUrl),
  empty: bytes(emptyUrl),
  ansi: bytes(ansiUrl),
  cyrillic: bytes(cyrillicUrl),
  malformedHeaders: bytes(malformedUrl),
  forgedSize: bytes(forgedUrl),
};
export const twin = new TextEncoder().encode(twinText);
