# Media audit and milestone release plan

Owner: coordinator. Delivery lane: media. Requested 4 November 2026. The corrected internal completion/polish target is 5 November 2026 at 00:00 SAST, with the actual deadline at 04:00 SAST (BRAIN-20261104-DEADLINE-02); neither authorizes incomplete or misleading output.

## Current authorization

Operator priority BRAIN-20261104-MEDIA-06: polish the main submission demo first, before supporting explainers. Current work remains planning/read-only audit; this priority does not lift the rendering hold.

Planning and inspection only. The operator has paused new video generation until the plan is settled and the relevant information or announcements are ready. Stop the active recovery render safely, retain completed outputs and logs, identify partial files as incomplete, and start no replacement render, narration generation or publication. Other development lanes and existing Loupe training continue. Only a later operator instruction lifts this render hold.

## 1. Establish what actually exists

Media inventories each existing video, demo, teaser, thumbnail and banner by path, hash, duration, dimensions, frame rate, audio presence, source commit and known capture/model version. Distinguish completed masters, raw renders, partial output and missing artifacts. Preserve originals; inspection must not silently overwrite them. Record which portions were actually watched or listened to, which received frame sampling or automated checks, and which remain unreviewed.

The coordinator audits the evidence and a representative set of rendered scenes before deciding improvements. Earlier agents' checkmarks, successful encoding and fact-file validation are not proof that the finished video is accurate, understandable or polished.

## 2. Audit content and viewing quality before brainstorming changes

Operator decision MEDIA-09: retain the current intro take, PiP layout and timing. No reshoot or aggressive sharpening. Modest colour correction remains conditional on demonstrated playback benefit and does not authorize generation now. Prioritize full normal-speed viewing/listening of the existing demo, recording artifact hash, reviewer, actual visual/audio coverage and timestamped findings. If audiovisual inspection capability is unavailable, prepare the exact existing file and review sheet for operator coverage; a launched player, sampled frames or audio measurements do not prove review. Findings drive final edits.

Produce a timestamped issue register for each artifact, covering the opening, story, real problem and user benefit, readability, pacing, transitions, diagram accuracy, actual product footage, model trace, evidence, limitations, ending and next action. Assess narration clarity and pronunciation, music balance, captions, scene/audio alignment and distracting pauses. Measure file integrity, duration, missing/black frames, layout clipping and the existing audio contract in `media/tools/master.py`; do not invent listening evidence from a waveform measurement.

For every spoken or visible factual claim, record its scene/time, exact evidence source, source date, implementation commit, deployed commit where relevant, and disposition: supported and current, supported historical, contradicted, unproven or absent. Inspect narration, graphics, captions, thumbnails and descriptions together. `check-facts.py` proves a pinned source match; an old source match alone does not prove a present-tense claim remains current.

Review the submission demo against the repository's recorded competition contract: no more than three minutes, working live behavior, synthetic data, meaningful Meta contributions and visible technical evidence. Keep development tools distinct from runtime models. Assess coverage of impact, Meta tooling, demo quality and technical execution. This is a quality rubric, not a prediction or guarantee of winning.

## 3. Form an evidence-based improvement brief

Operator correction MEDIA-08: provide direct recommendations, not an interview or tabletop exercise. Keep the main demo within180seconds and retain existing material unless a valuable addition needs the time. Recommend a minimal refinement of the existing164.352second demo, preserving PiP and useful footage, with factual correction and evidence readability first. Produce an actual-footage timestamped keep/change/cut plan and total duration before rendering; shorten decoder benchmarks only if the case evidence requires it.

Operator decision BRAIN-20261104-MEDIA-07: the main demo follows a suspicious email through evidence to a recommended action. Show model contributions only where verified by the actual trace/capture and version-bound facts. Detailed benchmarks can live in supporting explainers. Case selection is invoice-payment fraud (MEDIA-08); this is a structural planning decision, not narrative copy or authorization to render. The authorized narrative writer supplies any new copy.

After the audit, rank changes as release blockers, high-value story improvements or optional polish. For each proposed improvement, name the observed defect or missed opportunity, affected scenes, evidence needed, work owner, estimated effort and expected benefit to the judging rubric. Review alternative openings, proof sequences or cut lengths as written treatments first; do not render competing videos just to discover what the story should be.

Keep one primary submission demo and the existing supporting explainers as the default package. Add a variant only when it serves a distinct supported opportunity and fits the remaining time. New narrative or article copy follows the repository's writer rules; Codex reviews facts and proposes changes rather than silently rewriting restricted creative text. Existing approved text is not changed merely to make a number fit.

The coordinator consolidates the brief and recommends a concrete cut plan. The operator can discuss enhancements against actual findings. No generation begins while the current hold remains in force.

## 4. Collect changes continuously; release in meaningful batches

Maintain a media change register outside the release artifacts. Each entry records the event, verified source, affected claims/scenes, severity, owner and whether implementation, deployment, measurement or publication evidence is still missing. Lanes notify media through the coordinator at verified stamp, merge, deployment and evaluation boundaries. Training progress can be logged without triggering a video update.

Once rendering is authorized again, a batch is eligible when one of these conditions is met:

- A factual or safety contradiction invalidates a current candidate. Immediately mark that candidate unsuitable for upload; correct and review it before replacement generation.
- A major verified milestone changes the demonstration or story, such as a newly deployed core capability, a gate-passing model release, or a completed comparable evaluation.
- Several verified changes materially affect the same video and can be incorporated as one coherent update. The coordinator records why the batch is worth a render.
- The final delivery snapshot is ready and the measured render plus review time still fits the deadline with a recovery margin.

Commit counts, elapsed minutes and training-step increments alone do not trigger rendering. New changes arriving during a render enter the next batch. Interrupt an authorized render only for invalidating evidence, an operator stop or an actual resource/safety problem, not routine newer numbers.

## 5. Keep Loupe and technical facts version-specific

Separate training in progress, saved checkpoint, promotable checkpoint, evaluated candidate, gate-passing candidate, deployed model and published adapter. A newer checkpoint does not inherit an older version's evaluation or serving claims. A training loss is not detection accuracy. Every reported rate names its numerator, denominator, dataset/split identity, model/checkpoint and evaluation date; latency/cost name the measured environment and population.

Loupe 1.1 remains described as training or under evaluation until its actual gates pass. The missed 09:30 promotion target is not rewritten as success. Common-held-out isolation findings and missing provenance must be resolved or disclosed; no missing proof is reconstructed. Keep truthful, explicitly historical Loupe 1.0 material available as a fallback if 1.1 is not publishable in time.

Technical counts and architecture claims likewise distinguish repository state, CI-tested candidate and deployed behavior. Show only capabilities the recorded capture demonstrates. Missing ablation results are not zero contribution and must not appear as measured gains.

## 6. Freeze one reproducible candidate per render batch

Prepare a frozen fact pack and manifest before any future render: source/tree commit, deployed commit, relevant model/checkpoint and dataset IDs, evaluation/report hashes, capture manifests, approved storyboards/narration/captions, fact-pack hash and render settings. Every video in that batch consumes the same approved snapshot where it shares a claim. Do not let one composition silently collect newer figures midway through the batch.

Update the owning facts, source scenes and associated narration/captions together. Reuse unaffected verified footage and audio when provenance remains valid. Prefer previewing changed scenes before a full render after authorization; preserve the previous accepted candidate until its replacement passes all gates.

## 7. Verify the delivered artifact, not just its source

Media runs the relevant source/fact tests and renders only after release authorization. Inspect the actual encoded candidate, including changed transitions and audio, at normal playback speed. Perform the final claim-to-evidence comparison against that artifact. Explicitly record playback coverage and any unreviewed interval; a contact sheet alone is not a full playback review.

The coordinator independently checks the candidate's claims, findings, evidence manifest and substantive changes. No candidate is upload-ready with a factual contradiction, unsupported live claim, missing required footage, illegible key evidence, broken audio/captions or a failed format/duration requirement. Report residual limitations plainly; never label unchecked material perfect.

## 8. Deliver a clearly identified upload package

Retain versioned outputs and designate exactly one accepted final file per purpose. The package contains final video(s), supported captions, matching thumbnail/banner assets, verified existing copy or approved writing, credits/licence evidence, checksums and a short release manifest naming the evidence snapshot and completed checks. Mark superseded and incomplete files unmistakably so they cannot be uploaded by mistake. Preparing this package does not itself publish it.

Calculate the last safe render start from observed render duration, remaining review work and a recovery allowance. Prioritize the submission demo, then the most valuable supporting explainers. If a late milestone cannot be incorporated and verified before the corrected midnight polish target, retain the last truthful accepted candidate and list the later update separately. Do not sacrifice correctness or claim freshness merely to include the newest statistic.

## Immediate assignments

- Media: acknowledge the render hold, inventory and audit existing artifacts, and return timestamped findings plus a proposed improvement brief. Do not generate new media.
- Loupe and eval: supply version-bound measured facts, provenance and explicit unknowns through the coordinator; do not rewrite media claims directly.
- Product lanes: supply verified deployed behavior and capture-ready changes at their boundaries.
- Coordinator: review the audit, resolve factual conflicts and priorities, consolidate the cut plan and batch register, and preserve the operator's render hold until it is explicitly lifted.

Reversal: retain original media and manifests, withdraw an unaccepted candidate, and revert an isolated source change. No original asset, protected demo account, training input or historical evidence is deleted by this plan.
