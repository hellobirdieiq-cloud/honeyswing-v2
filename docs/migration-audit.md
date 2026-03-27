# Migration Audit: Pose Backend Verification

**Date:** 2026-03-27
**Branch:** v3-dev
**Purpose:** Verify actual compiled/running ML backend before MediaPipe body+hands migration

---

## 1. REPO TRUTH CHECK

### a) Which native plugin is actually compiled and registered?

**Apple Vision.** The Xcode project compiles `ios/HoneyVisionCameraPosePlugin.swift` (Apple Vision, 70 lines) — NOT the MediaPipe version in `modules/`.

**PBXSourcesBuildPhase** (`project.pbxproj:341-353`):
```
7E47E6622F6A735100932D12 /* HoneyVisionCameraPosePlugin.swift in Sources */   (line 346)
7E47E6632F6A735100932D12 /* HoneyVisionCameraPosePlugin.m in Sources */        (line 347)
F11748422D0307B40044C1D9 /* AppDelegate.swift in Sources */                     (line 348)
F7749C89B808CA66FAABB190 /* ExpoModulesProvider.swift in Sources */             (line 349)
```

File references (`project.pbxproj:28-29`) use `path = HoneyVisionCameraPosePlugin.swift`, `sourceTree = "<group>"`. Parent group is the project root (`project.pbxproj:99`), which resolves to `ios/`. Confirmed by sibling file `pose_landmarker_full.task` at line 33 resolving to `ios/pose_landmarker_full.task`.

The compiled file (`ios/HoneyVisionCameraPosePlugin.swift:2`) imports `Vision` (Apple framework), uses `VNDetectHumanBodyPoseRequest` (line 17), and outputs **17 joints** (lines 27-45).

The ObjC bridge (`ios/HoneyVisionCameraPosePlugin.m:7`) registers:
```objc
VISION_EXPORT_SWIFT_FRAME_PROCESSOR(HoneyVisionCameraPosePlugin, honeyPoseDetect)
```

### b) Which JS/TS entrypoint initializes the plugin?

`modules/vision-camera-pose/src/index.ts:3`:
```ts
const plugin = VisionCameraProxy.initFrameProcessorPlugin('honeyPoseDetect', {});
```

Imported by `app/(tabs)/record.tsx:12`:
```ts
import { honeyPoseDetect } from '../../modules/vision-camera-pose/src';
```

Called in the frame processor worklet at `record.tsx:393`:
```ts
const landmarks = honeyPoseDetect(frame);
```

The JS proxy is backend-agnostic — it calls the native plugin by name `'honeyPoseDetect'`. The native side that registers this name is determined by Xcode compilation, which is the `ios/` Apple Vision version.

### c) Which Pod dependencies are installed AND actually used by compiled code?

**Podfile** (`ios/Podfile:47-48`):
```ruby
# MediaPipe Pose Landmarker (BlazePose GHUM, 33 landmarks)
pod 'MediaPipeTasksVision', '~> 0.10.14'
```

**Podfile.lock** confirms installed: `MediaPipeTasksVision (0.10.21)` (line 273), `MediaPipeTasksCommon (0.10.21)` (line 272).

**Actually used by compiled code:** NONE. The compiled `ios/HoneyVisionCameraPosePlugin.swift` imports only `Foundation`, `Vision`, `VisionCamera`, `CoreMedia` (lines 1-4). It does NOT import `MediaPipeTasksVision`.

`MediaPipeTasksVision` is installed but **zero compiled Swift files reference it**. It is dead weight in the pod dependencies.

### d) Is the MediaPipe native module linked into the app target?

**No.** The `modules/vision-camera-pose/` directory contains:
- `ios/HoneyVisionCameraPosePlugin.swift` (128 lines, MediaPipe)
- `ios/HoneyVisionCameraPosePlugin.m` (14 lines)
- `src/index.ts` (14 lines)

Missing integration files:
- No `package.json`
- No `expo-module.config.json`
- No `.podspec`
- Not referenced in root `package.json`
- Not referenced in `Podfile`
- **Not in PBXSourcesBuildPhase** — only 4 files are compiled (see section a), all from `ios/`

The modules/ Swift files are **not compiled into the app binary**.

### e) Which model files are present in the bundle and what is each one for?

**PBXResourcesBuildPhase** (`project.pbxproj:200-213`):
```
pose_landmarker_full.task in Resources    (line 209, build file ref line 15)
```

File: `ios/pose_landmarker_full.task` — 9.0 MB (MediaPipe Pose Landmarker Full model, BlazePose GHUM 33 landmarks).

**This model is bundled but unused.** The compiled Apple Vision plugin (`ios/HoneyVisionCameraPosePlugin.swift`) uses Apple's built-in `VNDetectHumanBodyPoseRequest` API, which requires no external model file. No compiled code calls `Bundle.main.path(forResource: "pose_landmarker_full", ofType: "task")`.

No other `.task` or `.tflite` model files found in the project.

### f) Does downstream TypeScript expect 17 joints or 33 joints?

**33 joints (mapped to 39 JointName entries).** `PoseTypes.ts:1-39` defines a `JointName` union of 39 values:
- Face: 11 (nose, leftEyeInner, leftEye, leftEyeOuter, rightEyeInner, rightEye, rightEyeOuter, leftEar, rightEar, mouthLeft, mouthRight)
- Upper body: 6 (shoulders, elbows, wrists)
- Hands: 6 (leftPinky, rightPinky, leftIndex, rightIndex, leftThumb, rightThumb)
- Lower body: 6 (hips, knees, ankles)
- Feet: 4 (leftHeel, rightHeel, leftFootIndex, rightFootIndex)

`createEmptyJoints()` (`PoseTypes.ts:81-117`) initializes all 39 as `undefined`.

`MLKitProvider.ts:10-44` maps all 39 names in `V1_TO_V2_JOINT_MAP`.

**But the compiled native plugin only emits 17** (Apple Vision joints: nose, leftEye, rightEye, leftEar, rightEar, shoulders, elbows, wrists, hips, knees, ankles). The remaining 22 slots (face detail, hands, feet) are always `undefined` at runtime.

### g) Does any downstream code reference joints by index rather than by name?

**No index-based joint access found in the TS/JS layer.** All access is name-based:

- `angles.ts:42-44`: `getJoint(frame, "leftShoulder")` — name lookup via `frame.joints[name]`
- `captureValidity.ts:19-20`: `frame.joints[jointName]` — iterates `KEY_JOINTS` array of names
- `analysisPipeline.ts:19-20`: `frame.joints.leftWrist`, `frame.joints.rightWrist` — property access
- `SkeletonOverlay.tsx:72-76`: `byName.set(lm.name, lm)` / `byName.get(a)` — Map keyed by name
- `VisualCoachCard.tsx`: Same Map-based lookup pattern
- `SwingArtCard.tsx`: Uses `getJoint(frame, name)` helper

The only index-based access is in `phaseDetection.ts:159-161` which indexes into a `DetectedPhase[]` array (phase results, not joints):
```ts
const topTs = heuristicResult[2].timestamp;    // phase array index, not joint index
```

The native Swift plugin does emit an `"id"` integer field (`ios/HoneyVisionCameraPosePlugin.swift:55`), but `MLKitProvider.ts` ignores it — mapping is by `landmark.name` (line 56).

**Verdict: Switching from 17 to 33 joints will NOT break by silent index shift.** Name-based access is safe.

### h) Would overlay, scoring, or domain logic break when switching to 33-joint MediaPipe output?

**No breakage expected.** All components handle missing joints gracefully:

- **SkeletonOverlay.tsx**: Lines 32-40 already define connections for hand joints (`leftWrist→leftThumb`, etc.) and foot joints (`leftAnkle→leftHeel`, etc.). Currently these render as no-ops because the joints are `undefined`. With MediaPipe, they would start rendering.

- **VisualCoachCard.tsx**: Same skeleton connections defined (lines 23-29 for hands). Metric scoring only uses body joints (shoulders, elbows, knees, hips — lines 76-125). Extra joints are irrelevant to scoring.

- **SwingArtCard.tsx**: Ghost connections only use core body joints (lines 109-118). Extra joints ignored.

- **angles.ts**: Uses only 12 body joints (lines 51-62): shoulders, elbows, wrists, hips, knees, ankles. All name-based. Extra joints untouched.

- **scoring.ts**: Scores 7 angle metrics (lines 22-29). No joint access — consumes GolfAngles struct.

- **captureValidity.ts**: Checks 8 KEY_JOINTS (line 11-14): shoulders, hips, elbows, knees. All present in both 17-joint and 33-joint output.

**Verdict: Safe switch. More joints = richer overlay, zero analysis breakage.**

### i) Are hand landmarks already scaffolded anywhere in the repo?

**Partial — pose-level hand points exist, but no dedicated hand landmarker.**

Pose-level hand scaffolding:
- `PoseTypes.ts:21-27`: 6 hand joints defined (leftPinky, rightPinky, leftIndex, rightIndex, leftThumb, rightThumb)
- `MLKitProvider.ts:28-33`: Mapping for all 6 hand joints
- `SkeletonOverlay.tsx:32-34, 38-40`: Skeleton connections wrist→thumb/index/pinky
- `modules/vision-camera-pose/ios/HoneyVisionCameraPosePlugin.swift:31-36`: MediaPipe joint mapping includes hand points

Dedicated hand landmarker: **None found.** No `HandLandmarker`, no 21-point hand model, no hand-specific types.

Grip feature uses photo-based Claude Vision API, not pose landmarks:
- `lib/classifyGrip.ts:60` — sends static photos to Supabase Edge Function
- `supabase/functions/classify-grip/index.ts` — calls Claude Vision for grip classification
- No pose-based hand analysis anywhere

---

## 2. CURRENT PIPELINE MAP

```
Camera component
  app/(tabs)/record.tsx:402-420 — <ReanimatedCamera> with frameProcessor prop

→ frame processor hook
  record.tsx:387 — useFrameProcessor((frame) => { ... })

→ frame skip logic
  record.tsx:390-391 — frameSkipCounter.value % skipInterval !== 0 → return
  record.tsx:366 — skipInterval = targetFps >= 120 ? 4 : targetFps >= 60 ? 2 : 1

→ native plugin call (worklet)
  record.tsx:393 — const landmarks = honeyPoseDetect(frame)

→ JS proxy init
  modules/vision-camera-pose/src/index.ts:3 — VisionCameraProxy.initFrameProcessorPlugin('honeyPoseDetect', {})
  modules/vision-camera-pose/src/index.ts:12 — plugin.call(frame)

→ native Swift callback
  ios/HoneyVisionCameraPosePlugin.m:7 — VISION_EXPORT_SWIFT_FRAME_PROCESSOR registers 'honeyPoseDetect'
  ios/HoneyVisionCameraPosePlugin.swift:12 — callback(_ frame: Frame, ...) -> Any

→ ML inference
  ios/HoneyVisionCameraPosePlugin.swift:17 — VNDetectHumanBodyPoseRequest()
  ios/HoneyVisionCameraPosePlugin.swift:20-21 — VNImageRequestHandler(cvPixelBuffer:, orientation: .right).perform()
  ios/HoneyVisionCameraPosePlugin.swift:47 — observation.recognizedPoints(.all)

→ return to JS
  ios/HoneyVisionCameraPosePlugin.swift:49-63 — builds [[String: Any]] array with id, name, x, y, z(=0), inFrameLikelihood, isPresent
  ios/HoneyVisionCameraPosePlugin.swift:65 — return landmarks (17 joints max)

→ worklet→main thread bridge
  record.tsx:396 — appendPoseFrame(landmarks, frame.timestamp, frame.width, frame.height)
  record.tsx:133 — appendPoseFrame = Worklets.createRunOnJS(async (...) => { ... })

→ overlay consumer
  record.tsx:163-164 — updateLandmarks(landmarks as Landmark[])
  record.tsx:129-131 — skeletonUpdateRef.current?.(lms) updates SkeletonOverlay
  components/SkeletonOverlay.tsx:69 — renders SVG circles + lines from landmark names

→ PoseFrame conversion (MLKitProvider)
  record.tsx:171-176 — providerRef.current.detectFromFrame({ frame: landmarks, ... })
  packages/pose/providers/MLKitProvider.ts:88-96 — detectFromFrame casts frame to V1PoseLandmark[]
  MLKitProvider.ts:55-68 — mapLandmarksToPoseFrame: iterates landmarks, maps by name via V1_TO_V2_JOINT_MAP

→ buffer accumulation
  record.tsx:180 — motionFramesRef.current.push(poseFrame)
  record.tsx:181-182 — caps at MAX_BUFFERED_POSE_FRAMES (180), slices if exceeded

→ analysis pipeline
  record.tsx (finalizeCapture) → classifyCapture(frames) — lib/captureValidity.ts:39
  record.tsx → analyzePoseSequence(sequence) — packages/domain/swing/analysisPipeline.ts:34
  analysisPipeline.ts:43 — calculateGolfAngles(midFrame) → angles.ts:50
  analysisPipeline.ts:45-46 — buildTrailPoints → detectSwingPhases → phaseDetection.ts:151
  analysisPipeline.ts:47 — calculateTempo → tempoAnalysis.ts
  analysisPipeline.ts:52 — scoreSwing → scoring.ts:16

→ state store
  record.tsx → setCurrentSwingMotion({ frames, ... }) — lib/swingMotionStore.ts:16
  record.tsx → setCurrentSwingAnalysis(result) — lib/swingMotionStore.ts:38

→ result screen
  record.tsx:126 — router.push('/analysis/result')
  Result screen reads from getCurrentSwingAnalysis() / getCurrentSwingMotion()
```

---

## 3. DELETE / DEPRECATE LIST

### Files to DELETE (Apple Vision dead after migration)

| Item | Action | File | Evidence |
|------|--------|------|----------|
| Apple Vision plugin (Swift) | DELETE | `ios/HoneyVisionCameraPosePlugin.swift` | 70 lines, imports `Vision` (line 2), uses `VNDetectHumanBodyPoseRequest` (line 17). Will be replaced by MediaPipe version. |
| Apple Vision plugin (ObjC bridge) | REPLACE | `ios/HoneyVisionCameraPosePlugin.m` | 8 lines, uses `VISION_EXPORT_SWIFT_FRAME_PROCESSOR` macro (line 7). Must be replaced with MediaPipe-compatible registration. |

### Dead code already present

| Item | Action | File | Evidence |
|------|--------|------|----------|
| MediaPipe module Swift (uncompiled) | REPLACE | `modules/vision-camera-pose/ios/HoneyVisionCameraPosePlugin.swift` | 128 lines, correct MediaPipe code, but NOT in PBXSourcesBuildPhase. Dead code — must be properly integrated. |
| MediaPipe module ObjC (uncompiled) | REPLACE | `modules/vision-camera-pose/ios/HoneyVisionCameraPosePlugin.m` | 14 lines, NOT compiled. Uses different macro (`VISION_EXPORT_FRAME_PROCESSOR` with category pattern, line 12) vs ios/ version. |

### Unused dependencies

| Item | Action | Location | Evidence |
|------|--------|----------|----------|
| `MediaPipeTasksVision` pod | KEEP (will be used after migration) | `ios/Podfile:48` | Currently installed (`Podfile.lock:273`) but zero compiled code imports it. After migration, the new MediaPipe plugin will use it. |
| `pose_landmarker_full.task` model | KEEP (will be used after migration) | `ios/pose_landmarker_full.task` (9.0 MB) | Bundled in resources (`project.pbxproj:209`) but unused by compiled Apple Vision code. After migration, MediaPipe plugin loads it. |

### Documentation contradictions

| Item | Action | File | Evidence |
|------|--------|------|----------|
| CLAUDE.md pose backend claim | FIX DOC | `CLAUDE.md:27,35,53` | Claims MediaPipe is active. Code shows Apple Vision. |
| CLAUDE.md "17 joints emitted to JS" | FIX DOC | `CLAUDE.md:27` | Says "17 joints emitted" but `PoseTypes.ts` defines 39 JointName entries and `MLKitProvider.ts` maps all 39. The native plugin emits 17 (Apple Vision) or would emit 33 (MediaPipe). |
| README.md tech stack | FIX DOC | `README.md:10` | "MediaPipe Pose Landmarker (BlazePose GHUM Full, 33 landmarks → 17 emitted to JS)" — MediaPipe is not the active backend. |
| Master Context V17.2 | FIX DOC | `HoneySwing_Master_Context_V17_2.md:48` | "[VERIFIED March 21, 2026] Current pose backend is MediaPipe Pose with 33 landmarks" — incorrect, Apple Vision with 17 landmarks. |

---

## 4. VERIFIED STATE SUMMARY

| Area | Verified State | Evidence |
|------|---------------|----------|
| Active plugin | `ios/HoneyVisionCameraPosePlugin.swift` (Apple Vision) | `project.pbxproj:346` — in PBXSourcesBuildPhase; Swift file imports `Vision` (line 2) |
| ML backend | Apple `VNDetectHumanBodyPoseRequest` | `ios/HoneyVisionCameraPosePlugin.swift:17` |
| Joint count | 17 emitted by native | `ios/HoneyVisionCameraPosePlugin.swift:27-45` — 17 `VNHumanBodyPoseObservation.JointName` entries |
| Dimensions (2D/3D) | 2D only — z hardcoded to 0.0 | `ios/HoneyVisionCameraPosePlugin.swift:59` — `"z": 0.0` |
| MediaPipe code status | Dead code in `modules/vision-camera-pose/ios/` — exists but NOT compiled | Not in `project.pbxproj` PBXSourcesBuildPhase; no package.json/podspec/expo-module.config.json |
| Models in bundle | `pose_landmarker_full.task` (9.0 MB) — bundled but unused | `project.pbxproj:209` (bundled); no compiled code loads it |
| Downstream joint expectation | 39 JointName entries (33 BlazePose + mapped names) | `PoseTypes.ts:1-39`; `MLKitProvider.ts:10-44`; `createEmptyJoints():81-117` |
| Index-based access present? | No — all name-based | All downstream code uses `frame.joints[name]` or `Map<string, Landmark>` keyed by name |
| Hand scaffolding present? | 6 pose-level hand joints defined (pinky, index, thumb per hand) — no dedicated hand landmarker | `PoseTypes.ts:21-27`; `SkeletonOverlay.tsx:32-40`; grip uses Claude Vision API, not pose |

### FINAL VERDICT

**Apple Vision (`VNDetectHumanBodyPoseRequest`) is the ONLY ML backend compiled and running in production.**

The MediaPipe swap (commit `623d453`, Mar 20) successfully converted `ios/HoneyVisionCameraPosePlugin.swift` to MediaPipe. Three days later, a `prebuild --clean` wiped the `ios/` directory. Commit `68870d3` ("restore native pose plugin files after prebuild --clean", Mar 23) restored the **original Apple Vision version** (70 lines) instead of the MediaPipe version (128 lines). The MediaPipe code survives only in `modules/vision-camera-pose/ios/` which has zero build integration.

**What is actually running:**
- Native: Apple Vision framework, 17 body joints, 2D only (z=0.0)
- Pod `MediaPipeTasksVision` 0.10.21: installed, unused
- Model `pose_landmarker_full.task` 9.0 MB: bundled, unused
- TS types: designed for 33+ joints, receiving only 17; 22 joint slots always `undefined`

---

## 5. DOC vs CODE CONTRADICTIONS

| Doc | Claim | Code Reality | Evidence |
|-----|-------|-------------|----------|
| CLAUDE.md:27 | "Currently uses MLKitProvider wrapping MediaPipe Pose Landmarker (BlazePose GHUM Full)" | MLKitProvider wraps Apple Vision output. MediaPipe code exists but is not compiled. | `ios/HoneyVisionCameraPosePlugin.swift:2` imports `Vision`, not `MediaPipeTasksVision` |
| CLAUDE.md:27 | "JointName (17 joints emitted to JS)" | JointName defines 39 entries. Native emits 17 (Apple Vision). TS layer expects up to 39. | `PoseTypes.ts:1-39` (39 entries); `ios/HoneyVisionCameraPosePlugin.swift:27-45` (17 emitted) |
| CLAUDE.md:35 | "Uses MediaPipe PoseLandmarker with the Full model to detect 33 body landmarks, maps 17 to JS" | Uses Apple Vision VNDetectHumanBodyPoseRequest. Detects and emits 17 joints. No MediaPipe. No mapping from 33→17. | `ios/HoneyVisionCameraPosePlugin.swift:17` — `VNDetectHumanBodyPoseRequest()` |
| CLAUDE.md:35 | "Image orientation handled via CIContext render (landscape → portrait)" | Uses `VNImageRequestHandler` with `orientation: .right` — no CIContext. CIContext is in the uncompiled MediaPipe version. | `ios/HoneyVisionCameraPosePlugin.swift:20` vs `modules/.../HoneyVisionCameraPosePlugin.swift:94-98` |
| CLAUDE.md:53 | "MediaPipe Pose Landmarker (BlazePose GHUM Full) for iOS pose detection" | Apple Vision is the iOS pose backend. MediaPipe pod installed but unused. | `ios/Podfile:48` (installed); `ios/HoneyVisionCameraPosePlugin.swift:2` (not imported) |
| README.md:10 | "MediaPipe Pose Landmarker (BlazePose GHUM Full, 33 landmarks → 17 emitted to JS)" | Apple Vision, 17 landmarks, no MediaPipe in compiled code | Same as above |
| Master Context V17.2:48 | "[VERIFIED March 21, 2026] Current pose backend is MediaPipe Pose with 33 landmarks" | Apple Vision with 17 landmarks. Verification date predates the prebuild --clean restore (Mar 23) that reverted to Apple Vision. | Commit `68870d3` (Mar 23) restored Apple Vision version |
| CLAUDE.md:27 | "NormalizedJoint (coordinates normalized 0-1)" | NormalizedJoint also has optional `z` and `confidence` fields | `PoseTypes.ts:41-47` — `z?: number`, `confidence?: number` |

### Root cause of all contradictions

Commit `623d453` (Mar 20) genuinely swapped to MediaPipe. All docs were updated to reflect this. Commit `68870d3` (Mar 23) silently reverted the native code to Apple Vision during a "restore after prebuild --clean" — but no documentation was updated to reflect the reversion. Every doc still describes the Mar 20 state, not the current Mar 23+ state.

---

# PROMPT 2 — ARCHITECTURE & MIGRATION PLAN

## Ground Truth (from Section 4, Verified State Summary)

1. **Active plugin:** Apple Vision (`VNDetectHumanBodyPoseRequest`) compiled via `ios/HoneyVisionCameraPosePlugin.swift` — 17 joints, 2D only (z=0.0)
2. **MediaPipe code:** exists at `modules/vision-camera-pose/ios/` but is dead (not compiled, no build integration — missing from PBXSourcesBuildPhase, no package.json/podspec/expo-module.config.json)
3. **Bundle waste:** `MediaPipeTasksVision` pod installed + `pose_landmarker_full.task` (9MB) bundled — neither used by compiled code
4. **Downstream safety:** All joint access is name-based (`frame.joints[name]`), no index-based access. TS types define 39 JointName entries; 22 are always undefined at runtime. Overlay/scoring/analysis handle missing joints gracefully.
5. **No hand landmarker:** 6 pose-level hand joints defined in types but no dedicated hand detection model or code; grip feature uses photo-based Claude Vision API

Everything below treats these 5 points as ground truth.

---

## 6. MEDIAPIPE BODY ACTIVATION PLAN

### a) Can the plugin name remain `honeyPoseDetect`?

**Yes. Keep it.** No tradeoffs — only benefits.

The JS proxy (`modules/vision-camera-pose/src/index.ts:3`) calls `VisionCameraProxy.initFrameProcessorPlugin('honeyPoseDetect', {})`. The ObjC bridge (`ios/HoneyVisionCameraPosePlugin.m:7`) registers `VISION_EXPORT_SWIFT_FRAME_PROCESSOR(HoneyVisionCameraPosePlugin, honeyPoseDetect)`. The Swift class name (`HoneyVisionCameraPosePlugin`) and plugin name (`honeyPoseDetect`) are identical in both the Apple Vision and MediaPipe implementations. Changing the name would require updating the ObjC bridge, JS proxy, and all call sites for zero functional benefit.

### b) Files: replaced vs newly created vs unchanged

| File | Action | Reason |
|------|--------|--------|
| `ios/HoneyVisionCameraPosePlugin.swift` | **REPLACE CONTENTS** | Swap 70-line Apple Vision body with 128-line MediaPipe body from `modules/` version |
| `ios/HoneyVisionCameraPosePlugin.m` | **UNCHANGED** | `VISION_EXPORT_SWIFT_FRAME_PROCESSOR` macro works regardless of ML backend; class name matches |
| `ios/pose_landmarker_full.task` | **UNCHANGED** | Already bundled (`project.pbxproj:209`), already 9MB |
| `ios/Podfile` | **UNCHANGED** | Already has `pod 'MediaPipeTasksVision', '~> 0.10.14'` (line 48) |
| `ios/Podfile.lock` | **UNCHANGED** | Already resolved to 0.10.21 (line 273) |
| `project.pbxproj` | **UNCHANGED** | Same Swift/ObjC files compiled (lines 346-347), same model bundled (line 209) |
| `modules/vision-camera-pose/src/index.ts` | **UNCHANGED** | JS proxy is backend-agnostic |
| `packages/pose/PoseTypes.ts` | **UNCHANGED** | Already defines 39 JointName entries including all 33 BlazePose names |
| `packages/pose/providers/MLKitProvider.ts` | **UNCHANGED** | `V1_TO_V2_JOINT_MAP` already maps all 33 body joint names (lines 10-44) |
| All analysis/overlay/scoring files | **UNCHANGED** | Name-based access, handles undefined gracefully |

**Total files changed for body activation: 1** (`ios/HoneyVisionCameraPosePlugin.swift`)

### c) What build registration steps are currently missing?

**For body-only activation via the "direct replacement" approach: NONE.**

The build system is already fully wired:
- `project.pbxproj:346-347` compiles `ios/HoneyVisionCameraPosePlugin.swift` and `.m`
- `project.pbxproj:209` bundles `pose_landmarker_full.task`
- `Podfile:48` declares `MediaPipeTasksVision` dependency
- `Podfile.lock:273` has it resolved

The only missing step was that the wrong Swift file contents were restored after `prebuild --clean`. Replacing the contents fixes everything.

The `modules/vision-camera-pose/` directory needs NO build integration (no podspec, no expo-module.config, no package.json) because we are NOT using the Expo module pattern. The Swift code lives directly in `ios/`, compiled by the main app target.

### d) Exact native bridging / registration path

```
1. ios/HoneyVisionCameraPosePlugin.m:7
   VISION_EXPORT_SWIFT_FRAME_PROCESSOR(HoneyVisionCameraPosePlugin, honeyPoseDetect)
   ↓ registers plugin name "honeyPoseDetect" → class HoneyVisionCameraPosePlugin

2. ios/HoneyVisionCameraPosePlugin.m:5
   #import "HoneySwingV2-Swift.h"
   ↓ auto-generated bridging header exposes Swift class to ObjC

3. ios/HoneyVisionCameraPosePlugin.swift:6-7
   @objc(HoneyVisionCameraPosePlugin)
   public class HoneyVisionCameraPosePlugin: FrameProcessorPlugin
   ↓ Swift class with @objc exposure, inherits from VisionCamera's FrameProcessorPlugin

4. ios/HoneyVisionCameraPosePlugin.swift:77-127
   public override func callback(_ frame: Frame, withArguments:) -> Any
   ↓ called by VisionCamera on each processed frame

5. MediaPipeTasksVision pod (linked via Podfile:48)
   ↓ provides PoseLandmarker, PoseLandmarkerOptions, MPImage types

6. ios/pose_landmarker_full.task (bundled via project.pbxproj:209)
   ↓ loaded at init via Bundle.main.path (modules/ version line 55-57)
```

This entire chain is already wired. Replacing the Swift file contents activates it.

### e) Migration sequence — Decision table

| Option | Description | Files Changed | JS Changes | Build Config Changes | Risk | Rollback |
|--------|-------------|---------------|------------|---------------------|------|----------|
| **A: Direct replacement** | Copy MediaPipe Swift from `modules/` into `ios/HoneyVisionCameraPosePlugin.swift` | 1 | 0 | 0 | Low — same class, same registration, same method signature | `git checkout ios/HoneyVisionCameraPosePlugin.swift` |
| B: Parallel plugins | Add MediaPipe as second class, dual registration, runtime toggle | 3+ new files | 1+ (toggle logic) | pbxproj additions | Medium — dual registration may conflict, extra complexity | Remove new files |
| C: Module integration | Wire `modules/vision-camera-pose/` as proper Expo module with package.json, podspec, expo-module.config | 4+ new files | 0 | Podfile, pbxproj, autolinking | High — prebuild sensitivity (caused the original regression), more moving parts | Complex multi-file revert |

**DECISION: Option A (Direct replacement).**

Reject B: Parallel plugins add complexity for a feature that is testable in one build. The single-file revert of Option A provides the same safety net with zero overhead.

Reject C: The Expo module pattern requires package.json, podspec, and expo-module.config.json — none of which exist. Creating them introduces the exact prebuild fragility that caused the current Apple Vision regression (commit `68870d3`). Putting Swift directly in `ios/` survives `prebuild --clean` IF the restore is done correctly (or, better, if the file is committed and tracked by git).

---

## 7. HANDS INTEGRATION PLAN

### a) Required hand landmarker model

**Model:** `hand_landmarker.task` (MediaPipe Hand Landmarker)
**Approximate size:** 5-15 MB depending on variant (lite ~5MB, full ~12MB)
**In repo:** NO — only `pose_landmarker_full.task` (body pose) exists. `hand_landmarker.task` must be downloaded from the MediaPipe model catalog and added to the project.
**Pod dependency:** Already covered by `MediaPipeTasksVision` (`Podfile:48`, `Podfile.lock:273`) — the same pod provides both `PoseLandmarker` and `HandLandmarker` classes.

### b) Body + hands: one callback or separate?

| Option | Per-Frame Latency | Complexity | Skip Flexibility | Frame Budget Impact |
|--------|-------------------|------------|------------------|---------------------|
| **A: Single callback, hands conditional** | Body always (~8-15ms); hands only when requested (~5-10ms additional) | Medium — one plugin, one return type, flag-driven | High — hands can be disabled during swing capture | Best — hands cost is zero during swing |
| B: Two separate plugins | Same total when both active | High — two registrations, two JS call sites, two return paths | High — independent frame rates | Neutral — same work, more wiring |
| C: Single callback, both always | Body + hands every frame (~15-25ms) | Low — always run both | None — can't disable hands | Worst — wastes budget during swing capture |

**DECISION: Option A (Single callback, hands conditional).**

The `callback` method receives `arguments: [AnyHashable: Any]?` (`modules/.../HoneyVisionCameraPosePlugin.swift:79`). JS can pass `{ detectHands: true }` when grip analysis is active. During swing capture (the 90% use case), hands are not requested and add zero latency.

Reject B: Two plugins means two `VisionCameraProxy.initFrameProcessorPlugin` calls, two exports from the module, two calls in the frame processor worklet, and synchronization complexity — all for the same work that Option A achieves with a flag.

Reject C: Running hand detection during swing capture wastes 5-10ms per frame on data that is discarded. With the camera at 120fps / skipInterval 4 = 30 effective fps, that's 150-300ms wasted per second of capture.

### c) Output contract

**Body-only mode** (default, during swing capture — `detectHands` absent or false):
```
[                                          // [[String: Any]] — flat array
  { "id": 0, "name": "nose", "x": 0.52, "y": 0.15, "z": 0.0, "inFrameLikelihood": 0.98, "isPresent": true },
  { "id": 1, "name": "leftEyeInner", ... },
  ...                                      // up to 33 body landmarks
]
```
This is identical to the current Apple Vision format (same keys, same types). Downstream consumers (`record.tsx:395`, `MLKitProvider.ts:55-68`, `SkeletonOverlay.tsx:72-76`) work unchanged.

**Body + hands mode** (`detectHands: true`, during grip analysis):
```
{                                          // [String: Any] — dictionary
  "body": [                                // same flat array as body-only
    { "id": 0, "name": "nose", ... },
    ...
  ],
  "hands": [                               // array of detected hands (0, 1, or 2)
    {
      "label": "Left",                     // MediaPipe handedness classification
      "score": 0.95,                       // handedness confidence
      "landmarks": [                       // 21 landmarks per hand
        { "id": 0, "name": "wrist", "x": 0.45, "y": 0.60, "z": 0.0, "inFrameLikelihood": 0.92 },
        { "id": 1, "name": "thumbCmc", ... },
        ...                                // 21 MediaPipe hand landmarks
      ]
    },
    {                                      // second hand (if detected)
      "label": "Right",
      "score": 0.88,
      "landmarks": [ ... ]
    }
  ]
}
```

**Two hands detected:** `hands` array has 2 entries, each with `label`, `score`, and `landmarks`.
**One hand detected:** `hands` array has 1 entry.
**Zero hands detected:** `hands` is an empty array `[]`.
**Hands not requested:** Return value is a flat array (body-only mode), NOT a dictionary. This preserves backward compatibility — `Array.isArray(landmarks)` at `record.tsx:395` continues to work.

**Contract change is explicit:** The return type changes from `[[String: Any]]` (body-only) to `[String: Any]` (dictionary with "body" and "hands" keys) ONLY when `detectHands: true` is passed. JS consumers must check `Array.isArray(result)` to determine which mode was used. This is already the existing pattern — `record.tsx:395` already checks `Array.isArray(landmarks)`.

### d) Handedness representation

MediaPipe `HandLandmarker` returns a `handedness` classification per detected hand: `"Left"` or `"Right"` with a confidence score.

In the output contract: `"label": "Left"` or `"Right"` + `"score": Float`.

Mapping to app domain (`lib/handedness.ts`): The app stores user handedness preference via `getIsLeftHanded()` (`lib/handedness.ts:5`). A left-handed golfer's lead hand is the right hand (and vice versa). The mapping from MediaPipe hand label to lead/trail is:
- If user is right-handed: Left hand = lead, Right hand = trail
- If user is left-handed: Right hand = lead, Left hand = trail

This mapping belongs in the grip analysis consumer, NOT in the native plugin. The plugin returns raw MediaPipe labels.

### e) Per-landmark confidence

**Body landmarks:** MediaPipe provides a `visibility` float per landmark. The dormant code maps this to `"inFrameLikelihood"` (`modules/.../HoneyVisionCameraPosePlugin.swift:118`). Continue this convention.

**Hand landmarks:** MediaPipe hand landmarks have a `presence` float (not `visibility`). Map to the same `"inFrameLikelihood"` key for consistency. Downstream consumers already treat this field as optional and threshold-based (`captureValidity.ts:21` checks `>= 0.3`, `angles.ts:47` checks `>= 0.5`).

---

## 8. DATA CONTRACT MIGRATION

### a) Current contract (Apple Vision — compiled and running)

Per Prompt 1 Section 2 (`ios/HoneyVisionCameraPosePlugin.swift:49-63`):

```
Return type: [[String: Any]] — array of landmark dictionaries

Per landmark:
  "id":                Int       (0-16, sequential)
  "name":              String    ("nose", "leftEye", ..., "rightAnkle")
  "x":                 Double    (0-1 normalized, raw from VNPoint)
  "y":                 Double    (0-1 normalized, flipped: 1.0 - point.location.y)
  "z":                 Double    (hardcoded 0.0)
  "inFrameLikelihood": Double    (VNPoint confidence)
  "isPresent":         Bool      (always true — filtered before inclusion)

Max landmarks per frame: 17
Omitted landmarks: any with confidence == 0
```

### b) Proposed contract — MediaPipe body + hands

**Phase 3 (body activation) — same shape, more landmarks:**
```
Return type: [[String: Any]] — same flat array

Per landmark:
  "id":                Int       (0-32, per BlazePose GHUM index)
  "name":              String    (33 BlazePose names: "nose", "leftEyeInner", ..., "rightFootIndex")
  "x":                 Double    (0-1 normalized, from MediaPipe NormalizedLandmark)
  "y":                 Double    (0-1 normalized, from MediaPipe NormalizedLandmark)
  "z":                 Double    (0.0 initially — can enable MediaPipe z later)
  "inFrameLikelihood": Double    (MediaPipe visibility)
  "isPresent":         Bool      (true — filtered by visibility > 0)

Max landmarks per frame: 33
```

**Phase 5 (body + hands) — conditional contract:**

When `detectHands: false` or absent → flat array as above.
When `detectHands: true` → dictionary as described in Section 7c.

### c) Compatibility strategy

**Per Prompt 1 Section 1g: No downstream code references joints by index.** All access is name-based:
- `MLKitProvider.ts:56`: `V1_TO_V2_JOINT_MAP[landmark.name]` — maps by name string
- `angles.ts:42-44`: `getJoint(frame, "leftShoulder")` → `frame.joints[name]`
- `captureValidity.ts:19-20`: `frame.joints[jointName]` — iterates name array
- `SkeletonOverlay.tsx:72-76`: `Map<string, Landmark>` keyed by `lm.name`

**Answer: Direct swap.** No adapter required. The 17→33 switch adds landmarks to slots that were previously `undefined`. All existing joints keep the same names. No silent contract change occurs because:
1. Joint names are identical in both backends (the 17 Apple Vision names are a subset of the 33 MediaPipe names)
2. The `V1_TO_V2_JOINT_MAP` already handles all 33 names (`MLKitProvider.ts:10-44`)
3. The `createEmptyJoints()` already initializes all 39 slots as `undefined` (`PoseTypes.ts:81-117`)
4. Skeleton connections for hands/feet already exist (`SkeletonOverlay.tsx:32-52`) — they'll start rendering instead of being no-ops

The Phase 5 contract change (flat array → conditional dictionary) DOES require a JS consumer update. This will be handled explicitly in Phase 5 by updating `record.tsx` to check `Array.isArray(result)` and route accordingly. No silent change — the consumer is updated in the same commit.

---

## 9. PERFORMANCE / FRAME BUDGET RISK

**Target budget:** 33.3ms per effective frame at 30 fps (120fps camera / skipInterval 4).

### a) Instrument Apple Vision baseline

Insert timing in the compiled plugin `ios/HoneyVisionCameraPosePlugin.swift`:
- **Entry:** line 12 (`callback` method start) — record `CFAbsoluteTimeGetCurrent()`
- **Post-inference:** line 21 (after `handler.perform([request])`) — record elapsed for VN inference
- **Exit:** line 65 (`return landmarks`) — record total callback time
- **Log every Nth frame** to match existing throttle pattern (`record.tsx:142` logs every 60 frames)

### b) Instrument MediaPipe plugin (once activated)

Insert timing in the replacement `ios/HoneyVisionCameraPosePlugin.swift` (based on `modules/.../HoneyVisionCameraPosePlugin.swift`):
- **Entry:** callback start (currently line 77)
- **Post-CIContext render:** after `ciContext.createCGImage` (currently line 95) — measures GPU→CPU pixel copy
- **Post-MPImage creation:** after `MPImage(uiImage:)` (currently line 101) — measures image wrapping
- **Post-detection:** after `poseLandmarker.detect(image:)` (currently line 102) — measures model inference
- **Exit:** return landmarks (currently line 123) — measures total including landmark extraction

### c) Metrics to capture

| Metric | Measurement Point | Why |
|--------|-------------------|-----|
| Total callback time (mean, p95, max) | Entry → Exit | Overall frame budget consumed |
| CIContext render time | Entry → Post-render | Biggest suspected bottleneck (GPU→CPU copy) |
| Model inference time | Post-MPImage → Post-detection | Core ML cost |
| Hand detection time (Phase 4+) | Pre-hand → Post-hand | Incremental cost of hands |
| Body + hands combined | Entry → Exit with hands enabled | Full budget for grip mode |

### d) Thresholds

| Zone | Combined Time | Action |
|------|---------------|--------|
| **Green** | < 15ms | Proceed — ample headroom within 33.3ms budget |
| **Yellow** | 15–25ms | Adjust `skipInterval` (e.g., 4→6 at 120fps) or explore `.liveStream` running mode |
| **Red** | > 25ms | Architecture change required — async detection, interleaved body/hands frames, or model downgrade to Lite variant |

### e) Biggest expected bottlenecks

1. **CIContext GPU→CPU pixel copy** (`modules/.../HoneyVisionCameraPosePlugin.swift:94-95`):
   ```swift
   let ciImage = CIImage(cvPixelBuffer: pixelBuffer).oriented(.right)
   guard let cgImage = ciContext.createCGImage(ciImage, from: ciImage.extent) else { ... }
   ```
   This renders the oriented CIImage to a new CGImage via the GPU pipeline, then copies pixels to CPU memory. Apple Vision avoids this entirely by accepting `CVPixelBuffer` directly with an `orientation` parameter (`ios/HoneyVisionCameraPosePlugin.swift:20`). This render is the single largest difference in per-frame overhead between Apple Vision and MediaPipe paths.

   The dormant code mitigates with `CIContext(options: [.useSoftwareRenderer: false])` (line 10) to ensure GPU acceleration, but the copy is still per-frame.

2. **Per-frame UIImage allocation** (`modules/.../HoneyVisionCameraPosePlugin.swift:98-101`):
   ```swift
   let uiImage = UIImage(cgImage: cgImage)
   let mpImage = try MPImage(uiImage: uiImage)
   ```
   Two heap allocations per frame (UIImage + MPImage). Under ARC, previous frame's objects are released each cycle. At 30 effective fps this is 60 alloc/dealloc per second — unlikely to be a bottleneck but worth measuring.

3. **Running mode `.image` vs `.liveStream`** (`modules/.../HoneyVisionCameraPosePlugin.swift:67`):
   The dormant code uses `opts.runningMode = .image`, which treats each frame independently. MediaPipe's `.liveStream` mode enables temporal optimizations (reusing prior frame state) but requires an async callback pattern — the current synchronous `callback() -> Any` return wouldn't work. This is a potential optimization for Yellow zone but requires refactoring the plugin to async.

4. **Hand model inference (Phase 4+)**: Running `HandLandmarker` in addition to `PoseLandmarker` roughly doubles inference time. The conditional flag (`detectHands`) ensures this cost is only paid during grip analysis, not during swing capture.

**Do NOT guess timings.** All of the above must be measured on a real device (iPhone, not simulator) with the Phase 0 instrumentation.

---

## 10. BUILD / POD / MODEL CHANGES

| Change | Category | Evidence |
|--------|----------|----------|
| Replace contents of `ios/HoneyVisionCameraPosePlugin.swift` with MediaPipe body code | REQUIRED | Active plugin uses Apple Vision (Section 4 ground truth #1). MediaPipe code exists in `modules/.../HoneyVisionCameraPosePlugin.swift` (128 lines) but is not compiled (ground truth #2). |
| Keep `ios/HoneyVisionCameraPosePlugin.m` unchanged | REQUIRED (no-op) | `VISION_EXPORT_SWIFT_FRAME_PROCESSOR` macro at line 7 is class-name-based, backend-agnostic. Same class name in both implementations. |
| Keep `pod 'MediaPipeTasksVision'` in Podfile | REQUIRED (already present) | `Podfile:48` — already declared. `Podfile.lock:273` — already resolved to 0.10.21. Currently unused (ground truth #3); will become used after Swift replacement. |
| Keep `pose_landmarker_full.task` in bundle | REQUIRED (already present) | `project.pbxproj:209` — already in PBXResourcesBuildPhase. Currently unused (ground truth #3); MediaPipe code loads it at init (`modules/.../HoneyVisionCameraPosePlugin.swift:55-57`). |
| Add `hand_landmarker.task` model to bundle (Phase 4) | REQUIRED for hands | Not currently in repo. Must download from MediaPipe model catalog, add to `ios/` directory, add to PBXResourcesBuildPhase in `project.pbxproj`. |
| Add `hand_landmarker.task` to PBXResourcesBuildPhase (Phase 4) | REQUIRED for hands | New entry needed in `project.pbxproj` — PBXBuildFile section + PBXFileReference + PBXResourcesBuildPhase addition. |
| Update Podfile MediaPipe version pin (Phase 4) | NEEDS VERIFICATION | Current pin `~> 0.10.14` resolves to 0.10.21. Verify HandLandmarker API is available in 0.10.21. If not, bump version pin. |
| `pod install` after any Podfile change | REQUIRED if Podfile changes | Standard CocoaPods workflow. |
| No PBXSourcesBuildPhase changes | CONFIRMED — none needed | Same 4 files compiled: `HoneyVisionCameraPosePlugin.swift`, `.m`, `AppDelegate.swift`, `ExpoModulesProvider.swift` (`project.pbxproj:346-349`). |
| Native rebuild required | REQUIRED | `cd ios && pod install && cd .. && npx expo run:ios`. Swift changes require Xcode recompilation. |
| `prebuild --clean` risk mitigation | LIKELY REQUIRED | Commit the MediaPipe Swift file BEFORE any prebuild. The original regression (commit `68870d3`) was caused by `prebuild --clean` wiping `ios/` and restoring the wrong version. Git-tracked files in `ios/` survive prebuild if committed. |
| EAS build update | REQUIRED for App Store submission | After migration is validated locally, an EAS build must be triggered for distribution. No EAS config changes needed — same native build pipeline. |
| Info.plist version sync | NEEDS VERIFICATION | Check if current Info.plist version matches `app.json` version. No migration-specific change, but any native rebuild should verify version consistency. Last synced at v1.3.0 build 18 (`729516c`). |
| Remove Apple `Vision` framework import | REQUIRED (implicit) | Replacing Swift file contents removes `import Vision`. No explicit framework unlinking needed — Apple Vision is a system framework, not a pod. |

---

## 11. PHASED EXECUTION PLAN

### Phase 0 — Measure current Apple Vision baseline

**Objective:** Establish per-frame timing baseline for the current Apple Vision plugin on a real device.

**Files touched:**
- `ios/HoneyVisionCameraPosePlugin.swift` (add 3 timing log lines)

**Risk:** Logging overhead could skew measurements if not throttled.

**Validation:** Run on physical device, capture 4s recording, examine Metro logs for mean/p95/max callback times. Expect < 10ms for Apple Vision. DEVICE TEST REQUIRED.

**Rollback:** Remove timing lines (or leave as debug-only prints).

**Gate:** Baseline numbers recorded. Proceed regardless of values — this is measurement only.

---

### Phase 1 — Activate MediaPipe body (replace Apple Vision)

**Objective:** Replace `ios/HoneyVisionCameraPosePlugin.swift` contents with MediaPipe body pose code, producing 33 landmarks.

**Files touched:**
- `ios/HoneyVisionCameraPosePlugin.swift` — replace entire contents with MediaPipe implementation (based on `modules/vision-camera-pose/ios/HoneyVisionCameraPosePlugin.swift`, adding timing instrumentation from Phase 0)

**Risk:**
- MediaPipe init failure (model not found, pod version mismatch)
- CIContext render failure on specific device/iOS version
- Performance regression vs Apple Vision
- Build failure if `MediaPipeTasksVision` headers aren't found

**Validation:**
1. `cd ios && pod install && cd .. && npx expo run:ios` — must compile without errors
2. App launches, camera preview shows skeleton overlay
3. Metro logs show `[HoneySwing] MediaPipe PoseLandmarker ready` (from `modules/.../HoneyVisionCameraPosePlugin.swift:70`)
4. Metro logs show frame processing with landmarks > 0
5. Landmark count per frame should be > 17 (expect 25-33 depending on visibility)
6. DEVICE TEST REQUIRED

**Rollback:** `git checkout ios/HoneyVisionCameraPosePlugin.swift` — single file restore to Apple Vision.

**Gate:** MediaPipe produces landmarks on real device. Timing is in Green or Yellow zone (< 25ms).

---

### Phase 2 — Validate MediaPipe 33-landmark output end-to-end

**Objective:** Confirm that 33 landmarks flow correctly through the entire pipeline: overlay rendering, PoseFrame conversion, analysis, scoring, result screen.

**Files touched:** None — validation only.

**Risk:**
- SkeletonOverlay renders hand/foot connections incorrectly (wrong coordinates, visual artifacts)
- Analysis produces different scores vs Apple Vision baseline (expected — more data available)
- Capture validity thresholds may need tuning (more joints detected = higher confidence rates)

**Validation:**
1. Record a full swing → verify overlay shows hand + foot skeleton segments
2. Verify result screen shows score, coaching cue, tempo, Visual Coach
3. Compare score with Apple Vision baseline (expect different but not wildly different)
4. Verify `captureValidity` classification still produces 'valid' for good swings
5. Check that previously-undefined joints (hands, feet, face detail) are now populated in PoseFrame
6. DEVICE TEST REQUIRED

**Rollback:** N/A — no code changes in this phase.

**Gate:** Full capture → analysis → result flow works with 33-landmark input. No crashes, no undefined-access errors.

---

### Phase 3 — Commit MediaPipe body as active plugin

**Objective:** Commit the MediaPipe body activation, remove Phase 0 debug timing (or gate behind a flag), mark the migration as stable.

**Files touched:**
- `ios/HoneyVisionCameraPosePlugin.swift` — finalize (remove excessive timing logs or gate behind debug flag)

**Risk:** Minimal — Phase 2 validation passed.

**Validation:** Clean build, run once on device, verify skeleton + analysis. DEVICE TEST REQUIRED.

**Rollback:** `git revert` the commit.

**Gate:** Committed and pushed. Apple Vision code no longer present in `ios/HoneyVisionCameraPosePlugin.swift`.

---

### Phase 4 — Add MediaPipe hands

**Objective:** Add `HandLandmarker` to the plugin, gated behind `detectHands` argument. Download and bundle `hand_landmarker.task` model.

**Files touched:**
- `ios/HoneyVisionCameraPosePlugin.swift` — add HandLandmarker init, conditional hand detection in callback, dictionary return type when hands requested
- `ios/hand_landmarker.task` — new file (downloaded from MediaPipe model catalog)
- `ios/HoneySwingV2.xcodeproj/project.pbxproj` — add `hand_landmarker.task` to PBXFileReference + PBXBuildFile + PBXResourcesBuildPhase

**Risk:**
- HandLandmarker API not available in `MediaPipeTasksVision` 0.10.21 (verify before starting)
- Hand model adds significant per-frame latency
- Memory pressure from two loaded models

**Validation:**
1. Build succeeds with hand model bundled
2. Default mode (no `detectHands` flag) returns flat array — existing swing capture unaffected
3. With `detectHands: true`, returns dictionary with `body` and `hands` keys
4. Hold hand in front of camera → `hands` array has 1-2 entries with 21 landmarks each
5. Measure combined body+hands latency — must be in Green or Yellow zone
6. DEVICE TEST REQUIRED

**Rollback:** Revert commit — removes hand model, Swift changes, pbxproj changes.

**Gate:** Hand detection works on device. Combined latency acceptable. Default (body-only) mode unchanged.

---

### Phase 5 — Unify output contract (body + hands)

**Objective:** Update JS consumers to handle the conditional return type (flat array for body-only, dictionary for body+hands).

**Files touched:**
- `modules/vision-camera-pose/src/index.ts` — update return type annotation, add `detectHands` argument support
- `app/(tabs)/record.tsx` — update `appendPoseFrame` to handle dictionary return when hands mode is active
- `packages/pose/PoseTypes.ts` — add hand landmark types (HandLandmark, HandFrame)
- `packages/pose/providers/MLKitProvider.ts` — add hand landmark mapping if needed for grip analysis
- New or existing grip analysis consumers — wire hand landmark data to grip analysis flow

**Risk:**
- Type changes break TypeScript compilation
- Existing swing capture regresses if body-only path is accidentally broken

**Validation:**
1. `npx tsc --project tsconfig.json` — no type errors
2. Swing capture works normally (body-only mode)
3. Grip capture receives hand landmarks
4. DEVICE TEST REQUIRED for hand data flow

**Rollback:** Revert commit. Phase 4 hand detection still works at native level; only JS consumption is reverted.

**Gate:** Both body-only and body+hands modes work end-to-end through the full TS pipeline.

---

### Phase 6 — Remove Apple Vision path + dangling dependencies

**Objective:** Clean up dead code and confirm nothing references Apple Vision.

**Files touched:**
- `modules/vision-camera-pose/ios/HoneyVisionCameraPosePlugin.swift` — DELETE (dead code, MediaPipe version now lives in `ios/`)
- `modules/vision-camera-pose/ios/HoneyVisionCameraPosePlugin.m` — DELETE (dead code)
- Verify no `import Vision` in any compiled Swift file
- Verify no `VNDetectHumanBodyPoseRequest` references remain

**Risk:** Deleting wrong files.

**Validation:**
1. `grep -r "import Vision" ios/` — no matches
2. `grep -r "VNDetect" ios/` — no matches
3. Build succeeds
4. App runs normally
5. DEVICE TEST REQUIRED (rebuild after file deletion)

**Rollback:** `git revert` — restores deleted files.

**Gate:** No Apple Vision references in compiled code. No dead MediaPipe code in `modules/`.

---

### Phase 7 — Docs cleanup

**Objective:** Fix every doc contradiction identified in Section 5.

**Files touched:**
- `CLAUDE.md` — update pose backend description, joint count, CIContext reference, tech stack
- `README.md` — update tech stack section
- `HoneySwing_Master_Context_V17_2.md` — update Section 0.1 verified state, mark old MediaPipe verification as superseded

**Risk:** None — documentation only.

**Validation:** Read each doc, verify claims match code. Check App Privacy section — MediaPipe does not change data collection (all on-device), so App Store privacy declaration should remain "Data Not Collected."

**Rollback:** `git revert`.

**Gate:** All docs accurately describe MediaPipe body + hands as the active backend.

---

## 12. FINAL VERDICT

### a) Is MediaPipe-only body + hands feasible without architecture collapse?

**Yes.** The infrastructure is 90% in place:
- Pod installed (`Podfile:48`)
- Model bundled (`project.pbxproj:209`)
- TS types ready for 33 joints (`PoseTypes.ts:1-39`)
- MLKitProvider maps all 33 names (`MLKitProvider.ts:10-44`)
- Overlay connections scaffold hands/feet (`SkeletonOverlay.tsx:32-52`)
- All downstream access is name-based — no breakage on joint count change

The only true missing piece is the correct Swift file contents in `ios/HoneyVisionCameraPosePlugin.swift`.

### b) Highest-risk step

**Phase 1 (activate MediaPipe body)** — specifically the CIContext GPU→CPU pixel copy performance. Apple Vision accepts CVPixelBuffer directly; MediaPipe requires UIImage, forcing a per-frame render. If this pushes latency into the Red zone (>25ms), the entire migration path changes.

Second risk: `prebuild --clean` re-regression. The original bug was caused by prebuild restoring the wrong file. Mitigation: commit the MediaPipe Swift file and verify git tracks it correctly.

### c) Smallest proof step to run first

**Phase 0 + Phase 1 combined:** Replace `ios/HoneyVisionCameraPosePlugin.swift` contents with the MediaPipe version from `modules/`, build, and observe:
1. Does it compile?
2. Does MediaPipe init succeed (Metro log: "PoseLandmarker ready")?
3. Are landmarks produced (landmark count > 0 in frame logs)?
4. What is the per-frame timing?

This answers the feasibility question in a single device test. If it works, proceed. If it fails (build error, init error, Red zone timing), diagnose before continuing.

### d) Any technical reason to keep Apple Vision?

**No concrete technical limitation of MediaPipe that Apple Vision solves.** Both:
- Run on-device with no network
- Support real-time inference
- Work on iOS 16+ deployment target
- Support portrait orientation

Apple Vision's only advantage is zero per-frame image conversion (accepts CVPixelBuffer directly), but this is a performance difference, not a capability limitation. If MediaPipe body stays in Green/Yellow zone on timing, there is no reason to keep Apple Vision.

If MediaPipe lands in Red zone on timing (>25ms body-only), the fallback is NOT "keep Apple Vision" — it's "use MediaPipe Lite model or switch to `.liveStream` running mode." Apple Vision's 17-joint, 2D-only output is fundamentally insufficient for the hand detection goal.

### e) How many phases to first device test of MediaPipe body output?

**1 phase.** Phase 1 replaces the Swift file and rebuilds. Device test is the Phase 1 validation step.

Phase 0 (Apple Vision baseline measurement) is useful but optional — it provides a comparison point. If you want to skip Phase 0, Phase 1 alone gets MediaPipe running on device.

---

## CONSISTENCY CHECK

- [x] Plan targets the correct compiled plugin (Apple Vision in `ios/HoneyVisionCameraPosePlugin.swift`, NOT the dead MediaPipe code in `modules/`)
- [x] No assumption that MediaPipe is already active — every phase treats Apple Vision as the starting state
- [x] Joint expectations match Prompt 1 findings — 17 from Apple Vision, 33 from MediaPipe, 39 in TS types, all name-based access
- [x] No doc-based assumptions — all claims reference verified code state from Sections 1-5
- [x] Every phase has a rollback point (`git checkout` or `git revert`) and a gate condition
- [x] No silent contract changes — Phase 3 (body) is shape-compatible; Phase 5 (hands) explicitly updates JS consumers in the same commit
