-- Repairs the rows D01 T02 §6's first deployment wrote before D01 T02 §9's fixes (probe 3, 2026-10-30): the analytics give
-- some addresses with their angle brackets, so domains were stored as `isitlegit.co.za>`; and a refusal's second notice, a
-- second after the first, became an incident of its own with no forward ("not found"). The code now reads the address
-- inside the brackets and folds such a notice into its refusal (src/mail/forwarding.ts); these rows are made to say what
-- the fixed code would have written. No alert is sent again.
UPDATE forward_incidents SET sender_domain = trim(sender_domain, '<> ') WHERE sender_domain GLOB '*[<>]*';
UPDATE forward_incidents SET destination_domain = trim(destination_domain, '<> ') WHERE destination_domain GLOB '*[<>]*';
UPDATE forward_seen SET sender_domain = trim(sender_domain, '<> ') WHERE sender_domain GLOB '*[<>]*';
-- A refusal with no forward of its own beside a refusal of the same subject and destination that has one, within five
-- seconds (NOTICE_SPREAD_MS): its notices are counted on that refusal, and its row goes. An incident tied to a forward is never folded, and a second run changes nothing (every statement matches only the shapes it repairs).
UPDATE forward_notices
SET incident_key = (
  SELECT s.key FROM forward_incidents i
  JOIN forward_incidents s
    ON s.kind = 'refused' AND s.key <> i.key AND s.alias IS NOT NULL AND s.subject_hash = i.subject_hash
    AND s.destination_domain IS i.destination_domain
    AND abs(julianday(s.occurred_at) - julianday(i.occurred_at)) * 86400000 <= 5000
  WHERE i.key = forward_notices.incident_key
  ORDER BY s.occurred_at LIMIT 1
)
WHERE incident_key IN (
  SELECT i.key FROM forward_incidents i
  WHERE i.kind = 'refused' AND i.alias IS NULL AND i.forward_hash IS NULL AND i.alert <> 'waiting' AND EXISTS (
    SELECT 1 FROM forward_incidents s
    WHERE s.kind = 'refused' AND s.key <> i.key AND s.alias IS NOT NULL AND s.subject_hash = i.subject_hash
      AND s.destination_domain IS i.destination_domain
      AND abs(julianday(s.occurred_at) - julianday(i.occurred_at)) * 86400000 <= 5000
  )
);
DELETE FROM forward_incidents
WHERE kind = 'refused' AND alias IS NULL AND forward_hash IS NULL AND alert <> 'waiting'
  AND key NOT IN (SELECT incident_key FROM forward_notices)
  AND EXISTS (
    SELECT 1 FROM forward_incidents s
    WHERE s.kind = 'refused' AND s.key <> forward_incidents.key AND s.alias IS NOT NULL
      AND s.subject_hash = forward_incidents.subject_hash
      AND s.destination_domain IS forward_incidents.destination_domain
      AND abs(julianday(s.occurred_at) - julianday(forward_incidents.occurred_at)) * 86400000 <= 5000
  );
