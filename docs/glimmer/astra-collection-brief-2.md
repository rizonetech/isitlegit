# Astra collection brief 2: more lure datasets for Loupe

This is the prompt `scripts/astra-collect.py --brief docs/glimmer/astra-collection-brief-2.md` gives GPT-6 Astra (D03 T04 §27). It is the second sweep, for Loupe 1.1: the first (`docs/glimmer/astra-collection-brief.md`) and §18's sources made Loupe 1.0, whose collection is frozen, so nothing this sweep brings reaches Loupe 1.0; it is for 1.1 alone, and it is wanted for its fake pages. You run in a write sandbox rooted at the Loupe data store's `raw/` folder, with network access. Your working directory is that folder, and every path in this brief is relative to it: `<source>/` means `./<source>/`, never `raw/<source>/`. You never touch the IsItLegit repository. Claude, a different model, checks every licence and file you report before anything is used, so report exactly what you did and found.

## Goal

Find and download public datasets of fake web pages that train Loupe, a model that judges whether a page is a fake. Each item needs a screenshot or the page's HTML (or both) and a label. Wanted most, in this order:

- fake shops and scam websites: invented shops, too-good prices, non-delivery, counterfeit goods;
- impersonation pages: lookalike company, supplier, bank, courier, government or social network pages built to pass as a real one;
- phishing pages that copy a brand's sign-in or payment page, labelled with the brand they copy;
- tech-support, investment, crypto, delivery-fee and tax-refund scam pages;
- phishing kits whose pages are shipped as HTML (a kit's HTML only: never run its code).

Pages from or about South Africa are worth more than any others: say so for each source that has them. Benign pages are not wanted in this sweep unless a source pairs them with its fakes.

## Already decided: do not research again

Every source below is decided (accepted for Loupe 1.0 or 1.1 or rejected, each with its reason in `docs/glimmer/sources.md`). Skip each, and skip any copy or mirror of one: `scamferret`, `phreshphish`, `phishpedia`, `phishintention`, `visualphishnet`, `pilwd-134k`, `phish360`, `mendeley-online-shops`, `elfw-2031`, `sa-attack-surface`, `yadav-2025`, `phishvn`, `7-days-later`, `compphish`, `ariyadasa-2021`, `kempf-html`, `look-for-mallory`, `shresthsamyak-phishing-screenshots`, `seirin16-dataset-phising`, `nyuuzyou-phishing-snapshots`, `putra`, `putra-phishing-website-dataset`, `van-dooremaal-ares-2021`, `van-dooremaal-ares-2021-dataset`, `what-is-in-phishers`, `phishingeval-ji`, `phishingeval-ji-usenix-2025`, `phish-blitz`, `scrapio-comprehensive-phishing-dataset-c`, `give-and-take-imc-2024`, `mal2-fake-shop-corpus`, `doppelcart-fake-shop-network`, `double-and-nothing-cryptoscamtracker`, `lnu-phish`, `dynapd`, `phishdecloaker`, `phishdecloaker-datasets`, `phishark2026`, `mtlp-multitext-lp`, `web2vecphishingdataset`, `aljofey-comprehensive-phishing-detection`, `ninoseki-phishing-kits-2021`, `phikita-500`, `faizkhan790-brand-impersonation-dataset`, `gpm123-phishing-screenshots`, `puyang2025-phish-html`, `phish-iris`, `phishlang`, `asifejazitu-phishing-dataset`, `cic-trap4phish-2025`, `zackyzac-phishing-html`, `zackyzac-phishing-screenshots`, `niklas-lange-html-url-metadata`, `rohith-reddy-website-screenshots`, `abhinavsarkar-phising-site-datasets`, `circl-phishing-screenshots`, `htmlphish`, `saferoute-scam-screenshots`, `desant-loginpagephishingvsbenign-2026`, `arelit-phishnchips`, `ealvaradob-phishing-dataset`, `phishvision-zero-day-corpus`, `phishcan-canadian-phishing-dataset`, `safehousetech-phishing`, `phishycontent`, `electric-sheep-africa-phishing`, `vlbrandphish-vlbp-set`, `learning-to-complete`, `negative-content-detection-model`, `phishload`, `crimson-cryptocurrency-investment-scams`, `phishinpatterns`, `phishingkittracker-lookup-mitchellkrogza`, `phishingkittracker-lookup-t4d`, `phishunt-phishing-kit-lookup`, `0xdaniellopez-phishing-kits`, `leaky-kits-phishingkitanalysis`, `phishoracle`, `phishingkittracker-lookup-marcoramilli`, `multimodal-llm-phishing-detection`, `claimed-anti-phishing-webpage-dataset-ze`, `threatadvphish`, `zero-day-post-rendered-html`, `aaditey-phishing-url-content`, `html-p-tags-preprocessed-dataset`, `ovi-phishing-website-detection-collectio`, `real-gradients`, `unimas-standard-offline-anti-phishing-da`, `tan-phishing-feature-evaluation`, `phishvit`, `deltaphish`, `saurabhwadekar-webphish-name-collision`, `webphish-look-before-you-leap`, `phishintentionllm`, `ows`, `ows-comprehensive-webpage-classification`, `knowphish-phishagent-tr-op`, `scam-check-south-africa`; also the Majestic Million and the Tranco list. A source whose name you do not recognise here may still be one of these under another title: check its release page against them before researching it.

## Where to look

Dataset archives and their search pages: Zenodo, Hugging Face datasets, Mendeley Data, Figshare, Kaggle (only a dataset whose licence is stated on its page; do not log in), Harvard Dataverse, IEEE DataPort open-access items, GitHub repositories of papers on phishing, scam-website and fake-shop detection from 2021 onwards, and the artifact pages of security conferences (USENIX Security, IEEE S&P, ACM CCS, NDSS, DIMVA, eCrime, ACSAC). Prefer a dataset's own release page over a copy.

## Licence rule

Download a dataset only when its licence allows use for training a model in a commercial product (for example MIT, Apache 2.0, BSD, CC BY 4.0, CC BY-SA 4.0, CC0, ODC-By, ODbL, GPL, or terms that say so in words). Do not download a dataset whose licence is research-only, non-commercial (CC BY-NC and the like), or unclear, including no licence at all: record it as rejected with the licence text you found and its link. A repository's code licence does not cover data hosted elsewhere. Quote the licence's operative sentence for every accepted source. This is the rule in the design spec, section 4.9.

## Safety rules

- Download only from the dataset's official page or the archive it links to.
- Never open, fetch or render a live phishing URL, and never visit a URL listed inside a dataset.
- Never execute, import or open with a program any file from a download; only download it, hash it, and list an archive's contents (`unzip -l`, `tar -tf`) to count its items.
- Never unpack an archive: Claude's converter extracts it with each entry confined to its folder and the expanded size bounded.
- Do not log in anywhere, accept a licence on someone's behalf, fill a form, or create an account. A dataset behind a sign-up or a request form is recorded as rejected with the reason `access by request`.
- Write nothing outside the folder you start in, and change nothing in a folder that already exists there (`scamferret/`, `phreshphish/`, `majestic/`, `benign/` and the first sweep's files are Claude's), except a folder this sweep made itself, which holds `.sweep-2` and which a rerun resumes.

## Output layout

One new folder per source, `<source>/`, where `<source>` is a short lowercase name with dashes that no existing folder uses; put an empty `<source>/.sweep-2` in it before its first download, so a rerun knows the folder is this sweep's. Each accepted source gets `<source>/COLLECTED.md` with these fields:

- `URL:` the page you downloaded from
- `Licence:` the licence's name
- `Licence quote:` the operative sentence, quoted exactly
- `Licence link:` where the licence text is
- `Files:` one line per file, its path under `<source>/`, its size in bytes and its SHA-256
- `Items:` the number of pages it holds, and how you counted them from the archive listing
- `Labels:` what the labels say (lure or not, the kind of scam, the brand copied) and where they are
- `South Africa:` whether it has South African pages, and roughly how many
- `Date:` when you downloaded it, in UTC

Each rejected source gets one line in `REJECTED-2.md` (a new file; leave the first sweep's `REJECTED.md` as it is): its name, URL, the licence or access text found, its link, and the reason.

## Recovery rules

- Every download is made with the downloader placed where you start: `python3 .fetch.py --url <url> --dest <source>/<name> --sha256 <the published SHA-256>` (`--md5 <hex>` where the dataset publishes only an MD5), with `--min-free 20000000000`, so the stop on free space below holds inside each download. A dataset that publishes neither digest is not downloaded: record it in `REJECTED-2.md` with the reason `no published digest`. It writes to `<source>/.partial/`, resumes an interrupted file from where it stopped, and moves a file into place only after its SHA-256 has been computed and its published digest matches; its last line is a JSON result, and only exit 0 means the file is in place. A source with more than one file is downloaded in one run, so the downloader starts once a source: write `<source>/.manifest.jsonl`, one line a file, `{"url": "<url>", "dest": "<source>/<name>", "sha256": "<the published SHA-256>"}` (`"md5"` where only an MD5 is published), then run `python3 .fetch.py --manifest <source>/.manifest.jsonl --min-free 20000000000`. It prints one JSON line a file in the manifest's order; exit 0 means every file is in place, 1 that at least one is not (its line says why), and 2 that the manifest was refused before anything was fetched. Write `COLLECTED.md` only after exit 0. A rerun is the same command: files in place report `present` and unfinished ones resume.
- `COLLECTED.md` is written last, through a temporary file and a rename, only when every file it lists is in place.
- A rerun skips a source whose `COLLECTED.md` hashes still match its files.
- A rerun keeps `.partial/` and runs `.fetch.py` again for each file of a source without a `COLLECTED.md`: it resumes an unfinished file and reports a finished one `present` without fetching it again. `.fetch.py` tries each file 3 times; make no retries of your own. This sweep resumes only the folders it made itself, those holding `.sweep-2`; it never changes a folder without one.
- A rerun that finds a `COLLECTED.md` whose listed file is missing or has a different SHA-256 renames it to `COLLECTED.invalid-<UTC stamp>.md`, deletes that source's other files except `.sweep-2`, and collects the source again; other sources are left as they are.

## Stop conditions

- At most 3 attempts per file; after the third failure the source is recorded as incomplete with the error.
- At most 5 GB per source and 30 GB in all for this sweep; a source larger than 5 GB is recorded with its size and not downloaded.
- At most 40 candidate sources researched.
- At most 4 hours in all (the launcher also stops the run at 4 hours).
- Stop before a download when the disk holding this folder has less than 20 GB free.

Reaching any of these ends the run, with a report of what is complete and what is not.

## Report

Your last message is the run's report: every candidate you researched, accepted, rejected or left incomplete, one line each with its reason; the totals downloaded per source; and anything a reviewer should check first.
