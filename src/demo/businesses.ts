// The five demo businesses as the seed takes them (D07 T07 §1), built from the shared data in data/demo/: Fynbos Freight
// from its brand kit, the courier and three suppliers from businesses.json. Pure: the caller reads the files.
import { type DemoBusiness, FYNBOS_ORG_ID } from "./seed";

export type BrandKit = {
  name: string;
  legal_name: string;
  domains: { verified: string };
  mailboxes: { accounts: string; member: string };
  bank: { name: string; account_on_file: string; branch_code: string };
};
export type OtherBusinesses = {
  bank: { name: string; branch_code: string };
  businesses: {
    slug: string;
    name: string;
    legal_name: string;
    domain: string;
    accounts: string;
    account_number: string;
    holder: string;
    logo: string;
  }[];
};

export function demoBusinesses(
  brand: BrandKit,
  others: OtherBusinesses,
  logos: { fynbos: string; byPath: Record<string, string> },
): DemoBusiness[] {
  const fynbos: DemoBusiness = {
    slug: "fynbos-freight",
    name: brand.name,
    legalName: brand.legal_name,
    domain: brand.domains.verified,
    accounts: brand.mailboxes.accounts,
    accountNumber: brand.bank.account_on_file,
    branchCode: brand.bank.branch_code,
    bankName: brand.bank.name,
    logoSvg: logos.fynbos,
    existingOrgId: FYNBOS_ORG_ID,
    ownerEmail: brand.mailboxes.member,
  };
  return [
    fynbos,
    ...others.businesses.map((b) => {
      const svg = logos.byPath[b.logo];
      if (!svg) throw new Error(`no logo file for ${b.slug}: ${b.logo}`);
      return {
        slug: b.slug,
        name: b.name,
        legalName: b.legal_name,
        domain: b.domain,
        accounts: b.accounts,
        accountNumber: b.account_number,
        branchCode: others.bank.branch_code,
        bankName: others.bank.name,
        logoSvg: svg,
        ownerEmail: b.accounts,
      } satisfies DemoBusiness;
    }),
  ];
}
