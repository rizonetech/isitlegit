# D04 T02 §11 completion disposition

Original approved plan: 37ed0e88199d4a19c1dd426efe33832761d7d554, genuine LOW plan digest5363a394b6e0de2b. Original implementation/completion candidate: 934fbcbaad28c82ab2d9a75c000d263b933220f4. Genuine combined MEDIUM completion at2026-11-04T14:19:33Z returned gaps, digestfed421b359fdef52, preserved verbatim in docs/reviews/04-agent/D04-T02-s11.md and committed at9886d45aa. The approved section and its obligations are unchanged. This document is a repair disposition, not approval.

## Every blocking finding

P2 finding1 identified two missing handled-failure paths under the existing interception/target-containment diagnostic obligation. No finding is deferred or reclassified.

- Interception frame refresh: when an unknown frame causes Page.getFrameTree rejection, refreshFrames already attaches frames.read identity but answer discarded it. The catch now retains that safe lexical diagnostic. The existing refused request row includes handledDiagnostics, and the request remains refused with no fetch and no terminal change. Regression `keeps a handled interception frame refresh failure in the existing refusal row` reads real D1 action_json and asserts operation/category/code, active driver state and zero fetches.
- Popup closure: Target.closeTarget rejection was discarded. The catch now retains containment.popup-close identity and the existing end record carries it, without turning a handled close failure into a terminal error. Regression `keeps handled popup close failure in the existing end record without changing terminal outcome` injects the rejected CDP operation after real popup bookkeeping and reads real D1 metadata, checking unchanged done outcome and absence of private exception text.

Handled metadata retains only the first diagnostic per two statically named operations, bounded by a two-entry map and max2 strict diagnostic array. Later existing records include the cumulative handled diagnostics with their original operation identity; this is not a mutable current-stage variable or attribution to the later record kind. Capturing metadata adds no write, await, retry or storage dependency. Existing terminal first-failure precedence, ordinary outcomes, 8-step/60-second limits, DNS/SSRF, canary-only input, downloads and interception remain intact. The action summary return annotation now states its existing object return type so record merging is type-checked; it changes no runtime behavior.

## Falsifiable evidence

Both new regressions failed on the original implementation: 2failed/27skipped in build/driver-handled-red.log. After repair, the unchanged five-file checkpoint passed86/86, including29 diagnostics tests,26 driver,11 Wonder loop,11 canary and9 URL-policy tests, in build/driver-handled-checkpoint.log. Full typecheck and dry build passed, as did targeted Biome, publication and diff checks. Logs: build/driver-handled-{types,build,biome-final,publication}.log. Existing local Chromium tests use stubbed request/model transports. No live probe, model spend, runtime incident-cause claim, CI or deployment is implied.

## Exact repair and intervening changes

The reconciliation candidate is the committed descendant containing this disposition and these exact repair blobs:

- `src/walkthrough/diagnostics.ts`: `3a536801972b64aeef518375f7bfb291372cc6f9`.
- `src/walkthrough/driver.ts`: `33ec90c173ba65f82803ca3382111f2b739c2242`.
- `test/walkthrough/driver-diagnostics.test.ts`: `2ec6739390cf9096c2132c0ae2ae42473af96a36`.

After original934fbcbaa, commit9886d45aa only preserved the returned completion report. This repair changes the three paths above and adds this disposition. Original report, plan, pin, completion binding and all call journals remain unchanged. There are no other product changes between the failed candidate and this repair. Earlier voice, URL, diagnostics20 and verification work on the branch retain their separate evidence and holds; this review does not release the whole branch.

The optional terminal WalkResult.diagnostic shape remains operation/category/optionalnetworkCode. The owning finite operation enum adds containment.popup-close; the earlier handover schema was explicitly bound to934fbcbaa and remains historical. The repaired source schema must be imported by the separately owned eval adapter, not copied or relabelled. Existing action_json adds optional handledDiagnostics for handled failures; no migration. Eval adapter implementation and live measurement remain explicitly outside this section, owned by eval/coordinator and gated separately. No ordinary completion repeat or additional regular round is requested. Only the supported first reconciliation may establish completion.
