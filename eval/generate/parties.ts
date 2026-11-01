// The fictional parties of the synthetic South African mail set (D08 T01 §3): banks, suppliers, couriers, a revenue
// office styled like a tax authority, software providers, and the small businesses that receive the mail. None is a
// real organisation, and every domain sits under the reserved `.example` top-level domain (RFC 2606), so no generated
// address belongs to anyone.

export type Party = {
  name: string;
  domain: string;
  kind: "bank" | "supplier" | "courier" | "revenue" | "provider" | "business";
  // A person who writes for it: first name, surname, role.
  people: { first: string; last: string; role: string }[];
  city: string;
};

const p = (first: string, last: string, role: string) => ({ first, last, role });

export const BANKS: Party[] = [
  {
    name: "Protea Bank",
    domain: "proteabank.example",
    kind: "bank",
    people: [p("Lerato", "Dube", "Business Banking")],
    city: "Johannesburg",
  },
  {
    name: "Karoo Mutual Bank",
    domain: "karoomutual.example",
    kind: "bank",
    people: [p("Johan", "Steyn", "Client Services")],
    city: "Bloemfontein",
  },
  {
    name: "Highveld Savings",
    domain: "highveldsavings.example",
    kind: "bank",
    people: [p("Ayanda", "Khumalo", "Fraud Desk")],
    city: "Pretoria",
  },
];

export const SUPPLIERS: Party[] = [
  {
    name: "Umhlanga Packaging",
    domain: "umhlangapack.example",
    kind: "supplier",
    people: [p("Priya", "Naidoo", "Accounts")],
    city: "Durban",
  },
  {
    name: "Cederberg Office Supplies",
    domain: "cederbergoffice.example",
    kind: "supplier",
    people: [p("Pieter", "Malan", "Sales")],
    city: "Clanwilliam",
  },
  {
    name: "Kloof Electrical",
    domain: "kloofelectrical.example",
    kind: "supplier",
    people: [p("Sipho", "Ndlovu", "Accounts")],
    city: "Kloof",
  },
  {
    name: "Bushveld Timber",
    domain: "bushveldtimber.example",
    kind: "supplier",
    people: [p("Marike", "Botha", "Debtors")],
    city: "Polokwane",
  },
  {
    name: "Swartland Print",
    domain: "swartlandprint.example",
    kind: "supplier",
    people: [p("Zanele", "Mthembu", "Accounts")],
    city: "Malmesbury",
  },
  {
    name: "Vaal Hygiene Services",
    domain: "vaalhygiene.example",
    kind: "supplier",
    people: [p("Kagiso", "Molefe", "Operations")],
    city: "Vereeniging",
  },
];

export const COURIERS: Party[] = [
  {
    name: "Swift Kudu Couriers",
    domain: "swiftkudu.example",
    kind: "courier",
    people: [p("Bongani", "Zulu", "Dispatch")],
    city: "Midrand",
  },
  {
    name: "Baobab Freight",
    domain: "baobabfreight.example",
    kind: "courier",
    people: [p("Nomsa", "Sithole", "Customer Care")],
    city: "Gqeberha",
  },
];

export const REVENUE: Party = {
  name: "National Revenue Office",
  domain: "nro-gov.example",
  kind: "revenue",
  people: [p("Thabo", "Mahlangu", "eFiling Support")],
  city: "Pretoria",
};

export const PROVIDERS: Party[] = [
  {
    name: "CloudDesk Mail",
    domain: "clouddeskmail.example",
    kind: "provider",
    people: [p("Anele", "Dlamini", "Support")],
    city: "Cape Town",
  },
  {
    name: "Fynbos Ledger",
    domain: "fynbosledger.example",
    kind: "provider",
    people: [p("Riaan", "Pretorius", "Billing")],
    city: "Stellenbosch",
  },
  {
    name: "SecureSign Docs",
    domain: "securesigndocs.example",
    kind: "provider",
    people: [p("Lindiwe", "Ngcobo", "Notifications")],
    city: "Johannesburg",
  },
];

// The small businesses the mail is sent to, and whose own staff write the internal mail.
export const BUSINESSES: Party[] = [
  {
    name: "Mzansi Plumbing",
    domain: "mzansiplumbing.example",
    kind: "business",
    people: [p("Themba", "Nkosi", "Owner"), p("Refilwe", "Mokoena", "Bookkeeper")],
    city: "Soweto",
  },
  {
    name: "Lekker Bakes",
    domain: "lekkerbakes.example",
    kind: "business",
    people: [p("Annelie", "du Toit", "Owner"), p("Neo", "Sebola", "Office Manager")],
    city: "Paarl",
  },
  {
    name: "Bay Dental Rooms",
    domain: "baydental.example",
    kind: "business",
    people: [p("Kavitha", "Pillay", "Practice Owner"), p("Craig", "Jacobs", "Practice Manager")],
    city: "Durban",
  },
  {
    name: "Jacaranda Panel Beaters",
    domain: "jacarandapanel.example",
    kind: "business",
    people: [p("Mpho", "Radebe", "Owner"), p("Lisa", "van Wyk", "Admin")],
    city: "Pretoria",
  },
  {
    name: "Garden Route Guesthouse",
    domain: "gardenroutegh.example",
    kind: "business",
    people: [p("Hennie", "Smit", "Owner"), p("Busisiwe", "Cele", "Bookings")],
    city: "Knysna",
  },
];

export const ALL_PARTIES: Party[] = [...BANKS, ...SUPPLIERS, ...COURIERS, REVENUE, ...PROVIDERS, ...BUSINESSES];

// A look-alike domain an attacker registers for a party: still under `.example`, a different registrable domain.
export function lookalike(party: Party, variant: number): string {
  const stem = party.domain.replace(/\.example$/, "");
  const forms = [`${stem}-secure`, `${stem}-online`, `${stem}-za`, `${stem}-billing`, `my${stem}`, `${stem}-verify`];
  return `${forms[variant % forms.length]}.example`;
}

// A free-mail style service the attacker writes from; fictional too.
export const FREEMAIL = ["mailbox-za.example", "quickpost.example", "inboxnow.example"];
