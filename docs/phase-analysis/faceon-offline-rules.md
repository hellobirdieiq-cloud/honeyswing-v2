# Face-On Offline Phase Rules

> **⚠️ RETIRED (2026-07-16, T9-70).** The script this doc describes,
> `scripts/export-faceon-phase-analysis.ts`, was deleted — it was a 1,512-line
> stale parallel reimplementation of the detector (36fps-era constants, drifted
> impact rule) whose replay reports could no longer be trusted. This doc is
> kept as the historical record of the rules it implemented. Future replay
> tooling builds on the REAL detector via the shared scaffold (`scripts/lib/`)
> instead of reimplementing rules.

Canonical rules for the retired `scripts/export-faceon-phase-analysis.ts`. This was **research tooling**, not production. The script did not import production phase code; it reimplemented the rules below from scratch and wrote CSV-only output.

## Why this exists

Production phase detection (`packages/domain/swing/phaseDetection.ts`) uses a wrist-midpoint signal tuned for DTL captures. The 5 face-on candidate swings store `camera_angle="side"` and `swing_debug.phases=NULL` because foreshortening's `estimateAngleDegrees()` returns 75–89° regardless of true geometry — `avgSpread` is systematically under-detected vs. the 0.30 reference. We need a face-on-specific rule set we can iterate on offline without disturbing production.

## Dataset

Hardcoded 5 swing IDs in the script. Each swing's `motion_frames` is read from Supabase (`swings.motion_frames`). Nothing else is read or written.

## Joint coordinate conventions

- `x`, `y`: normalized 0–1 (image-space).
- `z`: optional signed depth offset.
- `confidence`: optional, 0–1; we floor at 0.5 for any signal that uses the joint.
- All joints come from MediaPipe BlazePose via `packages/pose/PoseTypes.ts`.

## Framerate scaling

All thresholds are stored as **milliseconds**. At runtime, the script measures fps per swing:

```
fps = 1000 / median(diff(timestampMs))
```

(Median resists single-frame jitter; defaults to 36 fps if dt array is degenerate.) Frame counts are then derived from ms via:

```
framesFor(ms, fps) = max(1, round(ms * fps / 1000))
```

This keeps the same script working at the current 36 fps `motion_frames` and the future 120 fps pipeline.

| Constant | ms | 36 fps frames | 120 fps frames | Spec wording |
|---|---|---|---|---|
| `BASELINE_MS` | 833 | 30 | 100 | "frames 1–30" |
| `SUSTAIN_MS` | 333 | 12 | 40 | "12 consecutive frames" |
| `ADDRESS_LOCK_MS` | 833 | 30 | 100 | "address frames 0–30" |
| `RISE_DELTA_MS` | 83 | 3 | 10 | "3-frame delta" |
| `RISE_SUSTAIN_MS` | 111 | 4 | 13 | "4+ frames" |
| `TOP_SMOOTH_MS` | 83 | 3 | 10 | (smoothing window) |
| `TOP_CONFIRM_HALFWINDOW_MS` | 139 | 5 | 17 | "±5 frames" |
| `ENDFS_SMOOTH_MS` | 139 | 5 | 17 | "5-frame rolling average" |
| `ENDFS_PRERISE_MS` | 556 | 20 | 67 | "20 frames of rising x" |

`BASELINE_LOWEST_RATIO = 2/3` (spec: "20 lowest values" out of 30 = 67%).

## Rule 1 — Swing start

**Signal**: per-frame velocity for `rightWrist`, `leftWrist`, `leftShoulder`, computed by 3-point central difference on `(x, y)` with `dt` from `timestampMs`. Velocity is set to NaN when any of the three frames `i-1, i, i+1` has joint confidence < 0.5. The 3-signal average requires ≥ 2 of 3 non-NaN values per frame.

**Algorithm**:
1. Take the first `framesFor(BASELINE_MS, fps)` frames as the baseline window.
2. Baseline = mean of the lowest `floor(BASELINE_LOWEST_RATIO * baselineWindow)` non-NaN values.
3. Trigger threshold = `2.5 * baseline`. Confirm threshold = `10 * baseline`.
4. For each candidate `i ≥ baselineWindow`, require:
   - `signal3[i] > 2.5 * baseline`
   - All `signal3[i .. i + sustain - 1]` exceed `2.5 * baseline` where `sustain = framesFor(SUSTAIN_MS, fps)`
   - Mean over the same window exceeds `10 * baseline`
5. First `i` satisfying all three is `detected_swing_start_frame`. Else null with a failure reason.

**Diagnostics**:
- `baseline_likely_contaminated` is set when `(min(baseline_window) - mean(baseline_window)) / mean > -0.3`. This means there's no clean low-floor in the baseline — early motion has pulled the mean up to where the lowest values aren't meaningfully lower than the average. A practical sign that the swing started before frame `framesFor(833, fps)`.

## Rule 2 — Impact

**Signals**:
- Crossing signal: `rightWrist.x` directly, **with no confidence floor** (whatever the pose tracker emits, even at confidence < 0.5; only NaN when the joint is entirely missing). This deviates from the velocity signals — those still use the 0.5 confidence floor. The motivation: under motion blur, the wrist position is still tracked roughly even when confidence drops, and the alternative (filtering it out) loses the crossing entirely.
- `foot_ref_x` = **median** of `(leftHeel.x + leftAnkle.x) / 2` across the address-lock window (first `framesFor(ADDRESS_LOCK_MS, fps)` frames where both joints ≥ 0.5). Median (not mean) for robustness to single-frame jitter.

(The `hand_avg_x` and `hand_avg_x_raw` columns in the per-frame CSV are kept for visual comparison but are no longer used by the impact rule.)

**Algorithm**:
1. Find smallest `i > swing_start` where `rightWrist.x[i-1] < foot_ref_x` and `rightWrist.x[i] >= foot_ref_x` (left-to-right crossing for a right-handed face-on capture; lefty support is out of scope here).
2. Rise-rate gate: for each candidate, every `k` in `[i - sustainFrames + 1 .. i]` must satisfy
   `rightWrist.x[k] - rightWrist.x[k - deltaFrames] >= 0.03`,
   where `deltaFrames = framesFor(RISE_DELTA_MS, fps)` and `sustainFrames = framesFor(RISE_SUSTAIN_MS, fps)`. Reject and continue if not sustained.
3. Apply timing correction (piecewise, ms-logged):
   ```
   correctionFrames = fps < 70 ? 1 : 2
   correctionMs = -correctionFrames * 1000 / fps
   correctedIdx = max(0, candidateIdx + round(correctionMs * fps / 1000))
   ```
   The script logs both `impact_correction_frames` and `impact_correction_ms` to the summary CSV. The 70 fps split is a single-point boundary between the 36 and 120 calibration points; if a 60 or 90 fps capture appears later, this boundary needs revalidation.

**Allowed degradation**: when `rightThumb` confidence is unreliable for a swing (mostly NaN), the script falls back to `hand_avg_x = rightWrist.x` and sets `impact_thumb_fallback: true` in the summary CSV.

**NaN-gap interpolation**: after `hand_avg_x` is computed, gaps of ≤ `HAND_AVG_X_MAX_INTERPOLATE_FRAMES` (10 frames) are linearly interpolated between their finite anchors. Gaps > 10 frames stay NaN. Edge gaps (no anchor on one side) stay NaN. This is the only frame-count constant in the script that is not derived from ms — pose-tracking confidence dropouts are per-frame events under motion blur, not time events. Applied only to `hand_avg_x`; velocity signals are NOT interpolated. The count of filled frames per swing is logged to the summary CSV as `hand_avg_x_interpolated_frames`.

## Rule 3 — Top of backswing

**Signal**: `rightWrist` velocity (same per-frame velocity from Rule 1), then a centered rolling mean of width `framesFor(TOP_SMOOTH_MS, fps)` to suppress single-frame noise.

**Algorithm**:
1. Define swing arc as `[swing_start, impact]`. If either is null, skip.
2. Search window: 25%–80% of arc by frame count.
3. Take the index of minimum smoothed `rightWrist` velocity in the window — this is `detected_top_frame`.
4. Confirmations within `±framesFor(TOP_CONFIRM_HALFWINDOW_MS, fps)` (advisory, not gate):
   - `rightWrist.z` argmax inside the window → `top_z_confirm: true`
   - `leftShoulder.x` argmin inside the window → `top_shoulder_x_confirm: true`

**Z confirmation is advisory** because `NormalizedJoint.z` is optional. If z is missing for a swing, `top_z_confirm` will be false but the top index is still reported.

## Rule 4 — End of forward swing

**Signal**: `rightShoulder.x` 5-frame rolling mean (`framesFor(ENDFS_SMOOTH_MS, fps)`). Frames where raw `rightShoulder.x > 1.10 * rolling_mean_at_that_point` are marked excluded (spec: "exclude frames >10% above rolling average") — they're skipped in both the rolling-mean re-window and the plateau test, and flagged as `rightShoulder_x_excluded=true` in the per-frame CSV.

**Algorithm**:
1. Search starts at `impact + framesFor(ENDFS_SMOOTH_MS, fps)`.
2. Pre-rise gate: rolled `rightShoulder.x` over the prior `framesFor(ENDFS_PRERISE_MS, fps)` frames must be mostly monotone increasing (≤ 2 dips allowed).
3. Plateau test: the next `framesFor(ENDFS_SMOOTH_MS, fps)` frames satisfy `|rolled[j] - rolled[k]| < ENDFS_PLATEAU_TOL` (= 0.005 normalized x units).
4. First `k` satisfying both is `detected_end_forward_swing_frame`; else null with `end_fs_failure_reason`. No fallback to last frame.

## Phase labels (per-frame)

The CSV `phase_label` column comes from frame index ranges across the 4 markers, with degradation when markers are null:

| Range | Label |
|---|---|
| `0` to `swing_start - 1` | `address` |
| `swing_start` to `top - 1` | `backswing` |
| `top` to `impact - 1` | `downswing` |
| `impact` to `end_fs - 1` | `forward_swing` |
| `end_fs` to last | `finish` |

If any marker is null, the preceding label runs forward to the next valid marker. If all markers are null, every frame is `unknown`.

## CSV outputs

`exports/faceon-phase-analysis/per-frame-signals.csv` (one row per frame, all 5 swings concatenated):

- `swingId, frameIndex, timestampMs, fps_estimate`
- Joint columns: `rightWrist_{x,y,z,confidence}`, `leftWrist_{x,y,confidence}`, `leftShoulder_{x,y,confidence}`, `rightShoulder_{x,y,confidence}`, `rightThumb_{x,confidence}`, `leftHeel_{x,confidence}`, `leftAnkle_{x,confidence}`
- Derived signals: `rightWrist_velocity, leftWrist_velocity, leftShoulder_velocity, signal3_avg, hand_avg_x, foot_ref_x, rightShoulder_x_rolled, rightShoulder_x_excluded`
- Detected markers (repeated on every row): `detected_swing_start_frame, detected_top_frame, detected_impact_frame, detected_end_forward_swing_frame`
- `phase_label`

`exports/faceon-phase-analysis/phase-summary.csv` (one row per swing): all detected indices, ms timestamps, fps, baseline, foot reference stddev, failure reasons, joint-coverage means, marker-ordering invariant.

## Manual verification protocol

Open `per-frame-signals.csv` in a spreadsheet and plot:

1. **Swing start**: `signal3_avg` vs `frameIndex`. Confirm a clear baseline floor in frames 0–30, then a sustained spike at `detected_swing_start_frame`.
2. **Impact**: `hand_avg_x` vs `frameIndex` with `foot_ref_x` as a horizontal line. Confirm crossing near `detected_impact_frame` (corrected — actual crossing is 1–2 frames later).
3. **Top**: `rightWrist_velocity` vs `frameIndex`. Confirm a velocity dip near `detected_top_frame` between `swing_start` and `impact`.
4. **End forward swing**: `rightShoulder_x_rolled` vs `frameIndex`. Confirm a clear rise during follow-through, then a plateau starting at `detected_end_forward_swing_frame`.

Repeat for at least 2 of the 5 swings. The script does not produce charts (no charting libs in `package.json`).

## Known limitations

1. **No ground truth.** No swing in the dataset has labeled phase indices. This script's output IS the proposed face-on phase definition — it is not a comparison against a known answer.
2. **Right-handed only.** The hand-x crossing logic assumes a right-handed swing facing the camera. Lefty face-on captures need a sign flip (out of scope for v0).
3. **Z is optional.** `rightWrist.z` confirmation for top-of-backswing silently degrades when the model doesn't emit z.
4. **fps scaling at 120 fps is untested.** All thresholds were calibrated against 36 fps `motion_frames`. The 120 fps frame counts in the table above are arithmetic projections; biomechanical validity at 120 fps needs separate verification once that data exists.
5. **Single-point fps boundary.** Impact correction switches at 70 fps. A 60 or 90 fps capture would force re-validation of the boundary.
6. **No production drift.** The script intentionally duplicates velocity/smoothing logic from `phaseDetection.ts` instead of importing it, so this research can iterate without bumping production semantics.
