# Club Tracking (Shaft + Club Head) — Face-On Design Plan

**Status:** DRAFT (2026-07-06) — PARKED; specced for later pickup
**Owner:** Sam
**Positioning:** complementary to, and sequenced after, the face-on first-line
priority (`docs/FACE_ON_FIRST_LINE_PLAN.md`). Rung 3 below explicitly depends on
that plan's workstream G (replay harness) existing first.

## Goal

Track the golf club — shaft line + club head point — in face-on swing videos,
starting where the physics is easiest: static address frames, then slow-speed
chips. The app currently watches only bodies (RTMW 133-kp pose); the club is
approximated by a placeholder forearm extrapolation
(`packages/domain/swing/syntheticClubheadPath.ts`, K_EXTENSION = 4.0, thresholds
explicitly placeholders). A real club track (a) yields genuine coaching metrics
(shaft lean at address, low point, real path angle), and (b) is a strictly better
impact anchor than today's wrist proxies — the #1 open defect in the face-on plan.

## Non-goals

- **No DTL.** Face-on only.
- **No scoring or UI changes** in any rung as specced — swing_debug telemetry only.
- **No changes to the protected face-on detector** outside the single
  S4-behind-replay-gate path in rung 3.
- **No swing-type awareness / chip product mode.** Chips already persist rows +
  video even when they trip fallback gates (swing_debug is written on the
  `mid_frame_fallback` path too), so v1 instrumentation needs zero gate changes.
  A chip practice mode is a later product decision.
- **No live frame-processor work.** Capture is post-hoc by architecture (see below).

## Why the architecture is already primed

- Capture saves a 240fps 1920×1080 h265 `.mov`; pose is extracted from the file
  afterward (`lib/extractPoseFromVideo.ts` → `native-assets/ios/HoneyRtmwOneShotPlugin.swift`
  (canonical source; prebuild copies it to `ios/honeyswing/`), per-timestamp
  decode → CoreML). `PoseFrame.timestampMs` IS video PTS, so a second
  detector run on the same timestamps is frame-aligned to the body for free.
- `faceOnImpactConsensus.ts` is a multi-signal fusion (xCross / arm-vertical /
  wrist-lowest + reliability flags) that a club-head low-point can join as a new
  anchor (S4) without restructuring.
- `FrameSelectionDebug` → `swings.swing_debug` JSONB is a turnkey telemetry path;
  `merge_swing_debug(swing_id, patch)` supports async attachment.
- `scripts/clubhead-overlay-prototype.py` already does Supabase download + cache,
  pose/video alignment, and overlay rendering — the Stage-0 harness scaffolding.

## Decision summary

| Decision | Choice |
|---|---|
| Detection approach | Hybrid, classical-first: wrist-anchored gradient-ridge + anchored RANSAC line fit + alpha-beta temporal filter; human-accepted classical detections later bootstrap ML labels |
| iOS CV dependency | Pure vImage/Accelerate + CoreImage — **no OpenCV pod** on device. OpenCV allowed in the desktop harness only; the algorithm restricts itself to Accelerate-portable primitives (allowlist noted in harness header) |
| Prototyping | Desktop-harness-first (Python/OpenCV, clone `clubhead-overlay-prototype.py` scaffolding); Swift port only after validation gates pass |
| First rung | Address-frame shaft angle/lean — works on the existing corpus today; doubles as the feasibility probe |
| Integration | Separate one-shot plugin `HoneyClubTrackOneShotPlugin.swift` (clone RTMW reader pattern incl. preferredTransform conjugation), second decode pass, flag-gated, swing_debug-only |
| Data type | Separate `ClubSequence` keyed by shared `timestampMs` — do NOT extend the closed `JointName` union (would ripple into `createEmptyJoints`, canonical transform, identity correction, velocity veto — all body-semantics code the club must not enter) |
| Impact anchor | Club low-point joins `faceOnImpactConsensus` as S4 only after a workstream-G before/after corpus replay report |

## Quantitative feasibility (the physics that shapes the plan) — EXTERNAL ASSUMPTION, measured in rung 0

Pixel scale: a kid at ~60% of portrait frame height (1920 px tall after
preferredTransform) ≈ **0.8–1.0 px/mm**. Junior shaft diameter 8.5–15 mm →
**7–9 px** wide at good framing, 4–5 px loose, **2–3 px worst-case** — the
kill-criterion regime Stage 0 must measure on real corpus frames.

Motion at 240fps (Δt = 4.17 ms); blur streak = speed × exposure (outdoor slo-mo
auto-exposure typically 1/500–1/2000 s, ceiling 1/240 s):

| Feature | Speed | Displacement/frame | Blur @ 1/1000 s |
|---|---|---|---|
| Chip club head | 5–15 mph | 8–25 px | **2–6 px** |
| Full-swing hands at impact | 20–25 mph | 33–41 px | 8–10 px |
| Full-swing club head | 70–100 mph | **115–165 px** | 28–40 px |

Consequences:
- **Chips in daylight are essentially blur-free** on a 4–9 px shaft; classical CV
  is well-posed, and 8–25 px/frame head displacement makes temporal gating trivial.
- **Full-swing impact is a different problem.** Near impact the shaft smears
  sideways into a wide low-contrast band — unrecoverable per frame. What survives
  is the club-head **streak** (a compact blob smeared along the arc; endpoints =
  head at shutter open/close). So rungs 1–2 are *shaft detection*, rung 3 is
  *streak-endpoint detection* — two detectors sharing scaffolding, never one
  unified detector.
- **Foreshortening:** at address the shaft lies ~in the image plane; full swings
  lose it (toward camera axis, hand-occluded) near the top. Chips keep hands below
  ~hip height → shaft stays within ~±45° of the image plane, ≥70% apparent length
  throughout. Chips-first is right independent of blur.

## Classical detector spec (per frame)

1. **ROI**: grip point g = midpoint(leftWrist, rightWrist) from existing pose.
   Prior direction = previous filtered frame; at track start, seed from the
   `syntheticClubheadPath` forearm extrapolation (±20° is adequate). Crop ~1.6×
   prior shaft length along the prior direction, downsample ×2 → luminance.
2. **Oriented gradient ridge map**: Sobel; a thin shaft is a *ridge* (antiparallel
   edge pair 3–9 px apart). Keep pixels with |∇| above an adaptive MAD threshold
   AND orientation ⊥ prior ±25°; ridge confirmation (matching opposite-sign edge
   within max shaft width) kills single-edge clutter — legs, shadows, alignment
   sticks, club-path guides.
3. **Anchored RANSAC** line fit constrained to pass within ~25 px of g (2-DOF:
   angle + small offset). Anchoring to the hands designs out the
   hands-occlude-grip-end problem — the butt end is never detected. Hough
   rejected (clutter-prone at 2–5 px widths, wastes the through-the-hands prior);
   LSD rejected (OpenCV-only, breaks the no-pod decision). Accept if inlier span
   ≥ 0.5 × expected shaft length; score = inlier arc length × mean gradient.
4. **Club head** = distal end of contiguous inlier support + local blob refinement
   (±15 px) for the head's intensity/color anomaly — junior heads are large and
   often bright vs grass, which genuinely helps.
5. **Temporal filter**: alpha-beta on (angle, apparent length); chip gates
   Δθ ≤ ~6°/frame, head displacement ≤ 30 px/frame; coast ≤ 3 frames on miss,
   then mark a gap. Emit per-frame quality: inlier ratio, gradient SNR, angle
   innovation.

## Workstreams (deliverable ladder — cheapest useful thing first)

### Rung 0. Desktop harness + feasibility report

1. `scripts/club-track-prototype.py` — detector on one swing (`swing_id`, or
   `--video/--pose` for local clips). Reuse `clubhead-overlay-prototype.py`'s
   env/Supabase/cache/render scaffolding wholesale. Outputs to
   `exports/club-track/{swing_id}/`:
   - `track.jsonl` — per frame `{timestampMs, shaft{gripX,gripY,tipX,tipY}|null,
     head{x,y,confidence}|null, quality, mode: shaft|streak|coast|miss}`
   - `overlay.mp4` — shaft line + head dot + trail for human accept/reject review
     (each accepted clip = future ML training labels)
   - `summary.json` — detection rate by phase window, angle jitter (deg RMS),
     coverage %, measured shaft width px, gradient SNR
2. `scripts/club-track-report.py` — corpus sweep aggregating the kill-criteria
   numbers (table below).
3. In parallel: **record 10–20 chip clips** (2–3 kids, one session) through the
   normal app capture flow — they land in outbox/Supabase like any swing, so the
   harness pulls them identically. **No chip footage exists today**; the existing
   corpus (~73 swings) is full swings only, which validates rungs 1 and 3 inputs
   but not rung 2.
4. Gate: feasibility numbers pass the kill-criteria thresholds.

### Rung 1. Address shaft angle / lean (static)

Works on ALL existing corpus swings today: zero blur, max apparent length,
high-confidence wrist seeds. A real coaching metric (setup check), and the
feasibility probe for everything downstream (measures real shaft px width and
contrast on real lawns).

1. Calibrate on corpus in the harness; hand-label ~20 swings (click-two-points
   helper, ~an hour).
2. Gate: ≥85% of corpus address frames within ±3° of the labeled truth set.
3. Swift port (see Integration) — flag-gated, swing_debug-only.
4. Effort: ~3–5 days harness + ~1 week port.

### Rung 2. Chip full track

Whole-swing club-head trail + true low point + real (non-synthetic) path angle
for chips; the first real validation of — and chip-path replacement for —
`syntheticClubheadPath`.

1. Requires the rung-0 chip clips.
2. Gate: on ≥15 chip clips, head error ≤15 px vs hand labels on 10 sampled
   frames/clip; low-point frame within ±2 frames of human-judged contact.
3. Effort: ~1–2 weeks after rung 1.

### Rung 3. Full-swing impact-window streak (±10 frames around consensus impact)

Streak-endpoint detection (per the physics section), sharing ROI/temporal
scaffolding but a distinct detector. Unlocks S4: club-head low point / ball-line
crossing as a new anchor in `faceOnImpactConsensus.ts` — a strictly better impact
signal than wrist proxies.

1. Prototype on corpus impact windows in the harness first (human-check streak
   visibility on ~10 swings before writing any detector).
2. **Hard gate (non-negotiable):** S4 joins the consensus only with a
   before/after workstream-G corpus replay report showing no regression plus
   improvement on the disagreement set — same rule as every detector change in
   the face-on plan.
3. Acceptable partial win: daylight-only S4 with a reliability flag (the
   consensus already models per-signal reliability).
4. Effort: ~1–2 weeks; genuinely risky.

### Rung 4. ML keypoint model (optional, only if rung 3 stalls)

2-keypoint (hosel + head centroid) CoreML crop model. Labels harvested from
human-accepted rung 1–2 overlays — accept/reject per clip yields 200–900
auto-labeled frames each, collapsing the labeling burden from thousands of clicks
to per-clip review. Precedent: the grip-classifier pipeline
(`HoneyVisionCameraPosePlugin.swift`). Effort: 2–4 weeks.

## Integration architecture (for the eventual on-device port)

- **Native:** `native-assets/ios/HoneyClubTrackOneShotPlugin.swift` (canonical
  source; synced to `ios/honeyswing/` by prebuild), cloning
  `HoneyRtmwOneShotPlugin`'s sequential reader + preferredTransform-conjugation
  pattern (that logic encodes a hard-won mirroring fix — reuse verbatim).
  Signature: `trackClub(videoUri, timestampsMs, seeds: [{tsMs, gripX, gripY,
  priorAngleDeg?}]) → ClubFrame[]`. A **separate second decode pass**, not fused
  into the RTMW pass: isolates experimental code from the production-critical
  pose plugin, and hardware HEVC decode ≈ 2–4 ms/frame → a full pass costs 2–4 s
  (rungs 1/3 decode only short windows) — well inside the 90 s extraction budget.
  Revisit fusion only if chip full-track measures >10 s on-device.
- **JS:** `modules/vision-camera-pose/src/clubTrack.ts` +
  `lib/extractClubTrackFromVideo.ts` (mirror `rtmw.ts` / `extractPoseFromVideo.ts`),
  invoked after pose extraction with wrist seeds from the fresh `PoseFrame[]`.
  Flag: module constant `CLUB_TRACK_ENABLED` (repo pattern: constants + `__DEV__`,
  no runtime flag system). All failures non-fatal — caught, logged into the debug
  patch, never block `persistSwing`.
- **Types:** new `packages/pose/ClubTypes.ts` — `ClubFrame { timestampMs,
  shaft|null, head|null, quality, mode }`, `ClubSequence { frames, source,
  version }`, joined to pose by shared `timestampMs`.
- **Telemetry:** add `club_track?` to `FrameSelectionDebug`
  (`analysisPipeline.ts`) → flows through `persistSwing.ts` automatically. Persist
  the **summary** only (address shaft angle, coverage %, low-point frame, quality
  stats) — not the per-frame track (JSONB bloat); the full track is regenerable
  from the stored video. Use `merge_swing_debug()` for async attachment.

## Risks & kill criteria (each probed in <1 day of rung-0 harness work)

| Risk | Probe | Kill / pivot threshold |
|---|---|---|
| Shaft too thin / no contrast vs grass | Measure ridge width px + gradient SNR on 20 corpus address frames | Median width <2 px or SNR <2 on >40% of corpus → classical dead at current framing; pivot = tighter framing guidance or ML-only |
| Line clutter (legs, shadows, alignment sticks) | False-positive rate of anchored RANSAC vs 20 hand labels | >25% wrong-line picks after ridge + anchor constraints → add color prior / temporal-only acceptance |
| Hands occlude grip end | Designed out (anchor to wrist midpoint; butt end never detected) — verify anchor residual on labels | Residual >40 px systematically → seed from thumb keypoints instead |
| Chip out-of-plane windows | Coverage % per chip clip vs the ±45° apparent-length model | Coverage <60% of chip frames → rung 2 degrades to hitting-zone-only trail (still useful) |
| Full-swing streak invisible | Crop ±10 impact frames from 10 corpus swings; human-check, then run streak detector | Indistinct in >50% of daylight corpus → rung 3 ML-only or dropped; rungs 1–2 unaffected |
| Extraction budget | Time the Swift port per rung window on-device | Chip full-track >10 s → decimate club pass (120→60 fps) or fuse into RTMW decode loop |

## Sequencing

1. **Rung 0** (harness + feasibility report) — everything measures through it;
   chip recording session runs in parallel.
2. **Rung 1** (address shaft angle) — gate on ±3°/85%, then Swift port.
3. **Rung 2** (chip full track) — gate on head-error/low-point criteria; compare
   against `syntheticClubheadPath` on the same clips.
4. **Rung 3** (impact streak → S4) — only after FACE_ON workstream G exists;
   gated on a before/after replay report.
5. **Rung 4** (ML) — only if rung 3 under-delivers.

## Decision gates

- No on-device Swift work before the rung-0 feasibility report passes.
- No consensus/detector change merges without a before/after corpus replay
  report (FACE_ON workstream G) — S4 is subject to the same rule as every other
  detector change.
- Rung 4 (ML) is triggered only by rung-3 shortfall, never speculatively.
