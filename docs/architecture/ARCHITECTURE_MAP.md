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
│   ├── extractPoseFromVideo.ts ← runs RTMW pose detector on the MP4
│   ├── swingMotionStore.ts     ← in-memory handoff: record → result
│   ├── persistSwing.ts         ← writes the row to Supabase
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
| Persistence | `lib/persistSwing.ts` | `persistSwing` → `swings` table |
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
