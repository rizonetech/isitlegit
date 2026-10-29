// The brand table's schema (D02 T03 §3), apart from the table so `scripts/load-brands.ts` validates with the same rules
// the Worker reads with (Node cannot import the bundled JSON without an import attribute).
import { getDomain } from "tldts";
import { z } from "zod";

export const BRANDS_SCHEMA = 1;
export const BRANDS_KEY = `brands:v${BRANDS_SCHEMA}`;
export const BRANDS_PREVIOUS_KEY = `${BRANDS_KEY}:previous`;

// Its own registrable domain, the public suffix list's private section included, so a customer's host on a provider's
// private suffix (`x.blob.core.windows.net`) is the customer's, not the provider's.
export const registrable = (host: string) =>
  getDomain(host.toLowerCase().replace(/\.$/, ""), { allowPrivateDomains: true });

const Domain = z
  .string()
  .regex(/^[a-z0-9.-]+$/)
  .refine((domain) => registrable(domain) === domain, "a registrable domain");
const Host = z.string().regex(/^[a-z0-9.-]+$/);
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
    for (const host of brand.user_content)
      if (!brand.domains.includes(registrable(host) ?? ""))
        ctx.addIssue({ code: "custom", message: `${brand.name}: ${host} is not under one of its domains` });
  });
export const BrandTable = z.strictObject({
  version: z.literal(BRANDS_SCHEMA),
  revision: z.iso.date(),
  brands: z.array(Brand).min(1),
  excluded: z.array(z.strictObject({ name: z.string().min(1), reason: z.string().min(1) })),
});
export type BrandTable = z.infer<typeof BrandTable>;
export type Brand = z.infer<typeof Brand>;
