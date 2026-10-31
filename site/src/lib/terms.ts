// Launch-terms review status (D07 T06 §8, §17). Until the operator records approval in D07 T06 §17, `/terms` stays
// explicitly marked as a draft awaiting Rizonetech review rather than claiming a completed review.
export const TERMS_REVIEWED_ON: string | null = null;

export function termsStatus(reviewedOn: string | null = TERMS_REVIEWED_ON): { draft: boolean; badge: string } {
  if (!reviewedOn || !reviewedOn.trim()) {
    return {
      draft: true,
      badge: "Draft for the launch period; awaiting Rizonetech review",
    };
  }
  return {
    draft: false,
    badge: `Reviewed by Rizonetech on ${reviewedOn.trim()}`,
  };
}
