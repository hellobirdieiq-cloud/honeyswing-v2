# HoneySwing Structure Split — Design Plan

---

## GROUND TRUTH GATE — 5 Constraining Facts

**Fact 1 (Earliest Failure Point):** `record.tsx:tryNavigate` is a silent 4-condition gate (capturePhase, analysisReady, videoUri, navigated) called from 3 async contexts. Any structural change that alters the timing or ordering of these signals will silently break navigation. **Constraint: the navigation gate, the refs it reads, and its 3 call sites must remain co-located in a single file.**

**Fact 2 (Highest Risk Surface):** `record.tsx:finalizeCapture` (lines 225-297) interleaves analysis execution, store writes, persistence, upload chaining, classification, and navigation signaling in a single imperative sequence. Async timing between `stopRecording`, `onRecordingFinished`, and the safety timeout is fragile. **Constraint: finalizeCapture's internal sequence must not be split across files — the orchestration must stay in one place. Only the _callees_ (what it invokes) can be extracted.**

**Fact 3 (Duplicated Logic):** Metric ideal/tolerance/cue definitions exist in 3 files: `VisualCoachCard.tsx:70`, `swingMotionStore.ts:71`, `result.tsx:89`. They will drift. **Constraint: any new file structure must consolidate these into a single source, or the split is invalid.**

**Fact 4 (Cross-System Timing Dependency):** `persistSwing` is called from `record.tsx` before navigation, but reads singleton state (`positiveReinforcementEngine`, `sessionAccumulator`) that `result.tsx` updates after navigation. The debug payload is always one swing behind. **Constraint: any split must not worsen this — and ideally the coaching tip pipeline extraction should make the data flow direction explicit.**

**Fact 5 (Side Effect in useMemo):** `result.tsx:278` calls `sessionAccumulator.addSwing()` inside `useMemo`. React 19 may re-execute memos. This is a correctness bug waiting to happen. **Constraint: the split must move this side effect out of useMemo into a useEffect.**

---

## 1. PRIMARY SPLIT DECISION

### record.tsx split

**Extract one hook: `useSwingCapture`.**

This hook encapsulates everything from "user presses record" through "navigation fires." It owns:
- The capture state machine (idle → countdown → capturing → complete/error/weak)
- `motionFramesRef`, `analysisReadyRef`, `videoUriRef`, `navigatedRef`, `swingIdPromiseRef`
- `tryNavigate`, `finalizeCapture`, `beginRecording`, `startCountdownCapture`, `startInstantCapture`
- `clearTimers`, `updateCapturePhase`
- The quality gate (`isGoodFrame`)
- Store writes (`setCurrentSwingMotion`, `setCurrentSwingAnalysis`, `setCurrentSwingVideoUri`)
- Persistence call (`persistSwing`) and upload chain (`uploadSwingVideo`)
- Classification (`classifyCapture`)
- Analysis execution (`analyzePoseSequence`)

**record.tsx keeps:**
- Camera lifecycle (permissions, device, format, activation, `cameraRef`)
- Frame processor + `appendPoseFrame` worklet
- Camera guidance (EMA shoulder separation)
- `LiveSkeleton` component
- Pinch-to-zoom gesture
- All JSX rendering
- Paywall gate (`checkSwingLimit` calls)
- Framing tips

**Why this boundary:** `tryNavigate` and `finalizeCapture` are the #1 and #2 debugging pain points. Isolating them in a hook means you can log, test, and reason about the capture-to-navigation pipeline without scrolling through 500 lines of camera/UI code. The hook returns `{ capturePhase, countdown, startCountdownCapture, startInstantCapture, finalizeCapture }` — a clean interface. record.tsx becomes a camera+UI shell that calls into the hook.

**Critical: the hook receives `cameraRef` and tilt capture as params.** It does not own the camera — it tells the camera what to do via the ref. This preserves the Fact 2 constraint (finalizeCapture stays in one place).

### result.tsx split

**Extract one file: `lib/coachingTips.ts`.**

This file takes the ~90 lines of pure domain logic out of the UI:
- `METRIC_KEY_MAP`
- `COACHING_TEXT`
- `TIP_SCORE_THRESHOLD`
- `buildRawTips()`

**Move `sessionAccumulator.addSwing()` from useMemo to useEffect.** This fixes the Fact 5 bug. Not a file split — a 5-line move within result.tsx.

**result.tsx keeps everything else.** The useMemo coaching chain (lines 231-272) stays — it's tightly coupled to the render decision tree (positive card vs session insight vs visual coach). Splitting the _rendering orchestration_ doesn't help debugging; splitting the _data transformation_ (buildRawTips) does.

---

## 2. DECISION TABLE

| Criteria | A. Leave as-is | B. Minimal split (CHOSEN) | C. Medium split | D. Heavy split |
|---|---|---|---|---|
| **What changes** | Nothing | 1 hook from record.tsx, 1 lib file from result.tsx, 1 shared metrics file | + separate NavigationGate, ResultDataProvider, PersistenceService | Full MVC: controllers, services, view components |
| **Pros** | Zero risk | Isolates #1 debugging pain (tryNavigate). Fixes useMemo bug. Consolidates metrics. 3 new files total. | Cleaner boundaries everywhere | Textbook separation |
| **Cons** | Every bug requires reading 815 lines of record.tsx | Doesn't fix persistSwing timing (Fact 4) | 6+ new files, complex wiring, solo builder overhead | 10+ files, massive change, weeks of work, breaks everything if wrong |
| **Debugging speed** | Baseline (bad) | **+40%** — capture bugs isolated to ~200-line hook, tip bugs isolated to ~80-line lib file | +55% — but only if you memorize the new wiring | +60% on paper, -20% in practice (indirection tax) |
| **Risk level** | None | **Low** — hook extraction is mechanical, lib extraction is pure functions | Medium — NavigationGate abstraction could introduce new timing bugs | High — full rewrite risk |
| **What breaks if it fails** | Nothing new | Worst case: hook wiring bug → capture doesn't start. Obvious, fast to diagnose, revert in 1 commit. | NavigationGate abstraction could silently break tryNavigate (violates Fact 1) | Everything |

**→ PICK: B. Minimal split.**

**Reject A:** Leaves the #1 debugging pain point (tryNavigate buried in 815-line file) untouched. Every future capture bug costs 2x the time it should.

**Reject C:** A separate NavigationGate module would split `tryNavigate` from the refs it reads (`capturePhaseRef`, `analysisReadyRef`, `videoUriRef`, `navigatedRef`). This violates Fact 1 — the gate and its signals must be co-located. The hook approach keeps them together while isolating them from camera UI.

**Reject D:** Solo builder. 10+ files for a golf app. The indirection tax exceeds the debugging benefit. Violates "prefer fewer, high-leverage splits."

---

## 3. PROPOSED FILE STRUCTURE

### New files (3 total):

**`lib/useSwingCapture.ts`**
- Owns: capture state machine, tryNavigate, finalizeCapture, beginRecording, startCountdownCapture, startInstantCapture, clearTimers, quality gate, store writes, analysis execution, persistence call, upload chain, classification, all related refs (analysisReadyRef, videoUriRef, navigatedRef, swingIdPromiseRef, capturePhaseRef, captureTimeoutRef, countdownRef, safetyTimeoutRef, motionFramesRef)
- MUST NOT own: camera lifecycle, frame processor, camera guidance, JSX, paywall gate, skeleton overlay

**`lib/coachingTips.ts`**
- Owns: `METRIC_KEY_MAP`, `COACHING_TEXT`, `TIP_SCORE_THRESHOLD`, `buildRawTips()`, `frameToLandmarks()`, `pickKeyFrame()`
- MUST NOT own: useMemo orchestration, rendering decisions, singleton interactions (positiveReinforcementEngine, sessionAccumulator)

**`packages/domain/swing/metricDefinitions.ts`**
- Owns: single source of truth for metric ideals, tolerances, labels, segment mappings, and coaching cue generators. Consumed by VisualCoachCard, swingMotionStore (computeFocus), and coachingTips.
- MUST NOT own: scoring logic, rendering, AsyncStorage, age tier fetching (receives ageTier as a parameter to cue functions)

### Modified files:

**`app/(tabs)/record.tsx`** — shrinks from ~815 to ~500 lines
- Owns: camera lifecycle, frame processor, appendPoseFrame worklet, camera guidance, LiveSkeleton, pinch-to-zoom, JSX rendering, paywall gate, framing tips
- Calls `useSwingCapture()` for all capture logic
- MUST NOT own: tryNavigate, finalizeCapture, analysis, persistence, store writes

**`app/analysis/result.tsx`** — shrinks from ~690 to ~550 lines
- Owns: rendering, video player, useMemo coaching chain (using imported buildRawTips), useEffect side effects, focus persistence
- Imports from `lib/coachingTips.ts` instead of defining inline
- MUST NOT own: metric definitions, tip text constants, buildRawTips logic

**`components/VisualCoachCard.tsx`** — minor change
- Imports metric definitions from `packages/domain/swing/metricDefinitions.ts`
- Deletes its local `METRICS` record (~60 lines)
- MUST NOT own: metric ideals/tolerances (uses shared source)

**`lib/swingMotionStore.ts`** — minor change
- `computeFocus` imports metric definitions from `packages/domain/swing/metricDefinitions.ts`
- Deletes its local `FOCUS_METRICS` record (~50 lines)
- MUST NOT own: metric ideals/tolerances (uses shared source)

---

## 4. RESPONSIBILITY REALLOCATION

### Moves OUT of record.tsx → `lib/useSwingCapture.ts`:

| What moves | Lines | Debugging benefit |
|---|---|---|
| `tryNavigate` + 4 guard refs | 133-145 + refs at 96-101 | **#1 benefit.** Capture-to-navigation debugging goes from "search 815 lines" to "open 200-line hook." |
| `finalizeCapture` | 225-298 | Analysis, persist, upload, classification — all isolated from camera UI. Can add logging/tracing in one place. |
| `beginRecording` | 300-335 | Recording start sequence visible without camera boilerplate. |
| `startCountdownCapture` + `startInstantCapture` | 337-365 | Entry points clearly visible in hook. |
| `clearTimers` | 118-131 | Timer management co-located with the timers it manages. |
| `updateCapturePhase` | 113-116 | Phase state machine entirely in hook. |
| `isGoodFrame` + quality constants | 57-68, 214-223 | Quality gate testable without camera. |
| Capture-related refs | 90-101 | No longer scattered among 15+ refs in the component. |

### Moves OUT of result.tsx → `lib/coachingTips.ts`:

| What moves | Lines | Debugging benefit |
|---|---|---|
| `METRIC_KEY_MAP` | 78-86 | Tip mapping inspectable in isolation. |
| `COACHING_TEXT` | 89-125 | Coaching text changes don't require touching UI file. |
| `buildRawTips()` | 133-162 | Pure function, independently testable. |
| `frameToLandmarks()` | 40-52 | Data transformation, not UI. |
| `pickKeyFrame()` | 55-69 | Frame selection logic, not UI. |

### Moves within result.tsx (not a file split):

| What moves | From | To | Debugging benefit |
|---|---|---|---|
| `sessionAccumulator.addSwing()` | useMemo (line 278) | useEffect | Fixes Fact 5 — eliminates double-add risk under React 19 re-renders. |

### Consolidates across 3 files → `packages/domain/swing/metricDefinitions.ts`:

| Source file | What moves | Debugging benefit |
|---|---|---|
| `VisualCoachCard.tsx` lines 70-131 | `METRICS` record (ideals, tolerances, segments, cues) | Eliminates Fact 3. One change, one file, no drift. |
| `swingMotionStore.ts` lines 71-120 | `FOCUS_METRICS` record (ideals, tolerances, cues) | Same. |
| `result.tsx` lines 89-125 | `COACHING_TEXT` metric definitions | Partially — text stays in coachingTips.ts, but ideals/tolerances come from metricDefinitions.ts. |

### STAYS in record.tsx:
- Camera permissions, device selection, format configuration
- `ReanimatedCamera` + `cameraRef`
- Frame processor + `appendPoseFrame` worklet (tightly coupled to camera)
- Camera guidance (shoulder separation EMA)
- `LiveSkeleton` memoized component
- Pinch-to-zoom gesture
- Paywall gate (`checkSwingLimit` + `useFocusEffect`)
- All JSX + styles
- `tipSessionsSeen` module counter

### STAYS in result.tsx:
- `useMemo` coaching chain (calls imported `buildRawTips`, orchestrates subsystems)
- Video player + speed control
- All rendering logic (6 content paths)
- Focus persistence (`computeFocus` + `saveFocus` in useEffect)
- Coach name, limit hit, handedness async fetches
- All JSX + styles

---

## 5. OTHER FILES

### `components/VisualCoachCard.tsx` → SPLIT NOW
- Delete local `METRICS` record, import from `metricDefinitions.ts`
- ~60 lines removed, no behavior change
- **Why now:** Direct fix for Fact 3 (triplicated metrics). Zero risk — pure constant replacement.

### `lib/swingMotionStore.ts` → SPLIT NOW
- Delete local `FOCUS_METRICS` record, import from `metricDefinitions.ts`
- ~50 lines removed, no behavior change
- **Why now:** Same Fact 3 fix. Also makes the file what it should be — a state store, not a domain logic container.

### `lib/persistSwing.ts` → LEAVE ALONE
- Yes, it aggregates from 6 subsystems (Fact 4). But the fix requires changing the _timing_ of when singletons are read, not the _file structure_. Moving code around doesn't fix the one-swing-behind bug. The right fix is passing the debug data as parameters instead of reading singletons — but that's a behavior change, not a structural split.
- **Why leave:** Splitting the file doesn't improve debugging. The file is 108 lines and single-purpose.

### `app/_layout.tsx` → LEAVE ALONE
- Yes, it knows about 3 singletons for reset. But it's 167 lines, the reset logic is 20 lines, and extracting a "session lifecycle manager" adds a file for marginal benefit.
- **Why leave:** Solo builder. 20 lines of reset logic doesn't justify a new abstraction. If a 4th singleton is added, revisit.

### `app/grip/capture.tsx` → LEAVE ALONE
- Audit rated it "relatively well-scoped." No Fact violations. Independent from swing flow.
- **Why leave:** No debugging pain to fix here.

---

## 6. PROTECTED SURFACES

**Files that MUST NOT change:**
- `packages/domain/swing/analysisPipeline.ts` — pure domain, clean boundary. Do not touch.
- `packages/domain/swing/scoring.ts` — `scoreAngle` is imported by VisualCoachCard; keep as-is.
- `packages/pose/` — pose abstraction layer. No changes.
- `ios/HoneyVisionCameraPosePlugin.swift` — native plugin. Do not touch.
- `lib/captureValidity.ts` — consumed by both record and result. Works fine.

**Systems that must remain untouched:**
- Navigation flow: record → result via `router.push('/analysis/result')`. No change to routing.
- Store contract: record writes module globals, result reads them synchronously on mount. Not changing this — hook just moves _where_ the writes happen, not _when_.
- Persistence flow: `persistSwing` called fire-and-forget from `finalizeCapture`, upload chained off promise. Same sequence, just in hook instead of component.
- Video callback: `onRecordingFinished` sets `videoUriRef` and calls `tryNavigate`. Same flow, same ref, just in hook.

---

## 7. PHASED EXECUTION PLAN

### Phase 1: Structured logging (15 min, zero risk)
Add a `console.log` to `tryNavigate` in record.tsx showing all 4 conditions and the outcome. Validates the audit's claim about the earliest failure point. Creates a diagnostic baseline before any refactoring.

### Phase 2: Create `packages/domain/swing/metricDefinitions.ts` (30 min, low risk)
Extract the shared metric ideals/tolerances/cues into one file. Update VisualCoachCard and swingMotionStore to import from it. Pure constant extraction — behavior is identical.

**Verification:** App builds. VisualCoachCard skeleton coloring unchanged. computeFocus produces same focus data. Run existing tests.

### Phase 3: Create `lib/coachingTips.ts` (20 min, low risk)
Move `METRIC_KEY_MAP`, `COACHING_TEXT`, `buildRawTips()`, `frameToLandmarks()`, `pickKeyFrame()` from result.tsx into new file. result.tsx imports them.

**Verification:** Result screen displays identical tips, skeleton, score. No behavior change.

### Phase 4: Fix `sessionAccumulator.addSwing()` in result.tsx (5 min, low risk)
Move from `useMemo` to `useEffect`. Eliminates Fact 5 double-add risk.

**Verification:** Metro logs show `[sessionInsight]` firing once per swing, not twice.

### Phase 5: Create `lib/useSwingCapture.ts` (45 min, medium risk)
Extract capture state machine + finalizeCapture + tryNavigate + all related refs into a custom hook. record.tsx calls `useSwingCapture({ cameraRef, tiltCapture, guidanceSnapshot, router })` and gets back `{ capturePhase, countdown, startCountdownCapture, startInstantCapture, finalizeCapture }`.

**Verification:**
1. Record a swing → navigates to result → score displays correctly
2. Record with low-quality pose → "weak" state shows
3. Record with < 6 frames → "error" state shows
4. Video plays in result screen (onRecordingFinished path works)
5. Safety timeout fires if video callback is slow (simulate by adding delay)
6. tryNavigate log shows same condition pattern as before split

### Phase 6: Update `result.tsx` COACHING_TEXT to use metricDefinitions (15 min, low risk)
Wire the coaching text ideals to shared definitions where applicable (tip thresholds already separate from visual thresholds, so this is partial).

**Verification:** Tips match visual coach skeleton coloring. No divergence.

**Total: ~2 hours. Each phase is independently committable and revertable.**

---

## 8. RISK ANALYSIS

### During the split

**Risk: Hook wiring breaks camera ref passing.**
- `useSwingCapture` needs `cameraRef` to call `startRecording`/`stopRecording`. If the ref isn't passed correctly, recording silently fails.
- **Mitigation:** Hook takes `cameraRef` as a parameter. The ref itself stays in record.tsx (where Camera is rendered). Type system catches missing ref.

**Risk: `appendPoseFrame` worklet can't call hook functions.**
- The worklet callback in record.tsx calls into `capturePhaseRef` and `motionFramesRef`. These move into the hook.
- **Mitigation:** Hook exposes the refs it creates. `appendPoseFrame` reads `capturePhaseRef.current` from the hook's returned refs. Alternatively, hook returns a `onPoseFrame` callback that the worklet calls. The worklet boundary is the critical seam — test this explicitly.

**Risk: Countdown timer state splits across hook and component.**
- `countdown` is React state (for display). Timer management is in the hook.
- **Mitigation:** Hook owns both `countdown` state and timer. Returns `countdown` as part of its interface. record.tsx only reads it for display.

### After the split

**Risk: New async timing bug in tryNavigate.**
- Lowest probability — tryNavigate and all its refs stay together in the hook. The 3 call sites (finalizeCapture, onRecordingFinished callback, safety timeout) all stay in the hook.
- **Mitigation:** Phase 1 logging makes this observable before and after.

**Risk: Stale closure in appendPoseFrame worklet.**
- If hook re-creates refs on re-render, the worklet captures old refs.
- **Mitigation:** Hook uses `useRef` (stable across renders). The worklet accesses `.current` at call time, not capture time. This is the existing pattern — the split doesn't change it.

**Risk: Metric definition consolidation introduces subtle value changes.**
- If the three copies have drifted already, picking one as "canonical" could change behavior.
- **Mitigation:** Phase 2 starts by diffing all three copies. If values differ, flag to user before proceeding.

---

## 9. SMALLEST PROOF STEP

**Phase 1: Add structured logging to `tryNavigate`.**

Add this inside `tryNavigate` in record.tsx, before the early returns:

```
console.log('[tryNavigate]', {
  phase: capturePhaseRef.current,
  analysis: analysisReadyRef.current,
  video: typeof videoUriRef.current === 'string' ? 'ready' : videoUriRef.current,
  navigated: navigatedRef.current,
});
```

- **Low risk:** Log only. No behavior change.
- **Fast:** 5 lines, 2 minutes.
- **Reversible:** Delete the log.
- **Does NOT require full refactor.**
- **Validates:** Confirms the audit's Fact 1 claim. Creates the diagnostic baseline needed for Phase 5. If this log never fires "BLOCKED," the tryNavigate risk is lower than estimated and the hook extraction is less urgent.

---

## 10. FINAL VERDICT

**Split now:** Extract `useSwingCapture` hook from record.tsx (isolates the #1 debugging pain — tryNavigate + finalizeCapture). Extract `lib/coachingTips.ts` from result.tsx (isolates tip domain logic from UI). Create `packages/domain/swing/metricDefinitions.ts` (eliminates triplicated metrics — Fact 3). Fix the `sessionAccumulator.addSwing()` useMemo bug in result.tsx (Fact 5).

**Delay:** persistSwing.ts restructuring (the one-swing-behind bug is a timing issue, not a structural one). _layout.tsx singleton orchestration (20 lines, not worth a new file yet). grip/capture.tsx (no pain to fix).

**Do this before new feature work.** The useSwingCapture hook extraction takes ~45 minutes and every future capture-related feature or bug fix benefits from it. The metric consolidation takes 30 minutes and prevents silent coaching inconsistencies on every future tuning change. Total cost: ~2 hours. Pays for itself on the first capture bug.
