# HoneySwing Structure Audit — Debugging Speed & Fault Isolation

---

## A. FILES READ

**Fully read:**
1. `app/(tabs)/record.tsx` (815 lines)
2. `app/analysis/result.tsx` (689 lines)
3. `lib/persistSwing.ts` (108 lines)
4. `lib/swingMotionStore.ts` (152 lines)
5. `app/_layout.tsx` (167 lines)
6. `app/grip/capture.tsx` (595 lines)
7. `components/VisualCoachCard.tsx` (320 lines)

**Search queries executed:**
- `persistSwing` — 17 files (2 in-scope: record.tsx, persistSwing.ts)
- `setCurrentSwingMotion|setCurrentSwingAnalysis|setCurrentSwingVideoUri` — only record.tsx writes; result.tsx reads
- `checkSwingLimit` — record.tsx (2 call sites), result.tsx (1), swingLimit.ts (definition), tipFrequency.ts (1)
- `processSwingTips` — result.tsx, tipFrequency.ts, positiveReinforcement.ts
- `sessionAccumulator` — persistSwing.ts, result.tsx, _layout.tsx, sessionAccumulator.ts
- `positiveReinforcementEngine` — persistSwing.ts, result.tsx, _layout.tsx, positiveReinforcement.ts
- `router.push|back|replace` — record.tsx (2), result.tsx (4), _layout.tsx (4), grip/capture.tsx (3), paywall.tsx (3), settings.tsx (4)
- `useFocusEffect` — record.tsx only
- `startRecording|stopRecording` — record.tsx only

---

## B. RESPONSIBILITY MAP

### `app/(tabs)/record.tsx`
**Owns:**
- Camera lifecycle (permissions, device selection, format, activation)
- Frame processor pipeline (worklet → appendPoseFrame → motionFramesRef)
- Capture state machine (idle → countdown → capturing → complete/error/weak)
- Live skeleton overlay delegation
- Camera guidance (EMA shoulder separation)
- Video recording start/stop
- Pinch-to-zoom gesture
- Countdown timer
- Framing tips display
- Paywall gate (initial + on-focus)

**Should NOT own but currently does:**
- **Analysis execution** (`analyzePoseSequence` at line 260) — business logic invoked inline
- **Persistence orchestration** (`persistSwing` at line 272, `uploadSwingVideo` at line 322) — DB write + S3 upload initiated from UI component
- **Navigation timing gate** (`tryNavigate` at lines 133-145) — coordinates analysis readiness + video readiness + capturePhase + navigated guard
- **Store writes** (`setCurrentSwingMotion`, `setCurrentSwingAnalysis`, `setCurrentSwingVideoUri`) — direct module-global mutation from UI
- **Quality gating** (`isGoodFrame`, `MIN_GOOD_FRAMES` at lines 214-223) — frame quality logic inline in UI
- **Capture classification** (`classifyCapture` at line 271) — validity classification done here

**Tightly coupled to:**
- `swingMotionStore` (write path) — 5 direct calls
- `persistSwing` (fire-and-forget promise chain)
- `uploadSwingVideo` (chained off persistSwing promise)
- `swingLimit/checkSwingLimit` (2 independent call sites with different error handling)
- `captureValidity/classifyCapture`
- `cameraGuidance` (3 functions imported)
- `useTiltCapture` hook
- Navigation timing (video callback + analysis completion + safety timeout)

---

### `app/analysis/result.tsx`
**Owns:**
- Results display (score, tempo, video playback, coaching)
- Video player setup + speed control
- Coaching tip pipeline (buildRawTips → processSwingTips → display)
- Positive reinforcement engine invocation
- Session accumulator feeding
- Visual coach card delegation
- Swing art card display
- "Record Again" / sign-in CTA

**Should NOT own but currently does:**
- **Tip text/mapping constants** (lines 76-162, ~90 lines) — `METRIC_KEY_MAP`, `COACHING_TEXT`, `buildRawTips()` are domain logic embedded in UI
- **Fallback re-analysis** (lines 219-222) — re-runs `analyzePoseSequence` if storedAnalysis is null
- **Capture re-classification** (lines 200-203) — re-runs `classifyCapture` (already done in record.tsx)
- **Focus persistence** (lines 300-303) — `computeFocus` + `saveFocus` is a side effect triggered from display screen
- **Session accumulator mutation** (lines 277-279) — `sessionAccumulator.addSwing()` inside a `useMemo` (side effect in memo)
- **Swing limit re-check** (lines 191-197) — third call site for `checkSwingLimit`

**Tightly coupled to:**
- `swingMotionStore` (read path) — 4 getter calls at top of component
- `tipFrequency/processSwingTips`
- `positiveReinforcement/positiveReinforcementEngine`
- `sessionAccumulator`
- `captureValidity/classifyCapture`
- `swingLimit/checkSwingLimit`
- `handedness/getIsLeftHanded`
- `coachCode`
- `ageTier`
- `confidenceScore/shouldShowMetric`
- `scoring` types

---

### `lib/persistSwing.ts`
**Owns:**
- Supabase DB write (single `swings` table insert)
- `swing_debug` payload assembly
- Local swing count increment

**Should NOT own but currently does:**
- **Debug payload aggregation from 6+ subsystems** — pulls from `tipFrequency`, `positiveReinforcementEngine`, `sessionAccumulator`, `coachCode`, `handedness`, `ageTier`, `cameraGuidance`
- **APP_VERSION constant** (hardcoded at line 15, duplicated in swing_debug at line 81)

**Tightly coupled to:**
- `supabase` (auth + DB)
- `swingLimit/incrementLocalSwingCount`
- `captureValidity/isGoodFrame`
- `coachCode`, `handedness`, `ageTier` (async fetches)
- `tipFrequency/getFrequencyDebugInfo`
- `positiveReinforcement/positiveReinforcementEngine`
- `sessionAccumulator`

---

### `lib/swingMotionStore.ts`
**Owns:**
- In-memory module-global state for motion, analysis, videoUri
- "Today's Focus" computation + AsyncStorage persistence
- `computeFocus` scoring logic with metric definitions

**Should NOT own but currently does:**
- **Focus metric definitions + scoring** (lines 62-142) — 80 lines of domain logic (ideal angles, tolerances, coaching cues) in a state store file
- **Age tier coupling** — `getCachedAgeTier()` called inside cue generation functions

**Tightly coupled to:**
- `AsyncStorage` (focus persistence)
- `ageTier/getCachedAgeTier` (called inside cue lambdas)
- `storageKeys`

---

### `app/_layout.tsx`
**Owns:**
- App initialization (splash, auth, onboarding, referral)
- Deep link handling (magic links, referral URLs)
- Auth state change listener
- Session lifecycle (background timeout → reset singletons)
- Navigation stack definition

**Should NOT own but currently does:**
- **Singleton reset orchestration** (lines 132-151) — knows about `tipFrequencyLimiter`, `positiveReinforcementEngine`, `sessionAccumulator` and their reset semantics
- **Age tier initialization** (line 62) — `getAgeTier().then(tier => tipFrequencyLimiter.setAgeTier(tier))`

**Tightly coupled to:**
- `supabase` (auth)
- `referralAttribution`
- `purchases`
- `tipFrequency/tipFrequencyLimiter`
- `positiveReinforcement/positiveReinforcementEngine`
- `sessionAccumulator`
- `ageTier`

---

### `app/grip/capture.tsx`
**Owns:**
- Grip camera lifecycle (permissions, device, photo capture)
- Hand detection frame processor
- Countdown + capture + preview phases
- Hand landmark smoothing + overlay
- Photo URI management

**Should NOT own but currently does:**
- Nothing significant — this file is relatively well-scoped

**Tightly coupled to:**
- `gripStore/setGrip` (single write)
- `handDetection/detectHands` (single native call)
- Navigation to `/grip/result` with serialized landmarks param

---

### `components/VisualCoachCard.tsx`
**Owns:**
- Skeleton rendering with color-coded worst-metric highlight
- Score-based segment coloring
- Coaching cue text generation
- Lefty joint name remapping

**Should NOT own but currently does:**
- **Metric definitions duplicated** — `METRICS` record (lines 70-131) duplicates ideal/tolerance/cue from `swingMotionStore.ts` and `result.tsx`
- **Direct `scoreAngle` import from scoring.ts** — presentation component reaches into domain scoring

**Tightly coupled to:**
- `scoring/scoreAngle` (domain function)
- `ageTier/getCachedAgeTier` (called inside cue lambdas)
- `SkeletonOverlay` types

---

## C. COUPLING MAP

### Cross-file dependencies (data flow)
```
record.tsx ──writes──→ swingMotionStore (module globals)
record.tsx ──calls───→ persistSwing (fire-and-forget promise)
record.tsx ──chains──→ uploadSwingVideo (off persistSwing promise)
record.tsx ──navigates→ result.tsx (via router.push)

result.tsx ──reads───→ swingMotionStore (module globals)
result.tsx ──calls───→ processSwingTips, positiveReinforcementEngine, sessionAccumulator
result.tsx ──writes──→ AsyncStorage (saveFocus via swingMotionStore)

persistSwing ──reads→ 6 subsystem singletons for debug payload
_layout.tsx ──resets→ 3 subsystem singletons on foreground
```

### Shared mutable state
1. **Module globals in swingMotionStore.ts** (lines 12-14): `currentMotion`, `currentAnalysis`, `currentVideoUri` — written by record.tsx, read by result.tsx. No locking, no versioning, no change notification.
2. **`positiveReinforcementEngine`** — singleton mutated by result.tsx (`processSwing`), read by persistSwing.ts (`buildDebugInfo`), reset by _layout.tsx.
3. **`sessionAccumulator`** — singleton mutated by result.tsx (`addSwing`), read by persistSwing.ts (`swingCount`), reset by _layout.tsx.
4. **`tipFrequencyLimiter`** — singleton configured by _layout.tsx (`setAgeTier`), called by result.tsx (`processSwingTips`), read by persistSwing.ts (`getFrequencyDebugInfo`), reset by _layout.tsx.
5. **Module-level `tipSessionsSeen`** in record.tsx (line 55) — mutable counter outside React state.

### Hidden coupling via store or side effects
1. **record.tsx → result.tsx ordering dependency**: result.tsx reads store synchronously on mount. If navigation fires before `setCurrentSwingMotion`/`setCurrentSwingAnalysis` complete, result.tsx gets stale/null data. The `tryNavigate` gate exists to prevent this, but it's a manual coordination mechanism spread across 3 refs.
2. **persistSwing reads singletons that result.tsx mutates**: `persistSwing` is called from record.tsx *before* navigation. But `positiveReinforcementEngine.processSwing` and `sessionAccumulator.addSwing` are called from result.tsx *after* navigation. So persistSwing's debug payload captures the *previous* session state for these fields. This is a silent data consistency issue.
3. **Side effect in useMemo** (result.tsx lines 277-279): `sessionAccumulator.addSwing()` runs inside `useMemo`. This mutates a singleton during render. If React re-renders, it could double-add.
4. **checkSwingLimit called 3 times**: record.tsx mount (line 396), record.tsx focus (line 379), result.tsx mount (line 191). Each is independent, async, and can produce conflicting navigation.
5. **clearCurrentSwingMotion also clears analysis and videoUri** (swingMotionStore.ts line 25-28) — hidden cascade. Callers may not expect clearing motion also clears video.

---

## D. DEBUGGING PAIN ANALYSIS

### `record.tsx`
**Why it is hard to debug:**
- 815 lines with 15+ refs, 8+ state variables, 3 timers, and a worklet callback make it hard to reconstruct state at any point in time.
- The `capturePhase` state machine has both a React state and a ref mirror (`capturePhaseRef`), requiring mental tracking of both.
- `tryNavigate` depends on 4 conditions checked across async boundaries (capturePhase, analysisReady, videoUri, navigated). Any one being wrong = silent no-op.

**Expensive bug types:**
- **Async timing bugs (HIGH)**: `finalizeCapture` → `stopRecording` → `onRecordingFinished` callback is fully async. The 3-second safety timeout (line 293) is the only fallback. If timing changes, navigation silently breaks.
- **Race conditions (HIGH)**: `swingIdPromiseRef` is set in `finalizeCapture`, read in `onRecordingFinished`. If `onRecordingFinished` fires before `finalizeCapture` assigns the promise (theoretically impossible but fragile), upload silently fails.
- **Navigation bugs (HIGH)**: `tryNavigate` is called from 3 sites (finalizeCapture, onRecordingFinished, safety timeout). Any could fire first. `navigatedRef` prevents double-nav but hides which path won.
- **Data consistency bugs (MEDIUM)**: Store writes happen in `finalizeCapture`, but `classifyCapture` runs there too — if classification logic changes, persist and result screen could see different classifications.
- **UI vs logic mismatch (LOW)**: `capturePhase` state and `capturePhaseRef` can theoretically diverge if `updateCapturePhase` is called from async context during unmount.

**Cross-system bug responsibilities:**
- Any change to timing in native video recording affects navigation reliability.
- `checkSwingLimit` at mount AND focus can race against each other.

---

### `result.tsx`
**Why it is hard to debug:**
- Heavy `useMemo` chains where output of one feeds the next (analysis → processedTips → sessionInsight). Stale closures or dep array mismatches silently produce wrong coaching.
- Side effects hidden in `useMemo` (sessionAccumulator.addSwing).
- Reads from 3 module globals at mount with no guarantee they're populated.
- 6 different content paths in render (no motion, invalid, positive card, session insight, visual coach, normal).

**Expensive bug types:**
- **Data consistency bugs (HIGH)**: `classifyCapture` is re-run here (line 200) — if frames are the same as record.tsx used, it's redundant. If not, it's a divergence source.
- **Async timing bugs (MEDIUM)**: Multiple `useEffect` hooks fetch async state independently (`getIsLeftHanded`, `getCoachCode`, `checkSwingLimit`). Their results arrive at different times, potentially causing intermediate renders with inconsistent state.
- **UI vs logic mismatch (HIGH)**: Fallback re-analysis (line 219-222) runs `analyzePoseSequence` again if storedAnalysis is null. This *should* match what record.tsx computed, but uses `isLeftHanded` from local state (initially `false`), which may differ from what record.tsx used.
- **Navigation bugs (LOW)**: "Record Again" uses `router.back()`, which goes to whatever was previous — could be paywall or onboarding if deep-linked.

**Cross-system bug responsibilities:**
- Coaching tip display depends on 5 subsystems in sequence (scoring → buildRawTips → processSwingTips → shouldShowMetric → positiveReinforcementEngine). A bug in any produces wrong coaching.

---

### `persistSwing.ts`
**Why it is hard to debug:**
- Assembles data from 6+ async sources. If any throw, the whole persist fails.
- `swing_debug` payload is a bag of untyped data from multiple subsystems. Schema drift is invisible until you query the DB.
- Called fire-and-forget from record.tsx — errors only surface in console.error logs, never shown to user.

**Expensive bug types:**
- **Data consistency bugs (HIGH)**: Reads `positiveReinforcementEngine.buildDebugInfo()` and `sessionAccumulator.swingCount` — but these reflect *previous* swing's state because result.tsx hasn't run yet.
- **Async timing bugs (MEDIUM)**: 3 sequential `await` calls (getUserId, getCoachCode, getIsLeftHanded, getAgeTier) — any hanging blocks persist indefinitely.

---

### `swingMotionStore.ts`
**Why it is hard to debug:**
- Module globals with no change notification — you can't observe when they change or who changed them.
- `clearCurrentSwingMotion` has a hidden cascade (also clears analysis + videoUri).

**Expensive bug types:**
- **Data consistency bugs (HIGH)**: No atomicity — motion, analysis, and videoUri are set independently across multiple call sites. Between writes, a reader sees partially-updated state.

---

### `_layout.tsx`
**Why it is hard to debug:**
- Init function does 6 async things in sequence. Failure in any silently skips the rest.
- Auth state change listener has retry logic and side effects (commitPendingReferral, syncAuthState). Hard to trace which events fired.

**Expensive bug types:**
- **Navigation bugs (MEDIUM)**: 4 `router.replace` calls from different async contexts. If auth callback and init race, the user could bounce between screens.
- **Async timing bugs (MEDIUM)**: `getAgeTier().then(...)` at line 62 is fire-and-forget. If it resolves late, `tipFrequencyLimiter` operates without age tier for early swings.

---

### `grip/capture.tsx`
**Why it is hard to debug:**
- Relatively clean. Main risk is the countdown timer + photo capture async boundary.
- Serializing frozen landmarks to JSON for navigation params is fragile (size limits, encoding).

**Expensive bug types:**
- **Navigation bugs (LOW)**: Landmarks serialized via `JSON.stringify` into route params. Large payloads could hit URL/param limits.

---

### `VisualCoachCard.tsx`
**Why it is hard to debug:**
- Duplicated metric definitions (ideal/tolerance/cue) with swingMotionStore.ts and result.tsx. If values drift between files, the skeleton highlight and coaching text disagree with the score.

**Expensive bug types:**
- **Data consistency bugs (MEDIUM)**: Three copies of metric ideals/tolerances exist. Visual coach could highlight a metric as "bad" while the score card says "good" if values diverge.

---

## E. FAULT BOUNDARIES (CURRENT)

### Clear boundaries:
- **Native → JS**: Frame processor worklet boundary is clean. `honeyPoseDetect` returns landmarks, `appendPoseFrame` consumes them. Diagnostic frames are filtered.
- **Domain analysis pipeline**: `analyzePoseSequence` is pure, no side effects, tested independently. Clean input/output.
- **Grip capture flow**: Fully independent from swing flow. No shared state. Clean boundary.
- **VisualCoachCard**: Pure render component (despite duplicated logic). Takes props, returns JSX.

### Blurred boundaries:
- **record.tsx ↔ swingMotionStore ↔ result.tsx**: No formal contract. record.tsx writes, result.tsx reads. The "API" is implicit ordering enforced by navigation timing.
- **record.tsx ↔ persistSwing**: Persistence is initiated from UI. Errors are swallowed. Upload chains off persistence. Three async concerns (analysis, persist, video) are interleaved in one function.
- **result.tsx ↔ 5 coaching subsystems**: result.tsx directly orchestrates tip frequency, positive reinforcement, session accumulation, confidence scoring, and age tier. No intermediary.
- **_layout.tsx ↔ session singletons**: Layout knows the reset semantics of 3 unrelated subsystems. Adding a new singleton requires modifying _layout.tsx.

### Broken boundaries:
- **persistSwing reads singletons mutated by result.tsx**: persistSwing runs before result.tsx, but reads state that result.tsx is responsible for updating. The debug payload is always one swing behind for reinforcement/session data.
- **`sessionAccumulator.addSwing()` inside `useMemo`**: Side effect in a render-time computation. React makes no guarantees about memo execution count.

---

## F. BUG ORIGIN ANALYSIS

### "Coaching tip shows wrong/stale advice"
- **Origin**: result.tsx `useMemo` chain (lines 231-272). Depends on `analysis`, `shouldShowMetric`, `processSwingTips`, `positiveReinforcementEngine.processSwing` in sequence.
- **Hard to isolate because**: 5 subsystems contribute. Each has internal state (frequency limiter history, reinforcement streak). No single place to inspect "why was this tip shown?"

### "Navigation stuck after recording (blank screen or no transition)"
- **Origin**: record.tsx `tryNavigate` (lines 133-145). Requires `capturePhase === 'complete'` AND `analysisReadyRef === true` AND `videoUriRef !== 'pending'` AND `navigatedRef === false`.
- **Hard to isolate because**: 4 independent conditions, 3 trigger sites. Adding a log to `tryNavigate` shows which condition failed, but not *why* the condition hasn't been met yet (async pipeline).

### "Score or analysis differs from what skeleton shows"
- **Origin**: Metric ideal/tolerance values duplicated in `VisualCoachCard.tsx` (line 70), `swingMotionStore.ts` (line 71), `result.tsx` (line 89).
- **Hard to isolate because**: Three files define the same constants independently. No test or type enforces consistency.

### "Swing not persisted / upload missing"
- **Origin**: record.tsx `finalizeCapture` (lines 272-290). `persistSwing` promise chain with catch that only logs.
- **Hard to isolate because**: Fire-and-forget. No user-visible signal. Upload depends on persist completing first (`swingIdPromiseRef`). If persist throws, upload silently never happens.

### "Paywall gate bypassed or triggers incorrectly"
- **Origin**: `checkSwingLimit` called from 3 independent sites with different error handling (record.tsx mount: navigates on !allowed; record.tsx focus: navigates on !allowed; result.tsx: sets limitHit flag). 
- **Hard to isolate because**: Any of the 3 can fire first. The record.tsx mount check could succeed, then focus check (which runs immediately after) could fail if limit was just hit by persist.

### "swing_debug data is wrong in DB"
- **Origin**: persistSwing.ts `swing_debug` payload (lines 80-93).
- **Hard to isolate because**: Aggregates from 6 subsystems. `positiveReinforcementEngine.buildDebugInfo()` and `sessionAccumulator.swingCount` reflect state from *before* result.tsx processes this swing — timing dependency is invisible.

---

## G. WHAT SHOULD STAY TOGETHER

1. **Camera + frame processor + skeleton overlay** in record.tsx — these are intrinsically tied to the camera lifecycle. Splitting them creates more coordination than it saves.
2. **Video recording start/stop** in record.tsx — tightly coupled to capture phase state machine. The `startRecording`/`stopRecording` calls must be co-located with the capture phase transitions.
3. **Countdown timer logic** in record.tsx — simple, phase-specific, no reuse value.
4. **Tip display + positive reinforcement + session insight rendering** in result.tsx — these are mutually exclusive display paths. They share the same render decision tree.
5. **VisualCoachCard as a self-contained component** — despite duplicated constants, its rendering logic is cohesive. The fix is to share constants, not split the component.

---

## H. WHAT SHOULD BE SEPARATED (NO SOLUTIONS)

1. **Analysis execution + store writes + persistence + upload** are currently a single imperative sequence in `record.tsx:finalizeCapture` (lines 225-297). Analysis, persistence, upload, and store population are four distinct concerns with different failure modes.
   → OPEN DECISION FOR PROMPT 2

2. **Navigation timing gate** (`tryNavigate` + the 3-ref coordination + safety timeout) is embedded in record.tsx but is actually a coordination protocol between analysis completion, video recording completion, and navigation.
   → OPEN DECISION FOR PROMPT 2

3. **Coaching tip pipeline** (buildRawTips, METRIC_KEY_MAP, COACHING_TEXT, TIP_SCORE_THRESHOLD) lives in result.tsx but is pure domain logic with no UI dependency. ~90 lines of mapping/filtering.
   → OPEN DECISION FOR PROMPT 2

4. **Metric ideal/tolerance/cue definitions** are triplicated across `VisualCoachCard.tsx`, `swingMotionStore.ts`, and `result.tsx`. Three independent copies of the same biomechanical targets.
   → OPEN DECISION FOR PROMPT 2

5. **Focus computation + persistence** (`computeFocus`, `saveFocus`, `FOCUS_METRICS`) lives in `swingMotionStore.ts` but has nothing to do with the in-memory swing state store. It's domain logic + AsyncStorage I/O mixed into a state module.
   → OPEN DECISION FOR PROMPT 2

6. **Singleton reset orchestration** in `_layout.tsx` — layout must know about every session-scoped singleton to reset them. Currently 3, will grow.
   → OPEN DECISION FOR PROMPT 2

7. **`checkSwingLimit` is called from 3 sites** with 3 different response patterns (navigate to paywall, set flag, ignore). Limit-checking policy is scattered.
   → OPEN DECISION FOR PROMPT 2

8. **`swing_debug` payload assembly** in `persistSwing.ts` aggregates from 6+ subsystems. It's a data-gathering orchestrator disguised as a persistence function.
   → OPEN DECISION FOR PROMPT 2

---

## I. HIGHEST RISK SURFACES

### 1. `record.tsx:finalizeCapture` + `tryNavigate` (lines 225-297, 133-145)
- **Likelihood of bugs**: HIGH — async timing between analysis, video callback, and safety timeout. Any native behavior change (recording latency, frame count) shifts timing.
- **Difficulty of debugging**: HIGH — 4 boolean conditions across 3 refs, 3 trigger sites, no logging of which path navigated or why conditions weren't met.

### 2. `result.tsx` coaching pipeline (lines 231-290)
- **Likelihood of bugs**: HIGH — 5 subsystems chained in `useMemo`, one with a side effect (`sessionAccumulator.addSwing`). Adding any new coaching feature requires touching this chain.
- **Difficulty of debugging**: HIGH — no intermediate state is inspectable. Tip suppression, frequency limiting, confidence gating, and positive reinforcement all interact silently.

### 3. Triplicated metric definitions (`VisualCoachCard.tsx:70`, `swingMotionStore.ts:71`, `result.tsx:89`)
- **Likelihood of bugs**: MEDIUM — any metric tuning must be applied to 3 files. One miss = skeleton shows green while tip says "work on this."
- **Difficulty of debugging**: HIGH — manifests as subtle coaching inconsistency. No test catches cross-file drift. User reports "confusing feedback" with no clear repro.

---

## J. EARLIEST FAILURE POINT

**"What fails FIRST when debugging or modifying these files?"**

**`record.tsx:tryNavigate`** — any change to the capture flow (new quality gate, different timer, additional async step) requires understanding and updating the 4-condition navigation gate. It is the earliest point where a modification silently breaks because:

1. It's a silent no-op when any condition is false (no error, no log, no fallback).
2. It's called from 3 different async contexts, so adding a log doesn't tell you *which* path failed to trigger it.
3. The 3-second safety timeout masks failures — the app "works" but with degraded behavior (no video in result screen).

A developer adding a new post-capture step (e.g., a new async check) will almost certainly break `tryNavigate` by not threading their completion signal through the gate.

---

## K. SMALLEST PROOF STEP

**Add structured logging to `tryNavigate`.**

A single `console.log` inside `tryNavigate` that emits the current value of all 4 conditions on every call:

```
[tryNavigate] phase=complete analysis=true video=pending navigated=false → BLOCKED (video)
[tryNavigate] phase=complete analysis=true video=/path/to/video navigated=false → NAVIGATING
```

This is zero-risk (log-only, no behavior change), immediately reveals which condition blocks navigation, and creates a paper trail for async timing diagnosis. It pays for itself on the first stuck-navigation bug report.

---

## SELF-CHECK

- [x] All 7 files read fully before any output written
- [x] No architecture proposed — all structural observations labeled → OPEN DECISION FOR PROMPT 2
- [x] Bug origins identified with specific file:line references
- [x] Every section ends with a conclusion, not an observation
