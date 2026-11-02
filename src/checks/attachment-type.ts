// An attachment whose bytes are not what its name or declared type says (D02 T04 §1): a `.pdf` that is a Windows
// program is the classic trick. The bytes decide (`sniff`); the name's extension and the declared media type are claims.
// A program, script or shortcut behind a document or image name is high; any other disagreement medium; an unknown
// extension or an unrecognised body claims nothing.
import { bounded, fittedDetail, plain } from "./auth";
import type { CaseView } from "./case-view";
import type { EvidenceDraft } from "./evidence";
import { counted } from "./outcome-summary";
import type { CheckRegistry } from "./registry";
import { MAX_SNIFFED, type SniffedType, sniff } from "./sniff";

type Family =
  | "document"
  | "image"
  | "audio"
  | "archive"
  | "executable"
  | "script"
  | "shortcut"
  | "text"
  | "web"
  | "disk";

// The types a claim allows the bytes to be: a `.docx` is an OOXML package, which is a ZIP; a `.doc` an OLE file.
const EXTENSIONS: Record<string, SniffedType[]> = {
  pdf: ["pdf"],
  docx: ["docx", "ooxml", "zip"],
  xlsx: ["xlsx", "ooxml", "zip"],
  pptx: ["pptx", "ooxml", "zip"],
  docm: ["docx", "ooxml", "zip"],
  xlsm: ["xlsx", "ooxml", "zip"],
  doc: ["ole"],
  xls: ["ole"],
  ppt: ["ole"],
  msg: ["ole"],
  // Older Office templates are their documents' containers; OpenDocument is a ZIP named by its mimetype (D02 T04 §5).
  dot: ["ole"],
  xlt: ["ole"],
  pot: ["ole"],
  dotx: ["docx", "ooxml", "zip"],
  xltx: ["xlsx", "ooxml", "zip"],
  potx: ["pptx", "ooxml", "zip"],
  odt: ["odf", "zip"],
  ods: ["odf", "zip"],
  odp: ["odf", "zip"],
  ott: ["odf", "zip"],
  ots: ["odf", "zip"],
  otp: ["odf", "zip"],
  rtf: ["rtf"],
  m4a: ["m4a"],
  ogg: ["ogg"],
  oga: ["ogg"],
  opus: ["ogg"],
  wav: ["wav"],
  mp3: ["mp3"],
  zip: ["zip", "docx", "xlsx", "pptx", "ooxml", "odf"],
  rar: ["rar"],
  "7z": ["7z"],
  cab: ["cab"],
  iso: ["iso"],
  img: ["iso"],
  png: ["png"],
  jpg: ["jpeg"],
  jpeg: ["jpeg"],
  gif: ["gif"],
  webp: ["webp"],
  svg: ["svg"],
  html: ["html", "text", "script"],
  htm: ["html", "text", "script"],
  txt: ["text"],
  csv: ["text"],
  exe: ["pe"],
  dll: ["pe"],
  scr: ["pe"],
  lnk: ["lnk"],
  bat: ["script", "text"],
  cmd: ["script", "text"],
  ps1: ["script", "text"],
  vbs: ["script", "text"],
  js: ["script", "text"],
  hta: ["script", "html", "text"],
  sh: ["script", "text"],
};
const MEDIA_TYPES: Record<string, SniffedType[]> = {
  "application/pdf": ["pdf"],
  "application/zip": ["zip", "docx", "xlsx", "pptx", "ooxml", "odf"],
  "application/x-zip-compressed": ["zip", "docx", "xlsx", "pptx", "ooxml", "odf"],
  "application/rtf": ["rtf"],
  "application/vnd.ms-cab-compressed": ["cab"],
  "text/rtf": ["rtf"],
  "application/vnd.oasis.opendocument.text": ["odf", "zip"],
  "application/vnd.oasis.opendocument.spreadsheet": ["odf", "zip"],
  "application/vnd.oasis.opendocument.presentation": ["odf", "zip"],
  "application/vnd.oasis.opendocument.text-template": ["odf", "zip"],
  "application/vnd.oasis.opendocument.spreadsheet-template": ["odf", "zip"],
  "application/vnd.oasis.opendocument.presentation-template": ["odf", "zip"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template": ["docx", "ooxml", "zip"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template": ["xlsx", "ooxml", "zip"],
  "application/vnd.openxmlformats-officedocument.presentationml.template": ["pptx", "ooxml", "zip"],
  "audio/mp4": ["m4a"],
  "audio/m4a": ["m4a"],
  "audio/x-m4a": ["m4a"],
  "audio/ogg": ["ogg"],
  "audio/opus": ["ogg"],
  "application/ogg": ["ogg"],
  "audio/wav": ["wav"],
  "audio/wave": ["wav"],
  "audio/x-wav": ["wav"],
  "audio/vnd.wave": ["wav"],
  "audio/mpeg": ["mp3"],
  "audio/mp3": ["mp3"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx", "ooxml", "zip"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx", "ooxml", "zip"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx", "ooxml", "zip"],
  "application/msword": ["ole"],
  "application/vnd.ms-excel": ["ole"],
  "application/vnd.ms-powerpoint": ["ole"],
  "application/vnd.ms-outlook": ["ole"],
  "image/png": ["png"],
  "image/jpeg": ["jpeg"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "image/svg+xml": ["svg"],
  "text/html": ["html", "text", "script"],
  "text/plain": ["text"],
  "text/csv": ["text"],
};
const FAMILY: Record<SniffedType, Family> = {
  pdf: "document",
  docx: "document",
  xlsx: "document",
  pptx: "document",
  ooxml: "document",
  ole: "document",
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  cab: "archive",
  iso: "disk",
  png: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  pe: "executable",
  elf: "executable",
  macho: "executable",
  lnk: "shortcut",
  script: "script",
  html: "web",
  text: "text",
  rtf: "document",
  odf: "document",
  m4a: "audio",
  ogg: "audio",
  wav: "audio",
  mp3: "audio",
};
// Each format as a member reads it, in the summaries; `detail` keeps the identifiers (completion review).
const NAMES: Record<SniffedType, string> = {
  pdf: "a PDF",
  docx: "a Word document",
  xlsx: "an Excel workbook",
  pptx: "a PowerPoint presentation",
  ooxml: "an Office document",
  ole: "an older Office file or Outlook message",
  zip: "a ZIP archive",
  rar: "a RAR archive",
  "7z": "a 7-Zip archive",
  cab: "a Windows cabinet archive",
  iso: "a disk image",
  png: "a PNG image",
  jpeg: "a JPEG image",
  gif: "a GIF image",
  webp: "a WebP image",
  svg: "an SVG image",
  pe: "a Windows program",
  elf: "a Linux program",
  macho: "a Mac program",
  lnk: "a Windows shortcut",
  script: "a script",
  html: "a web page",
  text: "plain text",
  rtf: "an RTF document",
  odf: "an OpenDocument file",
  // Format only: the bytes say the container, not that it holds speech (completion review).
  m4a: "an M4A audio file",
  ogg: "an Ogg file",
  wav: "a WAV audio file",
  mp3: "an MP3 audio file",
};
const DANGEROUS: Family[] = ["executable", "script", "shortcut"];
// A program behind a voice note's name is the same trick as behind a document's (D02 T04 §5).
const DISGUISE: Family[] = ["document", "image", "audio"];

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1
    ? name
        .slice(dot + 1)
        .trim()
        .toLowerCase()
    : null;
};
const decode = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

// What to compare: a message's attachments, or an uploaded file under the name and media type it was sent with (D02 T04
// §4), its stored key the artefact.
function compared(view: CaseView): { key: string; filename: string; mediaType: string }[] {
  if (view.source.kind === "upload") {
    const claimed = view.source.claimed;
    return claimed ? [{ key: view.source.key, filename: claimed.name ?? "", mediaType: claimed.mediaType ?? "" }] : [];
  }
  return view.attachments;
}

export function typeMismatchEvidence(view: CaseView): EvidenceDraft[] {
  const heads = view.attachmentHeads;
  if (!heads) return [];
  const items: EvidenceDraft[] = [];
  // The attachments the step read, at most MAX_SNIFFED of them (round 1: fifty copies of one file share a key).
  for (const attachment of compared(view).slice(0, MAX_SNIFFED)) {
    const head = heads.heads.find((h) => h.key === attachment.key);
    if (!head) continue;
    const sniffed = sniff(decode(head.head));
    if (!sniffed) continue;
    const extension = extensionOf(attachment.filename);
    const declared = attachment.mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
    // Own entries only: a name such as `notes.constructor` reads no inherited property (completion review).
    const byName = extension && Object.hasOwn(EXTENSIONS, extension) ? EXTENSIONS[extension] : undefined;
    const byType = Object.hasOwn(MEDIA_TYPES, declared) ? MEDIA_TYPES[declared] : undefined;
    const claims = [
      ...(byName && !byName.includes(sniffed) ? ["extension"] : []),
      ...(byType && !byType.includes(sniffed) ? ["media type"] : []),
    ];
    if (!claims.length) continue;
    // Every claim that disagrees weighs on the severity, so a false name cannot soften a false declared type (round 2):
    // a program behind any document or image claim is high, and the summary names that claim.
    const disagreeing = [
      ...(byName && !byName.includes(sniffed) ? [byName[0] as SniffedType] : []),
      ...(byType && !byType.includes(sniffed) ? [byType[0] as SniffedType] : []),
    ];
    const disguise = disagreeing.find((claim) => DISGUISE.includes(FAMILY[claim]));
    const hidden = DANGEROUS.includes(FAMILY[sniffed]) && disguise !== undefined;
    const said = (hidden ? disguise : disagreeing[0]) as SniffedType;
    items.push({
      check: "attachment.type_mismatch",
      severity: hidden ? "high" : "medium",
      summary: bounded(
        `${plain(attachment.filename || "An attachment", 80)} is ${byName && !byName.includes(sniffed) && byName[0] === said ? "named" : "declared"} as ${NAMES[said]}, but contains ${NAMES[sniffed]}.`,
      ),
      detail: fittedDetail({
        filename: attachment.filename,
        extension,
        declared,
        sniffed,
        family: FAMILY[sniffed],
        claims,
      }) as EvidenceDraft["detail"],
      artefacts: [attachment.key],
    });
  }
  if (heads.unread > 0)
    items.push({
      check: "attachment.type_mismatch",
      severity: "info",
      summary: bounded(`${heads.unread} more attachments' contents were not compared with their names.`),
      detail: { checked: false, unread: heads.unread },
      artefacts: [],
    });
  return items;
}

export function registerTypeMismatchCheck(registry: CheckRegistry): void {
  registry.register({
    name: "attachment.type_mismatch",
    needs: [],
    timeoutMs: 1_000,
    run: typeMismatchEvidence,
    examined: (view) => compared(view).map((a) => a.filename || a.key),
    // The files the check compares, an uploaded file included, and a mismatch of its name or its declared type alike
    // (completion review: an upload counted none, and a declared type's mismatch was called a name's).
    summary: (view, items) => {
      const read = Math.min(compared(view).length, MAX_SNIFFED);
      return items.length
        ? `${items.length} of ${read} not what ${read === 1 ? "it claims" : "they claim"} to be`
        : `${counted(read, "file", "files")} read, each what it claims to be`;
    },
    applies: (view) =>
      view.attachmentHeads
        ? null
        : view.source.kind === "upload"
          ? "the upload was sent without a name or media type to compare"
          : "the message has no attachments",
    // Attachments not read, and files whose bytes match no type the sniffer knows (an audio upload, a plain-text file),
    // were not compared, so the check is partial for them (completion review).
    partial: (view) => {
      const heads = view.attachmentHeads;
      if (!heads) return null;
      const unknown = compared(view)
        .slice(0, MAX_SNIFFED)
        .filter((a) => {
          const head = heads.heads.find((h) => h.key === a.key);
          return head !== undefined && sniff(decode(head.head)) === null;
        }).length;
      const parts = [
        heads.unread ? `${heads.unread} attachment${heads.unread === 1 ? "" : "s"} could not be read` : "",
        unknown ? `${unknown} file${unknown === 1 ? "" : "s"} of a type not identified` : "",
      ].filter(Boolean);
      return parts.length ? parts.join(", ") : null;
    },
  });
}
