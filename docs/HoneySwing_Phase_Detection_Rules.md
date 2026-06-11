# HoneySwing Phase Detection Rules — All Camera Angles

**Version:** Session 90 (2026-05-11)
**Status:** DTL N=4 validated. Face-on N=2 validated. All rules provisional until clinic.
**Next gate:** Dave clinic + 10+ swings per angle across 3+ golfers.
**Data source:** `motion_frames[i].joints.*` for all new rules. `trail_points` for existing pipeline rules.

---

## Camera angle context

| Angle | DB value | Status | Primary signal axis |
|---|---|---|---|
| DTL (trail side) | `camera_angle: "front"` ⚠️ inverted label | Primary — all rules validated | Hip x-spread, lead wrist x |
| Face-on | `camera_angle: "side"` ⚠️ inverted label | Secondary — N=2 validated | Wrist velocity, wrist z, shoulder x |

**⚠️ DB label inversion:** `camera_angle` field is inverted from plain English. Use `angle_gating.bucket` instead — reads `"dtl"` or `"front"` correctly.

---

## Shared setup

```
ms_per_frame = duration_ms / frame_count
```

All time-based thresholds compute frames dynamically — never hardcode frame counts.
At 120fps: `frames = round(milliseconds / (1000 / fps))`

---

# DTL Rules

## DTL Phase 0 — Swing start

**Signal:** Hip rotation velocity (`dSpreadX`)
**Biomechanical basis:** Proximal-to-distal — pelvis fires first (TPI + ASMI consensus)
**Validated:** N=4, adult male RH + youth female LH
**Status:** PROVISIONAL

```
// Baseline — first 10 frames, golfer standing still
baseline = mean(|dSpreadX[i]|) for i in 0..9
  where dSpreadX[i] = (leftHip.x - rightHip.x)[i] - (leftHip.x - rightHip.x)[i-1]

hard_threshold  = max(baseline × 3, 0.002)
watch_threshold = max(baseline × 2, 0.0015)

watchMode = false; watchTimeout = 0

for each frame F (starting at frame 3):
  spreadX      = leftHip.x - rightHip.x
  midX         = (leftHip.x + rightHip.x) / 2
  spreadX_rise = spreadX[F] - spreadX[F-3] > 0.003
  midX_drift   = |midX[F] - midX[F-3]| > 0.004

  if spreadX_rise OR midX_drift: enter watchMode, watchTimeout = 5
  decrement watchTimeout; if ≤ 0: exit watchMode

  threshold = watchMode ? watch_threshold : hard_threshold

  if dSpreadX[F] > threshold AND dSpreadX[F+1] > 0:
    swing_start = F - 1
    break
```

**Validated results:**

| Swing | Golfer | Baseline | Hard threshold | Start frame | Pipeline addr | Error |
|---|---|---|---|---|---|---|
| a7a310fe | Adult male RH | 0.0004 | 0.002 | f66 | f71 | −5 |
| 6ea31cb0 | Adult male RH | 0.0010 | 0.003 | f44 | f52 | −8 |
| e4297195 | Youth female LH | 0.0006 | 0.002 | f25 | f4 | +21 pipeline error |
| 9148f404 | Youth female LH | 0.0012 | 0.004 | f24 | f11 | +13 pipeline error |

**Notes:**
- Works in raw image space — canonical transform not needed
- Works for both handedness in DTL raw space
- `EXTERNAL ASSUMPTION` — multipliers 3x/2x, floors 0.002/0.0015

---

## DTL Phase 1 — True address

**Signal:** Spine variance + head delta + trail knee variance
**Source:** V3 rules — validated on 3 of 4 DTL swings
**Status:** MEDIUM-HIGH reliability

```
// Scan BACKWARD from topIdx - 20
for each 8-frame window ending at W:
  spine_var = max(spineAngle[W-7..W]) - min(spineAngle[W-7..W]) < 1.5°
  head_ok   = ALL |headDelta[i]| < 0.006 for i in W-7..W
  knee_var  = max(trailKnee[W-7..W]) - min(trailKnee[W-7..W]) < 2.0°
  if all three pass: trueAddressFrame = W; break

fallback: trueAddressFrame = phaseIndex.address, reliability = LOW
```

**Notes:**
- `topIdx - 20` cap prevents false match at top-of-backswing pause
- Head threshold 0.006 — 0.005 fails on validated swing 77b49def
- Trail knee: `rightKnee` RH, `leftKnee` LH

---

## DTL Phase 2 — Takeaway

**Signal:** Wrist midpoint x directional gate (canonical space)
**Status:** SHIPPED — commit `7c54e4b`

```
// DIRECTION_FRAMES = 20 (~167ms at 120fps)
// DIRECTION_THRESHOLD = 0.002
// MAX_ADDRESS_FRACTION = 0.6

Δx = wristMidpoint.x[F] - wristMidpoint.x[F - DIRECTION_FRAMES]
if Δx > 0 for DIRECTION_FRAMES consecutive: takeawayIdx = F
```

---

## DTL Phase 3 — Top of backswing

**Signal:** Lead wrist X minimum (raw image space)
**Status:** PROVISIONAL

```
searchStart = swing_start + round(200 / ms_per_frame)
searchEnd   = swing_start + round(2000 / ms_per_frame)

MIN_TRAVEL           = 0.04
// EXTERNAL ASSUMPTION — N=1 observation (5-frame gap f39→f44 × 2 safety).
// Re-calibrate at Clinic 2 with raw wrist X traces.
MIN_LOOKAHEAD_FRAMES = 10

// Lead wrist = leftWrist RH, rightWrist LH
for each frame F in [searchStart .. searchEnd]:
  lWx = leadWrist.x[F]
  if lWx < lWx[F-1]
    AND lWx < lWx[F+1]
    AND lWx[F+1] < lWx[F+2]
    AND lWx < (max(lWx[searchStart..F]) - MIN_TRAVEL)
    // Lookahead guard: reject candidate if a deeper minimum exists
    // within MIN_LOOKAHEAD_FRAMES — guards against transient dips
    // before the true top (validated: swing 075d79a6, f39→f44 gap).
    AND NOT (∃ k in 1..MIN_LOOKAHEAD_FRAMES where
             F + k ≤ searchEnd AND lWx[F+k] < lWx[F])
    → top = F; break
```

**Validated:**
- Swing 2: f83 (pipeline f84) ✓
- Swing 3: f61 (pipeline f63) ✓
- Swing 1 (075d79a6): without guard fires at f39 (false min, lw_x=0.1878); with guard advances to true min f44 (lw_x=0.1274). 5-frame gap.

---

## DTL Phase 4 — Impact

**Signal:** Combined wrist Y maximum + 67ms offset
**Biomechanical basis:** Hand low point occurs ~67ms before ball contact
**Status:** PROVISIONAL

```
searchStart = top_frame + round(100 / ms_per_frame)
searchEnd   = top_frame + round(1500 / ms_per_frame)

combinedY[F] = leadWrist.y[F] + trailWrist.y[F]

// Highest-peak scan — take the frame with MAXIMUM combinedY in the
// full window, not the first local peak. Guards against early
// transient peaks that latch a false hand-low (validated: swing 1,
// first peak f60=0.7347 vs true peak f71=0.8964, 11-frame gap).
hand_low_frame = argmax(combinedY[F]) for F in [searchStart..searchEnd]

// EXTERNAL ASSUMPTION — adult 67ms, youth unvalidated
HAND_LOW_TO_IMPACT_MS = 67
impact_frame = hand_low_frame + round(HAND_LOW_TO_IMPACT_MS / ms_per_frame)
```

**Validated:**
- Swing 2: f97 ✓
- Swing 3: f77 (velocity spike confirms) ✓
- Swing 1 (top f54): first-peak scan picks f60 (combinedY=0.7347); max-peak scan picks true peak f71 (0.8964). 11-frame gap.

---

## DTL Phase 5 — Finish

**Signal:** Wrist midpoint velocity drops to near-zero
**Window:** 3x downswing duration (self-scaling to swing tempo)
**Status:** PROVISIONAL

```
downswing_ms = (impact_frame - top_frame) × ms_per_frame
search_end   = min(impact_frame + round((downswing_ms × 3.0) / ms_per_frame), total_frames - 1)
min_follow   = round(300 / ms_per_frame)

midX[F] = (leadWrist.x[F] + trailWrist.x[F]) / 2
midY[F] = (leadWrist.y[F] + trailWrist.y[F]) / 2
velXY[F] = sqrt((midX[F]-midX[F-1])² + (midY[F]-midY[F-1])²)

finish = first frame F in [impact + min_follow .. search_end] where:
  velXY[F] < 0.008 AND velXY[F+1] < 0.008 AND velXY[F+2] < 0.008

if no finish found:
  finish = search_end
  follow_through_complete = false
```

**Validated:** Swing 3: f88, ~253ms after impact ✓

---

# Face-On Rules

## Face-On Phase 0 — Swing start

**Signal:** 3-joint velocity average (rightWrist + leftWrist + leftShoulder)
**Validated:** N=2 swings (3b035cd6, c6860ce5)
**Status:** PROVISIONAL

```
// Velocity per frame
vel[joint][F] = sqrt((joint.x[F]-joint.x[F-1])² + (joint.y[F]-joint.y[F-1])²)
avg[F] = mean(vel[rightWrist][F], vel[leftWrist][F], vel[leftShoulder][F])

// Baseline = 20 lowest avg values from frames 1–30
baseline = mean(20 lowest values of avg[1..30])

// EXTERNAL ASSUMPTION
TRIGGER_MULTIPLIER = 2.5
SUSTAIN_MULTIPLIER = 10.0
SUSTAIN_FRAMES = round(330 / ms_per_frame)  // ~330ms at any fps

// Swing start = first frame where:
avg[F..F+SUSTAIN_FRAMES] ALL > baseline × TRIGGER_MULTIPLIER
AND mean(avg[F..F+SUSTAIN_FRAMES]) > baseline × SUSTAIN_MULTIPLIER
→ swing_start = F
```

**Results:** 3b035cd6: f61 ✓ · c6860ce5: f47 ✓

**Notes:**
- Waggle edge case untested — add reset: if velocity drops below threshold within 5 frames, discard and keep searching
- Different from DTL (hip spread) — hip x-spread not visible from face-on

---

## Face-On Phase 1 — True address

**Status:** NOT VALIDATED face-on. Use pipeline address as fallback.

---

## Face-On Phase 2 — Takeaway

**Signal:** Wrist midpoint x directional gate — same as DTL
**Status:** SHIPPED — same canonical transform works both angles

---

## Face-On Phase 3 — Top of backswing

**Signal:** rightWrist velocity minimum + rightWrist z maximum + leftShoulder x minimum
**Validated:** N=1 confirmed (3b035cd6), N=1 estimated (c6860ce5)
**Status:** PROVISIONAL

```
// Search window
from = swing_start + round(25% × (impact - swing_start) × ms_per_frame)
to   = impact - round(20% × (impact - swing_start) × ms_per_frame)

// Three signals
vel_min_fi = frame of rightWrist velocity MINIMUM in [from..to]
z_max_fi   = frame of rightWrist z MAXIMUM within ±5 frames of vel_min_fi
             (z most positive = wrist furthest behind body = top)
ls_min_fi  = frame of leftShoulder x MINIMUM within ±5 frames of vel_min_fi
             (shoulder stops rotating trail-side = TPI definition)

if all three within 5 frames of each other:
  top = round(mean(vel_min_fi, z_max_fi, ls_min_fi))
else:
  top = vel_min_fi  // best single signal
```

**Signal quality ranking:**
1. rightWrist z maximum — cleanest, peaks at +0.23 at top, no ambiguity
2. rightWrist velocity minimum — clear valley
3. leftShoulder x minimum — TPI-validated, confidence ~0.9999
4. rightWrist confidence minimum — lags 4-9 frames, use as check only

**Results:** 3b035cd6: f85-87 confirmed (algorithm: f91, within 4 frames) ✓

---

## Face-On Phase 4 — Impact

**Signal:** Speed-banded lead-wrist (`leftWrist`) Y-arc-bottom — `detectFaceOnImpact` (`packages/domain/swing/phaseDetectionFaceOn.ts:152-194`). No foot reference, no handedness, no trail hand: only `leftWrist` (`:162-163, :185`).
**Validated:** via `scripts/testLeadWristImpact.ts` — T=0.90: +9 recoveries on impact_search_bounds, 1 regression (`phaseDetectionFaceOn.ts:143-144`).
**Status:** PROVISIONAL — **KNOWN BIAS** (see below).

```
// Constants (phaseDetectionFaceOn.ts:148-150)
IMPACT_SPEED_LOOKBACK  = 3      // frames; 2D leftWrist displacement window
IMPACT_PEAK_PERCENTILE = 0.95   // robust max (ignores a single noisy spike)
IMPACT_BAND_THRESHOLD  = 0.9    // band = speed >= threshold * peak

// 1. Lead-wrist 2D speed, 3-frame lookback (phaseDetectionFaceOn.ts:160-168).
//    speed[0..2] = 0; speed[f] = 0 when either frame's leftWrist is missing.
speed[f] = hypot(leftWrist.x[f] - leftWrist.x[f-3],
                 leftWrist.y[f] - leftWrist.y[f-3])

// 2. Robust peak = 95th-percentile speed: sort asc, index floor(0.95*n) (:170-173).
peak  = sorted_speed[ floor(IMPACT_PEAK_PERCENTILE * n) ]

// 3. High-speed band, then arc bottom = MAX leftWrist.y within band (:176-191).
//    y is top-down 0..1, so max y = the LOWEST point of the wrist arc. Banding
//    keeps the search out of slow address/finish regions where a global y-max lands.
floor  = IMPACT_BAND_THRESHOLD * peak
impact = argmax_f { leftWrist.y[f] : speed[f] >= floor }
```

**Returns:** `{ frame, reliability: "medium" }` (`phaseDetectionFaceOn.ts:193`); `null` when `n === 0`, `peak <= 0`, or no band frame has a valid `leftWrist.y` (`:159, :174, :192`).

**KNOWN BIAS:** fires at the lead-wrist **arc-bottom**, which precedes true contact. Measured **3.6 frames early (~60 ms at 60 fps)** on swing 81f0b197 (eyeballed ground truth 137.6 vs detected 134). **No lag correction applied** — unlike DTL Phase 4's 67 ms `HAND_LOW_TO_IMPACT_MS` term. A fixed lag constant was **considered and REJECTED**: lag varies with swing speed.

### Under evaluation (NOT shipped)

**(a) Lead-thumb-line vertical crossing** — `dx = thumb_tip.x − thumb_CMC.x` (COCO-WholeBody left-hand indices 95, 92) sign flip; take the **LAST** crossing in `[top, follow_through]`, **not the first** (8/13 RH swings have multiple crossings — an early transition-wobble crossing right after `top` confounds first-crossing). Matched ground truth on 81f0b197 (**137.5 vs 137.6**) and historically corroborates c6860ce5 f92. **CAVEATS:** requires a valid `top`/`follow_through` window (3 swings without a stored `top` produced garbage, crossings at 122–235); 2 unexplained outliers (a761da0e −22.75, 4b47009e +32.77) not yet eyeballed; constants `conf ≥ 0.4` and the 2-frame hold are `EXTERNAL ASSUMPTION`. Validation data: `scripts/output/thumb_crossing_validation.json`.

**(b) Two-wrist x crossing** — **TESTED AND REJECTED** on 81f0b197: the wrists are ~55 px apart through contact (`wristDx = rightWrist.x − leftWrist.x` runs −53→−36 across frames 134–141), with **no zero-cross in the impact band**. Nearest crossings are early-downswing rotation (~127) and follow-through noise (~143, 5.4 frames late). Label-swap invariant (a L/R wrist swap only flips `wristDx`'s sign — crossing frames are identical). Data: `scripts/output/wrist_crossing_81f0b197.json`.

### SUPERSEDED (replaced — see in-code comment `phaseDetectionFaceOn.ts:144-145`)

> The trail-hand X-rise-vs-foot-reference rule below shipped previously and was replaced because it "keyed off the wrong hand/axis for face-on" (`phaseDetectionFaceOn.ts:145`). Preserved for its N=2 historical validation.

**Signal:** Hand/foot x crossing (hand crosses lead foot reference line)
**Validated:** N=2, strongest rule in (old) face-on set

```
// Lock foot reference at address — NEVER update during swing
foot_ref = mean((leftHeel.x + leftAnkle.x) / 2) for frames 0..30

// Trail hand average — right hand for RH, left hand for LH
hand_avg[F] = (trailWrist.x[F] + trailThumb.x[F]) / 2

// Committed downswing rise
rise_rate[F] = hand_avg[F] - hand_avg[F-3]
rise_active  = rise_rate > 0.03 sustained for round(110 / ms_per_frame) frames

// Impact
crossing_frame = first frame where rise_active AND hand_avg[F] >= foot_ref
lag_frames = round(27 / ms_per_frame)  // landmark lag correction
impact = crossing_frame - lag_frames
```

**Results:** 3b035cd6: f105 ✓ · c6860ce5: f92 ✓ (confirmed by velocity spike + thumb zero crossing)

**Notes:**
- Trail hand = rightWrist + rightThumb for RH — most confident joints through impact
- Lock foot at address — live foot position drifts ±0.005 with weight shift
- Flag swings where lead foot x moves >0.01 from address (dramatic lunge)
- Coaching use: hand crosses foot early = ball too far forward; late = too far back
- `EXTERNAL ASSUMPTION` (SUPERSEDED with detector) — 27ms lag correction, 0.03 rise rate, 110ms sustain

---

## Face-On Phase 5 — Finish

**Signal:** Trail shoulder x rolling average plateau
**Validated:** N=2
**Status:** PROVISIONAL

```
// 5-frame rolling average of trailShoulder.x (rightShoulder for RH)
// Exclude frames where value exceeds rolling avg by >10% (jitter filter)

plateau = highest clean 5-frame rolling average in swing
confirm = plateau preceded by round(550 / ms_per_frame) frames of rising x

finish = first frame where rolling average reaches plateau value
```

**Post-impact zones (from real data):**
- Impact → ~330ms: follow-through rotation, shoulder moving forward fast
- ~330ms → ~550ms: finish position plateau
- ~550ms+: relaxation, slowly drifting back

**Results:** 3b035cd6: f124 ✓ · c6860ce5: f118 ✓

**Notes:**
- If golfer loses balance and never holds finish, plateau still forms at arc peak — correct biomechanical event, flag `held_finish_duration` separately as balance metric

---

# Summary

| Phase | DTL signal | Face-on signal | Shared? |
|---|---|---|---|
| 0 — Swing start | Hip dSpreadX | 3-joint velocity avg | No |
| 1 — True address | Spine+head+knee window | Not validated | No |
| 2 — Takeaway | Wrist midX directional gate | Same | Yes ✓ |
| 3 — Top | Lead wrist X minimum | Wrist vel min + Z max + shoulder | No |
| 4 — Impact | Combined wrist Y max + 67ms | Lead-wrist speed-band arc-bottom (`leftWrist.y` max) — foot-crossing SUPERSEDED | No |
| 5 — Finish | velXY < 0.008 × 3 frames | Trail shoulder x plateau | No |

---

# External assumptions — validate at clinic

| Constant | Value | Phase | Angle |
|---|---|---|---|
| Swing start hard multiplier | 3x | DTL 0 | DTL |
| Swing start watch multiplier | 2x | DTL 0 | DTL |
| MIN_TRAVEL | 0.04 | DTL 3 | DTL |
| MIN_LOOKAHEAD_FRAMES | 10 | DTL 3 | DTL |
| HAND_LOW_TO_IMPACT_MS | 67ms | DTL 4 | DTL |
| Follow-through multiplier | 3.0x downswing | DTL 5 | DTL |
| Follow-through floor | 300ms | DTL 5 | DTL |
| DTL velocity noise floor | 0.008 | DTL 5 | DTL |
| Face-on trigger multiplier | 2.5x | Face-on 0 | Face-on |
| Face-on sustain multiplier | 10x | Face-on 0 | Face-on |
| Face-on sustain window | 330ms | Face-on 0 | Face-on |
| Face-on top 5-frame window | ±5 frames | Face-on 3 | Face-on |
| Impact lag correction | 27ms | Face-on 4 — SUPERSEDED with detector | Face-on |
| Rise rate threshold | 0.03 | Face-on 4 — SUPERSEDED with detector | Face-on |
| Rise sustain | 110ms | Face-on 4 — SUPERSEDED with detector | Face-on |
| Impact speed lookback | 3 frames | Face-on 4 (shipped) | Face-on |
| Impact peak percentile | 0.95 | Face-on 4 (shipped) | Face-on |
| Impact band threshold | 0.9 × peak | Face-on 4 (shipped) | Face-on |
| Shoulder plateau filter | >10% exclusion | Face-on 5 | Face-on |
| Shoulder plateau confirm | 550ms rising | Face-on 5 | Face-on |

---

# Known failure modes

| Failure | Condition | Mitigation |
|---|---|---|
| Pipeline address too early | Clip starts mid-action | DTL Phase 0 fixes |
| Noisy knee on bad capture | f660b0c6 pattern | Fallback to pipeline, flag LOW |
| Clip ends before finish | Short recording | follow_through_complete = false |
| Kid keeps spinning | No deceleration | 3x window cutoff, mark incomplete |
| Wrong handedness in DB | Recorded as wrong hand | DTL Phase 0 works in raw image space |
| Face-on misclassified as DTL | camera_angle ~71-73° | Classifier bug — separate fix |
| Pipeline fails completely | temporal_inversion, ratio check | Swing c6860ce5 — our rules still found phases |
| Camera drift mid-swing | Swing 1290eb6e (80° drift) | Flag z_range outliers, exclude from calibration |
