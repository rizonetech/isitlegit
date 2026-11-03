// The case as every check sees it (D02 T01 §1): built once from the parsed summary in R2 (`raw/<caseId>/parsed.json`,
// D01 T01 §5) by `caseViewOf`, never from raw bytes passed between steps. A mailed forward or an uploaded message gives
// its headers, bodies, cut parts and attachments; an uploaded document, image or voice note gives only its file. Links
// (D02 T07 §1, `links`) and renders (D03 T02 §1) join the view in the sections that make them.
import { z } from "zod";
import type { Receiver } from "../auth/receivers";
import type { VoiceRead } from "../voice/schema";
import type { TranscriptGap, TranscriptTurn } from "../voice/transcribe";
import type { Instructions } from "./ai-instructions";
import type { AttachmentRisks } from "./attachment-risk";
import type { BrandTable } from "./brand-schema";
import type { Expansions } from "./expand";
import type { HiddenText } from "./hidden-text";
import type { HtmlAttachment } from "./html-attachment";
import type { InvisibleText } from "./instruction-phrases";
import type { Links, Unread } from "./links";
import type { DomainAges } from "./rdap";
import type { ReceivingChain } from "./receiving-chain";
import type { Reputation } from "./reputation";

const Header = z.strictObject({ name: z.string(), value: z.string() });
const Attachment = z.strictObject({
  key: z.string().min(1),
  filename: z.string(),
  mediaType: z.string(),
  contentId: z.string().nullable(),
  disposition: z.string().nullable(),
  // The charset a text attachment's bytes are read with; absent from a summary stored before D02 T05 §2.
  charset: z.string().nullable().optional(),
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
    // What the file claimed to be when uploaded (D02 T04 §4); absent from a summary stored before.
    claimed: z.strictObject({ name: z.string().nullable(), mediaType: z.string().nullable() }).optional(),
  }),
  forward: z.strictObject({ headersAvailable: z.literal(false) }),
});

// The organisation the case is for, and its receiving systems (D02 T02 §1), which the checks step reads from the store
// so a check never has to: only Authentication-Results headers these wrote are trusted. Empty when none are known.
export type Tenant = {
  orgId: string;
  channel: "email" | "upload";
  receivers: Receiver[];
  // Its receiving chains behind a filtering gateway (D02 T02 §6), stored before this case was read: none when absent.
  chains?: ReceivingChain[];
  // The domains the organisation trusts, which `domain.lookalike` compares against (D02 T03 §2): its verified domains
  // and its suppliers', read by the checks step.
  trusted: { own: string[]; suppliers: string[] };
};

// The protected-identity candidates the trust claim match reads (D02 T01 §9): every effectively protected
// identity's names and verified domains as stored text, with its registered logo reference (artefact key,
// never bytes), filled by the checks step from `protectedIdentities`. Each list is bounded with its overflow
// counted, so a cut set never reads as an exhaustive no-match.
export const MAX_PROTECTED_CANDIDATES = 25;
export const MAX_CANDIDATE_NAMES = 10;
export const MAX_CANDIDATE_DOMAINS = 10;

export type ProtectedCandidates = {
  candidates: {
    orgId: string;
    names: string[];
    namesOmitted: number;
    domains: string[];
    domainsOmitted: number;
    logo: { key: string; mediaType: string } | null;
  }[];
  omitted: number;
};

export function boundProtectedCandidates(
  list: {
    orgId: string;
    names: string[];
    domains: string[];
    logo: { key: string; mediaType: string } | null;
  }[],
): ProtectedCandidates {
  const seen = new Set<string>();
  const unique = list.filter((c) => !seen.has(c.orgId) && seen.add(c.orgId));
  return {
    candidates: unique.slice(0, MAX_PROTECTED_CANDIDATES).map((c) => ({
      orgId: c.orgId,
      names: c.names.slice(0, MAX_CANDIDATE_NAMES),
      namesOmitted: Math.max(0, c.names.length - MAX_CANDIDATE_NAMES),
      domains: c.domains.slice(0, MAX_CANDIDATE_DOMAINS),
      domainsOmitted: Math.max(0, c.domains.length - MAX_CANDIDATE_DOMAINS),
      logo: c.logo,
    })),
    omitted: Math.max(0, unique.length - MAX_PROTECTED_CANDIDATES),
  };
}

export type CaseView = {
  tenant: Tenant & { headersAvailable: boolean };
  // The protected-identity candidates for the trust claim match (D02 T01 §9), filled by the checks step; absent
  // from a view built before it, and an empty set when no identity is effectively protected.
  protectedCandidates?: ProtectedCandidates;
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
  // The case's link and sender-domain reputation answers (D02 T06 §5), read by the checks step; null when the case
  // has neither a link nor a sender domain, or the step was given no way to ask. Absent from a view built before it.
  reputation?: Reputation | null;
  // The first bytes (SNIFF_BYTES, base64) of up to MAX_SNIFFED attachments, read from R2 by the checks step for the
  // type-mismatch check (D02 T04 §1); `unread` counts those not read. Null when not read.
  attachmentHeads: { heads: { key: string; head: string }[]; unread: number } | null;
  // The hidden text the checks step found in the HTML, the summary's and each cut part's (D02 T05 §1); null when the
  // message had no HTML.
  hiddenText: HiddenText | null;
  // The HTML and SVG attachments the checks step read and analysed (D02 T04 §2); null when there were none.
  // `skipped` names those not read (D02 T07 §1); absent from a view built before it.
  htmlAttachments: { items: HtmlAttachment[]; unread: number; skipped?: Unread[] } | null;
  // Each attachment's macros, encryption and programs, read by the checks step (D02 T04 §3); null without attachments.
  attachmentRisks: AttachmentRisks | null;
  // The phrases written to steer an AI, matched by the checks step over the body's and the text attachments' whole text,
  // and what it could not read (D02 T05 §2); null when not read.
  instructions: Instructions | null;
  // Runs of characters no font draws in the visible text (D02 T05 §3), the tag block's decoded; null when not read.
  invisibleText: InvisibleText | null;
  // Every link in the body, its cut parts, and the HTML, SVG and PDF attachments, or an uploaded PDF's, read by the
  // checks step (D02 T07 §1); null when the case has nothing to read links from.
  links: Links | null;
  // The case's links followed in Browser Run (D02 T07 §2), read by the checks step; null when following was unavailable
  // (no binding, or no session), which is not the same as a case with no links.
  expansions: Expansions | null;
  // What a voice note's transcript was read to say (D01 T03 §4), from the stored `voice-claim.json`; null or absent for a
  // case that is not a voice note.
  voice?: VoiceRead | null;
  // Each stored transcript of the case's recordings (D01 T03 §16), read from its `audio` artefacts by the checks
  // step: the transcript's own key, its recording's key and filename where they are known, its turns and gaps, and
  // whether it is whole; a transcript that cannot be read is named by its key with `malformed` set. Null when the
  // case holds no transcript artefact.
  transcripts?:
    | {
        transcriptKey: string;
        recordingKey: string | null;
        filename: string | null;
        turns: TranscriptTurn[];
        gaps: TranscriptGap[];
        complete: boolean;
        malformed?: boolean;
      }[]
    | null;
  source:
    | { kind: "message"; path: z.infer<typeof ForwardPath>; otherOriginals: number }
    | {
        kind: "upload";
        fileKind: "document" | "image" | "audio";
        mediaType: string;
        key: string;
        bytes: number;
        claimed?: { name: string | null; mediaType: string | null };
      };
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
      attachmentHeads: null,
      hiddenText: null,
      htmlAttachments: null,
      attachmentRisks: null,
      instructions: null,
      invisibleText: null,
      links: null,
      expansions: null,
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
      attachmentHeads: null,
      hiddenText: null,
      htmlAttachments: null,
      attachmentRisks: null,
      instructions: null,
      invisibleText: null,
      links: null,
      expansions: null,
      source: {
        kind: "upload",
        fileKind: kind,
        mediaType: file.mediaType,
        key: file.key,
        bytes: file.bytes,
        ...(file.claimed ? { claimed: file.claimed } : {}),
      },
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
