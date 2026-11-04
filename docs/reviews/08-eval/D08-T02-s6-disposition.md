# D08 T02 section 6 completion-gap disposition

Original plan candidate: `353dd9e298f2c38b9904f5283e77ea60d7d63f89`. Original completion candidate: `ef1c3e960e8c1dcb6dc9edae252380fb394e084c`. Canonical record: `docs/reviews/08-eval/D08-T02-s6.md`; original pin `0bb45776a2b27198b4bb6e41128b2ff411cac1e7`, the dispatcher must bind the actual recorded completion digest. The original completion remains `COMPLETION: gaps`.

1. Original gap1, missing-in-scope: recoverable staged corpus publication. Approved requirement: reliable regeneration, validated manifest/file hashes and truthful read-back, without destroying the last usable corpus. Disposition: repaired at `f7780c0509aec017723054c72cde3f83dc39e23a` through a verified sibling stage, prior-generation retention, rollback on promotion failure and recovery after process termination. `test/node/eval-forensics.test.ts` tests disk-full injection, malformed/truncated stages, actual SIGKILL at write/save/promotion, concurrent builders, kernel-lock release and retry. These tests retain their assertions after the CI path correction. They prove process/write/concurrency behavior, not machine-crash durability.
2. Original gap2, in-scope excellence recovery target: the same underlying defect as gap1. Its target is met by the same staged publication and real failure/restart evidence; it is not dismissed as optional or counted as a different completed feature. D08 T02 §18 owns the genuine repair/verification chain and remains unstamped until its own supported reconciliation succeeds.

Original round1 P2 required a resolving reference for measured misses. D06 T02 §8 was verified in console plan commit20f4747f and recorded before the original completion; that reference remains in generated results. Filing is not detector repair. All four original plan gaps retain their original dispositions in the canonical record; no native-PDF population, denominator, severity floor or real-byte checkpoint is removed.

Current supported-gate blocker: main's verified reconciliation binding compares the original section contract byte-for-byte. The current §6 names the corrected manifest location and adds truthful completion/CI notes, so that check would refuse. The actual obligations remain intact but the storage-path correction is a real necessary integration repair. Coordinator must establish a supported disposition for that identity change. Do not restore the defective corpus location, fabricate labels, filter it from the mail loader, alter the original receipt or bypass the binding to make a stamp pass.

This is a committed disposition proposal, not a review receipt or acceptance. Original review bytes, pins and failed verdicts remain in their canonical files. Coordinator D00 T01 §35 is locally verified on main but not installed in this lane; no reconciliation call has been made. No additional ordinary round or completion pass is authorized.

Current repair candidate: `d7e3d125ba1df127287cd9a0294aa2ae1111d97e`. The CI storage correction moves native PDFs from the mail-only `eval/sets/` tree to `eval/forensics/sets/pdf-forensics/`, changes the producer and scorer defaults, moves the local recovery paths, updates manifest paths and current report, and adds a build-plus-mail-loader regression. All six PDF byte hashes and all external fixture pins are unchanged. The original published PDF section is preserved exactly in `eval/forensics/history/2026-11-04-before-corpus-relocation.md`. Local remeasurement remains 3/7 detections, 0/7 false positives and 13/14 complete coverage; 40 raster inputs remain excluded. No detector, severity rule or safety boundary changed. D06 T02 §8 remains the sole detector/coverage follow-up; its diagnostic delivery does not establish repaired targets.

Verification at this repair boundary: the new generation-plus-mail-loader test failed on the old location, then passed after the source relocation. `taskset -c 0,1 pnpm exec vitest run --project node test/node/eval-forensics.test.ts test/node/eval-frontier-digits.test.ts test/node/eval-datasets-doc.test.ts test/node/eval-synthetic.test.ts test/node/eval-totals.test.ts` passed 128 tests, including 21 forensic tests. Actual default `node eval/forensics/build.ts` and `node eval/forensics/score.ts --check eval/RESULTS.md` passed. Full typecheck, lint, dry-run build and publication checks passed. Existing 21 shared lint warnings, 2 infos and asset-route warning remain disclosed. CI41805781547 and41809060857 are failed historical evidence, not approval; the newly pushed candidate needs its own green CI. No model call or deployment is claimed.

Intervening committed history, including unrelated ablation, paired CLI, coordinator merge and Wonder plan preparation, is disclosed below. Review the owned repair paths against the original candidate; this list grants no approval to unrelated unfinished sections. The current uncommitted Wonder implementation is excluded from the repair candidate and must remain quiescent during any review.

```text
447fb1fe892693867537a2a04e53a5f22916637c todo: record the Remotion licence basis (D10 T01 §2)
a1e6224d6fe209d8caddfa3f258e57a119407ccb media: @DerickPayneDev YouTube channel banner (D10 T01 §10)
3771e07e24a76c9ed588741f8cabf9b1d5d284e5 launch: demo script and demo mode
ca89308dad2cf15f4846a655793864b2dec8e0a0 media: demo title cards and architecture animation
e3b2adb64135f6a17d23c5997bfd78e56a5e5045 media: judge getting-started video (D10 T01 §8)
cd18eb5dab12d1e01728ed6f80383615db482463 media: 45-second X viral teaser clip (D10 T01 §9)
f270f9603d888a43daa601222f5519e2305dadfd Merge remote-tracking branch 'origin/main' into claude/trusting-pasteur-umwvqz
0942cfec13ae570a34836395d1b88350b38f84c8 media: video 03 approved and rendered (D10 T01 §6)
1f60c5acba5f9d2baf26615d090f8f09b5e56e0c media: video 02 approved and rendered (D10 T01 §4)
006f87155b8fbb6a7dd8ec341406d7da7acbc5db media: video 01 approved and rendered (D10 T01 §3)
ed58f73ad0ffbbc2bd39fb49228d5e25efe1dc5a invoice: standalone payment document path
c737a641aaf84c7629e693c2c02544fdc72d96a2 invoice: standalone payment document path
d7748b83eb1584570f1c0a86eec841e32cffd69a invoice: skip mail checks on standalone document emails and retain forensics on retry
f93b1d3db5973d7dabef4dac88936c42f4a011f4 invoice: close D06 T02 §3 completion review gaps
fb12a5ba4557e4c2ae5bd53044b02af427d757ef media: master renders with one fixed gain and a look-ahead limiter, into out2
78f1615a4e6134aacb19e194cba9892cb538a5dc media: the real Meta logo, and a one-line attribution
7889b2150ddd50def2a35a7e71fc185f8201e685 media: capture the report's trace view, the verify, results and monitor pages, and redo one beat
a3443871f9862aa4221d11aec952bfc52ecbdd9c invoice: close D06 T02 §3 review round 1 findings
a94b0a7ff620bd0b41e37b59d5bda2bcd343eb1e media: demo rebuilt around the live product, with the operator intro, timing from the narration and captions under the window
b901db750dd36f2d7cc1e0c389d8046bf2deb5dd media: judge guide on the live service; the X teaser is now a cut of the demo
3497877dedc91ef3b9b8913509bcf8c03d60e2c1 media: new @DerickPayneDev channel banner
dcf433c283a4280b65e0004764a0305b23a5c86a invoice: close D06 T02 §3 review round 2 finding
121ab1347de2d14ecd171ff7797e5c78dcfdea1f launch: demo script matches the rebuilt cut
754b7c951d43cde378494a588b5a8b3f3b033e3d todo: record the rebuilt demo, judge guide and teaser
af114bcd312a9342260bf08616308ba3c33ff162 invoice: close D06 T02 §3 review round 3 finding
2e99b5d43a2519a0a812a28abc6f5f3ea3790f0c invoice: close D06 T02 §3 review round 4 finding
93786a298123f19da4d76f8ffdf3102aeeb03ed6 Merge remote-tracking branch 'origin/main' into checks-lane
dba84ac011e0ee8541e4440c7474085c693abf8f todo: file the videos' re-cut as the live gaps close in D10 T01 §11
d9fc8e7665067c2fa4b8e46683be49d3b0a37a22 invoice: close D06 T02 §3 review round 5 finding
08d2dedf5463166950370cd5c88e5cd28c0e2261 todo: start D07 T09 §19
e7e264bd430c18562173816b0fe8baf89c7e99bb Merge remote-tracking branch 'origin/main' into claude/trusting-pasteur-umwvqz
21a7d26e90968be937f2a1417573cfc6c5c3f7d8 invoice: close D06 T02 §3 review round 6 finding
348f8346f2f35dad2c382c387ea8259b52d8836d invoice: cap D06 T02 §3 review record at 3-round schedule limit
4282400fc6933256a53e1e94961fd343a3a136c1 todo: stamp D06 T02 §3
204ac4ff00db10a4b69c0a395454ce09c535ea80 media: record the Remotion licence basis in the media folder and tighten its check
3b1f8e213d7ef3430896ffa10dab3e363a2765a7 chore(todo): start D02 T03 s12, D02 T05 s10, D01 T02 s10, D01 T02 s15
e703029c177feb6f527021a54daf48dd31c83a15 web: diagnostic detail on the early card
158ee45694c372196945b741366c201758bda593 todo: refuse a company-licence placeholder in the Remotion licence check
2fcbd55dd90a9662d640721cf1fce7d5c4916a5c web: assert per-case Type wording in desktop rows and phone cards (D07 T04 §13)
72828b04ca68559e0f29f4c0fbd1de795654b183 Merge branch 'console-lane'
f5f348d77a38b55ba94f5de697cbb1f198a1ca8f todo: stamp D10 T01 §2
c661d4d185a99c874a33947505703f8811eed767 web: record D07 T04 §13 review round
cc1c9adba35432f51fcc3d9b9fd515c6079c43f2 Merge branch 'claude/trusting-pasteur-umwvqz'
1f1c4883539ef4c255148bfe250af854255f1598 web(report): complete early card diagnostic details and tests for D07 T09 §19
20e7104720e9c8168b8f2697222ac5b9fefdbfa8 media: count only order rows, name the stats output, and test the collector end to end
f3ce39680d273f5929bdc099870190bc5c7514f7 todo: stamp D07 T04 §13
46c600ec2caa311aa6e5184bbd902bd6078dbd47 Merge remote-tracking branch 'origin/main' into console-lane
c72fb3bdfd172a59a11a16646addf1fc083259b9 media: preflight renders, cancel on a failed font, honour RENDER_CONCURRENCY, record stats inputs
92e7a0d8d82161ca3ad9479352bc0c793b0a26b7 test: widen linear-time CI wall-clock bound in instruction-phrases.test.ts
71572c0c42e8c2b01a22edcf7867f0576284f620 Merge branch 'console-lane'
5659dd45e9e7b68876e50c57e46c3ca77497647f media: generate the demo capture index before every render and the studio
f16bdfa44a4de61baad58834cf326395c5308885 web(report): fix compauth explanations and HELO derivation for D07 T09 §19 round 1
e9bd6e4142585cab5844b3b2c955de28e1bcc8fa web(report): add all documented compauth reason codes for D07 T09 §19 round 2
b6f283e6cbfe9da10c3aecd2bdea468b141233de checks, mail: lookalike compared summary, instruction shapes, retry reply, early refusal alert
0cc4aaa6d70111b18efe4bf18ddf23bd98d04bd6 todo(app): stamp D07 T09 §19
fa5a926b2b7744d016b4625b3878f0ed418dedcf Merge remote-tracking branch 'origin/main' into app-lane
5a76ef95fc9086fbbed367813a5b87ed08bd5e3b media: use Brian's voice settings across videos 01 to 03
35be5447b7a8bd3fed66bc39937f3bfd01d85873 media: stop thumbs script on the first failed thumbnail render
9a9b6fc37e9bffa13bbbadd61ff8eedd73594f3b Merge branch 'eval-lane'
2bffe56e3fd17f27e83051f6587c7c2d2f91a8b1 todo: stamp D10 T01 §1
b16034c9adda057b945f4d35a5cd001ec1b3a8ae Merge branch 'claude/trusting-pasteur-umwvqz'
1eebf7cc8d51b2e62a778da84dc81e4f713e9f2d todo: stamp D10 T01 §1
6c98d4022c1a01dbb10e33d023c71e6e0eccefd3 checks, mail: address completion review P2s for D02 T03 s12, D02 T05 s10, D01 T02 s10, D01 T02 s15
94022c58bf0966a7f8855ea63b6a2a782ce8923e Merge branch 'claude/trusting-pasteur-umwvqz'
c8370753d880a6164018ee3e1288ff39950f0815 test: align eval-run liveDb caseState walkthrough expectation with D08 T02 s8
544d3b946a162aab4c8623ea705379b3ebe86e90 fix(checks,intake): address round 1 review findings for D02 T03 §12, D02 T05 §10, D01 T02 §10, D01 T02 §15
55ae27be71fd4a021f0f32d9c29391c3465ffc27 test(intake): pause overlapping-scan test after early-send snapshot in D01 T02 §15
474ffe47b272ee331912d1aafd04ff100815607a Set up Codex coordinator and lane self-review
f62c57707aceb1bed94c5393f966fc840e71752e Delegate twelve-hour delivery decisions to coordinator
d018236a6e674dfb44be8c7e0a5b2a90815a4312 chore(todo): stamp D02 T03 s12, D02 T05 s10, D01 T02 s10, D01 T02 s15
f87b50d12eb23fb2a19ff5937445924d17fe3908 glimmer(1.1): record dataset 1.1 sha256 and training session launch
7b052b8ece9ebfbe234ffeab5b730cef11dfe3e9 Merge branch 'checks-lane'
580f4b4b12eee125c46aaf42aa8d60c5eb5a7d36 todo: scope PDF corpus publication recovery
f7780c0509aec017723054c72cde3f83dc39e23a eval: publish PDF corpora with recoverable generations
b1560b732543219b63fba47aebea93e84bacaa12 eval: record corpus recovery implementation review
a84a80aaca79ffda1715ba141605a4de90068ef6 todo: preserve recovery gaps and refine ablation contract
a7db96191483812a5b13e1411b3bb61aa719ebf7 todo: resolve ablation recovery plan gaps
391921d298817948ee0242519ac393da64010c2c eval: bind ablation runs to durable per-case identities
8aee6996154b05ee04a3470d4b16eddcbf09eb52 eval: serialize report publication and measure unit cost
586e499ef3938c4025b12c36e1157f2fe25c4f9e todo: verify durable per-case ablation repair
eb846e6df1db00289e109ebc3621e5dd93d4afd8 Merge remote-tracking branch 'origin/main' into eval-lane
c19945b3f6d5c8f41d6f290cfb86477a8b4bce48 todo: prepare paired evidence and separate replay packaging
04d0c09383895138f816ce675707acb87c317b9d todo: define paired finding alignment and command discovery
6e930b6db82693a888baf2aed84cf7f5535a27e7 eval: compare paired verdict evidence in the CLI
51ed642d2c712b89a0c0e29babcb6ddc33d69f52 todo: verify paired evidence CLI completion
8c28bc8ce8abd0087c1d87f81c640909ba98dae1 todo: define bounded multi-step Wonder experiment
60f271a5484a7d2f5e65986c16dfa8dcf2f9a197 todo: record Wonder experiment plan preparation start
57fc61508811e065a9ae7bdbd5b44c4e8d9ebdc6 todo: define capacity and lost-walk reconciliation
d7e3d125ba1df127287cd9a0294aa2ae1111d97e eval: keep native PDF corpus outside mail datasets
```
