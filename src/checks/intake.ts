// The intake items (D02 T01 §1), registered ahead of every other check so `E1` always says how the case arrived:
// `intake.forward` for a message (D01 T01 §4's forward path), `intake.upload` for an uploaded file, and
// `intake.truncated` when body parts were cut for reading (D01 T01 §5). These state what intake did and nothing more:
// that a check read a cut part in full is that check's own evidence (D02 T07 §1, D02 T05 §1).
import type { CaseView } from "./case-view";
import type { EvidenceDraft } from "./evidence";
import type { CheckRegistry } from "./registry";

const ARRIVED: Record<"email" | "upload", Record<"rfc822" | "eml" | "msg" | "inline", string>> = {
  email: {
    rfc822: "The forward carried the original email as an attachment.",
    eml: "The forward carried the original email as an attached .eml file.",
    msg: "The forward carried the original email as an attached Outlook .msg file.",
    inline: "The original email was forwarded inline, in the body of the forward.",
  },
  upload: {
    rfc822: "The original email was uploaded.",
    eml: "The original email was uploaded as an .eml file.",
    msg: "The original email was uploaded as an Outlook .msg file.",
    inline: "The original email was uploaded.",
  },
};

const FILE_KINDS = { document: "a document", image: "an image", audio: "a voice note" } as const;

export function forwardEvidence(view: CaseView): EvidenceDraft[] {
  if (view.source.kind !== "message") return [];
  const { path, otherOriginals } = view.source;
  const others =
    otherOriginals === 0
      ? ""
      : ` ${otherOriginals} further attached ${otherOriginals === 1 ? "message was" : "messages were"} not checked.`;
  return [
    {
      check: "intake.forward",
      severity: "info",
      summary: ARRIVED[view.tenant.channel][path] + others,
      detail: { path, otherOriginals },
      artefacts: [],
    },
  ];
}

export function uploadEvidence(view: CaseView): EvidenceDraft[] {
  if (view.source.kind !== "upload") return [];
  const { fileKind, mediaType, key, bytes } = view.source;
  return [
    {
      check: "intake.upload",
      severity: "info",
      summary: `The case is ${FILE_KINDS[fileKind]} uploaded as ${mediaType}.`,
      detail: { kind: fileKind, mediaType, bytes },
      artefacts: [key],
    },
  ];
}

export function truncatedEvidence(view: CaseView): EvidenceDraft[] {
  if (view.truncated.length === 0 && view.omitted === 0) return [];
  const parts = view.truncated.length;
  const further =
    view.omitted === 0
      ? ""
      : ` ${view.omitted} further cut ${view.omitted === 1 ? "part was" : "parts were"} kept only up to the cut.`;
  return [
    {
      check: "intake.truncated",
      severity: "info",
      summary:
        `${parts} body ${parts === 1 ? "part was" : "parts were"} longer than the reading limit, so the reading of ` +
        `${parts === 1 ? "it" : "each"} stops at the cut; the whole text is kept.${further}`,
      detail: {
        parts: view.truncated.map(({ mediaType, charset, fullBytes, keptBytes, key }) => ({
          mediaType,
          charset,
          fullBytes,
          keptBytes,
          key,
        })),
        omitted: view.omitted,
      },
      artefacts: view.truncated.map((part) => part.key),
    },
  ];
}

// The intake checks, in the order their items appear: how the case arrived, then what was cut.
export function registerIntakeChecks(registry: CheckRegistry): void {
  // Each reads one kind of case: the other kind is skipped, never clean (D02 T01 §3).
  registry.register({
    name: "intake.forward",
    needs: ["source"],
    timeoutMs: 1_000,
    run: forwardEvidence,
    summary: (view) =>
      view.tenant.headersAvailable
        ? "the original's headers were read"
        : "the original's headers were not in the forward",
    applies: (view) => (view.source.kind === "message" ? null : "the case is not a forwarded message"),
  });
  registry.register({
    name: "intake.upload",
    needs: ["source"],
    timeoutMs: 1_000,
    run: uploadEvidence,
    summary: () => "read from an upload",
    // Why the file check does not apply (D01 T03 §12): an uploaded email is checked as the message it holds, not as a
    // file; a forward was not uploaded at all.
    applies: (view) =>
      view.source.kind === "upload"
        ? null
        : view.tenant.channel === "upload"
          ? "an uploaded email is checked as the message it holds, not as a file"
          : "the case was forwarded, not uploaded",
  });
  registry.register({
    name: "intake.truncated",
    needs: ["truncated", "omitted"],
    timeoutMs: 1_000,
    run: truncatedEvidence,
    examined: (view) => view.truncated.map((part) => `${part.mediaType} part, ${part.fullBytes} bytes`),
    summary: (_, items) => (items.length ? "part of the message was not read whole" : "read whole"),
  });
}
