// The report's evidence cards (D07 T03 §3; design/SPEC.md M3, boards `Main`, `Report-Safe`, `Report-Partial`,
// `Report-Mobile`): every stored item as an `EvidenceCard`, drawn by its family's renderer from its check's own
// `detail` (src/checks/*.ts), with its files linked through the artefact route. Detail fields that come from the
// message (a domain, a quote, a file name) are drawn as text and never as markup. An item whose check has no renderer
// (a check renamed since it was stored) draws the plain card: its severity and summary.
import { cx, FOCUS } from "../attrs";
import { EvidenceCard, EvidenceQuote, type Severity } from "../Evidence";

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
export const FAMILIES = ["intake", "auth", "sender", "domain", "attachment", "content", "not_checked"] as const;
export type Family = (typeof FAMILIES)[number];
// Each check a renderer draws, by its exact name, with the plain words a reader sees for it. A registered check missing
// here fails test/web/evidence-cards; a stored name not here (a check retired since, even in a known family) draws the
// plain card, never a sibling's reading of its detail.
export const CHECK_WORDS: Record<string, string> = {
  "intake.forward": "How the message was forwarded",
  "intake.upload": "The uploaded file",
  "intake.truncated": "Reading very long message parts",
  "auth.results": "The receiving server's checks",
  "auth.spf": "The sending server check (SPF)",
  "auth.dkim": "The signature check (DKIM)",
  "auth.dmarc": "The domain policy check (DMARC)",
  "auth.alignment": "Whether the sender's domain matches its checks",
  "auth.arc": "The forwarding seal (ARC)",
  "sender.display_address": "A different address in the sender's name",
  "sender.display_brand": "A brand in the sender's name",
  "sender.reply_to": "Where replies go",
  "sender.return_path": "Where bounces go",
  "sender.first_time": "Whether this sender has written before",
  "domain.lookalike": "Lookalike domains",
  "domain.age": "How old the domain is",
  "attachment.type_mismatch": "Whether attachments are what they claim",
  "attachment.html": "Web pages sent as attachments",
  "attachment.executable": "Programs in attachments",
  "attachment.macro": "Macros in attachments",
  "attachment.encrypted_archive": "Encrypted archives",
  "content.hidden_text": "Hidden text",
  not_checked: "Checks that did not run",
};
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
function Files(props: { keys: string[]; file: FileLink; name?: string | null }) {
  if (props.keys.length === 0) return null;
  return (
    <div class="flex flex-col gap-4">
      {props.keys.map((key) => (
        <a href={props.file(key)} class={LINK} rel="nofollow">
          {RAW.test(key) ? "Download the original message" : `Download ${props.name ?? "the file"}`}
        </a>
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
          <Files keys={item.artefacts} file={file} name="the uploaded file" />
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
                <a href={file(text(p.key) as string)} class={LINK} rel="nofollow">
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
        body: (
          <p class="text-14">{`Not used: ${UNTRUSTED[text(d.reason) ?? ""] ?? "the results could not be read"}.`}</p>
        ),
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
          <Files keys={item.artefacts} file={file} />
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
          <Files keys={item.artefacts} file={file} />
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
        <Files keys={item.artefacts} file={file} />
      </>
    ),
  };
};

const sender: Renderer = (item, file) => {
  const d = item.detail;
  const tail = (
    <>
      <Headers lines={d.headers} />
      <Files keys={item.artefacts} file={file} />
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
const domain: Renderer = (item, file) => {
  const d = item.detail;
  const files = <Files keys={item.artefacts} file={file} />;
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
  const files = <Files keys={item.artefacts} file={file} name={name} />;
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
const content: Renderer = (item, file) => {
  const d = item.detail;
  const files = <Files keys={item.artefacts} file={file} />;
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

const RENDERERS: Record<Family, Renderer> = {
  intake,
  auth,
  sender,
  domain,
  attachment,
  content,
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
export function EvidenceCards(props: {
  items: readonly CardItem[];
  cited: readonly string[];
  file: FileLink;
  columns?: 2 | 3;
}) {
  const { cited, rest } = cardOrder(props.items, props.cited);
  const grid = cx("grid gap-16 md:grid-cols-2", props.columns === 3 && "lg:grid-cols-3");
  const all = cited.length === 0;
  return (
    <section aria-labelledby="evidence-heading" class="flex flex-col gap-16">
      <h2 id="evidence-heading" class="type-h3">
        Evidence
      </h2>
      {props.items.length === 0 ? null : (
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
                {`${plural(rest.length, "more finding")}`}
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
