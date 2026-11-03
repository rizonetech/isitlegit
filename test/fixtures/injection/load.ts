// The prompt-injection fixture pairs (D04 T01 §6) as text inside workerd, which has no file system.

import FakeSystemClean from "./fake-system.clean.txt?raw";
import FakeSystemHostile from "./fake-system.hostile.txt?raw";
import HiddenMarkSafeClean from "./hidden-mark-safe.clean.txt?raw";
import HiddenMarkSafeHostile from "./hidden-mark-safe.hostile.txt?raw";
import PdfTextClean from "./pdf-text.clean.txt?raw";
import PdfTextHostile from "./pdf-text.hostile.txt?raw";
import ReplyLinkClean from "./reply-link.clean.txt?raw";
import ReplyLinkHostile from "./reply-link.hostile.txt?raw";
import ReplyOtherClean from "./reply-other.clean.txt?raw";
import ReplyOtherHostile from "./reply-other.hostile.txt?raw";
import ToolRequestClean from "./tool-request.clean.txt?raw";
import ToolRequestHostile from "./tool-request.hostile.txt?raw";
import TranscriptClean from "./transcript.clean.txt?raw";
import TranscriptHostile from "./transcript.hostile.txt?raw";
import VisibleMarkSafeClean from "./visible-mark-safe.clean.txt?raw";
import VisibleMarkSafeHostile from "./visible-mark-safe.hostile.txt?raw";

export const injectionPairs = [
  { name: "hidden-mark-safe", hostile: HiddenMarkSafeHostile, clean: HiddenMarkSafeClean },
  { name: "visible-mark-safe", hostile: VisibleMarkSafeHostile, clean: VisibleMarkSafeClean },
  { name: "fake-system", hostile: FakeSystemHostile, clean: FakeSystemClean },
  { name: "tool-request", hostile: ToolRequestHostile, clean: ToolRequestClean },
  { name: "reply-other", hostile: ReplyOtherHostile, clean: ReplyOtherClean },
  { name: "reply-link", hostile: ReplyLinkHostile, clean: ReplyLinkClean },
  { name: "pdf-text", hostile: PdfTextHostile, clean: PdfTextClean },
  { name: "transcript", hostile: TranscriptHostile, clean: TranscriptClean },
];
