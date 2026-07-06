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

**Primary signal:** xCross CONSENSUS — a geometric consensus anchor refined by a sub-frame thumb crossing — `computeFaceOnImpactConsensus` (`packages/domain/swing/faceOnImpactConsensus.ts`), selected in `selectFaceOnImpact` (`phaseDetectionFaceOn.ts`). Ported from the validated viewer prototype (`impactRule.ts`, 6/6 on verified RH swings, avg|Δ| 0.43 frames, max 1.0).
**Fallback signal:** Speed-banded lead-wrist (`leftWrist`) Y-arc-bottom — `detectFaceOnImpact` (`phaseDetectionFaceOn.ts`).
**Status:** SHIPPED + LIVE for **both handedness** (DB-verified 2026-07-05: lefty swings c0b3febe / 9316f27b persist `impact_source: 'consensus'`, `analysis_version: 'v2'`). Runs in **pre-canonical (unmirrored, normalized)** space — the same x-sign space the rule was validated in; the canonical mirror would negate the x-signs. LH negates them explicitly via `signFlip = -1`; the LH gate was removed once the sign path validated.

```
// Pipeline (faceOnImpactConsensus.ts; constants under EXTERNAL_ASSUMPTIONS.faceOn.impact.consensus)
footPick / S2 / S3  — anchor-free geometric signals over [lo,hi] (gated wrist-below-shoulder)
                      S2 = arm-vertical, S3 = wrist-lowest, footPick = wrist-over-foot (seed only)
provAnchor          = round(median(available{footPick, S2, S3}))
S1 = xCross         = sustained neg→pos crossing of g = signFlip·(betterConfWristX − feetMidX),
                      nearest provAnchor within ±radius
consensus           = median/avg over available{S1, S2, S3}
thumb refine        = sustained neg→pos crossing of dx = signFlip·(thumbTipX − thumbBaseX)
                      within ±refineRadius of round(consensus)
FINAL               = thumb sub-frame if it qualifies, else consensus, else null
```

> The earlier standalone LAST-crossing thumb detector (`detectFaceOnThumbCrossing`) no longer feeds the live impact. Ordinal crossing selection was shown to pick post-impact noise on real swings (dec6edd1: LAST-crossing picked post-impact noise, forcing the arc-bottom fallback = 117; the true crossing was 119.5 — 2nd of 4 — against viewer ground truth 120); the consensus's thumb-refine instead selects the crossing **nearest the consensus anchor**.

**Selection precedence (`selectFaceOnImpact`, `phaseDetectionFaceOn.ts`):**
1. **Test override** (`impactOverride`, testLeadWristImpact seam) → arc-bottom, `impact_fallback_reason: "override"`.
2. **No pre-canonical frames / consensus not computed** → arc-bottom, `"no_precanonical"`.
3. **Consensus resolved to null** (0 geometric signals available) → arc-bottom, `"no_signals"`.
4. Otherwise **CONSENSUS** — PRIMARY for RH **and** LH (`impact_source: "consensus"`, `reliability.impact = "high"`, downgraded to `"medium"` on a cross-check mismatch). Every arc-bottom fallback carries `reliability.impact = "low"`.

`impact_fallback_reason: "lh_ungated"` is **DEPRECATED** — no longer produced since the LH gate was removed (last persisted `lh_ungated` rows 2026-06-23); the union member survives only for historical rows (`phaseDetectionShared.ts`).

The consensus window is takeaway/top-anchored; the **provisional arc-bottom** impact still bounds `detectFaceOnTop`/`detectFaceOnFinish`, and the consensus FINAL then becomes the final impact. A swing with no detectable `top` exits earlier via the `top_search_bounds` gate (→ mid-frame fallback).

**Cross-check (never silently trusts either):** `swing_debug.phase_rules` records `impact_source`, `impact_consensus_final`, `impact_arcbottom`, `impact_delta`, and `impact_cross_check_mismatch` (= `|delta| >` rate-derived threshold, `crossCheckThresholdMs`) on every swing. A consensus-primary read with a mismatch is **kept** but downgraded to `reliability.impact = "medium"`. Full consensus provenance (s1/s2/s3, provAnchor, thumb-refine, signFlip) is logged under `impact_consensus`.

### Fallback detector — speed-banded lead-wrist arc-bottom

```
// Constants (phaseDetectionFaceOn.ts:148-150)
IMPACT_SPEED_LOOKBACK  = 3      // frames; 2D leftWrist displacement window
IMPACT_PEAK_PERCENTILE = 0.95   // robust max (ignores a single noisy spike)
IMPACT_BAND_THRESHOLD  = 0.9    // band = speed >= threshold * peak

speed[f] = hypot(leftWrist.x[f] - leftWrist.x[f-3], leftWrist.y[f] - leftWrist.y[f-3])
peak     = sorted_speed[ floor(IMPACT_PEAK_PERCENTILE * n) ]
floor    = IMPACT_BAND_THRESHOLD * peak
impact   = argmax_f { leftWrist.y[f] : speed[f] >= floor }   // arc bottom in high-speed band
```

**KNOWN BIAS (why it is now the fallback, not primary):** fires at the lead-wrist **arc-bottom**, which precedes true contact — measured **3.6 frames early (~60 ms at 60 fps)** on swing 81f0b197 (ground truth 137.6 vs detected 134). A fixed lag constant was **considered and REJECTED**: lag varies with swing speed. The consensus supersedes it as primary (81f0b197: 137.5 vs 137.6).

### Rejected alternatives

**Two-wrist x crossing** — **TESTED AND REJECTED** on 81f0b197: the wrists are ~55 px apart through contact (`wristDx = rightWrist.x − leftWrist.x` runs −53→−36 across frames 134–141), with **no zero-cross in the impact band**. Nearest crossings are early-downswing rotation (~127) and follow-through noise (~143, 5.4 frames late). Label-swap invariant (a L/R wrist swap only flips `wristDx`'s sign — crossing frames are identical). Data: `scripts/output/wrist_crossing_81f0b197.json`.

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
| 4 — Impact | Combined wrist Y max + 67ms | Lead-thumb-line last zero-crossing (RH); arc-bottom fallback; cross-check flag | No |
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
