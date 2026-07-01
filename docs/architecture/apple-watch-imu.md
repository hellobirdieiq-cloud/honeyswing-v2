# Apple Watch IMU for Golf Swing Analysis — Architecture

## Context

HoneySwing scores swings from camera pose (RTMW → `PoseFrame[]`) plus a phone
accelerometer stream (`gravity_vector`) used only for tilt correction. The camera
struggles with depth and fast motion, and the pipeline already **withholds tempo**
when phase detection is unsure (`tempoAnalysis.ts` sanity checks). A wrist-worn
Apple Watch IMU (accelerometer + gyroscope) is a complementary, body-fixed sensor
that directly measures wrist rotation, swing speed, tempo, and a sharp **impact
spike** — signals the camera can't reliably recover.

**This document is an architecture/design write-up, not a committed build.** It
captures the full design, the hard parts, and a phased path so a later session can
execute. Decision recorded with the user: **capture the full raw 6-axis stream**
first and decide what's useful after seeing real data (rather than building toward
a specific derived metric up front).

## The fundamental constraint

"Apple Watch data" is two unrelated paths:

| Path | Gives you | Useful for swings? |
|------|-----------|--------------------|
| **HealthKit** (read from phone, no watch app) | heart rate, workout summaries | **No** — nothing biomechanical |
| **Wrist IMU via watchOS app** (CoreMotion) | accel + gyro at up to 200 Hz | **Yes** — this is the gold |

The useful data does **not** flow through HealthKit. It requires a **native
watchOS companion app** running CoreMotion, transferred to the phone over
`WatchConnectivity`, bridged into JS via a native module. There is no Expo/JS
shortcut. The project is already prebuilt/bare (`ios/honeyswing.xcworkspace`
exists), so adding a watch target is feasible.

## Why the existing code makes this tractable

`gravity_vector` already established the exact pattern a new sensor stream
follows. Watch IMU mirrors it, one layer deeper:

- **Capture hook:** `lib/useTiltCapture.ts` — start/stop tied to recording,
  buffered readings, `getReadings()` on stop. New `useWatchImuCapture.ts` mirrors
  this shape exactly.
- **Lifecycle wiring:** `lib/useSwingCapture.ts` — `startTiltCapture()` in
  `beginRecording()`, `stopTiltCapture()` + `getTiltReadings()` in
  `finalizeCapture()`. Watch capture starts/stops at the same two points.
- **Analysis entry:** `analyzePoseSequence(sequence, isLeftHanded, gravityReadings, ...)`
  in `packages/domain/swing/analysisPipeline.ts` already takes an **optional
  sensor array that no-ops when empty**. Add `watchImuReadings` the same way.
- **Persistence:** `lib/persistSwing.ts` averages `gravityReadings` → `gravity_vector`
  JSONB. Add a `watch_imu` column (raw stream, not just an average) + a
  `swing_debug.watch_imu` telemetry block.
- **Migration precedent:** `supabase/migrations/20260515183650_add_gravity_vector.sql`.

The "additive, no-ops when absent" property is the key: a swing with no paired
watch behaves exactly as today (empty array), so nothing regresses.

## Component architecture

```
┌─ Apple Watch (new watchOS app target) ────────────────────────┐
│  HKWorkoutSession (golf)  ← REQUIRED to unlock high-rate IMU   │
│  CMBatchedSensorManager.startDeviceMotionUpdates  @ ~200 Hz    │
│    → buffer ~4 s of {t, ax,ay,az, gx,gy,gz} (≈800 samples)     │
│  WCSession.transferUserInfo(payload)  after swing ends         │
└───────────────────────────┬───────────────────────────────────┘
                            │ WatchConnectivity
┌───────────────────────────▼─ iPhone (native module, new) ─────┐
│  WCSessionDelegate receives payload                            │
│  Expo native module emits event → JS (mirrors RTMW plugin)     │
└───────────────────────────┬───────────────────────────────────┘
                            │ JS bridge
┌───────────────────────────▼─ React Native / domain (JS) ──────┐
│  useWatchImuCapture()  ← buffers readings during recording     │
│  useSwingCapture: start/stop alongside tilt capture            │
│  analyzePoseSequence(..., watchImuReadings)  → sync + derive   │
│  persistSwing → swings.watch_imu (jsonb) + swing_debug.watch_imu│
└───────────────────────────────────────────────────────────────┘
```

## The three hard parts (and the chosen approach)

### 1. Unlocking high-rate sensors on the watch
`CMBatchedSensorManager` (the 200 Hz batched API Apple built for golf/tennis/
baseball) and reliable background motion **require an active `HKWorkoutSession`**.
So the watch app starts a golf workout session when the user arms a swing, runs
batched device-motion updates, and ends the session after. Fallback for older
watches without `CMBatchedSensorManager`: `CMMotionManager.startDeviceMotionUpdates`
at ~100 Hz under the same workout session.

### 2. Watch → phone transfer
A swing is a ~4 s burst ≈ 800 samples × 6 floats ≈ small. **Capture-then-transfer**
(buffer on watch, send once after the swing via `transferUserInfo`) is far more
reliable than live streaming and is the recommended approach. Live `sendMessage`
streaming is possible but adds reachability/dropout failure modes for no benefit
here, since analysis is post-capture anyway.

**[ADDED AT RECOVERY]** `transferUserInfo` accepts only property-list types —
encode the sample payload as a **binary `Data` blob**, not a JSON / `[String:Any]`
dictionary.

### 3. Clock sync between watch IMU and camera pose — the real problem
The watch and phone have independent clocks; the camera/pose stream uses **video
file timestamps** (`PoseFrame.timestampMs`), not wall clock. Two-tier strategy:

- **Coarse:** stamp both streams at `beginRecording()` (phone wall clock) and tag
  the watch payload with its session start, to get rough alignment.
- **Fine (the good one): event-based anchoring on impact.** The wrist accel/gyro
  produces an unmistakable spike at ball impact; the pipeline already detects an
  **impact phase** (`phaseDetection.ts`). Align the two streams by matching the
  IMU impact spike to the pose impact frame. This sidesteps absolute clock
  alignment entirely and is robust to transfer latency. Bonus: the IMU impact is
  a near-ground-truth event that can *correct/confirm* the camera's impact frame,
  which then improves the very tempo the pipeline currently withholds.

## Data model (capture everything raw)

```ts
// new: packages/pose or lib types
export interface WatchImuReading {
  t: number;    // watch monotonic time (ms), for intra-stream spacing + impact-spike alignment
  ax: number; ay: number; az: number;  // user accel (G), gravity removed by CMDeviceMotion
  gx: number; gy: number; gz: number;  // rotation rate (rad/s) — gyroscope
  // optional: attitude quaternion qw,qx,qy,qz if cheap to include
  wornWrist: 'lead' | 'trail' | 'unknown'; // [ADDED AT RECOVERY]
}
```

**[ADDED AT RECOVERY]** Handedness × wear-wrist = 4 configurations; every derived
metric (impact, tempo, hinge proxy) depends on knowing which wrist wore the watch.

- **Persisted raw**, not just averaged (unlike `gravity_vector`): new
  `swings.watch_imu jsonb` holding the decimated stream (cap size like
  `motion_frames` does), plus a derived summary in `swing_debug.watch_imu`
  (peak angular velocity, impact index, tempo-from-IMU, sample count, watch model,
  whether a workout session was active). Excluded from default SELECTs if large,
  same as `pose_full`.

## Phased build path (when execution is greenlit)

1. **watchOS app target** in `ios/` — SwiftUI, minimal UI ("ready / recording /
   sent"). Pairs with the existing iOS app.
2. **Watch capture:** `HKWorkoutSession` + `CMBatchedSensorManager` → buffer →
   `WCSession.transferUserInfo`. Test on a real device pair (simulator can't do
   CoreMotion or watch pairing meaningfully).
3. **iOS native module / config plugin:** `WCSessionDelegate` on the phone,
   emit payload to JS. Mirror the existing native-module registration pattern
   (RTMW one-shot plugin, vision-camera plugin).
4. **JS capture hook:** `lib/useWatchImuCapture.ts` mirroring `useTiltCapture.ts`;
   detect pairing (`isPaired`/`isWatchAppInstalled`) and **no-op gracefully when
   absent**. Wire start/stop into `useSwingCapture.ts` beside tilt capture.
5. **Telemetry-only landing (validate first):** thread `watchImuReadings` into
   `analyzePoseSequence` and `persistSwing`; write raw stream + summary to
   `swing_debug.watch_imu` / new column. **No scoring impact yet.** Add a chart to
   the dev diagnostics (alongside the existing IMU/motion charts) to eyeball real
   swings. This is the "see the data before trusting it" gate.

### Phase 5.5 — Calibration consumer (first real use) **[ADDED AT RECOVERY]**

A single watch on the **coach/operator lead wrist** at a clinic. The impact
accelerometer spike is used as **ground truth** to validate
`HAND_LOW_TO_IMPACT_MS = 67` (`packages/domain/swing/phaseDetectionLegacy.ts`,
`app/clinic/coach-mode/signalCompute.ts`) and the phase-detection impact frame.
This calibration consumer comes **before** any user-facing derived metric.

6. **Derive + integrate (separate, later decision):** once real data confirms
   quality — impact-anchored sync, IMU-confirmed impact frame, tempo-from-IMU,
   peak swing speed. Each becomes its own scoped change; only then does it touch
   user-visible scoring/UI.

## Critical files (reference / to mirror — none modified in this doc)

- `lib/useTiltCapture.ts` — capture-hook pattern to mirror.
- `lib/useSwingCapture.ts` — `beginRecording()` / `finalizeCapture()` wiring points.
- `packages/domain/swing/analysisPipeline.ts` — `analyzePoseSequence` optional-sensor-arg entry.
- `packages/domain/swing/phaseDetection.ts` — impact phase, for event-based sync.
- `lib/persistSwing.ts` — averaging/persist pattern; where `watch_imu` attaches.
- `supabase/migrations/20260515183650_add_gravity_vector.sql` — migration precedent.
- `ios/honeyswing.xcworkspace` — where the watch target is added.
- Native plugin registration precedent: `ios/HoneyVisionCameraPosePlugin.swift`,
  RTMW one-shot plugin (`HoneyRtmwOneShotPlugin.swift`).

## Verification (per phase, when built)

- **Phase 2 (watch capture):** on a paired physical iPhone+Watch, log buffered
  sample count/rate to Xcode console; confirm ~200 Hz and gravity removed.
- **Phase 3–4 (bridge):** swing with watch on → confirm `useWatchImuCapture`
  receives a non-empty array; swing with no watch → confirm empty array, no error,
  identical behavior to today.
- **Phase 5 (telemetry):** record N swings, inspect `swing_debug.watch_imu` and the
  new dev chart; verify the IMU impact spike visually lines up with the pose impact
  frame (the sync hypothesis) before building anything on top of it.
- No new automated tests until a derived metric is added; then unit-test the
  derivation (impact detection, tempo-from-IMU) as pure functions like the existing
  `*.test.ts` domain tests.

## Open questions for the execution session

- Minimum watchOS version to support (gates `CMBatchedSensorManager` vs 100 Hz fallback).
- Distribution: a paired watchOS app ships with the iOS app but needs App Store
  Connect setup — confirm provisioning before building.
- Storage budget: cap/decimate the raw `watch_imu` stream (follow `motion_frames`
  compaction) vs. store full-rate.
