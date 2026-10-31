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
const MODEL_TALK = [/\bas an ai\b/i, /\blanguage model\b/i, /^\s*here is\b/i, /^\s*sure[,!]/i, /\bI cannot\b/i];

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
  if (spec.label === "genuine") {
    const marker = DECEPTION_MARKERS.find((re) => re.test(text));
    if (marker) problems.push(`genuine mail carries a deception marker (${marker.source})`);
    for (const [, host] of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi))
      if (!OWN_DOMAINS.has((host ?? "").toLowerCase().split(".").slice(-2).join(".")))
        problems.push(`genuine mail links off its parties' domains (${host})`);
  }
  return problems;
}
