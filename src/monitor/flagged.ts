// The pages §4 takes its walkthroughs from (D05 T04 §9): the organisation's current-capture lures screened at or after
// `since` that Spark did not decline. A confirmed flag, one Spark could not look at again (`unavailable`), one Spark
// screened itself and one stored before the second look existed (`second_look` NULL) all stand; only a declined flag, a
// likely false positive, stops before the walkthrough.
export type Flagged = {
  domain: string;
  capture_key: string;
  lure_type: string;
  confidence: number;
  screener: "glimmer" | "spark";
  second_look: "confirmed" | "unavailable" | null;
  screened_at: string;
};

export async function flaggedForWalkthrough(db: D1Database, orgId: string, since: string): Promise<Flagged[]> {
  return (
    await db
      .prepare(
        `SELECT s.domain, s.capture_key, s.lure_type, s.confidence, s.screener, s.second_look, s.screened_at
         FROM monitor_screens s
         JOIN monitor_hosts h ON h.org_id = s.org_id AND h.domain = s.domain AND h.capture_key = s.capture_key
         WHERE s.org_id = ? AND s.lure = 1 AND s.screened_at >= ? AND (s.second_look IS NULL OR s.second_look != 'declined')
         ORDER BY s.screened_at, s.domain`,
      )
      .bind(orgId, since)
      .all<Flagged>()
  ).results;
}
