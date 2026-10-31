// The Cases list's search text kept current (D07 T04 §7): the rows stored before `cases.search_text` existed are folded
// by the 15-minute schedule, a bounded pass at a time. The folding itself is ./search-fold.ts.
import { searchText } from "./search-fold";

export { fold, SEARCH_TEXT_LIMIT, type SearchFields, searchText } from "./search-fold";

type Unfolded = {
  id: string;
  original_subject: string | null;
  original_from_name: string | null;
  original_from_address: string | null;
  upload_name: string | null;
};

// Folds the cases stored before the column existed (or written by a path that does not fold), `limit` a pass, from the
// 15-minute schedule: those with a covered field stored and no search text. A row changed since it was read keeps the
// newer write (the update only fills a text still missing). Returns how many it filled; 0 once none are left.
export async function refreshSearchText(db: D1Database, limit = 200): Promise<number> {
  const rows = (
    await db
      .prepare(
        `SELECT id, original_subject, original_from_name, original_from_address, upload_name FROM cases
          WHERE search_text IS NULL AND COALESCE(original_subject, original_from_name, original_from_address, upload_name)
            IS NOT NULL
          LIMIT ?`,
      )
      .bind(limit)
      .all<Unfolded>()
  ).results;
  if (!rows.length) return 0;
  await db.batch(
    rows.map((r) =>
      db.prepare("UPDATE cases SET search_text = ? WHERE id = ? AND search_text IS NULL").bind(
        searchText({
          subject: r.original_subject,
          fromName: r.original_from_name,
          fromAddress: r.original_from_address,
          uploadName: r.upload_name,
        }) ?? "", // a field that folds to nothing (marks alone) is still done, never picked again
        r.id,
      ),
    ),
  );
  return rows.length;
}

// The 15-minute schedule's pass (src/index.ts `scheduled()`): one bounded refill, its failure logged and swallowed so the
// schedule's other work goes on.
export async function scheduledSearchRefresh(env: { DB: D1Database }): Promise<number> {
  try {
    const filled = await refreshSearchText(env.DB);
    if (filled) console.log(JSON.stringify({ event: "case-search", outcome: "refilled", rows: filled }));
    return filled;
  } catch (error) {
    console.error(JSON.stringify({ event: "case-search", outcome: "refill-failed", error: (error as Error).name }));
    return 0;
  }
}
