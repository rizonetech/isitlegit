# Day-zero case capture

Loupe 1.1's training data includes the cases Is It Legit's users have checked, which production keeps for 30 days. This copies each case, read-only, into the private training store under `capture/1.1/` so it outlives that. It is D03 T04 §34. The code is `scripts/glimmer/capture-cases.ts` (collection, privacy, persistence, stats) and `scripts/glimmer/capture-source.ts` (the Wrangler reader).

Capture is private. It never calls the page importer or training, nothing in the repository holds a case, and the store is never deleted from (the operator's rule, 2026-10-31). Admission of any capture to a model pipeline is a separate, authorised step.

## Sources

| What | Source | Read by |
|---|---|---|
| Case | `cases` (id, org, channel, source_kind, status, verdict, run_id, forwarded_by, uploaded_by, original_* header fields, upload name and type, message id, times) | keyset page on `id`, 50 per page |
| Raw mail, renders, crops, pages, attachments, audio | `artefacts` rows, bytes from R2 `isitlegit-artefacts` by the row's `r2_key` only | one object at a time |
| Evidence and check outcomes | `evidence`, `check_outcomes` for the case's current run, `COALESCE(cases.run_id, cases.id)` | fixed SELECT |
| Verdict | `case_verdicts` | fixed SELECT |
| Member feedback | `feedback` (kind, note, providers, times, user id) | fixed SELECT |
| Who checked it | Better Auth `user` joined to `member` by `uploaded_by` or the forwarding address | fixed SELECT |

The reader holds fixed single-statement SELECT templates. The only variable parts are ids matched against `^[A-Za-z0-9_-]{1,100}$`, so no SQL can be passed in. Production is never written. A payload never enters argv or a log: R2 objects go to a private temporary file inside the capture folder and are removed.

Category and lure type are `null` unless a validated source field supplies them. Nothing infers ground truth from free text.

## Privacy

The recipient is whoever checked the case: the forwarding address, the uploading member, and every name in the message's own recipient headers (`To`, `Cc`, `Bcc`, `Delivered-To`, `X-Original-To`). Their address, in the forms a link or header carries it (plain, percent-encoded, base64, base64url, hex), and their name pieces are what every policy removes.

Coordinator decisions, 2026-10-31 21:44 SAST:

1. **Verdict mapping.** A case that is `malicious` with no `false_alarm` feedback takes the phishing rule: the sender's signals stay (sender addresses and domains, authentication results, link hosts and links, attachment hashes) and only the recipient is replaced. Every other case, `safe`, `suspicious`, pending or unknown, takes the genuine rule: the existing redaction (`redact.ts` and the entity pass), with headers, authentication results, links and hashes kept.
2. **A later `false_alarm`.** The case is then genuine mail. Its earlier phishing revisions are redacted in place to the genuine rule: the record, its hashes and its labels stay, and the recipient-identifying text is replaced. No unredacted copy remains in quarantine or anywhere else. This is redaction, not deletion, so the never-delete rule holds. The manifest records `redacted_in_place`.
3. **Binary and raster data** that cannot be cleared of recipient identifiers is withheld. Its hash, media type and size stay, and the stats count it. There is no binary sanitiser in this version. An upload whose uploader record no longer exists cannot be certified, so all of its payloads are withheld.

Mail is parsed structurally (postal-mime) and cleaned part by part. JSON is walked leaf by leaf, never run whole through the prose redactor, and hashes and authentication values are left byte for byte.

## Layout

```text
capture/1.1/
  cases/<case id>/<fingerprint>/{manifest.json, record.json, p0.json ...}   one folder per distinct state of the case
  cases/<case id>/LATEST.json                                                the revision stats count
  stats.json, STATS.md                                                       counts only, from each case's latest revision
  last-run.json, runner-status.json                                          counts and case ids only
  .lock, .runner.lock                                                        single writer
```

A revision's fingerprint hashes the canonical case row, the current run's evidence and outcomes, the verdict, every artefact descriptor, every feedback row (the note by its hash), the recipient dictionary's digest and the policy key. A changed verdict or new feedback makes a new revision; an unchanged rerun adds nothing.

A revision is built under a `.tmp-<pid>-` folder and published by one rename; the `LATEST.json` pointer is written atomically after it. A temporary folder whose writer is gone is removed on the next run. An unreadable or missing object leaves the case unpublished and retryable on the next run. A digest that does not match its record fails the case. Permissions are `0700` on folders and `0600` on files, and the root must lie outside every git work tree after symlinks resolve.

## Running it

`node scripts/glimmer/capture-cases.ts [--limit N]` runs once. The runner `scripts/glimmer/capture-run.sh` pins cores 0 and 1, refuses under 3000 MB of available memory (exit 75, status `deferred`), takes a single-instance lock and records `ok`, `failed` or `deferred` in `runner-status.json`.

The user units are `scripts/glimmer/systemd/isitlegit-capture.{service,timer}`, installed to `~/.config/systemd/user/`. The timer runs 5 minutes after boot (the start-up sweep, well inside the 30-day expiry) and daily at 03:30, with `Persistent=true`. A deferred or failed run is retried every 15 minutes, up to 4 times in 6 hours. Disabling the timer leaves the store as it is.

Install and check:

```sh
cp scripts/glimmer/systemd/isitlegit-capture.* ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now isitlegit-capture.timer
systemctl --user list-timers isitlegit-capture.timer
```

## First live run

2026-10-31 22:36 SAST: a real read-only run saw 8 cases (email 3, upload 5; all `suspicious`), captured all 8, and found nothing failed, waiting or withheld (21 raw payloads kept, no recipient address left in a recipient header). The timer is enabled; its next runs are listed by `systemctl --user list-timers isitlegit-capture.timer`. Category and lure type are `unknown` for all 8: no source field supplies them.
