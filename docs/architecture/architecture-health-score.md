# HoneySwing Architecture-Health Score — Phase 2 (2026-07-02)

Scored against `architecture-health-rubric.md` (deduction model). Every
deduction cites the measured evidence. All commands were run live on this
working tree (branch `main`); no axis was unmeasurable — even the two
network/auth-gated commands (supabase type generation, madge/knip via npx)
ran successfully, so no unmeasurable-penalty was applied anywhere.

## Scoreboard

| # | Axis | Max | Deductions | Score |
|---|---|--:|--:|--:|
| 1 | Layer & boundary integrity | 140 | −15 | **125** |
| 2 | Domain determinism & runtime purity | 70 | −0 | **70** |
| 3 | Capture-pipeline cohesion & rate-independence | 130 | −0 | **130** |
| 4 | Calibration single-sourcing | 90 | −40 | **50** |
| 5 | Data-contract integrity & evolution | 140 | −8 | **132** |
| 6 | Test health & gate integrity | 150 | −52 | **98** |
| 7 | Static-gate coverage | 90 | −38 | **52** |
| 8 | Dependency coupling & cycles | 90 | −40 | **50** |
| 9 | RN/Expo platform & native-bridge health | 60 | −10 | **50** |
| 10 | Dead code & change-amplification hotspots | 40 | −2 | **38** |
| | **TOTAL** | **1000** | | **795** |

---

## Axis 1 — Layer & boundary integrity: 125/140

Evidence:
- (a) Exactly **one** upward import from `packages/`:
  `packages/domain/swing/swingRowBuilders.ts:9` — verified `import type { Json }
  from '@/lib/database.types'` (type-only).
- (d) **Zero** react/react-native/expo imports anywhere under `packages/`.
- (c) One import escaping the packages root:
  `packages/pose/rtmw/cocoWholebody.ts:1` → `../../../models/coco_wholebody_index.json`.
- (b) UI→domain direct imports resolve to exactly three `domain/swing` modules:
  `tipFrequency` (4 files), `positiveReinforcement` (3), `captureValidity` (2)
  — all public product-logic surfaces, **no detector/pipeline internals**;
  remaining UI→domain imports target `packages/domain/clinic`, the clinic
  screens' own domain package.

Deductions:
- **−10** — the one type-only upward import is not enumerated in any written
  in-repo allowlist (it is documented only in session memory, not in the repo).
- **−5** — the models-JSON escape from `packages/pose` is likewise
  un-allowlisted, so the package is silently non-relocatable.

## Axis 2 — Domain determinism & runtime purity: 70/70

Evidence:
- (a) 9 ambient-read hits in non-test domain code: `tipFrequency.ts` (5×
  `Date.now()` — session-window state), `positiveReinforcement.ts:300`
  (`Math.random()` — message selection), `personalBandCalculator.ts` (3×
  `Date.now()` — `updatedAt` stamps). **Zero `console.*`** hits.
- (b) None reachable from `analyzePoseSequence`: `analysisPipeline.ts` imports
  none of the three modules (grep empty). None feeds a scored, phase, or
  persisted analysis value.
- (c) Determinism double-run: `npm test -- scoring` twice → **diff empty
  ("DETERMINISM: IDENTICAL")**.

Deductions: none. (The `tipFrequency` internal clock is a testability wart,
noted in the assessment below, but the schedule deducts only for analyze-path
or output-feeding reads, and these are neither.)

## Axis 3 — Capture-pipeline cohesion & rate-independence: 130/130

Evidence:
- (a) `ANALYZER_DECIMATION` defined **once** (`lib/cameraFormat.ts:11`),
  imported by exactly one consumer (`lib/captureProcessing.ts:41`), passed
  down from there. No copies in app/packages/scripts.
- (b) Frame-count literal sweep over the five capture-chain files returned
  only the format definition itself (`CAPTURE_FPS = 240`, the source of truth)
  and comments — no stale fps-assuming literals.
- (c)/(d) ms-sibling thresholds present in `captureValidity`,
  `confidenceScore`, and throughout `phaseDetectionShared`'s tables (every
  frame constant carries an `…Ms` sibling with a "live readers use msToFrames"
  comment); `msToFrames`/`msPerFrame` consumed in 11 non-test domain files.
- Cross-file coupling: `EXTRACTION_TIMEOUT_MS` (`captureProcessing.ts:153`)
  carries an explicit comment tying it to decimation 2 and flagging it
  unverified on-device — the coupling is documented at the consuming end.

Deductions: none.

## Axis 4 — Calibration single-sourcing: 50/90

Evidence:
- (a) Literal copies of shared tunables outside the shared table:
  `app/clinic/coach-mode/signalCompute.ts:144` (`MIN_TRAVEL = 0.04`, duplicates
  `EXTERNAL_ASSUMPTIONS.dtl.top.minTravel`) and `:423` (`VEL_NOISE_FLOOR =
  0.008`, duplicates `dtl.finish.velocityFloor`). Both drive the coach-mode
  debug visualization (display surface, not a phase decision); neither carries
  a comment naming its shared source (line 386 hardcodes the string
  `'MIN_TRAVEL=0.04'` into the displayed rule text).
- (b) Detector-private tunables: `phaseDetectionLegacy.ts:107,108,136,165,166`
  (`MIN_TRAVEL 0.04`, `MIN_LOOKAHEAD_FRAMES 10`, `HAND_LOW_TO_IMPACT_MS 67`,
  `FOLLOW_THROUGH_MULTIPLIER 3.0`, `VEL_NOISE_FLOOR 0.008` — value-identical
  to the shared `dtl` block) and `phaseDetectionFaceOn.ts:211–213`
  (`IMPACT_SPEED_LOOKBACK_MS`, `IMPACT_PEAK_PERCENTILE`,
  `IMPACT_BAND_THRESHOLD`).
- (c) Output contract unified: all detectors return the shared
  `DetectedPhase[]` type from `phaseDetection.ts`; no divergence.

Deductions:
- **−20** — two uncommented literal copies in a display-only surface
  (−10 each): a recalibration of the shared table silently desynchronizes the
  coach-mode debug views.
- **−20** (cap) — ≥ 7 tunables living detector-private. Classification note:
  the legacy detector's value-identical constants were scored under this item
  (−5 each, capped) rather than as decision-path copies (−30 each) because
  ARCHITECTURE_MAP documents the legacy detector as intentionally frozen 1:1
  for unknown-angle back-compat — a stated design decision, not accidental
  drift. Had that freeze been undocumented, this axis would have scored ≤ 10.

## Axis 5 — Data-contract integrity & evolution: 132/140

Evidence:
- (a) Column census: `metric_confidences` (5 files), `trail_points` (5),
  `pose_full` (6), `swing_debug` (10) all have readers. `category_scores`
  appears in 3 files — write (`persistSwing.ts:134`), select + row type
  (`swingStore.ts:64,115`), and a test fixture — the **value is consumed
  nowhere**; the write site (`persistSwing.ts:134`) carries no comment naming
  an external/future consumer.
- (b) Idempotency of the read-time identity correction **is tested**:
  `lowerBodyIdentity.test.ts:216` ("#9 idempotency — second application is a
  no-op"), and the invariant is stated at `lowerBodyIdentity.ts:49,238` and at
  the read site (`swingStore.ts:277`).
- (c) Naive-Date triage: 10 hits; 9 construct ISO strings *from* epoch-ms
  values (serialization, safe). The one parse — `swingLimit.ts:60`
  `new Date(user.created_at)` — reads the Supabase **auth** user object
  (`getUser()` from `lib/supabase.ts`), whose `created_at` is ISO-8601 with
  timezone, not an offset-less DB column string. No violations.
- (d) `npx supabase gen types typescript --linked` ran; output is
  **byte-identical** to `lib/database.types.ts` (diff empty, 498 = 498 lines).
- (e) Write paths: both `.insert` calls live in `lib/persistSwing.ts`
  (:177 primary, :192 FK-heal retry) — one orchestration path.
- (f) `analysis_version` is written and selected; no read-path branches on it,
  but version tolerance exists structurally: all analysis columns are nullable
  and `reconstructAnalysis.ts` (unit-tested) rebuilds results from partial
  rows. Scored as handling-present; the unused version column is noted in the
  assessment.

Deductions:
- **−8** — one persisted write-only field (`category_scores`) undocumented at
  its write site.

## Axis 6 — Test health & gate integrity: 98/150

Evidence:
- (a) Full run: **50 files, 49 passed, 1 failed** — `phaseDetectionDTL.test.ts`,
  which is the documented, parked red (ARCHITECTURE_MAP "Coverage note").
- (b) Discovery: 50 `*.test.ts` on disk under lib/+packages/ = 50 executed —
  no mismatch. Zero `*.test.tsx` / `*.spec.ts` files exist on disk; the runner
  (`run-tests.mjs:30`) matches only `.test.ts`, so a first component test
  would be silently invisible (design blind spot, currently zero affected files).
- (c) Exit propagation intact: `run-tests.mjs:55` `process.exit(failed.length ? 1 : 0)`.
- (e) Sibling-suite check over the 10 analysis-critical modules: **4 missing**
  — `phaseDetectionLegacy`, `phaseDetectionShared`, `tempoAnalysis`, `angles`
  (no sibling `.test.ts`; `tempoDisplay.test.ts` covers a different module).
- (d) Distribution: 30 suites in domain/swing, 17 in lib, 2 clinic, 1 pose —
  **0 in app/ and components/**, while documented capture invariants
  (refs-as-refs, outbox mutual exclusion — Batch 5.1 notes) live in that code.

Deductions:
- **−5** — one red suite, documented as parked.
- **−5** — runner-invisible test-file class exists by design (zero files yet).
- **−32** — 4 analysis-critical modules without sibling suites (−8 each).
- **−10** — zero tests over app/components holding documented capture invariants.

## Axis 7 — Static-gate coverage: 52/90

Evidence:
- (a) `npx tsc --noEmit` **passes** (exit 0).
- (b) Census: app 47/47 loaded; lib 62 of 64 non-test files; components 9 of 11;
  scripts 0 of 28+. The 4 unchecked files: `components/GripHistoryRow.tsx`,
  `components/VisualCoachCard.tsx`, `lib/adapters/mediapipeHandAdapter.ts`,
  `lib/adapters/rtmHandAdapter.ts` (unchecked because unimported — see Axis 10).
- (c) 33 test files loaded by tsc — exactly the packages/ suites; **all 17
  lib test suites are outside every tsconfig** and run only under
  type-stripping tsx. This set includes the persistence seam's tests
  (`outbox.test.ts`, `persistSwing.canary.test.ts`, `swingStore.test.ts`).
- (d) Lint: **36 problems (0 errors, 36 warnings)** — exactly the recorded
  baseline of 36. No deduction.

Deductions:
- **−8** — 4 unchecked non-test files in shipped trees (−2 each).
- **−20** — a whole class of test files (17 lib suites) outside every tsconfig.
- **−10** — `scripts/` validation harnesses import production domain code and
  are type-checked by nothing.

(Overlap note: the 4 unchecked files are also counted as orphans in Axis 10.
Both deductions stand because they measure different defects — Axis 7 scores
the reachability-based gate perimeter that *allows* any orphan to become
invisible; Axis 10 scores the orphans' existence.)

## Axis 8 — Dependency coupling & cycles: 50/90

Evidence:
- (a) madge@8: **5 circular dependencies**, all inside
  `packages/domain/swing/`: dispatcher↔each detector (3), dispatcher→
  cameraAngle→phaseDetectionShared→back (1), watchImu↔clockAlign (1).
  Import-level inspection shows every back-edge is `import type`
  (`phaseDetectionLegacy.ts:9`, `phaseDetectionDTL.ts:18`,
  `phaseDetectionFaceOn.ts:11`, `phaseDetectionShared.ts:18`,
  `clockAlign.ts:19`) — type-erased at runtime, so the undefined-at-init
  attack cannot occur; the coupling still binds the modules for extraction.
- (b) `npm ls`: `react-native-worklets@0.8.3` is required by
  `react-native-reanimated@4.1.7`; `react-native-worklets-core@1.6.3` by
  `react-native-vision-camera@4.7.3` — the duality is constraint-driven by
  dependency edges (both also directly pinned). No deduction.
- (c) devDependency runtime-imported: `@supabase/supabase-js` (declared in
  devDependencies) is imported at runtime by `lib/supabase.ts` and the whole
  persistence layer. One occurrence.

Deductions:
- **−30** (cap) — 5 intra-layer cycles (−10 each, capped). Schedule applied
  literally; the type-only nature is recorded as mitigating context, not as a
  waiver.
- **−10** — one runtime import of a devDependency.

## Axis 9 — RN/Expo platform & native-bridge health: 50/60

Evidence:
- (a) Source-vs-copy drift across all mirrored `native-assets/ios/*.swift`
  files: **zero drift**.
- (b) Copy mechanism exists and is automated: `plugins/withHoneyNative.js:63`
  copies from `native-assets/ios` at prebuild.
- (c) `newArchEnabled` agrees across all three surfaces (`app.json:10`,
  `ios/Podfile.properties.json:5`, `android/gradle.properties:38`).
- (d) `npx expo-doctor`: **2 checks failed** — 9 packages out of date vs SDK 54
  expectations (expo-file-system, expo-font, expo-router, expo-updates among
  them). No documented waiver found in-repo.

Deductions:
- **−10** — 2 undocumented failed doctor checks (−5 each).

## Axis 10 — Dead code & change-amplification hotspots: 38/40

Evidence:
- (a) knip@5 reported 96 "unused files". Triage: ~50 are the custom runner's
  test files and ~30 are `scripts/` harnesses + `plugins/withHoneyNative.js`
  (all false positives — knip has no entry config for the custom runner,
  npx-tsx scripts, or config plugins). Parked-code allowlist (built before
  triage, from repo docs/product decisions): result-screen vanished-feature
  effects; inert Watch-IMU modules; the parked DTL suite. Genuine orphans
  after triage: **7** — `components/GripHistoryRow.tsx`,
  `components/VisualCoachCard.tsx`, `lib/adapters/mediapipeHandAdapter.ts`,
  `lib/adapters/rtmHandAdapter.ts`, `packages/domain/clinic/metricComputation.ts`,
  `packages/domain/clinic/physicalLimitFlagEvaluator.ts`,
  `packages/domain/clinic/predictionAccuracyTracker.ts`. None on the
  capture/persist path. (`VisualCoachCard` being orphaned suggests the Visual
  Coach UI joined the vanished-features family — flagged for the parked-code
  inventory, not deletion.)
- (b) God-file census (> 600 lines, non-test): 9 files (1236, 998, 904, 814,
  772, 697, 695, 673, 605). No prior recorded ">600 count" baseline exists;
  per the rubric's lint-baseline convention, this census becomes the baseline
  and no trajectory deduction is taken. **Baseline recorded: 9.**

Deductions:
- **−2** — 7 off-path orphans; −1 each beyond the first 5.

---

# FINAL ARCHITECTURE SCORE: **795 / 1000**

The shape of the loss is telling: the pure analysis core is in excellent
health (determinism 70/70, capture rate-independence 130/130, boundaries
125/140, data contract 132/140) while almost half of all lost points sit in
the *assurance* layers — the test gate (−52), the static-gate perimeter
(−38), and calibration sourcing (−40). The codebase itself is easier to
evolve than the tooling around it can currently prove.

---

# FINAL ARCHITECTURAL ASSESSMENT

*If I became lead architect tomorrow with exactly one week for architecture
only — ranked purely by long-term architectural impact, ignoring cost. No
code proposals, no redesigns; each item is a structural decision the current
architecture already implies but has not made explicit.*

## #1 — Make the persisted swing row an explicit, versioned contract

The `swings` row is the only interface in this system that spans *time*: it is
written once by whatever pipeline version exists that day and read forever by
history, playback, trends, reconstruction, and an external inspector. Today
that contract is implicit — `analysis_version` is recorded but nothing keys on
it, compatibility rests on nullable columns plus reconstruction behavior, one
column (`category_scores`) is written for a consumer that exists only as
folklore, and field semantics (score `null` vs `0`, RAW motion frames
requiring idempotent read-time correction) live in comments and doc files.
This is the one surface where a mistake is irreversible: code can be
refactored, but rows written under a misunderstood contract can never be
recaptured. Making the contract explicit — an owned registry of fields, their
consumers, their semantics, and a stated policy for what each
`analysis_version` guarantees at read time — converts the scariest category of
change in this codebase (evolving the analysis pipeline) into a routine one.
Everything else in the system can recover from a bad week; the data cannot.

## #2 — Close the static-analysis perimeter to the whole repository

The measured gates pass — and see only part of the repo. The entire lib test
suite (17 files, including the tests guarding the persistence seam) executes
under a type-stripping runner and is type-checked by nothing; the 9k-line
validation-script toolkit that replays production domain code is outside the
gate; whole files in shipped trees are invisible because inclusion is defined
by import-reachability rather than by the source tree. Strict TypeScript is
this repo's primary refactor amplifier — the thing that makes a rename across
65 domain modules cheap and safe — and every blind spot is a location where
"it compiles" is false comfort. Extending the perimeter until *every* source
and test file is seen by some typecheck configuration is the single highest
multiplier available: it strengthens not one subsystem but the safety of every
future change in all of them, and it costs no design risk whatsoever.

## #3 — Finish calibration single-sourcing, and make the legacy freeze a decision

The `EXTERNAL_ASSUMPTIONS` table exists for one architectural reason: so that
recalibrating phase detection against real coaching data is a single edit.
That property currently holds for the two modern detectors and fails at the
edges — the coach-mode debug views hold uncommented literal copies of shared
tunables (so the very screens used for tuning can silently show stale rules),
and the legacy detector carries value-identical private constants whose
"frozen 1:1" status is documented prose, not an enforced contract.
Recalibration is not an edge case here; it is the product's core iteration
loop with real coaches. Completing single-sourcing — every consumer reads the
table by reference, and the legacy detector's freeze is either declared and
guarded or retired as a policy — makes the calibration loop lossless. This
ranks third because it protects the accuracy-improvement flywheel the entire
product depends on.

## #4 — Reallocate test mass from the comfort zone to the risk surface

Test placement currently mirrors ease of testing, not cost of regression: the
pure math is superbly covered (51% of domain lines are tests; determinism is
provable), while four analysis-critical modules have no sibling suites, the
capture orchestration's invariants (ref identity, persist/retry mutual
exclusion) exist only in documentation, and the coordinate-mapping and
render-adjacent glue has zero tests — precisely the code where most future
changes will land. The gate infrastructure itself has a dormant blind spot
(component-style test files are invisible to the runner by extension). The
structural move is a policy, not a test-writing sprint: every documented
invariant must have an executable guard, and the runner must discover every
test-file class before the first such file exists. This converts institutional
memory — currently the only thing protecting the capture path — into
mechanical protection that survives team change.

## #5 — Declare the domain packages' public API and codify the boundary rules

The layering is in genuinely good shape — but it is healthy by discipline, not
by mechanism. There is no written allowlist for the two known boundary
exceptions, no declared public surface for `packages/domain` (UI currently
imports three specific modules directly, which happens to be fine, but nothing
distinguishes "public product logic" from "pipeline internals" except
convention), mixed import styles that defeat grep-level auditing, and
type-level cycles through the phase dispatcher that bind modules against
future extraction. Declaring the public API of the domain packages and writing
the boundary rules down as machine-checkable policy makes the repo's single
most valuable property — the pure, replayable analysis core — durable under
team growth and contributor turnover, and unlocks the package extraction that
the `packages/` layout has always implied. It ranks fifth only because the
boundary is currently intact; this is the act of locking the door that
happens, today, to be closed.
