// The rule checks a generated body must pass before its message joins the synthetic set (D08 T01 §3). A label rests
// on what the model actually wrote, so an attack's body must carry the details its deception turns on, verbatim (the
// new account, the amount, the link, the phone number, the attachment), and a genuine mail must carry its ordinary
// facts and none of the deception markers. Every problem is named; an empty list passes.
import { ALL_PARTIES } from "./parties.ts";
import { realNames, realNamesIn } from "./real-names.ts";
import { registrableOf, type Spec } from "./scenarios.ts";

export const MIN_WORDS = 40;
export const MAX_WORDS = 400;

const PLACEHOLDERS = [/\[[^\]]*\]/, /\{\{/, /<insert/i, /\bTODO\b/, /lorem ipsum/i, /\bXXX+\b/];
// A model's refusal, not a writer in character: "I cannot process it myself" is a fraudster's line (bec-payment-007).
const MODEL_TALK = [
  /\bas an ai\b/i,
  /\blanguage model\b/i,
  /^\s*here is\b/i,
  /^\s*sure[,!]/i,
  /\bI (cannot|can't|won't) (help|assist|comply|create|write|provide|generate)\b/i,
];

// What a genuine mail never says: the tells of a payment fraud, a credential lure or a pressure call.
export const DECEPTION_MARKERS = [
  /\bnew (bank(ing)?|account) (details|number)\b/i,
  /\b(changed|updated|change|update) (to )?(our|the|its) bank(ing)? (details|account)\b/i,
  /\burgent(ly)?\b/i,
  /\bimmediately\b/i,
  /\bconfidential\b/i,
  /\b(within|in) (24|48) hours\b/i,
  /\bsuspend(ed|ion)?\b/i,
  /\bverify your (account|identity|details|password)\b/i,
  /\bgift cards?\b/i,
  /\bpenalt(y|ies)\b/i,
  /\bdo not (tell|discuss|share)\b/i,
];

// What an attack of each category must say for its label to rest on the body: the request its deception turns on, in
// its own words (a link's path, such as `/login`, does not count). A fluent body carrying the required details without
// it is refused.
export const ATTACK_CUES: Record<string, RegExp> = {
  "credential-phishing": /\b(sign[ -]?in|log[ -]?in|password|verify|confirm your|credentials)\b/i,
  "bec-payment": /\b(pay|payment|transfer|EFT|settle)\b/i,
  "invoice-bank-change": /\b(new|changed?|updated?|different)\b[^.]{0,60}\b(bank(ing)?|account)\b/i,
  impersonation: /\b(pay|fee|penalty|settle)\b/i,
  "voice-lure": /\b(call|phone|ring)\b/i,
  "malware-attachment": /\b(open|attached|attachment|download|enable)\b/i,
};

// A body that warns against itself (a security notice the model wrote instead of the attack) is no attack, whatever
// words of the request it carries. Only warnings about this message: a fraudster's "do not visit a branch" stays.
// These patterns filter; the proof that a body makes its request is the pinned reviewer's second reading of every
// message (D08 T01 §3), which a body the rules let through must still pass.
export const SELF_WARNINGS = [
  /\b(this|the|that) (e-?mail|message|link|request|address|site|website) (is|was|may be|looks) (a |an )?(fake|fraud(ulent)?|phishing|scam|suspicious|not (from|genuine))/i,
  /\b(phishing|scam(mer)?s?|security awareness|simulat(ed|ion))\b/i,
  /\b(do not|don.t|never) (click|follow|open|visit|use) (the|this|that|any) (link|attachment|address|url|site|website)\b/i,
  /\b(do not|don.t|never) (enter|type|give|send) (your |any )?(password|credentials|pin|login details)\b/i,
  /\byour account (remains|is still) (active|safe|secure)\b/i,
  /\bignore (the|this|that|any) (request|message|e-?mail|link)\b/i,
  /\bdelete (the|this|that) (message|e-?mail)\b/i,
  /\bno (action|payment) is (required|needed|due)\b/i,
  /\bunauthori[sz]ed (request|message|e-?mail)\b/i,
  /\bbringing this to our attention\b/i,
];

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const OWN_DOMAINS = new Set(ALL_PARTIES.map((p) => registrableOf(`x@${p.domain}`)));

export type Generated = { subject: string; body: string };

export function realismProblems(spec: Spec, generated: Generated, names = realNames()): string[] {
  const problems: string[] = [];
  const text = `${generated.subject}\n${generated.body}`;
  const real = realNamesIn(text, names);
  if (real.length) problems.push(`names a real organisation: ${real.join(", ")}`);
  const n = words(generated.body);
  if (n < MIN_WORDS || n > MAX_WORDS) problems.push(`the body is ${n} words, not ${MIN_WORDS} to ${MAX_WORDS}`);
  if (!generated.subject.trim()) problems.push("the subject is empty");
  if (!text.includes(spec.claimed)) problems.push(`does not name ${spec.claimed}`);
  if (PLACEHOLDERS.some((re) => re.test(text))) problems.push("carries a placeholder");
  if (MODEL_TALK.some((re) => re.test(generated.body))) problems.push("talks as a model");
  for (const [what, value] of Object.entries(spec.details))
    if (!generated.body.includes(value)) problems.push(`the body lacks its ${what} (${value})`);
  // Every address and link is fictional: under the reserved `.example` (RFC 2606), never an invented real-looking one.
  for (const [address] of text.matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g))
    if (!/\.example$/i.test(address)) problems.push(`names an address outside .example (${address})`);
  for (const [, host] of text.matchAll(/(?:https?:\/\/|www\.)([a-z0-9.-]+)/gi))
    if (!/\.example$/i.test(host ?? "")) problems.push(`links outside .example (${host})`);
  const cue = ATTACK_CUES[spec.category];
  if (spec.label === "attack" && cue && !cue.test(generated.body.replace(/https?:\/\/\S+/g, " ")))
    problems.push(`the body does not make its ${spec.category} request`);
  const warning = spec.label === "attack" ? SELF_WARNINGS.find((re) => re.test(text)) : undefined;
  if (warning) problems.push(`the body warns against itself (${warning.source.slice(0, 40)})`);
  if (spec.label === "genuine") {
    const marker = DECEPTION_MARKERS.find((re) => re.test(text));
    if (marker) problems.push(`genuine mail carries a deception marker (${marker.source})`);
    for (const [, host] of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi))
      if (!OWN_DOMAINS.has((host ?? "").toLowerCase().split(".").slice(-2).join(".")))
        problems.push(`genuine mail links off its parties' domains (${host})`);
  }
  return problems;
}
