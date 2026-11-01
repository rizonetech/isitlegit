// A protected business's public address on the verify page, `/v/<slug>` (D05 T02 §6, corrections 2 and 11): the
// registered name lower-cased, accented letters folded to ASCII, every run of other characters one hyphen, the company
// form dropped, cut to 50 characters at a hyphen; a result under 3 characters (a very short or non-Latin name) becomes
// `business-` and the start of the organisation's id. A taken slug gets `-2`, `-3` and so on (`withSuffix`), always
// within the column's 60 characters.
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;
export const MAX_SLUG = 60;
const BASE_MAX = 50;
const COMPANY_FORMS = new Set(["pty", "ltd", "limited", "cc", "inc", "npc", "proprietary", "rf", "soc"]);

export function publicSlugOf(name: string, orgId: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  while (words.length > 1 && COMPANY_FORMS.has(words[words.length - 1] as string)) words.pop();
  let slug = "";
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > BASE_MAX) break;
    slug = next;
  }
  if (!slug && words[0]) slug = words[0].slice(0, BASE_MAX);
  if (slug.length < 3)
    slug = `business-${
      orgId
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 8) || "page"
    }`;
  return slug;
}

// The slug with a collision's number, the base shortened so the whole stays within 60 characters.
export function withSuffix(slug: string, n: number): string {
  if (n <= 1) return slug;
  const suffix = `-${n}`;
  return `${slug.slice(0, MAX_SLUG - suffix.length).replace(/-+$/, "")}${suffix}`;
}
