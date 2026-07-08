# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npx expo start          # Start Expo dev server
npx expo run:ios        # Build and run on iOS simulator/device
npx expo run:android    # Build and run on Android
npx expo lint           # Run ESLint
npx tsc --project tsconfig.json  # TypeScript type checking
```

iOS native rebuild (after changing Swift/Podfile):
```bash
cd ios && pod install && cd ..
npx expo run:ios
```

## Architecture

HoneySwing is a golf swing analysis app. It records a video of the swing, extracts pose data from the recording post-hoc with a native RTMW model, then runs biomechanical analysis to score the swing. All processing is on-device.

### Three-Layer Package Structure

**Pose Layer** (`packages/pose/`) — Core pose types (`PoseTypes.ts`: `PoseFrame`, `PoseSequence`, `JointName`, `NormalizedJoint` with coordinates normalized 0-1) plus the RTMW backend (`rtmw/`): `Rtmw133Frame` (133-point COCO-WholeBody keypoints) and `rtmwAdapter` which converts RTMW output to `PoseFrame`.

**Domain Logic** (`packages/domain/swing/`) — Pure TypeScript swing analysis, no UI or native dependencies. The pipeline (`analysisPipeline.ts`) orchestrates: lower-body identity correction → trail extraction → phase detection (camera-angle routed) → phase-windowed angle calculation (mid-frame is fallback only) → camera-angle detection → tempo analysis (with sanity checks) → scoring. Entry point: `analyzePoseSequence(sequence)` for extracted pose data.

**UI Layer** (`app/`) — Expo Router screens. Record tab records a plain video clip via Vision Camera `startRecording` (H.265, 4s capture window, 1200ms validity floor) — there is NO frame processor on the record camera; pose is extracted from the recording after it finishes. Results screen shows score, swing skeleton replay (`SwingSkeletonCanvas`, video-synced or self-clocked), coaching cue, tempo rating, and "Record Again" CTA. Captures are classified as valid / partial / invalid before showing results.

### Native Module

`ios/honeyswing/HoneyRtmwOneShotPlugin.swift` — native RTMW pose extraction (CoreML `rtmw_l_256x192.mlpackage`), invoked post-capture via `extractRtmw` → `HoneyRtmwOneShotPlugin.extractRtmwFromVideo` (`modules/vision-camera-pose/src`, wired through `lib/extractPoseFromVideo.ts`), and gated by a body-confirm check that runs FIRST: `HoneyAppleVisionBodyConfirmPlugin.confirmBodyAtVideo` fails no-person clips fast, before any extraction. Extracts 133 COCO-WholeBody keypoints per frame from the recorded video. (`HoneyRTMWModule.swift` also ships but is only a diagnostic probe — see `lib/rtmwProbe.ts`.) Separate MediaPipe **hand** frame processors (`HoneyVisionCameraHandPlugin.swift`) serve only the grip-capture screen (`app/grip/capture.tsx`) — that is the sole remaining live frame-processor path.

### State Flow

Record screen → `startRecording` → `processRecordedVideo` (`lib/captureProcessing.ts`) → `extractPoseFromVideo` (native RTMW) → `swingMotionStore` (in-memory store in `lib/`) → `captureValidity` classifies capture → Analysis result screen. The store holds `PoseFrame[]` from capture and `AnalysisResult` from the pipeline. Swings persist to Supabase (`lib/persistSwing.ts`, `lib/persistPoseFull.ts`) through a durable outbox (`lib/outbox.ts`); history is browsable in the History tab. Prod rows are written with `analysis_version: 'v2'`.

DB timestamp strings are parsed only via `lib/datetime.ts` `parseDbTimestamp`; never `new Date()` on a column value (offset-less strings would be read as device-local and shift the instant).

### Domain Analysis Details

- **Angles** (`angles.ts`): 7 biomechanical angles (spine, elbows, knees, hip rotation, shoulder tilt). Min confidence threshold: 0.5.
- **Phases** (`phaseDetection.ts`): 5 swing phases (takeaway → top → downswing → impact → follow_through; `SwingPhase`, phaseDetection.ts:33-38). Routes by detected camera angle to rule-based detectors (`detectFaceOnPhases` / `detectDTLPhases`); the velocity-based heuristic survives only in the legacy detector for unknown-angle swings, with percentage-based fallback splits.
- **Tempo** (`tempoAnalysis.ts`): Backswing/downswing ratio. "Good" = 2.5–3.5 ratio. Sanity checks withhold tempo when phases are fallback-only, durations < `TEMPO_MIN_PHASE_MS` (120ms, tempoAnalysis.ts:106), or ratio is implausible.
- **Scoring** (`scoring.ts`): headline score is tempo-only — the tempo ratio maps to one of 9 bands (green band 2.0–4.3 → 100). Withheld/missing tempo → `score: null`, rendered as an em-dash (never 0).

## Tech Stack

- Expo 54 / React Native 0.81.5 / React 19 (new architecture enabled)
- TypeScript 5.9 strict mode, path alias `@/*` maps to repo root
- react-native-vision-camera 4.7.3 (video recording on the record screen; frame processor only on the grip/hand screen) + react-native-worklets-core 1.6.3
- RTMW (133-point COCO-WholeBody, CoreML) for post-hoc iOS pose extraction; MediaPipe Hands for grip capture
- react-native-svg for skeleton overlays
- iOS deployment target: 17.0 (`app.json` build-properties)
