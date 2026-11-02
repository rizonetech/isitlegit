// The report's evidence cards (D07 T03 §3; design/SPEC.md M3, boards `Main`, `Report-Safe`, `Report-Partial`,
// `Report-Mobile`): every stored item as an `EvidenceCard`, drawn by its family's renderer from its check's own
// `detail` (src/checks/*.ts), with its files linked through the artefact route. Detail fields that come from the
// message (a domain, a quote, a file name) are drawn as text and never as markup. An item whose check has no renderer
// (a check renamed since it was stored) draws the plain card: its severity and summary.

import { cx, FOCUS } from "../attrs";
import { EvidenceCard, EvidenceFigure, EvidenceQuote, type Severity } from "../Evidence";
import { CHECK_WORDS } from "./check-words";

export type CardItem = {
  id: string;
  check: string;
  severity: Exclude<Severity, "not-checked">;
  summary: string;
  detail: Record<string, unknown>;
  artefacts: string[];
};
// How a card links a file: the URL for a key (the member's, or the link holder's with its signature parameters).
export type FileLink = (key: string) => string;

// The families a renderer exists for; the families whose producers come later (reputation, link, vision and more)
// are D07 T03 §12 to §17.
export const FAMILIES = [
  "intake",
  "auth",
  "sender",
  "domain",
  "attachment",
  "content",
  "link",
  "walkthrough",
  "voice",
  "document",
  "reputation",
  "not_checked",
] as const;
export type Family = (typeof FAMILIES)[number];
export { CHECK_WORDS } from "./check-words";
export const familyOf = (check: string): Family | null => {
  if (!Object.hasOwn(CHECK_WORDS, check)) return null;
  return check.split(".")[0] as Family;
};
// A check's name in words; a name no longer known is said as a check, never as its internal name.
const checkWords = (check: unknown) =>
  typeof check === "string" && Object.hasOwn(CHECK_WORDS, check) ? (CHECK_WORDS[check] as string) : "A check";

// Narrow reads of a stored detail: anything not of the expected type is left out, never drawn as something it is not.
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
// The hidden instruction's excerpt (D02 T05 §6): the text around the instruction and the character it starts at in
// the run. A stored value of any other shape is left out.
const runInstruction = (v: unknown): { text: string; offset: number } | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const body = text(r.text);
  const offset = count(r.offset);
  return body !== null && offset !== null && Number.isInteger(offset) && offset >= 0 ? { text: body, offset } : null;
};
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const records = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x))
    : [];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const LINK = cx("self-start text-14 text-orange-text underline underline-offset-4 wrap-anywhere", FOCUS);

function Facts(props: { rows: [string, string | number | null | undefined][] }) {
  const rows = props.rows.filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (rows.length === 0) return null;
  return (
    <dl class="grid gap-x-16 gap-y-8 text-14 md:grid-cols-[max-content_1fr]">
      {rows.map(([term, value]) => (
        <>
          <dt class="text-muted">{term}</dt>
          <dd class="min-w-0 wrap-anywhere">{String(value)}</dd>
        </>
      ))}
    </dl>
  );
}
function Bullets(props: { items: string[]; more?: number }) {
  if (props.items.length === 0) return null;
  return (
    <ul class="flex flex-col gap-4 pl-16 list-disc text-14 wrap-anywhere">
      {props.items.map((item) => (
        <li>{item}</li>
      ))}
      {props.more ? <li class="text-muted">{`and ${props.more} more`}</li> : null}
    </ul>
  );
}
// The authentication header lines a finding rests on, at most three, each as the receiver wrote it.
function Headers(props: { lines: unknown }) {
  const lines = texts(props.lines).slice(0, 3);
  return lines.length === 0 ? null : (
    <div class="flex flex-col gap-8">
      {lines.map((line) => (
        <EvidenceQuote>{line}</EvidenceQuote>
      ))}
    </div>
  );
}

const RAW = /^raw\/[^/]+\/message\.eml$/;
// Each link has an id of its own (`e7-file-1`) so a running report's poll, replacing the cards, gives focus back to it.
function Files(props: { owner: string; keys: string[]; file: FileLink; name?: string | null }) {
  if (props.keys.length === 0) return null;
  return (
    <div class="flex flex-col gap-4">
      {props.keys.map((key, i) => (
        <>
          <a id={`${props.owner.toLowerCase()}-file-${i + 1}`} href={props.file(key)} class={LINK} rel="nofollow">
            {RAW.test(key) ? "Download the original message" : `Download ${props.name ?? "the file"}`}
          </a>
          {RAW.test(key) &&
            [
              ["message", "View the original message"],
              ["headers", "View complete headers"],
            ].map(([part, words]) => (
              // Without the app script these are the download itself; with it they open the preview (D07 T03 §19).
              <a data-original-view={part} href={props.file(key)} class={LINK} rel="nofollow">
                {words}
              </a>
            ))}
        </>
      ))}
    </div>
  );
}

type Drawn = { title: string; body: unknown; level?: Severity };
type Renderer = (item: CardItem, file: FileLink) => Drawn;

const PATH_WORDS: Record<string, string> = {
  rfc822: "Forwarded as an attached message",
  eml: "Forwarded as an attached .eml file",
  msg: "Forwarded as an attached Outlook .msg file",
  inline: "Forwarded inline, so the original's headers were not available",
};
const intake: Renderer = (item, file) => {
  const d = item.detail;
  if (item.check === "intake.upload")
    return {
      title: "The uploaded file",
      body: (
        <>
          <Facts
            rows={[
              ["Kind", text(d.kind)],
              ["Type", text(d.mediaType)],
              ["Size", count(d.bytes) === null ? null : plural(count(d.bytes) as number, "byte")],
            ]}
          />
          <Files owner={item.id} keys={item.artefacts} file={file} name="the uploaded file" />
        </>
      ),
    };
  if (item.check === "intake.truncated") {
    const parts = records(d.parts);
    return {
      title: "Parts cut for reading",
      body: (
        <>
          <Bullets
            items={parts.map((p) => {
              const kept = count(p.keptBytes);
              const full = count(p.fullBytes);
              return `${text(p.mediaType) ?? "A part"}: ${kept ?? "?"} of ${full ?? "?"} bytes read`;
            })}
            more={count(d.omitted) ?? 0}
          />
          <div class="flex flex-col gap-4">
            {parts.map((p, i) =>
              text(p.key) ? (
                <a
                  id={`${item.id.toLowerCase()}-part-${i + 1}`}
                  href={file(text(p.key) as string)}
                  class={LINK}
                  rel="nofollow"
                >
                  {`Download cut part ${i + 1} (${text(p.mediaType) ?? "a part"}), as received`}
                </a>
              ) : null,
            )}
          </div>
        </>
      ),
    };
  }
  const others = count(d.otherOriginals) ?? 0;
  return {
    title: "How the original arrived",
    body: (
      <Facts
        rows={[
          ["How", PATH_WORDS[text(d.path) ?? ""] ?? null],
          ["Other attached messages", others > 0 ? `${others} not checked` : null],
        ]}
      />
    ),
  };
};

const STATE_WORDS: Record<string, string> = {
  passed: "Passed",
  failed: "Failed",
  inconclusive: "Inconclusive",
  unavailable: "Not recorded",
};
const UNTRUSTED: Record<string, string> = {
  "no-headers": "the original's headers were not available",
  "unknown-receiver": "the receiving mail server is not one whose results we can trust",
  "no-boundary": "the receiver's own results could not be told apart from the sender's",
  // The organisation's own mail records could not be read this time (D02 T02 §6; D07 T03 §45): a passing lookup
  // failure on the reader's side, nothing about the sender, so it says exactly that.
  "chain-unverified":
    "your organisation's mail records could not be read this time, so your mail provider's results were not trusted. This is a passing lookup failure, not a sign about the sender, and a later email is looked up afresh",
  ambiguous: "more than one receiver's results were found",
  "none-in-zone": "the receiver recorded no results",
};
const auth: Renderer = (item, file) => {
  const d = item.detail;
  const results = records(d.results);
  if (item.check === "auth.results") {
    if (d.trusted !== true)
      return {
        title: "The receiving server's checks",
        body: <p class="text-14">{`Not used: ${UNTRUSTED[text(d.reason) ?? ""] ?? "the results were not used"}.`}</p>,
      };
    return {
      title: "The receiving server's checks",
      body: (
        <>
          <Facts rows={[["Receiver", text(d.authservId) ?? text(d.receiver)]]} />
          <Bullets items={results.map((r) => `${text(r.method) ?? "?"}: ${text(r.result) ?? "?"}`)} />
        </>
      ),
    };
  }
  if (item.check === "auth.alignment")
    return {
      title: "Does the sender's domain match its checks?",
      body: (
        <>
          <Facts rows={[["From domain", text(d.from)]]} />
          <Bullets
            items={records(d.aligned).map((a) => `${text(a.method) ?? "?"} aligned for ${text(a.identifier) ?? "?"}`)}
          />
          <Headers lines={d.headers} />
          <Files owner={item.id} keys={item.artefacts} file={file} />
        </>
      ),
    };
  if (item.check === "auth.arc")
    return {
      title: "Forwarding seal (ARC)",
      body: (
        <>
          <Facts
            rows={[
              ["Result", text(d.verdict)],
              ["Sealed by", text(d.sealer)],
              ["Seal", count(d.instance) === null ? null : `number ${count(d.instance)}`],
              ["Earlier results", d.context === "unavailable" ? "Not available" : null],
            ]}
          />
          <Bullets items={records(d.earlier).map((r) => `${text(r.method) ?? "?"}: ${text(r.result) ?? "?"}`)} />
          <Headers lines={d.headers} />
          <Files owner={item.id} keys={item.artefacts} file={file} />
        </>
      ),
    };
  const name = item.check === "auth.spf" ? "SPF" : item.check === "auth.dkim" ? "DKIM" : "DMARC";
  const policy = d.policy as { certain?: unknown; either?: unknown } | null | undefined;
  const policyWords =
    text(policy?.certain) ?? (texts(policy?.either).length === 2 ? texts(policy?.either).join(" or ") : null);
  return {
    title: `${name}: ${STATE_WORDS[text(d.state) ?? ""] ?? "Not recorded"}`,
    body: (
      <>
        <Facts
          rows={[
            ["From domain", text(d.from)],
            ["Policy", policyWords],
          ]}
        />
        <Bullets
          items={results.map((r) => [text(r.result), text(r.identifier), text(r.comment)].filter(Boolean).join(" · "))}
        />
        <Headers lines={d.headers} />
        <Files owner={item.id} keys={item.artefacts} file={file} />
      </>
    ),
  };
};

const sender: Renderer = (item, file) => {
  const d = item.detail;
  const tail = (
    <>
      <Headers lines={d.headers} />
      <Files owner={item.id} keys={item.artefacts} file={file} />
    </>
  );
  if (item.check === "sender.display_address")
    return {
      title: "The name shows a different address",
      body: (
        <>
          <Facts
            rows={[
              ["Shown in the name", text(d.shown)],
              ["Really sent from", text(d.from)],
            ]}
          />
          {tail}
        </>
      ),
    };
  if (item.check === "sender.display_brand")
    return {
      title: "The name claims a brand",
      body: (
        <>
          <Facts
            rows={[
              ["Brand claimed", text(d.brand)],
              ["Really sent from", text(d.from)],
            ]}
          />
          {tail}
        </>
      ),
    };
  if (item.check === "sender.reply_to")
    return {
      title: "Replies go somewhere else",
      body: (
        <>
          <Facts
            rows={[
              ["Sender's domain", text(d.from)],
              ["Replies go to", texts(d.destinations).join(", ")],
              ["Outside the sender's domain", texts(d.elsewhere).join(", ")],
            ]}
          />
          {tail}
        </>
      ),
    };
  if (item.check === "sender.return_path")
    return {
      title: "Bounces go somewhere else",
      body: (
        <>
          <Facts
            rows={[
              ["Sender's domain", text(d.from)],
              ["Bounces go to", text(d.path)],
              ["Its domain", text(d.site)],
            ]}
          />
          {tail}
        </>
      ),
    };
  return {
    title: "First message from this sender",
    body: (
      <>
        <Facts rows={[["Sender", text(d.from)]]} />
        {tail}
      </>
    ),
  };
};

const TECHNIQUE: Record<string, string> = {
  skeleton: "letters swapped for look-alike characters",
  "different-tld": "the same name under a different ending",
  "added-word": "a word added to the name",
  edit: "a letter or two changed",
};
const TARGET: Record<string, string> = {
  own: "your own domain",
  supplier: "a supplier's domain",
  brand: "a brand's domain",
};
const UNCHECKED: Record<string, string> = {
  "no-service": "no registry answers for its ending",
  unavailable: "the registry did not answer",
  malformed: "the registry's answer could not be read",
  "no-date": "the registry has no registration date",
};
const day = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  day: "numeric",
  month: "long",
  year: "numeric",
});
// What speaks for a sender from each counter-signal provider, in plain words (D02 T06 §4's stored provider names).
const COUNTER_WORDS: Record<string, string> = {
  "majestic-million": "The domain is on a list of well-known domains.",
  "domain-age": "The domain is not newly registered.",
  "dmarc-aligned": "Its DMARC record aligns with the sending domain.",
  "trust-network": "A registered business in the trust network stands behind this domain.",
};
// What kind of thing was listed, in plain words.
const LISTED_KIND: Record<string, string> = {
  url: "A page address",
  domain: "The domain",
  ip: "An IP address",
  address: "An address",
};
// The provider's review or delisting address, as a link only when it is a web address; a stored value that is not
// one is drawn as text, never followed and never markup.
function ReviewLink(props: { url: unknown }) {
  const url = text(props.url);
  if (!url) return null;
  let web = false;
  try {
    const parsed = new URL(url);
    web = parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    web = false;
  }
  return web ? (
    <a href={url} class={LINK} rel="nofollow">
      Request a review
    </a>
  ) : (
    <p class="text-14 wrap-anywhere">{url}</p>
  );
}
// Reputation cards (D07 T03 §12; spec 4.3a): a listing names its provider and what was listed, and offers the
// provider's review; a listing alone never decides anything, and what was not checked is never "not listed".
const reputation: Renderer = (item, file) => {
  const d = item.detail;
  const files = <Files owner={item.id} keys={item.artefacts} file={file} />;
  if (item.check === "reputation.counter_signal") {
    // An overflow item groups the domains it speaks for (the producer's `entries`), with the rest counted.
    const domains = records(d.entries)
      .map((entry) => text(entry.domain))
      .filter((x): x is string => x !== null);
    return {
      title: "What speaks for this sender",
      body: (
        <>
          <p class="text-14">{COUNTER_WORDS[text(d.provider) ?? ""] ?? "Another check speaks for this sender."}</p>
          {domains.length > 0 ? (
            <>
              <Bullets items={domains} />
              {Math.max(0, (count(d.more) ?? 0) - domains.length) > 0 && (
                <p class="text-14 text-muted">{`and ${Math.max(0, (count(d.more) ?? 0) - domains.length)} more`}</p>
              )}
            </>
          ) : (
            <Facts rows={[["Domain", text(d.domain)]]} />
          )}
          {files}
        </>
      ),
    };
  }
  if (item.check === "reputation.coverage")
    return {
      title: "Reputation not checked",
      body: (
        <>
          <Bullets items={texts(d.gaps)} />
          {files}
        </>
      ),
    };
  const entries = records(d.entries);
  if (entries.length > 0)
    return {
      title: "Listed by reputation providers",
      body: (
        <>
          {entries.map((entry) => (
            <div class="flex flex-col gap-4">
              <Facts
                rows={[
                  ["Provider", text(entry.provider)],
                  ["Listed", text(entry.listed)],
                ]}
              />
              <ReviewLink url={entry.delist_url} />
            </div>
          ))}
          {Math.max(0, (count(d.more) ?? 0) - entries.length) > 0 && (
            <p class="text-14 text-muted">{`and ${Math.max(0, (count(d.more) ?? 0) - entries.length)} more`}</p>
          )}
          {files}
        </>
      ),
    };
  const listedAt = text(d.listed_at);
  return {
    title: "Listed by a reputation provider",
    body: (
      <>
        <Facts
          rows={[
            ["Provider", text(d.provider)],
            ["Listed", text(d.listed)],
            ["What was listed", LISTED_KIND[text(d.granularity) ?? ""] ?? null],
            ["Listed on", listedAt && !Number.isNaN(Date.parse(listedAt)) ? day.format(new Date(listedAt)) : null],
            [
              "Corroborated",
              // The producer's word means other evidence agrees (an authentication failure, a lookalike, a
              // credential form), never that another provider lists it (D02 T06 §4).
              d.corroborated === true
                ? "Other evidence agrees with this listing"
                : d.corroborated === false
                  ? "No other evidence agrees with it yet"
                  : null,
            ],
          ]}
        />
        <ReviewLink url={d.delist_url} />
        {files}
      </>
    ),
  };
};

const domain: Renderer = (item, file) => {
  const d = item.detail;
  const files = <Files owner={item.id} keys={item.artefacts} file={file} />;
  if (item.check === "domain.age") {
    if (d.checked === false)
      return {
        title: "Domain age not checked",
        body: (
          <>
            <Bullets
              items={records(d.unchecked).map(
                (u) => `${text(u.domain) ?? "?"}: ${UNCHECKED[text(u.reason) ?? ""] ?? "not checked"}`,
              )}
              more={Math.max(0, (count(d.uncheckedCount) ?? 0) - records(d.unchecked).length)}
            />
            <Bullets
              items={texts(d.unread).map((u) => `${u}: could not be read`)}
              more={Math.max(0, (count(d.unreadCount) ?? 0) - texts(d.unread).length)}
            />
            {files}
          </>
        ),
      };
    const registered = text(d.registered);
    const days = count(d.days);
    return {
      title: "When the domain was registered",
      body: (
        <>
          <Facts
            rows={[
              ["Domain", text(d.domain)],
              [
                "Registered",
                registered && !Number.isNaN(Date.parse(registered)) ? day.format(new Date(registered)) : null,
              ],
              ["Age", days === null ? null : plural(days, "day")],
              ["Registry", text(d.server)],
            ]}
          />
          {files}
        </>
      ),
    };
  }
  if (count(d.more) !== null)
    return {
      title: "More lookalike domains",
      body: (
        <>
          <Bullets items={texts(d.domains)} />
          {files}
        </>
      ),
    };
  if (d.compared === false) {
    const targets = texts(d.targets);
    return {
      title: "Domains not compared",
      body: (
        <>
          {text(d.domain) && <Facts rows={[["Domain", text(d.domain)]]} />}
          <Bullets items={targets.map((t) => `${t}: cannot be compared`)} />
          <Bullets
            items={texts(d.unlisted)}
            more={Math.max(0, (count(d.unlistedCount) ?? 0) - texts(d.unlisted).length)}
          />
          <Bullets
            items={texts(d.unread).map((u) => `${u}: could not be read`)}
            more={Math.max(0, (count(d.unreadCount) ?? 0) - texts(d.unread).length)}
          />
          {files}
        </>
      ),
    };
  }
  return {
    title: "A lookalike domain",
    body: (
      <>
        <Facts
          rows={[
            ["This message uses", text(d.domain)],
            ["It looks like", text(d.target)],
            [
              "Which is",
              TARGET[text(d.targetKind) ?? ""]
                ? `${TARGET[text(d.targetKind) as string]}${text(d.brand) ? ` (${text(d.brand)})` : ""}`
                : null,
            ],
            ["How", TECHNIQUE[text(d.technique) ?? ""] ?? null],
            ["Seen in", texts(d.fields).join(", ")],
          ]}
        />
        <Headers lines={d.headers} />
        {files}
      </>
    ),
  };
};

const HTML_FEATURES: [string, string][] = [
  ["passwordField", "asks for a password"],
  ["cardField", "asks for card details"],
  ["longBase64", "carries a long encoded blob"],
  ["builds", "builds its page with script"],
  ["downloads", "starts a download"],
  ["smuggling", "assembles a file inside the browser"],
];
const attachment: Renderer = (item, file) => {
  const d = item.detail;
  const name = text(d.filename);
  const files = <Files owner={item.id} keys={item.artefacts} file={file} name={name} />;
  if (d.checked === false && count(d.unread) !== null)
    return {
      title: "Attachments not checked",
      body: <p class="text-14">{`${plural(count(d.unread) as number, "further attachment")} could not be checked.`}</p>,
    };
  if (d.checked === false)
    return {
      title: "Attachment not fully checked",
      body: (
        <>
          <Facts
            rows={[
              ["File", name],
              ["Why", text(d.reason)],
              ["Archives inside", texts(d.nested).join(", ")],
            ]}
          />
          {files}
        </>
      ),
    };
  if (item.check === "attachment.type_mismatch")
    return {
      title: "The file is not what it says",
      body: (
        <>
          <Facts
            rows={[
              ["File", name],
              [
                "It claims to be",
                [text(d.extension) && `.${text(d.extension)}`, text(d.declared)].filter(Boolean).join(", "),
              ],
              ["Its contents are", text(d.sniffed)],
              ["Kind", text(d.family)],
            ]}
          />
          {files}
        </>
      ),
    };
  if (item.check === "attachment.html")
    return {
      title: d.kind === "svg" ? "An SVG attachment that acts like a web page" : "An HTML attachment",
      body: (
        <>
          <Facts rows={[["File", name]]} />
          <Bullets
            items={[
              ...HTML_FEATURES.filter(([k]) => d[k] === true).map(([, words]) => `It ${words}`),
              ...texts(d.formActions).map((url) => `Its form sends to ${url}`),
              ...(d.truncated === true ? ["Only its first 5 MB were read"] : []),
            ]}
          />
          {files}
        </>
      ),
    };
  const kind =
    item.check === "attachment.macro"
      ? "Macros"
      : item.check === "attachment.encrypted_archive"
        ? "An encrypted archive"
        : "A program";
  return {
    title: `${kind} in an attachment`,
    body: (
      <>
        <Facts rows={[["File", name]]} />
        <Bullets items={records(d.findings).map((f) => `${text(f.where) ?? "?"}: ${text(f.how) ?? "?"}`)} />
        {files}
      </>
    ),
  };
};

const HIDDEN: Record<string, string> = {
  "hidden-attribute": "marked hidden",
  "display:none": "not displayed",
  "visibility:hidden": "made invisible",
  "font-size": "set too small to read",
  opacity: "made transparent",
  "color-match": "coloured like its background",
  "off-screen": "placed off the screen",
  collapsed: "collapsed to nothing",
  comment: "inside a comment",
};
// Where text written to steer an AI was found (src/checks/ai-instructions.ts): the body's visible, hidden or plain
// text, or a named attachment.
const placeWords = (location: string | null) =>
  location === "visible"
    ? "In the message's visible text"
    : location === "hidden"
      ? "In text hidden from the reader"
      : location === "text"
        ? "In the message's plain-text version"
        : location === "body"
          ? "Part of the message body"
          : location === "subject"
            ? "In the subject"
            : location === "subject-hidden"
              ? "In text hidden in the subject"
              : location?.startsWith("attachment-hidden:")
                ? `In text hidden inside the attachment ${location.slice(18)}`
                : location?.startsWith("attachment:")
                  ? `In the attachment ${location.slice(11)}`
                  : null;
// Text in characters no font draws (D02 T05 §3; D07 T03 §24): a run of zero-width or other ignorable characters (low),
// or tag characters that spell text (medium, high when it reads as an instruction), with where it sits; then a count of
// runs not listed one by one. The producer stores the run's opening (the detail bounds clip a quote past 255 characters
// and end it with "…", src/checks/auth.ts `fittedDetail`), so a quote cut short is labelled as the opening, never
// implied to be the instruction itself; and where the instruction starts in the run with the text around it
// (`detail.instruction`, D02 T05 §6), drawn under the opening (D07 T03 §29).
function invisible(item: CardItem, files: Drawn["body"]): Drawn {
  const d = item.detail;
  const more = count(d.more);
  if (more !== null)
    return {
      title: "More invisible characters",
      body: (
        <>
          <p class="text-14">{`${plural(more, "more run")}, not listed one by one.`}</p>
          {files}
        </>
      ),
    };
  const quote = text(d.quote);
  const length = count(d.length);
  // Cut exactly when the producer clipped it: its clip ends the quote with "…", which decoded tag text (printable ASCII
  // only) can never hold. The run's `length` is no guide, since it counts nonprinting characters that decode to nothing.
  const cut = quote?.endsWith("…") ?? false;
  // Where the instruction sits in the run, when the producer found one (D02 T05 §6; D07 T03 §29): its own excerpt,
  // so a reader reads the instruction itself without decoding the original elsewhere.
  const instruction = runInstruction(d.instruction);
  return {
    title:
      item.severity === "high" || item.severity === "critical"
        ? "Hidden instruction in invisible characters"
        : "Invisible characters",
    body: (
      <>
        {quote && (
          <>
            {cut && <p class="text-13 text-muted">Opening of the hidden text</p>}
            <EvidenceQuote>{`"${quote}"`}</EvidenceQuote>
            {cut && <p class="text-13 text-muted">The rest is in the original message.</p>}
          </>
        )}
        {instruction && (
          <>
            <p class="text-13 text-muted">{`The instruction, from character ${instruction.offset}`}</p>
            <EvidenceQuote>{`"${instruction.text}"`}</EvidenceQuote>
          </>
        )}
        <Facts
          rows={[
            ["Length", length === null ? null : plural(length, "character")],
            ["Where", placeWords(text(d.location))],
          ]}
        />
        {files}
      </>
    ),
  };
}

const content: Renderer = (item, file) => {
  const d = item.detail;
  const files = <Files owner={item.id} keys={item.artefacts} file={file} />;
  if (item.check === "content.ai_instructions") {
    if (d.checked === false && count(d.more) !== null)
      return {
        title: "Texts not checked for AI instructions",
        body: <p class="text-14">{`${plural(count(d.more) as number, "further text")} could not be checked.`}</p>,
      };
    if (d.checked === false)
      return {
        title: "Not checked for AI instructions",
        body: (
          <>
            <Facts
              rows={[
                ["Where", placeWords(text(d.location))],
                ["Why", text(d.reason)],
              ]}
            />
            {files}
          </>
        ),
      };
    if (count(d.more) !== null)
      return {
        title: "More text written to steer an AI",
        body: <p class="text-14">{`${plural(count(d.more) as number, "more passage")}, not listed one by one.`}</p>,
      };
    const quote = text(d.quote);
    return {
      title: "Text written to steer an AI",
      body: (
        <>
          {quote && <EvidenceQuote>{`"${quote}"`}</EvidenceQuote>}
          <Facts rows={[["Where", placeWords(text(d.location))]]} />
          {files}
        </>
      ),
    };
  }
  if (d.reason === "invisible-characters") return invisible(item, files);
  if (d.complete === false)
    return {
      title: "Hidden text scan not complete",
      body: (
        <>
          <Bullets
            items={[
              ...(count(d.unresolvedRules)
                ? [`${plural(count(d.unresolvedRules) as number, "style rule")} could not be resolved`]
                : []),
              ...(count(d.unreadColours)
                ? [`${plural(count(d.unreadColours) as number, "colour")} could not be read`]
                : []),
              ...records(d.notScanned).map((p) =>
                p.why === "charset"
                  ? "A part in an unknown character set was not scanned"
                  : "A part could not be found to scan",
              ),
            ]}
          />
          {files}
        </>
      ),
    };
  if (count(d.more) !== null) {
    const by = (d.byReason && typeof d.byReason === "object" ? d.byReason : {}) as Record<string, unknown>;
    return {
      title: "More hidden text",
      body: (
        <>
          <Bullets
            items={Object.entries(by)
              .filter(([, n]) => typeof n === "number")
              .map(([reason, n]) => `${plural(n as number, "span")} ${HIDDEN[reason] ?? "hidden"}`)}
            more={count(d.omitted) ?? 0}
          />
          {files}
        </>
      ),
    };
  }
  const quote = text(d.quote);
  const length = count(d.length);
  return {
    title: d.preheader === true ? "Hidden preview text" : "Hidden text aimed at scanners",
    body: (
      <>
        {quote && <EvidenceQuote>{`"${quote}"${length !== null && length > quote.length ? "…" : ""}`}</EvidenceQuote>}
        <Facts
          rows={[
            ["Hidden by being", HIDDEN[text(d.reason) ?? ""] ?? null],
            ["Length", length === null ? null : plural(length, "character")],
          ]}
        />
        {files}
      </>
    ),
  };
};

const MISSING: Record<string, string> = {
  headers: "the original's headers were not available",
  text: "the original has no plain-text body",
  html: "the original has no HTML body",
};
const notChecked: Renderer = (item) => {
  const d = item.detail;
  const missing = text(d.missing);
  if (missing)
    return {
      title: "Checks that did not run",
      level: "not-checked",
      body: (
        <>
          <p class="text-14">{`They did not run because ${MISSING[missing] ?? "an input was missing"}.`}</p>
          <Bullets items={texts(d.checks).map(checkWords)} />
        </>
      ),
    };
  const error = text(d.errorClass);
  return {
    title: `${checkWords(d.check)}: not run`,
    level: "not-checked",
    body: (
      <p class="text-14">
        {error === "Timeout"
          ? "It ran out of time. The verdict rests on the checks that did run."
          : "It failed. The verdict rests on the checks that did run."}
      </p>
    ),
  };
};

// How a link was found, and where (D07 T03 §31; the producer's `kind` and `part`, D02 T07 §1).
const LINK_KINDS: Record<string, string> = {
  href: "A link",
  form: "A form's address",
  frame: "A frame inside the message",
  image: "An image's link",
  refresh: "A page refresh",
  text: "An address written in the text",
  pdf: "A link in a PDF",
};
// A stored file's name: the key keeps `<sha256>-<safe name>` (src/intake/store.ts `attachmentKey`), the name cleaned
// and shortened for storage. An attachment and a body part cut for its size (`body-<n>.html`, src/intake/parse.ts) are
// stored alike, so the card names the stored file and does not guess which it was.
const storedName = (key: string) => /\/attachments\/[0-9a-f]{64}-(.+)$/.exec(key)?.[1] ?? null;
// A screenshot the pipeline rendered (`art/<case>/render/<sha256>-<name>`, src/intake/store.ts `artefactKey`), by its name.
const renderedName = (key: string) => /\/render\/[0-9a-f]{64}-(.+)$/.exec(key)?.[1] ?? null;
const linkPlace = (part: string | null) => {
  if (!part) return null;
  if (part === "summary") return "In the message";
  const name = storedName(part);
  return name ? `In the stored file ${name}` : "In a part of the message";
};
// Why a part or file could not be read for links (the producer's `Unread.why`).
const UNREAD: Record<string, string> = {
  missing: "it was not stored",
  charset: "its character set is not one we read",
  encrypted: "it is encrypted",
  "too-large": "it is too large to read",
  "too-many": "it was past the number of parts read",
  damaged: "it is damaged, so it could not be read",
};

// A link whose words show one address and whose target is another (D07 T03 §31): what it shows, where it goes, the
// whole address, how and where it was found, and an attachment's download. An item that could not check every link
// says so at the not-checked level, never as a medium finding of its own.
// How a followed link ended, in a reader's words (D02 T07 §2; the producer's `outcome`).
const FOLLOWED: Record<string, string> = {
  done: "Followed to its end",
  timeout: "Stopped: the page did not answer in time",
  error: "Stopped: the page could not be followed",
  blocked: "Stopped: the address was refused by the safety rules",
};

// A link followed in a sandboxed browser (D02 T07 §2): the chain it took, hop by hop, and where it ended, or the site it
// ended at when that is not the one it named; an interrupted chain says "last seen", never "ends"; a stopped download and
// the requests the safety rules refused are shown with their reasons. The interim card; the richer redirect card is
// D07 T03 §13's.
const followed: Renderer = (item) => {
  const d = item.detail;
  const hops = records(d.hops).filter((h) => typeof h.url === "string");
  const start = text(d.link);
  const end = text(d.final);
  const confirmed = d.confirmed !== false;
  const changed = item.check === "link.final_domain_changed";
  const downloads = (Array.isArray(d.downloads) ? d.downloads : []).filter((x): x is string => typeof x === "string");
  const refused = records(d.refused).filter((r) => typeof r.url === "string" && typeof r.reason === "string");
  const host = (raw: string | null) => {
    try {
      return raw ? new URL(raw).hostname : null;
    } catch {
      return null;
    }
  };
  return {
    title: changed ? "A link that ends at a different site" : "Where a link goes after it is followed",
    body: (
      <>
        {start && (
          <p class="text-14 wrap-anywhere">
            {"The link to "}
            <strong>{host(start) ?? start}</strong>
            {end ? (
              <>
                {confirmed ? (changed ? " ends at a different site, " : " ends at ") : " was last seen at "}
                <strong>{host(end) ?? end}</strong>
                {confirmed ? "." : ", where it stopped."}
              </>
            ) : (
              " could not be followed to an end."
            )}
          </p>
        )}
        {!changed && hops.length > 0 && (
          <Bullets
            items={hops.map((h) =>
              `${count(h.status) ?? "?"} ${text(h.url) ?? ""}${h.via === "page" ? " (the page sent it on)" : ""}`.trim(),
            )}
          />
        )}
        {end && <EvidenceQuote>{end}</EvidenceQuote>}
        {!changed && downloads.length > 0 && <Bullets items={downloads.map((x) => `A download was stopped: ${x}`)} />}
        {!changed && refused.length > 0 && (
          <Bullets items={refused.slice(0, 5).map((r) => `Not followed: ${text(r.url)}, ${text(r.reason)}`)} />
        )}
        <Facts rows={[["How it ended", FOLLOWED[text(d.outcome) ?? ""] ?? null]]} />
      </>
    ),
  };
};

// A page a link reached that asks for a password or card details, or is nearly empty but for a button (D02 T07 §3): what it
// asks for, where what is typed would go, which frame held it, and the screenshot as a file.
const LANDING_TITLES: Record<string, string> = {
  "link.credential_form": "A page that asks for a password",
  "link.card_form": "A page that asks for card details",
  "link.lure_button": "A nearly empty page with a button to press",
};
const landing: Renderer = (item, file) => {
  const d = item.detail;
  const page = text(d.page);
  const sends = records(d.sends).filter((x) => typeof x.host === "string");
  const buttons = records(d.buttons).filter((x) => typeof x.text === "string");
  const shot = item.artefacts.find((key) => renderedName(key) !== null);
  return {
    title:
      item.check === "link.credential_form" && !count(d.passwordFields)
        ? "A page with a form set to send elsewhere"
        : (LANDING_TITLES[item.check] ?? item.check),
    body: (
      <>
        <p class="text-14 wrap-anywhere">{item.summary}</p>
        {page && <EvidenceQuote>{page}</EvidenceQuote>}
        <Facts
          rows={[
            ["Where", d.frame === true ? "In a frame of the page" : "On the page itself"],
            ["Password fields", count(d.passwordFields) ? String(count(d.passwordFields)) : null],
            ["Card fields", count(d.cardFields) ? String(count(d.cardFields)) : null],
            ["Set to send what is typed to", sends.length ? sends.map((x) => text(x.host)).join(", ") : null],
            ["Screenshot", !shot && text(d.shot) ? `Not kept: it ${text(d.shot)}` : null],
            [
              "Buttons",
              buttons.length
                ? buttons.map((x) => `${text(x.text)}${text(x.host) ? ` (${text(x.host)})` : ""}`).join("; ")
                : null,
            ],
          ]}
        />
        {shot && (
          <Shot
            id={item.id}
            url={file(shot)}
            alt={`The page the link reaches, ${placeOf(text(d.page)) ?? "an address"}`}
            caption="The page as the contained browser saw it"
          />
        )}
        <Files owner={item.id} keys={item.artefacts} file={file} name={shot ? (renderedName(shot) as string) : null} />
      </>
    ),
  };
};

// A screenshot drawn in its card (D07 T03 §13): the artefact route's inline mode (`?inline=1`, which keeps a link holder's
// signature parameters), in a figure with an alt text naming what it shows. The app script replaces an image that fails to
// load with a plain message and Try again (`img[data-evidence-image]`, src/web/client/app.ts); the file link stays under it.
const inlineUrl = (url: string) => `${url}${url.includes("?") ? "&" : "?"}inline=1`;
function Shot(props: { id: string; url: string; alt: string; caption: string }) {
  return (
    <EvidenceFigure
      caption={props.caption}
      open={{ href: inlineUrl(props.url), download: props.url, id: props.id.toUpperCase() }}
    >
      <img
        data-evidence-image
        src={inlineUrl(props.url)}
        alt={props.alt}
        loading="lazy"
        class="h-full w-full object-cover object-top"
      />
    </EvidenceFigure>
  );
}

// What a walk's submission and the page's answer to it are, in a reader's words (src/walkthrough/evidence.ts).
const SUBMISSION: Record<string, string> = {
  blocked: "The browser stopped it before it was sent",
  failed: "It could not be delivered",
  delivered: "It was delivered",
};
const ACCEPTANCE: Record<string, string> = {
  accepted: "The page took them and moved on",
  rejected: "The page refused them",
  unknown: "What the page did is not known",
};
const WALK_ENDED: Record<string, string> = {
  finished: "The walk finished",
  limit: "The walk stopped at its limit",
  refused: "The walk stopped when a request was refused",
  error: "The walk stopped on an error",
};
const placeOf = (raw: string | null) => {
  try {
    return raw ? new URL(raw).hostname : null;
  } catch {
    return null;
  }
};

// Why a walk did not run or did not finish, in plain words (D04 T02 §6: the stored reason is a class only).
const WALK_REASON: Record<string, string> = {
  budget: "Today's model limit was reached",
  limit: "The walk stopped at its limit",
  refused: "A request was refused",
  error: "It stopped on an error",
  invalid_case_id: "The case for the walk could not be found",
  no_case: "The case for the walk could not be found",
};
const walkClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
// A reused walk's provenance (D07 T09 §7): the finding is an earlier walk's, with its time, and this case made no
// new screenshot or submission. A stored time that does not parse is left out, never invented.
function Reused(props: { detail: Record<string, unknown> }) {
  const reused = records([props.detail.reused])[0];
  const at = reused ? text(reused.at) : null;
  if (!at || Number.isNaN(Date.parse(at))) return null;
  return (
    <p class="text-14 text-muted">{`From an earlier walk of the same page, on ${walkClock.format(new Date(at))} SAST. No new screenshot or submission was made for this case.`}</p>
  );
}

// The contained browser's walk (D04 T02 §5, written by `recordWalk`, not by a registered check): the pages it visited in
// order, where the test credentials would go and what became of them, and text it found hidden. Every address, name and
// quote is text; the credential values are never stored, so only the field names are drawn.
const walkthrough: Renderer = (item, file) => {
  const d = item.detail;
  if (item.check === "walkthrough.not_checked") {
    const incomplete = item.summary.includes("did not finish");
    return {
      title: incomplete ? "The walkthrough did not finish" : "The walkthrough could not run",
      body: (
        <>
          <Facts
            rows={[
              ["Why", WALK_REASON[text(d.reason) ?? ""] ?? "It could not be completed"],
              ["Page", text(d.url)],
            ]}
          />
        </>
      ),
    };
  }
  if (item.check === "walkthrough.chain") {
    const pages = records(d.pages).filter((p) => typeof p.url === "string");
    const omitted = records([d.omitted])[0] ?? {};
    const left = [count(omitted.targets), count(omitted.hidden), count(omitted.pages)].reduce<number>(
      (n, x) => n + (x ?? 0),
      0,
    );
    return {
      title: "Where the walk went",
      body: (
        <>
          <Reused detail={d} />
          <ol class="m-0 flex list-decimal flex-col gap-4 pl-20 text-14">
            {pages.map((p) => (
              <li class="wrap-anywhere">
                <strong>{placeOf(text(p.url)) ?? "An unknown address"}</strong>
                {p.withheld === true ? " (the page was withheld from the report)" : ""}
                <span class="block text-muted">{text(p.url)}</span>
              </li>
            ))}
          </ol>
          <Facts
            rows={[
              ["How it ended", WALK_ENDED[text(d.outcome) ?? ""] ?? null],
              ["Not listed one by one", left ? String(left) : null],
            ]}
          />
          <Files owner={item.id} keys={item.artefacts} file={file} name="a screenshot of the walk" />
        </>
      ),
    };
  }
  if (item.check === "walkthrough.credential_target") {
    const shot = item.artefacts[0];
    const fields = texts(d.fields);
    return {
      title: "Where the test credentials would go",
      body: (
        <>
          <Reused detail={d} />
          {text(d.url) && <EvidenceQuote>{text(d.url) as string}</EvidenceQuote>}
          <Facts
            rows={[
              ["Goes to", text(d.domain)],
              ["Method", text(d.method)],
              ["Fields sent", fields.length ? fields.join(", ") : null],
              ["What became of it", SUBMISSION[text(d.state) ?? ""] ?? null],
              ["What the page did", ACCEPTANCE[text(d.outcome) ?? ""] ?? null],
              [
                "Brand",
                text(d.brand)
                  ? `${text(d.brand)}: ${item.severity === "info" ? "this is its own site" : "this is not its own site"}`
                  : null,
              ],
            ]}
          />
          {shot ? (
            <Shot
              id={item.id}
              url={file(shot)}
              alt={`The page with the sign-in form that sends to ${text(d.domain) ?? "another address"}`}
              caption="The page with the form, as the contained browser captured it"
            />
          ) : (
            <p class="text-14 text-muted">The page with the form was not kept as a screenshot.</p>
          )}
          <Files owner={item.id} keys={shot ? [shot] : []} file={file} name="the screenshot of the page" />
        </>
      ),
    };
  }
  if (item.check === "walkthrough.canary_accepted")
    return {
      title: "The page took the test credentials",
      body: (
        <>
          <Reused detail={d} />
          {text(d.url) && <EvidenceQuote>{text(d.url) as string}</EvidenceQuote>}
          <Facts rows={[["Then it moved to", placeOf(text(d.nextPage))]]} />
          {item.artefacts.length > 0 && <p class="text-14 text-muted">Screenshots taken around this step:</p>}
          <Files owner={item.id} keys={item.artefacts} file={file} name="a screenshot taken around this step" />
        </>
      ),
    };
  const quote = text(d.quote);
  return {
    title: "Text hidden on a walked page",
    body: (
      <>
        <Reused detail={d} />
        {quote && <EvidenceQuote>{quote}</EvidenceQuote>}
        <Facts
          rows={[
            ["Hidden by", HIDDEN[text(d.reason) ?? ""] ?? null],
            ["On the page", text(d.page)],
          ]}
        />
        <Files owner={item.id} keys={item.artefacts} file={file} name="a screenshot of the page" />
      </>
    ),
  };
};

// What the voice note asks for, in a reader's words (src/checks/voice.ts, D01 T03 §4): the request kinds the model reads,
// from the strongest (a payment or bank change) down. An unknown kind is drawn as the model's own short phrase, as text.
const URGENCY: Record<string, string> = {
  high: "Strong pressure to act at once",
  medium: "Some pressure to act soon",
  low: "Mild pressure",
  none: "No pressure",
};
// The voice family: every quote is the speaker's own words (a verified substring of the transcript), every other field the
// model's reading of them, so each card says which is which. Nothing here is markup.
const voice: Renderer = (item) => {
  const d = item.detail;
  // An attachment claiming to be a recording (D07 T03 §16; D01 T03 §5's shape): its file, and what it carries.
  if (item.check === "voice.lure")
    return {
      title: "What the attachment claims to be",
      body: (
        <Facts
          rows={[
            ["File", text(d.filename)],
            ["A player in the message", d.player === true ? "Yes" : d.player === false ? "No" : null],
            ["A link in the message", d.linked === true ? "Yes" : d.linked === false ? "No" : null],
          ]}
        />
      ),
    };
  const quote = text(d.quote);
  const spoken = quote && (
    <>
      <p class="text-13 text-muted">The speaker said</p>
      <EvidenceQuote>{`"${quote}"`}</EvidenceQuote>
    </>
  );
  if (item.check === "voice.limits")
    return {
      title: "What this check cannot tell",
      body: (
        <>
          <p class="text-14">
            The quotes are the speaker&apos;s own words. What they mean is the model&apos;s reading.
          </p>
          <Facts
            rows={[
              ["Languages not read", texts(d.unsupportedLanguages).join(", ") || null],
              ["Cloned or synthetic voices", d.voiceCloneDetection === false ? "Not detected by this check" : null],
              ["Meaning", text(d.interpretation)],
            ]}
          />
        </>
      ),
    };
  if (item.check === "voice.claimed_identity")
    return {
      title: "Who the speaker says they are",
      body: (
        <>
          <Facts rows={[["Says they are", text(d.identity)]]} />
          {spoken}
        </>
      ),
    };
  if (item.check === "voice.urgency")
    return {
      title: "Pressure to act quickly",
      body: (
        <>
          <Facts rows={[["How much", URGENCY[text(d.urgency) ?? ""] ?? text(d.urgency)]]} />
          {spoken}
        </>
      ),
    };
  // voice.request: asked for something, only a payment sentence, or not checked at all.
  if (d.checked === false)
    return {
      title: "The voice note was not checked for a request",
      level: "not-checked",
      body: (
        <>
          <Facts rows={[["Why", text(d.why) ?? text(d.reason)]]} />
        </>
      ),
    };
  const paymentQuote = text(d.paymentQuote);
  return {
    title: text(d.request) ? "What the voice note asks for" : "A sentence about payment",
    body: (
      <>
        <Facts rows={[["Asks the listener to", text(d.request)]]} />
        {spoken}
        {paymentQuote && (
          <>
            <p class="text-13 text-muted">The speaker said about payment</p>
            <EvidenceQuote>{`"${paymentQuote}"`}</EvidenceQuote>
          </>
        )}
      </>
    ),
  };
};

const link: Renderer = (item, file) => {
  if (item.check in LANDING_TITLES) return landing(item, file);
  if (item.check === "link.redirects" || item.check === "link.final_domain_changed") return followed(item, file);
  const d = item.detail;
  if (d.checked === false) {
    const more = count(d.more);
    const unread = records(d.unread).filter((u) => typeof u.key === "string");
    // The unread files past the 20 the producer names (D07 T03 §32).
    const further = count(d.unreadMore);
    const unreadMore = further !== null && Number.isInteger(further) && further > 0 ? further : 0;
    return {
      title: "Links not fully checked",
      level: "not-checked",
      body: (
        <Bullets
          items={[
            ...(more ? [`${plural(more, "more link")} past the first 50 were not checked`] : []),
            ...unread.map(
              (u) =>
                `${storedName(u.key as string) ?? "The message"} was not read for links: ${UNREAD[text(u.why) ?? ""] ?? "it could not be read"}`,
            ),
            ...(unreadMore
              ? [
                  unreadMore === 1
                    ? "and 1 more file or part was not read for links"
                    : `and ${unreadMore} more files or parts were not read for links`,
                ]
              : []),
          ]}
        />
      ),
    };
  }
  const shown = text(d.shown);
  const target = text(d.target);
  const href = text(d.href);
  const stored = item.artefacts.find((key) => storedName(key) !== null);
  return {
    title: "A link that shows one address and goes to another",
    body: (
      <>
        {shown && target && (
          <p class="text-14 wrap-anywhere">
            {"The link shows "}
            <strong>{shown}</strong>
            {" but goes to "}
            <strong>{target}</strong>.
          </p>
        )}
        {href && <EvidenceQuote>{href}</EvidenceQuote>}
        <Facts
          rows={[
            ["Found as", LINK_KINDS[text(d.kind) ?? ""] ?? null],
            ["Where", linkPlace(text(d.part))],
          ]}
        />
        <Files
          owner={item.id}
          keys={item.artefacts}
          file={file}
          name={stored ? (storedName(stored) as string) : null}
        />
      </>
    ),
  };
};

// What a document's forensic finding is (D07 T03 §30; the producer, D06 T02 §1, `forensicsEvidence` in
// src/invoice/forensics.ts): each kind's own facts, the issuer when the file says it is from a bank, the sentence on
// what the finding cannot show (`limits`), and the PDF to download.
const UPDATES: Record<string, string> = {
  content: "what its pages show",
  signature: "a signature",
  other: "something else",
};
const yes = (v: unknown, words: string) => (v === true ? words : null);
const quoted = (v: unknown) => {
  const t = text(v);
  return t ? `"${t}"` : null;
};
const FORENSICS: Record<string, (d: Record<string, unknown>) => { title: string; rows: [string, string | null][] }> = {
  revisions: (d) => {
    const saves = count(d.revisions);
    const edits = count(d.edits);
    return {
      title: d.afterSignature === true ? "Changed after it was signed" : "Changed after it was first saved",
      rows: [
        ["Saved", saves === null ? null : saves > 1 ? `${plural(saves - 1, "time")} after it was first made` : "once"],
        ["Saves that changed its pages", edits === null ? null : String(edits)],
        ["After a signature", yes(d.afterSignature, "Yes, a save came after the file was signed")],
        [
          "What the later saves changed",
          texts(d.updates)
            .map((u) => UPDATES[u] ?? null)
            .filter(Boolean)
            .join(", ") || null,
        ],
        ["Its fast-view index", yes(d.linearizedLengthChanged, "No longer matches the file's length")],
      ],
    };
  },
  producer: (d) => ({
    title: "Made or saved with an editing program",
    rows: [
      ["Program", text(d.tool)],
      ["Producer it names", text(d.producer)],
      ["Creator it names", text(d.creator)],
      ["Producer in its XMP record", text(d.xmpProducer)],
      ["Creator in its XMP record", text(d.xmpCreator)],
    ],
  }),
  dates: (d) => ({
    title: "Dates that do not fit the payment",
    rows: [
      ["Created", text(d.created)],
      ["Modified", text(d.modified)],
      ["Payment date it states", text(d.paymentDate)],
      ["On the line", quoted(d.paymentLine)],
      ["Its two date records", yes(d.infoAndXmpDisagree, "Disagree with each other")],
    ],
  }),
  fonts: (d) => ({
    title: d.rule === "subset" ? "A line set from a second copy of its typeface" : "A line in a different typeface",
    rows: [
      ["Page", count(d.page) === null ? null : String(count(d.page))],
      ["Line", quoted(d.line)],
      ["Its typeface", text(d.font)],
      // A family finding compares the line with the other amounts; a subset one with the copy the rest of the text uses.
      [d.rule === "subset" ? "The copy the rest of its text uses" : "The other amounts' typeface", text(d.otherFont)],
      [
        "How it differs",
        d.rule === "family" ? "A different typeface" : d.rule === "subset" ? "The same typeface, embedded apart" : null,
      ],
    ],
  }),
  overlay: (d) => ({
    title: "An image placed over its text",
    rows: [
      ["Page", count(d.page) === null ? null : String(count(d.page))],
      ["Text it covers", quoted(d.covered)],
      ["Line", quoted(d.line)],
      ["On an amount or account line", yes(d.onAmountOrAccountLine, "Yes")],
    ],
  }),
};
const documentCard: Renderer = (item, file) => {
  const d = item.detail;
  const draw = item.check.startsWith("document.forensics.")
    ? FORENSICS[item.check.slice("document.forensics.".length)]
    : undefined;
  const filename = text(d.filename);
  const limits = text(d.limits);
  const found = draw ? draw(d) : { title: "A finding in the document", rows: [] };
  return {
    title: found.title,
    body: (
      <>
        <Facts rows={[["File", filename], ["Says it is from", d.issuer === "bank" ? "A bank" : null], ...found.rows]} />
        {limits && (
          <p class="type-small text-muted wrap-anywhere">
            <span class="weight-text-strong">What this cannot show: </span>
            {limits}
          </p>
        )}
        <Files owner={item.id} keys={item.artefacts} file={file} name={filename} />
      </>
    ),
  };
};

const RENDERERS: Record<Family, Renderer> = {
  intake,
  auth,
  sender,
  domain,
  attachment,
  content,
  link,
  walkthrough,
  voice,
  document: documentCard,
  reputation,
  not_checked: notChecked,
};

export function Card(props: { item: CardItem; file: FileLink }) {
  const { item, file } = props;
  const family = familyOf(item.check);
  const drawn = family ? RENDERERS[family](item, file) : null;
  return (
    <EvidenceCard
      id={item.id}
      level={drawn?.level ?? item.severity}
      title={drawn?.title ?? item.summary}
      layout="compact"
    >
      {drawn ? <p class="text-14 text-muted wrap-anywhere">{item.summary}</p> : null}
      {drawn?.body as never}
    </EvidenceCard>
  );
}

// The order cards are drawn in: those the reasons cite, in the order they cite them, then the rest by severity and id.
const RANK: Record<CardItem["severity"], number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
export function cardOrder(items: readonly CardItem[], cited: readonly string[]) {
  const seen = new Set<string>();
  const first = cited.filter((id) => !seen.has(id) && seen.add(id) && items.some((item) => item.id === id));
  const byId = new Map(items.map((item) => [item.id, item]));
  const rest = items
    .filter((item) => !seen.has(item.id))
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  return { cited: first.map((id) => byId.get(id) as CardItem), rest };
}

// The evidence section: the cited cards, then the rest inside a disclosure a phone shows closed ("6 more findings",
// `Report-Mobile`) and a wider screen open. It is open in the page as sent, so it reads whole without the app script,
// which closes it below `md` and opens it when a link points inside.
// Cards sit two to a row from `md` (`Main`), three from `lg` on a safe report (`Report-Safe`), one on a phone.
// `heading` and `intro` name the section (a running report's "Found so far", `Report-Running`); `empty` is what an
// empty one says.
// The disclosure's summary, by the count line's rule (D07 T03 §18): a "Not checked" card is no finding, so it is named
// apart ("5 more findings · 1 not checked"), and the two totals on the page agree.
function moreWords(rest: readonly CardItem[]): string {
  const unchecked = rest.filter((item) => item.check === "not_checked").length;
  const found = rest.length - unchecked;
  return [found ? plural(found, "more finding") : "", unchecked ? `${unchecked} not checked` : ""]
    .filter(Boolean)
    .join(" · ");
}

// What a check did, in plain words, and a failed check's stored error class translated (D07 T09 §11), as the
// coverage notice words them (src/web/pages/report-live.tsx).
const OUTCOME_WORDS: Record<string, string> = {
  ran: "ran",
  partial: "read part of its input",
  skipped: "did not run",
  failed: "failed",
};
const FAILED_WORDS: Record<string, string> = {
  Timeout: "it ran out of time",
  EvidenceRefused: "its findings could not be stored",
};
function versionLine(o: {
  check: string;
  revision?: string;
  outcome?: "ran" | "partial" | "skipped" | "failed";
  reason?: string | null;
}): string {
  const head = `${CHECK_WORDS[o.check] ?? o.check}: ${o.revision ?? "version not recorded"}`;
  if (!o.outcome) return head;
  const words = OUTCOME_WORDS[o.outcome] ?? o.outcome;
  if (o.outcome === "ran") return `${head} · ${words}`;
  if (o.outcome === "failed") return `${head} · failed: ${FAILED_WORDS[o.reason ?? ""] ?? "it failed"}`;
  return `${head} · ${words}${o.reason ? `: ${o.reason}` : ""}`;
}

export function EvidenceCards(props: {
  items: readonly CardItem[];
  cited: readonly string[];
  file: FileLink;
  columns?: 1 | 2 | 3;
  heading?: string;
  intro?: string;
  empty?: string;
  // The run shown's check versions (D07 T03 §39), drawn as a disclosure on the count line; the terminal report
  // passes the stored outcomes, the running report passes none. Each line keeps its outcome and reason beside
  // the version (D07 T09 §11).
  versions?:
    | readonly {
        check: string;
        revision?: string;
        outcome?: "ran" | "partial" | "skipped" | "failed";
        reason?: string | null;
      }[]
    | null;
}) {
  const { cited, rest } = cardOrder(props.items, props.cited);
  const grid = cx("grid gap-16", props.columns !== 1 && "md:grid-cols-2", props.columns === 3 && "lg:grid-cols-3");
  const all = cited.length === 0;
  return (
    <section aria-labelledby="evidence-heading" class="flex flex-col gap-16">
      <h2 id="evidence-heading" class="type-h3">
        {props.heading ?? "Evidence"}
      </h2>
      {props.intro && <p class="type-small text-muted">{props.intro}</p>}
      {props.versions && props.versions.length > 0 && (
        <details>
          <summary class={cx("type-small text-muted cursor-pointer", FOCUS)}>Check versions</summary>
          <ul class="flex flex-col gap-4 mt-8 text-14">
            {props.versions.map((o) => (
              <li class="wrap-anywhere">{versionLine(o)}</li>
            ))}
          </ul>
        </details>
      )}
      {props.items.length === 0 ? (
        <p class="type-small text-muted">{props.empty ?? "No evidence was recorded."}</p>
      ) : (
        <>
          {(all ? rest : cited).length > 0 && (
            <div class={grid}>
              {(all ? rest : cited).map((item) => (
                <Card item={item} file={props.file} />
              ))}
            </div>
          )}
          {rest.length > 0 && !all && (
            <details open data-more-findings class="flex flex-col gap-16">
              <summary
                class={cx(
                  "md:hidden p-16 font-heading weight-heading bg-surface border border-line rounded-card-large cursor-pointer",
                  FOCUS,
                )}
              >
                {moreWords(rest)}
                <span class="block mt-8 text-14 text-muted weight-text wrap-anywhere">
                  {rest
                    .slice(0, 4)
                    .map((item) => item.id)
                    .join(", ") + (rest.length > 4 ? " and more" : "")}
                </span>
              </summary>
              <div class={grid}>
                {rest.map((item) => (
                  <Card item={item} file={props.file} />
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
