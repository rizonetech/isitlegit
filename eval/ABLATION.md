# Durable upload ablation

The upload experiment runs one full baseline followed by four optional removals: verdict-agent reasoning, walkthrough, SAM comparison and voice transcription. Loupe screening runs in the monitor, so upload reports explicitly leave its contribution unmeasured. This command does not authorize a live experiment before the coordinator verifies the exact reviewed hooks and deployment.

Start with a positive cap per arm:

```sh
node eval/ablate-run.ts --cap-usd 1 --flags no-sam --set synthetic-sa --seed ablation-v1
```

Omitting `--flags` selects all four upload-supported arms. Omitting `--set` selects nazario-2025, synthetic-sa and synthetic-challenge. Selection is deterministic from the seed, with up to ten attacks and ten genuine samples per set, attacks distributed across categories. Challenge results remain separate. The command prints the sum of the arm caps; each arm also uses the existing eval runner's shared spend, admission and per-case accounting gates. No limit is raised automatically.

The existing eval-session cookie comes from `EVAL_SESSION_COOKIE`, never a command argument or log. The session must belong to the eval organisation alone. Before the baseline or any arm, the authenticated capability endpoint must advertise the exact deployed commit, durable context and every requested upload arm. `no-screening` explicitly refuses before upload. Missing attribution tables or consumer capabilities are refusals, not permission to run the ordinary pipeline.

The command prints the experiment ID and recovery command before dispatch. The manifest lives at `build/eval-ablation/<experiment-id>/manifest.json` and records the immutable population, digest, deployment, per-arm caps and stable replay identities. Resume with no overrides:

```sh
node eval/ablate-run.ts --resume <experiment-id>
```

Experimental baselines are stored as `ablate:full`, so an ordinary runner resume cannot strip their experiment context. The wire arm remains explicit `full`. Resume reads completed arms from D1, verifies case attribution, verdicts, times and ledger costs, and rebuilds the report from all comparable arms. It never invents a fresh arm identity after a lost response or uncertain insert. A server-confirmed, definitively unstarted RawMissing case may release its active sample binding and admit a replacement under the same experiment and arm; unknown outcomes retain the binding. Failed historical cases do not enter metrics. A changed population, deployment, cap or identity refuses rather than relabelling old work.

Progress uses validated temporary files, synchronization and replacement, with a kernel lock allowing only one command for an experiment. Linux/WSL with util-linux `flock` is required. Tests cover process and write failure recovery; they do not establish physical hardware power-loss guarantees. On disk errors, restore available storage and use the printed resume command. Do not edit caps or IDs inside a saved manifest.

Exit 0 means each selected arm either completed with verified comparable rows or was explicitly left unmeasured because its baseline did not exercise the model, with no arm upload. It does not mean every removed model was exercised: a model absent from the baseline's recorded successful calls remains `not measured`, never zero contribution. Cached responses are not new measured model calls. An unexercised model is not a reason to spend on another arm; its report has no run ID. Exit 2 means an arm remains incomplete; later arms have not started. Exit 3 means a precondition or read-back was refused. An existing results section is preserved on failure. The new table is published only after every arm verifies, and includes experiment, deployment and population identity while preserving other sections in `eval/RESULTS.md`.

Offline verification:

```sh
 taskset -c 0,1 pnpm exec vitest run --project node test/node/eval-ablation.test.ts test/node/eval-ablation-transport.test.ts test/node/eval-run.test.ts
```

The SQL adapter tests use all available migrations, plus an explicitly labelled contract fixture if checks' migration 0095 has not yet merged. That fallback verifies query semantics only, not deployed migration or consumer readiness. No test makes a paid model call.

Report publication uses one kernel lock for the shared results path, covering merge, atomic replacement and exact read-back for component and ablation writers alike. Cost is the mean model-ledger cost per measured check; the full row gives that mean and removed-model rows give its difference from the full baseline.
