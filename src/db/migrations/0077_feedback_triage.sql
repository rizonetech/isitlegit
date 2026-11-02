-- Operator triage of "this verdict is wrong" reports (D07 T08 §5): the New, Triaged and Closed tabs of the
-- feedback queue with the triage note. No resolved_at: the board triages with actions, not a toggle. A row changed
-- after it was triaged reads as new (`updated_at` past `triaged_updated_at`), so an operator never closes words they
-- have not seen; the operator's note is kept. Additive only: existing rows read as new with no note.
ALTER TABLE feedback ADD COLUMN triage TEXT NOT NULL DEFAULT 'new'
  CHECK (triage IN ('new', 'triaged', 'closed'));
ALTER TABLE feedback ADD COLUMN triage_note TEXT CHECK (triage_note IS NULL OR length(triage_note) BETWEEN 1 AND 1000);
ALTER TABLE feedback ADD COLUMN triaged_updated_at TEXT;
