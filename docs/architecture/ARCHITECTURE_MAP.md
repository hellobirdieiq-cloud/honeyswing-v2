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

The key property: **`packages/domain/swing` has zero UI and zero native
dependencies.** All the biomechanics (phase detection, angles, tempo, scoring)
is plain functions over `PoseFrame[]`, which is why it is fully unit-tested
(`*.test.ts` files live next to each module). The UI and native layers feed it
data and render its output, but never live inside it.

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
│   ├── captureFlow.ts          ← pure capture-flow decisions (+ .test.ts)
│   ├── extractPoseFromVideo.ts ← runs RTMW pose detector on the MP4
│   ├── swingMotionStore.ts     ← in-memory handoff: record → result
│   ├── persistSwing.ts         ← writes the row to Supabase (orchestration)
│   ├── swingRowBuilders.ts     ← pure swings-row builders (+ .test.ts)
│   ├── swingStore.ts           ← reads swings back (history / playback)
│   └── supabase.ts · database.types.ts · …
│
├── packages/
│   ├── pose/                   ← pose abstraction (swappable backend)
│   │   ├── PoseProvider.ts · PoseTypes.ts   (PoseFrame, PoseSequence)
│   │   └── rtmw/               ← 133-keypoint RTMW adapter
│   └── domain/swing/           ← 🧠 PURE analysis (no UI / no native)
│       ├── analysisPipeline.ts ← master orchestrator (16 stages)
│       ├── phaseDetection.ts · angles.ts · tempoAnalysis.ts
│       ├── scoring.ts · cameraAngle.ts · lowerBodyIdentity.ts
│       └── … (keypointVeto, canonicalTransform, confidenceScore, …)
│
├── native-assets/ios/HoneyVisionCameraPosePlugin.swift  ← live MediaPipe
├── modules/vision-camera-pose/                          ← native bridge
└── supabase/migrations/        ← DB schema history (swings table)
```

## Code size (snapshot — 2026-06-27)

Counts source files only (`.ts`, `.tsx`, `.swift`); excludes `node_modules`,
build output (`ios/Pods`, `ios/build`, `.expo`, `dist`, `.venv`), and the
generated `lib/database.types.ts`. Regenerate with the same scan before trusting.

The per-area table below covers **7 areas** (`.ts/.tsx/.swift` only); the
whole-repo reconciliation follows it.

| Area | Lines | Files |
|---|--:|--:|
| `lib/` | 16,902 | 89 |
| `packages/domain/swing/` | 12,698 | 48 |
| `app/` | 12,479 | 44 |
| `native-assets/` | 2,654 | 11 |
| `supabase/` | 682 | 2 |
| `packages/pose/` | 531 | 7 |
| `modules/` | 77 | 2 |
| **Total** | **46,023** | **203** |

**10 biggest single files**

| Lines | File |
|--:|---|
| 1,218 | `packages/domain/swing/phaseDetectionFaceOn.ts` |
| 998 | `lib/outbox.ts` |
| 983 | `lib/visibilityWeighting.test.ts` |
| 904 | `app/clinic/coach-mode/Tab1LiveView.tsx` |
| 850 | `app/analysis/result.tsx` |
| 797 | `app/(tabs)/settings.tsx` |
| 780 | `lib/tiltCorrection.test.ts` |
| 776 | `packages/domain/swing/analysisPipeline.ts` |
| 729 | `lib/foreshorteningCorrection.test.ts` |
| 725 | `lib/positiveReinforcement.test.ts` |

**Test vs non-test (by area)**

| Area | Test LOC | Non-test LOC | % tests |
|---|--:|--:|--:|
| `lib/` | 8,928 | 7,974 | 53% |
| `packages/domain/swing/` | 4,277 | 8,421 | 34% |
| `app/` | 0 | 12,479 | 0% |
| `packages/pose/` | 110 | 421 | 21% |
| `native-assets/` | 0 | 2,654 | 0% |
| `supabase/` | 0 | 682 | 0% |
| `modules/` | 0 | 77 | 0% |

`lib/` is now over half tests — the write-path extraction added
`swingRowBuilders.test.ts` (+322) and `captureFlow.test.ts` (+109).

### Whole-repo reconciliation

The per-area table above is a **7-area subset** (`app/ lib/ packages/pose/
packages/domain/swing/ native-assets/ modules/` + supabase `.ts`), `.ts/.tsx/.swift`
only. The whole repo (adds `.sql`, plus the areas below) is:

**292 files / 67,365 lines.** Subtracting the 4,932-line generated
`supabase/migrations/20260417055038_remote_schema.sql` leaves **62,433** — but
that is an **upper bound** on hand-authored code, not a pure figure: it still
includes `ios/honeyswing/` generated/duplicated Swift (3,246; `AppDelegate.swift`
is Expo-generated, the `Honey*` plugins are build-time copies of
`native-assets/ios/`). Removing those too puts hand-authored at **≈ 59,187**.

Areas missing from the 7-area view:

| Area | Lines | Files |
|---|--:|--:|
| `scripts/` (dev/diagnostic tooling) | 8,849 | 27 |
| `supabase/` `.sql` migrations | 5,209 | 14 |
| `ios/honeyswing/` (generated/duplicated native) | 3,246 | 13 |
| `components/` | 2,164 | 11 |
| `packages/domain/clinic/` | 1,116 | 14 |
| `targets/watch/` (parked, unshipped Watch IMU) | 756 | 9 |
| root (`expo-env.d.ts`) | 2 | 1 |
| **Added** | **21,342** | **89** |

Reconciliation (proves the old 203 / 46,023 was a 7-area subset):

```
  46,023   7-area subset (.ts/.tsx/.swift)
+ 15,017   remainder (scripts + ios/honeyswing + components + targets/watch + root)
+  1,116   packages/domain/clinic (.ts, previously missed)
+  5,209   supabase .sql migrations (7-area supabase figure was .ts-only)
= 67,365   whole repo   (files: 203 + 61 + 14 + 14 = 292)
```

Note: `scripts/` is dev/diagnostic tooling, not shipped app code, and
`targets/watch/` is the parked, unshipped Watch IMU feature — neither inflates
shipped app size. `ios/honeyswing/` is generated/duplicated native glue
(`AppDelegate.swift` generated; `Honey*` plugins are build-time copies of
`native-assets/ios/`), so the `62,433` figure overstates hand-authored code;
excluding `ios/honeyswing/` lands at **≈ 59,187**.

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
 │ EXTRACT  (extractPoseFromVideo.ts)                           │
 │   MP4 ──► RTMW detector ──► 133-keypoint frames              │
 │        ──► rtmwToPoseFrame() ──► PoseSequence                │
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
| Row builders (pure, tested) | `lib/swingRowBuilders.ts` | `buildWatchImuDebug`, `enrichFramesWithVelocity`, `calcPoseSuccessRate`, … |
| Capture-flow decisions (pure, tested) | `lib/captureFlow.ts` | `computeNavigationBlockReason`, `deriveClassification` |
| Playback read | `lib/swingStore.ts` | `getSwingById`, `getSwingMotionFrames` |

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

`analyzePoseSequence` (`packages/domain/swing/analysisPipeline.ts:520`) is the
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
  `analysisPipeline.ts:554` and `[[project_faceon_impact_trail_wrist]]`.
- **Two angle paths (stage 6):** the phase-windowed path is preferred; the
  mid-frame fallback runs only when phases are unreliable (`shouldFallback`),
  and it skips visibility weighting, wrist-hinge, and face-to-path entirely.
- **Empty input** returns a fully-zeroed `AnalysisResult` early
  (`analysisPipeline.ts:585`) rather than throwing.
- **`watchImuReadings` / `gravityReadings`** are optional sensor seams that
  no-op when empty — a swing with no paired sensor behaves exactly as before.

## Scoring model

The headline `score` is **tempo-only** — a 9-band traffic light over
`tempoRatio` (`scoring.ts:scoreTempoTrafficLight`). Angles are computed and
persisted but **do not** feed the headline number.

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

The pipeline's output (`AnalysisResult`, `analysisPipeline.ts:100`):

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
  aggregate?: AggregateResult;     // category buckets (in-memory; not persisted)
  swing_debug?: FrameSelectionDebug;// full diagnostic tree (persisted)
}
```

## Persistence — the `swings` table

`persistSwing` (`lib/persistSwing.ts`) flattens `AnalysisResult` into one row.
The pure row-building helpers were extracted to `lib/swingRowBuilders.ts`
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
See `[[project_motion_frames_coordinate_space]]`.

## The `swing_debug` diagnostic tree

Every stage writes telemetry into `swing_debug` (`FrameSelectionDebug`,
`analysisPipeline.ts:53`). It is the audit trail used by the web swing inspector:
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
  (`msPerFrameFromTrail`). ⚠️ A few consensus constants are raw *frame* counts
  validated only at 60 fps — flagged in-source for conversion before non-60fps
  capture ships.
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
