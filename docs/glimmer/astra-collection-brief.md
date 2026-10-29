# Astra collection brief: public page datasets for Loupe

This is the prompt `scripts/astra-collect.py` gives GPT-6 Astra (D03 T04 §4). You run in a write sandbox rooted at the Loupe data store's `raw/` folder, with network access. Your working directory is that folder, and every path in this brief is relative to it: `<source>/` means `./<source>/`, never `raw/<source>/`. You never touch the IsItLegit repository. Claude, a different model, checks every licence and file you report before anything is used, so report exactly what you did and found.

## Goal

Find and download public datasets of web pages that train Loupe, a model that judges whether a page is a fake. Wanted, each with a screenshot and the page's HTML or visible text, and a label:

- phishing pages that copy a brand's sign-in or payment page, labelled with the brand they copy;
- fake shops and scam websites (invented shops, too-good prices, non-delivery scams), labelled as such;
- lookalike company, supplier or social network pages built to impersonate a real one;
- benign pages, the real pages the fakes copy, labelled benign.

Pages from or about South Africa are worth more than any others: say so for each source that has them.

## Candidate sources

Research these and any others you find: Phishpedia, PhishIntention, VisualPhishNet, PILWD-134K, and fake-shop and scam-website corpora (academic datasets of fraudulent online shops, scam-website collections). Prefer a dataset's own release page (the paper's project page, its GitHub repository or its archive record) over a copy.

## Licence rule

Download a dataset only when its licence allows use for training a model in a commercial product (for example MIT, Apache 2.0, BSD, CC BY 4.0 or CC0, or terms that say so in words). Do not download a dataset whose licence is research-only, non-commercial (CC BY-NC and the like), or unclear, including no licence at all: record it as rejected in `REJECTED.md` with the licence text you found and its link. Quote the licence's operative sentence for every accepted source. This is the rule in the design spec, section 4.9.

## Safety rules

- Download only from the dataset's official page or the archive it links to.
- Never open, fetch or render a live phishing URL, and never visit a URL listed inside a dataset.
- Never execute, import or open with a program any file from a download; only download it, hash it, and list an archive's contents (`unzip -l`, `tar -tf`) to count its items.
- Never unpack an archive: Claude's converter (D03 T04 §5) extracts it with each entry confined to its folder and the expanded size bounded.
- Do not log in anywhere, accept a licence on someone's behalf, fill a form, or create an account. A dataset behind a sign-up or a request form is recorded as rejected with the reason `access by request`.
- Write nothing outside the folder you start in.

## Output layout

One folder per source, `<source>/`, where `<source>` is a short lowercase name with dashes (`phishpedia`, `visualphishnet`). Each accepted source gets `<source>/COLLECTED.md` with these fields:

- `URL:` the page you downloaded from
- `Licence:` the licence's name
- `Licence quote:` the operative sentence, quoted exactly
- `Licence link:` where the licence text is
- `Files:` one line per file, its path under `<source>/`, its size in bytes and its SHA-256
- `Items:` the number of pages (screenshots) it holds, and how you counted them from the archive listing
- `Labels:` what the labels say and where they are
- `South Africa:` whether it has South African pages, and roughly how many
- `Date:` when you downloaded it, in UTC

Each rejected source gets one line in `REJECTED.md`: its name, URL, the licence or access text found, its link, and the reason.

## Recovery rules

- Every download is made with the downloader placed where you start: `python3 .fetch.py --url <url> --dest <source>/<name> --sha256 <the published SHA-256>` (`--md5 <hex>` where the dataset publishes only an MD5), with `--min-free 10000000000`, so the stop on free space below holds inside each download. A dataset that publishes neither digest is not downloaded: record it in `REJECTED.md` with the reason `no published digest`. It writes to `<source>/.partial/`, resumes an interrupted file from where it stopped, and moves a file into place only after its SHA-256 has been computed and its published digest matches; its last line is a JSON result, and only exit 0 means the file is in place.
- `COLLECTED.md` is written last, through a temporary file and a rename, only when every file it lists is in place.
- A rerun skips a source whose `COLLECTED.md` hashes still match its files.
- A rerun keeps `.partial/` and runs `.fetch.py` again for each file of a source without a `COLLECTED.md`: it resumes an unfinished file and reports a finished one `present` without fetching it again. `.fetch.py` tries each file 3 times; make no retries of your own.
- A rerun that finds a `COLLECTED.md` whose listed file is missing or has a different SHA-256 renames it to `COLLECTED.invalid-<UTC stamp>.md`, deletes that source's other files, and collects the source again; other sources are left as they are.

## Stop conditions

- At most 3 attempts per file; after the third failure the source is recorded as incomplete with the error.
- At most 5 GB per source and 20 GB in all; a source larger than 5 GB is recorded with its size and not downloaded.
- At most 30 candidate sources researched.
- At most 4 hours in all (the launcher also stops the run at 4 hours).
- Stop before a download when the disk holding this folder has less than 10 GB free.

Reaching any of these ends the run, with a report of what is complete and what is not.

## Report

Your last message is the run's report: every candidate you researched, accepted, rejected or left incomplete, one line each with its reason; the totals downloaded per source; and anything a reviewer should check first.
