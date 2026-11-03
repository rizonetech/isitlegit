-- Which tier settled a screened page and the first Spark call made for it (D03 T04 §45): the settling call stays in
-- spark_call_id, so an escalated page keeps both references and a plain failover reads back distinct from it.
ALTER TABLE monitor_screens ADD COLUMN tier TEXT;
ALTER TABLE monitor_screens ADD COLUMN spark_first_call_id TEXT;
