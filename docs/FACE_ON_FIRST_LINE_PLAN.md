# Face-On First-Line Detector — Improvement & Validation Plan

**Status:** DRAFT (2026-07-02)
**Owner:** Sam
**Product priority:** the first-line detector must be excellent for normal, valid, face-on swings.

## Scope

In scope: `phaseDetectionFaceOn.ts` and everything that feeds or consumes it on the
live face-on path — impact detection, top detection, tempo, phase ordering — plus the
validation machinery (device review workflow, fresh corpus, replay comparison).

Explicit non-goals:
- **No DTL work.** The DTL detector and its red test stay parked.
- **No legacy characterization.** Legacy has smoke coverage only
  (`phaseDetection.test.ts` T11); fresh `phase_source` / `ruleDebug.detector`
  telemetry will decide keep/retire/characterize later.
- **No broad cleanup.** Refactors only where a workstream below requires them.

## Current known state (inputs to this plan)

- Face-on impact reads the **canonical leftWrist = TRAIL wrist** deliberately; the
  lead-wrist alternative was falsified on real swings (guard test exists).
- Impact x-crossing selection is a known defect class: LAST-crossing can pick
  post-impact noise and fall back to arc-bottom (e.g. corpus swing dec6edd1: picked
  117 via fallback, true crossing 119.5, the 2nd of 4 crossings). FIRST-crossing is
  also wrong. Correct selection = **crossing nearest the arc bottom**, not ordinal.
- `reliability.impact` is computed and persisted but **read by no consumer** (tempo
  trust gate, scoring, angle windows, finish, trends all ignore it). Propagation is
  intentionally deferred until impact selection is validated.
- Tempo sanity floor `TEMPO_MIN_PHASE_MS = 120` was chosen from N=2 developer swings
  (tempoAnalysis.ts:106) — explicitly flagged for revalidation on real user data.
- Persisted phase debug renamed `impact_thumb` → `impact_consensus_final` (+
  `impact_source` values); the web viewer's `loadSwing.ts` still reads the old key.
- `motion_frames` are stored RAW (un-mirrored); phases are canonical-space. Replay
  must reconcile by frame index, never by render-time mirroring.
- 120fps capture commits are on main but **not verified on-device** (gate:
  extractionMs < 90s, ~8.33ms spacing, valid capture).
- DB corpus as of 2026-07-02: 73 swings, `phase_source` non-null on all
  (heuristic / fallback / none).

## Workstreams

### A. Impact detection
1. Implement arc-bottom-proximity crossing selection in
   `detectFaceOnImpact` (replace ordinal LAST-crossing; keep arc-bottom fallback for
   the zero-crossing case).
2. Replay the full stored corpus before/after (`scripts/replayThumbImpact.ts`,
   `scripts/validateImpactXCross.ts`) — report per-swing impact-frame deltas.
3. Only after (2) validates: propagate `reliability.impact` into consumers, one at a
   time, tempo trust gate first (it directly gates user-visible tempo).
4. Exit criteria: on the labeled corpus (workstream F), detected impact within
   ±2 frames of human label at 120fps for ≥90% of normal valid face-on swings; no
   regression on the existing corpus replay.

### B. Top detection
1. Define ground truth: human-labeled top frame from video frame-stepping (top =
   lead-wrist direction reversal in x, highest hand position window).
2. Instrument: ensure `ruleDebug` records the top rule's inputs (velocity window,
   reversal index candidates) so replay can explain misses.
3. Same replay-delta methodology as impact.
4. Exit criteria: within ±3 frames of label for ≥90% of labeled corpus.

### C. Tempo
Depends on A + B (tempo = top/impact-anchored durations).
1. Recompute backswing/downswing ms across the labeled corpus using human labels vs
   detected phases; quantify tempo-ratio error contributed by detection.
2. Revalidate `TEMPO_MIN_PHASE_MS = 120` and the 0.5–10 ratio band against real
   distributions; adjust only with corpus evidence.
3. Verify takeaway-onset anchoring (backswing start) against labels —
   `scripts/verifyTakeawayOnset.ts` exists for this.
4. Exit criteria: tempo shown (not withheld) on ≥95% of normal valid face-on swings,
   with ratio error ≤0.3 vs label-derived ratio.

### D. Phase ordering
1. Add pipeline-level invariant assertions (test-side): indices/timestamps
   non-decreasing, all 5 phases present, every index in-bounds — for the face-on
   detector across the whole replay corpus (not synthetic only).
2. Persist any ordering violation as a `ruleDebug` flag so field data surfaces it.
3. Exit criteria: zero ordering violations across corpus replay + fresh corpus.

### E. Real device review workflow
1. Fold in the two deferred device checks first (skeleton overlay both render modes;
   120fps capture gate) — they share the same session.
2. Per-swing review loop: record on device → swing persists (video +
   `swing_debug.phase_rules` + `impact_consensus_final`) → step video frames against
   detected phase markers → verdict logged per swing (agree / off-by-N / wrong).
3. Fix the viewer's `loadSwing.ts` `impact_thumb` → `impact_consensus_final` read so
   the web inspector is usable for this review (single, scoped fix — display gap,
   not a crash).
4. Deliverable: a repeatable checklist (device, fps, lighting, distance) so review
   sessions are comparable.

### F. Fresh-swing corpus collection
1. Protocol: normal valid face-on swings only; capture matrix = {right- and
   left-handed} × {120fps} × {2+ lighting conditions}; N ≥ 30 swings to start
   (current DB skews right-handed — recruit at least a few left-handed swings).
2. Label: human impact + top frame per swing from video (store labels alongside the
   swing id — labels table or JSON fixture, decided at implementation).
3. Ownership/tenancy follows the web-inspector fixture plan (single-tenant DB,
   fixture ownership gate).
4. This corpus is also the dataset that decides legacy disposition: monitor
   `phase_source` + `ruleDebug.detector` frequency of `legacy` routing in the fresh
   data.

### G. Replay comparison harness
1. One script (extend `scripts/diagnoseSwingPhases.ts` or new
   `scripts/replayFaceOnPhases.ts`): for every stored swing, re-run the current
   pipeline on `motion_frames` (RAW → identity/veto/canonical, reconcile by frame
   index) and diff detected phase indices against (a) the values persisted at
   capture time and (b) human labels where they exist.
2. Output: per-swing delta table + aggregate percentiles; non-zero unexplained
   deltas vs capture-time values = regression.
3. This harness is the pre-ship gate for every change in workstreams A–C: no
   detector change lands without a before/after replay report.

## Sequencing

1. **G first** (replay harness) — everything else measures through it.
2. **E.1/E.3** (device-check debt + viewer key fix) in the first device session.
3. **F** (corpus + labels) — starts as soon as E's workflow exists; grows continuously.
4. **A** (impact) → **B** (top) → **C** (tempo), each gated by a replay report.
5. **D** (ordering invariants) rides along with G and each detector change.

## Decision gates

- No detector change merges without a before/after corpus replay report (G).
- `reliability.impact` propagation starts only after A's exit criteria are met.
- Legacy keep/retire/characterize decision is made from F's `phase_source` +
  detector-routing telemetry — not before.
