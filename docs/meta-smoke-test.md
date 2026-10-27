# Meta smoke test

Run 2026-10-27T16:01:05.353Z by `node scripts/meta-smoke.ts --confirm-credit` (D00 T01 §7), through AI Gateway `isitlegit` with `store: false` and payload logging off. Result: **every check passed**. Total cost US$0.015093 (estimate US$0.0745). No keys and no bodies are recorded here.

| Call | Model | Result | Wall ms | Gateway ms | Tokens in | Tokens out | Cost (Meta usage) | Gateway cost | Detail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Spark text | `muse-spark-1.3` | passed | 3140 | 2732 | 23 | 190 | US$0.000836 | US$0.000836 | answered 51; metadata and a matching cost kept, no body |
| Spark image | `muse-spark-1.3` | passed | 1953 | 1829 | 420 | 270 | US$0.001672 | US$0.001672 | read the code printed only on the fixture; metadata and a matching cost kept, no body |
| SAM 3.1 | `sam-3.1` | passed | 1454 | 1392 | ? | ? | US$0.002500 | unavailable from the gateway; US$0.0025 per image | 1 box(es); best overlap with the logo 0.99; metadata kept, no body |
| Wonder | `muse-wonder-1.0` | passed | 2509 | 2399 | 1771 | 150 | US$0.010084 | US$0.010084 | clicked Continue at (638, 424); metadata and a matching cost kept, no body |
