// The forward fixtures (D01 T01 §4) as bytes inside workerd, which has no file system: Vite reads each as text, and every
// fixture is ASCII (the placeholder .msg travels base64-encoded inside its .eml), so the bytes are exact.

import attachedEmlFileText from "./attached-eml-file.eml?raw";
import attachedMsgText from "./attached-msg.eml?raw";
import attachedRfc822Text from "./attached-rfc822.eml?raw";
import attachedRfc822InlineText from "./attached-rfc822-inline.eml?raw";
import emlAndMsgText from "./eml-and-msg.eml?raw";
import inlineForwardText from "./inline-forward.eml?raw";
import inlineWithPdfText from "./inline-with-pdf.eml?raw";
import innerEml1Text from "./inner-eml-1.eml?raw";
import innerFirstOfTwoText from "./inner-first-of-two.eml?raw";
import innerNestedMiddleText from "./inner-nested-middle.eml?raw";
import innerNodisp1Text from "./inner-nodisp-1.eml?raw";
import innerRfc8221Text from "./inner-rfc822-1.eml?raw";
import innerWinnerEmlText from "./inner-winner-eml.eml?raw";
import innerWinnerRfc822Text from "./inner-winner-rfc822.eml?raw";
import nestedForwardText from "./nested-forward.eml?raw";
import rfc822AndEmlText from "./rfc822-and-eml.eml?raw";
import twoOriginalsText from "./two-originals.eml?raw";

const bytes = (text: string) => new TextEncoder().encode(text);

export const forwards = {
  "attached-rfc822": bytes(attachedRfc822Text),
  "attached-eml-file": bytes(attachedEmlFileText),
  "attached-msg": bytes(attachedMsgText),
  "inline-forward": bytes(inlineForwardText),
  "attached-rfc822-inline": bytes(attachedRfc822InlineText),
  "nested-forward": bytes(nestedForwardText),
  "rfc822-and-eml": bytes(rfc822AndEmlText),
  "eml-and-msg": bytes(emlAndMsgText),
  "two-originals": bytes(twoOriginalsText),
  "inline-with-pdf": bytes(inlineWithPdfText),
};

// The attached originals' own bytes, for byte-equality checks.
export const inners = {
  "rfc822-1": bytes(innerRfc8221Text),
  "eml-1": bytes(innerEml1Text),
  "nodisp-1": bytes(innerNodisp1Text),
  "winner-rfc822": bytes(innerWinnerRfc822Text),
  "winner-eml": bytes(innerWinnerEmlText),
  "first-of-two": bytes(innerFirstOfTwoText),
  "nested-middle": bytes(innerNestedMiddleText),
};
