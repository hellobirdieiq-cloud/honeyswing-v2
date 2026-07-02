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

HoneySwing is a golf swing analysis app. It captures pose data from the camera in real-time, then runs biomechanical analysis to score the swing. All processing is on-device.

### Three-Layer Package Structure

**Pose Abstraction** (`packages/pose/`) — Provider-based pose detection with a swappable backend interface (`PoseProvider`). Currently uses MLKitProvider wrapping MediaPipe Pose Landmarker (BlazePose GHUM Full). Key types: `PoseFrame`, `PoseSequence`, `JointName` (33 joints emitted to JS), `NormalizedJoint` (coordinates normalized 0-1).

**Domain Logic** (`packages/domain/swing/`) — Pure TypeScript swing analysis, no UI or native dependencies. The pipeline (`analysisPipeline.ts`) orchestrates: angle calculation → trail extraction → phase detection → tempo analysis (with sanity checks) → scoring. Entry point: `analyzePoseSequence(sequence)` for live pose data.

**UI Layer** (`app/`) — Expo Router screens. Record tab captures poses via Vision Camera frame processor worklet (max 180 frames, 4s capture window). Results screen shows score, Visual Coach (color-coded skeleton with worst-metric highlight), tempo rating, and "Record Again" CTA. Captures are classified as valid / partial / invalid before showing results.

### Native Module

`ios/HoneyVisionCameraPosePlugin.swift` — Vision Camera frame processor plugin (`honeyPoseDetect`). Uses MediaPipe `PoseLandmarker` with the Full model to detect 33 body landmarks, maps all 33 to JS via worklets. Image orientation handled via CIContext render (landscape → portrait).

### State Flow

Record screen → `swingMotionStore` (in-memory store in `lib/`) → `captureValidity` classifies capture → Analysis result screen. The store holds `PoseFrame[]` from capture and `AnalysisResult` from the pipeline. No persistence — state is lost on app restart.

DB timestamp strings are parsed only via `lib/datetime.ts` `parseDbTimestamp`; never `new Date()` on a column value (offset-less strings would be read as device-local and shift the instant).

### Domain Analysis Details

- **Angles** (`angles.ts`): 7 biomechanical angles (spine, elbows, knees, hip rotation, shoulder tilt). Min confidence threshold: 0.5.
- **Phases** (`phaseDetection.ts`): 5 swing phases (takeaway → top → downswing → impact → follow_through; `SwingPhase`, phaseDetection.ts:33-38). Uses velocity-based heuristic with setup detection; falls back to percentage-based splits.
- **Tempo** (`tempoAnalysis.ts`): Backswing/downswing ratio. "Good" = 2.5–3.5 ratio. Sanity checks withhold tempo when phases are fallback-only, durations < `TEMPO_MIN_PHASE_MS` (120ms, tempoAnalysis.ts:106), or ratio is implausible.
- **Scoring** (`scoring.ts`): 0–100 score averaging 7 component scores against biomechanical targets. Missing data scores 0.

## Tech Stack

- Expo 54 / React Native 0.81.5 / React 19 (new architecture enabled)
- TypeScript 5.9 strict mode, path alias `@/*` maps to repo root
- react-native-vision-camera 4.7.3 + react-native-worklets-core 1.6.3
- MediaPipe Pose Landmarker (BlazePose GHUM Full) for iOS pose detection
- react-native-svg for skeleton overlays
- iOS deployment target: 16.0
