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

Capture 4s of video → extract 133-keypoint poses → run the 16-stage pure-TS
analysis pipeline → hand off via an in-memory store to the results screen →
persist the full swing to Supabase for history and playback.
