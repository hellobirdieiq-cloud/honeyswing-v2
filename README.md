# HoneySwing

A golf swing analysis app for iOS. Point the camera, swing, get a score and coaching cue — all on-device.

## Tech Stack

- Expo 54 / React Native 0.81 / React 19 (new architecture)
- TypeScript 5.9 strict
- react-native-vision-camera + react-native-worklets-core (frame processor)
- MediaPipe Pose Landmarker (BlazePose GHUM Full, 33 landmarks → 17 emitted to JS)
- react-native-svg (skeleton overlay)
- iOS deployment target: 16.0

## Getting Started

Prerequisites: Node 18+, Xcode 15+, CocoaPods, an iOS device (simulator works but has no real camera).

```bash
npm install
cd ios && pod install && cd ..
npx expo run:ios
```

Expo Go is **not** sufficient — the app uses a native Vision Camera frame processor plugin that requires a dev client build.

## Project Structure

```
app/                  Expo Router screens
  (tabs)/index.tsx      Home — Start Swinging CTA
  (tabs)/record.tsx     Record — camera, skeleton overlay, capture flow
  analysis/result.tsx   Result — score, Visual Coach, tempo chip

components/           Shared UI
  SkeletonOverlay.tsx   Live + static skeleton renderer (SVG)
  VisualCoachCard.tsx   Color-coded skeleton with worst-metric highlight

lib/                  App-level utilities
  swingMotionStore.ts   In-memory store for current swing frames + analysis
  captureValidity.ts    Capture classification (valid / partial / invalid)

packages/pose/        Pose abstraction layer
  PoseTypes.ts          Core types: PoseFrame, JointName, NormalizedJoint
  PoseProvider.ts       Provider interface
  providers/MLKitProvider.ts  Converts native landmarks → PoseFrame

packages/domain/swing/  Analysis pipeline (pure TS, no UI)
  analysisPipeline.ts   Orchestrates: angles → phases → tempo → scoring
  angles.ts             7 biomechanical angles from joint positions
  phaseDetection.ts     6 swing phases (velocity heuristic + fallback)
  tempoAnalysis.ts      Backswing/downswing ratio + sanity checks
  scoring.ts            0–100 score from angle + tempo targets

modules/vision-camera-pose/  Native frame processor plugin
  src/index.ts            JS bridge (honeyPoseDetect worklet)
  ios/                    Swift plugin (inactive copy — active copy in ios/)

ios/
  HoneyVisionCameraPosePlugin.swift   Active MediaPipe plugin
  pose_landmarker_full.task           MediaPipe model file (9MB)
```

## App Flow

1. **Home** — "Start Swinging" navigates to Record tab
2. **Record** — camera preview with live skeleton overlay. Two capture modes: 3-2-1 countdown or instant. 4-second capture window. Pre-record tips show for first 3 visits.
3. **Result** — capture classified as valid / partial / invalid:
   - **Valid** — score, Visual Coach (skeleton highlighting weakest metric + coaching cue), tempo rating, Record Again
   - **Partial** — same result with "low confidence" caveat
   - **Invalid** — recovery screen: "Couldn't clearly capture your swing" + Record Again

## Key Architecture Notes

- All pose detection and analysis runs on-device — no server calls
- MediaPipe detects 33 landmarks per frame; plugin maps 17 to JS (body joints only)
- Analysis uses the mid-frame for angles, wrist trail for phase detection
- Tempo is withheld when phases are fallback-only, durations < 50ms, or ratio is implausible
- Session state is in-memory only — no persistence across app restarts
- Scoring averages 7 component scores (6 angles + tempo) against biomechanical targets; missing data scores neutral 50

## Useful Commands

```bash
npx expo start              # Dev server
npx expo run:ios            # Build + run on iOS
npx tsc --project tsconfig.json --noEmit  # Type check
npx expo lint               # ESLint
cd ios && pod install       # After changing Podfile or Swift
```

## Current State

Implemented:
- Real-time pose detection via MediaPipe
- Live skeleton overlay on camera
- Swing analysis (angles, phases, tempo, scoring)
- Visual Coach with color-coded skeleton + coaching cue
- Capture validity gate (valid / partial / invalid)
- Pre-record framing tips (first 3 sessions)
- Tempo sanity checks
- Record Again loop

Not included yet:
- Swing history / persistence
- User accounts / auth
- Backend / Supabase integration
- Streak tracking / personal bests
- Android support (iOS only currently)
