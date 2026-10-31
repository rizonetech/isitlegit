// The synthetic challenge set (D08 T01 §7): 30 pairs, each a subtle attack and the benign control that mirrors it, so a
// screener cannot score well by recognising the generator's style. A pair shares its claimed party, its recipient
// organisation, its topic and its risk cue (the same amount, invoice or deadline, carried verbatim by both messages) and
// differs only in its tell: the attack's tell is in `details.tell`, the control states the benign counterpart in
// `details.counter`. Both are sent from the same sender domain and pass authentication (the attack is the message a
// compromised or abused genuine mailbox sends), so no header separates a pair; most attacks are `basis: "model"`
// (D08 T01 §4) and a few carry a header or attachment tell the deterministic checks can see. Built from a
// fixed seed. Parties and the cue come from the pair's own seed and the tell or counter from the variant's, so a
// replacement for a message that failed its tries keeps its pair intact.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BANKS,
  BUSINESSES,
  COURIERS,
  FREEMAIL,
  lookalike,
  type Party,
  PROVIDERS,
  REVENUE,
  SUPPLIERS,
} from "./parties.ts";
import { challengeProblems } from "./realism.ts";
import {
  box,
  type Draft,
  digits,
  fee,
  finish,
  localOf,
  PASS,
  pick,
  rands,
  registrableOf,
  rng,
  type Spec,
} from "./scenarios.ts";
import type { Others, SetDef } from "./set-def.ts";

export const SET_NAME = "synthetic-challenge";
export const SOURCE =
  "IsItLegit synthetic challenge set, subtle attacks with matched benign controls, written by muse-spark-1.3 from code-built scenarios (D08 T01 §7)";
export const CHALLENGE_CAP_USD = 1;
export const PER_CATEGORY = 5;
export const ATTACK_CATEGORIES = [
  "credential-phishing",
  "bec-payment",
  "invoice-bank-change",
  "impersonation",
  "voice-lure",
  "malware-attachment",
] as const;
export type AttackCategory = (typeof ATTACK_CATEGORIES)[number];

export type Pair = {
  index: number;
  category: AttackCategory;
  attack: string;
  control: string;
};

const pad = (n: number) => String(n).padStart(3, "0");
export const PAIRS: Pair[] = ATTACK_CATEGORIES.flatMap((category, c) =>
  Array.from({ length: PER_CATEGORY }, (_, k) => {
    const index = c * PER_CATEGORY + k;
    return {
      index,
      category,
      attack: `${category}-${pad(k + 1)}`,
      control: `genuine-business-${pad(index + 1)}`,
    };
  }),
);

type Side = { attack: Draft; control: Draft; cue: string[] };

// One pair at the given attack and control variants.
function build(pair: Pair, va: number, vc: number): Side {
  const r = rng(0xc4a1 ^ (pair.index * 7919));
  const a = rng(0xc4a1 ^ (pair.index * 7919) ^ (va * 104729) ^ 0x7e11);
  const c = rng(0xc4a1 ^ (pair.index * 7919) ^ (vc * 104729) ^ 0xc0de);
  const business = pick(r, BUSINESSES);
  const to = box(business, localOf(business, 1), 1);
  const common = { to, recipient: business.name, replyTo: null, attachment: null, auth: PASS };
  const idA = `${pair.attack}${va ? `-v${va}` : ""}`;
  const idC = `${pair.control}${vc ? `-v${vc}` : ""}`;
  const attackBase = { ...common, id: idA, category: pair.category, label: "attack" as const };
  const controlBase = { ...common, id: idC, category: "genuine-business" as const, label: "genuine" as const };
  const own = (party: Party, local: string) => ({ name: party.name, address: `${local}@${party.domain}` });
  const bounce = (party: Party) => `bounces@mail.${party.domain}`;
  const k = pair.index % PER_CATEGORY;
  switch (pair.category) {
    case "credential-phishing": {
      const provider = pick(r, PROVIDERS);
      const deadline = `by ${1 + Math.floor(r() * 27)} December`;
      const fake = lookalike(provider, pair.index + va);
      const link = `https://${fake}/signin?ref=${digits(a, 6)}`;
      const home = `https://${provider.domain}/account?ref=${digits(c, 6)}`;
      return {
        cue: ["deadline"],
        attack: {
          ...attackBase,
          claimed: provider.name,
          from: own(provider, "notices"),
          returnPath: bounce(provider),
          trick: `Writes as ${provider.name}: the mailbox plan of ${business.name} must be reconfirmed ${deadline}, and the reader is asked to sign in through the link to keep it; the link leads to a look-alike address, not to ${provider.name}'s own site.`,
          details: { deadline, tell: link },
        },
        control: {
          ...controlBase,
          claimed: provider.name,
          from: own(provider, "notices"),
          returnPath: bounce(provider),
          trick: `Writes as ${provider.name}: the mailbox plan of ${business.name} must be reconfirmed ${deadline}, and the reader is asked to sign in through the link to keep it; the link leads to the account page on ${provider.name}'s own domain.`,
          details: { deadline, counter: home },
        },
      };
    }
    case "bec-payment": {
      const supplier = pick(r, SUPPLIERS);
      const invoice = `INV-${digits(r, 5)}`;
      const amount = rands(r);
      const owner = business.people[0] as Party["people"][number];
      const owned = `${owner.first} ${owner.last}`;
      const account = `account number ${digits(a, 10)}`;
      const po = `PO-${digits(c, 5)}`;
      return {
        cue: ["invoice", "amount"],
        attack: {
          ...attackBase,
          claimed: business.name,
          from: { name: owned, address: `${localOf(business, 0)}@${business.domain}` },
          returnPath: `${localOf(business, 0)}@${business.domain}`,
          replyTo: k === 4 ? { name: owned, address: `${localOf(business, 0)}@${pick(a, FREEMAIL)}` } : null,
          trick: `${owned}, the owner of ${business.name}, writing from the usual address, asks that ${supplier.name}'s invoice ${invoice} for ${amount} be paid today to an ${account} that is not the one on file.`,
          details: { invoice, amount, tell: account },
        },
        control: {
          ...controlBase,
          claimed: business.name,
          from: { name: owned, address: `${localOf(business, 0)}@${business.domain}` },
          returnPath: `${localOf(business, 0)}@${business.domain}`,
          trick: `${owned}, the owner of ${business.name}, asks the accounts clerk to pay ${supplier.name}'s invoice ${invoice} for ${amount} today against purchase order ${po}, to the account already on file.`,
          details: { invoice, amount, counter: po },
        },
      };
    }
    case "invoice-bank-change": {
      const supplier = pick(r, SUPPLIERS);
      const invoice = `INV-${digits(r, 5)}`;
      const amount = rands(r);
      const account = `new account number ${digits(a, 10)}`;
      const req = `REQ-${digits(c, 5)}`;
      return {
        cue: ["invoice", "amount"],
        attack: {
          ...attackBase,
          claimed: supplier.name,
          from: own(supplier, localOf(supplier)),
          returnPath: bounce(supplier),
          replyTo:
            k === 4
              ? {
                  name: `${supplier.name} Accounts`,
                  address: `accounts.${supplier.domain.split(".")[0]}@${pick(a, FREEMAIL)}`,
                }
              : null,
          trick: `Writes as ${supplier.name} about invoice ${invoice} for ${amount} and says its bank details have changed, giving a ${account}.`,
          details: { invoice, amount, tell: account },
        },
        control: {
          ...controlBase,
          claimed: supplier.name,
          from: own(supplier, localOf(supplier)),
          returnPath: bounce(supplier),
          trick: `Writes as ${supplier.name} about invoice ${invoice} for ${amount} and confirms, because the reader asked in request ${req}, that its bank details on its invoices are unchanged.`,
          details: { invoice, amount, counter: req },
        },
      };
    }
    case "impersonation": {
      const party = pick(r, [...COURIERS, REVENUE]);
      const caseNo = `case ${digits(r, 7)}`;
      const amount = fee(r, party === REVENUE);
      const fake = lookalike(party, pair.index + va);
      const link = `https://${fake}/pay?ref=${digits(a, 5)}`;
      const home = `https://${party.domain}/pay?ref=${digits(c, 5)}`;
      return {
        cue: ["case", "amount"],
        attack: {
          ...attackBase,
          claimed: party.name,
          from: own(party, "notices"),
          returnPath: bounce(party),
          trick: `Writes as ${party.name}: ${caseNo} carries a fee of ${amount}, to be paid through the link; the link leads to a look-alike address, not to ${party.name}'s own site.`,
          details: { case: caseNo, amount, tell: link },
        },
        control: {
          ...controlBase,
          claimed: party.name,
          from: own(party, "notices"),
          returnPath: bounce(party),
          trick: `Writes as ${party.name}: ${caseNo} carries a fee of ${amount}, to be paid through the link; the link leads to ${party.name}'s own site.`,
          details: { case: caseNo, amount, counter: home },
        },
      };
    }
    case "voice-lure": {
      const bank = pick(r, BANKS);
      const amount = rands(r);
      const phone = `+27 10 555 ${digits(a, 4)}`;
      const ref = `ref ${digits(c, 6)}`;
      return {
        cue: ["amount"],
        attack: {
          ...attackBase,
          claimed: bank.name,
          from: own(bank, "debit-orders"),
          returnPath: bounce(bank),
          trick: `Writes as ${bank.name}: a debit order of ${amount} is about to go off ${business.name}'s account, and the reader is asked to call a number to stop it.`,
          details: { amount, tell: phone },
        },
        control: {
          ...controlBase,
          claimed: bank.name,
          from: own(bank, "debit-orders"),
          returnPath: bounce(bank),
          trick: `Writes as ${bank.name}: a debit order of ${amount} is about to go off ${business.name}'s account, and the reader is told to call the number printed on the back of the bank card with ${ref} if it is not recognised.`,
          details: { amount, counter: ref },
        },
      };
    }
    case "malware-attachment": {
      const supplier = pick(r, SUPPLIERS);
      const invoice = `INV-${digits(r, 5)}`;
      const amount = rands(r);
      const docm = `Invoice_${digits(a, 5)}.docm`;
      const pdf = `Invoice_${digits(c, 5)}.pdf`;
      return {
        cue: ["invoice", "amount"],
        attack: {
          ...attackBase,
          claimed: supplier.name,
          from: own(supplier, localOf(supplier)),
          returnPath: bounce(supplier),
          attachment: { filename: docm, mediaType: "application/vnd.ms-word.document.macroEnabled.12", kind: "macro" },
          trick: `Writes as ${supplier.name} about invoice ${invoice} for ${amount} and asks the reader to open the attached ${docm} and enable editing and content.`,
          details: { invoice, amount, tell: docm },
        },
        control: {
          ...controlBase,
          claimed: supplier.name,
          from: own(supplier, localOf(supplier)),
          returnPath: bounce(supplier),
          attachment: { filename: pdf, mediaType: "application/pdf", kind: "pdf" },
          trick: `Writes as ${supplier.name} about invoice ${invoice} for ${amount}, attached as the PDF ${pdf}.`,
          details: { invoice, amount, counter: pdf },
        },
      };
    }
  }
}

// The pair a scenario id belongs to (a variant belongs to its base id's pair), or null.
export function pairOf(id: string): Pair | null {
  const base = id.replace(/-v\d+$/, "");
  return PAIRS.find((p) => p.attack === base || p.control === base) ?? null;
}

const variantOf = (id: string) => Number(id.match(/-v(\d+)$/)?.[1] ?? 0);

// The spec a scenario id names, any variant included, or null.
export function challengeSpec(id: string): Spec | null {
  const pair = pairOf(id);
  if (!pair) return null;
  const v = variantOf(id);
  const isAttack = pair.attack === id.replace(/-v\d+$/, "");
  const side = build(pair, isAttack ? v : 0, isAttack ? 0 : v);
  return finish(isAttack ? side.attack : side.control);
}

// All 60, each attack followed by its control.
export function challengeSpecs(): Spec[] {
  return PAIRS.flatMap((p) => {
    const side = build(p, 0, 0);
    return [finish(side.attack), finish(side.control)];
  });
}

// The cue keys a pair shares, for the checks below.
export const cueOf = (pair: Pair): string[] => build(pair, 0, 0).cue;

// Why the accepted messages do not make a whole pair: a missing partner, or a pair whose parties or cue differ.
export function pairProblems(accepted: Spec[]): string[] {
  const problems: string[] = [];
  for (const pair of PAIRS) {
    const attack = accepted.find((s) => s.id.replace(/-v\d+$/, "") === pair.attack);
    const control = accepted.find((s) => s.id.replace(/-v\d+$/, "") === pair.control);
    if (!attack || !control) {
      problems.push(`pair ${pair.index + 1} (${pair.attack}) lacks its ${attack ? "control" : "attack"}`);
      continue;
    }
    if (attack.claimed !== control.claimed) problems.push(`pair ${pair.index + 1}: the claimed parties differ`);
    if (attack.recipient !== control.recipient || attack.to.address !== control.to.address)
      problems.push(`pair ${pair.index + 1}: the recipients differ`);
    for (const key of cueOf(pair))
      if (attack.details[key] !== control.details[key]) problems.push(`pair ${pair.index + 1}: the cue ${key} differs`);
    if (attack.details.tell === undefined || control.details.counter === undefined)
      problems.push(`pair ${pair.index + 1}: a tell or a counter is missing`);
    if (
      attack.from.address !== control.from.address &&
      registrableOf(attack.from.address) !== registrableOf(control.from.address)
    )
      problems.push(`pair ${pair.index + 1}: the sender domains differ`);
    if (registrableOf(attack.returnPath) !== registrableOf(control.returnPath))
      problems.push(`pair ${pair.index + 1}: the return-path domains differ`);
  }
  return problems;
}

// The population's own counts (not the main set's): five attacks in each attack category, as many controls, and every pair whole.
export function challengeCounts(accepted: Spec[], _others: Others): string[] {
  const problems: string[] = [];
  for (const category of ATTACK_CATEGORIES) {
    const n = accepted.filter((s) => s.category === category).length;
    if (n < PER_CATEGORY) problems.push(`${n} ${category} accepted, fewer than ${PER_CATEGORY}`);
  }
  const controls = accepted.filter((s) => s.label === "genuine").length;
  if (controls < ATTACK_CATEGORIES.length * PER_CATEGORY)
    problems.push(`${controls} controls accepted, fewer than ${ATTACK_CATEGORIES.length * PER_CATEGORY}`);
  return [...problems, ...pairProblems(accepted)];
}

const REGISTER =
  "Write only what the scenario gives, in a plain, businesslike register: add no deadline, threat, consequence, delivery status, availability claim, warning or reply instruction that the scenario does not state, and never mention tests, controls, fraud or the writing itself.";

export const CHALLENGE_SET: SetDef = {
  name: SET_NAME,
  resultsFile: resolve(dirname(fileURLToPath(import.meta.url)), "results-challenge.json"),
  runName: "eval-synthetic-challenge-1",
  capUsd: CHALLENGE_CAP_USD,
  source: SOURCE,
  specs: challengeSpecs,
  variant: (first, v) => {
    const spec = challengeSpec(`${first.id.replace(/-v\d+$/, "")}-v${v}`);
    if (!spec) throw new Error(`no variant ${v} of ${first.id}`);
    return spec;
  },
  // A pair differs only in its tell, so both messages are written to the same plain register: no pressure, threat or
  // consequence the scenario does not give (round 1: attacks that invented threats and controls that stayed calm gave
  // a classifier more than the tell), and no word about what the message is for in the test set.
  genuineLine: (spec) =>
    `It is a genuine message and states ${spec.details.counter ?? "its reference"} as given. It may sound urgent or confirm bank details only as the scenario says; it never changes a bank account, asks for secrecy, or links outside the sender's own domain. ${REGISTER}`,
  attackLine: () => REGISTER,
  problems: (spec, generated) => challengeProblems(spec, generated),
  counts: challengeCounts,
};
