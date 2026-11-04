# Compare evidence behind a changed verdict

Run the paired command printed beside a changed sample by `pnpm eval:metrics --compare <replay-run-id>`. The source and replay must be complete measurements of the same population. An unchanged or unknown sample is refused before evidence is read.

```sh
node eval/paired-evidence.ts --replay replay-run-id --sample synthetic-sa/example.eml
```

Use the existing authenticated `EVAL_SESSION_COOKIE` environment setting, never a command argument or a shared transcript. The member must belong to the eval organisation alone. `--json` produces the same public projection as deterministic JSON; `--help` needs no credentials. The command is read-only and makes no model calls.

Each side shows its permitted verdict, report route and public evidence grouped by check. Evidence IDs are local to a case. Exact summary/severity pairs match first, preserving duplicates; identical summaries with different severity are marked severity-changed. Other findings are added or removed, without guessing that a rewritten summary represents the same finding. Evidence differences do not establish why a model changed its verdict.

Exit0 means both sides were read. Exit2 keeps the available side readable and names the unavailable side's reason, without exposing its verdict, evidence or report address. Missing and inaccessible cases share a reason. A changed analysis is unavailable rather than shown beside an old measured verdict. Exit3 refuses invalid arguments, membership, stored runs or population pairing. On a transient read error, rerun the same command; it stores nothing. On an analysis change, remeasure through the existing eval workflow before pairing again.

The SQL reader selects only public summary fields, never raw detail JSON, registered bank records, artifacts or signed links. It checks current membership within the same statement that reads the case and its current analysis evidence. Local tests prove those query and command contracts with synthetic cases; they do not establish a live comparison.
