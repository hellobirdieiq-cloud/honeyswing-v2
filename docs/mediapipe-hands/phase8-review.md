# Phase 8 Review — Hand Detection Integration

**Date:** 2026-03-27
**Files reviewed:** `app/grip/capture.tsx`, `lib/handDetection.ts`

---

## 1. End-to-End Wiring Trace

The pipeline is wired correctly. Full path:

```
Camera frame (VisionCamera, capture.tsx:292-302)
  → frameProcessor worklet (capture.tsx:90-97)
    → detectHands(frame) (handDetection.ts:38-47)
      → plugin.call(frame) — calls native HoneyVisionCameraHandPlugin.swift
      → returns unknown[] (raw hand result array)
  → onHandResults via Worklets.createRunOnJS (capture.tsx:77-88)
    → filters diagnostic sentinels (capture.tsx:83-84)
    → updateHandDebug (capture.tsx:53-75)
      → EMA smoothing on normalized x/y, alpha=0.4 (capture.tsx:55-73)
      → setHandDebug(smoothed) triggers re-render (capture.tsx:74)
  → Live overlay renders (capture.tsx:353-395)
    → lm.x * screenW, lm.y * screenH at draw time (capture.tsx:370-384)
  → Debug panel renders (capture.tsx:397-414)
```

**Freeze path on capture:**
```
capturePhoto() → frozenHandsRef.current = [...handResultsRef.current] (capture.tsx:168)
  → Preview phase renders frozen skeleton (capture.tsx:229-269)
    → Same screenW/screenH coordinate math (capture.tsx:245-259)
```

**Key detail:** `handResultsRef.current` stores the RAW (pre-smoothing) results (capture.tsx:54), while `handDebug` state holds the smoothed results. The frozen overlay uses the raw snapshot from `handResultsRef`, which means the frozen skeleton shows the last unsmoothed frame — slightly different from what was displayed live. This is minor and arguably correct (the photo is a single instant, not a smoothed average).

---

## 2. Bugs, Memory Leaks, and Cleanup

### Frame processor cleanup
**OK.** `useFrameProcessor` is a VisionCamera hook that automatically cleans up when the component unmounts. The Camera's `isActive={phase !== 'preview'}` (capture.tsx:296) also stops frame processing during preview. No leak here.

### smoothedRef between sessions
**Minor issue.** `smoothedRef` (capture.tsx:51) accumulates EMA state entries keyed by `${handIndex}-${landmarkId}` and is never cleared. When the user does Retake → re-enters camera phase, the EMA state from the previous session persists. This means the first few frames after retake will blend with stale positions from the last session.

**Impact:** Low — the EMA converges within ~3-5 frames (alpha=0.4), so stale state washes out quickly. But for correctness, `handleRetake()` should clear it:
```
smoothedRef.current = {};
```

### frozenHandsRef cleanup
**Correct.** `handleRetake()` (capture.tsx:177-183) clears `frozenHandsRef.current = []` before returning to camera phase. `capturePhoto()` (capture.tsx:168) snapshots before setting preview phase. No gap or race.

### Other observations
- **No throttling on setHandDebug:** Every frame processor result calls `setHandDebug()` which triggers a React re-render + SVG redraw. At 30fps this is 30 re-renders/second. This is the same pattern used by SkeletonOverlay in the pose capture screen and hasn't been a problem there, but it's worth noting if performance issues appear on older devices.
- **Diagnostic sentinels silently dropped:** When `_diagnostic` is detected (capture.tsx:83-84), it's ignored without logging. If `hand_landmarker.task` is missing from the bundle, the user sees "Hands: 0" with no indication why. Consider logging the diagnostic at least once.
- **`normalizeHandLandmarks` in handDetection.ts is unused.** It was added in a prior phase but `capture.tsx` no longer calls it (coordinates stay normalized, converted at draw time). Dead code — should be removed.

---

## 3. Debug Panel — Keep or Hide?

**Keep for now, but plan to gate it.**

The debug panel (capture.tsx:397-414) is valuable during this integration phase:
- Confirms hand detection is running (hand count)
- Shows inference timing when available (every 30th frame)
- Shows handedness label and confidence
- Shows wrist position to verify coordinate sanity

**When to hide:** Before any user-facing build or App Store submission. Two options:
1. **`__DEV__` gate:** Wrap in `{__DEV__ && (...)}` — shows in dev builds, hidden in production. Simplest.
2. **Remove entirely** when hand detection is validated and stable.

Recommendation: Gate behind `__DEV__` in the next commit. It costs nothing and prevents accidental shipping.

---

## 4. Current Accuracy Limitation and Landmark Opportunity

### Current grip classification flow
`classifyGrip()` (lib/classifyGrip.ts:28-95) sends:
- A resized JPEG photo (800px wide, 80% quality) — capture.tsx:63
- User handedness (left/right) — classifyGrip.ts:65

Claude Vision receives ONLY the photo and must infer everything from pixel data: knuckle count, hand rotation, V-line position, palm orientation, grip position on club.

### Accuracy limitations
1. **Ambiguous angles:** A photo from one angle can't distinguish a neutral grip from a slightly weak grip — the difference is ~15° of hand rotation that's invisible from certain camera positions.
2. **Occluded fingers:** The trail hand often covers the lead hand's fingers. Claude has to guess finger positions it can't see.
3. **No depth information:** A flat photo can't convey how much the hands wrap around the grip or the pressure distribution.
4. **Lighting/background noise:** Claude Vision processes the entire image, including irrelevant background. It has no way to isolate hand regions precisely.

### What landmarks unlock
Sending the 21-point hand landmarks alongside the photo gives Claude:
1. **Precise finger positions:** Exact 3D coordinates of every fingertip, knuckle, and joint — even when occluded in the photo. MediaPipe infers occluded joints from the visible ones.
2. **Knuckle count by geometry:** Count visible knuckles by comparing landmark z-values and positions relative to the grip axis — no visual ambiguity.
3. **V-line angle:** Compute the angle between thumb tip (landmark 4) and index MCP (landmark 5) directly from coordinates. Currently Claude eyeballs this from the photo.
4. **Hand rotation quantification:** The angle of the wrist-to-middle-finger axis (landmarks 0→9) relative to vertical gives an exact rotation measurement in degrees.
5. **Grip overlap detection:** Compare lead hand pinky (landmark 20) position with trail hand index (landmark 8) to classify overlap vs interlock vs baseball grip.
6. **Consistency across sessions:** Landmarks provide normalized, repeatable measurements. Photo-only classification varies with lighting, angle, and distance.

The payload change would be adding a `landmarks` field to the `classifyGrip` request body — the edge function would include them in the Claude Vision prompt as structured data alongside the image.

---

## 5. Three Most Important Next Steps

### 1. Device test with hand_landmarker.task model
**Why:** Nothing has been tested on a real device yet. The Swift plugin, model loading, CIContext rendering, and JS bridge are all unverified. The model file itself hasn't been downloaded.
**Action:** Download `hand_landmarker.task` from MediaPipe model catalog, place at `ios/hand_landmarker.task`, run `cd ios && pod install && cd .. && npx expo run:ios`, navigate to grip capture, confirm skeleton renders on hands.
**Risk:** Model init failure, CIContext performance, coordinate orientation mismatch.

### 2. Send frozen landmarks to classify-grip edge function
**Why:** This is the entire point of the hand detection work — improving grip classification accuracy with structured landmark data.
**Action:** In `capturePhoto()`, serialize `frozenHandsRef.current` alongside the photo. Update `classifyGrip()` to include landmarks in the request body. Update the Supabase edge function prompt to use the landmark data.
**Dependency:** Step 1 must pass first (landmarks must actually work on device).

### 3. Clean up dead code and gate debug UI
**Why:** The codebase has accumulated artifacts from iteration: `normalizeHandLandmarks` is unused, `smoothedRef` isn't cleared on retake, the debug panel should be dev-only.
**Action:** Remove `normalizeHandLandmarks` from `handDetection.ts`. Add `smoothedRef.current = {}` to `handleRetake()`. Wrap debug panel in `{__DEV__ && (...)}`. Single cleanup commit.
