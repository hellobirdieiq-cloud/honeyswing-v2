# MediaPipe Hands Integration — Phase 1 Audit

**Date:** 2026-03-27
**Branch:** v3-dev

---

## 1. Files in modules/vision-camera-pose/ios/

Three files total:

| File | Purpose |
|------|---------|
| `modules/vision-camera-pose/ios/HoneyVisionCameraPosePlugin.swift` | MediaPipe PoseLandmarker implementation (33 BlazePose landmarks). Dead code — not compiled into the app target. |
| `modules/vision-camera-pose/ios/HoneyVisionCameraPosePlugin.m` | ObjC bridge using `VISION_EXPORT_FRAME_PROCESSOR` category pattern (line 12). Dead code — not in PBXSourcesBuildPhase. |
| `modules/vision-camera-pose/src/index.ts` | JS proxy — `VisionCameraProxy.initFrameProcessorPlugin('honeyPoseDetect', {})` (line 3). This IS used at runtime by `app/(tabs)/record.tsx:12`. |

No `package.json`, no `.podspec`, no `expo-module.config.json` in the module directory. The module has no build integration — only the JS entry point is consumed (via direct import path).

---

## 2. MediaPipeTasksVision in Podfile

**Yes, installed.**

- `ios/Podfile:48` — `pod 'MediaPipeTasksVision', '~> 0.10.14'`
- `ios/Podfile.lock:273` — resolved to `MediaPipeTasksVision (0.10.21)`
- `ios/Podfile.lock:272` — transitive dep `MediaPipeTasksCommon (0.10.21)`

The `MediaPipeTasksVision` pod provides both `PoseLandmarker` and `HandLandmarker` classes. No additional pod is needed for hand detection.

---

## 3. pose_landmarker_full.task in bundle

**Yes, bundled.**

- On disk: `ios/pose_landmarker_full.task` (9.0 MB)
- PBXFileReference: `project.pbxproj:33` — ID `AABB001122334455DEAD0001`
- PBXBuildFile: `project.pbxproj:15` — ID `AABB001122334455DEADBEEF`
- PBXResourcesBuildPhase: `project.pbxproj:209` — included in Resources build phase

The model is bundled into the app binary. The active MediaPipe plugin (`ios/HoneyVisionCameraPosePlugin.swift:55-57`) loads it via `Bundle.main.path(forResource: "pose_landmarker_full", ofType: "task")`.

---

## 4. Existing hand landmark code

**None found.** No references to:

- `HandLandmarker`
- `hand_landmarker`
- `handLandmark` / `HandPose` / `VNDetectHandPose`
- 21-point hand model or hand landmark indices

The grip feature (`app/grip/capture.tsx`, `lib/classifyGrip.ts`, `supabase/functions/classify-grip/`) uses static photos sent to Claude Vision API for classification — no on-device hand pose estimation.

The word "hand" appears in grip-related contexts only (e.g., `lead_hand`, `trail_hand` in `lib/classifyGrip.ts:7-8`; `isLeftHanded` in `lib/handedness.ts:5`). These refer to golfer handedness, not hand landmarks.

---

## 5. Frame processor plugin registration mechanism

**Compiled plugin (ios/ directory):**

`ios/HoneyVisionCameraPosePlugin.swift:6-7`:
```swift
@objc(HoneyVisionCameraPosePlugin)
public class HoneyVisionCameraPosePlugin: FrameProcessorPlugin {
```

`ios/HoneyVisionCameraPosePlugin.m:7`:
```objc
VISION_EXPORT_SWIFT_FRAME_PROCESSOR(HoneyVisionCameraPosePlugin, honeyPoseDetect)
```

Registration pattern:
1. Swift class inherits from `FrameProcessorPlugin` (from VisionCamera framework)
2. Class is annotated with `@objc(HoneyVisionCameraPosePlugin)` for ObjC bridging
3. ObjC file imports the auto-generated `HoneySwingV2-Swift.h` bridging header (line 5)
4. `VISION_EXPORT_SWIFT_FRAME_PROCESSOR` macro registers the class under plugin name `"honeyPoseDetect"`
5. JS side calls `VisionCameraProxy.initFrameProcessorPlugin('honeyPoseDetect', {})` to get a handle
6. Frame processor worklet calls `plugin.call(frame)` which invokes the Swift `callback(_:withArguments:)` method

**Note:** The modules/ .m file uses a different macro (`VISION_EXPORT_FRAME_PROCESSOR` with an ObjC category pattern at line 12) vs the compiled ios/ .m file (`VISION_EXPORT_SWIFT_FRAME_PROCESSOR` one-liner at line 7). Both register the same plugin name `honeyPoseDetect`.

---

## 6. Rendering library for overlays

**react-native-svg** is installed and actively used.

- `package.json:42` — `"react-native-svg": "^15.12.1"`
- `components/SkeletonOverlay.tsx:3` — `import Svg, { Circle, Line } from 'react-native-svg'`

Overlay components that render pose data:

| Component | File | Usage |
|-----------|------|-------|
| `SkeletonOverlay` | `components/SkeletonOverlay.tsx` | Real-time skeleton during capture. Uses `Svg`, `Circle`, `Line`. Renders joints as dots + bone connections. Supports cover-crop transform and mirroring. |
| `VisualCoachCard` | `components/VisualCoachCard.tsx` | Post-capture result screen. Same SVG skeleton with color-coded worst-metric highlighting. |
| `SwingArtCard` | `components/SwingArtCard.tsx` | Post-capture result screen. Artistic swing arc visualization with ghost silhouettes. |

All three use name-based joint lookup (`Map<string, Landmark>` or `getJoint(frame, name)`). Adding hand landmark rendering would follow the same pattern.

---

## 7. Multiple frame processor plugins

**Yes, VisionCamera supports multiple registered plugins.** Each `VISION_EXPORT_SWIFT_FRAME_PROCESSOR` / `VISION_EXPORT_FRAME_PROCESSOR` call registers an independent plugin under a unique string name.

Currently only one plugin is registered: `honeyPoseDetect`.

A second plugin (e.g., `honeyHandDetect`) could be registered by:
1. Creating a new Swift class inheriting from `FrameProcessorPlugin`
2. Adding a new ObjC file with `VISION_EXPORT_SWIFT_FRAME_PROCESSOR(NewClass, honeyHandDetect)`
3. Creating a JS proxy via `VisionCameraProxy.initFrameProcessorPlugin('honeyHandDetect', {})`
4. Calling both plugins sequentially in the frame processor worklet

However, per the migration plan in `docs/migration-audit.md` (Section 7b), the recommended approach is a **single plugin with conditional hand detection** via the `arguments` parameter, rather than separate plugins. This avoids dual registration complexity and allows body+hands to share the CIContext image rendering step.

**Important constraint:** The frame processor worklet runs synchronously. Multiple sequential plugin calls in the same worklet multiply per-frame latency additively. At the current effective rate of 30 fps (120fps camera / skipInterval 4), the combined budget is 33.3ms per processed frame.
