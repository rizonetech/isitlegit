# Meta smoke test

Run 2026-10-27T16:23:52.515Z by `node scripts/meta-smoke.ts --confirm-credit` (D00 T01 §7), through AI Gateway `isitlegit` with `store: false` and payload logging off. Result: **every check passed**. Spend so far US$0.016320 (estimate US$0.0745). No keys and no bodies are recorded here; excerpts are of answers about synthetic fixtures.

| Call | Model | Result | Wall ms | Meta tokens in / out | Gateway log: status, outcome, tokens in / out, duration | Cost (Meta usage) | Gateway cost | Excerpt | Detail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Spark text | `muse-spark-1.3` | passed | 2710 | 23 / 181 | 200, success, 23 / 181, 2343 ms | US$0.000798 | US$0.000798 | 51 | answered 51; metadata and a matching cost kept, no body |
| Spark image | `muse-spark-1.3` | passed | 3016 | 420 / 471 | 200, success, 420 / 471, 2889 ms | US$0.002527 | US$0.002527 | BSK-68M-WPD | read exactly the code printed only on the fixture; metadata and a matching cost kept, no body |
| SAM 3.1 | `sam-3.1` | passed | 2007 | 0 / 0 | 200, success, 0 / 0, 1954 ms | US$0.002500 | unavailable from the gateway; US$0.0025 per image | 1 box(es), best overlap 0.99 | 1 box(es); best overlap with the logo 0.99; metadata kept, no body |
| Wonder | `muse-wonder-1.0` | passed | 3488 | 1809 (116 cached) / 185 | 200, success, 1809 / 185, 3362 ms | US$0.010495 | US$0.010495 | click(640, 446) | clicked Continue at (640, 446); metadata and a matching cost kept, no body |
