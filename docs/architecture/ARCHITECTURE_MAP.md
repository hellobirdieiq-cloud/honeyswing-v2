# HoneySwing — Architecture Map

## Context

HoneySwing captures a golf swing from the camera, extracts body pose, runs
biomechanical analysis on-device, and shows a score plus coaching feedback. This
document is a **navigable map of the whole app**: the layer structure (where
code lives and why), the directory tree of the parts that matter, and the
runtime data flow of a single swing from camera to stored result. It was built
by tracing the real code paths, so the file references below are accurate entry
points — start here, then open the named files.

## Layer structure

The app is layered so that analysis logic stays pure and testable:

```
app/  (UI screens)
  └─► lib/  (glue: hooks, in-memory state, persistence)
        └─► packages/domain/swing/  (PURE TypeScript analysis — no UI, no native)
        └─► packages/pose/          (pose I/O: types + RTMW adapter)
              └─► native Swift / modules  (camera frame processing, RTMW, MediaPipe)
```

The key property: **`packages/domain/swing` has no import-level UI or native
dependencies** — runtime purity (global reads, RN/Expo singletons, types that
transitively pull native) is not separately verified. All the biomechanics (phase
detection, angles, tempo, scoring) is plain functions over `PoseFrame[]`, and each
module has a `*.test.ts` beside it, run by `npm test` (`scripts/run-tests.mjs`,
all 50 `lib/` + `packages/` suites). The UI and native layers feed it data and
render its output, but never live inside it.

Exception: a few hydration hooks lifted out of a single screen (Batch 5.2/5.3)
are co-located beside that screen instead of centralized in `lib/` —
`app/analysis/useSwingSource.ts`, `app/analysis/useSwingVideoClock.ts`,
`app/(tabs)/useSettingsData.ts` — since they have exactly one caller.

## Directory tree

```
honeyswing-v2/
│
├── app/                        ← UI (Expo Router screens)
│   ├── (tabs)/
│   │   ├── record.tsx          ← 📷 capture screen (camera + live skeleton)
│   │   ├── history.tsx · gallery.tsx · grip.tsx · settings.tsx
│   ├── analysis/
│   │   ├── result.tsx          ← 📊 score / angles / tempo / coach
│   │   └── no-swing.tsx
│   ├── grip/   · clinic/       ← grip estimation + coaching clinic flows
│   └── onboarding · paywall · signin · index
│
├── lib/                        ← glue: hooks, stores, persistence
│   ├── useSwingCapture.ts      ← orchestrates capture → analyze → persist
│   ├── captureProcessing.ts    ← processRecordedVideo pipeline (lifted from useSwingCapture)
│   ├── extractPoseFromVideo.ts ← runs RTMW pose detector on the MP4
│   ├── swingMotionStore.ts     ← in-memory handoff: record → result
│   ├── persistSwing.ts         ← writes the row to Supabase (orchestration)
│   ├── accountLifecycle.ts     ← account teardown / age-tier switch / coach-check (+ .test.ts)
│   ├── reconstructAnalysis.ts  ← pure AnalysisResult reconstruction (+ .test.ts)
│   ├── swingStore.ts           ← reads swings back (history / playback)
│   └── supabase.ts · database.types.ts · …
│
├── packages/
│   ├── pose/                   ← pose types + RTMW adapter (RTMW-only; the
│   │   │                          PoseProvider swappable-backend abstraction
│   │   │                          + MLKitProvider stub were deleted 2026-07-01,
│   │   │                          zero importers — commit f344747)
│   │   ├── PoseTypes.ts        (PoseFrame, PoseSequence, JointName)
│   │   └── rtmw/               ← 133-keypoint RTMW adapter (cocoWholebody.ts,
│   │                              Rtmw133Frame.ts, rtmwAdapter.ts)
│   └── domain/swing/           ← 🧠 PURE analysis (no UI / no native)
│       ├── analysisPipeline.ts ← master orchestrator (15 stages, 0–14)
│       ├── phaseDetection.ts · angles.ts · tempoAnalysis.ts
│       ├── scoring.ts · cameraAngle.ts · lowerBodyIdentity.ts
│       ├── captureFlow.ts · swingRowBuilders.ts · captureValidity.ts
│       ├── positiveReinforcement.ts · tipFrequency.ts · tempoDisplay.ts
│       └── … (keypointVeto, canonicalTransform, confidenceScore, …)
│
├── native-assets/ios/HoneyVisionCameraPosePlugin.swift  ← live MediaPipe
├── modules/vision-camera-pose/                          ← native bridge
└── supabase/migrations/        ← DB schema history (swings table)
```

> **Abbreviated** — shows the main runtime areas only. For the complete
> inventory (incl. `scripts/`, `components/`, `packages/domain/clinic/`,
> `targets/watch/`, `ios/honeyswing/`), see **Code size** below.

## Code size (snapshot — 2026-07-02)

Counts source files only (`.ts`, `.tsx`, `.swift`); excludes `node_modules`,
build output (`ios/Pods`, `ios/build`, `.expo`, `dist`, `.venv`), and the
generated `lib/database.types.ts`. Regenerate with the same scan before trusting.

The per-area table below covers **7 areas** (`.ts/.tsx/.swift` only); the
whole-repo reconciliation follows it.

| Area | Lines | Files |
|---|--:|--:|
| `packages/domain/swing/` | 20,109 | 65 |
| `lib/` | 11,382 | 81 |
| `app/` | 12,540 | 47 |
| `native-assets/` | 2,617 | 11 |
| `supabase/` | 682 | 2 |
| `packages/pose/` | 408 | 5 |
| `modules/` | 77 | 2 |
| **Total** | **47,815** | **213** |

**10 biggest single files**

| Lines | File |
|--:|---|
| 1,236 | `packages/domain/swing/phaseDetectionFaceOn.ts` |
| 998 | `lib/outbox.ts` |
| 988 | `packages/domain/swing/visibilityWeighting.test.ts` |
| 904 | `app/clinic/coach-mode/Tab1LiveView.tsx` |
| 814 | `packages/domain/swing/analysisPipeline.ts` |
| 780 | `packages/domain/swing/tiltCorrection.suite.test.ts` |
| 772 | `app/(tabs)/settings.tsx` |
| 732 | `packages/domain/swing/foreshorteningCorrection.test.ts` |
| 725 | `packages/domain/swing/positiveReinforcement.test.ts` |
| 697 | `app/(tabs)/record.tsx` |

`app/analysis/result.tsx` dropped out of the top 10 entirely (850→525 lines,
Batch 5.2 decomposition into `useSwingSource.ts` / `useSwingVideoClock.ts` +
3 pure modules).

**Test vs non-test (by area)**

| Area | Test LOC | Non-test LOC | % tests |
|---|--:|--:|--:|
| `packages/domain/swing/` | 10,207 | 9,902 | 51% |
| `lib/` | 3,740 | 7,642 | 33% |
| `app/` | 0 | 12,540 | 0% |
| `packages/pose/` | 110 | 298 | 27% |
| `native-assets/` | 0 | 2,617 | 0% |
| `supabase/` | 0 | 682 | 0% |
| `modules/` | 0 | 77 | 0% |

`packages/domain/swing/` remains the largest area and now crosses the halfway
mark on tests (~51%); `lib/` fell further to ~33% tests (from 53%, then 40%)
as Batch 2/5 moved pure modules and their tests out to `packages/domain/swing/`
and lifted co-located hooks out to `app/`.

⚠️ **Coverage note:** these are line counts, not pass/fail coverage. `npm test`
(`scripts/run-tests.mjs`) executes all 50 `lib/` + `packages/` suites and exits
non-zero on any failure (an earlier `find lib …` runner silently skipped every
`packages/` suite; fixed in `773cabd`). As of 2026-07-02, 49 of 50 pass — one
suite is red and parked (not pending triage): `phaseDetectionDTL`
(`tipFrequency` and `metricDefinitions` were fixed test-side in Batch 3).

### Whole-repo reconciliation

The per-area table above is a **7-area subset** (`app/ lib/ packages/pose/
packages/domain/swing/ native-assets/ modules/` + supabase `.ts`), `.ts/.tsx/.swift`
only. The whole repo (adds `.sql`, plus the areas below) is:

**303 files / 69,502 lines.** Subtracting the 4,932-line generated
`supabase/migrations/20260417055038_remote_schema.sql` leaves **64,570** — but
that is an **upper bound** on hand-authored code, not a pure figure: it still
includes `ios/honeyswing/` generated/duplicated Swift (3,373; `AppDelegate.swift`
is Expo-generated, the `Honey*` plugins are build-time copies of
`native-assets/ios/`). Removing those too puts hand-authored at **≈ 61,197**.

**Working-tree vs tracked:** the 303 files / 69,502 lines is a **working-tree**
count (files on disk). The git-**tracked** repo is **288 files / 65,789 lines** —
~15 files are gitignored (chiefly the generated `ios/honeyswing/` Swift, 3,373)
or untracked. Tracked minus the generated schema = 65,789 − 4,932 = **60,857**,
consistent with the ≈ 61,197 hand-authored figure above.

Areas missing from the 7-area view:

| Area | Lines | Files |
|---|--:|--:|
| `scripts/` (dev/diagnostic tooling) | 9,067 | 28 |
| `supabase/` `.sql` migrations | 5,209 | 14 |
| `ios/honeyswing/` (generated/duplicated native) | 3,373 | 13 |
| `components/` | 2,164 | 11 |
| `packages/domain/clinic/` | 1,116 | 14 |
| `targets/watch/` (parked, unshipped Watch IMU) | 756 | 9 |
| root (`expo-env.d.ts`) | 2 | 1 |
| **Added** | **21,687** | **90** |

Reconciliation (the 213-file / 47,815-line per-area total is a 7-area subset):

```
  47,815   7-area subset (.ts/.tsx/.swift)
+ 15,362   remainder (scripts + ios/honeyswing + components + targets/watch + root)
+  1,116   packages/domain/clinic (.ts, previously missed)
+  5,209   supabase .sql migrations (7-area supabase figure was .ts-only)
= 69,502   whole repo   (files: 213 + 62 + 14 + 14 = 303)
```

Note: `scripts/` is a maintained, read-only validation/diagnostic toolkit —
harnesses that run production functions over ground-truth swings via `npx tsx`
(e.g. `validateImpactXCross`, `replayThumbImpact`, `scoreSwings`), not shipped
app code. `targets/watch/` is the parked, unshipped Watch IMU feature — neither
inflates shipped app size. `ios/honeyswing/` is generated/duplicated native glue
(`AppDelegate.swift` generated; `Honey*` plugins are build-time copies of
`native-assets/ios/`), so the `64,570` figure overstates hand-authored code;
excluding `ios/honeyswing/` lands at **≈ 61,197**.

## Runtime data flow

How one swing moves through the system, end to end:

```
 ┌─────────────────────────────────────────────────────────────┐
 │ CAPTURE  (record.tsx + useSwingCapture.ts)                   │
 │                                                              │
 │   Camera 240fps ──► HoneyVisionCameraPosePlugin.swift        │
 │                        └─ MediaPipe (BlazePose, 33 joints)   │
 │                            └─► live skeleton overlay          │
 │   4-second clip saved ──► {cache}/{swingId}.mp4              │
 │   (also: device tilt/gravity + optional Apple Watch IMU)     │
 └───────────────────────────────┬─────────────────────────────┘
                                  │ on stop
                                  ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ EXTRACT  (extractPoseFromVideo.ts, via captureProcessing.ts)  │
 │   MP4 ──► RTMW detector ──► 133-keypoint frames              │
 │        ──► rtmwToPoseFrame() ──► PoseSequence                │
 │   ANALYZER_DECIMATION = 2 (cameraFormat.ts) → 120fps         │
 │   effective extraction (was decimation 4 / 60fps). ⚠️ not     │
 │   yet verified on-device as of this doc revision.            │
 └───────────────────────────────┬─────────────────────────────┘
                                  ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ ANALYZE  (analysisPipeline.ts → analyzePoseSequence)        │
 │                                                              │
 │   identity-fix → keypoint veto → canonical transform        │
 │      → phase detection → swing-start → ANGLES               │
 │      → visibility weight → wrist hinge / clubhead path      │
 │      → camera angle → foreshorten/tilt fix → TEMPO          │
 │      → angle gating → SCORE → confidence → categories       │
 │                                                              │
 │   ▼ returns AnalysisResult { score, angles, tempo,          │
 │                              phases, trail, confidence … }   │
 └───────────────────────────────┬─────────────────────────────┘
                                  ▼
 ┌──────────────────────────────┐     ┌──────────────────────────┐
 │ swingMotionStore (in-memory) │────►│ result.tsx                │
 │  motion · analysis · video   │     │  score / angles / tempo / │
 │                              │     │  coach tips / skeleton    │
 └──────────────┬───────────────┘     └──────────────────────────┘
                │ persistSwing.ts
                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ PERSIST → Supabase `swings` table                           │
 │   row: score, angles, tempo, phases, trail_points,          │
 │        motion_frames (full pose seq), swing_debug, IMU…      │
 │   then async: uploadSwingVideo() ─► Storage                 │
 └───────────────────────────────┬─────────────────────────────┘
                                  ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ PLAYBACK  (swingStore.ts ← history.tsx / gallery.tsx)       │
 │   fetch row ──► re-apply identity correction ──► re-render   │
 └─────────────────────────────────────────────────────────────┘
```

## Key files

| Component | File | Key symbol |
|---|---|---|
| Capture UI | `app/(tabs)/record.tsx` | record screen + live skeleton |
| Capture orchestration | `lib/useSwingCapture.ts` | `useSwingCapture`, `finalizeCapture` |
| Capture video pipeline | `lib/captureProcessing.ts` | `processRecordedVideo` (decimated RTMW extraction) |
| Live native pose | `native-assets/ios/HoneyVisionCameraPosePlugin.swift` | MediaPipe BlazePose |
| Pose extraction | `lib/extractPoseFromVideo.ts` | `extractPoseFromVideo` (RTMW) |
| Pose types | `packages/pose/PoseTypes.ts` | `PoseFrame`, `PoseSequence` |
| Analysis orchestrator | `packages/domain/swing/analysisPipeline.ts` | `analyzePoseSequence` |
| Phase detection | `packages/domain/swing/phaseDetection.ts` | `detectSwingPhasesWithDebug` |
| Angles | `packages/domain/swing/angles.ts` | `calculateGolfAngles`, `GolfAngles` |
| Tempo | `packages/domain/swing/tempoAnalysis.ts` | `calculateTempo`, `SwingTempo` |
| Scoring | `packages/domain/swing/scoring.ts` | `scoreSwing` |
| In-memory handoff | `lib/swingMotionStore.ts` | `setCurrentSwing*` / `getCurrentSwing*` |
| Persistence (orchestration) | `lib/persistSwing.ts` | `persistSwing` → `swings` table (now ~394 lines; delegates row-building) |
| Row builders (pure, tested) | `packages/domain/swing/swingRowBuilders.ts` | `buildWatchImuDebug`, `enrichFramesWithVelocity`, `calcPoseSuccessRate`, … |
| Capture-flow decisions (pure, tested) | `packages/domain/swing/captureFlow.ts` | `computeNavigationBlockReason`, `deriveClassification` |
| Playback read | `lib/swingStore.ts` | `getSwingById`, `getSwingMotionFrames` |
| Result-screen data source | `app/analysis/useSwingSource.ts` | `useSwingSource` (live store vs history fetch vs reconstruction) |
| Result-screen video clock | `app/analysis/useSwingVideoClock.ts` | `useSwingVideoClock` |
| Settings hydration | `app/(tabs)/useSettingsData.ts` | `useSettingsData` |
| Account lifecycle (pure, tested) | `lib/accountLifecycle.ts` | account teardown, age-tier switch, coach check |

## One-line summary

Capture 4s of video → extract 133-keypoint poses → run the multi-stage pure-TS
analysis pipeline → hand off via an in-memory store to the results screen →
persist the full swing to Supabase for history and playback.

---

# Deep dive

Everything below drills into the parts that carry the most logic: the analysis
pipeline, the scoring model, the core data types, the persistence schema, and
the diagnostic trail. File/line references point at the verified source.

## Analysis pipeline — stage by stage

`analyzePoseSequence` (`packages/domain/swing/analysisPipeline.ts:553`) is the
single orchestrator. It runs these stages in order over the `PoseFrame[]`:

```
 PoseSequence (133-kp RTMW frames, raw + normalized)
   │
 0 ┤ correctLowerBodyIdentity      lowerBodyIdentity.ts   fix RTMW left/right LEG swaps
 1 ┤ vetoAndInterpolateKeypoints   keypointVeto.ts        velocity veto + gap interpolation
 2 ┤ toCanonicalSequence           canonicalTransform.ts  mirror → canonical space
   │                                                      (mirror RH, pass LH through)
 3 ┤ buildTrailPoints + detectCameraAngleEarly            wrist trail + provisional view
 4 ┤ detectSwingPhasesWithDebug    phaseDetection.ts      5 phases + fallbackGate
 5 ┤ detectSwingStart              swingStartDetection.ts refine address frame (HIGH/LOW)
 6 ┤ angles:                       angles.ts
   │   • computePhaseWindowedAngles  (preferred — averages frames around phases)
   │   • calculateGolfAngles         (mid-frame fallback when shouldFallback)
 7 ┤ applyVisibilityWeighting      visibilityWeighting.ts drop low-conf joints
   │   + implausible-frame filter  implausibleFrameFilter.ts (heuristic path only)
 8 ┤ leadWristHinge / clubheadPath / faceToPath           swing_debug only (no UI yet)
 9 ┤ detectCameraAngle(addressFrame) cameraAngle.ts       final view + metric weights
10 ┤ correctForeshortening → applyTiltCorrection          perspective + device-tilt fix
11 ┤ calculateTempo                tempoAnalysis.ts        backswing/downswing ratio
   │   + withhold guard: isTempoTrustworthy / address-unreliable → tempo = null
12 ┤ computeAngleGating → scoreSwing  scoring.ts           headline score (tempo-only)
13 ┤ computeSwingConfidence         confidenceScore.ts     overall + tier + components
14 ┤ metricConfidences + aggregateSwing categoryAggregation.ts
   ▼
 AnalysisResult { score, honeyBoom, angles, tempo, phases, trail,
                  swingConfidence, cameraAngleResult, swing_debug }
```

Notes that matter when reading the code:
- **Canonical space (stage 2):** RH swings are mirrored, LH swings pass through,
  so downstream sign conventions hold for both. In canonical space the `left*`
  joints are the **TRAIL** arm — see the long comment at
  `analysisPipeline.ts:587-595`.
- **Two angle paths (stage 6):** the phase-windowed path is preferred; the
  mid-frame fallback runs only when phases are unreliable (`shouldFallback`),
  and it skips visibility weighting, wrist-hinge, and face-to-path entirely.
- **Empty input** returns a fully-zeroed `AnalysisResult` early
  (`analysisPipeline.ts:618`) rather than throwing.
- **`watchImuReadings` / `gravityReadings`** are optional sensor seams that
  no-op when empty — a swing with no paired sensor behaves exactly as before.

## Scoring model

The headline `score` is **tempo-only** — a 9-band traffic light over
`tempoRatio` (`scoring.ts:scoreTempoTrafficLight`). Angles are computed and
persisted but **do not** feed the headline number.

Angles are still consumed in-app — `computeFocus` (`lib/swingMotionStore.ts:75`)
picks the worst-scoring metric to drive the Visual Coach focus cue on the result
screen, called at `result.tsx:257` (`computeFocus(angles, getCachedAgeTier(),
Date.now())`); `record.tsx` displays the saved `FocusData` but does not call
`computeFocus` itself. `angles` is defined once, at `result.tsx:150`
(`analysis?.angles`), and that single definition is the only consumer inside
`result.tsx` — the live-vs-history resolution the doc previously attributed to
a second "history display" re-read now happens upstream, inside
`useSwingSource.ts` (`analysis` itself already resolves live store vs. history
fetch vs. reconstruction before `angles` is derived from it). The persisted
`category_scores` column, by contrast, has **no in-app reader** — written from
`analysis.aggregate` (`persistSwing.ts:134`) and selected in `swingStore.ts` but
consumed nowhere in this repo (likely the external web inspector / future use).

| Tempo ratio (backswing/downswing) | Score | Band |
|---|---|---|
| `< 0.5` | 25 | red |
| `[0.5, 1.0)` | 60 | yellow |
| `[1.0, 1.5)` | 70 | yellow |
| `[1.5, 2.0)` | 80 | yellow |
| **`[2.0, 4.3]`** | **100** | **green → `honeyBoom`** |
| `(4.3, 5.0]` | 90 | yellow |
| `(5.0, 6.0]` | 75 | yellow |
| `(6.0, 7.0]` | 60 | yellow |
| `> 7.0` | 25 | red |

- `honeyBoom = (score === 100)`.
- When tempo is withheld (unreliable phases / unreliable address frame), the
  pipeline passes `tempo: null` and `scoreSwing` returns `score: null` — a
  neutral "no score", **not** 0.
- A separate `TempoRating` label drives the UI text (`tempoAnalysis.ts:rateTempo`),
  on different thresholds: `rushed < 1.5`, `fast < 2.5`, `good < 3.5`,
  `slow < 4.5`, else `very_slow`. This label is independent of the numeric score.

## Core data types

From `packages/pose/PoseTypes.ts`:

- **`JointName`** — 35 named landmarks: face, upper body, hands, **thumb tips**
  (`leftThumbTip`/`rightThumbTip`, used by the face-on impact detector via
  `dx = thumbTip.x − thumb.x`), lower body, feet.
- **`NormalizedJoint`** — `{ name, x, y, z?, confidence?, vx?, vy?, vz? }`;
  coordinates normalized 0–1, optional depth, confidence, and per-axis velocity.
- **`PoseFrame`** — `{ timestampMs, joints: Record<JointName, NormalizedJoint?>,
  frameWidth, frameHeight }`.
- **`PoseSequence`** — `{ frames, source, metadata: { fps?, durationMs? } }`.

The pipeline's output (`AnalysisResult`, `analysisPipeline.ts:101`):

```ts
{
  score: number | null;            // tempo-only headline (null when withheld)
  honeyBoom: boolean;              // green band
  cameraAngleValid: boolean;
  angles?: GolfAngles;             // spine, elbows, knees, hip, shoulder tilt, drift
  tempo?: SwingTempo | null;       // backswing/downswing ms + ratio + rating
  phases?: DetectedPhase[];        // takeaway, top, downswing, impact, follow_through
  trail?: SwingTrailPoint[];       // wrist path for the overlay
  swingConfidence: SwingConfidence;// overall 0–1, tier, components
  cameraAngleResult: CameraAngleResult;
  metricConfidences?: …;           // per-metric visibility × camera confidence
  aggregate?: AggregateResult;     // category buckets (in-memory); a derived
                                   // category_scores column IS persisted (no in-repo reader)
  swing_debug?: FrameSelectionDebug;// full diagnostic tree (persisted)
}
```

## Persistence — the `swings` table

`persistSwing` (`lib/persistSwing.ts`) flattens `AnalysisResult` into one row.
The pure row-building helpers were extracted to `packages/domain/swing/swingRowBuilders.ts`
(unit-tested), so `persistSwing.ts` is now ~394 lines (was ~560) and focuses on
orchestration: auth, the insert, the FK-23503 heal-and-retry, and side-effects.
Columns, grouped (`lib/database.types.ts:215`):

| Group | Columns |
|---|---|
| Identity | `id`, `user_id`, `player_profile_id`, `created_at` |
| Headline | `score`, `honey_boom`, `capture_validity`, `pose_success_rate`, `frame_count`, `duration_ms`, `fps_actual` |
| Analysis (JSON) | `angles`, `tempo`, `phases`, `trail_points`, `metric_confidences`, `category_scores` |
| Raw pose (JSON) | `motion_frames` (velocity-enriched), `pose_full` |
| Timing | `backswing_ms`, `downswing_ms`, `tempo_ratio`, `impact_frame_index`, `phase_source` |
| Media | `video_storage_path`, `video_url`, `video_uploaded_at` |
| Sensors (JSON) | `gravity_vector`, `watch_imu` |
| Diagnostics | `swing_debug` (JSON) |
| Metadata | `app_version`, `coach_name`, `analysis_version`, `analysis_tier`, `is_favorite`, `failure_reason` |

`motion_frames` is stored **RAW** (un-mirrored, pre-identity-correction);
identity correction is re-applied at read time in
`lib/swingStore.ts` (`getSwingMotionFrames`), so it must stay idempotent.

## The `swing_debug` diagnostic tree

Every stage writes telemetry into `swing_debug` (`FrameSelectionDebug`,
`analysisPipeline.ts:54`). It is the audit trail used by the web swing inspector:
frame-selection method + fallback gate, camera-angle spreads (shoulder/hip/avg),
scoring breakdown, confidence components, foreshortening + tilt correction,
keypoint veto + identity maps, phase rules, lead-wrist hinge / synthetic clubhead
path / face-to-path, and `watch_imu_present`. Nothing here feeds the score — it
exists purely so a swing's outcome can be reconstructed and debugged after the fact.

## Phase detection (deep dive)

Phase detection turns the canonical wrist trail + pose frames into 5 ordered
swing phases. It is a **dispatcher**: `detectSwingPhasesWithDebug`
(`phaseDetection.ts:128`) picks a detector by the pre-detected camera angle, so
each viewpoint gets rules tuned for what it can actually see.

```
 detectSwingPhasesWithDebug(input)
   │  input = { canonical, trail, angle, preCanonical?, isLeftHanded? }
   │          (or a bare SwingTrailPoint[] → legacy, for back-compat callers)
   ▼
   angle === "dtl"     → detectDTLPhases       phaseDetectionDTL.ts
   angle === "face_on" → detectFaceOnPhases    phaseDetectionFaceOn.ts
   angle === "unknown" → detectLegacyPhases    phaseDetectionLegacy.ts
   ▼
   { phases: DetectedPhase[5], fallbackGate, ruleDebug }
```

All three return the **same 5-slot shape**, so tempo / scoring / angle-windowing
downstream never branch on camera angle:

| Phase | Meaning | Each `DetectedPhase` carries |
|---|---|---|
| `takeaway` | first committed move off the ball | `phase`, `label`, `index`, |
| `top` | top of backswing | `timestamp`, `point` (trail xy), |
| `downswing` | transition toward the ball | and `source`: |
| `impact` | club meets ball | `"heuristic"` (rules fired) |
| `follow_through` | finish / club decelerates | or `"fallback"` (fixed %) |

### Shared mechanics (`phaseDetectionShared.ts`)

- **One threshold table.** `EXTERNAL_ASSUMPTIONS` holds every numeric constant
  for both `dtl` and `faceOn` (search windows in **ms**, travel/velocity floors,
  consensus radii). Putting them in one object means the Dave-clinic
  recalibration step is a single edit, not a hunt through the detectors.
- **Frame-rate independence.** Rules express windows in milliseconds;
  `msToFrames(ms, msPerFrame)` converts using the capture's real ms/frame
  (`msPerFrameFromTrail`). The face-on impact search window
  `EXTERNAL_ASSUMPTIONS.faceOn.impact.consensus.downswingBudget` (= 50 @ 60fps,
  `phaseDetectionShared.ts:143`) now has an ms-sibling, `downswingBudgetMs: 833`
  (`phaseDetectionShared.ts:147`, commit `9eb2895`) — live consumers convert via
  `msToFrames`, so this is rate-independent ahead of the 120fps capture shipping
  (commit `a211128`). Related: `captureValidity.ts` (`VALID_MIN_MS = 500`,
  `PARTIAL_MIN_MS = 250`, commit `c3b82d5`) and `confidenceScore.ts`'s
  frame-coverage ramp (`MIN_MS = 250`, `GOOD_MS = 1000`, commit `405836f`) were
  converted to duration-based thresholds in the same rate-independence effort.
- **Shared takeaway gate.** `findSetupEndIndex` finds the end of address with a
  sign-aware directional test: slide an 8-frame window over canonical
  wrist-midpoint Δx, drop the min+max, require the middle 6 all `> 0` (a
  committed move in the takeaway direction, not a waggle/glove-tug). Falls back
  to a magnitude-only stillness gate (`findSetupEndIndexStillness`) when no
  directional onset is found or it arrives implausibly late (> 60% in).
- **Canonical-space trick.** Lefties are mirrored upstream, so "Δx > 0 = takeaway
  direction" and "trail wrist = `leftWrist`" hold for both handedness.

### Legacy detector — the `unknown` fallback (`phaseDetectionLegacy.ts`)

The pre-rules single path, kept 1:1 so `unknown`-angle swings behave exactly as
before the angle-aware split. Needs ≥ 6 trail points.

```
address  = findSetupEndIndex (shared takeaway gate)
top      = trail-wrist X minimum in [address+200ms, address+2000ms],
           guarded by lookahead + MIN_TRAVEL 0.04 (rejects shallow dips)
impact   = hand-low frame (max trail y) in [top+100ms, top+1500ms], + 67 ms
downswing= top + 35% of (impact − top)
finish   = first 3-frame velocity plateau below 0.008, else search-end
```

Then two sanity gates: indices must be **strictly increasing** and **≥ 2 frames
apart**. A final `backswing/downswing ≥ 0.8` ratio check guards against a
collapsed top. Any failure replaces the result with `fallbackPhases` (fixed
percentages `0.12 / 0.45 / 0.55 / 0.65 / 0.9`, every phase `source: "fallback"`)
and records why via `FallbackGate`:

| `FallbackGate` | Cause |
|---|---|
| `points_too_short` | < 6 trail points |
| `top_search_bounds` | no valid top window / no qualifying minimum |
| `impact_search_bounds` | no valid impact window |
| `impact_distance_out_of_range` | top→impact too far (> 40% of swing) or < 2 frames |
| `temporal_inversion` | phases not strictly increasing |
| `phases_too_bunched` | adjacent phases < 2 frames apart |
| `backswing_ratio_check_failed` | backswing/downswing < 0.8 |

`fallbackGate` is what the pipeline reads to decide the mid-frame angle fallback
and to **withhold tempo** when phases are untrustworthy.

### DTL detector (`phaseDetectionDTL.ts`)

Down-the-line sees rotation better than lateral wrist travel, so it anchors on
the body. Phase 0 swing-start is **hip `dSpreadX`** — the frame the hips first
commit to rotation (works in canonical space because the lefty joint-swap +
x-mirror cancel for a magnitude). It then scans a true-address stillness window
(spine/head/knee variance bounded), finds top by trail travel + lookahead, impact
by hand-low + 67 ms, and finish by a velocity plateau — all windows from the
`dtl` block of `EXTERNAL_ASSUMPTIONS`.

### Face-on detector (`phaseDetectionFaceOn.ts`)

Face-on sees the down-the-target-line geometry, so impact is detected
geometrically rather than by velocity:

- **Takeaway** uses the body-scaled `findTakeawayOnsetFaceOn`: the lead wrist
  must climb ≥ `0.5` body-heights (ruler = trimmed-mean nose↔ankle), rejecting
  waggles/feints via a sustained-reversal counter; falls back to the shared gate.
- **Top** is the lead-X extreme (median across nose / lead-shoulder / lead-ear,
  robust to one drifting landmark), re-anchored on the takeaway.
- **Impact** is an **xCross consensus** (`faceOnImpactConsensus.ts`): three
  geometric signals — S1 wrist-crosses-feet-midpoint, S2 arm-vertical, S3
  wrist-lowest — combined and refined by a sub-frame lead-thumb crossing, run on
  the **pre-canonical** (un-mirrored) frames over `[top, top+downswingBudget]`.
  Arc-bottom is the fallback.

### Telemetry — `swing_debug.phase_rules`

Every detector writes a `PhaseRuleDebug` record: which detector ran, swing-start /
true-address frames, per-rule reliability (`high/medium/low`), the
`external_assumptions_used`, and (face-on) full impact provenance —
`impact_source` (`consensus` vs `arc_bottom`), the consensus breakdown, the
shadow X-extreme top, and the takeaway path taken. This is the audit trail the
web inspector reads; none of it feeds the score directly.
