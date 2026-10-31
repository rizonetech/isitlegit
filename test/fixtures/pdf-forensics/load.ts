// The Ghostscript and Chromium fixtures as bytes inside workerd, which has no file system: Vite inlines each file as a
// data URL (test/fixtures/audio/load.ts does the same).
import chromiumInvoiceUrl from "./chromium-invoice.pdf?inline";
import chromiumPopUrl from "./chromium-pop.pdf?inline";
import gsEditedUrl from "./gs-edited-pop.pdf?inline";
import gsGenuineUrl from "./gs-genuine-pop.pdf?inline";
import gsLogoUrl from "./gs-logo.pdf?inline";
import gsModifiedUrl from "./gs-modified-pop.pdf?inline";
import gsPastedUrl from "./gs-pasted-image.pdf?inline";
import gsSubstitutedUrl from "./gs-substituted-font.pdf?inline";

const bytes = (dataUrl: string) =>
  Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0));

export const generated = {
  "chromium-invoice.pdf": bytes(chromiumInvoiceUrl),
  "chromium-pop.pdf": bytes(chromiumPopUrl),
  "gs-edited-pop.pdf": bytes(gsEditedUrl),
  "gs-genuine-pop.pdf": bytes(gsGenuineUrl),
  "gs-logo.pdf": bytes(gsLogoUrl),
  "gs-modified-pop.pdf": bytes(gsModifiedUrl),
  "gs-pasted-image.pdf": bytes(gsPastedUrl),
  "gs-substituted-font.pdf": bytes(gsSubstitutedUrl),
};
