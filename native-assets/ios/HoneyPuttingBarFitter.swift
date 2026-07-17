import Foundation
import CoreVideo

/// Putting Mode Phase A2 — the v7.6.5 pinned twin-edge BAR shaft fitter,
/// ported from the validated browser playground
/// (docs/putting-cv-test/playground/shaft-playground-v7-6-5.html, embedded JS)
/// plus the v8 greenness-ellipse head refiner
/// (head-refinement-test-v8.html). Pure pixel/series math — no AVFoundation,
/// no React; HoneyPuttingTrackerPlugin drives the decode passes and calls in.
///
/// COORDINATE SPACE: everything here is ANALYSIS px @480w (the playground's
/// canvas space at scale=1) — the frozen constants below are literal in that
/// space. Angles: degrees, 0° = shaft straight down, + = head toward target
/// (ux = sin, uy = cos, y down).
///
/// Every constant is an EXTERNAL ASSUMPTION at n=2 clips (51b07a6b, a347efc8).
/// Spec-pinned values (BAR_W_MAX 5, LEN_W 160) override the playground HTML
/// slider defaults; all others are the v7-6-5 HTML defaults.
///
/// PORT DEVIATIONS (documented, all reject-only or inert):
///  - UNPINNED legacy mode not ported: frames with no pose prior emit
///    pose_fallback/predicted_hold/none via the acceptance ladder instead of
///    the v6 RANSAC fallback (both validation clips have priors on ~100% of
///    frames).
///  - ovMask (overlay-artifact guard) dropped — native frames have no
///    burned-in overlay colors.
///  - KNOWN FIDELITY DEVIATION (owner-confirmed): the foreground term is
///    ported INERT (FG_WEIGHT = 0, no BG temporal-median builder), but the
///    validated playground runs all had BG built and fg ACTIVE (fg column
///    present in every scored readout). TRIGGER: if device smoothed angles
///    diverge >1° from the v8 DATA series over the refine window, the inert
///    fg term is suspect #1 and the BG builder gets ported BEFORE any
///    constant is changed.
enum BarFitterConst {
  // Spec-pinned winning set
  static let BAR_GRAD = 12.0
  static let BAR_W_MIN = 2.0
  static let BAR_W_MAX = 5.0 // spec-pinned (HTML default was 8)
  static let BAR_COV = 0.6
  static let GRIP_WIN = 20.0
  static let LEN_W = 160.0 // spec-pinned (HTML default was 80)
  static let LEN_INLIER_CUTOFF = 1.15
  static let LEN_OVERSHOOT_AT = 1.25
  static let OVERSHOOT_PENALTY = 0.5

  // v7-6-5 HTML defaults
  static let EMA_ALPHA = 0.5
  static let BLEND_POSE = 0.65
  static let ANG_TOL = 6.0
  static let INNOV_TRIGGER = 6.0
  static let REC_FACTOR = 1.4
  static let REC_PRED_TOL = 3.0
  static let REC_POSE_TOL = 10.0
  static let POST_TOL = 3.0
  static let SW_MARGIN = 1.3
  static let SW_CONFIRM = 2
  static let SWITCH_DIST = 8.0
  static let PIV_MAX = 12.0
  static let PIV_STEP = 2.0
  static let PIV_PEN = 0.5
  static let MIN_SUP = 0.55
  static let PROX_LEN = 28.0
  static let PROX_MIN = 0.5
  static let TOP_MIN = 0.3
  static let GAP_MAX = 24.0
  static let MAT_CUT = 30.0
  static let MAX_JUMP = 2.0
  static let MIN_SPAN = 79.0
  static let CONT_W = 0.4
  static let VEL_W = 0.15
  static let VEL_DEAD = 0.5
  static let DARK_T = 70.0
  static let BAR_W_DIV = 2.0
  static let ANGLE_STEP = 0.25
  static let BALL_EXCL_FACTOR = 2.2
  static let BALL_BOUND_R_FACTOR = 0.8
  static let MAX_T_FRAC = 0.45

  /// KNOWN FIDELITY DEVIATION — see header. Playground: fgW 0.5 with BG built.
  static let FG_WEIGHT = 0.0

  // Launch (FULL-RES px — the one non-analysis-space constant; identical to
  // packages/domain/putting/detectImpact.ts including the post-rest-window
  // guard)
  static let LAUNCH_DIST_PX = 8.0
  static let LAUNCH_REST_FRACTION = 0.6
  static let LAUNCH_MIN_BALL_FRAMES = 4

  // v8 refiner (analysis px)
  static let ELLIPSE_ALONG = 20.0
  static let ELLIPSE_PERP = 15.0
  static let BALL_LUMA_MAX = 200.0
  static let REFINE_MIN_CANDIDATES = 12
  static let REFINE_TAKE_FRACTION = 0.25
  static let REFINE_TAKE_MIN = 8
}

struct BarPrior {
  let angleDeg: Double
  let ax: Double // analysis px (med3-smoothed by the builder)
  let ay: Double
}

struct BarBall {
  let x: Double // analysis px
  let y: Double
  let r: Double
}

struct BarFrameResult {
  let source: String // "cv" | "recovery" | "pose_fallback" | "predicted_hold" | "none"
  let angleDeg: Double?
  let gripX: Double?
  let gripY: Double?
  let spanPx: Double
  let matX: Double?
  let lengthMatch: Double?
  let score: Double
  let pivotOffsetPx: Double
}

struct BarFitterState {
  var prevAng: Double? = nil
  var angVel: Double = 0
  var prevMatX: Double? = nil
  /// Angle of the last ACCEPTED FIT commit (v765 prevLine.ang) — pose-fallback
  /// and predicted-hold commits null it, which turns the continuity term off
  /// until the next real fit (playground behavior).
  var prevLineAng: Double? = nil
  var pendingSwitch: (matX: Double, count: Int)? = nil

  mutating func reset() {
    prevAng = nil
    angVel = 0
    prevMatX = nil
    prevLineAng = nil
    pendingSwitch = nil
  }

  /// v765 commitTrack: EMA the angle delta, move the track forward. isFit
  /// mirrors the playground's `fit` third argument (null on fallback/hold).
  mutating func commit(ang: Double, matX: Double?, isFit: Bool) {
    if let p = prevAng {
      angVel = BarFitterConst.EMA_ALPHA * (ang - p) + (1 - BarFitterConst.EMA_ALPHA) * angVel
    }
    prevAng = ang
    prevMatX = matX
    prevLineAng = isFit ? ang : nil
  }
}

final class HoneyPuttingBarFitter {

  // MARK: - Luma

  /// MEAN luma (R+G+B)/3 — the playground's grabLuma. Deliberately NOT the
  /// plugin's BT.601 lumaPlane: BAR_GRAD/DARK_T were tuned on mean luma.
  static func meanLumaPlane(buffer: CVPixelBuffer) -> [Float] {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let w = CVPixelBufferGetWidth(buffer)
    let h = CVPixelBufferGetHeight(buffer)
    let stride = CVPixelBufferGetBytesPerRow(buffer)
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return [] }
    let ptr = base.assumingMemoryBound(to: UInt8.self)
    var out = [Float](repeating: 0, count: w * h)
    for y in 0..<h {
      let row = y * stride
      for x in 0..<w {
        let px = row + x * 4 // BGRA
        let b = Int(ptr[px])
        let g = Int(ptr[px + 1])
        let r = Int(ptr[px + 2])
        out[y * w + x] = Float(r + g + b) / 3.0
      }
    }
    return out
  }

  // MARK: - Priors

  static func med3(_ a: Double, _ b: Double, _ c: Double) -> Double {
    return max(min(a, b), min(max(a, b), c))
  }

  /// v765 getPrior anchor smoothing: median-3 on ax/ay when both neighbors
  /// exist (angle untouched). poseBias is 0 — the harness already subtracted
  /// the 3.0° calibration; never re-apply it here.
  static func smoothedPriors(_ raw: [BarPrior?]) -> [BarPrior?] {
    var out = raw
    for i in 0..<raw.count {
      guard let p = raw[i] else { continue }
      guard i > 0, i + 1 < raw.count, let m = raw[i - 1], let n = raw[i + 1] else { continue }
      out[i] = BarPrior(angleDeg: p.angleDeg,
                        ax: med3(m.ax, p.ax, n.ax),
                        ay: med3(m.ay, p.ay, n.ay))
    }
    return out
  }

  /// v765 handVx on the smoothed anchors: ±2 stencil /4, fallback ±1 /2.
  static func handVx(_ priors: [BarPrior?], _ f: Int) -> Double? {
    func ax(_ i: Int) -> Double? {
      guard i >= 0, i < priors.count else { return nil }
      return priors[i]?.ax
    }
    if let p2 = ax(f + 2), let m2 = ax(f - 2) { return (p2 - m2) / 4 }
    if let p1 = ax(f + 1), let m1 = ax(f - 1) { return (p1 - m1) / 2 }
    return nil
  }

  // MARK: - Launch (FULL-RES ball series)

  /// Identical semantics to packages/domain/putting/detectImpact.ts, including
  /// the reject-only post-rest-window guard (a launch inside the window that
  /// defines rest is contradictory — clip a347efc8's settling ball false-fires
  /// the unguarded loop at f0). Device cross-check: this must equal the TS
  /// detectImpact result on every clip.
  static func computeBallLaunch(fullResBalls: [(x: Double, y: Double)?])
    -> (launch: Int?, restStart: Int, restEnd: Int)? {
    var presentIdx: [Int] = []
    for (i, b) in fullResBalls.enumerated() where b != nil { presentIdx.append(i) }
    guard presentIdx.count >= BarFitterConst.LAUNCH_MIN_BALL_FRAMES else { return nil }
    let restCount = max(1, Int(Double(presentIdx.count) * BarFitterConst.LAUNCH_REST_FRACTION))
    let restIdx = Array(presentIdx.prefix(restCount))
    func median(_ a: [Double]) -> Double {
      let s = a.sorted()
      let m = s.count / 2
      return s.count % 2 == 1 ? s[m] : (s[m - 1] + s[m]) / 2
    }
    let rx = median(restIdx.map { fullResBalls[$0]!.x })
    let ry = median(restIdx.map { fullResBalls[$0]!.y })
    func dist(_ i: Int) -> Double {
      let b = fullResBalls[i]!
      return ((b.x - rx) * (b.x - rx) + (b.y - ry) * (b.y - ry)).squareRoot()
    }
    let lastRestIdx = restIdx[restIdx.count - 1]
    var launch: Int? = nil
    for i in presentIdx {
      if i <= lastRestIdx { continue }
      guard i + 1 < fullResBalls.count, fullResBalls[i + 1] != nil else { continue }
      let di = dist(i)
      let dn = dist(i + 1)
      if di > BarFitterConst.LAUNCH_DIST_PX, dn > BarFitterConst.LAUNCH_DIST_PX, dn > di {
        launch = i
        break
      }
    }
    return (launch, restIdx[0], lastRestIdx)
  }

  // MARK: - evalLine (v765.js:265-362, useBar branch only)

  struct EvalResult {
    var spanT = 0.0
    var sup = 0.0
    var supTop = 0.0
    var prox = 0.0
    var grip = 0.0
    var ct = 0
    var cg = 0
    var inlWithin = 0
    var overshoot = false
    var meanW: Double? = nil
    var sdW: Double? = nil
    var wMul = 1.0
  }

  private struct Sample {
    let t: Double
    let g: Bool
    let w: Double
    let skip: Bool
  }

  /// Twin-edge bar test along the ray from (px0,py0) at ang: perpendicular
  /// mean-luma profile −9..+9, both edge gradients ≥ BAR_GRAD, width in
  /// [BAR_W_MIN, BAR_W_MAX], line strictly between the edges. Span extends
  /// through passing samples with gaps ≤ GAP_MAX. Length-aware counters
  /// (inlWithin ≤ 1.15L, overshoot > 1.25L) feed baseScore.
  static func evalLine(px0: Double, py0: Double, angDeg: Double,
                       luma: [Float], W: Int, H: Int,
                       yLim: Double, maxT: Double,
                       ball: BarBall?, shaftLen: Double?) -> EvalResult {
    let th = angDeg * Double.pi / 180
    let ux = sin(th)
    let uy = cos(th)
    let pnx = uy
    let pny = -ux
    let border = 10.0
    var samples: [Sample] = []
    samples.reserveCapacity(Int(maxT / 2) + 4)
    var proxTot = 0
    var proxGood = 0
    var gripTot = 0
    var gripGood = 0

    var t = 8.0
    while t <= maxT {
      defer { t += 2.0 }
      let x = px0 + ux * t
      let y = py0 + uy * t
      if x < border || y < border || x >= Double(W) - border || y >= Double(H) - border
        || y > yLim {
        break
      }
      if let b = ball {
        let dx = x - b.x
        let dy = y - b.y
        let excl = BarFitterConst.BALL_EXCL_FACTOR * b.r
        if dx * dx + dy * dy < excl * excl {
          samples.append(Sample(t: t, g: false, w: -1, skip: true))
          continue
        }
      }
      // Perpendicular profile −9..+9 (adjacent diffs → twin opposite edges).
      var prof = [Double](repeating: 0, count: 19)
      for k in -9...9 {
        let sx = Int(x + pnx * Double(k))
        let sy = Int(y + pny * Double(k))
        prof[k + 9] = Double(luma[sy * W + sx])
      }
      var g = false
      var w = -1.0
      var maxP = -1e9
      var maxN = 1e9
      var posP = 0.0
      var posN = 0.0
      for k in 0..<18 {
        let dd = prof[k + 1] - prof[k]
        let pos = Double(k) - 9 + 0.5
        if dd > maxP { maxP = dd; posP = pos }
        if dd < maxN { maxN = dd; posN = pos }
      }
      if maxP >= BarFitterConst.BAR_GRAD, -maxN >= BarFitterConst.BAR_GRAD {
        let wid = abs(posP - posN)
        if wid >= BarFitterConst.BAR_W_MIN, wid <= BarFitterConst.BAR_W_MAX,
           min(posP, posN) <= 0, max(posP, posN) >= 0 {
          g = true
          w = wid
        }
      }
      if t <= 8 + BarFitterConst.PROX_LEN {
        proxTot += 1
        if g { proxGood += 1 }
      }
      if t <= 8 + BarFitterConst.GRIP_WIN {
        gripTot += 1
        if g { gripGood += 1 }
      }
      samples.append(Sample(t: t, g: g, w: w, skip: false))
    }

    // SPAN: extend through good samples, tolerate gaps ≤ GAP_MAX px.
    var spanT = 0.0
    var lastGood = 8.0
    var brokenGap = false
    for s in samples where !s.skip {
      if s.g {
        if !brokenGap, s.t - lastGood <= BarFitterConst.GAP_MAX { spanT = s.t } else { brokenGap = true }
        lastGood = s.t
      } else if s.t - lastGood > BarFitterConst.GAP_MAX {
        brokenGap = true
      }
    }

    var r = EvalResult()
    r.spanT = spanT
    let L = shaftLen
    let mid = (8 + spanT) / 2
    var cgT = 0
    var ctT = 0
    var ws: [Double] = []
    for s in samples where !s.skip {
      if s.g, let l = L, s.t > BarFitterConst.LEN_OVERSHOOT_AT * l { r.overshoot = true }
      if s.t > spanT { continue }
      r.ct += 1
      if s.g {
        r.cg += 1
        if L == nil || s.t <= BarFitterConst.LEN_INLIER_CUTOFF * L! { r.inlWithin += 1 }
        if s.w >= 0 { ws.append(s.w) }
      }
      if s.t <= mid {
        ctT += 1
        if s.g { cgT += 1 }
      }
    }
    r.sup = r.ct > 0 ? Double(r.cg) / Double(r.ct) : 0
    r.supTop = ctT > 0 ? Double(cgT) / Double(ctT) : 0
    r.prox = proxTot > 0 ? Double(proxGood) / Double(proxTot) : 0
    r.grip = gripTot > 0 ? Double(gripGood) / Double(gripTot) : 0
    if !ws.isEmpty {
      let meanW = ws.reduce(0, +) / Double(ws.count)
      let sdW = (ws.reduce(0) { $0 + ($1 - meanW) * ($1 - meanW) } / Double(ws.count)).squareRoot()
      r.meanW = meanW
      r.sdW = sdW
      r.wMul = 1 - min(0.5, max(0, sdW / BarFitterConst.BAR_W_DIV))
    }
    return r
  }

  /// Length-aware base (calibrated) or legacy span base (uncalibrated) —
  /// v765 baseScore. Paying linearly for raw length is what let 450px leg
  /// edges outbid the ~260px shaft; lengthMatch fixes that.
  static func baseScore(_ e: EvalResult, shaftLen: Double?) -> Double {
    if let l = shaftLen {
      let lengthMatch = 1 - min(1, abs(e.spanT - l) / l)
      var b = (Double(e.inlWithin) + BarFitterConst.LEN_W * lengthMatch) * (0.5 + e.supTop)
      if e.overshoot { b *= BarFitterConst.OVERSHOOT_PENALTY }
      return b
    }
    return e.sup * e.spanT * (0.5 + e.supTop)
  }

  static func lengthMatchOf(spanT: Double, shaftLen: Double?) -> Double? {
    guard let l = shaftLen else { return nil }
    return 1 - min(1, abs(spanT - l) / l)
  }

  // MARK: - Pinned per-frame fit (v765 fitLine pinned mode + acceptance ladder)

  private struct Candidate {
    let score: Double
    let ang: Double
    let off: Double
    let px0: Double
    let py0: Double
    let spanT: Double
    let matX: Double
    let lengthMatch: Double?
    let isRec: Bool
  }

  private static func angleRange(_ c: Double, _ tol: Double) -> [Double] {
    var out: [Double] = []
    var x = c - tol
    while x <= c + tol + 1e-6 {
      out.append(x)
      x += BarFitterConst.ANGLE_STEP
    }
    return out
  }

  private static func angleUnion(_ r1: [Double], _ r2: [Double]) -> [Double] {
    var seen = Set<Int>()
    var out: [Double] = []
    for x in r1 + r2 {
      let k = Int((x * 4).rounded())
      if !seen.contains(k) {
        seen.insert(k)
        out.append(x)
      }
    }
    return out
  }

  /// One frame of the pinned tracker. Implements stage-1 sweep, recovery
  /// sweep, switch hysteresis, and the acceptance ladder (fit → cv/recovery;
  /// pre-impact + prior → pose_fallback; post-impact + predicted →
  /// predicted_hold; else none). COMMITS into `state` — this ladder IS the
  /// tracker; it keeps prevAng/angVel alive through occlusion.
  ///
  /// ladderCommits false = calibration mode (v765 cal button): only accepted
  /// cv/recovery fits commit; no pose-fallback/hold commits, "none" otherwise.
  static func fitFrame(luma: [Float], W: Int, H: Int,
                       prior: BarPrior?,
                       ball: BarBall?,
                       preImpact: Bool,
                       shaftLen: Double?,
                       matY: Double,
                       vx: Double?,
                       state: inout BarFitterState,
                       ladderCommits: Bool = true) -> BarFrameResult {
    let yLim = min(Double(H) - 2, matY + BarFitterConst.MAT_CUT)
    let maxT = Double(H) * BarFitterConst.MAX_T_FRAC
    let predicted: Double? = state.prevAng.map { $0 + state.angVel }

    guard let pr = prior else {
      // Pinned-only port: no prior → no sweep. Post-impact prediction still
      // holds the track; otherwise nothing this frame (state untouched).
      if ladderCommits, !preImpact, let pred = predicted {
        let matX = lineMatX(px0: 0, py0: 0, ang: pred, matY: matY, fallbackX: state.prevMatX)
        state.commit(ang: pred, matX: matX, isFit: false)
        return BarFrameResult(source: "predicted_hold", angleDeg: pred, gripX: nil, gripY: nil,
                              spanPx: 0, matX: matX, lengthMatch: nil, score: 0, pivotOffsetPx: 0)
      }
      return BarFrameResult(source: "none", angleDeg: nil, gripX: nil, gripY: nil,
                            spanPx: 0, matX: nil, lengthMatch: nil, score: 0, pivotOffsetPx: 0)
    }

    let innov: Double? = predicted.map { abs(pr.angleDeg - $0) }

    func sweep(_ angles: [Double], supMul: Double, rateRef: Double?)
      -> (best: Candidate?, stay: Candidate?) {
      let minSup = min(0.95, BarFitterConst.MIN_SUP * supMul)
      let proxMin = min(0.95, BarFitterConst.PROX_MIN * supMul)
      var sBest: Candidate? = nil
      var sStay: Candidate? = nil
      for ang in angles {
        if let ref = rateRef, abs(ang - ref) > BarFitterConst.MAX_JUMP { continue }
        let th = ang * Double.pi / 180
        let ux = sin(th)
        let uy = cos(th)
        let pnx = uy
        let pny = -ux
        var o = -BarFitterConst.PIV_MAX
        while o <= BarFitterConst.PIV_MAX {
          defer { o += BarFitterConst.PIV_STEP }
          let px0 = pr.ax + pnx * o
          let py0 = pr.ay + pny * o
          // BALL BOUNDARY: pre-impact, mat-level x may not pass the ball.
          if preImpact, let b = ball {
            let tMat = (b.y - py0) / uy
            if px0 + ux * tMat > b.x + b.r * BarFitterConst.BALL_BOUND_R_FACTOR { continue }
          }
          let e = evalLine(px0: px0, py0: py0, angDeg: ang, luma: luma, W: W, H: H,
                           yLim: yLim, maxT: maxT, ball: ball, shaftLen: shaftLen)
          // Hard gates, playground order.
          if e.prox < proxMin { continue }
          if e.grip < BarFitterConst.BAR_COV { continue } // GRIP CONNECTION gate
          if e.spanT < BarFitterConst.MIN_SPAN { continue }
          if e.ct < 10 || e.sup < minSup { continue }
          if e.sup < BarFitterConst.BAR_COV { continue } // BAR_MIN_COVERAGE
          if e.supTop < BarFitterConst.TOP_MIN { continue }
          var score = baseScore(e, shaftLen: shaftLen)
          // HEAD CHECK (pre-impact only): the tube must END on something dark.
          if preImpact {
            let ex = px0 + ux * e.spanT
            let ey = py0 + uy * e.spanT
            var dark = 0
            var tot = 0
            var dy = -6
            while dy <= 6 {
              var dx = -6
              while dx <= 6 {
                let xx = Int(ex + Double(dx))
                let yy = Int(ey + Double(dy))
                if xx >= 0, yy >= 0, xx < W, yy < H {
                  tot += 1
                  if Double(luma[yy * W + xx]) < BarFitterConst.DARK_T + 15 { dark += 1 }
                }
                dx += 2
              }
              dy += 2
            }
            let df = tot > 0 ? Double(dark) / Double(tot) : 0
            if df < 0.25 { continue }
            score *= (0.5 + df)
          }
          score *= e.wMul // width consistency
          score *= (1 + BarFitterConst.FG_WEIGHT * 0) // fg INERT — see header
          // SOFT VELOCITY COUPLING with deadband.
          if let v = vx, let prev = state.prevAng, abs(v) >= BarFitterConst.VEL_DEAD {
            let dAng = ang - prev
            if abs(dAng) > 0.01 {
              let m: Double = ((dAng > 0) == (v > 0)) ? 1 : -1
              score *= (1 + BarFitterConst.VEL_W * m)
            }
          }
          // Continuity (angle-based, v765 prevLine.ang — off after
          // fallback/hold commits until the next real fit).
          if let prevLine = state.prevLineAng {
            let dA = abs(ang - prevLine)
            score *= max(1 - BarFitterConst.CONT_W, 1 - BarFitterConst.CONT_W * dA / 10)
          }
          // Pivot penalty: wandering off the pose anchor costs points.
          score *= (1 - BarFitterConst.PIV_PEN * abs(o) / max(1, BarFitterConst.PIV_MAX))
          if score <= 0 { continue }
          let matX = px0 + ux * (matY - py0) / uy
          let cand = Candidate(score: score, ang: ang, off: o, px0: px0, py0: py0,
                               spanT: e.spanT, matX: matX,
                               lengthMatch: lengthMatchOf(spanT: e.spanT, shaftLen: shaftLen),
                               isRec: false)
          if sBest == nil || score > sBest!.score { sBest = cand }
          if let pm = state.prevMatX, abs(matX - pm) <= BarFitterConst.SWITCH_DIST,
             sStay == nil || score > sStay!.score {
            sStay = cand
          }
        }
      }
      return (sBest, sStay)
    }

    // ---- STAGE 1 ----
    let center: Double
    let tol: Double
    if preImpact {
      center = predicted.map { BarFitterConst.BLEND_POSE * pr.angleDeg + (1 - BarFitterConst.BLEND_POSE) * $0 }
        ?? pr.angleDeg
      tol = BarFitterConst.ANG_TOL
    } else {
      // POST-IMPACT: pose angle dropped entirely (measured decoupling).
      center = predicted ?? pr.angleDeg
      tol = BarFitterConst.POST_TOL
    }
    let s1 = sweep(angleRange(center, tol), supMul: 1, rateRef: state.prevAng)

    // ---- RECOVERY (pre-impact only): no stage-1 fit OR innovation spike ----
    var rec: (best: Candidate?, stay: Candidate?)? = nil
    if preImpact, s1.best == nil || (innov ?? 0) > BarFitterConst.INNOV_TRIGGER {
      var angs = angleRange(pr.angleDeg, BarFitterConst.REC_POSE_TOL)
      if let pred = predicted {
        angs = angleUnion(angleRange(pred, BarFitterConst.REC_PRED_TOL), angs)
      }
      rec = sweep(angs, supMul: BarFitterConst.REC_FACTOR, rateRef: predicted)
    }

    // ---- candidate pick + SWITCH HYSTERESIS ----
    var cand: Candidate? = s1.best
    if let rb = rec?.best, cand == nil || rb.score > cand!.score {
      cand = Candidate(score: rb.score, ang: rb.ang, off: rb.off, px0: rb.px0, py0: rb.py0,
                       spanT: rb.spanT, matX: rb.matX, lengthMatch: rb.lengthMatch, isRec: true)
    }
    if let c = cand, let pm = state.prevMatX, abs(c.matX - pm) > BarFitterConst.SWITCH_DIST {
      // Off-track candidate: needs margin (unless recovery) + confirm frames.
      var stays: [Candidate] = []
      if let s = s1.stay { stays.append(s) }
      if let s = rec?.stay { stays.append(s) }
      let inc = stays.max { $0.score < $1.score }
      let marginOK = c.isRec || inc == nil || c.score > BarFitterConst.SW_MARGIN * inc!.score
      if !marginOK {
        cand = inc
        state.pendingSwitch = nil
      } else {
        let same = state.pendingSwitch.map { abs($0.matX - c.matX) <= BarFitterConst.SWITCH_DIST } ?? false
        let count = same ? state.pendingSwitch!.count + 1 : 1
        if count >= BarFitterConst.SW_CONFIRM {
          state.pendingSwitch = nil
        } else {
          state.pendingSwitch = (c.matX, count)
          cand = inc
        }
      }
    } else {
      state.pendingSwitch = nil
    }

    // ---- acceptance ladder ----
    if let c = cand {
      state.commit(ang: c.ang, matX: c.matX, isFit: true)
      return BarFrameResult(source: c.isRec ? "recovery" : "cv",
                            angleDeg: c.ang, gripX: c.px0, gripY: c.py0,
                            spanPx: c.spanT, matX: c.matX, lengthMatch: c.lengthMatch,
                            score: c.score, pivotOffsetPx: c.off)
    }
    if !ladderCommits {
      // Calibration mode: no fallback/hold commits (v765 cal loop skips
      // frames without an accepted fit).
      return BarFrameResult(source: "none", angleDeg: nil, gripX: nil, gripY: nil,
                            spanPx: 0, matX: nil, lengthMatch: nil, score: 0, pivotOffsetPx: 0)
    }
    if preImpact {
      // POSE FALLBACK: no CV fit passed — the pose line IS the track.
      let matX = lineMatX(px0: pr.ax, py0: pr.ay, ang: pr.angleDeg, matY: matY,
                          fallbackX: state.prevMatX)
      state.commit(ang: pr.angleDeg, matX: matX, isFit: false)
      return BarFrameResult(source: "pose_fallback", angleDeg: pr.angleDeg,
                            gripX: pr.ax, gripY: pr.ay, spanPx: 0, matX: matX,
                            lengthMatch: nil, score: 0, pivotOffsetPx: 0)
    }
    if let pred = predicted {
      // POST-IMPACT HOLD: pose dropped, no fit → the prediction IS the line.
      let matX = lineMatX(px0: pr.ax, py0: pr.ay, ang: pred, matY: matY,
                          fallbackX: state.prevMatX)
      state.commit(ang: pred, matX: matX, isFit: false)
      return BarFrameResult(source: "predicted_hold", angleDeg: pred,
                            gripX: pr.ax, gripY: pr.ay, spanPx: 0, matX: matX,
                            lengthMatch: nil, score: 0, pivotOffsetPx: 0)
    }
    return BarFrameResult(source: "none", angleDeg: nil, gripX: nil, gripY: nil,
                          spanPx: 0, matX: nil, lengthMatch: nil, score: 0, pivotOffsetPx: 0)
  }

  private static func lineMatX(px0: Double, py0: Double, ang: Double, matY: Double,
                               fallbackX: Double?) -> Double? {
    let th = ang * Double.pi / 180
    let uy = cos(th)
    guard abs(uy) > 1e-6 else { return fallbackX }
    return px0 + sin(th) * (matY - py0) / uy
  }

  // MARK: - Calibration

  /// SHAFT_LEN = round(median accepted spanT) over the calibration frames.
  /// The cal loop itself commits ONLY accepted fits (playground cal button
  /// behavior — no pose-fallback commits during calibration).
  static func medianShaftLen(_ lens: [Double]) -> Double? {
    guard !lens.isEmpty else { return nil }
    let s = lens.sorted()
    let m = s.count / 2
    let med = s.count % 2 == 1 ? s[m] : (s[m - 1] + s[m]) / 2
    return med.rounded()
  }

  // MARK: - v8 greenness-ellipse head refiner

  /// Least-green centroid inside a shaft-aligned ellipse (ALONG 20 / PERP 15
  /// analysis px) centered on the PREDICTED head (caller-supplied — from the
  /// TS smoothed series, never recomputed here). Candidates: mean luma ≤ 200
  /// (ball reject); score greenness = G − (R+B)/2 (mat high, gray head low);
  /// refined = centroid of the lowest-greenness 25% (min 8 px).
  /// < 12 candidates → nil (caller coasts on the prediction — never a jump).
  static func refineHeadEllipse(buffer: CVPixelBuffer, cx: Double, cy: Double,
                                angRad: Double) -> (x: Double, y: Double, count: Int)? {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let w = CVPixelBufferGetWidth(buffer)
    let h = CVPixelBufferGetHeight(buffer)
    let stride = CVPixelBufferGetBytesPerRow(buffer)
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
    let ptr = base.assumingMemoryBound(to: UInt8.self)

    let ux = sin(angRad)
    let uy = cos(angRad)
    let pxv = -uy
    let pyv = ux
    let A = BarFitterConst.ELLIPSE_ALONG
    let P = BarFitterConst.ELLIPSE_PERP
    let R = max(A, P) + 2
    let x0 = max(0, Int(cx - R))
    let y0 = max(0, Int(cy - R))
    let x1 = min(w - 1, Int(cx + R))
    let y1 = min(h - 1, Int(cy + R))
    if x1 - x0 < 4 || y1 - y0 < 4 { return nil }

    var pts: [(x: Double, y: Double, green: Double)] = []
    for y in y0...y1 {
      let row = y * stride
      for x in x0...x1 {
        let gx = Double(x) - cx
        let gy = Double(y) - cy
        let a = (gx * ux + gy * uy) / A
        let p = (gx * pxv + gy * pyv) / P
        if a * a + p * p > 1 { continue }
        let px = row + x * 4 // BGRA
        let b = Double(ptr[px])
        let g = Double(ptr[px + 1])
        let r = Double(ptr[px + 2])
        if (r + g + b) / 3 > BarFitterConst.BALL_LUMA_MAX { continue }
        pts.append((Double(x), Double(y), g - (r + b) / 2))
      }
    }
    if pts.count < BarFitterConst.REFINE_MIN_CANDIDATES { return nil }
    pts.sort { $0.green < $1.green }
    let take = max(BarFitterConst.REFINE_TAKE_MIN,
                   Int(Double(pts.count) * BarFitterConst.REFINE_TAKE_FRACTION))
    var sx = 0.0
    var sy = 0.0
    for i in 0..<take {
      sx += pts[i].x
      sy += pts[i].y
    }
    return (sx / Double(take), sy / Double(take), take)
  }
}
