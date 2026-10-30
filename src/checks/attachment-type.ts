// An attachment whose bytes are not what its name or declared type says (D02 T04 §1): a `.pdf` that is a Windows
// program is the classic trick. The bytes decide (`sniff`); the name's extension and the declared media type are claims.
// A program, script or shortcut behind a document or image name is high; any other disagreement medium; an unknown
// extension or an unrecognised body claims nothing.
import { bounded, fittedDetail, plain } from "./auth";
import type { CaseView } from "./case-view";
import type { EvidenceDraft } from "./evidence";
import type { CheckRegistry } from "./registry";
import { type SniffedType, sniff } from "./sniff";

type Family = "document" | "image" | "archive" | "executable" | "script" | "shortcut" | "text" | "web" | "disk";

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
  zip: ["zip", "docx", "xlsx", "pptx", "ooxml"],
  rar: ["rar"],
  "7z": ["7z"],
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
  "application/zip": ["zip", "docx", "xlsx", "pptx", "ooxml"],
  "application/x-zip-compressed": ["zip", "docx", "xlsx", "pptx", "ooxml"],
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
};
const DANGEROUS: Family[] = ["executable", "script", "shortcut"];
const DISGUISE: Family[] = ["document", "image"];

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

export function typeMismatchEvidence(view: CaseView): EvidenceDraft[] {
  const heads = view.attachmentHeads;
  if (!heads) return [];
  const items: EvidenceDraft[] = [];
  for (const attachment of view.attachments) {
    const head = heads.heads.find((h) => h.key === attachment.key);
    if (!head) continue;
    const sniffed = sniff(decode(head.head));
    if (!sniffed) continue;
    const extension = extensionOf(attachment.filename);
    const declared = attachment.mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
    const byName = extension ? EXTENSIONS[extension] : undefined;
    const byType = MEDIA_TYPES[declared];
    const claims = [
      ...(byName && !byName.includes(sniffed) ? ["extension"] : []),
      ...(byType && !byType.includes(sniffed) ? ["media type"] : []),
    ];
    if (!claims.length) continue;
    // What the attachment says it is, by the claim that disagrees: its name first.
    const said = byName && !byName.includes(sniffed) ? (byName[0] as SniffedType) : (byType?.[0] as SniffedType);
    const hidden = DANGEROUS.includes(FAMILY[sniffed]) && DISGUISE.includes(FAMILY[said]);
    items.push({
      check: "attachment.type_mismatch",
      severity: hidden ? "high" : "medium",
      summary: bounded(
        `${plain(attachment.filename || "An attachment", 80)} is named or labelled as ${said} but its contents are ${hidden ? `a ${FAMILY[sniffed]} (${sniffed})` : sniffed}.`,
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
  registry.register({ name: "attachment.type_mismatch", needs: [], timeoutMs: 1_000, run: typeMismatchEvidence });
}
