# Nazario phishing corpus: attribution

The messages in this folder are from Jose Nazario's phishing corpus, mailbox `phishing-2025` (https://monkey.org/~jose/phishing/), licensed under the Creative Commons Attribution 4.0 International licence (CC BY 4.0, the full text in `LICENSE.txt` beside this file; https://creativecommons.org/licenses/by/4.0/). The corpus README reads: "The license for these files is CC-BY-4.0, enabling derivative works and commercial use but does require attribution."

Changes: 60 of the mailbox's 481 messages were drawn at random (seed 20261031), leaving out any that name a client of ours (18 were passed over), independently of whether our checks can see the attack. Each is stored as its own `.eml` file, byte for byte as the mailbox holds it, without the mbox `From ` separator line; nothing in a message was added, removed or altered. Of these, 58 are labelled in `eval/sets/nazario-2025/labels.json` (IsItLegit's own labels): 10 by the evidence our checks name, 48 as attacks only a model can see (basis `model`, D08 T01 §4); the other 2 wait unlabelled in `eval/pending/nazario-2025/` (`pending.json`, each with its reason), and `draw.json` there records all 60 with their hashes.

Taken 2026-10-31 (mailbox sha256 `f1fa7e0fe35c9a16f36d9aa20ade7e1d3908d1d0c1d917b8c53c8aa799ec1c8f`, last modified 2026-02-19).
