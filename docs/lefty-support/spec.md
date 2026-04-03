# Left-Handed Swing Support Specification

## 1. Summary

HoneySwing's swing analysis pipeline hardcodes right-handed assumptions: joint-to-role mappings (left=lead, right=trail), shoulder tilt sign convention, and scoring ideals all assume right-handed anatomy. Left-handed support adds a **canonical transform** that mirrors lefty pose data into right-handed equivalents before analysis, letting the engine run unchanged. The transform is a pure function: mirror all X coordinates (`1.0 - x`) and swap bilateral joint pairs. After analysis, coaching labels ("Lead arm", "Trail arm") are already functional rather than anatomical, so no output label remapping is needed — only the VisualCoachCard skeleton highlight segments require a left/right joint-name swap for correct display. Infrastructure additions: a setter for `lib/handedness.ts`, a toggle on the Settings screen, and a `handedness` field in `swing_debug`. Estimated effort: ~6 files changed, no native code, no schema changes, JS-only until final device verification.

---

## 2. Data Flow Map

Complete path from pose capture to result screen. Each step tagged DIRECTIONAL (contains left/right assumptions) or NEUTRAL.

```
app/(tabs)/record.tsx: frameProcessor → PoseFrame[]                         — NEUTRAL
  (captures raw anatomical joints from MediaPipe, no L/R role assignment)

app/(tabs)/record.tsx: analyzePoseSequence(sequence) → AnalysisResult       — DIRECTIONAL
  ├─ [NEW] toCanonicalSequence(sequence, isLeftHanded) → PoseSequence       — DIRECTIONAL (transform)
  │
  ├─ packages/domain/swing/analysisPipeline.ts:
  │    buildTrailPoints(sequence) → SwingTrailPoint[]                       — NEUTRAL
  │      (midpoint of leftWrist + rightWrist; after canonical swap, correct)
  │
  │    calculateGolfAngles(midFrame) → GolfAngles                           — DIRECTIONAL
  │      packages/domain/swing/angles.ts:50-112
  │      (reads leftShoulder, rightShoulder, etc. by name → after swap, correct)
  │
  │    detectSwingPhases(trail) → DetectedPhase[]                           — NEUTRAL
  │      packages/domain/swing/phaseDetection.ts:151-225
  │      (Y-based top detection, velocity magnitude — no X-direction dependency)
  │
  │    calculateTempo(phases) → SwingTempo | null                           — NEUTRAL
  │      packages/domain/swing/tempoAnalysis.ts:54-98
  │      (timestamp-based, no spatial dependency)
  │
  │    scoreSwing({angles, tempo}) → ScoringResult                          — DIRECTIONAL
  │      packages/domain/swing/scoring.ts:16-41
  │      (hardcoded left=lead ideals → after canonical transform, correct)
  │
  └─ Returns AnalysisResult { score, honeyBoom, angles, tempo, phases }

lib/swingMotionStore.ts: setCurrentSwingAnalysis(result)                    — NEUTRAL (stores only)
lib/swingMotionStore.ts: setCurrentSwingMotion(data)                        — NEUTRAL (stores raw frames)

lib/persistSwing.ts: persistSwing(frames, analysis, classification)         — NEUTRAL
  (writes to DB; swing_debug needs handedness field added — Section 8)

app/analysis/result.tsx: ResultScreen                                       — DIRECTIONAL (display)
  ├─ computeFocus(angles) → FocusData                                       — NEUTRAL (after canonical)
  │    lib/swingMotionStore.ts:120-141
  │    (reads canonical angles; remapKey removed since canonical handles it)
  │
  ├─ VisualCoachCard(landmarks, angles, isLeftHanded)                       — DIRECTIONAL (display)
  │    components/VisualCoachCard.tsx:148-249
  │    (skeleton overlay uses REAL landmarks; segment highlight needs L/R swap for lefties)
  │
  └─ Score + tempo display                                                  — NEUTRAL
```

---

## 3. Directional Assumptions Found

### 3.1 — angles.ts: Joint-to-variable mapping

**File:** `packages/domain/swing/angles.ts:51-62`
```typescript
const ls = getJoint(frame, "leftShoulder");
const rs = getJoint(frame, "rightShoulder");
const le = getJoint(frame, "leftElbow");
const re = getJoint(frame, "rightElbow");
const lw = getJoint(frame, "leftWrist");
const rw = getJoint(frame, "rightWrist");
const lh = getJoint(frame, "leftHip");
const rh = getJoint(frame, "rightHip");
const lk = getJoint(frame, "leftKnee");
const rk = getJoint(frame, "rightKnee");
const la = getJoint(frame, "leftAnkle");
const ra = getJoint(frame, "rightAnkle");
```
**Assumes:** Anatomical left = lead side, anatomical right = trail side.
**Classification:** TRANSFORM-FIXED. After bilateral joint swap, `frame.joints.leftShoulder` contains the lead-side joint for both handedness.

### 3.2 — angles.ts: Elbow and knee angle outputs

**File:** `packages/domain/swing/angles.ts:71-89`
```typescript
let leftElbowAngle: number | null = null;
if (isGood(ls) && isGood(le) && isGood(lw)) {
  leftElbowAngle = angleBetween(ls!, le!, lw!);
}
// ... same for rightElbowAngle, leftKneeAngle, rightKneeAngle
```
**Assumes:** `leftElbowAngle` = lead arm angle, `rightElbowAngle` = trail arm angle.
**Classification:** TRANSFORM-FIXED. `angleBetween()` computes unsigned angle (0-180) from three points — no directional sign. After joint swap, the left-slot contains the lead-side joints, so `leftElbowAngle` = lead arm angle for both handedness.

### 3.3 — angles.ts: Shoulder tilt

**File:** `packages/domain/swing/angles.ts:96-101`
```typescript
const dx = rs!.x - ls!.x;
const dy = rs!.y - ls!.y;
shoulderTilt = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
```
**Assumes:** `dx = rightShoulder.x - leftShoulder.x` has a consistent sign convention for right-handed golfers.
**Classification:** TRANSFORM-FIXED. Verified numerically: for a lefty with original `ls=(0.3, 0.4)` and `rs=(0.7, 0.5)`:
- After X-mirror: `ls_m=(0.7, 0.4)`, `rs_m=(0.3, 0.5)`
- After bilateral swap: `ls_c=rs_m=(0.3, 0.5)`, `rs_c=ls_m=(0.7, 0.4)`
- `dx_c = 0.7 - 0.3 = 0.4`, `dy_c = 0.4 - 0.5 = -0.1`
- Identical to a right-hander with the same pose geometry. No additional sign flip needed.

### 3.4 — angles.ts: Hip rotation

**File:** `packages/domain/swing/angles.ts:91-94`
```typescript
hipRotation = Math.round(Math.abs(rh!.x - lh!.x) * 100);
```
**Assumes:** Nothing directional — uses `Math.abs()`.
**Classification:** TRANSFORM-FIXED. Absolute distance is preserved under mirror + swap.

### 3.5 — analysisPipeline.ts: Trail point construction

**File:** `packages/domain/swing/analysisPipeline.ts:18-28`
```typescript
const lw = frame.joints.leftWrist;
const rw = frame.joints.rightWrist;
// ...
x: (lw.x + rw.x) / 2,
y: (lw.y + rw.y) / 2,
```
**Assumes:** Midpoint of both wrists represents swing path.
**Classification:** TRANSFORM-FIXED. After mirror + swap, the midpoint X is mirrored (`1.0 - original_midpoint_x`), and Y is unchanged. Phase detection uses Y for top-of-swing and velocity magnitude — both are unaffected by X reversal.

### 3.6 — scoring.ts: Hardcoded ideal angles

**File:** `packages/domain/swing/scoring.ts:22-30`
```typescript
scoreAngle(angles.leftElbowAngle, 165, 40),   // left = lead arm ideal
scoreAngle(angles.rightElbowAngle, 165, 40),   // right = trail arm ideal
scoreAngle(angles.leftKneeAngle, 155, 35),     // left = lead knee ideal
scoreAngle(angles.rightKneeAngle, 155, 35),     // right = trail knee ideal
```
**Assumes:** `leftElbowAngle` is the lead arm, `rightElbowAngle` is the trail arm.
**Classification:** TRANSFORM-FIXED. After canonical transform, `angles.leftElbowAngle` = lead arm for both handedness, so these ideals apply correctly.

**Note:** Currently both left and right elbows share the same ideal (165) and both knees share the same ideal (155). If lead/trail ideal angles ever diverge in the future, the canonical transform still handles this correctly because the engine always sees "left = lead" data.

### 3.7 — swingMotionStore.ts: FOCUS_METRICS labels

**File:** `lib/swingMotionStore.ts:77-88`
```typescript
leftElbowAngle: { ideal: 165, tolerance: 40, label: 'Lead arm', ... },
rightElbowAngle: { ideal: 165, tolerance: 40, label: 'Trail arm', ... },
leftKneeAngle: { ideal: 155, tolerance: 35, label: 'Lead knee', ... },
rightKneeAngle: { ideal: 155, tolerance: 35, label: 'Trail knee', ... },
```
**Assumes:** `leftElbowAngle` = lead arm.
**Classification:** TRANSFORM-FIXED. After canonical transform, this mapping is correct. The labels "Lead arm" / "Trail arm" are functional, not anatomical — correct for all users.

### 3.8 — swingMotionStore.ts: shoulderTilt coaching cue

**File:** `lib/swingMotionStore.ts:101-106`
```typescript
shoulderTilt: {
  ideal: 0, tolerance: 25, label: 'Shoulders',
  cue: (v) => v > 0
    ? 'Your lead shoulder is too high at address — try to level them'
    : 'Your trail shoulder is too high at address — try to level them',
},
```
**Assumes:** Positive `shoulderTilt` = lead shoulder high (right-handed convention).
**Classification:** TRANSFORM-FIXED. After canonical transform, the sign convention is normalized to right-handed, so `v > 0` = lead shoulder high for both handedness.

### 3.9 — swingMotionStore.ts: remapKey function

**File:** `lib/swingMotionStore.ts:109-118`
```typescript
function remapKey(key: MetricKey, isLeftHanded: boolean): MetricKey {
  if (!isLeftHanded) return key;
  switch (key) {
    case 'leftElbowAngle': return 'rightElbowAngle';
    case 'rightElbowAngle': return 'leftElbowAngle';
    case 'leftKneeAngle': return 'rightKneeAngle';
    case 'rightKneeAngle': return 'leftKneeAngle';
    default: return key;
  }
}
```
**Assumes:** Analysis output uses raw anatomical mapping (no canonical transform).
**Classification:** MANUAL-FIX. With canonical transform active, this remapping would **double-swap** lefty angles, reading the trail arm value for the "Lead arm" label. Must remove `isLeftHanded` from the `computeFocus()` call (pass `false` or remove the parameter), since canonical transform already normalizes the data. [REPO-VERIFIED]

### 3.10 — swingMotionStore.ts: computeFocus call in result.tsx

**File:** `app/analysis/result.tsx:133`
```typescript
const focus = computeFocus(angles, isLeftHanded);
```
**Assumes:** Angles are raw (non-canonical) and need remapping.
**Classification:** MANUAL-FIX. After canonical transform, angles are already canonical. Change to `computeFocus(angles)` — the default `isLeftHanded = false` in the function signature handles it. [REPO-VERIFIED]

### 3.11 — VisualCoachCard.tsx: remapKey function

**File:** `components/VisualCoachCard.tsx:128-137`
```typescript
function remapKey(key: MetricKey, isLeftHanded: boolean): MetricKey { ... }
```
Same logic as swingMotionStore.ts version.
**Classification:** MANUAL-FIX. Same issue as Section 3.9 — would double-swap. The angle VALUE lookup must stop using remapKey. However, the **segment highlighting** still needs left/right swap for lefty display (see Section 3.12).

### 3.12 — VisualCoachCard.tsx: Segment highlight joint names

**File:** `components/VisualCoachCard.tsx:85-124`
```typescript
leftElbowAngle: {
  segments: [['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist']],
  ...
},
rightElbowAngle: {
  segments: [['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist']],
  ...
},
```
**Assumes:** The skeleton overlay shows data in the same left/right convention as the metric key name.
**Classification:** LABEL-MAP. The skeleton overlay displays the REAL captured pose (protected surface — never mirrored). For a left-handed golfer, the canonical `leftElbowAngle` (lead arm) corresponds to the golfer's anatomical RIGHT arm in the real skeleton. The highlight segments must point to right-side joints for lefties. Requires a joint-name swap function on the segment arrays when `isLeftHanded=true`.

### 3.13 — VisualCoachCard.tsx: METRICS labels and cues

**File:** `components/VisualCoachCard.tsx:76-124`
Labels: "Lead arm", "Trail arm", "Lead knee", "Trail knee", "Spine tilt", "Shoulders"
Cues: "Your lead arm is too bent...", "Your trail elbow is too bent...", etc.
**Classification:** TRANSFORM-FIXED. All labels and cues use functional terminology (lead/trail), not anatomical (left/right). Correct for both handedness after canonical transform.

---

## 4. Canonical Transform Specification

### Insertion point

**New pure function:** `toCanonicalFrame(frame: PoseFrame, isLeftHanded: boolean): PoseFrame`
**New convenience wrapper:** `toCanonicalSequence(sequence: PoseSequence, isLeftHanded: boolean): PoseSequence`

**Location:** New file `packages/domain/swing/canonicalTransform.ts`

**Called from:** `packages/domain/swing/analysisPipeline.ts`, at the top of `analyzePoseSequence()`. The function signature changes to:
```typescript
export function analyzePoseSequence(
  sequence: PoseSequence,
  isLeftHanded = false,
): AnalysisResult
```
Line 34 in `analysisPipeline.ts`, first line of the function body adds:
```typescript
const canonical = toCanonicalSequence(sequence, isLeftHanded);
```
All subsequent references to `sequence` in the function body change to `canonical`.

### Input/output types

- Input: `PoseFrame` (unchanged type)
- Output: `PoseFrame` (unchanged type — drop-in replacement)
- When `isLeftHanded=false`: returns input unchanged (identity)

### Mirror operation

For each joint in `frame.joints`:
```
x_canonical = 1.0 - x_original
y_canonical = y_original       (unchanged)
z_canonical = z_original       (unchanged, if present)
confidence_canonical = confidence_original (unchanged)
```

### Bilateral joint swap list

Only pairs referenced by the analysis engine (verified in Section 3.1):

| Pair # | Joint A | Joint B | Used in |
|--------|---------|---------|---------|
| 1 | `leftShoulder` | `rightShoulder` | angles.ts:51-52, 65-66, 96-98 |
| 2 | `leftElbow` | `rightElbow` | angles.ts:53-54, 72-78 |
| 3 | `leftWrist` | `rightWrist` | angles.ts:55-56, analysisPipeline.ts:19-20 |
| 4 | `leftHip` | `rightHip` | angles.ts:57-58, 65-67, 82-88, 91-93 |
| 5 | `leftKnee` | `rightKnee` | angles.ts:59-60, 82-88 |
| 6 | `leftAnkle` | `rightAnkle` | angles.ts:61-62, 82-88 |

Implementation should swap ALL bilateral pairs (including face, hands, feet — 15 pairs total) for correctness and future-proofing, but the 6 pairs above are the ones the analysis engine reads.

Full bilateral pair list from `PoseTypes.ts`:
```
leftEyeInner ↔ rightEyeInner     leftEye ↔ rightEye
leftEyeOuter ↔ rightEyeOuter     leftEar ↔ rightEar
mouthLeft ↔ mouthRight            leftShoulder ↔ rightShoulder
leftElbow ↔ rightElbow            leftWrist ↔ rightWrist
leftPinky ↔ rightPinky            leftIndex ↔ rightIndex
leftThumb ↔ rightThumb            leftHip ↔ rightHip
leftKnee ↔ rightKnee              leftAnkle ↔ rightAnkle
leftHeel ↔ rightHeel              leftFootIndex ↔ rightFootIndex
```
`nose` is unpaired — no swap.

### Angle/rotation sign flips needed beyond X-mirror

**None.** Evidence:

1. `angleBetween()` (angles.ts:13-26) computes unsigned angle via `Math.acos(cosAngle)` — range [0, 180]. Pure magnitude, no sign dependency. [REPO-VERIFIED]
2. `angleToVertical()` (angles.ts:32-38) uses `Math.abs(dy)` — sign-independent. [REPO-VERIFIED]
3. `hipRotation` uses `Math.abs(rh.x - lh.x)` — sign-independent. [REPO-VERIFIED]
4. `shoulderTilt` uses `atan2(dy, dx)` — verified numerically in Section 3.3 that mirror+swap produces identical result to a right-hander with the same pose. [REPO-VERIFIED]
5. Phase detection velocity uses `Math.sqrt(dx*dx + dy*dy)` — magnitude only. [REPO-VERIFIED]

### Properties

- Pure function, no side effects, no state
- Returns a new `PoseFrame` object — does not mutate the input
- `frameWidth` and `frameHeight` are preserved unchanged

---

## 5. Label Mapping Specification

### Where directional strings originate

Coaching labels and cues originate in two locations:
1. `lib/swingMotionStore.ts:70-107` — `FOCUS_METRICS` (used by `computeFocus()` for "Today's Focus" on home screen)
2. `components/VisualCoachCard.tsx:76-124` — `METRICS` (used for result screen coaching card)

### Strings that reference direction

| String | Source | Handedness-sensitive? |
|--------|--------|-----------------------|
| "Lead arm" | label | No — functional term, correct for both |
| "Trail arm" | label | No — functional term, correct for both |
| "Lead knee" | label | No — functional term, correct for both |
| "Trail knee" | label | No — functional term, correct for both |
| "Spine tilt" | label | No — anatomically neutral |
| "Shoulders" | label | No — anatomically neutral |
| "Your lead arm is too bent..." | cue | No — references functional "lead" side |
| "Your trail elbow is too bent..." | cue | No — references functional "trail" side |
| "Your lead shoulder is too high..." | cue | No — after canonical transform, sign is normalized |
| "Your trail shoulder is too high..." | cue | No — after canonical transform, sign is normalized |

### Verdict: No label remapping function needed [MUST SHIP]

All existing labels use functional terminology ("lead"/"trail"), not anatomical ("left"/"right"). After the canonical transform normalizes the pose data, every label and cue is correct for both handedness. No translation layer is required.

**FUTURE ONLY:** If user research shows junior golfers (ages 8-17) don't understand "lead"/"trail", a future enhancement could add parenthetical hints like "Lead arm (your left arm)" / "Lead arm (your right arm)" based on handedness. This is not needed for v1 of lefty support.

### What DOES need mapping: VisualCoachCard segment highlights

Per Section 3.12, the skeleton highlight segments use anatomical joint names that must be swapped for lefty display. This is a **display-time** mapping in the VisualCoachCard component, not a label mapping.

Implementation: When building the `highlightedSegments` set (VisualCoachCard.tsx:184-189), swap "left"↔"right" in segment joint names when `isLeftHanded=true`:

```typescript
function remapSegmentJoint(name: string, isLeftHanded: boolean): string {
  if (!isLeftHanded) return name;
  if (name.startsWith('left')) return 'right' + name.slice(4);
  if (name.startsWith('right')) return 'left' + name.slice(5);
  return name;
}
```

Apply to each segment pair when building `highlightedSegments`:
```typescript
for (const [a, b] of METRICS[worst.key].segments) {
  const ra = remapSegmentJoint(a, isLeftHanded);
  const rb = remapSegmentJoint(b, isLeftHanded);
  highlightedSegments.add(`${ra}-${rb}`);
}
```

---

## 6. Handedness Storage

### Existing file

**File:** `lib/handedness.ts` (8 lines)
**Current exports:** `getIsLeftHanded()` — async getter only, no setter.
**AsyncStorage key:** `'honeyswing:isLeftHanded'`
**Current value format:** String `'true'` or `'false'` (set as `String(boolean)` in `onboarding.tsx:60`).
**Default:** `false` (right-handed) — when key is absent, `getIsLeftHanded()` returns `false`.

### Pattern to replicate

From `lib/coachCode.ts:1-27` [REPO-VERIFIED]:
```typescript
import AsyncStorage from '@react-native-async-storage/async-storage';
const KEY = 'honeyswing:coachCode';
export async function getCoachCode(): Promise<string | null> {
  return AsyncStorage.getItem(KEY);
}
export async function setCoachCode(code: string): Promise<void> {
  await AsyncStorage.setItem(KEY, code.toLowerCase().trim());
}
export async function clearCoachCode(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}
```

### Changes to lib/handedness.ts

Add `setIsLeftHanded(value: boolean)` export. Keep existing `getIsLeftHanded()` unchanged.

```typescript
export async function setIsLeftHanded(value: boolean): Promise<void> {
  await AsyncStorage.setItem(KEY, String(value));
}
```

No `clearIsLeftHanded()` needed — the delete-account flow in `settings.tsx:57-63` already clears via `AsyncStorage.multiRemove(['honeyswing:isLeftHanded', ...])`.

**Valid values:** `'true'` | `'false'` (string in AsyncStorage, boolean in API)
**Default:** `false` (right-handed)
**Exports after change:** `getIsLeftHanded()`, `setIsLeftHanded(value)`

---

## 7. UX Flow

### Selection modal: NOT NEEDED [MUST SHIP decision]

Handedness is already collected during onboarding (`app/onboarding.tsx:117-148`). There is no need for a first-launch modal since every user goes through onboarding. The only missing piece is the ability to change handedness post-onboarding, which the Settings toggle addresses.

### Settings toggle

**Location in settings.tsx:** Add a new "Handedness" section between the Coach section (line 104) and the Delete Account section (line 106). This mirrors the existing `coachSection` pattern.

**UI pattern:** Match the onboarding toggle exactly (`app/onboarding.tsx:117-148`) [REPO-VERIFIED]:
- Section label: `<Text style={styles.coachLabel}>Dominant hand</Text>` (reuse `coachLabel` style)
- Two-button `toggleRow` (flexDirection: 'row', gap: 10)
- Each button: `TouchableOpacity` with `flex: 1`, `#1A1A1C` background, `borderRadius: 12`, `paddingVertical: 14`, `alignItems: 'center'`, `borderWidth: 2`
- Selected state: `borderColor: '#F5A623'`, text color `#fff`
- Unselected state: `borderColor: 'transparent'`, text color `#999`
- Options: "Right-handed" and "Left-handed"

**Data flow:**
1. On screen focus (`useFocusEffect`), read `getIsLeftHanded()` into local state
2. On toggle press, call `setIsLeftHanded(newValue)` and update local state
3. No confirmation dialog — instant save (matches coach code pattern)

### What happens when handedness changes mid-use

- Stored swings in the database are NOT reanalyzed. They retain their original analysis.
- The `swing_debug.handedness` field (Section 8) records what handedness was active at capture time, preserving audit trail.
- `todaysFocus` in AsyncStorage (`honeyswing:todaysFocus`) may be stale after a toggle. It will be overwritten on the next swing. No explicit invalidation needed — the focus label says "Lead arm" (still correct) and the score is based on the previous swing (acceptable staleness).
- The next swing capture will use the new handedness setting.

---

## 8. swing_debug Addition

### Current shape

**File:** `lib/persistSwing.ts:82-86` [REPO-VERIFIED]
```typescript
swing_debug: {
  app_version: APP_VERSION,                           // string, e.g. "1.6"
  capture_validity: classification?.validity ?? 'unknown',  // string
  classification_reason: classification?.reason ?? null,    // string | null
},
```

### Addition

Add `handedness` field:
```typescript
swing_debug: {
  app_version: APP_VERSION,
  capture_validity: classification?.validity ?? 'unknown',
  classification_reason: classification?.reason ?? null,
  handedness: isLeftHanded ? 'left' : 'right',
},
```

### Where to add

**File:** `lib/persistSwing.ts`
**Insertion point:** Inside the `swing_debug` object literal at line 82-86.
**Data source:** `persistSwing()` must read handedness. Add `getIsLeftHanded()` call at the top of the function (after line 60, alongside `getCoachCode()`):
```typescript
const isLeftHanded = await getIsLeftHanded();
```
Import `getIsLeftHanded` from `'./handedness'`.

**swing_debug is JSONB, additive only** — adding a new key requires no schema change. [REPO-VERIFIED]

---

## 9. Protected Surfaces

### FILES THAT WILL CHANGE

| File | Change | Why |
|------|--------|-----|
| `packages/domain/swing/analysisPipeline.ts` | Add `isLeftHanded` param, call canonical transform | Entry point for analysis; transform must run before angle/phase/tempo calculations |
| `packages/domain/swing/canonicalTransform.ts` | **NEW FILE** — pure transform function | Houses `toCanonicalFrame` and `toCanonicalSequence` |
| `lib/handedness.ts` | Add `setIsLeftHanded()` export | Settings screen needs a setter |
| `lib/persistSwing.ts` | Read handedness, add to `swing_debug` | Audit trail for handedness at capture time |
| `lib/swingMotionStore.ts` | Remove `isLeftHanded` from `computeFocus()` calls | Canonical transform makes remapKey unnecessary |
| `components/VisualCoachCard.tsx` | Replace angle remapKey with segment remapKey | Highlight correct skeleton segments for lefties |
| `app/(tabs)/record.tsx` | Pass `isLeftHanded` to `analyzePoseSequence()` | Caller must provide handedness |
| `app/analysis/result.tsx` | Pass `isLeftHanded` to `analyzePoseSequence()`, stop passing to `computeFocus()` | Two call sites for analysis; focus no longer needs remap |
| `app/settings.tsx` | Add handedness toggle section | User can change handedness post-onboarding |

### FILES THAT MUST NOT CHANGE

| File | Reason |
|------|--------|
| `supabase/functions/classify-grip/index.ts` | Protected: Grip pipeline |
| `lib/classifyGrip.ts` | Protected: Grip pipeline (already handles handedness correctly) |
| `lib/gripStore.ts` | Protected: Grip pipeline |
| `app/grip/*` | Protected: Grip capture/result |
| `app/_layout.tsx` | Protected: Auth flow |
| `ios/HoneyVisionCameraPosePlugin.swift` | Protected: Camera configuration / native module |
| `components/SkeletonOverlay.tsx` | Protected: Skeleton overlay rendering (always shows real pose) |
| `app/onboarding.tsx` | No changes needed — already handles handedness correctly |
| `packages/pose/PoseTypes.ts` | No type changes needed — PoseFrame type is unchanged |
| Supabase schema | Protected: No new columns |

---

## 10. Test Gates

### Gate 1: Right-handed regression

**What:** Run a right-handed swing capture end-to-end.
**Pass:** Score, coaching cue, tempo, and skeleton highlight match pre-change behavior exactly. `swing_debug.handedness` = `'right'`.
**Fail action:** Diff the canonical transform path for `isLeftHanded=false` — must be identity (no-op). Check that `toCanonicalFrame` returns the input unchanged.

### Gate 2: Left-handed analysis produces correct directional output

**What:** Set handedness to left, capture a swing.
**Pass:** `angles.leftElbowAngle` in the AnalysisResult corresponds to the golfer's anatomical right arm (lead arm for lefty). Verify by comparing the raw frame's `rightElbow` joint data with the canonical frame's `leftElbow` joint data — they should match (with mirrored X). Score is plausible (not systematically lower than right-handed captures of similar quality).
**Fail action:** Check bilateral swap logic — are joint NAMES swapped, not just X coordinates? Check that the swap table covers all 6 required pairs.

### Gate 3: Handedness persists across app restart

**What:** Set handedness to left in Settings, force-quit app, relaunch, check Settings and capture a swing.
**Pass:** Settings shows "Left-handed" selected. Swing analysis uses `isLeftHanded=true`. `swing_debug.handedness` = `'left'`.
**Fail action:** Check `AsyncStorage.setItem` call in `setIsLeftHanded()`. Verify key matches `'honeyswing:isLeftHanded'`.

### Gate 4: Settings toggle works and takes effect on next swing

**What:** Toggle from right to left in Settings, record a swing, check result.
**Pass:** No app restart needed. Result screen coaching cue references correct functional side. `swing_debug.handedness` = `'left'`.
**Fail action:** Check that `record.tsx` reads `isLeftHanded` fresh at capture time (not cached from app start).

### Gate 5: Phase detection fires correctly for mirrored data

**What:** Record a left-handed swing with clear phases (full swing from address to finish).
**Pass:** `phases` array contains 6 entries with `source: 'heuristic'`. Tempo ratio is plausible (1.5-5.0). Phase timestamps are monotonically increasing.
**Fail action:** Check that `buildTrailPoints` receives canonical frames (not raw). Log trail point X values — they should be mirrored (wrist midpoint should be on the opposite side of 0.5 compared to the raw data).

### Gate 6: No directional coaching cues reference wrong side

**What:** With left-handed setting, examine every coaching cue that appears in the result screen.
**Pass:** Cues say "lead arm", "trail arm", etc. — never "left arm" or "right arm". Skeleton highlight appears on the correct arm/leg in the real (non-mirrored) skeleton overlay.
**Fail action:** Check VisualCoachCard `remapSegmentJoint()` — are segment joint names being swapped? Check that the angle VALUE lookup no longer uses the old `remapKey()`.

---

## 11. Build Order

### Step 1: Canonical transform function [JS-ONLY]
**Produces:** `packages/domain/swing/canonicalTransform.ts` with `toCanonicalFrame()` and `toCanonicalSequence()`
**Depends on:** Nothing
**Acceptance:** Unit-testable: given a PoseFrame with known joint positions and `isLeftHanded=true`, output has mirrored X and swapped joint names. With `isLeftHanded=false`, output === input.

### Step 2: Wire transform into analysis pipeline [JS-ONLY]
**Produces:** Updated `analysisPipeline.ts` with `isLeftHanded` param, canonical transform at top
**Depends on:** Step 1
**Acceptance:** `analyzePoseSequence(sequence, false)` produces identical output to current behavior. `analyzePoseSequence(sequence, true)` produces canonical angles (verify `leftElbowAngle` reads from the original right-side joint).

### Step 3: Add setIsLeftHanded to handedness.ts [JS-ONLY]
**Produces:** Updated `lib/handedness.ts` with `setIsLeftHanded(value)` export
**Depends on:** Nothing
**Acceptance:** Call `setIsLeftHanded(true)`, then `getIsLeftHanded()` returns `true`. Call `setIsLeftHanded(false)`, returns `false`.

### Step 4: Update record.tsx to pass isLeftHanded [JS-ONLY]
**Produces:** Updated `app/(tabs)/record.tsx` — reads handedness, passes to `analyzePoseSequence()`
**Depends on:** Steps 2, 3
**Acceptance:** Compiles without errors. Right-handed capture produces same result as before.

### Step 5: Update result.tsx — remove computeFocus remap, pass isLeftHanded to fallback analysis [JS-ONLY]
**Produces:** Updated `app/analysis/result.tsx` — `computeFocus(angles)` without isLeftHanded, fallback `analyzePoseSequence(sequence, isLeftHanded)` with it
**Depends on:** Steps 2, 3
**Acceptance:** Compiles. Right-handed flow unchanged.

### Step 6: Update VisualCoachCard — replace angle remap with segment remap [JS-ONLY]
**Produces:** Updated `components/VisualCoachCard.tsx` — angle lookup uses key directly (no remap), segment highlighting uses `remapSegmentJoint()`
**Depends on:** Step 2 (canonical angles)
**Acceptance:** Right-handed display unchanged. Left-handed display highlights correct arm/leg segments.

### Step 7: Update persistSwing.ts — add handedness to swing_debug [JS-ONLY]
**Produces:** Updated `lib/persistSwing.ts` with `handedness` field in `swing_debug`
**Depends on:** Step 3
**Acceptance:** Persisted swing has `swing_debug.handedness = 'right'` or `'left'`.

### Step 8: Add handedness toggle to Settings screen [JS-ONLY]
**Produces:** Updated `app/settings.tsx` with "Dominant hand" toggle section
**Depends on:** Step 3
**Acceptance:** Toggle renders, reads current value on focus, saves on press.

### Step 9: End-to-end device test — right-handed regression [DEVICE-TEST]
**Produces:** Verified right-handed flow is unchanged
**Depends on:** Steps 1-8
**Acceptance:** Test Gate 1 passes.

### Step 10: End-to-end device test — left-handed flow [DEVICE-TEST]
**Produces:** Verified left-handed analysis, scoring, coaching, persistence
**Depends on:** Steps 1-8
**Acceptance:** Test Gates 2-6 pass.

---

## 12. Ship Gates

### Gate 1: Minimum shippable (MUST SHIP)

**Included:**
- Canonical transform (Steps 1-2)
- Handedness setter (Step 3)
- Pipeline wiring — record.tsx + result.tsx (Steps 4-5)
- VisualCoachCard segment remap (Step 6)
- swing_debug handedness field (Step 7)
- Settings toggle (Step 8)

**Deferred:**
- Supabase `profiles.is_left_handed` sync on toggle (currently only set during onboarding; db update can be added later without blocking the feature)
- Anatomical label hints ("Lead arm (your right arm)") — FUTURE ONLY
- Analytics dashboard for left vs right population — FUTURE ONLY

### Gate 2: Full feature (BONUS)

**Added on top of Gate 1:**
- Sync `profiles.is_left_handed` to Supabase when toggled in Settings (upsert to `profiles` table)
- Invalidate `todaysFocus` AsyncStorage when handedness changes (clear stale focus data)

---

## 13. STOP Conditions

### Condition 1: Canonical transform changes right-handed scores

**Symptom:** Right-handed regression test (Gate 1) fails — scores differ from pre-change baseline.
**What it means:** The `isLeftHanded=false` code path is not identity. The transform is being applied when it shouldn't be, or a downstream consumer changed behavior.
**Fallback:** Revert canonical transform changes. Add explicit `if (!isLeftHanded) return sequence;` guard as first line if missing.

### Condition 2: Left-handed scores are systematically 20+ points lower than right-handed for similar swings

**Symptom:** Left-handed captures consistently score much lower despite good form.
**What it means:** The bilateral swap is incomplete (missing a joint pair), or the X-mirror is not applied to all joints, or the shoulderTilt sign is wrong after transform.
**Fallback:** Log canonical frame joints and compare to raw frame. Check that every joint in the canonical frame has `x = 1.0 - original_x` and names are swapped. Focus on the 6 required pairs in Section 4.

### Condition 3: VisualCoachCard highlights wrong body segments for lefties

**Symptom:** "Lead arm" label appears but the LEFT arm is highlighted on a left-handed golfer's skeleton.
**What it means:** `remapSegmentJoint()` is not being called, or the old `remapKey()` is still active on the angle value lookup (double-swap issue).
**Fallback:** Check that the old `remapKey()` call is removed from the scoring loop (VisualCoachCard.tsx:170). Verify `remapSegmentJoint()` is applied in the highlight set builder (line ~184).

### Condition 4: Phase detection returns empty for lefty captures

**Symptom:** `phases` array is empty or all `source: 'fallback'` for left-handed swings that have clear motion.
**What it means:** Trail points have unexpected X range after mirroring, causing the heuristic search windows to miss.
**Fallback:** This is [DEVICE-TEST REQUIRED]. If trail X values are outside [0, 1] after mirroring, the X-mirror formula is wrong. Check that frame.joints values are normalized 0-1 before transform.

---

## 14. Risks

### Blocking risk: Canonical transform silently breaks right-handed regression

**Classification:** CODE
**Why it's the most likely failure:** The transform touches every frame of every swing. A bug in the identity path (`isLeftHanded=false`) or an accidental mutation of the input frame would affect ALL users, not just lefties.

**Concrete first test:** Before any device testing, write an inline assertion in `analyzePoseSequence()`:
```typescript
if (!isLeftHanded) {
  // In dev: verify canonical is identity
  const firstFrame = sequence.frames[0];
  const canonicalFirst = canonical.frames[0];
  console.assert(
    firstFrame.joints.leftShoulder?.x === canonicalFirst.joints.leftShoulder?.x,
    'Canonical transform must be identity for right-handed'
  );
}
```
Run a right-handed capture. If the assertion fires, the transform has a bug. Remove the assertion before shipping.

---

## 15. Open Questions

### Q1: MediaPipe landmark left/right convention when phone is flipped

**Question:** MediaPipe Pose Landmarker outputs landmarks with "left" meaning the subject's anatomical left (not camera left). This is the standard. But does the native plugin (`HoneyVisionCameraPosePlugin.swift`) or the CIContext orientation handling alter this mapping? If the user holds the phone upside down or in landscape, are left/right landmarks still anatomically correct?

**Status:** [DEVICE-TEST REQUIRED]
**Test:** With known right-handed setup: verify that `leftShoulder.x < rightShoulder.x` when the golfer faces the camera with their left side toward the right edge of the screen. If this invariant holds for the standard recording orientation, the canonical transform is correct. If not, the X-mirror formula may need adjustment.

### Q2: Left-handed golfer camera orientation

**Question:** Right-handed golfers typically stand with their left side toward the camera (so the swing goes left-to-right in screen space). Left-handed golfers stand with their right side toward the camera (swing goes right-to-left). Does the app's capture tips or onboarding instruct on camera placement? If a lefty stands in the "wrong" orientation, both the raw pose AND the canonical transform produce incorrect results.

**Status:** [DEVICE-TEST REQUIRED]
**Test:** Record a left-handed swing from the standard camera position. Verify that phase detection finds a valid top-of-swing and impact. If the wrist trail moves in a pattern the heuristics can't parse, we may need capture-orientation guidance for lefties.
