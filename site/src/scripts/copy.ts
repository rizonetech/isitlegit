// The Copy address action (D07 T06 §2), separate from the page so it can be tested without a browser.
export const COPIED = "Address copied";
export const COPY_FAILED = "Copy failed: select the address and copy it";

type Clipboard = { writeText(text: string): Promise<void> };

// Copies `address` and returns what to announce; never throws.
export async function copy(clipboard: Clipboard | undefined, address: string): Promise<string> {
  if (!clipboard) return COPY_FAILED;
  try {
    await clipboard.writeText(address);
    return COPIED;
  } catch {
    return COPY_FAILED;
  }
}
