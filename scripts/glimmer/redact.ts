// Redaction of sample mail before anything is rendered or stored (D03 T04 §7): the pilot client's people and numbers
// are replaced with fixed placeholders in the HTML itself, so the screenshot shows the placeholders too. Brand names
// and link host names stay, because they are what Loupe learns from.
//
// Names come from the recipient headers (To, Cc, Delivered-To: the client's people) and `samples/client-names.txt`,
// never from the sender: a phishing sender's display name is the brand it fakes. Every image is replaced by a blank
// box before the render (`stripImages`): a signature image or a personalised attachment can carry what no text rule
// sees, so no picture from a sample reaches a screenshot.

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { leadingBrand } from "./label-rules.ts";

export const PLACEHOLDER = {
  email: "[email]",
  name: "[name]",
  domain: "[domain]",
  phone: "[phone]",
  number: "[number]",
  address: "[address]",
} as const;

// Mailbox roles, not people: `accounts@`, `Accounts Payable`. Taking them for names would redact `accounts.google.com`
// and `Google Accounts` out of the very lures Loupe learns from.
const ROLE_WORDS = new Set(
  "accounts account payable receivable info admin administrator support sales billing noreply reply office reception finance hr enquiries enquiry contact hello team mail email service services help orders order invoices invoice accounting marketing helpdesk security notifications notification alerts news newsletter postmaster webmaster mailer daemon bookings booking careers jobs legal compliance procurement purchasing payroll credit debtors creditors operations dispatch logistics user users staff general".split(
    " ",
  ),
);

// Words a display name carries that name no one: articles, joining and other common English words, titles, company
// forms and surname particles (`van der Merwe` is redacted by `Merwe`; `van` alone is every delivery van). Taken for
// names, they would refuse almost every page. A name that is also a common word (`May`) is left to the surname with it.
// The words among them that name no one even when written capitalised (`The`, `Your`, `Ltd`, `Keep`): what a place
// span's leftover words are read past (`survivingEntities`). Titles, surname particles and the words that are also
// names (`May Long`, `Will Grant`, `Said`, `More`) are not among them (§19, round 2 finding 2). A name signed under a
// closing is never cut short by a word of either list (`signatureSpans`, §19 rounds 3 and 4).
const FUNCTION_WORDS = new Set(
  "the and for from with our your his her its of to at on in by an a or pty ltd inc llc plc cc sa co corp company group holdings all any are but can did does get got has had have how let new not now off one out own see she they this that than then them there these those too two was were what when where which who why yet you also back been both came come each even ever every here into just keep last like live look made make many most much must need next only open over part plus same seen send show some soon such sure take thank thanks very want well went work year com net org gov edu www http https html htm mail gmail googlemail outlook hotmail yahoo icloud za uk".split(
    " ",
  ),
);
const NOT_NAMES = new Set([
  ...FUNCTION_WORDS,
  ..."mr mrs ms miss dr prof sir madam van der den de du le la von da di dos das el al bin ibn may way will best free long more said tell".split(
    " ",
  ),
]);

// A recipient's name pieces: the display name's words (a capitalised two-letter name such as `Jo` included) and the
// address's local part split at dots, dashes and underscores (three letters or more), mailbox roles left out.
export function namePieces(display: string | undefined, address: string | undefined): string[] {
  const local = (address ?? "").split("@")[0] ?? "";
  // A display name that is itself an address or a domain names no one: its words are web words (`com`, `www`), and the
  // address's own rules cover it. A hyphenated name counts whole and by its parts (`Anne-Marie`, `Anne`, `Marie`).
  const named = /@|^\S+\.[a-z]{2,}$|https?:|www\./i.test((display ?? "").trim()) ? "" : (display ?? "");
  const words = named
    .split(/[\s,."'()]+/)
    .flatMap((word) => (word.includes("-") ? [word, ...word.split("-")] : [word]));
  const shown = words.filter((piece) => /^(\p{L}{3,}(-\p{L}+)*|\p{Lu}\p{Ll})$/u.test(piece));
  const parts = local.split(/[._\-+0-9]+/).filter((piece) => /^\p{L}{3,}$/u.test(piece));
  // The whole display name too, as a phrase: a name made of common words (`May Long`) is still the reader's name.
  const whole = named.trim().replace(/\s+/g, " ");
  const role = whole.split(" ").some((word) => ROLE_WORDS.has(word.toLowerCase()));
  const phrase = !role && /^\p{L}[\p{L}'-]*( \p{L}[\p{L}'-]*)+$/u.test(whole) ? [whole] : [];
  return [...phrase, ...shown, ...parts].filter(
    (piece) => !ROLE_WORDS.has(piece.toLowerCase()) && !NOT_NAMES.has(piece.toLowerCase()),
  );
}

export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// South African numbers (+27 or 0, then nine digits grouped by spaces, dashes, dots or slashes, the area code in brackets
// too) and other international numbers.
export const PHONE =
  /\(0\d{2}\)[\s./-]?\d{3}[\s./-]?\d{4}\b|(?:\+27|\b0)[\s./-]?\d{2}[\s./-]?\d{3}[\s./-]?\d{4}\b|\+\d{1,3}[\s./-]?\(?\d{1,4}\)?(?:[\s./-]?\d{2,4}){2,4}\b/g;
// Nine or more digits in a run (single spaces, non-breaking spaces, dots, slashes or dashes allowed between): South African account numbers (9 to 11
// digits), ID numbers (13) and card numbers (13 to 19). Eight stops short, so a date like 2026-10-31 stays.
export const LONG_NUMBER = /\b\d(?:[ \u00A0\u202F./-]?\d){8,}\b/g;
const DATA_URI = /data:[^"')\s>]+/g;
const URL = /\b(?:https?:\/\/|www\.)[^\s"'<>()]+/gi;
// Characters that hide inside a word without showing: a soft hyphen or a zero-width space splits `Tha­ndi` for a
// text rule while the render shows `Thandi`.
const INVISIBLE = /[­​-‍⁠﻿]/g;
const LETTER_ENTITIES: Record<string, string> = {
  aacute: "á",
  agrave: "à",
  acirc: "â",
  auml: "ä",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  euml: "ë",
  iacute: "í",
  iuml: "ï",
  oacute: "ó",
  ocirc: "ô",
  ouml: "ö",
  uacute: "ú",
  uuml: "ü",
  ccedil: "ç",
  ntilde: "ñ",
};

// Letters from other scripts that look like Latin ones, and full-width forms: a name written `Thаndi` with a Cyrillic
// `а` reads as Thandi on the screen and to an OCR engine, but no Latin rule matches it.
const LOOKALIKE: Record<string, string> = Object.fromEntries(
  [
    ...("аaеeоoрpсcуyхxіiјjѕsԁdһhӏlոnԛqԝwАAВBЕEЅSІIЈJКKМMНHОOРPСCТTХXУYΑAΒBΕEΖZΗHΙIΚKΜMΝNΟOΡPΤTΥYΧXοoαaρpνvτtιiκkυuχx".match(
      /../gu,
    ) ?? []),
  ].map((pair) => [...pair] as [string, string]),
);

// `text` with every look-alike letter and full-width form folded to its Latin or ASCII twin, one character for one
// character, so a match found in it is the same span of `text`.
export function skeleton(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const folded = LOOKALIKE[char] ?? (code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : char);
    // Only a fold that keeps the length (one UTF-16 unit for one) keeps spans aligned.
    out += folded.length === char.length ? folded : char;
  }
  return out;
}

// Every match of `rule` in the folded text replaced, in the original, by `placeholder`.
function replaceFolded(text: string, rule: RegExp, placeholder: string): string {
  const folded = skeleton(text);
  let out = "";
  let from = 0;
  for (const match of folded.matchAll(
    new RegExp(rule.source, rule.flags.includes("g") ? rule.flags : `${rule.flags}g`),
  )) {
    out += text.slice(from, match.index) + placeholder;
    from = (match.index ?? 0) + match[0].length;
  }
  return out + text.slice(from);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One rule for a list of terms, each a whole word (no letter or digit beside it), longest first; null for none.
function termRule(terms: Iterable<string>): RegExp | null {
  // Folded as the text it is matched against is (`replaceFolded`): a term written with a look-alike letter still matches.
  const unique = [...new Set([...terms].map((n) => skeleton(n.trim())).filter((n) => n.length >= 2))].sort(
    (a, b) => b.length - a.length,
  );
  return unique.length
    ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${unique.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`, "giu")
    : null;
}

// Every match of `rule` replaced by `placeholder` outside the URLs in `text`: a lure's link host stays.
function outsideUrls(text: string, rule: RegExp, placeholder: string): string {
  let out = "";
  let from = 0;
  for (const url of text.matchAll(URL)) {
    out += replaceFolded(text.slice(from, url.index), rule, placeholder) + url[0];
    from = (url.index ?? 0) + url[0].length;
  }
  return out + replaceFolded(text.slice(from), rule, placeholder);
}

// Character references written for what is plain text (`Th&#97;ndi`, `&eacute;`) read as the characters they render
// as, so a rule sees what the viewer sees. The markup's own (`&lt;`, `&amp;`, quotes) are kept.
export function decodeTextEntities(html: string): string {
  return html
    .replace(/&#(x[0-9a-f]+|\d+);?/gi, (whole, code: string) => {
      const point = code[0] === "x" || code[0] === "X" ? Number.parseInt(code.slice(1), 16) : Number(code);
      if (!Number.isFinite(point) || point < 0x20 || point > 0x10ffff) return whole;
      const char = String.fromCodePoint(point);
      return /[<>&"']/.test(char) ? whole : char;
    })
    .replace(/&([a-z]+);/gi, (whole, name: string) => {
      if (name.toLowerCase() === "nbsp") return "\u00A0";
      const lower = LETTER_ENTITIES[name.toLowerCase()];
      if (!lower) return whole;
      return name[0] === name[0]?.toUpperCase() ? lower.toUpperCase() : lower;
    })
    .replace(INVISIBLE, "");
}

const IMAGE_TAG = /<(?:img|image|object|embed|picture|source|video|audio|input\s[^>]*type\s*=\s*["']?image)\b[^>]*>/gi;

// CSS escapes read as what they stand for (`\\75rl` is `url`, `\\3a ` is `:`), in every style block and attribute, so
// the picture rules see the CSS the browser will read (CSS Syntax 3, section 4.3.7).
export function unescapeCss(html: string): string {
  const decode = (css: string) =>
    css.replace(/\\([0-9a-f]{1,6})[ \t\r\n\f]?|\\([^\r\n\f0-9a-f])/gi, (_m, hex: string, char: string) => {
      if (char !== undefined) return char;
      const point = Number.parseInt(hex, 16);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : "\uFFFD";
    });
  return html
    .replace(
      /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi,
      (_m, open: string, css: string, close: string) => open + decode(css) + close,
    )
    .replace(/(\sstyle\s*=\s*)("([^"]*)"|'([^']*)')/gi, (_m, name: string, _q: string, dq?: string, sq?: string) =>
      dq !== undefined ? `${name}"${decode(dq)}"` : `${name}'${decode(sq ?? "")}'`,
    )
    .replace(/(\sstyle\s*=\s*)([^\s"'>][^\s>]*)/gi, (_m, name: string, bare: string) => `${name}${decode(bare)}`);
}

// Every picture out of the HTML before it is rendered: an `<img>` becomes a grey box of its size (so the layout a lure
// draws stays), other embedded media go, and CSS images and `background` attributes are dropped.
export function stripImages(html: string): string {
  return (
    unescapeCss(html)
      // An imported stylesheet can carry pictures of its own: it goes, whatever form its address takes.
      .replace(/@import\b(?:"[^"]*"|'[^']*'|url\([^)]*\)|[^;"'])*;?/gi, "")
      // Vector artwork (a signature drawn as paths) goes whole, its own text with it.
      .replace(
        /<svg\b[\s\S]*?<\/svg\s*>/gi,
        '<span style="display:inline-block;width:120px;height:40px;background:#d0d0d0"></span>',
      )
      // CSS-generated text is drawn but never in the page's text, out of the post-render check's reach.
      .replace(/content\s*:\s*(?:"[^"]*"|'[^']*')/gi, "content:none")
      .replace(IMAGE_TAG, (tag) => {
        if (!/^<img\b/i.test(tag)) return "";
        const size = (name: string, fallback: number, most: number) => {
          const value = new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, "i").exec(tag)?.[1];
          return Math.min(most, Math.max(1, value ? Number(value) : fallback));
        };
        return `<span style="display:inline-block;width:${size("width", 120, 1280)}px;height:${size("height", 40, 600)}px;background:#d0d0d0;vertical-align:middle"></span>`;
      })
      .replace(/(?:-webkit-)?image-set\((?:[^()]|\([^()]*\))*\)/gi, "none")
      .replace(/url\(\s*(["']?)[^)]*\1\s*\)/gi, "none")
      .replace(/\s(?:background|poster|srcset)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      // A frame's own document (`srcdoc`) and a linked stylesheet can carry pictures of their own.
      .replace(/<(iframe|frame|frameset)\b[\s\S]*?<\/\1\s*>|<(?:iframe|frame|link)\b[^>]*>/gi, "")
      // Any embedded picture left anywhere (a quoted data URL in a style or an attribute).
      .replace(/data:image\/[^"')\s>]*/gi, "")
  );
}

// Whether any picture is left for a render to draw: checked before every render, so a rule `stripImages` missed is a
// refusal, never a stored screenshot.
export function hasImages(html: string): boolean {
  return /<(?:img|image|svg|object|embed|picture|source|video|audio|iframe|frame|link)\b|url\(\s*["']?\s*(?:data:|cid:|https?:)|image-set\(|data:image\/|content\s*:\s*["']|@import\b/i.test(
    unescapeCss(html),
  );
}

// Details the entity model reads past (D03 T04 §19, completion review gap 3), found by rule, with no model: street
// addresses, post boxes, postal codes beside a place, a name signed under a closing, and South African towns. The
// Latin benchmark showed spaCy leaving street lines (`7 Kloof Nek Road`), signed names and towns on accepted pages, and
// reading the render again with the same model cannot catch its own misses. `redact()` replaces each in the HTML, and
// `discoveredDetail()` refuses a render or fails the leak check that still shows one.
//
// A word of a street name, in any case (`Kloof`, `KLOOF`, `kloof`): an address typed small is still an address, so
// every keyword of the address rules below (street types, `Unit`, `PO Box`) is matched in any case too (§19, round 2
// finding 1). The rules themselves stay case-sensitive, so the tail after them can tell a suburb from a sentence.
const PLACE_WORD = "\\p{L}[\\p{L}'’.-]*";
// A capitalised word, a word written in capitals included (`KLOOF`), as a suburb or town after a comma is written.
const CAPITAL_WORD = "\\p{Lu}[\\p{L}'’.-]*";
// A space, a non-breaking space or a line break: an address block is often one line a part.
const GAP = "[\\s\\u00A0]+";
// Street type words, in English and Afrikaans.
const STREET_TYPES = anyCaseAlternatives(
  "Street St Road Rd Avenue Ave Lane Ln Close Drive Dr Crescent Cres Way Boulevard Blvd Place Pl Terrace Court Ct Circle Square Highway Hwy Rylaan Straat Weg Laan Singel Steeg".split(
    " ",
  ),
);
const CODE = "\\d{4}(?!\\p{N})";
// What follows a street line or a box: the suburb, the town and the code, each after a comma (`, Tamboerskloof, Cape
// Town, 8001`), the code also after the town (`, Durban 4001`). A part written small is taken only inside the block,
// with a code or another comma after it (`, bryanston, sandton, 2191`), so the words of a sentence that goes on after
// the address (`, and call us`) stay.
const ADDRESS_TAIL = `(?:,[\\s\\u00A0]*(?:${CAPITAL_WORD}(?:${GAP}${CAPITAL_WORD}){0,2}(?:${GAP}${CODE})?|${PLACE_WORD}(?:${GAP}${PLACE_WORD}){0,2}(?:${GAP}${CODE}|(?=[\\s\\u00A0]*,))|${CODE}))*`;
// A house number (`7`, `7A`, `7-9`), up to four words and a street type (`7 Kloof Nek Road`, `7 kloof nek road`), or
// one word ending in an Afrikaans street type (`12 Kerkstraat`, `12 kerkstraat`); a unit or flat before it is part of it.
export const STREET_ADDRESS = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:(?:${anyCaseAlternatives(["Unit", "Flat", "Suite", "Apartment", "Apt", "Shop"])})${GAP}[\\p{L}\\p{N}]{1,5},?${GAP})?\\d{1,5}(?:[-/]\\d{1,5})?[A-Za-z]?${GAP}(?:(?:${PLACE_WORD}${GAP}){1,4}(?:${STREET_TYPES})\\.?|(?:${PLACE_WORD}${GAP}){0,3}\\p{L}{2,}(?:${anyCaseAlternatives(["straat", "weg", "laan", "rylaan", "singel", "steeg"])}))(?![\\p{L}\\p{N}])${ADDRESS_TAIL}`,
  "gu",
);
// A post box, a private bag or a PostNet suite with its number (`PO Box 1234`, `P.O. Box 52`, `Posbus 7`, `Private Bag
// X9`), in any case (`po box 1234`), and what follows it.
export const PO_BOX = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:[Pp]\\.?[\\s\\u00A0]?[Oo]\\.?[\\s\\u00A0]?${anyCase("box")}|${anyCase("post")}(?:${anyCase("al")})?${GAP}${anyCase("box")}|${anyCaseAlternatives(["Posbus", "Private Bag", "Privaatsak", "PostNet Suite"])})${GAP}?[A-Za-z]?\\d{1,6}(?!\\p{N})${ADDRESS_TAIL}`,
  "gu",
);
// South African towns and cities a signature, a delivery note or a branch line names, with their former names. Words
// that are also everyday words or brands (George, Hope, Springs, Brits, Strand, Springbok, Bethlehem, Alexandra) are
// left to the entity pass. Matched in any case (`cape town`, `CAPE TOWN`).
const TOWNS = alternatives(
  "Johannesburg|Joburg|Jozi|Pretoria|Tshwane|Centurion|Sandton|Midrand|Randburg|Roodepoort|Soweto|Benoni|Boksburg|Germiston|Kempton Park|Alberton|Vereeniging|Vanderbijlpark|Krugersdorp|Edenvale|Tembisa|Mamelodi|Soshanguve|Cape Town|Bellville|Stellenbosch|Paarl|Somerset West|Durbanville|Worcester|Hermanus|Mossel Bay|Oudtshoorn|Knysna|Plettenberg Bay|Beaufort West|Saldanha|Vredenburg|Malmesbury|Swellendam|Khayelitsha|Mitchells Plain|Gugulethu|Durban|eThekwini|Pietermaritzburg|Umhlanga|Ballito|Richards Bay|Newcastle|Ladysmith|Empangeni|Port Shepstone|Margate|Pinetown|Amanzimtoti|Umlazi|Kokstad|Vryheid|Ulundi|Gqeberha|Port Elizabeth|East London|Mthatha|Umtata|Makhanda|Grahamstown|Komani|Queenstown|Kariega|Uitenhage|Jeffreys Bay|Bhisho|Bisho|Qonce|King William's Town|Bloemfontein|Mangaung|Welkom|Kroonstad|Sasolburg|Parys|Harrismith|Polokwane|Pietersburg|Tzaneen|Thohoyandou|Mokopane|Phalaborwa|Louis Trichardt|Makhado|Musina|Giyani|Lephalale|Bela-Bela|Modimolle|Mbombela|Nelspruit|Witbank|Emalahleni|eMalahleni|Middelburg|Secunda|Ermelo|Barberton|White River|Hazyview|Standerton|Mahikeng|Mafikeng|Rustenburg|Klerksdorp|Potchefstroom|Hartbeespoort|Kimberley|Upington|Kuruman|De Aar".split(
    "|",
  ),
);
export const TOWN = new RegExp(`(?<![\\p{L}\\p{N}])(?:${TOWNS})(?![\\p{L}\\p{N}])`, "giu");
// A postal code beside a town or a place already replaced (`Durban 4001`, `[address], 8001`): a four-digit number
// alone is a year or an amount as often as a code, so only its place makes it one.
export const POSTAL_CODE = new RegExp(
  `(?:(?<![\\p{L}\\p{N}])(?:${TOWNS})|${escapeRegExp(PLACEHOLDER.address)}),?[\\s\\u00A0]*\\d{4}(?!\\p{N})`,
  "giu",
);
// The phrases a letter is signed off with, matched in any case (`Kind regards`, `Kind Regards`, `KIND REGARDS`).
const CLOSINGS =
  "Kind regards|Kindest regards|Best regards|Warm regards|Warmest regards|Regards|Many thanks|Thank you|Thanks|Yours sincerely|Yours faithfully|Yours truly|Sincerely|Best wishes|Cheers|Respectfully|Vriendelike groete|Groete|Baie dankie|Ngiyabonga"
    .split("|")
    .map(anyCase)
    .join("|");
// The tags that end a line as a browser draws it (a paragraph, a break, a cell, a heading): `entityText` reads them as
// line breaks too.
const BLOCK_NAMES =
  "p|div|br|hr|li|ul|ol|dl|dt|dd|tr|td|th|table|thead|tbody|tfoot|caption|h[1-6]|section|article|aside|header|footer|nav|main|blockquote|pre|address|form|fieldset|legend|label|button|option|select|textarea|center";
// The end of a line: a line break or a tag that ends one.
const LINE_BREAK = new RegExp(`[\\r\\n]|<\\/?(?:${BLOCK_NAMES})\\b[^>]*>`, "i");
// A closing that signs a letter off (§19 round 4): a closing, then a comma or a dash with the signature on the rest of
// its line (`Regards, may west`), or a line break after it, a full stop or another mark between (`Thanks!\n\nSipho`,
// `Regards.</p><p>Anne`). A closing with more of its sentence after a space or a full stop on the same line (`Thank you
// for your order`, `Thank you. Click here`) signs nothing, so the line after it is no signature.
const SIGN_OFF = new RegExp(
  `(?<![\\p{L}])(?:${CLOSINGS})[ \\t\\u00A0]*(?:[,-]|[.!:;]?[ \\t\\u00A0]*(?=${LINE_BREAK.source}))`,
  "giu",
);
// What lies between a closing and the line signed under it: spaces, line breaks, tags, and a style or script block or a
// comment whole (none of it is drawn as a line of text).
const BEFORE_SIGNATURE = /^(?:[\s\u00A0]|&nbsp;|<(script|style)\b[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->|<[^<>]*>)*/i;
// Where a signature line divides into a signer and what it signs for: its first comma, a bar, or a dash with spaces
// around it (`May W. West, Standard Bank`, `May West | Customer Care`, `May West - Standard Bank`). A hyphen inside a
// name (`J.-P.`, `Anne-Marie`) divides nothing.
const SIGNATURE_PARTS = /,|[ \t\u00A0]*\|[ \t\u00A0]*|[ \t\u00A0]+[-\u2013\u2014][ \t\u00A0]+/;
// A business's words, for the phrases a business signs with (`Customer Care`, `Online Banking Team`), beside the
// mailbox roles (`ROLE_WORDS`). A line made of them alone signs for a business; one word that is not among them makes
// the line a person's, so a surname that is also one of them (`May West`, `June Bank`) is never taken for a business.
const ORGANISATION_WORDS = new Set(
  "bank banking customer customers care client clients department desk centre center division management board limited mutual insurance assurance life health medical financial finance online digital card cards fraud risk verification partners solutions technologies systems global international africa african south north east west national municipality revenue office".split(
    " ",
  ),
);
// The business words that name only where a business is (`North West`, `South African`): a line of them alone signs
// for no team.
const PLACE_ONLY_WORDS = new Set("south north east west africa african national international global".split(" "));

// `phrases` as one alternation, longest first, for a rule matched in any case (the `i` flag).
function alternatives(phrases: string[]): string {
  return [...new Set(phrases)]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
}

// `phrases` as one alternation, longest first, each matched in any case (`anyCase`).
function anyCaseAlternatives(phrases: string[]): string {
  return [...new Set(phrases)]
    .sort((a, b) => b.length - a.length)
    .map(anyCase)
    .join("|");
}

// `phrase` matched in any case inside a rule that stays case-sensitive (a `u` rule with the `i` flag lets `\p{Lu}`
// match small letters too): each letter a class of its two forms, each space any run of spaces.
function anyCase(phrase: string): string {
  return [...phrase]
    .map((c) =>
      c === " "
        ? "[\\s\\u00A0]+"
        : c.toLowerCase() === c.toUpperCase()
          ? escapeRegExp(c)
          : `[${c.toLowerCase()}${c.toUpperCase()}]`,
    )
    .join("");
}

// Whether one part of a signature line, taken whole, signs for a business (§19 round 3): a team or role phrase of the
// businesses' words and the mailbox roles (`Customer Care`, `Support`, `Billing Department`, `The Accounts Team`, `Your
// Online Banking Team`, in any case), a brand the labels know (`leadingBrand` in label-rules.ts: `Standard Bank`,
// `FNB`), a brand with such a phrase after it (`Standard Bank Customer Care`), or titles and placeholders with nothing
// else (`Mr`, `Mr [name]`, `[name]`). Anything else is a person's, whatever its words look like or mean.
function businessSignOff(found: string): boolean {
  const all = found.split(/[ \t\u00A0]+/);
  if (all.every((word) => word === PLACEHOLDER.name || TITLES.has(word.toLowerCase().replace(/\.$/, "")))) return true;
  const article = /^(?:the|your|our)[ \t\u00A0]+/i.exec(found)?.[0].length ?? 0;
  const brand = leadingBrand(found.slice(article));
  const rest = found.slice(article + brand).trim();
  const words = rest ? rest.split(/[ \t\u00A0]+/).map((word) => word.toLowerCase()) : [];
  const team =
    words.length > 0 &&
    words.every((word) => ROLE_WORDS.has(word) || ORGANISATION_WORDS.has(word)) &&
    words.some((word) => !PLACE_ONLY_WORDS.has(word));
  return team || (brand > 0 && !words.length);
}

// Whether a signature line's text (or the part of it after its signer), trimmed and its closing marks dropped, signs
// for a business in every part (`businessSignOff`): `Standard Bank`, `[name], Standard Bank`, `Customer Care |
// Standard Bank`.
function signsForBusiness(text: string): boolean {
  const whole = text.trim().replace(/[\s\u00A0.,!:;]+$/, "");
  return whole.length > 0 && whole.split(SIGNATURE_PARTS).every((part) => businessSignOff(part.trim()));
}

// Where `folded` (a text as `skeleton` folds it) signs a person under a closing, as spans to replace (§19 round 4).
// After a closing (`SIGN_OFF`), the first line of text is a person's as a whole, whatever its words look like
// (initials, small letters, capitals, digits, hyphens, apostrophes, accented letters: `May W. West`, `may west`, `J.-P.
// van der Merwe`), unless it signs for a business (`signsForBusiness`); no word of it is read for whether it is a name.
// A line that does not sign for a business but whose part after its first comma, bar or spaced dash does keeps that
// part (`May W. West, Standard Bank` is `[name], Standard Bank`). The signature reaches that first line only: a title,
// a phone, an address or a company on the lines under it is left to the phone, email, address and entity rules, so
// `Senior Manager` under a name stays. The rule leans to removal: a lure line after a closing goes too (`Kind
// regards,\nPlease verify your account today`).
function signatureSpans(folded: string): { index: number; length: number }[] {
  const found: { index: number; length: number }[] = [];
  for (const closing of folded.matchAll(SIGN_OFF)) {
    const after = (closing.index ?? 0) + closing[0].length;
    const index = after + (BEFORE_SIGNATURE.exec(folded.slice(after))?.[0].length ?? 0);
    const rest = folded.slice(index);
    const stop = rest.search(LINE_BREAK);
    const line = (stop < 0 ? rest : rest.slice(0, stop)).trimEnd();
    // The line's inline tags (`<b>May</b> West`) kept in place but read past, so a comma inside one divides nothing.
    const masked = line.replace(/<[^<>]*>/g, (tag) => "\0".repeat(tag.length));
    const shown = (part: string) => part.replace(/\0/g, "");
    if (!shown(masked).trim() || signsForBusiness(shown(masked))) continue;
    const split = SIGNATURE_PARTS.exec(masked);
    const signer = split ? masked.slice(0, split.index).trimEnd() : "";
    const tail = split ? masked.slice(split.index + split[0].length) : "";
    found.push({ index, length: shown(signer).trim() && signsForBusiness(shown(tail)) ? signer.length : line.length });
  }
  return found;
}

// `text` with every signature `signatureSpans` finds replaced by one `[name]`, the tags inside it kept so the markup
// stays whole; a span inside one already replaced adds nothing.
function replaceSignedNames(text: string): string {
  let out = "";
  let from = 0;
  for (const { index, length } of signatureSpans(skeleton(text))) {
    const end = index + length;
    if (end <= from) continue;
    const start = Math.max(index, from);
    const tags = (text.slice(start, end).match(/<[^<>]*>/g) ?? []).join("");
    out += text.slice(from, start) + (start === index ? PLACEHOLDER.name : "") + tags;
    from = end;
  }
  return out + text.slice(from);
}

// Which detail the rules above still find in a rendered text, by kind (never the detail), or null: what admission and
// the leak check refuse on beside the entity pass, with no model in the way. A signature line is found by the same
// line rule `redact()` replaces it by (`signatureSpans`), so a signature left unredacted refuses.
export function discoveredDetail(text: string): string | null {
  const seen = skeleton(text);
  for (const [kind, rule] of [
    ["a street address", STREET_ADDRESS],
    ["a post box", PO_BOX],
    ["a postal code", POSTAL_CODE],
    ["a town", TOWN],
  ] as const) {
    // The rule's own flags, the global one aside: an address rule matches in any case.
    if (new RegExp(rule.source, rule.flags.replace("g", "")).test(seen)) return kind;
  }
  return signatureSpans(seen).length ? "a signed name" : null;
}

// `text` with every address, client domain, name, phone and long number replaced. Names are left alone inside a URL
// (a lure's link host is what Loupe learns from); addresses and the client's domains are replaced everywhere.
// Embedded `data:` URIs are left as they are, since a digit run inside base64 is not a number.
// Places (the entity pass's address spans, §19) are replaced the same way, by their own placeholder, and so are the
// street addresses, post boxes, signed names, towns and postal codes the rules above find (§19, gap 3).
export function redact(
  text: string,
  names: Iterable<string>,
  domains: Iterable<string> = [],
  places: Iterable<string> = [],
): string {
  const nameRule = termRule(names);
  const placeRule = termRule(places);
  const owned = [...new Set([...domains].map((d) => d.trim().toLowerCase()).filter(Boolean))];
  const domainRule = owned.length
    ? new RegExp(`(?<![\\p{L}\\p{N}.-])(?:${owned.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}-])`, "giu")
    : null;
  const source = decodeTextEntities(text);
  const pieces: string[] = [];
  let last = 0;
  for (const match of source.matchAll(DATA_URI)) {
    pieces.push(clean(source.slice(last, match.index)), match[0]);
    last = (match.index ?? 0) + match[0].length;
  }
  pieces.push(clean(source.slice(last)));
  return pieces.join("");

  function clean(part: string): string {
    // Matched on the folded text, replaced in the original: look-alike letters hide nothing, and keep their own cue.
    let out = replaceFolded(part, EMAIL, PLACEHOLDER.email);
    if (domainRule) out = replaceFolded(out, domainRule, PLACEHOLDER.domain);
    // Street lines and boxes whole, before a name or a place inside one is replaced on its own; then signed names,
    // whatever part of them a list or the pass already took; then towns, and a code beside a place.
    out = replaceFolded(replaceFolded(out, STREET_ADDRESS, PLACEHOLDER.address), PO_BOX, PLACEHOLDER.address);
    out = replaceSignedNames(out);
    if (nameRule) out = outsideUrls(out, nameRule, PLACEHOLDER.name);
    if (placeRule) out = outsideUrls(out, placeRule, PLACEHOLDER.address);
    out = replaceFolded(outsideUrls(out, TOWN, PLACEHOLDER.address), POSTAL_CODE, PLACEHOLDER.address);
    return replaceFolded(replaceFolded(out, PHONE, PLACEHOLDER.phone), LONG_NUMBER, PLACEHOLDER.number);
  }
}

// The entity pass (D03 T04 §19): people and places a page names that no header or list gave, found by spaCy's English
// model in `entities.py`, a child process (JSON lines in on stdin and out on stdout) whose every answer is checked here
// against its schema before a span counts. Each person span becomes names (its own text and its `namePieces`) and
// each place span a place that `redact()` removes from the HTML like any other term. Any failure (a missing or changed
// model, a crash, a timeout, an answer too large or not to the schema, a text too long, or a letter in a script the
// model does not read) refuses the page with a diagnostic that names the failure and holds none of the page's content.
//
// The switch: on only if `docs/glimmer/redaction-benchmark.json` shows the pass raising recall on the Latin-script set
// without refusing more pages (§19's measurement; its `entityDecision` records the figures this follows).
export const ENTITY_PASS_ON = true;
export const ENTITY_MODEL = {
  name: "en_core_web_lg",
  // SHA-256 over the model package's files (`model_digest()` in `entities.py`): spaCy 3.8.18's en_core_web_lg 3.8.0,
  // installed from `requirements-entities.txt` and checked as docs/glimmer/importing.md section 5 says.
  sha256: "2c670c29386ea89708bf55e443eb92ab40c9bd05efa94f53703e4db3505c3011",
  language: "en",
} as const;
export const ENTITY_LIMITS = { text: 200_000, seconds: 60, outputBytes: 1024 * 1024 } as const;
// Everything about the pass that decides what it removes and which pages it refuses: the switch, the model and its
// digest, and the limits. `redactionKey()` (import-samples.ts) hashes all of it, so a change to any one remakes every
// sample page (§19, plan review finding 7).
export type EntityConfig = {
  on: boolean;
  model: { name: string; sha256: string; language: string };
  limits: { text: number; seconds: number; outputBytes: number };
};
export const ENTITY_CONFIG: EntityConfig = { on: ENTITY_PASS_ON, model: ENTITY_MODEL, limits: ENTITY_LIMITS };

export type EntitySpan = { start: number; end: number; label: "person" | "place" };
export type EntityPass = { find: (text: string) => Promise<EntitySpan[]>; close: () => void };

// The letters and marks the English model does not read, as `entities.py` reads them from the same table
// (`unread-scripts.json`, built by `unread-scripts.ts` from the Unicode Script property): one of them anywhere in a text
// refuses the page here too, so a pass that answered clean for it is never believed.
const UNREAD = (
  JSON.parse(readFileSync(join(import.meta.dirname, "unread-scripts.json"), "utf8")) as {
    ranges: [number, number, string][];
  }
).ranges;

// The script of the first letter or mark in `text` the model does not read, or null: any one, however short the word
// it is in (`王伟`, the vowel sign of `रवि`), since a name written in it would go unseen.
export function unreadScript(text: string): string | null {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    let [low, high] = [0, UNREAD.length - 1];
    while (low <= high) {
      const middle = (low + high) >> 1;
      const [first, last, script] = UNREAD[middle] as [number, number, string];
      if (code < first) high = middle - 1;
      else if (code > last) low = middle + 1;
      else return script;
    }
  }
  return null;
}

const BLOCK_TAG = new RegExp(`<\\/?(?:${BLOCK_NAMES})\\b[^>]*>`, "gi");

// What a page's HTML shows as text, for the entity pass: its text with block tags as line breaks and inline tags
// joined up (a name split by `<b>` reads whole), then the values a form field or a tooltip draws, one a line. Read as
// `redact()` reads it (`decodeTextEntities`), so a span's text is a term `redact()` finds in the HTML.
export function entityText(html: string): string {
  const source = decodeTextEntities(html);
  const values = [
    ...source.matchAll(/\s(?:value|placeholder|title|alt|aria-label)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi),
  ].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
  const body = source
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(BLOCK_TAG, "\n")
    .replace(/<[^>]*>/g, "");
  return [body, ...values]
    .join("\n")
    .replace(/&(lt|gt|quot|apos|#39|#34);/g, (_m, name: string) => MARKUP[name] ?? "")
    .replace(/&amp;/g, "&");
}
const MARKUP: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#34": '"' };

const PLACEHOLDERS = new RegExp(Object.values(PLACEHOLDER).map(escapeRegExp).join("|"), "g");

// Titles a person span may carry before a name: they name no one (`Mr [name]`).
const TITLES = new Set("mr mrs ms mx miss dr prof sir madam".split(" "));

// Whether what the model found as a person names someone: a word of two letters or more that is not a title, a mailbox
// role (`Accounts Team` signs for a business) or a common word written small (`the`). The model's own judgement
// otherwise stands, so a name that is also a common word (`Long`, `LI`, `May`) or that the header parser would not take
// (`O’Neil`) still names someone (§19, round 1 finding 1).
function namesSomeone(found: string): boolean {
  return (found.replace(PLACEHOLDERS, " ").match(/\p{L}[\p{L}\p{M}'’-]*/gu) ?? []).some((word) => {
    const lower = word.toLowerCase();
    if ((word.match(/\p{L}/gu) ?? []).length < 2 || TITLES.has(lower) || ROLE_WORDS.has(lower)) return false;
    return !(word === lower && NOT_NAMES.has(lower));
  });
}

// The terms a page's spans give `redact()`: a person span's own text, as the model found it (folded as every term is),
// with its name pieces (`namePieces`) beside it for a name the page writes in parts; and a place's whole text.
export function entityTerms(text: string, spans: EntitySpan[]): { names: string[]; places: string[] } {
  const names: string[] = [];
  const places: string[] = [];
  for (const span of spans) {
    const found = text.slice(span.start, span.end).trim();
    if (span.label === "person") {
      if (namesSomeone(found)) names.push(found);
      names.push(...namePieces(found, undefined));
    } else if (found.length >= 2) places.push(found);
  }
  return { names, places };
}

// The spans of `text` that still name someone or somewhere once the placeholders are taken out: a person span that
// still names someone (`[name] Grobbelaar`, `O’Neil`, `Long`, not `Mr [name]`), a place span with a word left. What
// admission and the leak check refuse on (§19, plan review finding 4).
export function survivingEntities(text: string, spans: EntitySpan[]): EntitySpan[] {
  return spans.filter((span) => {
    const rest = text.slice(span.start, span.end).replace(PLACEHOLDERS, " ");
    if (span.label === "person") return namesSomeone(rest);
    // A word left counts unless it names no place in any case (`the`, `The`) or is a common word written small: a
    // capitalised word that is also a common word (`Long`, `May`) may be the place (§19, round 2).
    return (rest.match(/\p{L}{2,}/gu) ?? []).some((word) => {
      const lower = word.toLowerCase();
      return !FUNCTION_WORDS.has(lower) && !(word === lower && NOT_NAMES.has(lower));
    });
  });
}

// `html` redacted by the lists, and, with the switch on, by what the entity pass finds in its text: a page the pass
// refuses is refused (the error says why). With the switch off the pass is never asked.
export async function redactWithEntities(
  html: string,
  names: Iterable<string>,
  domains: Iterable<string>,
  pass: EntityPass | null,
  on: boolean = ENTITY_PASS_ON,
): Promise<string> {
  if (!on) return redact(html, names, domains);
  if (!pass) throw new Error("refused: the entity pass is on but was not started");
  const text = entityText(html);
  const found = entityTerms(text, await pass.find(text));
  return redact(html, [...names, ...found.names], domains, found.places);
}

// The refusals `entities.py` may give for a page, word for word: anything else is not to the schema, so no reason it
// sends can carry the page's text into a diagnostic.
const PASS_REFUSAL =
  /^(?:a name in [a-z_]+ script would go unread|the text is over \d+ characters|a request must hold text|the request failed \([A-Za-z]+\))$/;

// `entities.py`'s refusal to start in an environment its requirements file does not describe, word for word.
const UNPINNED =
  /^the environment does not match (requirements-entities\.txt \([A-Za-z0-9._-]+ is (?:not installed|[A-Za-z0-9.+!_-]+), pinned [A-Za-z0-9.+!_-]+\))$/;

// UTF-16 offsets of each code point in `text` (Python counts code points), or null when the two counts agree.
function codePointOffsets(text: string): number[] | null {
  if (!/[\uD800-\uDFFF]/.test(text)) return null;
  const offsets: number[] = [];
  let at = 0;
  for (const char of text) {
    offsets.push(at);
    at += char.length;
  }
  offsets.push(at);
  return offsets;
}

// One answer read against its schema: `{"spans": [{"start", "end", "label"}]}` with whole-number offsets inside the
// text and a known label, or `{"refused": <a known reason>}`; anything else is malformed (null).
function readAnswer(line: string, text: string): EntitySpan[] | { refused: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1) return null;
  const answer = value as { spans?: unknown; refused?: unknown };
  if (typeof answer.refused === "string") return PASS_REFUSAL.test(answer.refused) ? { refused: answer.refused } : null;
  if (!Array.isArray(answer.spans)) return null;
  const offsets = codePointOffsets(text);
  const length = offsets ? offsets.length - 1 : text.length;
  const spans: EntitySpan[] = [];
  for (const span of answer.spans as unknown[]) {
    if (!span || typeof span !== "object" || Object.keys(span).length !== 3) return null;
    const { start, end, label } = span as Record<string, unknown>;
    if (!Number.isInteger(start) || !Number.isInteger(end) || (label !== "person" && label !== "place")) return null;
    const [from, to] = [start as number, end as number];
    if (from < 0 || from >= to || to > length) return null;
    spans.push({ start: offsets?.[from] ?? from, end: offsets?.[to] ?? to, label });
  }
  return spans;
}

// The entity pass as a child process, started on the first page and again after any failure that ended it; one page
// at a time. `python` and `script` stand in for the venv and `entities.py` in tests.
export function openEntityPass(
  options: {
    python?: string;
    script?: string;
    sha256?: string;
    seconds?: number;
    outputBytes?: number;
    text?: number;
  } = {},
): EntityPass {
  const python = options.python ?? join(homedir(), ".venvs", "presidio", "bin", "python");
  const script = options.script ?? join(import.meta.dirname, "entities.py");
  const sha256 = options.sha256 ?? ENTITY_MODEL.sha256;
  const seconds = options.seconds ?? ENTITY_LIMITS.seconds;
  const outputBytes = options.outputBytes ?? ENTITY_LIMITS.outputBytes;
  const most = options.text ?? ENTITY_LIMITS.text;
  const refuse = (why: string) => new Error(`refused: the entity ${why}`);
  type Session = { ask: (line?: string) => Promise<string>; end: (why: string) => void; close: () => void };
  let session: Session | null = null;
  let ready: Promise<void> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const start = (): Session => {
    const child: ChildProcess = spawn(python, ["-I", script, "--model-sha256", sha256], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let failure: string | null = null;
    let waiting: { resolve: (line: string) => void; reject: (error: Error) => void } | null = null;
    let held: Buffer[] = [];
    let heldBytes = 0;
    const self: Session = {
      // Waits for the next line, after writing `line` when one is given; the time limit runs from the write.
      ask: (line) =>
        new Promise<string>((resolve, reject) => {
          if (failure) return reject(refuse(failure));
          const timer = setTimeout(() => self.end(`pass took over ${seconds} seconds`), seconds * 1000);
          waiting = {
            resolve: (answer) => {
              clearTimeout(timer);
              resolve(answer);
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
          };
          if (line !== undefined) child.stdin?.write(`${line}\n`);
        }),
      // Ends the process for good, refusing whatever page waits on it; the next page starts a new one.
      end: (why) => {
        if (failure) return;
        failure = why;
        child.kill("SIGKILL");
        if (session === self) {
          session = null;
          ready = null;
        }
        const pending = waiting;
        waiting = null;
        pending?.reject(refuse(why));
      },
      close: () => {
        failure ??= "pass was closed";
        child.stdin?.end();
      },
    };
    child.stdin?.on("error", () => self.end("pass stopped reading"));
    child.on("error", (error: NodeJS.ErrnoException) => self.end(`pass could not start (${error.code ?? error.name})`));
    child.on("close", (code, signal) =>
      self.end(signal ? `pass crashed (signal ${signal})` : `pass crashed (exit code ${code})`),
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      let from = 0;
      for (let at = chunk.indexOf(10); at !== -1 && !failure; at = chunk.indexOf(10, from)) {
        if (heldBytes + at - from > outputBytes) return self.end(`pass answered over ${outputBytes} bytes`);
        const line = Buffer.concat([...held, chunk.subarray(from, at)]).toString("utf8");
        held = [];
        heldBytes = 0;
        from = at + 1;
        const pending = waiting;
        if (!pending) return self.end("pass answered what was not asked");
        waiting = null;
        pending.resolve(line);
      }
      if (failure) return;
      held.push(chunk.subarray(from));
      heldBytes += chunk.length - from;
      if (heldBytes > outputBytes) self.end(`pass answered over ${outputBytes} bytes`);
    });
    return self;
  };

  // The first line: ready, the pinned model, English; or the script's own refusal to start.
  const begin = async (current: Session) => {
    const line = await current.ask();
    let value: Record<string, unknown> | null = null;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {}
    const fail = (why: string) => {
      current.end(why);
      throw refuse(why);
    };
    if (value?.refused === "the model is not installed") fail("model is not installed");
    if (value?.refused === "the model is not the pinned one") fail("model is not the pinned one");
    // An installed package that is not the version `requirements-entities.txt` pins (`pins.py`): named, by package
    // and versions only, so the operator knows what to reinstall (§19, round 1 finding 2).
    const unpinned = typeof value?.refused === "string" ? UNPINNED.exec(value.refused) : null;
    if (unpinned) fail(`environment does not match ${unpinned[1]}`);
    if (
      !value ||
      Object.keys(value).length !== 4 ||
      value.ready !== true ||
      value.model !== ENTITY_MODEL.name ||
      value.language !== ENTITY_MODEL.language
    )
      fail("pass gave a malformed answer");
    if (value?.model_sha256 !== sha256) fail("model is not the pinned one");
  };

  const ask = async (page: string): Promise<EntitySpan[]> => {
    if (page.length > most) throw refuse(`pass takes at most ${most} characters, and the page's text is longer`);
    // Read as the screen shows it, as `redact()` matches: a look-alike letter folded to its Latin twin, one unit for
    // one, so a span of the folded text is the same span of the page's. What is left of another script refuses.
    const text = skeleton(page);
    const script = unreadScript(text);
    if (script) throw refuse(`model does not read ${script} script, and the page holds a name in it`);
    if (!session) {
      session = start();
      ready = begin(session);
    }
    const current = session;
    await ready;
    const answer = readAnswer(await current.ask(JSON.stringify({ text })), text);
    if (!answer) {
      current.end("pass gave a malformed answer");
      throw refuse("pass gave a malformed answer");
    }
    if ("refused" in answer) throw refuse(`pass refused the page (${answer.refused})`);
    return answer;
  };

  return {
    find: (text) => {
      const answer = queue.then(() => ask(text));
      queue = answer.catch(() => undefined);
      return answer;
    },
    close: () => {
      session?.close();
      session = null;
      ready = null;
    },
  };
}

// The pass a configuration describes: its pinned digest and its limits, so what runs is what `redactionKey()` hashed.
export function openConfiguredPass(config: EntityConfig = ENTITY_CONFIG): EntityPass {
  const { model, limits } = config;
  return openEntityPass({
    sha256: model.sha256,
    seconds: limits.seconds,
    outputBytes: limits.outputBytes,
    text: limits.text,
  });
}
