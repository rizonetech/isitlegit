// The brand table's schema (D02 T03 §3), apart from the table so `scripts/load-brands.ts` validates with the same rules
// the Worker reads with (Node cannot import the bundled JSON without an import attribute).
import { getDomain } from "tldts";
import { z } from "zod";

export const BRANDS_SCHEMA = 1;
export const BRANDS_KEY = `brands:v${BRANDS_SCHEMA}`;
export const BRANDS_PREVIOUS_KEY = `${BRANDS_KEY}:previous`;

// Its own registrable domain, the public suffix list's private section included, so a customer's host on a provider's
// private suffix (`x.blob.core.windows.net`) is the customer's, not the provider's. IsItLegit's demo suffix is one
// such private suffix (D07 T02 §20, `DEMO_SUFFIX`): each `<name>.demo.isitlegit.co.za` is its own domain, so two demo
// organisations' domains are never one, and the suffix itself is no domain.
// WORKAROUND: the constant is written out here, not imported from `src/auth/senders.ts` (its owner), because that module
// reads D1 types and this one is also loaded by Node scripts, whose typecheck has no Worker types. `test/checks/brands.test.ts`
// fails if the two ever differ.
export const DEMO_SUFFIX_OF_CHECKS = "demo.isitlegit.co.za";
// A host name as typed (ASCII letters, digits and hyphens in dot-separated labels of 1 to 63, 253 in all, an
// internationalised name in its xn-- form), checked before the demo boundary reads it: `tldts` refused a malformed host
// itself, and `mail..fynbos.demo.isitlegit.co.za` must not become the organisation's domain.
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export const registrable = (host: string) => {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name === DEMO_SUFFIX_OF_CHECKS) return null;
  if (name.endsWith(`.${DEMO_SUFFIX_OF_CHECKS}`)) {
    if (!HOST.test(name)) return null;
    const labels = name.slice(0, -DEMO_SUFFIX_OF_CHECKS.length - 1).split(".");
    return `${labels[labels.length - 1]}.${DEMO_SUFFIX_OF_CHECKS}`;
  }
  return getDomain(name, { allowPrivateDomains: true });
};

const Domain = z
  .string()
  .regex(/^[a-z0-9.-]+$/)
  .refine((domain) => registrable(domain) === domain, "a registrable domain");
// Where a brand publishes other people's content: a host and its subdomains (`sites.google.com`), one host exactly
// (`=live.com`, a consumer mailbox domain whose `login.` host is the brand's own), or a host and a path prefix, a `*`
// standing for one path segment (`learn.microsoft.com/*/answers/`, under any locale).
const Host = z.string().regex(/^=?[a-z0-9.-]+(?:\/(?:[A-Za-z0-9._~-]+|\*)(?:\/(?:[A-Za-z0-9._~-]+|\*))*\/)?$/);
const Source = z.strictObject({
  url: z.url({ protocol: /^https$/ }),
  read: z.iso.date(),
  names: z.array(Domain).min(1),
  // A short verbatim quote naming the domain, or, for a page read only by its address, what the page is.
  evidence: z.string().min(1).max(300),
});
const Brand = z
  .strictObject({
    name: z.string().min(1),
    display_names: z.array(z.string().min(1)).min(1),
    domains: z.array(Domain).min(1),
    user_content: z.array(Host),
    sources: z.array(Source).min(1),
  })
  .superRefine((brand, ctx) => {
    const named = new Set(brand.sources.flatMap((s) => s.names));
    for (const domain of brand.domains)
      if (!named.has(domain)) ctx.addIssue({ code: "custom", message: `${brand.name}: no source names ${domain}` });
    for (const source of brand.sources) {
      const host = registrable(new URL(source.url).hostname);
      if (!host || !brand.domains.includes(host))
        ctx.addIssue({ code: "custom", message: `${brand.name}: ${source.url} is not on the brand's own domains` });
      for (const name of source.names)
        if (!brand.domains.includes(name))
          ctx.addIssue({ code: "custom", message: `${brand.name}: a source names ${name}, not one of its domains` });
    }
    for (const entry of brand.user_content) {
      const host = (entry.split("/")[0] as string).replace(/^=/, "");
      if (!brand.domains.includes(registrable(host) ?? ""))
        ctx.addIssue({ code: "custom", message: `${brand.name}: ${entry} is not under one of its domains` });
    }
  });
export const BrandTable = z.strictObject({
  version: z.literal(BRANDS_SCHEMA),
  revision: z.iso.date(),
  // A label below a brand's registrable domain that marks other people's content on any brand (`community`, `forums`).
  community_labels: z.array(z.string().regex(/^[a-z0-9-]+$/)),
  brands: z.array(Brand).min(1),
  excluded: z.array(z.strictObject({ name: z.string().min(1), reason: z.string().min(1) })),
});
export type BrandTable = z.infer<typeof BrandTable>;

// Whether a table names every brand another one does, as a brand or as excluded: a refresh may add and correct, never
// drop one (final review: a wrong file loaded into KV would otherwise shrink the table in production).
export function covers(table: BrandTable, required: BrandTable): string[] {
  const named = new Set([...table.brands.map((b) => b.name), ...table.excluded.map((e) => e.name)]);
  return [...required.brands.map((b) => b.name), ...required.excluded.map((e) => e.name)].filter((n) => !named.has(n));
}
export type Brand = z.infer<typeof Brand>;
