// Launch-terms review status (D07 T06 §8, §17). The operator approved the launch terms on 1 Nov 2026 (SAST, 2026-11-01, in
// the coordinator's session). While this is null `/terms` is marked as a draft awaiting Rizonetech review rather than
// claiming a completed review.
export const TERMS_REVIEWED_ON: string | null = "1 Nov 2026";

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
