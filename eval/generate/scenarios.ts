// The scenarios of the synthetic South African mail set (D08 T01 §3): 160 specs, each a category, its fictional
// parties, the trick it plays, the authentication results its headers carry, the details its deception turns on, and
// the evidence the deterministic checks should raise from its headers and parts (or `basis: "model"` when its only
// tell is its text). Built from a fixed seed, so the same specs come out every time; a variant number gives a
// replacement for a scenario whose body failed the content rules twice.
import { z } from "zod";
import { CATEGORIES, type Label } from "../schema.ts";
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

// The eight check names a synthetic message can be expected to raise: what code-built headers and parts can show.
export const EXPECTABLE = [
  "auth.spf",
  "auth.dkim",
  "auth.dmarc",
  "sender.reply_to",
  "sender.return_path",
  "attachment.executable",
  "attachment.macro",
  "attachment.html",
] as const;
export type Expectable = (typeof EXPECTABLE)[number];

export const MIX = {
  "genuine-business": 40,
  "genuine-newsletter": 30,
  "credential-phishing": 20,
  "bec-payment": 15,
  "invoice-bank-change": 15,
  impersonation: 15,
  "voice-lure": 15,
  "malware-attachment": 10,
} as const satisfies Record<(typeof CATEGORIES)[number], number>;

const Mailbox = z.strictObject({
  name: z.string().min(1),
  address: z.string().regex(/^[a-z0-9._-]+@[a-z0-9.-]+\.example$/),
});
const Result = z.enum(["pass", "fail"]);

export const Spec = z.strictObject({
  id: z.string().regex(/^[a-z-]+-\d{3}(-v\d+)?$/),
  category: z.enum(CATEGORIES),
  label: z.enum(["attack", "genuine"]),
  // Who the mail claims to be from (a party), who sent it, and who receives it.
  claimed: z.string().min(1),
  from: Mailbox,
  replyTo: Mailbox.nullable(),
  returnPath: z.string().regex(/^[a-z0-9._-]+@[a-z0-9.-]+\.example$/),
  to: Mailbox,
  recipient: z.string().min(1),
  auth: z.strictObject({ spf: Result, dkim: Result, dmarc: Result }),
  // The scenario in a sentence, for the model and the annotation.
  trick: z.string().min(10).max(300),
  // What the body must carry verbatim (an attack's deception, or a genuine mail's ordinary facts).
  details: z.record(z.string(), z.string().min(1)),
  attachment: z
    .strictObject({ filename: z.string(), mediaType: z.string(), kind: z.enum(["executable", "macro", "html", "pdf"]) })
    .nullable(),
  expected: z.array(z.enum(EXPECTABLE)),
  basis: z.enum(["checks", "model"]),
});
export type Spec = z.infer<typeof Spec>;

// A small seeded generator (mulberry32), so the specs are the same on every machine.
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The registrable domain of a `.example` address: its last two labels.
export const registrableOf = (address: string) => (address.split("@")[1] ?? "").split(".").slice(-2).join(".");

export const person = (party: Party, i = 0) => party.people[i % party.people.length] as Party["people"][number];
export const box = (party: Party, local: string, i = 0): z.infer<typeof Mailbox> => {
  const who = person(party, i);
  return { name: `${who.first} ${who.last}`, address: `${local}@${party.domain}` };
};
export const localOf = (party: Party, i = 0) => {
  const who = person(party, i);
  return `${who.first}.${who.last}`.toLowerCase().replace(/[^a-z.]/g, "");
};

// The evidence a spec's headers and parts should raise: what the checks find, by registrable domain.
export function expectedFor(spec: Omit<Spec, "expected" | "basis">): Expectable[] {
  const out: Expectable[] = [];
  if (spec.auth.spf === "fail") out.push("auth.spf");
  if (spec.auth.dkim === "fail") out.push("auth.dkim");
  if (spec.auth.dmarc === "fail") out.push("auth.dmarc");
  const own = registrableOf(spec.from.address);
  if (spec.replyTo && registrableOf(spec.replyTo.address) !== own) out.push("sender.reply_to");
  if (registrableOf(spec.returnPath) !== own) out.push("sender.return_path");
  if (spec.attachment?.kind === "executable") out.push("attachment.executable");
  if (spec.attachment?.kind === "macro") out.push("attachment.macro");
  if (spec.attachment?.kind === "html") out.push("attachment.html");
  return out;
}

export const PASS = { spf: "pass", dkim: "pass", dmarc: "pass" } as const;
const SPOOFED = { spf: "fail", dkim: "fail", dmarc: "fail" } as const;

export function digits(r: () => number, n: number) {
  let s = String(1 + Math.floor(r() * 9));
  while (s.length < n) s += String(Math.floor(r() * 10));
  return s;
}
export const rands = (r: () => number) => {
  const whole = 1200 + Math.floor(r() * 90000);
  return `R${whole.toLocaleString("en-ZA").replace(/,/g, " ").replace(/ /g, " ")}.00`;
};
// A small charge as a courier or a revenue office asks for it: a customs or redelivery fee, or a late-filing penalty.
export const fee = (r: () => number, revenue: boolean) => {
  const cents = String(Math.floor(r() * 100)).padStart(2, "0");
  const whole = revenue ? 250 + Math.floor(r() * 2250) : 25 + Math.floor(r() * 125);
  return `R${whole.toLocaleString("en-ZA").replace(/[\s,\u00a0]/g, " ")}.${cents}`;
};
export const pick = <T>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)] as T;

export type Draft = Omit<Spec, "expected" | "basis">;

// One draft of a category, number n, variant v (0 for the first, higher for a replacement).
function draft(category: Spec["category"], n: number, v: number): Draft {
  // Parties come from the scenario's own seed and details from the variant's, so a replacement keeps the category and
  // parties and changes only what its deception turns on (D08 T01 §3).
  const r = rng(0x5a1e ^ (n * 7919) ^ (category.length * 31));
  const d = v ? rng(0x5a1e ^ (n * 7919) ^ (v * 104729) ^ (category.length * 31)) : r;
  const business = pick(r, BUSINESSES);
  const to = box(business, localOf(business, 1), 1);
  const id = `${category}-${String(n).padStart(3, "0")}${v ? `-v${v}` : ""}`;
  const base = { id, category, to, recipient: business.name, attachment: null, replyTo: null };
  const genuineFrom = (party: Party, local: string) => ({
    claimed: party.name,
    from: box(party, local),
    returnPath: `bounces@mail.${party.domain}`,
    auth: PASS,
  });
  switch (category) {
    case "genuine-business": {
      const kind = n % 4;
      if (kind === 0) {
        const supplier = pick(r, SUPPLIERS);
        const invoice = `INV-${digits(d, 5)}`;
        return {
          ...base,
          label: "genuine",
          ...genuineFrom(supplier, localOf(supplier)),
          // A same-domain Reply-To: the accounts mailbox of the same supplier, which raises nothing.
          replyTo: { name: `${supplier.name} Accounts`, address: `accounts@${supplier.domain}` },
          trick: `An ordinary monthly invoice from ${supplier.name} to ${business.name}, attached as a PDF, paid to the account on file as usual.`,
          details: { invoice, amount: rands(d) },
          attachment: { filename: `${invoice}.pdf`, mediaType: "application/pdf", kind: "pdf" },
        };
      }
      if (kind === 1) {
        const courier = pick(r, COURIERS);
        return {
          ...base,
          label: "genuine",
          ...genuineFrom(courier, "dispatch"),
          trick: `A delivery update from ${courier.name}: a parcel for ${business.name} is out for delivery today.`,
          details: { waybill: `${digits(d, 3)}-${digits(d, 6)}` },
        };
      }
      if (kind === 2) {
        const staff = box(business, localOf(business, 0), 0);
        return {
          ...base,
          label: "genuine",
          claimed: business.name,
          from: staff,
          returnPath: staff.address,
          auth: PASS,
          trick: `Internal mail at ${business.name}: the owner asks the office to book the team's year-end function and confirm numbers.`,
          details: { date: `${1 + Math.floor(d() * 27)} December` },
        };
      }
      const bank = pick(r, BANKS);
      return {
        ...base,
        label: "genuine",
        ...genuineFrom(bank, "statements"),
        trick: `${bank.name} lets ${business.name} know that its monthly business statement is ready in online banking, with no link to click.`,
        details: { month: pick(d, ["September", "October"]) },
      };
    }
    case "genuine-newsletter": {
      const party = pick(r, [...PROVIDERS, ...SUPPLIERS, ...BANKS]);
      return {
        ...base,
        label: "genuine",
        ...genuineFrom(party, "news"),
        trick: `A monthly newsletter from ${party.name} to its customers: product news, a seasonal tip, and an unsubscribe line.`,
        details: { edition: `${pick(d, ["October", "November"])} 2026` },
      };
    }
    case "credential-phishing": {
      const target = pick(r, [...BANKS, ...PROVIDERS]);
      const fake = lookalike(target, n + v);
      const url = `https://${fake}/login?ref=${digits(d, 6)}`;
      // Half spoof the party's own domain and fail authentication; half write from a look-alike that passes.
      if (n % 2 === 0)
        return {
          ...base,
          label: "attack",
          claimed: target.name,
          from: { name: `${target.name} Security`, address: `security@${target.domain}` },
          returnPath: `security@${target.domain}`,
          auth: SPOOFED,
          trick: `Pretends to be ${target.name}, says the account will be suspended, and sends the reader to a look-alike sign-in page.`,
          details: { link: url },
        };
      return {
        ...base,
        label: "attack",
        claimed: target.name,
        from: { name: `${target.name}`, address: `alerts@${fake}` },
        returnPath: `alerts@${fake}`,
        auth: PASS,
        trick: `Writes from a look-alike of ${target.name}'s domain, asks the reader to confirm their sign-in details on a look-alike page.`,
        details: { link: url },
      };
    }
    case "bec-payment": {
      const owner = box(business, localOf(business, 0), 0);
      const fake = lookalike(business, n + v);
      const amount = rands(d);
      if (n % 2 === 0)
        return {
          ...base,
          label: "attack",
          claimed: business.name,
          from: { name: owner.name, address: `${localOf(business, 0)}@${fake}` },
          replyTo: { name: owner.name, address: `${localOf(business, 0)}@${pick(d, FREEMAIL)}` },
          returnPath: `${localOf(business, 0)}@${fake}`,
          auth: PASS,
          trick: `Poses as the owner of ${business.name} and asks the bookkeeper to pay a supplier urgently and quietly, replies going to a free-mail box.`,
          details: { amount },
        };
      return {
        ...base,
        label: "attack",
        claimed: business.name,
        from: { name: owner.name, address: `${localOf(business, 0)}@${fake}` },
        returnPath: `${localOf(business, 0)}@${fake}`,
        auth: PASS,
        trick: `Poses as the owner of ${business.name} from a look-alike domain and asks for an urgent, confidential payment before the end of the day.`,
        details: { amount },
      };
    }
    case "invoice-bank-change": {
      const supplier = pick(r, SUPPLIERS);
      const account = digits(d, 10);
      const branch = digits(d, 6);
      const bank = pick(d, BANKS).name;
      if (n % 2 === 0)
        return {
          ...base,
          label: "attack",
          claimed: supplier.name,
          from: box(supplier, localOf(supplier)),
          returnPath: `${localOf(supplier)}@${supplier.domain}`,
          auth: SPOOFED,
          trick: `Spoofs ${supplier.name} and says its banking details have changed, so the next invoice must be paid to a new account.`,
          details: { account, branch, bank },
        };
      return {
        ...base,
        label: "attack",
        claimed: supplier.name,
        from: { name: box(supplier, "x").name, address: `${localOf(supplier)}@${lookalike(supplier, n + v)}` },
        replyTo: {
          name: `${supplier.name} Accounts`,
          address: `accounts.${supplier.domain.split(".")[0]}@${pick(d, FREEMAIL)}`,
        },
        returnPath: `${localOf(supplier)}@${lookalike(supplier, n + v)}`,
        auth: PASS,
        trick: `Writes as ${supplier.name} from a look-alike domain, sends new banking details for the outstanding invoice, replies to a free-mail box.`,
        details: { account, branch, bank },
      };
    }
    case "impersonation": {
      const party = n % 3 === 0 ? REVENUE : pick(r, [...COURIERS, REVENUE]);
      const fake = lookalike(party, n + v);
      const url = `https://${fake}/pay?case=${digits(d, 7)}`;
      if (n % 2 === 0)
        return {
          ...base,
          label: "attack",
          claimed: party.name,
          from: { name: party.name, address: `notices@${party.domain}` },
          returnPath: `notices@${party.domain}`,
          // A spoof of the party's own domain from elsewhere: SPF, DKIM and so DMARC fail (RFC 7489 6.6.2: an aligned
          // SPF pass alone would pass DMARC).
          auth: SPOOFED,
          trick: `Pretends to be ${party.name} and demands a small fee or penalty be paid through a link before a deadline.`,
          details: { link: url, amount: fee(d, party === REVENUE) },
        };
      return {
        ...base,
        label: "attack",
        claimed: party.name,
        from: { name: party.name, address: `notices@${fake}` },
        returnPath: `notices@${fake}`,
        auth: PASS,
        trick: `Writes as ${party.name} from a look-alike domain and asks for a fee to be paid through a link to release a parcel or settle a penalty.`,
        details: { link: url, amount: fee(d, party === REVENUE) },
      };
    }
    case "voice-lure": {
      const bank = pick(r, BANKS);
      const phone = `+27 10 555 ${digits(d, 4)}`;
      const sender = pick(d, FREEMAIL);
      if (n % 3 === 0)
        return {
          ...base,
          label: "attack",
          claimed: bank.name,
          from: { name: `${bank.name} Fraud Desk`, address: `fraud-desk@${sender}` },
          returnPath: `bounce@${pick(
            d,
            FREEMAIL.filter((f) => f !== sender),
          )}`,
          auth: PASS,
          trick: `Claims a suspicious transaction on the ${bank.name} business account and asks the reader to phone a number at once.`,
          details: { phone, amount: rands(d) },
        };
      return {
        ...base,
        label: "attack",
        claimed: bank.name,
        from: { name: `${bank.name} Fraud Desk`, address: `fraud-desk@${sender}` },
        returnPath: `fraud-desk@${sender}`,
        auth: PASS,
        trick: `Claims a debit order is about to go off the ${bank.name} business account and asks the reader to call a number to stop it.`,
        details: { phone, amount: rands(d) },
      };
    }
    case "malware-attachment": {
      const party = pick(r, [...SUPPLIERS, ...COURIERS]);
      const fake = lookalike(party, n + v);
      // A program (odd numbers a macro-enabled Word document, even an executable): malware, never a sign-in form.
      const macro = n % 2 === 1;
      const ref = digits(d, 5);
      const file = macro ? `Invoice_${ref}.docm` : `Invoice_${ref}.exe`;
      return {
        ...base,
        label: "attack",
        claimed: party.name,
        from: { name: party.name, address: `documents@${fake}` },
        returnPath: `documents@${fake}`,
        auth: PASS,
        attachment: macro
          ? { filename: file, mediaType: "application/vnd.ms-word.document.macroEnabled.12", kind: "macro" }
          : { filename: file, mediaType: "application/octet-stream", kind: "executable" },
        trick: `Writes as ${party.name} and asks the reader to open the attached invoice at once${macro ? " and enable editing and content" : ""}.`,
        details: { attachment: file },
      };
    }
  }
}

// A spec with its evidence and basis filled in, validated.
export function finish(d: Draft): Spec {
  const expected = d.label === "attack" ? expectedFor(d) : [];
  return Spec.parse({ ...d, expected, basis: d.label === "attack" && expected.length === 0 ? "model" : "checks" });
}

// The scenario numbered n of a category, at a variant (a replacement when above 0).
export const scenario = (category: Spec["category"], n: number, variant = 0): Spec =>
  finish(draft(category, n, variant));

// The spec a scenario id names, any variant included (`bec-payment-007-v2`), or null when it names none.
export function specOfId(id: string): Spec | null {
  const m = id.match(/^([a-z-]+)-(\d{3})(?:-v(\d+))?$/);
  const category = m?.[1] as Spec["category"] | undefined;
  if (!m || !category || !(category in MIX)) return null;
  const n = Number(m[2]);
  if (n < 1 || n > MIX[category as keyof typeof MIX]) return null;
  return scenario(category, n, Number(m[3] ?? 0));
}

// All 160, in a stable order.
export function scenarios(): Spec[] {
  const out: Spec[] = [];
  for (const [category, count] of Object.entries(MIX) as [Spec["category"], number][])
    for (let n = 1; n <= count; n++) out.push(scenario(category, n));
  return out;
}

// The label a spec's file is written under.
export const labelOf = (spec: Spec, path: string, source: string): Label => ({
  path,
  label: spec.label,
  category: spec.category,
  expected: spec.expected,
  source,
  ...(spec.basis === "model" ? { basis: "model" as const } : {}),
});
