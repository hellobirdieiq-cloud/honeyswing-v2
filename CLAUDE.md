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

HoneySwing V2 is a golf swing analysis app. It captures pose data from the camera in real-time, then runs biomechanical analysis to score the swing.

### Three-Layer Package Structure

**Pose Abstraction** (`packages/pose/`) — Provider-based pose detection with a swappable backend interface (`PoseProvider`). Currently uses MLKit provider wrapping Apple Vision.framework. Key types: `PoseFrame`, `PoseSequence`, `JointName` (21 joints), `NormalizedJoint` (coordinates normalized 0-1).

**Domain Logic** (`packages/domain/swing/`) — Pure TypeScript swing analysis, no UI or native dependencies. The pipeline (`analysisPipeline.ts`) orchestrates: angle calculation → trail extraction → phase detection → tempo analysis → scoring. Entry points: `analyzeSwing(videoUri)` for video files, `analyzePoseSequence(sequence)` for live pose data.

**UI Layer** (`app/`) — Expo Router screens. Record tab captures poses via Vision Camera frame processor worklet (max 180 frames, 2.2s capture window). Results screen shows score, tempo, angles, phases, and "Honey Boom" badge (score ≥ 85).

### Native Module

`modules/vision-camera-pose/` — Vision Camera frame processor plugin (`honeyPoseDetect`). The Swift implementation (`HoneyVisionCameraPosePlugin.swift`) uses `VNDetectHumanBodyPoseRequest` to detect body joints and returns landmarks to JS via worklets.

### State Flow

Record screen → `swingMotionStore` (global store in `lib/`) → Analysis result screen. The store holds `PoseFrame[]` from capture and `AnalysisResult` from the pipeline.

### Domain Analysis Details

- **Angles** (`angles.ts`): 7 biomechanical angles (spine, elbows, knees, hip rotation, shoulder tilt). Min confidence threshold: 0.5.
- **Phases** (`phaseDetection.ts`): 6 swing phases (address → takeaway → top → downswing → impact → finish). Uses velocity-based heuristic with percentage-based fallback.
- **Tempo** (`tempoAnalysis.ts`): Backswing/downswing ratio. "Good" = 2.5–3.5 ratio.
- **Scoring** (`scoring.ts`): 0–100 score averaging 7 component scores against biomechanical targets. Missing data scores 50 (neutral).

## Tech Stack

- Expo 54 / React Native 0.81.5 / React 19 (new architecture enabled)
- TypeScript 5.9 strict mode, path alias `@/*` maps to repo root
- react-native-vision-camera 4.7.3 + react-native-worklets-core 1.6.3
- Apple Vision.framework for iOS pose detection
- Supabase client (stubbed for future backend)
- iOS deployment target: 16.0
