# Prompt 2: Architecture — Setup-Frame Grip Estimation (EfficientNet)

## Conflict Resolution: Pose Backend

**VERDICT: MediaPipe PoseLandmarker is the active pose backend.**

Evidence:
- `record.tsx:10` → `import { honeyPoseDetect } from '../../modules/vision-camera-pose/src'`
- `modules/vision-camera-pose/ios/HoneyVisionCameraPosePlugin.swift` → `import MediaPipeTasksVision`, `PoseLandmarker(options: opts)`, model `pose_landmarker_full.task`
- `PoseTypes.ts` → 33 joints (matches MediaPipe BlazePose GHUM)
- `ios/honeyswing/HoneyVisionCameraPosePlugin.swift` using Apple Vision is a **dead legacy file** — not imported

---

## Ground Truth Lock (5 Bullets)

1. **Pose backend**: MediaPipe PoseLandmarker (BlazePose GHUM Full, 33 joints) runs in `modules/vision-camera-pose/ios/HoneyVisionCameraPosePlugin.swift`. Receives CVPixelBuffer, converts via CIContext to CGImage → UIImage → MPImage, returns landmark JSON only. Raw pixels discarded per-frame.
2. **Capture flow**: VisionCamera 1280x720 @120fps → `honeyPoseDetect(frame)` worklet → `appendPoseFrame()` → `motionFramesRef` (max 180 PoseFrame[]) → `finalizeCapture()` → `analyzePoseSequence()` → `swingMotionStore` → navigate to `/analysis/result`.
3. **swing_debug**: Type `FrameSelectionDebug` at `analysisPipeline.ts:33-51`. All fields optional except `frame_selection_method`. Fully additive — new optional fields can be added without breaking existing code.
4. **Phase detection**: Address frame identified post-capture via velocity-based heuristic in `phaseDetection.ts:64-91`. Returns `DetectedPhase[]` with frame indices and timestamps. Address frame selection MUST use DetectedPhase indices/timestamps — no hardcoded frame ranges.
5. **ML runtime**: Only MediaPipe `.task` models exist on-device (pose + hand). No CoreML, TFLite, or ONNX custom model infrastructure. `MediaPipeTasksVision ~> 0.10.9` pod installed. Hand detection plugin exists at `ios/honeyswing/HoneyVisionCameraHandPlugin.swift` using `hand_landmarker.task`.

---

## Section 1 — Primary Architecture

### Where Each Concern Lives

| Concern | Location | Layer | Required? |
|---------|----------|-------|-----------|
| **Setup-frame pixel retention + crop + classify** | `modules/vision-camera-pose/ios/HoneyVisionCameraPosePlugin.swift` (ring buffer + crop + CoreML consolidated) | Native (Swift) | REQUIRED |
| **Frame quality scoring** | New file: `packages/domain/swing/gripFrameQuality.ts` | Domain (pure TS) | REQUIRED |
| **Multi-frame aggregation** | New file: `packages/domain/swing/gripEstimation.ts` | Domain (pure TS) | REQUIRED |
| **Result attachment** | `packages/domain/swing/analysisPipeline.ts` (extend `FrameSelectionDebug`) | Domain | REQUIRED |

### Why This Architecture

**Consolidated native plugin**: Ring buffer, crop extraction, and CoreML inference ALL live in `modules/vision-camera-pose/ios/HoneyVisionCameraPosePlugin.swift`. JS calls ONE native function post-capture (`classifyGripFrames(timestamps, jointCoords)`) which internally retrieves stashed buffers, crops, classifies, and returns aggregated probabilities. This eliminates multiple JS→native round-trips and keeps all pixel-handling code co-located with the only code that touches CVPixelBuffer.

**Why `modules/vision-camera-pose/` and NOT `ios/honeyswing/`**:
1. The active pose plugin lives in `modules/` — that's where CVPixelBuffer access exists
2. `ios/honeyswing/` contains a dead legacy Apple Vision pose plugin — placing new code there creates confusion about which is active
3. The Expo module structure under `modules/` has its own build target and ObjC bridge — keeping grip code here ensures it compiles with the same target that already links MediaPipe
4. Splitting native code across `modules/` (buffer) and `ios/honeyswing/` (crop+classify) would require cross-module references to a static buffer — fragile and unnecessary

**Domain-layer aggregation in pure TS**: Frame quality scoring and probability averaging are pure math on landmark data + model outputs. No native dependencies. Testable in isolation.

**swing_debug attachment**: Matches the constraint (additive only). No user-facing UI in v1. Data available for validation and future UI.

---

## Section 2 — Decision Tables

### A. Setup-Frame Extraction Location

| Option | Pros | Cons | Risk | If It Fails |
|--------|------|------|------|-------------|
| **Ring buffer in pose plugin** | Single file change; CVPixelBuffer already in hand; no new frame processors; no capture UX change | Adds memory pressure (~30-40MB); couples buffer to pose plugin | LOW | Frames unavailable → grip estimation returns null, swing analysis unaffected |
| Snapshot at motion start | Simpler; one frame only | Imprecise timing; may miss true address; needs real-time stillness detection in native | MEDIUM | Wrong frame → bad crop → low-confidence result |
| Classify every frame | No pixel retention needed | ~15ms/frame EfficientNet overhead on top of pose; thermal throttling risk at 120fps | HIGH | Performance regression in capture; dropped frames |
| Re-open camera post-capture | No buffer needed | User may have moved; adds delay; terrible UX | FATAL | Completely unreliable |

**PICK: Ring buffer in pose plugin.**
Reject: snapshot (imprecise), every-frame (too expensive), re-open (unreliable).

### B. Image Source Strategy

| Option | Pros | Cons | Risk | If It Fails |
|--------|------|------|------|-------------|
| **CVPixelBuffer ring buffer (raw)** | Full resolution; no compression artifacts; can crop at any region | ~2.7MB per frame × N frames; must manage CVPixelBuffer lifecycle | LOW | Memory warning → shrink buffer or skip grip |
| JPEG snapshot ring buffer | Smaller per frame (~100KB); simpler lifecycle | Compression artifacts in hand region; re-decode for crop | MEDIUM | Artifacts degrade classification accuracy |
| Video file frame extraction | No runtime memory | Requires video decode post-capture; adds latency; video may not be ready | HIGH | Video not ready at analysis time → grip skipped |

**PICK: CVPixelBuffer ring buffer (raw).**
Reject: JPEG (artifacts), video extraction (latency + timing dependency).

### C. Model Runtime

| Option | Pros | Cons | Risk | If It Fails |
|--------|------|------|------|-------------|
| **CoreML (.mlmodel)** | Apple Neural Engine acceleration; no new pods; native Vision framework integration; `coremltools` conversion well-documented | New infrastructure (first CoreML model in project); ANE availability varies by device | LOW | Falls back to CPU; still works, slower |
| TFLite via new pod | Familiar ecosystem; cross-platform | New pod dependency; no ANE; CPU/GPU only | MEDIUM | Pod version conflicts with MediaPipe's internal TFLite |
| MediaPipe custom task | Reuse existing pod | Poorly documented for custom classification; not designed for EfficientNet | HIGH | May not work; limited community support |

**PICK: CoreML (.mlmodel).**
Reject: TFLite (new dependency, no ANE), MediaPipe custom (poor fit).

### D. Data Handoff to Result Screen

| Option | Pros | Cons | Risk | If It Fails |
|--------|------|------|------|-------------|
| **Extend FrameSelectionDebug (swing_debug)** | Additive-only constraint satisfied; no new store; no schema change; result screen already reads swing_debug | Data only visible via debug/logging until UI added | LOW | Missing field → null, no crash |
| New field on AnalysisResult | Cleaner separation; easier to find | Modifies AnalysisResult type; may need persistence schema update | MEDIUM | Type change ripples to persistence layer |
| Separate gripEstimationStore | Fully decoupled | New store; new data flow; more plumbing | LOW | Unnecessary complexity for debug-only data |

**PICK: Extend FrameSelectionDebug (swing_debug).**
Reject: new AnalysisResult field (schema ripple), separate store (over-engineered for debug-only).

---

## Section 3 — Event Flow

### CAPTURE PHASE

| Step | File / Layer | Data Produced | Data Consumed | What Could Go Wrong |
|------|-------------|---------------|---------------|---------------------|
| 1. Camera frame arrives | VisionCamera native | `Frame` (CVPixelBuffer + metadata) | — | Camera permission denied |
| 2. Pose detection runs | `modules/vision-camera-pose/.../HoneyVisionCameraPosePlugin.swift` | 33 landmark JSON array | CVPixelBuffer | MediaPipe init failure → diagnostic sentinel |
| 3. **Ring buffer stash** | Same file (new code) | CVPixelBuffer retained in circular buffer (N slots) | CVPixelBuffer from step 1 | Memory pressure → buffer auto-shrinks or skips |
| 4. Landmarks cross bridge | Worklet → JS | Raw landmark array | — | Bridge serialization error (extremely rare) |
| 5. PoseFrame created | `MLKitProvider.ts` | `PoseFrame` | Raw landmarks | Malformed landmark → joint undefined |
| 6. Frame accumulated | `record.tsx` | `motionFramesRef` grows | `PoseFrame` | Max 180 frames cap reached → oldest dropped |

### GATE PHASE (post-capture)

| Step | File / Layer | Data Produced | Data Consumed | What Could Go Wrong |
|------|-------------|---------------|---------------|---------------------|
| 7. finalizeCapture() | `record.tsx:234` | Validation result (pass/fail) | `motionFramesRef` snapshot | < 6 frames → error state, no grip attempt |
| 8. analyzePoseSequence() | `analysisPipeline.ts:360` | `AnalysisResult` with phases | `PoseSequence` | Fallback phases → address index imprecise |
| 9. **Identify address frames via DetectedPhase** | `gripEstimation.ts` (new) | Frame timestamps for grip analysis | `DetectedPhase[]` timestamps from step 8 | No address phase → skip grip |
| 10. **Score frame quality** | `gripFrameQuality.ts` (new) | Quality scores per frame | `PoseFrame[]` matched by timestamp to DetectedPhase | All frames low quality → skip grip |
| 11. **Select top N frames** | `gripEstimation.ts` (new) | Sorted frame timestamps | Quality scores | Fewer than minimum frames → lower confidence |
| 12. **Single native call: crop + classify** | `modules/vision-camera-pose/.../HoneyVisionCameraPosePlugin.swift` (consolidated) | Per-frame classification probabilities | Frame timestamps + wrist/hand joint coords (one JS→native call) | Ring buffer released or model not found → null result |
| 14. **Aggregate probabilities** | `gripEstimation.ts` (new) | Final grip estimation + confidence | Per-frame probabilities | All low confidence → result marked uncertain |
| 15. **Attach to swing_debug** | `analysisPipeline.ts` (modified) | Extended `FrameSelectionDebug` | Aggregated grip result | — |
| 16. Store analysis | `record.tsx:275` | `swingMotionStore` updated | `AnalysisResult` with grip | — |
| 17. **Release ring buffer** | Pose plugin (via JS call) | Memory freed | — | Leak if not called → next capture clears anyway |

### RENDER PHASE

| Step | File / Layer | Data Produced | Data Consumed | What Could Go Wrong |
|------|-------------|---------------|---------------|---------------------|
| 18. Navigate to result | `record.tsx → router.push` | — | — | — |
| 19. Result screen mounts | `app/analysis/result.tsx` | UI render | `getCurrentSwingAnalysis()` | — |
| 20. Read swing_debug.grip | Result screen (future UI) | Display grip estimation | `analysis.swing_debug.grip_estimation` | Field undefined → section hidden |

---

## Section 4 — Image Pipeline Contract

### Ring Buffer Specification

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| **Format** | CVPixelBuffer (raw BGRA) | No compression artifacts; direct CoreML input; no re-decode |
| **Frame count** | 12 slots | Enough to cover any address phase duration; matched by timestamp, not index |
| **Memory per frame** | ~2.7MB (1280 x 720 x 4 bytes BGRA) | Standard VisionCamera resolution |
| **Peak memory** | ~32MB | Acceptable; iPhone SE 2 has 3GB RAM |
| **Retention policy** | Circular overwrite — newest frame replaces oldest | Guarantees bounded memory |
| **Lifetime** | Buffer allocated on `beginRecording` signal, released on explicit `releaseBuffer` call from JS after grip inference completes (or on next `beginRecording`) | Prevents leak across sessions |
| **Frame metadata** | Each slot stores: CVPixelBuffer + timestamp (ms) + frame index | Needed to match against phase detection output |
| **Thread safety** | Buffer writes on frame processor thread (serial per-frame); buffer reads on main thread post-capture | No concurrent read/write — capture must be stopped before reads |

### Crop Specification

| Parameter | Value |
|-----------|-------|
| **Crop center** | Midpoint of wrist joint (leftWrist or rightWrist, based on lead hand) |
| **Crop size** | 224 x 224 pixels (EfficientNet standard input) |
| **Crop region derivation** | Wrist → expand by 2x wrist-to-index distance in each direction; clamp to frame bounds |
| **Fallback** | If hand joints insufficient, use wrist ± 15% of frame width |
| **Output format** | CGImage (passed directly to CoreML Vision request) |
| **Coordinate system** | Normalized joint coords (0-1) × frame dimensions → pixel coords |

---

## Section 5 — Model Contract

### Input

| Parameter | Value |
|-----------|-------|
| **Image size** | 224 x 224 pixels (RGB) |
| **Pixel format** | CoreML handles CVPixelBuffer or CGImage → internal normalization |
| **Preprocessing** | Standard ImageNet normalization (mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]) — baked into CoreML model via `coremltools` |
| **Frame count for inference** | Top 3-5 frames from quality filter (configurable) |

### Output (per frame)

```typescript
type GripFrameResult = {
  leadHand: {
    weak: number;    // probability 0-1
    neutral: number;
    strong: number;
  };
  gripStyle: {
    overlap: number;
    interlock: number;
    tenFinger: number;
  };
  trailCoverage: {
    over: number;
    neutral: number;
    under: number;
  };
  frameConfidence: number;  // 0-1, model's overall confidence
};
```

### Aggregation (across frames)

```typescript
type GripEstimationResult = {
  leadHand: 'weak' | 'neutral' | 'strong';
  leadHandConfidence: number;          // weighted average probability
  gripStyle: 'overlap' | 'interlock' | 'tenFinger';
  gripStyleConfidence: number;
  trailCoverage: 'over' | 'neutral' | 'under';
  trailCoverageConfidence: number;
  framesUsed: number;                  // how many frames contributed
  framesAvailable: number;             // how many address frames existed
  aggregationMethod: 'quality_weighted_mean';
};
```

**Aggregation method**: Quality-weighted probability averaging.
- Each frame's probabilities weighted by `frameQualityScore * frameConfidence`
- Argmax of averaged probabilities → final classification per dimension
- Overall confidence = weighted mean of winning-class probabilities

### Placeholder Model (v1)

- CoreML model with correct input/output shape but random weights
- Returns uniform probabilities (~0.33 per class)
- Proves end-to-end pipeline works on real device
- Replaced with trained model in follow-up

---

## Section 6 — File-by-File Change Plan

### Files That WILL Change

| File | Change | Reason |
|------|--------|--------|
| `modules/vision-camera-pose/ios/HoneyVisionCameraPosePlugin.swift` | Add: (1) CVPixelBuffer ring buffer (12 slots), (2) crop extraction, (3) CoreML inference, (4) `classifyGripFrames(timestamps, joints)` entry point, (5) `releaseBuffer()` | Consolidated native: pixel retention + crop + classify in ONE plugin |
| `modules/vision-camera-pose/ios/GripClassifier.mlmodel` | **NEW** — placeholder CoreML model (EfficientNet-B0 architecture, random weights) | Model asset bundled with pose module |
| `modules/vision-camera-pose/src/index.ts` | Add `classifyGripFrames()` and `releaseGripBuffer()` exports | JS bridge for consolidated native call |
| `packages/domain/swing/gripFrameQuality.ts` | **NEW** — pure TS: score frame quality for grip analysis (wrist visibility, hand joint confidence, stillness) | Frame quality filter |
| `packages/domain/swing/gripEstimation.ts` | **NEW** — pure TS: orchestrate timestamp-based frame selection via DetectedPhase, invoke single native call, aggregate probabilities | Aggregation logic |
| `packages/domain/swing/analysisPipeline.ts` | Extend `FrameSelectionDebug` type with `grip_estimation?: GripEstimationResult` | Result attachment |
| `app/(tabs)/record.tsx` | After `analyzePoseSequence()`, call grip estimation pipeline, attach result to swing_debug, then call `releaseBuffer()` | Integration |

### Files That MUST NOT Change

| File | Reason |
|------|--------|
| `app/grip/capture.tsx` | Hard constraint |
| `app/grip/result.tsx` | Hard constraint |
| `lib/gripStore.ts` | Hard constraint |
| `supabase/functions/classify-grip/*` | Hard constraint |
| Auth flow files | Hard constraint |
| Paywall / RevenueCat files | Hard constraint |
| Video upload flow | Hard constraint |

---

## Section 7 — Smallest Proof First

### Minimum Viable Validation (Real Device)

**Goal**: Prove the ring buffer → crop → CoreML pipeline works end-to-end on a real iPhone.

**What to build**:
1. Ring buffer in pose plugin (12 CVPixelBuffer slots with timestamps)
2. Consolidated crop + classify in same plugin (single `classifyGripFrames` entry point)
3. Placeholder CoreML model bundled in modules/vision-camera-pose/
4. JS bridge that calls single native function with timestamps from DetectedPhase
5. Log result to `console.log` (not even swing_debug yet)

**What to verify**:
- No frame drops during capture (buffer doesn't slow pose detection)
- Memory stays under control (Xcode memory gauge < +50MB during capture)
- Crop coordinates are correct (save cropped image to tmp, inspect visually)
- CoreML inference completes without crash
- Buffer releases properly (memory returns to baseline after capture)

**What NOT to build yet**:
- Frame quality scoring
- Multi-frame aggregation
- swing_debug integration
- Any UI

**Estimated scope**: ~1 modified Swift file, ~1 modified TS file, 1 placeholder model.

---

## Section 8 — Payload Strategy

| Data | Where It Lives | Lifecycle |
|------|---------------|-----------|
| CVPixelBuffer ring buffer | Native memory (pose plugin static var in `modules/vision-camera-pose/`) | Allocated on beginRecording, released on explicit JS call or next beginRecording |
| Cropped CGImages | Native memory (temporary, inside consolidated plugin) | Created and consumed within single `classifyGripFrames` call, never leave native |
| Per-frame classification probabilities | JS heap (array) | Created during aggregation, GC'd after result attached |
| `GripEstimationResult` | `AnalysisResult.swing_debug.grip_estimation` → `swingMotionStore` | Session-scoped, cleared on next capture |
| Persisted copy | Via existing `persistSwing()` — swing_debug JSON column | Already persisted, no new column needed |

**What goes into swing_debug**:
```typescript
grip_estimation?: {
  leadHand: 'weak' | 'neutral' | 'strong';
  leadHandConfidence: number;
  gripStyle: 'overlap' | 'interlock' | 'tenFinger';
  gripStyleConfidence: number;
  trailCoverage: 'over' | 'neutral' | 'under';
  trailCoverageConfidence: number;
  framesUsed: number;
  framesAvailable: number;
  aggregationMethod: 'quality_weighted_mean';
}
```

**What does NOT go into swing_debug**: Raw pixel data, cropped images, per-frame probability arrays (too large, not useful for debugging).

---

## Section 9 — Cleanup / Memory

### Buffer Lifecycle

| Event | Action | Memory Impact |
|-------|--------|---------------|
| `beginRecording()` called | Allocate ring buffer (12 slots) OR clear existing buffer | +32MB |
| Each frame processor call | Overwrite oldest slot (circular) | Steady state ~32MB |
| `finalizeCapture()` + grip inference done | JS calls `releaseBuffer()` via NativeModule | -32MB |
| App goes to background during capture | No special handling — OS may reclaim; next capture re-allocates | Auto-recovery |
| `releaseBuffer()` never called (crash/bug) | Next `beginRecording()` clears buffer as first action | Self-healing |

### Memory Pressure Handling

- If `didReceiveMemoryWarning` fires during capture: shrink buffer to 6 slots (half), log to swing_debug
- If buffer is nil when grip inference requests a frame: skip grip estimation, return null — swing analysis proceeds normally
- Ring buffer is a **Swift static var** on the plugin class — survives across JS reloads but cleared on app restart

### Failure Modes

| Failure | Behavior | User Impact |
|---------|----------|-------------|
| CoreML model not found in bundle | `classifyGripImage()` returns null | No grip data in swing_debug; zero UX impact |
| All address frames low quality | Grip estimation returns null | Same |
| Memory warning during capture | Buffer shrinks; fewer frames for grip | Lower confidence or null |
| Ring buffer released before grip inference | Crop plugin returns null per frame | Grip estimation skipped |
| CoreML inference throws | Caught in Swift, returns error dict | JS receives null, logs warning |

---

## Section 10 — Persistence Justification

**Decision: No DB change required.**

- `swing_debug` is already persisted as a JSON column via `persistSwing()` in the existing flow
- Adding `grip_estimation` to `FrameSelectionDebug` automatically includes it in the persisted JSON
- No new table, no new column, no migration
- Data is queryable via JSON operators on the existing `swing_debug` column if needed for model validation

---

## Section 11 — Must Ship vs Bonus vs Future

### MUST SHIP (v1 — placeholder model)

- [ ] Ring buffer in pose plugin under `modules/vision-camera-pose/` (12 CVPixelBuffer slots)
- [ ] Buffer release mechanism (JS-callable via same module)
- [ ] Consolidated crop + CoreML classify in pose plugin (single `classifyGripFrames` entry)
- [ ] Placeholder CoreML model (correct shape, random weights) bundled in `modules/vision-camera-pose/ios/`
- [ ] JS bridge: `classifyGripFrames()` + `releaseGripBuffer()` exports
- [ ] Frame quality scoring (pure TS)
- [ ] Multi-frame aggregation with quality weighting (pure TS)
- [ ] Top-frame selection (pure TS)
- [ ] Extend FrameSelectionDebug with grip_estimation
- [ ] Wire into record.tsx post-analysis flow
- [ ] Buffer cleanup on capture end

### BONUS (if time permits)

- [ ] Memory pressure handling (buffer shrink on didReceiveMemoryWarning)
- [ ] Save cropped images to temp for visual inspection (debug build only)
- [ ] Per-frame timing instrumentation in swing_debug

### FUTURE (not this PR)

- [ ] Trained EfficientNet model (replace placeholder)
- [ ] User-facing grip UI on result screen
- [ ] Grip trend tracking across sessions
- [ ] Integration with existing grip capture flow (comparison)
- [ ] Android support

---

## Section 12 — Final Recommendation

### Execution Order

1. **Ring buffer** — add to pose plugin in `modules/vision-camera-pose/`, verify no frame drops, verify memory
2. **Placeholder CoreML model** — generate with coremltools, bundle in `modules/vision-camera-pose/ios/`
3. **Consolidated crop + classify** — add to same pose plugin Swift file, single `classifyGripFrames(timestamps, joints)` entry point
4. **JS bridge** — export `classifyGripFrames()` and `releaseGripBuffer()` from `modules/vision-camera-pose/src/index.ts`
5. **Domain logic** — frame quality, timestamp-based top-frame selection via DetectedPhase, aggregation (pure TS, fully testable)
6. **Pipeline integration** — extend FrameSelectionDebug, wire into record.tsx
7. **Cleanup** — buffer release, failure paths, memory pressure

### Biggest Hidden Risk

**CoreML model bundling in Expo module.** The consolidated plugin lives in `modules/vision-camera-pose/`. CoreML models must be included in the Xcode build target. If the `.mlmodel` isn't picked up by the Expo module's podspec or Xcode project, inference silently fails (model not found). Mitigation: verify model loads in Gate 4 before building any TS logic. Single native call eliminates the bridge-overhead risk from the original multi-plugin design.

### Fastest Validation Step

Build steps 1-3 only (ring buffer + placeholder model + consolidated crop+classify). Export JS bridge, console.log the output using timestamps from a real DetectedPhase. One real-device capture proves the entire native pipeline. No TS domain logic needed.
