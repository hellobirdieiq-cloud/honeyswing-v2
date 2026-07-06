# HoneySwing

A golf swing analysis app for iOS. Point the camera, swing, get a score and coaching cue — all on-device.

## Tech Stack

- Expo 54 / React Native 0.81 / React 19 (new architecture)
- TypeScript 5.9 strict
- react-native-vision-camera (video recording; frame processor only for grip/hand capture)
- RTMW (133-point COCO-WholeBody, CoreML) — post-hoc pose extraction from the recorded video
- react-native-svg (skeleton overlay)
- iOS deployment target: 16.0

## Getting Started

Prerequisites: Node 18+, Xcode 15+, CocoaPods, an iOS device (simulator works but has no real camera).

```bash
npm install
cd ios && pod install && cd ..
npx expo run:ios
```

Expo Go is **not** sufficient — the app uses native modules (RTMW pose extraction, MediaPipe hand plugins) that require a dev client build.

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

packages/pose/        Pose layer
  PoseTypes.ts          Core types: PoseFrame, JointName, NormalizedJoint
  rtmw/                 RTMW backend: Rtmw133Frame, rtmwAdapter (RTMW → PoseFrame)

packages/domain/swing/  Analysis pipeline (pure TS, no UI)
  analysisPipeline.ts   Orchestrates: angles → phases → tempo → scoring
  angles.ts             7 biomechanical angles from joint positions
  phaseDetection.ts     5 swing phases (velocity heuristic + fallback)
  tempoAnalysis.ts      Backswing/downswing ratio + sanity checks
  scoring.ts            0–100 score from angle + tempo targets

modules/vision-camera-pose/  JS bridge to native pose extraction
  src/index.ts            extractRtmw / confirmBodyAtVideo entry points

ios/honeyswing/
  HoneyRTMWModule.swift               Native RTMW extraction (post-hoc, from video)
  rtmw_l_256x192.mlpackage            CoreML RTMW model
  HoneyVisionCameraHandPlugin.swift   MediaPipe hand plugin (grip screen only)
```

## App Flow

1. **Home** — "Start Swinging" navigates to Record tab
2. **Record** — camera preview with framing guide. Two capture modes: 3-2-1 countdown or instant. 4-second capture window (sub-1.2s clips are discarded); pose is extracted from the recording after capture ends.
3. **Result** — capture classified as valid / partial / invalid:
   - **Valid** — score, Visual Coach (skeleton highlighting weakest metric + coaching cue), tempo rating, Record Again
   - **Partial** — same result with "low confidence" caveat
   - **Invalid** — recovery screen: "Couldn't clearly capture your swing" + Record Again

## Key Architecture Notes

- All pose detection and analysis runs on-device; swing records sync to Supabase
- Pose is extracted post-hoc: the recorded video is run through the native RTMW model (133 COCO-WholeBody keypoints per frame) — no live frame processor on the record camera
- Analysis uses the mid-frame for angles, wrist trail for phase detection
- Tempo is withheld when phases are fallback-only, durations are implausibly short, or the ratio is implausible
- Current-swing state is in-memory (`swingMotionStore`); swings persist to Supabase via a durable outbox, with history in the History tab
- Scoring averages 7 component scores against biomechanical targets

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
- Post-hoc pose extraction via native RTMW (133-point COCO-WholeBody)
- Swing analysis (angles, phases, tempo, scoring)
- Visual Coach with color-coded skeleton + coaching cue
- Capture validity gate (valid / partial / invalid)
- Tempo sanity checks
- Record Again loop
- Swing history with video replay + swipe-to-delete
- Supabase persistence (durable outbox), sign-in, player profiles, coach view
- Grip capture (MediaPipe hand frame processor)

Not included yet:
- Android support (iOS only currently)
