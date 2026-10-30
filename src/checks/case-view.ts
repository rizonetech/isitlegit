// The case as every check sees it (D02 T01 §1): built once from the parsed summary in R2 (`raw/<caseId>/parsed.json`,
// D01 T01 §5) by `caseViewOf`, never from raw bytes passed between steps. A mailed forward or an uploaded message gives
// its headers, bodies, cut parts and attachments; an uploaded document, image or voice note gives only its file. Links
// (D02 T07 §1) and renders (D03 T02 §1) join the view in the sections that make them.
import { z } from "zod";
import type { Receiver } from "../auth/receivers";
import type { BrandTable } from "./brand-schema";
import type { DomainAges } from "./rdap";

const Header = z.strictObject({ name: z.string(), value: z.string() });
const Attachment = z.strictObject({
  key: z.string().min(1),
  filename: z.string(),
  mediaType: z.string(),
  contentId: z.string().nullable(),
  disposition: z.string().nullable(),
  bytes: z.number().int().nonnegative(),
});
// A body part cut for reading, kept whole as its own artefact; its media type and charset read the bytes back.
const CutPart = z.strictObject({
  mediaType: z.string(),
  charset: z.string().nullable(),
  key: z.string().min(1),
  fullBytes: z.number().int().nonnegative(),
  keptBytes: z.number().int().nonnegative(),
});
const ForwardPath = z.enum(["rfc822", "eml", "msg", "inline"]);

// The two summaries `parse` writes (src/pipeline/analysis-workflow.ts): a message's, from `storeParsed`, and an uploaded
// file's, naming it.
const MessageSummary = z.strictObject({
  headers: z.array(Header),
  text: z.string().nullable(),
  html: z.string().nullable(),
  attachments: z.array(Attachment),
  truncated: z.array(CutPart),
  omitted: z.number().int().nonnegative(),
  forward: z.strictObject({
    path: ForwardPath,
    headersAvailable: z.boolean(),
    otherOriginals: z.number().int().nonnegative(),
  }),
});
const UploadSummary = z.strictObject({
  source: z.strictObject({
    kind: z.enum(["document", "image", "audio"]),
    mediaType: z.string(),
    key: z.string().min(1),
    bytes: z.number().int().nonnegative(),
  }),
  forward: z.strictObject({ headersAvailable: z.literal(false) }),
});

// The organisation the case is for, and its receiving systems (D02 T02 §1), which the checks step reads from the store
// so a check never has to: only Authentication-Results headers these wrote are trusted. Empty when none are known.
export type Tenant = {
  orgId: string;
  channel: "email" | "upload";
  receivers: Receiver[];
  // The domains the organisation trusts, which `domain.lookalike` compares against (D02 T03 §2): its verified domains
  // and its suppliers', read by the checks step.
  trusted: { own: string[]; suppliers: string[] };
};

export type CaseView = {
  tenant: Tenant & { headersAvailable: boolean };
  // The stored raw message the view was read from (`raw/<caseId>/message.eml`): the artefact a header-based item rests
  // on, since a check cannot store one of its own (D02 T02 §2).
  raw: string;
  // The curated brand table in force (D02 T02 §4): KV's copy, or the bundled one, read by the checks step so a check
  // never reads KV.
  brands: BrandTable;
  // Whether the organisation's earlier IsItLegit checks had a case from this sender (D02 T02 §5), filled by the checks
  // step from `observeSender`; null when it was not asked (no single valid From in the original's own headers).
  senderHistory: "first" | "seen" | null;
  // The registration dates of the case's header domains from RDAP (D02 T03 §4), read by the checks step; null when not
  // read.
  domainAges: DomainAges | null;
  source:
    | { kind: "message"; path: z.infer<typeof ForwardPath>; otherOriginals: number }
    | { kind: "upload"; fileKind: "document" | "image" | "audio"; mediaType: string; key: string; bytes: number };
  headers: z.infer<typeof Header>[];
  text: string | null;
  html: string | null;
  attachments: z.infer<typeof Attachment>[];
  truncated: z.infer<typeof CutPart>[];
  omitted: number;
};

export class SummaryRefused extends TypeError {
  override name = "SummaryRefused";
}

export function caseViewOf(summary: unknown, tenant: Tenant, raw: string, brands: BrandTable): CaseView {
  const message = MessageSummary.safeParse(summary);
  if (message.success) {
    const m = message.data;
    return {
      tenant: { ...tenant, headersAvailable: m.forward.headersAvailable },
      raw,
      brands,
      senderHistory: null,
      domainAges: null,
      source: { kind: "message", path: m.forward.path, otherOriginals: m.forward.otherOriginals },
      headers: m.headers,
      text: m.text,
      html: m.html,
      attachments: m.attachments,
      truncated: m.truncated,
      omitted: m.omitted,
    };
  }
  const upload = UploadSummary.safeParse(summary);
  if (upload.success) {
    const { kind, ...file } = upload.data.source;
    return {
      tenant: { ...tenant, headersAvailable: false },
      raw,
      brands,
      senderHistory: null,
      domainAges: null,
      source: { kind: "upload", fileKind: kind, ...file },
      headers: [],
      text: null,
      html: null,
      attachments: [],
      truncated: [],
      omitted: 0,
    };
  }
  throw new SummaryRefused("the parsed summary is neither a message's nor an uploaded file's");
}
