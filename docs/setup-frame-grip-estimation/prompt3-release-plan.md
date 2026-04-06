# Prompt 3: Release Plan — Setup-Frame Grip Estimation (EfficientNet)

## Locked Decisions (from Prompts 1 & 2)

| Decision | Choice | Locked In |
|----------|--------|-----------|
| Pose backend | MediaPipe PoseLandmarker (33 joints) in `modules/vision-camera-pose/` | Prompt 1 |
| Pixel retention | CVPixelBuffer ring buffer (12 slots) in pose plugin | Prompt 1 |
| Model runtime | CoreML (.mlmodel) — Apple Neural Engine | Prompt 1 |
| Model status | Placeholder first (random weights, correct shape) | Prompt 1 |
| Result surface | swing_debug only (additive) | Prompt 1 |
| Aggregation | Quality-weighted probability averaging across 3-5 frames | Prompt 2 |
| Native plugin placement | Consolidated in `modules/vision-camera-pose/` — NOT `ios/honeyswing/` | Prompt 2 |
| Native call pattern | Single JS→native call (`classifyGripFrames`) — NOT multiple plugins | Prompt 2 |
| Address frame selection | Timestamp-based via DetectedPhase — NO hardcoded frame indices | Prompt 2 |
| Persistence | No DB change — rides existing swing_debug JSON column | Prompt 2 |

---

## Section 1 — Contradiction Pass

### Prompt 1 vs Prompt 2 vs Feature Spec

| # | Contradiction | Source A | Source B | Resolution |
|---|--------------|----------|----------|------------|
| 1 | Prompt 1 audit stated "Apple Vision (`VNDetectHumanBodyPoseRequest`)" as pose backend | Prompt 1 explore agent | Repo truth: `modules/vision-camera-pose/` imports `MediaPipeTasksVision` | **RESOLVED**: MediaPipe is active. Apple Vision file is dead legacy. Corrected in Prompt 2. |
| 2 | Prompt 1 said "17 joints emitted to JS" | Prompt 1 audit | `PoseTypes.ts` defines 33 `JointName` values | **RESOLVED**: 33 joints. The 17-joint claim came from reading the legacy plugin. |
| 3 | Prompt 2 originally placed crop + classify in `ios/honeyswing/` as separate plugins | Prompt 2 Section 1 | User correction: must consolidate in `modules/` | **RESOLVED**: Consolidated in `modules/vision-camera-pose/`. Architecture doc updated. |
| 4 | Prompt 2 said "address is typically frames[0-9]" | Prompt 2 Ground Truth bullet 4 | User correction: must use DetectedPhase timestamps | **RESOLVED**: All frame selection uses DetectedPhase indices + timestamps. No hardcoded ranges. Architecture doc updated. |
| 5 | Feature spec says "multi-frame inference REQUIRED" | Feature spec | Prompt 2 smallest proof skipped multi-frame | **NO CONTRADICTION**: Smallest proof validates single-frame native pipeline. Multi-frame is in full build, not proof. |

**Verdict**: All contradictions resolved. No remaining conflicts between Prompt 1, Prompt 2 (as amended), and feature spec.

---

## Section 2 — Primary Blocking Risk

**CoreML model bundling in Expo module build target.**

- **Category**: DEVICE-TEST / CONFIG
- **Why it fails first**: The `.mlmodel` file must be compiled by Xcode into `.mlmodelc` and included in the app bundle. When the model lives inside `modules/vision-camera-pose/` (an Expo auto-linked module), the podspec or Xcode project must explicitly include it as a resource. If it's silently excluded, `Bundle.main.path(forResource:)` returns nil, and all downstream inference fails — with no compile-time error.
- **Fastest validation**: After placing the placeholder `.mlmodel` in `modules/vision-camera-pose/ios/`, run `npx expo run:ios`, then in Swift: `print(Bundle.main.path(forResource: "GripClassifier", ofType: "mlmodelc"))`. If nil, the resource bundling needs fixing before anything else.

---

## Section 3 — Full Risk Register

### R1: Pixel buffer retention failure
- **Symptom**: `classifyGripFrames` returns null for all frames
- **Root cause**: CVPixelBuffer not retained (ARC releases it); or ring buffer not populated
- **Detection**: Gate 1 — log buffer count after capture
- **Mitigation**: Explicit `CVPixelBufferRetain` / `CVPixelBufferRelease` in ring buffer; verify count > 0 post-capture
- **Blocker**: YES — no pixels, no feature

### R2: Ring buffer memory pressure
- **Symptom**: App receives `didReceiveMemoryWarning`; potential background termination
- **Root cause**: 12 × 2.7MB = ~32MB additional allocation during capture
- **Detection**: Xcode memory gauge during capture; memory warning logs
- **Mitigation**: Shrink to 6 slots on warning; release buffer immediately after grip inference
- **Blocker**: NO — degrades gracefully (fewer frames or skip)

### R3: Timestamp misalignment
- **Symptom**: Grip inference runs on wrong frames (not address phase)
- **Root cause**: Ring buffer timestamps use different clock than PoseFrame timestamps; or DetectedPhase indices don't map to buffer slots
- **Detection**: Gate 2 — log requested timestamps vs buffer timestamps; verify match within ±1 frame
- **Mitigation**: Both use `frame.timestamp` from VisionCamera (same clock source). Matching uses closest-timestamp lookup, not exact equality.
- **Blocker**: YES if severe — but solvable with tolerance window

### R4: Crop accuracy issues
- **Symptom**: Cropped region doesn't contain the hand/grip area
- **Root cause**: Wrist joint coordinates inaccurate; crop size too small; coordinate system mismatch (normalized vs pixel)
- **Detection**: Gate 3 — save cropped CGImage to temp directory, visually inspect
- **Mitigation**: Use wrist + index + pinky joints for crop center/size; fallback to wrist ± 15% frame width
- **Blocker**: NO — crop quality degrades, confidence drops, result still null-safe

### R5: CoreML integration failure
- **Symptom**: Model init throws; or inference returns error
- **Root cause**: Model not in bundle (see primary risk); or model format incompatible with device's CoreML version
- **Detection**: Gate 4 — verify model loads, run inference on one frame
- **Mitigation**: iOS 16+ deployment target supports all CoreML 6 features; placeholder model generated with coremltools for iOS 16
- **Blocker**: YES — but caught early at Gate 4

### R6: Inference latency
- **Symptom**: Post-capture delay noticeable to user (>200ms added)
- **Root cause**: CoreML inference on 3-5 crops sequentially
- **Detection**: Instrument `classifyGripFrames` wall-clock time
- **Mitigation**: EfficientNet-B0 ~5-15ms per crop on Neural Engine; 5 crops = 25-75ms. Single native call eliminates bridge overhead. If too slow, reduce to 3 frames.
- **Blocker**: NO — acceptable within 200ms budget

### R7: Bridge overhead
- **Symptom**: N/A (eliminated by consolidation)
- **Root cause**: Original multi-plugin design had 3 round-trips per frame
- **Detection**: N/A
- **Mitigation**: Consolidated single native call. Risk eliminated.
- **Blocker**: NO — resolved by architecture

### R8: Result timing race
- **Symptom**: Grip result not attached to swing_debug before `persistSwing()` runs
- **Root cause**: Grip inference is async; persist may fire before completion
- **Detection**: Gate 6 — verify swing_debug contains `grip_estimation` in persisted JSON
- **Mitigation**: Run grip inference synchronously between `analyzePoseSequence()` and `setCurrentSwingAnalysis()`. Total time budget: <200ms.
- **Blocker**: NO — if async needed, attach grip result to swing_debug before persist call

### R9: Low-confidence outputs
- **Symptom**: All grip results have ~0.33 probability (uniform) even with trained model
- **Root cause**: Poor crop quality; model not trained on golf grip images; wrong input normalization
- **Detection**: Gate 5 — verify that with placeholder model, outputs ARE uniform (expected); with trained model, outputs differentiate
- **Mitigation**: Placeholder phase explicitly expects uniform outputs. Trained model validated separately before swap.
- **Blocker**: NO — expected for placeholder; separate concern for trained model

### R10: Left/right handed mismatch
- **Symptom**: Crop targets wrong hand (trail instead of lead, or vice versa)
- **Root cause**: `isLeftHanded` flag not propagated to crop logic; or wrist joint naming confusion (leftWrist in image = trail hand for right-handed golfer)
- **Detection**: Gate 3 — verify crop targets correct hand for both handedness settings
- **Mitigation**: `gripEstimation.ts` receives `isLeftHanded` from `getIsLeftHanded()` (already called in finalizeCapture). Maps to correct wrist joint before native call.
- **Blocker**: NO — logic error, caught at gate, easy fix

### R11: Regression in swing pipeline
- **Symptom**: Swing score, angles, tempo, or phases change after grip code added
- **Root cause**: Ring buffer slows pose detection; or analysisPipeline.ts changes break existing logic
- **Detection**: Gate 6 — run existing swing test suite; compare 5 captures before/after
- **Mitigation**: Ring buffer is write-only during capture (append after pose detection, not before). FrameSelectionDebug extension is additive (new optional field only).
- **Blocker**: YES if detected — must not ship

### R12: Regression in grip pipeline (protected)
- **Symptom**: Existing grip capture/result flow breaks
- **Root cause**: Accidentally modifying protected files
- **Detection**: Gate 6 — run grip capture flow end-to-end; verify no file changes in `app/grip/`, `lib/gripStore.ts`, `supabase/functions/classify-grip/`
- **Mitigation**: Protected files listed in constraint. `git diff` verification before merge.
- **Blocker**: YES if detected — hard constraint

### R13: Release build differences
- **Symptom**: Works in debug but fails in release (archive) build
- **Root cause**: CoreML model optimization differs; Swift optimization flags; dead code stripping removes plugin registration
- **Detection**: Gate 7 — test with release build on device
- **Mitigation**: Test archive build before submission. CoreML models are compiled at build time regardless of config.
- **Blocker**: YES if detected — must test before submission

### R14: Model bundling failure
- **Symptom**: `Bundle.main.path(forResource: "GripClassifier", ofType: "mlmodelc")` returns nil
- **Root cause**: `.mlmodel` not included in Xcode target's "Copy Bundle Resources"; podspec missing resource declaration
- **Detection**: Gate 4 — first thing tested
- **Mitigation**: If Expo module podspec doesn't support resource bundling, move model to main app target with explicit path. Worst case: place in `ios/honeyswing/` resources only (not code).
- **Blocker**: YES — no model, no feature; but solvable

---

## Section 4 — Real Device Test Gates

### Gate 1 — Ring buffer works
**Pass**: After a 4-second capture, `print("[GripBuffer] count: \(buffer.count)")` logs count >= 8 (at 120fps with skip=4, ~30 frames/sec, 12-slot buffer cycles ~10 times). No frame drops in pose detection (compare frame count with/without buffer).
**Fail**: Buffer count is 0, OR pose frame count drops by >5% compared to baseline.

### Gate 2 — Frames align correctly with timestamps
**Pass**: For each DetectedPhase address timestamp, the ring buffer contains a frame within ±50ms. Log: `"[GripBuffer] requested ts=X, closest ts=Y, delta=Z"`. All deltas < 50ms.
**Fail**: Any delta > 100ms, OR no buffer frame found for an address timestamp.

### Gate 3 — Crop correctness
**Pass**: Save cropped 224x224 CGImage to `tmp/grip_crop_N.jpg`. Visual inspection confirms: hand/grip area is centered and visible. Test with both left-handed and right-handed settings.
**Fail**: Crop shows wrong body region (e.g., torso, face), OR crop is mostly black/empty, OR wrong hand targeted for handedness.

### Gate 4 — CoreML inference works
**Pass**: `classifyGripFrames` returns a non-null result with probability arrays that sum to ~1.0 per classification dimension. Model loads without error. Inference completes in <100ms total for 3 frames.
**Fail**: Model path returns nil (bundling issue), OR inference throws, OR probabilities don't sum to ~1.0.

### Gate 5 — Aggregation stable
**Pass**: For placeholder model, aggregated output shows ~equal probabilities across classes (expected: ~0.33 each). For 5 consecutive captures, aggregation produces consistent structure (no crashes, no NaN, no undefined).
**Fail**: NaN or undefined in output, OR crash during aggregation, OR inconsistent result structure across captures.

### Gate 6 — Result pipeline unaffected
**Pass**: 
- Swing analysis score, angles, tempo, phases are identical with and without grip feature (compare JSON output for same PoseFrame[] input)
- `swing_debug` contains new `grip_estimation` field
- Existing grip capture flow (`app/grip/`) works unchanged
- `git diff` shows zero changes in protected files
- Navigation to result screen timing unchanged (±100ms)
**Fail**: Any swing metric changes, OR protected file modified, OR navigation timing regresses >200ms.

### Gate 7 — 3-5 swing loop passes
**Pass**: Record → result → "Record Again" loop 5 times consecutively. No crash, no memory leak (Xcode memory gauge returns to baseline ±5MB after each cycle), grip_estimation present in swing_debug each time, ring buffer releases confirmed.
**Fail**: Crash on any iteration, OR memory grows monotonically across iterations (leak), OR grip_estimation missing on any iteration.

---

## Section 5 — Fallback Plan

### If EfficientNet path fails

**What changes**:
- Remove CoreML model and inference code from pose plugin
- Remove crop code from pose plugin
- Remove `classifyGripFrames` / `releaseGripBuffer` exports
- Remove `gripEstimation.ts` and `gripFrameQuality.ts`
- Remove `grip_estimation` field from FrameSelectionDebug
- Revert record.tsx to pre-integration state

**What stays identical**:
- Ring buffer code (useful for future features like frame replay)
- OR ring buffer removed too if not needed (clean revert)

**Time cap before fallback**:
- If Gate 4 (CoreML inference) fails after 4 hours of debugging → fallback
- If Gate 1 (ring buffer) fails after 2 hours → fallback (fundamental blocker)

**Fallback viability**:
- Full revert to pre-feature state is safe — all changes are additive
- `git revert` or branch abandonment, zero user impact
- Feature can be re-attempted with different model runtime (TFLite) or different approach (hand landmarks only, no image)

---

## Section 6 — Build Order

### Phase A: Domain Logic (JS-only, testable without device)

| Step | Tag | Description | Files |
|------|-----|-------------|-------|
| 1 | [JS-ONLY] | Define `GripFrameResult` and `GripEstimationResult` types | `packages/domain/swing/gripEstimation.ts` |
| 2 | [JS-ONLY] | Implement frame quality scoring: wrist visibility, hand joint confidence, inter-frame stillness | `packages/domain/swing/gripFrameQuality.ts` |
| 3 | [JS-ONLY] | Implement timestamp-based address frame selection using DetectedPhase | `packages/domain/swing/gripEstimation.ts` |
| 4 | [JS-ONLY] | Implement quality-weighted probability aggregation + argmax classification | `packages/domain/swing/gripEstimation.ts` |
| 5 | [JS-ONLY] | Add `grip_estimation?: GripEstimationResult` to `FrameSelectionDebug` type | `packages/domain/swing/analysisPipeline.ts` |
| 6 | [JS-ONLY] | Run `npx tsc --project tsconfig.json` — must pass with zero errors | — |

### Phase B: Native Infrastructure (requires Xcode build)

| Step | Tag | Description | Files |
|------|-----|-------------|-------|
| 7 | [NATIVE-BUILD-REQUIRED] | Add CVPixelBuffer ring buffer (12 slots) to pose plugin: `stashFrame()` in `callback()`, static buffer with timestamp metadata | `modules/vision-camera-pose/ios/HoneyVisionCameraPosePlugin.swift` |
| 8 | [NATIVE-BUILD-REQUIRED] | Generate placeholder CoreML model (EfficientNet-B0 shape, random weights) via coremltools script | `modules/vision-camera-pose/ios/GripClassifier.mlmodel` |
| 9 | [NATIVE-BUILD-REQUIRED] | Ensure model is included in build target (podspec resources or Xcode "Copy Bundle Resources") | Podspec or Xcode project |
| 10 | [NATIVE-BUILD-REQUIRED] | Add consolidated `classifyGripFrames(timestamps:, joints:)` to pose plugin: retrieve buffers → crop → CoreML inference → return probabilities | `modules/vision-camera-pose/ios/HoneyVisionCameraPosePlugin.swift` |
| 11 | [NATIVE-BUILD-REQUIRED] | Add `releaseGripBuffer()` to pose plugin | `modules/vision-camera-pose/ios/HoneyVisionCameraPosePlugin.swift` |
| 12 | [NATIVE-BUILD-REQUIRED] | Export `classifyGripFrames()` and `releaseGripBuffer()` from JS bridge | `modules/vision-camera-pose/src/index.ts` |
| 13 | [NATIVE-BUILD-REQUIRED] | `cd ios && pod install && cd .. && npx expo run:ios` — must build clean | — |
| 14 | [NATIVE-BUILD-REQUIRED] | **Gate 1**: Verify ring buffer populated after capture | Device test |
| 15 | [NATIVE-BUILD-REQUIRED] | **Gate 2**: Verify timestamp alignment | Device test |
| 16 | [NATIVE-BUILD-REQUIRED] | **Gate 3**: Verify crop correctness (save to tmp, inspect) | Device test |
| 17 | [NATIVE-BUILD-REQUIRED] | **Gate 4**: Verify CoreML inference returns valid probabilities | Device test |

### Phase C: Integration

| Step | Tag | Description | Files |
|------|-----|-------------|-------|
| 18 | [JS-ONLY] | Wire grip estimation into record.tsx: after `analyzePoseSequence()`, call grip pipeline, attach to swing_debug, call `releaseGripBuffer()` | `app/(tabs)/record.tsx` |
| 19 | [NATIVE-BUILD-REQUIRED] | **Gate 5**: Verify aggregation produces stable output across captures | Device test |
| 20 | [NATIVE-BUILD-REQUIRED] | **Gate 6**: Verify swing pipeline unaffected + protected files unchanged | Device test + git diff |
| 21 | [NATIVE-BUILD-REQUIRED] | **Gate 7**: 5-capture loop test — no crash, no leak, grip_estimation present each time | Device test |

---

## Section 7 — Regression Checks

| Check | Method | Pass Criteria |
|-------|--------|---------------|
| **Swing pipeline** | Compare `AnalysisResult` (score, angles, tempo, phases) for same PoseFrame[] input before and after feature | Identical values |
| **Result navigation** | Time from `finalizeCapture()` to router.push | Within ±200ms of baseline |
| **Record again loop** | 5 consecutive record→result→record cycles | Zero crashes, memory stable |
| **Grip pipeline untouched** | `git diff app/grip/ lib/gripStore.ts supabase/functions/classify-grip/` | Empty diff |
| **Auth/paywall untouched** | `git diff` on auth and paywall files | Empty diff |
| **No new DB columns** | Check Supabase migrations | No new migrations |

---

## Section 8 — Phase Artifacts

### Phase A: Domain Logic
| Artifact | File Path | Next Phase Dependency |
|----------|-----------|----------------------|
| GripFrameResult type | `packages/domain/swing/gripEstimation.ts` | Phase B (native returns this shape) |
| GripEstimationResult type | `packages/domain/swing/gripEstimation.ts` | Phase C (attached to swing_debug) |
| gripFrameQuality scoring function | `packages/domain/swing/gripFrameQuality.ts` | Phase C (called before native) |
| FrameSelectionDebug extended type | `packages/domain/swing/analysisPipeline.ts` | Phase C (result attachment) |
| tsc passes | — | Phase B gate (TS must compile) |

### Phase B: Native Infrastructure
| Artifact | File Path | Next Phase Dependency |
|----------|-----------|----------------------|
| Ring buffer implementation | `modules/vision-camera-pose/ios/HoneyVisionCameraPosePlugin.swift` | Phase C (record.tsx calls it) |
| Placeholder CoreML model | `modules/vision-camera-pose/ios/GripClassifier.mlmodel` | Phase C (inference requires it) |
| classifyGripFrames native function | `modules/vision-camera-pose/ios/HoneyVisionCameraPosePlugin.swift` | Phase C (JS bridge calls it) |
| JS exports | `modules/vision-camera-pose/src/index.ts` | Phase C (record.tsx imports) |
| Gates 1-4 passed | — | Phase C gate (native must work) |

### Phase C: Integration
| Artifact | File Path | Next Phase Dependency |
|----------|-----------|----------------------|
| Grip wiring in record.tsx | `app/(tabs)/record.tsx` | — (final) |
| Gates 5-7 passed | — | — (ship) |

---

## Section 9 — Open Questions Registry

File created at: `docs/setup-frame-grip-estimation/open-questions.md`

**Tracking rules**:
- New questions added with `[OPEN]` status, discovery date, and phase
- Resolved questions marked `[RESOLVED]` with resolution and date
- This file MUST be read at the start of each implementation phase
- Phase-blocking questions must be resolved before that phase begins
- Any team member can add questions

---

## Section 10 — Release Compliance

### App Privacy Impact
- **No new data collection**: Grip estimation runs entirely on-device. No images leave the device. No new network requests.
- **No new permissions**: Uses existing camera permission (already declared).
- **Privacy nutrition label**: No change required. Grip estimation result stored in existing swing_debug JSON (already declared as "app functionality" data).

### Export Compliance
- **No encryption added**: CoreML uses Apple's built-in framework, not custom cryptography.
- **No change to export compliance questionnaire**.

### Data Classification
- **Grip estimation result**: App functionality data, stored locally in swing_debug JSON. Persisted via existing `persistSwing()` flow to existing Supabase column. No new PII.
- **CVPixelBuffer ring buffer**: Transient native memory only. Never persisted, never transmitted. Released after each capture cycle.

---

## Section 11 — Must Ship vs Bonus vs Future

### MUST SHIP

- [ ] `GripFrameResult` and `GripEstimationResult` types
- [ ] Frame quality scoring (wrist visibility, hand joint confidence, stillness)
- [ ] Timestamp-based address frame selection via DetectedPhase
- [ ] Quality-weighted probability aggregation
- [ ] CVPixelBuffer ring buffer (12 slots) in `modules/vision-camera-pose/`
- [ ] Consolidated crop + CoreML classify (single `classifyGripFrames` native call)
- [ ] Placeholder CoreML model (EfficientNet-B0 shape, random weights)
- [ ] JS bridge exports (`classifyGripFrames`, `releaseGripBuffer`)
- [ ] `FrameSelectionDebug.grip_estimation` field
- [ ] record.tsx integration (call grip pipeline post-analysis, release buffer)
- [ ] All 7 gates passed

### BONUS

- [ ] Memory pressure handling (`didReceiveMemoryWarning` ��� shrink buffer)
- [ ] Save cropped images to tmp for visual inspection (debug build only)
- [ ] Per-frame timing instrumentation in swing_debug
- [ ] Handedness-aware crop validation (verify correct hand targeted)

### FUTURE

- [ ] Trained EfficientNet model (replace placeholder)
- [ ] User-facing grip UI on result screen
- [ ] Grip trend tracking across sessions
- [ ] Integration with existing grip capture flow (comparison/validation)
- [ ] Android support
- [ ] Grip coaching tips based on estimation

---

## Section 12 — Time Estimates

| Path | Scope | Estimate |
|------|-------|----------|
| **Proof path** | Ring buffer + placeholder model + single native call + console.log output (Gates 1-4) | 1 focused session |
| **Core path** | Full must-ship list (all 7 gates) | 2-3 focused sessions |
| **Extended path** | Core + bonus items | 3-4 focused sessions |

Note: "Session" = uninterrupted implementation block. Excludes model training (separate workstream).

---

## Section 13 — Go / No-Go Rule

**Ship if and only if all 7 gates pass on a real device with a release build and `git diff` confirms zero changes to protected files.**

---

## Section 14 — What NOT to Waste Time On

- **Training the model** — placeholder is sufficient for pipeline validation; training is a separate workstream
- **User-facing UI** — swing_debug only; no result screen changes
- **Android** — iOS only for v1
- **Optimizing inference latency** — EfficientNet-B0 on Neural Engine is already fast; don't optimize until measured
- **Custom preprocessing** — let CoreML handle normalization (baked into model via coremltools)
- **Fancy crop algorithms** — wrist-centered with joint-based sizing is sufficient; don't build face detection or segmentation
- **Persisting cropped images** — transient native memory only; don't build image storage
- **Comparing with server-side grip classification** — different feature, different data source, different flow
- **Backwards compatibility with older iOS** — deployment target is 16.0, CoreML 6 is available
- **Multiple model formats** — CoreML only; don't prototype TFLite or MediaPipe custom tasks

---

## Section 15 — Self Check

- [x] No architecture contradictions (all 5 from Section 1 resolved)
- [x] No locked decisions reopened (all 10 decisions preserved from table above)
- [x] Correct plugin placement (`modules/vision-camera-pose/` — NOT `ios/honeyswing/`)
- [x] Timestamp-based frame selection (DetectedPhase timestamps, no hardcoded indices)
- [x] No schema changes introduced (rides existing swing_debug JSON column)
- [x] Each phase has gate + fallback (Phase A: tsc pass; Phase B: Gates 1-4; Phase C: Gates 5-7; Fallback in Section 5)
