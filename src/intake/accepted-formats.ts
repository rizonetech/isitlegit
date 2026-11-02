// The accepted upload files, one definition (D01 T03 §13): the intake refusal's sentence and the upload page's
// list are both built from these rows, so they cannot drift apart. Kept apart from the sniff itself, which reaches
// the voice decoder's refusals, so a page that names the formats pulls in nothing else.
export const ACCEPTED_FORMATS = [
  {
    kind: "Email",
    what: "A saved email",
    detail: ".eml or Outlook .msg, with its original headers",
    phrase: "a saved email (.eml or .msg)",
  },
  {
    kind: "PDF",
    what: "Invoice, proof of payment or bank letter",
    detail: "Checked for edits and against your supplier ledger",
    phrase: "a PDF",
  },
  {
    kind: "Document",
    what: "Word, Excel or PowerPoint file",
    detail: ".docx, .xlsx or .pptx, read and checked as a document",
    phrase: "a Word (.docx), Excel (.xlsx) or PowerPoint (.pptx) file",
  },
  {
    kind: "Image",
    what: "Screenshot or photo",
    detail: "PNG, JPEG or WebP, for example a proof of payment sent on WhatsApp",
    phrase: "an image (PNG, JPEG or WebP)",
  },
  {
    kind: "Audio",
    what: "Voice note or voicemail",
    detail: ".ogg, .opus, .wav or .mp3, up to 10 minutes",
    phrase: "a voice note (Ogg Opus, WAV or MP3)",
  },
] as const;
export const ACCEPTED_FILES = `${ACCEPTED_FORMATS[0].phrase}, ${ACCEPTED_FORMATS[1].phrase}, ${ACCEPTED_FORMATS[2].phrase}, ${ACCEPTED_FORMATS[3].phrase}, or ${ACCEPTED_FORMATS[4].phrase}`;
// What is refused among Office files, in the same words everywhere (the page reads this too).
export const OFFICE_NOT_TAKEN =
  "Older Word, Excel and PowerPoint files (.doc, .xls and .ppt) and files with macros are not taken.";
