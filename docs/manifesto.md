# Manifesto

Derick Payne, founder and CEO, Rizonetech (Pty) Ltd. Adopted 26 October 2026, the first day of the IsItLegit build.

## The standard

IsItLegit is held to the standard of the best product in its field, whoever built it. The size of a competitor is not a reason to accept less: one developer, directing AI agents under strict engineering discipline, can out-think, out-test and out-finish organisations with hundreds of engineers, and this project exists to prove it.

The measure of success is the reaction of the most demanding person who examines the work, whether a judge, a client, a security engineer or a competitor. They should finish their review asking how it was done this well. Anything that does not earn that reaction is unfinished, however well it works.

That standard applies equally to what people see and to what they never will: the verdict and the email that delivers it, the test nobody reads, the commit message, the error path that may never run.

## The first priority: push the boundaries of Meta AI

Above everything else, IsItLegit exists to show what Meta's models can do when they are pushed to their limits. Integrating a model is easy; making it do something nobody expected it could do, reliably and in production, is the work. The goal is that engineers at Meta see this project and learn something new about their own models.

- **Every model does what only it can do.** Muse Spark reasons over evidence with cited proof, Muse Wonder operates a hostile website in a contained browser, SAM 3.1 isolates a logo, stamp or signature for forensic comparison, Muse Voice Transcribe turns a voice note into a case, Muse Image generates the forgeries the system is tested against, and Muse Spark screens lookalike sites each day. No model is a decorative wrapper around work a regular expression could do.
- **Chain the models into one investigation.** The output of one model becomes evidence for the next: a segmented logo becomes a comparison, a walkthrough becomes a cited finding, a transcript becomes a checked claim. The whole is a capability no single model has.
- **Use the hardest capabilities, deliberately.** Computer use against adversarial pages, multimodal reasoning over rendered mail, structured outputs under schema, tool calling, reasoning effort chosen per task, open weights where they win. Each choice is recorded with why.
- **Prove each model earns its place.** The evaluation measures every model's contribution by removing it and measuring the loss in detection, false positives, speed and cost. A model that adds nothing is removed; one that adds a great deal is shown.
- **Make the capability visible.** The model trace on every report shows which model did what, on which evidence, at what cost and speed. A judge watching the demo sees each model at work, not a spinner.
- **Explore the edge every day.** Each build day includes one experiment at the limit of what the models can do. What works becomes a feature; what fails is recorded honestly with the evidence, because knowing where a model breaks is as valuable as knowing where it shines.

## Principles

1. **Push the boundaries of Meta AI.** The first priority, above: every model does what only it can do, chained into one investigation, measured and made visible.
2. **Excellence is the baseline.** "It works" is where a piece of work starts. It is finished when it is correct, proven, clear, fast and well made.
3. **Benchmark against the leaders.** For every surface and every check, identify the best comparable product (Microsoft Defender, Gmail, Proofpoint, Stripe, Apple) and be able to state precisely where IsItLegit is better. If that cannot be stated, the work is not done.
4. **Evidence over assertion.** Every claim, in a verdict, the README, the demo or a commit, rests on evidence: a cited header, a passing test, a measured result. We never describe IsItLegit as accurate; we state how accurate, on which data, measured when.
5. **Honesty in every direction.** Known limitations are documented, failures are reported as failures, and nothing is demonstrated that the live service cannot do. Credibility is the product: a security tool that overstates itself is worthless.
6. **Root causes, not workarounds.** Problems are fixed in the layer that owns them. A workaround is permitted only where the owning layer cannot express the fix, and it is named as one.
7. **Fewer things, done exceptionally.** A ten-day build forces choices. Scope is cut before quality: one flawless capability outweighs three adequate ones. The deadline is fixed, the standard is fixed, and only the scope moves.
8. **Polish is part of the work.** A small improvement that costs little is made now, not filed for later. Accumulated small refinements are what make the whole feel inevitable.
9. **Leave everything better.** Any file, test or document that is touched is left clearer, safer and better organised than it was found.

## Standards

The principles become concrete in these standards. Each is checkable, and reviewers check them.

### Security and privacy

- Every input is hostile until proven otherwise: mail, attachments, links, landing pages, transcripts and model output alike. The safety contract in `AGENTS.md` is never weakened to make a feature easier.
- Least privilege everywhere: each binding, token and key has only the access its job needs, and no secret ever appears in code, logs, fixtures or arguments.
- Collect the minimum, keep it for the shortest useful time, and delete it on schedule. Raw mail expires; a member's data never reaches another member.
- Think like the attacker first. Every feature is reviewed for how it would be abused before it is reviewed for how it is used.

### Reliability

- No failure is silent. When a model, a provider or a step fails, the member receives a clearly marked partial report, never a confident verdict built on missing evidence, and never nothing at all.
- Every step is safe to retry. A redelivered email or a restarted workflow never produces a duplicate reply, a second alert or a corrupted record.
- The service is observable: each case can be traced end to end, from intake to reply, with timings and model calls, without logging personal content.

### Quality of the result

- Accuracy is measured, not estimated, against the targets in the design spec (section 4.9): detection of at least 95 percent, false positives of at most 2 percent, a median forward-to-reply time under 60 seconds and under 3 minutes at the 95th percentile, and a median cost per check under US$0.05.
- A regression in any of these numbers blocks the change that caused it.

### Experience

- Every message is written for a busy small business owner reading on a phone: the verdict first, the reasons second, the action third, in plain words.
- Every state is designed: empty, loading, partial, failed and recovered. No screen shows raw errors, placeholder text or "coming soon".
- Accessibility meets WCAG 2.2 AA: keyboard reachable, readable contrast in both themes, an accessible name on every control.
- Speed is a feature. Pages render quickly on a mid-range phone on a South African mobile connection, and nothing waits on work it does not need.
- One design language: colours, type and spacing come from the design tokens only, so every surface reads as one product.

### Engineering craft

- Tests prove behaviour and are shown to fail when the behaviour breaks. Every fix ships with the regression test that would have caught it.
- Dependencies are few, pinned to exact versions, licensed for our use and recorded in `NOTICE.md`. Each one must earn its place.
- Every change is reviewed before it ships, and every review finding is verified against the code rather than accepted or dismissed on trust. For Codex work, the operator decision of 4 November 2026 uses plan self-review, one implementation self-review round and a final completion self-review; other writers keep independent review.
- Reversible decisions are made quickly; irreversible ones (data models, public interfaces, anything a customer depends on) are made deliberately and recorded with their reasoning.
- The repository is documentation in its own right: a newcomer can understand what the product does, why each decision was made and how to verify it, from the files alone.

## The final test

Before anything is called done, examine it as the most demanding expert who will ever see it. If they would not ask how it was done this well, it is not done.
