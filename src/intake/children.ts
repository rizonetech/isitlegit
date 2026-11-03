// The fan-out manifest store (D01 T01 §12): which further originals of one forward became cases of their
// own, and how far each got. A row is written before its child is started, and a retry reads the same rows
// back, so the admitted set never changes under a retry and a refused original stays refused on the record.
export type ChildRow = {
  parentCaseId: string;
  position: number;
  childCaseId: string;
  format: "rfc822" | "eml" | "msg";
  state: "admitted" | "refused-cap" | "started";
};

type Row = {
  parent_case_id: string;
  position: number;
  child_case_id: string;
  format: ChildRow["format"];
  state: ChildRow["state"];
};

const toRow = (row: Row): ChildRow => ({
  parentCaseId: row.parent_case_id,
  position: row.position,
  childCaseId: row.child_case_id,
  format: row.format,
  state: row.state,
});

// Record one child of a forward, keeping the row a retry already wrote (its child case ID is the stable one).
export async function recordChild(db: D1Database, child: ChildRow): Promise<ChildRow> {
  await db
    .prepare(
      "INSERT INTO case_children (parent_case_id, position, child_case_id, format, state, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (parent_case_id, position) DO NOTHING",
    )
    .bind(child.parentCaseId, child.position, child.childCaseId, child.format, child.state, new Date().toISOString())
    .run();
  const stored = await db
    .prepare("SELECT * FROM case_children WHERE parent_case_id = ? AND position = ?")
    .bind(child.parentCaseId, child.position)
    .first<Row>();
  return stored ? toRow(stored) : child;
}

export async function markChildStarted(db: D1Database, childCaseId: string): Promise<void> {
  await db
    .prepare("UPDATE case_children SET state = 'started' WHERE child_case_id = ? AND state = 'admitted'")
    .bind(childCaseId)
    .run();
}

// A forward's children in the order their originals were attached.
export async function childrenOf(db: D1Database, parentCaseId: string): Promise<ChildRow[]> {
  const rows = await db
    .prepare("SELECT * FROM case_children WHERE parent_case_id = ? ORDER BY position")
    .bind(parentCaseId)
    .all<Row>();
  return rows.results.map(toRow);
}

// The forward a child case came from, or null when the case is no fan-out child.
export async function parentOf(db: D1Database, childCaseId: string): Promise<ChildRow | null> {
  const row = await db.prepare("SELECT * FROM case_children WHERE child_case_id = ?").bind(childCaseId).first<Row>();
  return row ? toRow(row) : null;
}
