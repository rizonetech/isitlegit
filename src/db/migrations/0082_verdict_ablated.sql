-- The ablation marker stored with a verdict (D04 T01 §14): the eval flag name (eval D08 T02 §3) when the
-- verdict was produced with a model contribution skipped, NULL for every ordinary verdict and for every
-- row stored before this column existed. Written once with the verdict; nothing else decides from it.
ALTER TABLE case_verdicts ADD COLUMN ablated TEXT CHECK (
  ablated IS NULL OR ablated IN ('no-agent-reasoning', 'no-walkthrough', 'no-sam', 'no-screening')
);
