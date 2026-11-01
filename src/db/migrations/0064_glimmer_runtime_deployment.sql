-- Which deployment a burst ran on (D03 T04 §32). Shared runtime is counted once only between bursts on the same
-- deployment: a promotion's probe wakes the new version's deployment while the serving one may be up, and two GPUs
-- running are two GPUs charged. Rows written before this column, and a NULL, are the first deployment, `isitlegit-loupe`.
ALTER TABLE glimmer_runtime ADD COLUMN deployment TEXT;
