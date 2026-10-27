# Meta smoke test

Run 2026-10-27T16:32:55.809Z by `node scripts/meta-smoke.ts --confirm-credit` (D00 T01 §7), through AI Gateway `isitlegit` with `store: false` and payload logging off. Result: **every check passed**. Spend so far US$0.008507 (estimate US$0.0745). No keys and no bodies are recorded here; excerpts are of answers about synthetic fixtures.

| Call | Model | Result | Wall ms | Meta tokens in / out | Gateway log: status, outcome, tokens in / out, duration | Cost (Meta usage) | Gateway cost | Excerpt | Detail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Spark text | `muse-spark-1.3` | passed | 3016 | 23 / 246 | 200, success, 23 / 246, 2650 ms | US$0.001074 | US$0.001074 | 51 | answered 51; metadata and a matching cost kept, no body |
| Spark image | `muse-spark-1.3` | passed | 3224 | 420 (355 cached) / 345 | 200, success, 420 / 345, 3110 ms | US$0.001601 | US$0.001601 | BSK-68M-WPD | read exactly the code printed only on the fixture; metadata and a matching cost kept, no body |
| SAM 3.1 | `sam-3.1` | passed | 1423 | 0 / 0 | 200, success, 0 / 0, 1377 ms | US$0.002500 | unavailable from the gateway; US$0.0025 per image | 1 box(es), best overlap 0.99 | 1 box(es); best overlap with the logo 0.99; metadata and Meta's counts kept, no body |
| Wonder | `muse-wonder-1.0` | passed | 2656 | 1809 (1780 cached) / 143 | 200, success, 1809 / 143, 2541 ms | US$0.003332 | US$0.003332 | click(640, 453) | clicked Continue at (640, 453); metadata and a matching cost kept, no body |
