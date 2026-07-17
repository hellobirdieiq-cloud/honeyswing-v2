import Foundation
import React
import AVFoundation
import CoreImage
import UIKit
import Vision

/// Putting CV go/no-go gate (Phase 1): post-hoc putter-HEAD + BALL tracker over
/// a recorded front-on clip. Clone of the HoneyRtmwOneShotPlugin decode skeleton
/// (forward AVAssetReader in 32BGRA, nearest-PTS straddle-pair cursor, per-frame
/// autoreleasepool, upright conjugated preferredTransform) with the CoreML stage
/// replaced by color-threshold blob detection + connected components. NO pose,
/// NO CoreML, NO OpenCV. Deliberate deviations from the template:
///   - stops emitting at stream end instead of padding with the last frame
///     (padding would fabricate frozen centroids and corrupt jitter stats);
///   - skips the passthrough frame-count probe pass (not needed, decode-bound).
///
/// Every detection threshold below is an EXTERNAL ASSUMPTION — uncalibrated
/// until the Phase 0 fixture corpus exists. Do not trust these numbers.
@objc(HoneyPuttingTrackerPlugin)
class HoneyPuttingTrackerPlugin: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool { return false }

  // MARK: - EXTERNAL ASSUMPTION constants (all uncalibrated until Phase 0 fixtures)

  /// EXTERNAL ASSUMPTION — detection resolution. Frames are Lanczos-downscaled
  /// to this width (height by aspect, forced even for the H.264 overlay writer);
  /// all *_PX/_PX2 constants below are in THIS space unless suffixed otherwise.
  private static let ANALYSIS_WIDTH = 480

  /// EXTERNAL ASSUMPTION — ball mask: bright + low-chroma. A pixel is "ball" iff
  /// min(R,G,B) > BALL_MIN_LUMA and (max−min) < BALL_MAX_CHROMA_SPREAD.
  private static let BALL_MIN_LUMA = 180
  private static let BALL_MAX_CHROMA_SPREAD = 40

  /// EXTERNAL ASSUMPTION — head mask: dark. A pixel is "head" iff max(R,G,B) < this.
  private static let HEAD_MAX_LUMA = 70

  /// EXTERNAL ASSUMPTION — ball blob area bounds (analysis px²) at 480w.
  private static let BALL_AREA_MIN_PX2 = 20.0
  private static let BALL_AREA_MAX_PX2 = 400.0

  /// EXTERNAL ASSUMPTION — head blob area bounds (analysis px²) at 480w.
  private static let HEAD_AREA_MIN_PX2 = 40.0
  private static let HEAD_AREA_MAX_PX2 = 1200.0

  /// EXTERNAL ASSUMPTION — the ball sits on the ground: search only the lower
  /// fraction of the frame (excludes white shirt/cap).
  private static let BALL_SEARCH_LOWER_FRACTION = 0.6

  /// EXTERNAL ASSUMPTION — ball-rest anchor: median ball centroid over the first
  /// N grid frames (~200ms at the 8.33ms grid). Anchors the head ROI.
  private static let BALL_REST_SAMPLE_FRAMES = 24
  /// EXTERNAL ASSUMPTION — anchor sanity: if anchor-window detections spread
  /// more than this from their median (analysis px), or fewer than
  /// BALL_REST_ANCHOR_MIN_DETECTIONS were found, the ball is NOT at rest
  /// (pre-moving decoy) → head ROI falls back to full-width unanchored mode.
  private static let BALL_REST_ANCHOR_MAX_SPREAD_PX = 6.0
  private static let BALL_REST_ANCHOR_MIN_DETECTIONS = 3

  /// EXTERNAL ASSUMPTION — head ROI horizontal extent: ±0.25 of frame WIDTH
  /// around the anchor x (generous so a long backstroke never exits the ROI
  /// sideways). Unchanged by the vertical-band fix below.
  private static let HEAD_ROI_HALF_WIDTH_FRAC = 0.25

  /// EXTERNAL ASSUMPTION — head ROI VERTICAL band around mat level (anchorY),
  /// analysis px @480w: up 80 (≈180 full-res), down 32 (≈72 full-res).
  /// Evidence, fixture 1d8722b8: real head observed y ∈ [1380,1600] full-res
  /// vs ball rest y=1531 → band ≈ [1351,1603] covers it; the grip/hands blob
  /// (y≈1095) that stole mat-level selection sits far above the band; and the
  /// old 0.25*frameH reach-up (to y≈1051) kept the head 4-connected to the
  /// dark shaft, collapsing compactness to 0.03-0.24 during the stroke — the
  /// tight band clips the shaft off the head blob. DOWN admits the head's
  /// ground-shadow zone (observed to y≈1600).
  private static let HEAD_BAND_UP_PX = 80.0
  private static let HEAD_BAND_DOWN_PX = 32.0

  /// EXTERNAL ASSUMPTION — confidence shape-factor floors. Confidence is the
  /// LOCKED definition: areaFactor × shapeFactor × proximityFactor, each 0..1.
  /// shape = circularity 4πA/P² for ball (P = boundary-pixel count — permissive,
  /// a square scores ~0.97; real discrimination waits for fixture calibration),
  /// compactness A/bboxArea for head.
  private static let BALL_MIN_CIRCULARITY = 0.6
  private static let HEAD_MIN_COMPACTNESS = 0.35

  /// EXTERNAL ASSUMPTION — proximity factor sigma (analysis px at 480w):
  /// exp(−d²/2σ²) to the previous-frame centroid; neutral 1.0 on the first
  /// frame or after a null gap.
  private static let PROXIMITY_SIGMA_PX = 24.0

  /// EXTERNAL ASSUMPTION — head mat-level tie band (analysis px at 480w):
  /// floor-clearing head candidates whose centroid y is within this of the
  /// lowest candidate's are tie-broken by confidence (see pickMatLevelHead).
  private static let HEAD_Y_TIE_BAND_PX = 12.0

  /// DIAGNOSTIC (options.debugCandidates) — per frame, dump at most this many
  /// head-ROI dark blobs ranked by raw pre-floor confidence.
  private static let HEAD_DEBUG_TOP_N = 3

  /// EXTERNAL ASSUMPTION — head motion factor: a blob pixel counts as
  /// "moving" iff its analysis-res luma changed by more than this vs the
  /// previous grid frame. motionFactor = moving fraction of the blob's
  /// pixels (0 on the first frame — no previous luma).
  private static let MOTION_DIFF_MIN_LUMA = 25

  // MARK: Shaft-first head detector constants (headDetector == "shaft", default)

  /// EXTERNAL ASSUMPTION — shaft ROI, ball-relative: x = anchorX ±
  /// SHAFT_ROI_HALF_WIDTH_FRAC × frameW; y from anchorY − SHAFT_ROI_UP_FRAC ×
  /// frameH (the shaft extends up toward the hands — the endpoint gates
  /// below handle the grip end) down to anchorY + HEAD_BAND_DOWN_PX.
  private static let SHAFT_ROI_HALF_WIDTH_FRAC = 0.22
  private static let SHAFT_ROI_UP_FRAC = 0.45

  /// EXTERNAL ASSUMPTION — shaft candidates exclude a disc of this factor ×
  /// ballRadius around the current (or last-known) ball centroid, so the
  /// ball's dark rim/shadow edge can't join the line fit.
  private static let BALL_EXCLUSION_RADIUS_FACTOR = 2.2

  /// EXTERNAL ASSUMPTION — shaft candidate mask: dark ∨ motion ∨ edge, where
  /// edge = |∇x luma| + |∇y luma| > this (central differences).
  private static let EDGE_MIN_GRAD = 35

  /// EXTERNAL ASSUMPTION — thin-neighborhood filter: keep a candidate iff its
  /// 3x3 candidate-neighbor count is in [MIN, MAX] — favors thin line
  /// structures, rejects fat blob interiors (shorts, body → 8 neighbors) and
  /// isolated speckle (0-1 neighbors).
  private static let THIN_NEIGHBOR_MIN = 2
  private static let THIN_NEIGHBOR_MAX = 7

  /// EXTERNAL ASSUMPTION — RANSAC-lite line fit (PRIMARY fitter: the measured
  /// merged components — 7-11k px with shadow/body pollution — are exactly
  /// where PCA's covariance axis breaks; RANSAC's inlier band ignores the
  /// off-line mass). DETERMINISTIC sampling (every-Nth pairing, no RNG) so
  /// runs reproduce. Score = inliers + SHAFT_SPAN_SCORE_WEIGHT × span.
  private static let SHAFT_PAIR_MIN_DIST_PX = 40.0
  private static let SHAFT_MAX_CANDIDATE_LINES = 80
  private static let SHAFT_INLIER_BAND_PX = 2.5
  private static let SHAFT_SPAN_SCORE_WEIGHT = 0.8
  private static let SHAFT_MIN_INLIERS = 25
  private static let SHAFT_MIN_SPAN_PX = 80.0

  /// EXTERNAL ASSUMPTION — angle gates: candidate lines more than this from
  /// vertical are rejected (a putter shaft never lies down in a front-on
  /// putt; tightened 35→18 — static near-vertical scene edges survived 35°);
  /// when a previous accepted line exists (≤ MAX_LINE_HOLD_FRAMES old),
  /// lines more than SHAFT_MAX_ANGLE_DELTA_DEG from it are rejected.
  private static let SHAFT_MAX_ANGLE_FROM_VERTICAL_DEG = 18.0
  private static let SHAFT_MAX_ANGLE_DELTA_DEG = 25.0

  /// EXTERNAL ASSUMPTION — pose-guided fit (options.posePriors): when a prior
  /// exists for a frame, candidate lines must be within POSE_ANGLE_TOL_DEG of
  /// the pose pair's calibrated angle (REPLACES the 18° absolute vertical
  /// gate for that frame) and pass within POSE_ANCHOR_PASS_PX (perpendicular,
  /// @480w) of the hand-cluster anchor. Null prior → pure-CV gates verbatim.
  /// Pose is a PRIOR only — head position/timing still comes from pixels.
  /// Validated on 1d8722b8: LeadWrist→TrailThumbTip tracks the measured shaft
  /// within +1.85°/+4.22° at f55/f114 (bias +3.0°, calibrated JS-side),
  /// rotation within 2.37°. Supersedes the CV grip blob tracker (it locked
  /// the chair).
  private static let POSE_ANGLE_TOL_DEG = 7.0
  private static let POSE_ANCHOR_PASS_PX = 22.0

  /// EXTERNAL ASSUMPTION — head extraction: lower endpoint = 95th-percentile
  /// inlier projection toward the mat (robust to stray inliers); head = mean
  /// of inliers within SHAFT_HEAD_CLUSTER_PX (projected) of it. Clusters
  /// smaller than SHAFT_HEAD_MIN_CLUSTER are treated as occluded (ball
  /// overlap at impact) → head = fitted line ∩ (y = mat level) at
  /// confidence × SHAFT_OCCLUDED_CONF_FACTOR.
  private static let SHAFT_HEAD_CLUSTER_PX = 8.0
  private static let SHAFT_HEAD_MIN_CLUSTER = 3
  private static let SHAFT_OCCLUDED_CONF_FACTOR = 0.5

  /// EXTERNAL ASSUMPTION — endpoint sanity gates: the LOWER endpoint must be
  /// within SHAFT_ENDPOINT_MAX_DX_PX of anchorX horizontally, and no higher
  /// than SHAFT_ENDPOINT_MIN_UP_PX above mat level (a lower endpoint far
  /// above the mat = the fit grabbed the grip-side segment — wrong end).
  private static let SHAFT_ENDPOINT_MAX_DX_PX = 90.0
  private static let SHAFT_ENDPOINT_MIN_UP_PX = 200.0

  /// EXTERNAL ASSUMPTION — when no line is accepted, hold the previous
  /// accepted line/head for up to this many frames, decaying the emitted
  /// head's confidence by ×SHAFT_HOLD_DECAY per held frame (the global
  /// MIN_CONFIDENCE_FLOOR still applies, so stale holds fade to null).
  private static let MAX_LINE_HOLD_FRAMES = 5
  private static let SHAFT_HOLD_DECAY = 0.8

  /// EXTERNAL ASSUMPTION — seeded mode (options.ballSeed): the rest-anchor
  /// pass only accepts ball candidates within this radius (analysis px at
  /// 480w) of the caller-provided seed.
  private static let SEED_LOCK_RADIUS_PX = 30.0

  /// EXTERNAL ASSUMPTION — seeded mode: per-frame HARD gate — ball candidates
  /// farther than this (analysis px at 480w) from the last accepted centroid
  /// (the seed until the first acceptance) are rejected before scoring. The
  /// confidence formula is unchanged for surviving candidates.
  private static let SEEDED_MAX_JUMP_PX = 40.0

  /// EXTERNAL ASSUMPTION — minimum confidence floor. Best candidate below this
  /// → Apple Vision contour fallback runs; still below → null for the frame.
  private static let MIN_CONFIDENCE_FLOOR = 0.15

  /// EXTERNAL ASSUMPTION — blobs smaller than this are speckle noise and are
  /// never scored (keeps connected-components output manageable).
  private static let NOISE_BLOB_MIN_PX2 = 4

  /// EXTERNAL ASSUMPTION — Vision fallback tuning (only runs on frames where
  /// the color pass's best confidence is below MIN_CONFIDENCE_FLOOR).
  private static let VISION_CONTRAST_ADJUSTMENT: Float = 2.0
  private static let VISION_MAX_IMAGE_DIMENSION = 512

  private static let ciContext = CIContext(options: [.useSoftwareRenderer: false])

  // MARK: - Internal types

  private struct Blob {
    var area = 0
    var sumX = 0.0
    var sumY = 0.0
    var minX = Int.max
    var maxX = -1
    var minY = Int.max
    var maxY = -1
    var boundary = 0
    /// ROI-local mask indices of every pixel (row-major) — consumed by the
    /// head motion factor; aggregate stats above stay the scoring source.
    var pixels: [Int] = []
  }

  /// A scored detection in ANALYSIS pixel space (top-left origin).
  private struct Detection {
    let x: Double
    let y: Double
    let area: Double
    let confidence: Double
    let source: String // "color" | "vision"
  }

  private struct Roi {
    var x0: Int
    var y0: Int
    var x1: Int
    var y1: Int
    var width: Int { x1 - x0 }
    var height: Int { y1 - y0 }
    func clamped(w: Int, h: Int) -> Roi {
      return Roi(x0: max(0, min(x0, w)), y0: max(0, min(y0, h)),
                 x1: max(0, min(x1, w)), y1: max(0, min(y1, h)))
    }
  }

  /// Forward decode cursor — template D1b nearest-PTS straddle-pair selection,
  /// except exhaustion returns nil (stop emitting) instead of padding.
  private final class DecodeCursor {
    let reader: AVAssetReader
    private let output: AVAssetReaderTrackOutput
    private var prev: (buffer: CMSampleBuffer, ptsMs: Double)?
    private var cur: (buffer: CMSampleBuffer, ptsMs: Double)?

    init?(asset: AVAsset, track: AVAssetTrack) {
      guard let r = try? AVAssetReader(asset: asset) else { return nil }
      reader = r
      output = AVAssetReaderTrackOutput(track: track, outputSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: NSNumber(value: kCVPixelFormatType_32BGRA),
      ])
      guard reader.canAdd(output) else { return nil }
      reader.add(output)
      guard reader.startReading() else { return nil }
      cur = next()
    }

    private func next() -> (buffer: CMSampleBuffer, ptsMs: Double)? {
      while let sb = output.copyNextSampleBuffer() {
        if CMSampleBufferGetImageBuffer(sb) != nil {
          let ptsMs = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb)) * 1000.0
          return (sb, ptsMs)
        }
      }
      return nil
    }

    func nearestSample(toMs tsMs: Double) -> CMSampleBuffer? {
      while let c = cur, c.ptsMs < tsMs {
        prev = c
        cur = next()
      }
      switch (prev, cur) {
      case let (p?, c?):
        return abs(p.ptsMs - tsMs) <= abs(c.ptsMs - tsMs) ? p.buffer : c.buffer
      case let (nil, c?):
        return c.buffer
      case (_, nil):
        // Stream exhausted: STOP emitting (deviation from template last-frame
        // padding — padded frames would fabricate frozen ball/head positions).
        return nil
      }
    }

    func cancel() { reader.cancelReading() }
  }

  /// Overlay .mov writer. Failure here must NEVER fail the tracking result —
  /// every path degrades to overlayUri = null.
  private final class OverlayWriter {
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor
    private let url: URL
    private(set) var failed = false

    init?(width: Int, height: Int) {
      let name = "putting-overlay-\(UUID().uuidString).mov"
      url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(name)
      try? FileManager.default.removeItem(at: url)
      guard let w = try? AVAssetWriter(outputURL: url, fileType: .mov) else { return nil }
      writer = w
      input = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: NSNumber(value: width),
        AVVideoHeightKey: NSNumber(value: height),
      ])
      input.expectsMediaDataInRealTime = false
      adaptor = AVAssetWriterInputPixelBufferAdaptor(
        assetWriterInput: input,
        sourcePixelBufferAttributes: [
          kCVPixelBufferPixelFormatTypeKey as String: NSNumber(value: kCVPixelFormatType_32BGRA),
          kCVPixelBufferWidthKey as String: NSNumber(value: width),
          kCVPixelBufferHeightKey as String: NSNumber(value: height),
        ])
      guard writer.canAdd(input) else { return nil }
      writer.add(input)
      guard writer.startWriting() else { return nil }
      writer.startSession(atSourceTime: .zero)
    }

    func append(_ buffer: CVPixelBuffer, ptsMs: Double) {
      guard !failed else { return }
      // Offline write: spin on readiness, but a >5s stall abandons the overlay
      // (tracking result is the primary output and must still resolve).
      var waits = 0
      while !input.isReadyForMoreMediaData {
        usleep(2000)
        waits += 1
        if waits > 2500 { failed = true; return }
      }
      let pts = CMTime(value: Int64(ptsMs.rounded()), timescale: 1000)
      if !adaptor.append(buffer, withPresentationTime: pts) {
        failed = true
      }
    }

    func finish() -> String? {
      if failed {
        if writer.status == .writing { writer.cancelWriting() }
        return nil
      }
      input.markAsFinished()
      let sem = DispatchSemaphore(value: 0)
      writer.finishWriting { sem.signal() }
      sem.wait()
      return writer.status == .completed ? url.absoluteString : nil
    }
  }

  // MARK: - Entry point

  @objc(trackPuttingObjects:stepMs:options:resolver:rejecter:)
  func trackPuttingObjects(_ videoUri: NSString,
                           stepMs: NSNumber,
                           options: NSDictionary?,
                           resolver resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
    let writeOverlay = (options?["writeOverlay"] as? NSNumber)?.boolValue ?? false
    let debugCandidates = (options?["debugCandidates"] as? NSNumber)?.boolValue ?? false
    // Overlay CONTENT mode: "clean" (default) — the exported overlay video is
    // the raw decoded analysis frames with NOTHING drawn (no line, dots, or
    // rings). "annotated" — markers burned in (debug). Ball path and all
    // tracking logic are untouched either way; this only changes what the
    // overlay writer draws.
    let overlayModeRaw = (options?["overlayMode"] as? String) ?? "clean"
    let annotateOverlay = overlayModeRaw == "annotated"
    DispatchQueue.global(qos: .userInitiated).async {
      let step = stepMs.doubleValue
      guard step > 0, step.isFinite else {
        DispatchQueue.main.async { reject("invalid_step", "stepMs must be > 0, got \(step)", nil) }
        return
      }
      guard overlayModeRaw == "clean" || overlayModeRaw == "annotated" else {
        DispatchQueue.main.async {
          reject("invalid_overlay_mode", "overlayMode must be \"clean\" or \"annotated\"", nil)
        }
        return
      }

      // Optional ball seed (normalized 0-1, upright frame space). Absent (or
      // explicit null) → behavior identical to the unseeded tracker.
      // Present-but-malformed rejects rather than silently running unseeded.
      var ballSeedNorm: (x: Double, y: Double)? = nil
      if let rawSeed = options?["ballSeed"], !(rawSeed is NSNull) {
        guard let seedDict = rawSeed as? NSDictionary,
              let sx = (seedDict["x"] as? NSNumber)?.doubleValue,
              let sy = (seedDict["y"] as? NSNumber)?.doubleValue,
              sx.isFinite, sy.isFinite,
              sx >= 0.0, sx <= 1.0, sy >= 0.0, sy <= 1.0 else {
          DispatchQueue.main.async {
            reject("invalid_seed", "ballSeed must be {x, y} with both normalized 0-1", nil)
          }
          return
        }
        ballSeedNorm = (sx, sy)
      }

      // Head detector selection: "shaft" (default — line fit, head = lower
      // endpoint), "blob" (legacy dark-blob path, kept intact for A/B on
      // fixtures), or "bar" (Phase A2 — v7.6.5 pinned twin-edge bar fitter,
      // HoneyPuttingBarFitter.swift, own pass structure below). Anything else
      // rejects rather than silently defaulting.
      let headDetectorRaw = (options?["headDetector"] as? String) ?? "shaft"
      guard headDetectorRaw == "shaft" || headDetectorRaw == "blob"
        || headDetectorRaw == "bar" else {
        DispatchQueue.main.async {
          reject("invalid_head_detector",
                 "headDetector must be \"shaft\", \"blob\" or \"bar\"", nil)
        }
        return
      }
      let useShaftDetector = headDetectorRaw == "shaft"

      // Pose priors (shaft mode): per-video-grid-frame expected shaft angle +
      // hand-cluster anchor (normalized 0-1), derived JS-side from
      // motion_frames — indices align 1:1 with this grid (poseAngleScan).
      // The caller already gated joints at confidence 0.3, so the confidence
      // field is informational; malformed/missing entries → null → pure-CV
      // gates for that frame. PRIOR ONLY: never a head position source.
      var posePriors: [(angleDeg: Double, ax: Double, ay: Double)?] = []
      if let rawPriors = options?["posePriors"] as? NSArray {
        posePriors.reserveCapacity(rawPriors.count)
        for item in rawPriors {
          if let d = item as? NSDictionary,
             let a = (d["angleDeg"] as? NSNumber)?.doubleValue,
             let x = (d["anchorX"] as? NSNumber)?.doubleValue,
             let y = (d["anchorY"] as? NSNumber)?.doubleValue,
             a.isFinite, x.isFinite, y.isFinite,
             x >= 0.0, x <= 1.0, y >= 0.0, y <= 1.0 {
            posePriors.append((a, x, y))
          } else {
            posePriors.append(nil)
          }
        }
      }

      guard let url = URL(string: videoUri as String) else {
        DispatchQueue.main.async {
          reject("invalid_video", "Could not parse video URI: \(videoUri)", nil)
        }
        return
      }
      let asset = AVURLAsset(url: url)
      guard let track = asset.tracks(withMediaType: .video).first else {
        DispatchQueue.main.async { reject("no_video_track", "asset has no video track", nil) }
        return
      }
      let preferredTransform = track.preferredTransform
      let durationSeconds = CMTimeGetSeconds(track.timeRange.duration)
      guard durationSeconds.isFinite, durationSeconds > 0 else {
        DispatchQueue.main.async {
          reject("invalid_video", "video track has no readable duration", nil)
        }
        return
      }
      let durationMs = durationSeconds * 1000.0

      // Timestamp grid: identical formula + `<` bound as the RTMW pose path
      // (lib/extractPoseFromVideo.ts:83-85); generated natively because a
      // downloaded fixture clip's duration is unknown to JS.
      var grid: [Double] = []
      var t = 0.0
      while t < durationMs {
        grid.append(t)
        t += step
      }

      // ---- PASS A: ball-rest anchor over the first BALL_REST_SAMPLE_FRAMES
      // grid timestamps (~200ms). A separate short decode pass so the head ROI
      // is known for EVERY frame of the main pass (no buffering, sequential
      // overlay writes). Cost: ~200ms of re-decode.
      guard let anchorCursor = DecodeCursor(asset: asset, track: track) else {
        DispatchQueue.main.async {
          reject("reader_init_failed", "AVAssetReader init failed (anchor pass)", nil)
        }
        return
      }
      var anchorDetections: [(x: Double, y: Double)] = []
      var anchorPrev: (x: Double, y: Double)? = nil
      var seedPx: (x: Double, y: Double)? = nil // ballSeedNorm in analysis px
      var analysisW = 0
      var analysisH = 0
      var fullW = 0
      var fullH = 0
      for ts in grid.prefix(Self.BALL_REST_SAMPLE_FRAMES) {
        let keepGoing = autoreleasepool { () -> Bool in
          guard let sample = anchorCursor.nearestSample(toMs: ts),
                let cgImage = Self.uprightImage(from: sample, transform: preferredTransform) else {
            return false
          }
          if fullW == 0 {
            fullW = cgImage.width
            fullH = cgImage.height
            analysisW = Self.ANALYSIS_WIDTH
            let rawH = Int((Double(fullH) * Double(analysisW) / Double(fullW)).rounded())
            analysisH = rawH - (rawH % 2) // even for the H.264 overlay writer
            if let s = ballSeedNorm {
              seedPx = (s.x * Double(analysisW), s.y * Double(analysisH))
            }
          }
          guard let buffer = Self.makeAnalysisBuffer(cgImage, width: analysisW, height: analysisH) else {
            return false
          }
          let band = Self.ballSearchBand(analysisW: analysisW, analysisH: analysisH)
          let mask = Self.buildMask(buffer: buffer, roi: band, kind: .brightBall)
          // Seeded mode: the anchor pass only accepts candidates inside the
          // seed lock radius (rejects the OTHER white balls in multi-ball
          // fixtures before they can pollute the median).
          let seedGate: (x: Double, y: Double, radius: Double)? =
            seedPx.map { (x: $0.x, y: $0.y, radius: Self.SEED_LOCK_RADIUS_PX) }
          if let det = Self.selectBlob(mask: mask, roi: band, isBall: true, prev: anchorPrev,
                                       gate: seedGate),
             det.confidence >= Self.MIN_CONFIDENCE_FLOOR {
            anchorDetections.append((det.x, det.y))
            anchorPrev = (det.x, det.y)
          }
          return true
        }
        if !keepGoing { break }
      }
      anchorCursor.cancel()

      // Anchor decision: pre-moving-ball decoys must NOT anchor the head ROI
      // to a moving ball — spread/paucity → unanchored full-width ROI.
      // Seeded mode overrides: the caller vouched for the rest position, so
      // the anchor is the median of the seed-locked detections (the seed
      // itself if none survived the lock radius) and skips the spread check.
      var anchored = false
      var anchorX = 0.0
      var anchorY = 0.0
      var roiAnchorMode = "unanchored"
      if ballSeedNorm != nil {
        roiAnchorMode = "seeded"
        if let seed = seedPx {
          if anchorDetections.isEmpty {
            anchorX = seed.x
            anchorY = seed.y
          } else {
            let xs = anchorDetections.map { $0.x }.sorted()
            let ys = anchorDetections.map { $0.y }.sorted()
            anchorX = xs[xs.count / 2]
            anchorY = ys[ys.count / 2]
          }
          anchored = true
        }
        // seedPx nil = the anchor pass decoded zero frames; resolved lazily
        // on the main pass's first frame below.
      } else if anchorDetections.count >= Self.BALL_REST_ANCHOR_MIN_DETECTIONS {
        let xs = anchorDetections.map { $0.x }.sorted()
        let ys = anchorDetections.map { $0.y }.sorted()
        anchorX = xs[xs.count / 2]
        anchorY = ys[ys.count / 2]
        let maxDev = anchorDetections
          .map { max(abs($0.x - anchorX), abs($0.y - anchorY)) }
          .max() ?? 0
        anchored = maxDev <= Self.BALL_REST_ANCHOR_MAX_SPREAD_PX
        if anchored { roiAnchorMode = "ball_rest" }
      }

      // Unanchored mat-level estimate for the head band: seed y if present,
      // else the rest-pass median y when any detections existed (a rough mat
      // level even if they failed the spread check). nil → no estimate.
      var unanchoredMatY: Double? = nil
      if !anchored {
        if let seed = seedPx {
          unanchoredMatY = seed.y
        } else if !anchorDetections.isEmpty {
          let ys = anchorDetections.map { $0.y }.sorted()
          unanchoredMatY = ys[ys.count / 2]
        }
      }

      // ---- BAR MODE (Phase A2): the v7.6.5 pinned bar fitter runs its OWN
      // pass structure (B' ball-only track → guarded launch + SHAFT_LEN
      // rest-window calibration → C' calibrated fits). PASS A above is shared
      // (unchanged); shaft/blob continue into the untouched PASS B below.
      if headDetectorRaw == "bar" {
        Self.runBarMode(asset: asset, track: track, preferredTransform: preferredTransform,
                        grid: grid, durationMs: durationMs,
                        posePriorsNorm: posePriors,
                        ballSeedNorm: ballSeedNorm, seedPx0: seedPx,
                        anchored0: anchored, anchorX0: anchorX, anchorY0: anchorY,
                        unanchoredMatY: unanchoredMatY, roiAnchorMode: roiAnchorMode,
                        writeOverlay: writeOverlay, annotateOverlay: annotateOverlay,
                        analysisW0: analysisW, analysisH0: analysisH,
                        fullW0: fullW, fullH0: fullH,
                        resolve: resolve, reject: reject)
        return
      }

      // ---- PASS B: full tracking pass.
      guard let cursor = DecodeCursor(asset: asset, track: track) else {
        DispatchQueue.main.async {
          reject("reader_init_failed", "AVAssetReader init failed (main pass)", nil)
        }
        return
      }

      var overlay: OverlayWriter? = nil
      var frames: [[String: Any]] = []
      var prevBall: (x: Double, y: Double)? = nil
      var prevHead: (x: Double, y: Double)? = nil
      var prevLuma: [UInt8]? = nil // previous ANALYSIS frame, feeds head motion factor
      // Shaft detector state (headDetector == "shaft"):
      var lastBallRadiusPx: Double? = nil // analysis px, for the ball-exclusion disc
      var lastShaftLine: (px: Double, py: Double, dx: Double, dy: Double)? = nil
      var lastShaftSegment: (x0: Double, y0: Double, x1: Double, y1: Double)? = nil
      var lastShaftHead: Detection? = nil
      var shaftHoldAge = 0 // consecutive frames since the last accepted fit

      for (gi, ts) in grid.enumerated() {
        let keepGoing = autoreleasepool { () -> Bool in
          guard let sample = cursor.nearestSample(toMs: ts) else {
            return false // stream exhausted → stop emitting
          }
          guard let cgImage = Self.uprightImage(from: sample, transform: preferredTransform) else {
            return false
          }
          if fullW == 0 {
            fullW = cgImage.width
            fullH = cgImage.height
            analysisW = Self.ANALYSIS_WIDTH
            let rawH = Int((Double(fullH) * Double(analysisW) / Double(fullW)).rounded())
            analysisH = rawH - (rawH % 2)
            // Anchor pass decoded zero frames (degenerate clip): resolve the
            // seed here so the seeded gate + head ROI anchor still apply.
            if seedPx == nil, let s = ballSeedNorm {
              let px = (x: s.x * Double(analysisW), y: s.y * Double(analysisH))
              seedPx = px
              anchorX = px.x
              anchorY = px.y
              anchored = true
            }
          }
          guard let buffer = Self.makeAnalysisBuffer(cgImage, width: analysisW, height: analysisH) else {
            return false
          }
          if writeOverlay, overlay == nil {
            overlay = OverlayWriter(width: analysisW, height: analysisH)
          }

          let band = Self.ballSearchBand(analysisW: analysisW, analysisH: analysisH)

          // Luma captured BEFORE drawOverlay mutates the buffer. nil motion
          // (first frame — no previous luma) → motionFactor 0 everywhere.
          let luma = Self.lumaPlane(buffer: buffer)
          let headMotion: (changed: [Bool], frameWidth: Int)? = prevLuma.map {
            (changed: Self.motionChangedMask(cur: luma, prev: $0), frameWidth: analysisW)
          }

          // ---- BALL (LOCKED — selection, fallback, floor all unchanged).
          // Runs before the head branch only so the shaft detector can
          // exclude the resolved ball's pixels from its candidate set.
          // Seeded mode: HARD gate — reject ball candidates farther than
          // SEEDED_MAX_JUMP_PX from the last accepted centroid (the seed
          // until the first acceptance). Applies to the Vision fallback too.
          let ballGate: (x: Double, y: Double, radius: Double)? = seedPx.map { seed in
            let c = prevBall ?? seed
            return (x: c.x, y: c.y, radius: Self.SEEDED_MAX_JUMP_PX)
          }
          let ballMask = Self.buildMask(buffer: buffer, roi: band, kind: .brightBall)
          var ball = Self.selectBlob(mask: ballMask, roi: band, isBall: true, prev: prevBall,
                                     gate: ballGate)
          let analysisImage = CIImage(cvPixelBuffer: buffer)
          if (ball?.confidence ?? 0) < Self.MIN_CONFIDENCE_FLOOR {
            ball = Self.visionFallback(image: analysisImage, roi: band,
                                       analysisH: analysisH, isBall: true, prev: prevBall,
                                       gate: ballGate)
          }
          if let b = ball, b.confidence < Self.MIN_CONFIDENCE_FLOOR { ball = nil }
          if let b = ball { lastBallRadiusPx = (b.area / Double.pi).squareRoot() }

          // ---- HEAD branch: shaft-first (default) or legacy blob.
          var head: Detection? = nil
          let headRoi: Roi
          var shaftOverlaySegment: (x0: Double, y0: Double, x1: Double, y1: Double)? = nil
          var poseAnchorForOverlay: (x: Double, y: Double)? = nil
          var headCandidatesDump: [[String: Any]]? = nil
          var shaftDebugDict: [String: Any]? = nil

          if useShaftDetector {
            headRoi = Self.shaftRoi(anchored: anchored, anchorX: anchorX, anchorY: anchorY,
                                    matYEstimate: unanchoredMatY,
                                    analysisW: analysisW, analysisH: analysisH)
            // Pose prior for this grid frame (normalized → analysis px).
            let priorNorm = gi < posePriors.count ? posePriors[gi] : nil
            let posePrior = priorNorm.map {
              (angleDeg: $0.angleDeg,
               ax: $0.ax * Double(analysisW),
               ay: $0.ay * Double(analysisH))
            }
            poseAnchorForOverlay = posePrior.map { ($0.ax, $0.ay) }
            // Ball-exclusion disc: current-frame ball, else last-known
            // centroid with last-known radius (6px default before any ball).
            var ballExclusion: (x: Double, y: Double, r: Double)? = nil
            if let b = ball {
              ballExclusion = (b.x, b.y,
                               Self.BALL_EXCLUSION_RADIUS_FACTOR * (b.area / Double.pi).squareRoot())
            } else if let pb = prevBall {
              ballExclusion = (pb.x, pb.y,
                               Self.BALL_EXCLUSION_RADIUS_FACTOR * (lastBallRadiusPx ?? 6.0))
            }
            let fit = Self.detectShaftHead(
              luma: luma, changed: headMotion?.changed,
              analysisW: analysisW, analysisH: analysisH, roi: headRoi,
              anchorX: anchored ? anchorX : nil,
              matY: anchored ? anchorY : unanchoredMatY,
              ballExclusion: ballExclusion,
              posePrior: posePrior,
              prevLine: lastShaftLine)
            var heldFlag = false
            if let lineRef = fit.lineRef {
              lastShaftLine = lineRef
              lastShaftSegment = fit.segment
              lastShaftHead = fit.head
              shaftHoldAge = 0
              head = fit.head
              shaftOverlaySegment = fit.segment
            } else {
              shaftHoldAge += 1
              if shaftHoldAge > Self.MAX_LINE_HOLD_FRAMES {
                lastShaftLine = nil
                lastShaftSegment = nil
                lastShaftHead = nil
              } else if let lh = lastShaftHead {
                let decayed = lh.confidence * pow(Self.SHAFT_HOLD_DECAY, Double(shaftHoldAge))
                head = Detection(x: lh.x, y: lh.y, area: lh.area,
                                 confidence: decayed, source: "shaft_held")
                shaftOverlaySegment = lastShaftSegment
                heldFlag = true
              }
            }
            if debugCandidates {
              var dbg = fit.debug
              dbg["held"] = heldFlag
              shaftDebugDict = dbg
            }
            // No Vision fallback in shaft mode — the fallback is a blob
            // scorer and would reintroduce the wrong-object contest.
          } else {
            headRoi = Self.headRoi(anchored: anchored, anchorX: anchorX, anchorY: anchorY,
                                   matYEstimate: unanchoredMatY,
                                   analysisW: analysisW, analysisH: analysisH)
            let headMask = Self.buildMask(buffer: buffer, roi: headRoi, kind: .darkHead)
            // DIAGNOSTIC dump BEFORE selection so it scores against the same
            // prevHead the live selection is about to use.
            if debugCandidates {
              headCandidatesDump = Self.dumpHeadCandidates(
                mask: headMask, roi: headRoi, prev: prevHead, motion: headMotion,
                scale: Double(fullW) / Double(analysisW))
            }
            head = Self.selectBlob(mask: headMask, roi: headRoi, isBall: false, prev: prevHead,
                                   motion: headMotion)
            // APPLE VISION FALLBACK — bounded exactly as specified: ONLY on
            // frames where the color pass's best confidence is below the floor.
            if (head?.confidence ?? 0) < Self.MIN_CONFIDENCE_FLOOR {
              head = Self.visionFallback(image: analysisImage, roi: headRoi,
                                         analysisH: analysisH, isBall: false, prev: prevHead)
            }
          }
          if let h = head, h.confidence < Self.MIN_CONFIDENCE_FLOOR { head = nil }

          // Overlay drawing happens BEFORE prev-position update so a null
          // frame rings the LAST-KNOWN position (hollow = missing). In
          // "clean" mode the buffer is appended untouched — raw decoded
          // frames, nothing drawn.
          if let writer = overlay, !writer.failed {
            if annotateOverlay {
              Self.drawOverlay(on: buffer, headRoi: headRoi, ball: ball, head: head,
                               lastBall: prevBall, lastHead: prevHead,
                               shaftSegment: shaftOverlaySegment, poseAnchor: poseAnchorForOverlay,
                               analysisH: analysisH)
            }
            writer.append(buffer, ptsMs: ts)
          }

          if let b = ball { prevBall = (b.x, b.y) }
          if let h = head { prevHead = (h.x, h.y) }
          prevLuma = luma

          // Scale analysis-space detections to full-res pixels for the payload.
          let s = Double(fullW) / Double(analysisW)
          var frame: [String: Any] = [
            "timestampMs": ts,
            "frameWidth": fullW,
            "frameHeight": fullH,
          ]
          if let b = ball {
            frame["ball"] = [
              "x": b.x * s,
              "y": b.y * s,
              "radiusPx": (b.area / Double.pi).squareRoot() * s,
              "confidence": b.confidence,
              "source": b.source,
            ]
          } else {
            frame["ball"] = NSNull()
          }
          if let h = head {
            frame["head"] = [
              "x": h.x * s,
              "y": h.y * s,
              "areaPx": h.area * s * s,
              "confidence": h.confidence,
              "source": h.source,
            ]
          } else {
            frame["head"] = NSNull()
          }
          if let dump = headCandidatesDump {
            frame["headCandidates"] = dump
          }
          if let sd = shaftDebugDict {
            frame["shaftDebug"] = sd
          }
          frames.append(frame)
          return true
        }
        if !keepGoing { break }
      }

      // Template D7: a mid-stream read failure rejects the whole extraction
      // rather than resolving a partial set.
      if cursor.reader.status == .failed {
        DispatchQueue.main.async {
          reject("reader_failed",
                 "AVAssetReader failed mid-stream: \(cursor.reader.error?.localizedDescription ?? "unknown")",
                 nil)
        }
        return
      }

      let overlayUri = overlay?.finish()

      let payload: [String: Any] = [
        "videoDurationMs": durationMs,
        "frameWidth": fullW,
        "frameHeight": fullH,
        "roiAnchor": roiAnchorMode,
        "headDetector": headDetectorRaw,
        "overlayUri": overlayUri ?? NSNull(),
        "frames": frames,
      ]
      DispatchQueue.main.async { resolve(payload) }
    }
  }

  // MARK: - BAR MODE (Phase A2 — v7.6.5 fitter passes; fitter math lives in
  // HoneyPuttingBarFitter.swift, EXTERNAL ASSUMPTION constants documented
  // there). Ball detection below CALLS the locked ball path read-only —
  // identical gates/fallback/floor as PASS B; the locked bodies are untouched.

  private static func runBarMode(asset: AVAsset, track: AVAssetTrack,
                                 preferredTransform: CGAffineTransform,
                                 grid: [Double], durationMs: Double,
                                 posePriorsNorm: [(angleDeg: Double, ax: Double, ay: Double)?],
                                 ballSeedNorm: (x: Double, y: Double)?,
                                 seedPx0: (x: Double, y: Double)?,
                                 anchored0: Bool, anchorX0: Double, anchorY0: Double,
                                 unanchoredMatY: Double?, roiAnchorMode: String,
                                 writeOverlay: Bool, annotateOverlay: Bool,
                                 analysisW0: Int, analysisH0: Int, fullW0: Int, fullH0: Int,
                                 resolve: @escaping RCTPromiseResolveBlock,
                                 reject: @escaping RCTPromiseRejectBlock) {
    var analysisW = analysisW0
    var analysisH = analysisH0
    var fullW = fullW0
    var fullH = fullH0
    var anchored = anchored0
    var anchorX = anchorX0
    var anchorY = anchorY0
    var seedPx = seedPx0

    // ---- PASS B': ball-only track over the full grid (LOCKED path, read-only
    // calls — same seeded gate / Vision fallback / confidence floor as PASS B).
    guard let cursorB = DecodeCursor(asset: asset, track: track) else {
      DispatchQueue.main.async {
        reject("reader_init_failed", "AVAssetReader init failed (bar ball pass)", nil)
      }
      return
    }
    var ballDetections: [Detection?] = []
    var prevBall: (x: Double, y: Double)? = nil
    for ts in grid {
      let keepGoing = autoreleasepool { () -> Bool in
        guard let sample = cursorB.nearestSample(toMs: ts),
              let cgImage = Self.uprightImage(from: sample, transform: preferredTransform) else {
          return false
        }
        if fullW == 0 {
          fullW = cgImage.width
          fullH = cgImage.height
          analysisW = Self.ANALYSIS_WIDTH
          let rawH = Int((Double(fullH) * Double(analysisW) / Double(fullW)).rounded())
          analysisH = rawH - (rawH % 2)
          if seedPx == nil, let s = ballSeedNorm {
            let px = (x: s.x * Double(analysisW), y: s.y * Double(analysisH))
            seedPx = px
            anchorX = px.x
            anchorY = px.y
            anchored = true
          }
        }
        guard let buffer = Self.makeAnalysisBuffer(cgImage, width: analysisW, height: analysisH) else {
          return false
        }
        let band = Self.ballSearchBand(analysisW: analysisW, analysisH: analysisH)
        let ballGate: (x: Double, y: Double, radius: Double)? = seedPx.map { seed in
          let c = prevBall ?? seed
          return (x: c.x, y: c.y, radius: Self.SEEDED_MAX_JUMP_PX)
        }
        let ballMask = Self.buildMask(buffer: buffer, roi: band, kind: .brightBall)
        var ball = Self.selectBlob(mask: ballMask, roi: band, isBall: true, prev: prevBall,
                                   gate: ballGate)
        if (ball?.confidence ?? 0) < Self.MIN_CONFIDENCE_FLOOR {
          ball = Self.visionFallback(image: CIImage(cvPixelBuffer: buffer), roi: band,
                                     analysisH: analysisH, isBall: true, prev: prevBall,
                                     gate: ballGate)
        }
        if let b = ball, b.confidence < Self.MIN_CONFIDENCE_FLOOR { ball = nil }
        if let b = ball { prevBall = (b.x, b.y) }
        ballDetections.append(ball)
        return true
      }
      if !keepGoing { break }
    }
    if cursorB.reader.status == .failed {
      DispatchQueue.main.async {
        reject("reader_failed",
               "AVAssetReader failed mid-stream (bar ball pass): \(cursorB.reader.error?.localizedDescription ?? "unknown")",
               nil)
      }
      return
    }
    cursorB.cancel()
    let emittedCount = ballDetections.count
    guard emittedCount > 0, fullW > 0 else {
      DispatchQueue.main.async {
        reject("no_frames", "bar mode decoded zero frames", nil)
      }
      return
    }

    let s = Double(fullW) / Double(analysisW)
    let balls: [BarBall?] = ballDetections.map { det in
      det.map { BarBall(x: $0.x, y: $0.y, r: ($0.area / Double.pi).squareRoot()) }
    }

    // Guarded launch on the FULL-RES ball series — identical semantics to the
    // TS detectImpact (device cross-check: launchFrameIdx == impactFrame).
    let fullResBalls: [(x: Double, y: Double)?] = ballDetections.map { det in
      det.map { (x: $0.x * s, y: $0.y * s) }
    }
    let launchInfo = HoneyPuttingBarFitter.computeBallLaunch(fullResBalls: fullResBalls)
    let launch = launchInfo?.launch

    // Pose priors → analysis px, med3 anchor smoothing, hand-x velocities.
    var priorsPx: [BarPrior?] = []
    priorsPx.reserveCapacity(emittedCount)
    for gi in 0..<emittedCount {
      let raw = gi < posePriorsNorm.count ? posePriorsNorm[gi] : nil
      priorsPx.append(raw.map {
        BarPrior(angleDeg: $0.angleDeg,
                 ax: $0.ax * Double(analysisW),
                 ay: $0.ay * Double(analysisH))
      })
    }
    let priors = HoneyPuttingBarFitter.smoothedPriors(priorsPx)
    let matY = anchored ? anchorY : (unanchoredMatY ?? 0.8 * Double(analysisH))

    // ---- PASS B'': SHAFT_LEN rest-window calibration. Rest window = first
    // 60% of PRE-LAUNCH ball-present frames (v765 cal button). The cal loop
    // commits ONLY accepted fits (ladderCommits: false — no pose-fallback
    // commits during calibration; the fitter never depends on a prior length).
    var ballFrames: [Int] = []
    for (i, b) in balls.enumerated() where b != nil {
      if launch == nil || i < launch! { ballFrames.append(i) }
    }
    let calFrames = Array(ballFrames.prefix(max(1, Int(Double(ballFrames.count) * 0.6))))
    var shaftLen: Double? = nil
    var acceptedFitCount = 0
    if calFrames.count >= 3 {
      guard let cursorCal = DecodeCursor(asset: asset, track: track) else {
        DispatchQueue.main.async {
          reject("reader_init_failed", "AVAssetReader init failed (bar cal pass)", nil)
        }
        return
      }
      var calState = BarFitterState()
      var lens: [Double] = []
      for fi in calFrames {
        let keepGoing = autoreleasepool { () -> Bool in
          guard let sample = cursorCal.nearestSample(toMs: grid[fi]),
                let cgImage = Self.uprightImage(from: sample, transform: preferredTransform),
                let buffer = Self.makeAnalysisBuffer(cgImage, width: analysisW, height: analysisH) else {
            return false
          }
          let luma = HoneyPuttingBarFitter.meanLumaPlane(buffer: buffer)
          let r = HoneyPuttingBarFitter.fitFrame(
            luma: luma, W: analysisW, H: analysisH,
            prior: fi < priors.count ? priors[fi] : nil,
            ball: balls[fi], preImpact: true, shaftLen: nil, matY: matY,
            vx: HoneyPuttingBarFitter.handVx(priors, fi),
            state: &calState, ladderCommits: false)
          if r.source == "cv" || r.source == "recovery" { lens.append(r.spanPx) }
          return true
        }
        if !keepGoing { break }
      }
      cursorCal.cancel()
      shaftLen = HoneyPuttingBarFitter.medianShaftLen(lens)
      acceptedFitCount = lens.count
    }

    // ---- PASS C': calibrated fits over every frame + payload + overlay.
    guard let cursorC = DecodeCursor(asset: asset, track: track) else {
      DispatchQueue.main.async {
        reject("reader_init_failed", "AVAssetReader init failed (bar fit pass)", nil)
      }
      return
    }
    var overlay: OverlayWriter? = nil
    var frames: [[String: Any]] = []
    var state = BarFitterState()
    var prevBallOverlay: (x: Double, y: Double)? = nil
    var prevHeadOverlay: (x: Double, y: Double)? = nil
    for gi in 0..<emittedCount {
      let keepGoing = autoreleasepool { () -> Bool in
        guard let sample = cursorC.nearestSample(toMs: grid[gi]),
              let cgImage = Self.uprightImage(from: sample, transform: preferredTransform),
              let buffer = Self.makeAnalysisBuffer(cgImage, width: analysisW, height: analysisH) else {
          return false
        }
        if writeOverlay, overlay == nil {
          overlay = OverlayWriter(width: analysisW, height: analysisH)
        }
        let luma = HoneyPuttingBarFitter.meanLumaPlane(buffer: buffer)
        let preImpact = launch == nil || gi < launch!
        let fit = HoneyPuttingBarFitter.fitFrame(
          luma: luma, W: analysisW, H: analysisH,
          prior: gi < priors.count ? priors[gi] : nil,
          ball: balls[gi], preImpact: preImpact, shaftLen: shaftLen, matY: matY,
          vx: HoneyPuttingBarFitter.handVx(priors, gi),
          state: &state, ladderCommits: true)

        // head export: tube endpoint, cv/recovery fits only (real pixel
        // evidence; fallback/hold frames carry the line in shaftFit instead).
        // Confidence = lengthMatch (proxy — locked schema requires a value).
        var headDet: Detection? = nil
        if fit.source == "cv" || fit.source == "recovery",
           let ang = fit.angleDeg, let gx = fit.gripX, let gy = fit.gripY {
          let th = ang * Double.pi / 180
          headDet = Detection(x: gx + sin(th) * fit.spanPx,
                              y: gy + cos(th) * fit.spanPx,
                              area: 0,
                              confidence: min(1.0, max(0.0, fit.lengthMatch ?? 0.5)),
                              source: "bar")
        }

        if let writer = overlay, !writer.failed {
          if annotateOverlay {
            var segment: (x0: Double, y0: Double, x1: Double, y1: Double)? = nil
            if let ang = fit.angleDeg, let gx = fit.gripX, let gy = fit.gripY {
              let th = ang * Double.pi / 180
              let reach = fit.spanPx > 0 ? fit.spanPx : (shaftLen ?? 150)
              segment = (gx, gy, gx + sin(th) * reach, gy + cos(th) * reach)
            }
            Self.drawOverlay(on: buffer, headRoi: Roi(x0: 0, y0: 0, x1: 0, y1: 0),
                             ball: ballDetections[gi], head: headDet,
                             lastBall: prevBallOverlay, lastHead: prevHeadOverlay,
                             shaftSegment: segment,
                             poseAnchor: priors[gi].map { ($0.ax, $0.ay) },
                             analysisH: analysisH)
          }
          writer.append(buffer, ptsMs: grid[gi])
        }
        if let b = ballDetections[gi] { prevBallOverlay = (b.x, b.y) }
        if let h = headDet { prevHeadOverlay = (h.x, h.y) }

        var frame: [String: Any] = [
          "timestampMs": grid[gi],
          "frameWidth": fullW,
          "frameHeight": fullH,
        ]
        if let b = ballDetections[gi] {
          frame["ball"] = [
            "x": b.x * s,
            "y": b.y * s,
            "radiusPx": (b.area / Double.pi).squareRoot() * s,
            "confidence": b.confidence,
            "source": b.source,
          ]
        } else {
          frame["ball"] = NSNull()
        }
        if let h = headDet {
          frame["head"] = [
            "x": h.x * s,
            "y": h.y * s,
            "areaPx": 0,
            "confidence": h.confidence,
            "source": "bar",
          ]
        } else {
          frame["head"] = NSNull()
        }
        // shaftFit: ANALYSIS px @480w (deliberately NOT scaled — the frozen
        // bar constants and the TS smoother/refiner operate in this space).
        var sf: [String: Any] = [
          "spanPx": fit.spanPx,
          "score": fit.score,
          "pivotOffsetPx": fit.pivotOffsetPx,
          "source": fit.source,
        ]
        sf["angleDeg"] = fit.angleDeg ?? NSNull()
        sf["gripX"] = fit.gripX ?? NSNull()
        sf["gripY"] = fit.gripY ?? NSNull()
        sf["matX"] = fit.matX ?? NSNull()
        sf["lengthMatch"] = fit.lengthMatch ?? NSNull()
        frame["shaftFit"] = sf
        frames.append(frame)
        return true
      }
      if !keepGoing { break }
    }
    if cursorC.reader.status == .failed {
      DispatchQueue.main.async {
        reject("reader_failed",
               "AVAssetReader failed mid-stream (bar fit pass): \(cursorC.reader.error?.localizedDescription ?? "unknown")",
               nil)
      }
      return
    }
    let overlayUri = overlay?.finish()

    var calibration: Any = NSNull()
    if let l = shaftLen, let info = launchInfo {
      calibration = [
        "shaftLenPx": l,
        "restStartIdx": info.restStart,
        "restEndIdx": info.restEnd,
        "acceptedFitCount": acceptedFitCount,
        "launchFrameIdx": info.launch ?? NSNull(),
      ] as [String: Any]
    }
    let payload: [String: Any] = [
      "videoDurationMs": durationMs,
      "frameWidth": fullW,
      "frameHeight": fullH,
      "roiAnchor": roiAnchorMode,
      "headDetector": "bar",
      "overlayUri": overlayUri ?? NSNull(),
      "frames": frames,
      "barCalibration": calibration,
      "analysisWidth": analysisW,
      "analysisHeight": analysisH,
    ]
    DispatchQueue.main.async { resolve(payload) }
  }

  // MARK: - refinePutterHead (Phase A2 — windowed greenness-ellipse refiner)

  /// Refines the putter-head position on the caller-specified grid frames.
  /// The ellipse center per frame is (gripX,gripY) + unit(angleDeg) ×
  /// (shaftLenPx + headExtPx) — predicted by the TS smoothed series, never
  /// recomputed here. Per-frame refine failure (or a frame past stream end)
  /// COASTS on the prediction; only malformed input rejects the call.
  /// Spec/points are ANALYSIS px @480w.
  @objc(refinePutterHead:stepMs:spec:resolver:rejecter:)
  func refinePutterHead(_ videoUri: NSString,
                        stepMs: NSNumber,
                        spec: NSDictionary?,
                        resolver resolve: @escaping RCTPromiseResolveBlock,
                        rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      let step = stepMs.doubleValue
      guard step > 0, step.isFinite else {
        DispatchQueue.main.async { reject("invalid_step", "stepMs must be > 0, got \(step)", nil) }
        return
      }
      guard let shaftLenPx = (spec?["shaftLenPx"] as? NSNumber)?.doubleValue,
            shaftLenPx > 0, shaftLenPx.isFinite,
            let headExtPx = (spec?["headExtPx"] as? NSNumber)?.doubleValue,
            headExtPx >= 0, headExtPx.isFinite,
            let rawFrames = spec?["frames"] as? NSArray, rawFrames.count > 0 else {
        DispatchQueue.main.async {
          reject("invalid_spec",
                 "spec must be {frames: [...], shaftLenPx > 0, headExtPx >= 0}", nil)
        }
        return
      }
      var specFrames: [(gridIdx: Int, gripX: Double, gripY: Double, angleDeg: Double)] = []
      specFrames.reserveCapacity(rawFrames.count)
      for item in rawFrames {
        guard let d = item as? NSDictionary,
              let gi = (d["gridIdx"] as? NSNumber)?.intValue, gi >= 0,
              let gx = (d["gripX"] as? NSNumber)?.doubleValue, gx.isFinite,
              let gy = (d["gripY"] as? NSNumber)?.doubleValue, gy.isFinite,
              let a = (d["angleDeg"] as? NSNumber)?.doubleValue, a.isFinite else {
          DispatchQueue.main.async {
            reject("invalid_spec", "each frame needs {gridIdx>=0, gripX, gripY, angleDeg}", nil)
          }
          return
        }
        specFrames.append((gi, gx, gy, a))
      }
      specFrames.sort { $0.gridIdx < $1.gridIdx }

      guard let url = URL(string: videoUri as String) else {
        DispatchQueue.main.async {
          reject("invalid_video", "Could not parse video URI: \(videoUri)", nil)
        }
        return
      }
      let asset = AVURLAsset(url: url)
      guard let track = asset.tracks(withMediaType: .video).first else {
        DispatchQueue.main.async { reject("no_video_track", "asset has no video track", nil) }
        return
      }
      let preferredTransform = track.preferredTransform
      guard let cursor = DecodeCursor(asset: asset, track: track) else {
        DispatchQueue.main.async {
          reject("reader_init_failed", "AVAssetReader init failed (refine pass)", nil)
        }
        return
      }

      var analysisW = 0
      var analysisH = 0
      var points: [[String: Any]] = []
      let reach = shaftLenPx + headExtPx
      for f in specFrames {
        autoreleasepool {
          let th = f.angleDeg * Double.pi / 180
          let cx = f.gripX + sin(th) * reach
          let cy = f.gripY + cos(th) * reach
          var refined: (x: Double, y: Double, count: Int)? = nil
          if let sample = cursor.nearestSample(toMs: Double(f.gridIdx) * step),
             let cgImage = Self.uprightImage(from: sample, transform: preferredTransform) {
            if analysisW == 0 {
              analysisW = Self.ANALYSIS_WIDTH
              let rawH = Int((Double(cgImage.height) * Double(analysisW) / Double(cgImage.width)).rounded())
              analysisH = rawH - (rawH % 2)
            }
            if let buffer = Self.makeAnalysisBuffer(cgImage, width: analysisW, height: analysisH) {
              refined = HoneyPuttingBarFitter.refineHeadEllipse(buffer: buffer, cx: cx, cy: cy,
                                                                angRad: th)
            }
          }
          if let r = refined {
            points.append(["gridIdx": f.gridIdx, "x": r.x, "y": r.y,
                           "coasted": false, "candidateCount": r.count])
          } else {
            // Coast on the prediction — never a jump, never a call failure.
            points.append(["gridIdx": f.gridIdx, "x": cx, "y": cy,
                           "coasted": true, "candidateCount": 0])
          }
        }
      }
      if cursor.reader.status == .failed {
        DispatchQueue.main.async {
          reject("reader_failed",
                 "AVAssetReader failed mid-stream (refine pass): \(cursor.reader.error?.localizedDescription ?? "unknown")",
                 nil)
        }
        return
      }
      cursor.cancel()
      DispatchQueue.main.async { resolve(["points": points]) }
    }
  }

  // MARK: - Decode helpers (template clones)

  /// Template D1c/D3 upright transform, verbatim: conjugate preferredTransform
  /// with y-flips (P authored top-left, CI operates bottom-left) → pure
  /// rotation, no mirroring.
  private static func uprightImage(from sample: CMSampleBuffer,
                                   transform: CGAffineTransform) -> CGImage? {
    guard let imageBuffer = CMSampleBufferGetImageBuffer(sample) else { return nil }
    let src = CIImage(cvImageBuffer: imageBuffer)
    let fIn = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: src.extent.height)
    var ci = src.transformed(by: fIn).transformed(by: transform)
    ci = ci.transformed(by: CGAffineTransform(translationX: -ci.extent.origin.x,
                                              y: -ci.extent.origin.y))
    ci = ci.transformed(by: CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: ci.extent.height))
    return ciContext.createCGImage(ci, from: ci.extent)
  }

  /// Template resizeToInput pattern, parametric dims (Lanczos → 32BGRA buffer).
  private static func makeAnalysisBuffer(_ cgImage: CGImage, width: Int, height: Int) -> CVPixelBuffer? {
    let ciImage = CIImage(cgImage: cgImage)
    let scaleX = CGFloat(width) / CGFloat(cgImage.width)
    let scaleY = CGFloat(height) / CGFloat(cgImage.height)

    guard let filter = CIFilter(name: "CILanczosScaleTransform") else { return nil }
    filter.setValue(ciImage, forKey: kCIInputImageKey)
    filter.setValue(scaleY, forKey: kCIInputScaleKey)
    filter.setValue(scaleX / scaleY, forKey: kCIInputAspectRatioKey)
    guard let scaled = filter.outputImage else { return nil }

    var pb: CVPixelBuffer?
    let attrs: [String: Any] = [
      kCVPixelBufferCGImageCompatibilityKey as String: true,
      kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
    ]
    CVPixelBufferCreate(kCFAllocatorDefault, width, height,
                        kCVPixelFormatType_32BGRA, attrs as CFDictionary, &pb)
    guard let buffer = pb else { return nil }

    let rect = CGRect(x: 0, y: 0, width: width, height: height)
    ciContext.render(scaled, to: buffer, bounds: rect, colorSpace: CGColorSpaceCreateDeviceRGB())
    return buffer
  }

  // MARK: - Detection

  private enum MaskKind {
    case brightBall
    case darkHead
  }

  private static func ballSearchBand(analysisW: Int, analysisH: Int) -> Roi {
    let y0 = Int(Double(analysisH) * (1.0 - BALL_SEARCH_LOWER_FRACTION))
    return Roi(x0: 0, y0: y0, x1: analysisW, y1: analysisH)
  }

  /// Head ROI: horizontal unchanged (±HEAD_ROI_HALF_WIDTH_FRAC around the
  /// anchor x; full width when unanchored); VERTICAL extent is the tight
  /// mat-level band [anchorY − HEAD_BAND_UP_PX, anchorY + HEAD_BAND_DOWN_PX]
  /// — see the constants' evidence comment (grip exclusion + shaft
  /// declipping on fixture 1d8722b8).
  private static func headRoi(anchored: Bool, anchorX: Double, anchorY: Double,
                              matYEstimate: Double?,
                              analysisW: Int, analysisH: Int) -> Roi {
    if anchored {
      let halfW = HEAD_ROI_HALF_WIDTH_FRAC * Double(analysisW)
      return Roi(x0: Int(anchorX - halfW), y0: Int(anchorY - HEAD_BAND_UP_PX),
                 x1: Int(anchorX + halfW), y1: Int(anchorY + HEAD_BAND_DOWN_PX))
        .clamped(w: analysisW, h: analysisH)
    }
    // Unanchored: full frame width. With a mat-level estimate (seed y, or the
    // rest-pass median y when detections existed but failed the spread
    // check), apply the same tight band; with NO estimate there is nothing to
    // band around — keep the old wide lower-band fallback.
    if let matY = matYEstimate {
      return Roi(x0: 0, y0: Int(matY - HEAD_BAND_UP_PX),
                 x1: analysisW, y1: Int(matY + HEAD_BAND_DOWN_PX))
        .clamped(w: analysisW, h: analysisH)
    }
    return ballSearchBand(analysisW: analysisW, analysisH: analysisH)
  }

  /// Shaft ROI (headDetector == "shaft"): ball-relative and TALL — unlike the
  /// blob detector's tight band, the line fit WANTS the shaft, so the ROI
  /// reaches SHAFT_ROI_UP_FRAC of the frame height toward the hands; the
  /// endpoint gates (not the ROI) reject the grip end. Same unanchored
  /// fallbacks as headRoi (mat-estimate band, else wide lower band).
  private static func shaftRoi(anchored: Bool, anchorX: Double, anchorY: Double,
                               matYEstimate: Double?,
                               analysisW: Int, analysisH: Int) -> Roi {
    let up = SHAFT_ROI_UP_FRAC * Double(analysisH)
    if anchored {
      let halfW = SHAFT_ROI_HALF_WIDTH_FRAC * Double(analysisW)
      return Roi(x0: Int(anchorX - halfW), y0: Int(anchorY - up),
                 x1: Int(anchorX + halfW), y1: Int(anchorY + HEAD_BAND_DOWN_PX))
        .clamped(w: analysisW, h: analysisH)
    }
    if let matY = matYEstimate {
      return Roi(x0: 0, y0: Int(matY - up),
                 x1: analysisW, y1: Int(matY + HEAD_BAND_DOWN_PX))
        .clamped(w: analysisW, h: analysisH)
    }
    return ballSearchBand(analysisW: analysisW, analysisH: analysisH)
  }

  /// Fold a line-direction angle (or difference) to (−90, +90] — line
  /// directions 180° apart are the same line.
  private static func foldDeg(_ a: Double) -> Double {
    var v = a
    while v > 90 { v -= 180 }
    while v <= -90 { v += 180 }
    return v
  }

  /// Threshold mask over a ROI (roi-local indexing, row-major).
  private static func buildMask(buffer: CVPixelBuffer, roi: Roi, kind: MaskKind) -> [Bool] {
    let w = roi.width
    let h = roi.height
    guard w > 0, h > 0 else { return [] }
    var mask = [Bool](repeating: false, count: w * h)

    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return mask }
    let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
    let ptr = base.assumingMemoryBound(to: UInt8.self)

    for y in 0..<h {
      let rowStart = (roi.y0 + y) * bytesPerRow
      let maskRow = y * w
      for x in 0..<w {
        let px = rowStart + (roi.x0 + x) * 4
        let b = Int(ptr[px + 0])
        let g = Int(ptr[px + 1])
        let r = Int(ptr[px + 2])
        let mx = max(r, max(g, b))
        let mn = min(r, min(g, b))
        switch kind {
        case .brightBall:
          mask[maskRow + x] = mn > BALL_MIN_LUMA && (mx - mn) < BALL_MAX_CHROMA_SPREAD
        case .darkHead:
          mask[maskRow + x] = mx < HEAD_MAX_LUMA
        }
      }
    }
    return mask
  }

  /// 4-connected component labeling (iterative DFS) → per-blob area, centroid,
  /// bbox, boundary-pixel count.
  private static func labelBlobs(mask: [Bool], w: Int, h: Int) -> [Blob] {
    guard w > 0, h > 0, mask.count == w * h else { return [] }
    var visited = [Bool](repeating: false, count: mask.count)
    var blobs: [Blob] = []
    var stack: [Int] = []

    for start in 0..<mask.count where mask[start] && !visited[start] {
      visited[start] = true
      stack.removeAll(keepingCapacity: true)
      stack.append(start)
      var blob = Blob()
      while let idx = stack.popLast() {
        let x = idx % w
        let y = idx / w
        blob.area += 1
        blob.pixels.append(idx)
        blob.sumX += Double(x)
        blob.sumY += Double(y)
        blob.minX = min(blob.minX, x)
        blob.maxX = max(blob.maxX, x)
        blob.minY = min(blob.minY, y)
        blob.maxY = max(blob.maxY, y)
        var isBoundary = false
        let neighbors = [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)]
        for (nx, ny) in neighbors {
          if nx < 0 || ny < 0 || nx >= w || ny >= h {
            isBoundary = true
            continue
          }
          let nidx = ny * w + nx
          if !mask[nidx] {
            isBoundary = true
          } else if !visited[nidx] {
            visited[nidx] = true
            stack.append(nidx)
          }
        }
        if isBoundary { blob.boundary += 1 }
      }
      blobs.append(blob)
    }
    return blobs
  }

  /// LOCKED confidence definition, factors broken out so the diagnostic dump
  /// (options.debugCandidates) reports EXACTLY what the live formula computed.
  private static func confidenceFactors(area: Double, areaMin: Double, areaMax: Double,
                                        shape: Double, shapeFloor: Double,
                                        dx: Double?, dy: Double?)
    -> (area: Double, shape: Double, proximity: Double) {
    // Area factor: 1.0 inside bounds, linear falloff to 0 at 2× outside
    // (0 at areaMin/2 below, 0 at 2×areaMax above).
    let areaFactor: Double
    if area < areaMin {
      areaFactor = max(0, (area - areaMin / 2) / (areaMin / 2))
    } else if area > areaMax {
      areaFactor = max(0, (2 * areaMax - area) / areaMax)
    } else {
      areaFactor = 1.0
    }
    // Shape factor: 0 at the named floor, 1 at ideal.
    let shapeFactor = min(1.0, max(0, (shape - shapeFloor) / (1.0 - shapeFloor)))
    // Proximity factor: gaussian on distance to previous centroid; neutral 1.0
    // when there is no previous (first frame / after a null gap).
    let proximityFactor: Double
    if let dx = dx, let dy = dy {
      let d2 = dx * dx + dy * dy
      proximityFactor = exp(-d2 / (2 * PROXIMITY_SIGMA_PX * PROXIMITY_SIGMA_PX))
    } else {
      proximityFactor = 1.0
    }
    return (areaFactor, shapeFactor, proximityFactor)
  }

  /// LOCKED confidence definition: areaFactor × shapeFactor × proximityFactor.
  private static func confidence(area: Double, areaMin: Double, areaMax: Double,
                                 shape: Double, shapeFloor: Double,
                                 dx: Double?, dy: Double?) -> Double {
    let f = confidenceFactors(area: area, areaMin: areaMin, areaMax: areaMax,
                              shape: shape, shapeFloor: shapeFloor, dx: dx, dy: dy)
    return f.area * f.shape * f.proximity
  }

  /// Approximate Rec.601 integer luma plane of an analysis buffer. Captured
  /// BEFORE drawOverlay mutates the buffer; kept one frame back to feed the
  /// head motion factor.
  private static func lumaPlane(buffer: CVPixelBuffer) -> [UInt8] {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let w = CVPixelBufferGetWidth(buffer)
    let h = CVPixelBufferGetHeight(buffer)
    var luma = [UInt8](repeating: 0, count: w * h)
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return luma }
    let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
    let ptr = base.assumingMemoryBound(to: UInt8.self)
    for y in 0..<h {
      let row = y * bytesPerRow
      let out = y * w
      for x in 0..<w {
        let px = row + x * 4
        let b = Int(ptr[px + 0])
        let g = Int(ptr[px + 1])
        let r = Int(ptr[px + 2])
        luma[out + x] = UInt8((r * 77 + g * 150 + b * 29) >> 8)
      }
    }
    return luma
  }

  /// Full-analysis-frame changed-pixel mask: |curLuma − prevLuma| >
  /// MOTION_DIFF_MIN_LUMA.
  private static func motionChangedMask(cur: [UInt8], prev: [UInt8]) -> [Bool] {
    var changed = [Bool](repeating: false, count: cur.count)
    for i in 0..<min(cur.count, prev.count) {
      let d = Int(cur[i]) - Int(prev[i])
      changed[i] = d > MOTION_DIFF_MIN_LUMA || d < -MOTION_DIFF_MIN_LUMA
    }
    return changed
  }

  /// Head motion factor: fraction of the blob's pixels flagged as moving.
  /// 0 when there is no previous frame (motion == nil) — first grid frame.
  private static func blobMotionFactor(pixels: [Int], area: Double, roi: Roi,
                                       motion: (changed: [Bool], frameWidth: Int)?) -> Double {
    guard let m = motion, area > 0, roi.width > 0 else { return 0.0 }
    var moved = 0
    for idx in pixels {
      let gx = roi.x0 + idx % roi.width
      let gy = roi.y0 + idx / roi.width
      let gidx = gy * m.frameWidth + gx
      if gidx >= 0, gidx < m.changed.count, m.changed[gidx] { moved += 1 }
    }
    return Double(moved) / area
  }

  /// Result of one shaft-line fit attempt (headDetector == "shaft").
  private struct ShaftFit {
    let head: Detection?
    /// nil = no accepted fit this frame (hold logic runs in the caller).
    let lineRef: (px: Double, py: Double, dx: Double, dy: Double)?
    /// Inlier extent of the fitted line, for the overlay.
    let segment: (x0: Double, y0: Double, x1: Double, y1: Double)?
    let debug: [String: Any]
  }

  /// SHAFT-FIRST head detection. Rationale (6 failed blob variants on
  /// fixture 1d8722b8): the head blob merges with shaft+shadow (compactness
  /// 0.03-0.24), the grip/hands blob steals selection, and per-frame blob
  /// logic has no structural prior. The shaft IS the structure — frame
  /// differencing shows it as the single dominant moving line in every
  /// stroke frame — so fit a line to thin dark ∨ moving ∨ edge pixels and
  /// read the head off its LOWER endpoint. RANSAC-lite is the PRIMARY
  /// fitter (not PCA-first): the measured merged components are exactly
  /// where PCA's covariance axis breaks, and RANSAC's inlier band ignores
  /// off-line mass. Deterministic sampling — reproducible runs, no RNG.
  private static func detectShaftHead(
      luma: [UInt8], changed: [Bool]?,
      analysisW: Int, analysisH: Int, roi: Roi,
      anchorX: Double?, matY: Double?,
      ballExclusion: (x: Double, y: Double, r: Double)?,
      posePrior: (angleDeg: Double, ax: Double, ay: Double)?,
      prevLine: (px: Double, py: Double, dx: Double, dy: Double)?) -> ShaftFit {
    var debug: [String: Any] = [
      "angleDeg": NSNull(),
      "inliers": 0,
      "span": 0.0,
      "candidateCount": 0,
      "usedMask": ["dark": 0, "motion": 0, "edge": 0],
      "poseAngleDeg": NSNull(),
      "poseAnchorUsed": false,
    ]
    if let pp = posePrior {
      debug["poseAngleDeg"] = pp.angleDeg
      debug["poseAnchorUsed"] = true
    }
    let w = roi.width
    let h = roi.height
    guard w > 8, h > 8 else {
      return ShaftFit(head: nil, lineRef: nil, segment: nil, debug: debug)
    }

    // 1) Candidate flags per ROI pixel: bit0 dark, bit1 motion, bit2 edge.
    var flags = [UInt8](repeating: 0, count: w * h)
    let exclR2 = ballExclusion.map { $0.r * $0.r }
    for y in 0..<h {
      let gy = roi.y0 + y
      let rowL = gy * analysisW
      for x in 0..<w {
        let gx = roi.x0 + x
        if let e = ballExclusion, let r2 = exclR2 {
          let ddx = Double(gx) - e.x
          let ddy = Double(gy) - e.y
          if ddx * ddx + ddy * ddy <= r2 { continue }
        }
        let li = rowL + gx
        var f: UInt8 = 0
        if Int(luma[li]) < HEAD_MAX_LUMA { f |= 1 }
        if let c = changed, li < c.count, c[li] { f |= 2 }
        if gx > 0, gx < analysisW - 1, gy > 0, gy < analysisH - 1 {
          let gxv = abs(Int(luma[li + 1]) - Int(luma[li - 1]))
          let gyv = abs(Int(luma[li + analysisW]) - Int(luma[li - analysisW]))
          if gxv + gyv > EDGE_MIN_GRAD { f |= 4 }
        }
        flags[y * w + x] = f
      }
    }

    // 2) Thin-neighborhood filter — favors thin line structures, rejects fat
    // blob interiors (8 candidate neighbors) and isolated speckle (0-1).
    var pts: [(x: Double, y: Double)] = []
    var darkKept = 0
    var motionKept = 0
    var edgeKept = 0
    for y in 0..<h {
      for x in 0..<w where flags[y * w + x] != 0 {
        var n = 0
        for ny in max(0, y - 1)...min(h - 1, y + 1) {
          for nx in max(0, x - 1)...min(w - 1, x + 1) where nx != x || ny != y {
            if flags[ny * w + nx] != 0 { n += 1 }
          }
        }
        if n >= THIN_NEIGHBOR_MIN && n <= THIN_NEIGHBOR_MAX {
          pts.append((Double(roi.x0 + x), Double(roi.y0 + y)))
          let f = flags[y * w + x]
          if f & 1 != 0 { darkKept += 1 }
          if f & 2 != 0 { motionKept += 1 }
          if f & 4 != 0 { edgeKept += 1 }
        }
      }
    }
    debug["candidateCount"] = pts.count
    debug["usedMask"] = ["dark": darkKept, "motion": motionKept, "edge": edgeKept]
    guard pts.count >= SHAFT_MIN_INLIERS else {
      return ShaftFit(head: nil, lineRef: nil, segment: nil, debug: debug)
    }

    // 3) RANSAC-lite, deterministic: every-Nth candidate paired with a far
    // point probed from the opposite half of the row-major candidate list
    // (row-major order ⇒ opposite half is vertically distant — good pairs).
    let n = pts.count
    // Ceil division so the line budget truly caps at SHAFT_MAX_CANDIDATE_LINES.
    let sampleStride = max(1, (n + SHAFT_MAX_CANDIDATE_LINES - 1) / SHAFT_MAX_CANDIDATE_LINES)
    var best: (score: Double, px: Double, py: Double, dx: Double, dy: Double)? = nil
    var i = 0
    while i < n {
      let p1 = pts[i]
      i += sampleStride
      var partner: (x: Double, y: Double)? = nil
      var k = 0
      while k < 24 {
        let q = pts[(i - sampleStride + n / 2 + k * 7) % n]
        let ddx = q.x - p1.x
        let ddy = q.y - p1.y
        if ddx * ddx + ddy * ddy > SHAFT_PAIR_MIN_DIST_PX * SHAFT_PAIR_MIN_DIST_PX {
          partner = q
          break
        }
        k += 1
      }
      guard let p2 = partner else { continue }
      var dirX = p2.x - p1.x
      var dirY = p2.y - p1.y
      let len = (dirX * dirX + dirY * dirY).squareRoot()
      dirX /= len
      dirY /= len
      if dirY < 0 { dirX = -dirX; dirY = -dirY } // orient toward mat (+y)
      if let pp = posePrior {
        // POSE PRIOR gates — replace the absolute vertical gate this frame:
        // the line must match the pose pair's calibrated angle AND pass
        // through the hand cluster (kills static near-vertical scene edges,
        // which are vertical but nowhere near the hands).
        let lineAngle = atan2(dirX, dirY) * 180.0 / Double.pi
        if abs(foldDeg(lineAngle - pp.angleDeg)) > POSE_ANGLE_TOL_DEG { continue }
        if abs((pp.ax - p1.x) * dirY - (pp.ay - p1.y) * dirX) > POSE_ANCHOR_PASS_PX { continue }
      } else {
        let angleFromVertical = atan2(abs(dirX), abs(dirY)) * 180.0 / Double.pi
        if angleFromVertical > SHAFT_MAX_ANGLE_FROM_VERTICAL_DEG { continue }
      }
      if let pl = prevLine {
        let dot = min(1.0, abs(dirX * pl.dx + dirY * pl.dy))
        if acos(dot) * 180.0 / Double.pi > SHAFT_MAX_ANGLE_DELTA_DEG { continue }
      }
      var count = 0
      var minProj = Double.greatestFiniteMagnitude
      var maxProj = -Double.greatestFiniteMagnitude
      for p in pts {
        let rx = p.x - p1.x
        let ry = p.y - p1.y
        if abs(rx * dirY - ry * dirX) <= SHAFT_INLIER_BAND_PX {
          count += 1
          let proj = rx * dirX + ry * dirY
          if proj < minProj { minProj = proj }
          if proj > maxProj { maxProj = proj }
        }
      }
      guard count >= 2 else { continue }
      let score = Double(count) + SHAFT_SPAN_SCORE_WEIGHT * (maxProj - minProj)
      if score > (best?.score ?? -Double.greatestFiniteMagnitude) {
        best = (score, p1.x, p1.y, dirX, dirY)
      }
    }
    guard let won = best else {
      return ShaftFit(head: nil, lineRef: nil, segment: nil, debug: debug)
    }

    // 4) Least-squares refine (orthogonal regression) on the winner's
    // inliers; keep the refined axis only if it still passes the vertical
    // gate (a shadow-polluted refine must not undo the gate).
    var inlierPts: [(x: Double, y: Double)] = []
    for p in pts {
      let rx = p.x - won.px
      let ry = p.y - won.py
      if abs(rx * won.dy - ry * won.dx) <= SHAFT_INLIER_BAND_PX { inlierPts.append(p) }
    }
    guard inlierPts.count >= SHAFT_MIN_INLIERS else {
      return ShaftFit(head: nil, lineRef: nil, segment: nil, debug: debug)
    }
    let m = Double(inlierPts.count)
    let cx = inlierPts.reduce(0.0) { $0 + $1.x } / m
    let cy = inlierPts.reduce(0.0) { $0 + $1.y } / m
    var sxx = 0.0
    var sxy = 0.0
    var syy = 0.0
    for p in inlierPts {
      let ax = p.x - cx
      let ay = p.y - cy
      sxx += ax * ax
      sxy += ax * ay
      syy += ay * ay
    }
    let theta = 0.5 * atan2(2 * sxy, sxx - syy)
    var dirX = cos(theta)
    var dirY = sin(theta)
    if dirY < 0 { dirX = -dirX; dirY = -dirY }
    var refinedAngle = atan2(abs(dirX), abs(dirY)) * 180.0 / Double.pi
    // Keep the refined axis only if it still passes this frame's angle gate
    // (pose tolerance when a prior exists, absolute vertical otherwise) —
    // a polluted refine must not undo the gate.
    let refinedOk: Bool
    if let pp = posePrior {
      refinedOk = abs(foldDeg(atan2(dirX, dirY) * 180.0 / Double.pi - pp.angleDeg))
        <= POSE_ANGLE_TOL_DEG
    } else {
      refinedOk = refinedAngle <= SHAFT_MAX_ANGLE_FROM_VERTICAL_DEG
    }
    if !refinedOk {
      dirX = won.dx
      dirY = won.dy
      refinedAngle = atan2(abs(dirX), abs(dirY)) * 180.0 / Double.pi
    }
    // Final inliers/projections against the refined axis through the centroid.
    var finalInliers: [(x: Double, y: Double, proj: Double)] = []
    var minProj = Double.greatestFiniteMagnitude
    var maxProj = -Double.greatestFiniteMagnitude
    for p in pts {
      let rx = p.x - cx
      let ry = p.y - cy
      if abs(rx * dirY - ry * dirX) <= SHAFT_INLIER_BAND_PX {
        let proj = rx * dirX + ry * dirY
        finalInliers.append((p.x, p.y, proj))
        if proj < minProj { minProj = proj }
        if proj > maxProj { maxProj = proj }
      }
    }
    let span = maxProj - minProj
    debug["inliers"] = finalInliers.count
    debug["span"] = span
    // Signed lean: 0° = straight down, sign = x-direction of the mat-ward dir.
    debug["angleDeg"] = atan2(dirX, dirY) * 180.0 / Double.pi
    guard finalInliers.count >= SHAFT_MIN_INLIERS, span >= SHAFT_MIN_SPAN_PX else {
      return ShaftFit(head: nil, lineRef: nil, segment: nil, debug: debug)
    }

    // POSE ANCHOR re-check on the FINAL axis (refined line runs through the
    // inlier centroid, not the sampled point — a refine drifting off the
    // hands would silently undo the prior). Fail → no fit → the caller's
    // ≤5-frame hold covers the gap (one-off jump immunity: never accept a
    // gate-violating fit).
    if let pp = posePrior {
      if abs((pp.ax - cx) * dirY - (pp.ay - cy) * dirX) > POSE_ANCHOR_PASS_PX {
        return ShaftFit(head: nil, lineRef: nil, segment: nil, debug: debug)
      }
    }

    // 5) Lower endpoint = 95th-percentile projection toward the mat.
    let projs = finalInliers.map { $0.proj }.sorted()
    let p95 = projs[min(projs.count - 1, Int(Double(projs.count - 1) * 0.95 + 0.5))]
    let lowerX = cx + dirX * p95
    let lowerY = cy + dirY * p95
    // 7) Endpoint sanity gates: near the ball's x, near mat level — a lower
    // endpoint far above the mat means the fit grabbed the grip-side
    // segment (wrong end of the club).
    if let ax = anchorX, abs(lowerX - ax) > SHAFT_ENDPOINT_MAX_DX_PX {
      return ShaftFit(head: nil, lineRef: nil, segment: nil, debug: debug)
    }
    if let my = matY, lowerY < my - SHAFT_ENDPOINT_MIN_UP_PX {
      return ShaftFit(head: nil, lineRef: nil, segment: nil, debug: debug)
    }
    let segment = (x0: cx + dirX * minProj, y0: cy + dirY * minProj,
                   x1: cx + dirX * maxProj, y1: cy + dirY * maxProj)
    let lineRef = (px: cx, py: cy, dx: dirX, dy: dirY)

    // 6) Confidence (shaft head only — ball confidence is LOCKED):
    //   inlierFraction = min(1, inliers / span) — inlier density per px of
    //     span; a solid dark shaft filling the 2.5px band scores ≥ 1.
    //   elongation = min(1, span / (2 × SHAFT_MIN_SPAN_PX)) — 0.5 at the
    //     bare-acceptance span, saturating at 2× it.
    //   angleFactor follows this frame's angle gate: with a pose prior it is
    //     1 − |deviation from prior| / POSE_ANGLE_TOL_DEG (the absolute-
    //     vertical form would zero out legitimate prior-guided fits beyond
    //     18°); without one, 1 − angleFromVertical / 18°.
    let inlierFraction = min(1.0, Double(finalInliers.count) / max(span, 1.0))
    let elongation = min(1.0, span / (2.0 * SHAFT_MIN_SPAN_PX))
    let angleFactor: Double
    if let pp = posePrior {
      let dev = abs(foldDeg(atan2(dirX, dirY) * 180.0 / Double.pi - pp.angleDeg))
      angleFactor = max(0.0, 1.0 - dev / POSE_ANGLE_TOL_DEG)
    } else {
      angleFactor = max(0.0, 1.0 - refinedAngle / SHAFT_MAX_ANGLE_FROM_VERTICAL_DEG)
    }
    let baseConf = inlierFraction * elongation * angleFactor

    let cluster = finalInliers.filter { $0.proj >= p95 - SHAFT_HEAD_CLUSTER_PX }
    let head: Detection?
    if cluster.count >= SHAFT_HEAD_MIN_CLUSTER {
      let hc = Double(cluster.count)
      head = Detection(x: cluster.reduce(0.0) { $0 + $1.x } / hc,
                       y: cluster.reduce(0.0) { $0 + $1.y } / hc,
                       area: hc, confidence: baseConf, source: "shaft")
    } else if let my = matY, abs(dirY) > 1e-6 {
      // Endpoint cluster thin/occluded (ball overlap at impact): extrapolate
      // the fitted line to mat level at reduced confidence.
      let t = (my - cy) / dirY
      head = Detection(x: cx + dirX * t, y: my, area: Double(cluster.count),
                       confidence: baseConf * SHAFT_OCCLUDED_CONF_FACTOR, source: "shaft")
    } else {
      head = nil
    }
    return ShaftFit(head: head, lineRef: lineRef, segment: segment, debug: debug)
  }

  /// DIAGNOSTIC ONLY (options.debugCandidates) — re-scores the head mask's
  /// dark blobs through the IDENTICAL factor formulas as live selection
  /// (same prev centroid, same head area/shape constants, pre-floor) and
  /// returns the top HEAD_DEBUG_TOP_N by raw confidence, each factor broken
  /// out, coordinates scaled to full-res. Never influences selection.
  private static func dumpHeadCandidates(mask: [Bool], roi: Roi,
                                         prev: (x: Double, y: Double)?,
                                         motion: (changed: [Bool], frameWidth: Int)?,
                                         scale: Double) -> [[String: Any]] {
    let blobs = labelBlobs(mask: mask, w: roi.width, h: roi.height)
    var scored: [(conf: Double, dict: [String: Any])] = []
    for blob in blobs where blob.area >= NOISE_BLOB_MIN_PX2 {
      let area = Double(blob.area)
      let cx = blob.sumX / area + Double(roi.x0)
      let cy = blob.sumY / area + Double(roi.y0)
      let bboxArea = Double((blob.maxX - blob.minX + 1) * (blob.maxY - blob.minY + 1))
      let shape = area / max(bboxArea, 1)
      let f = confidenceFactors(area: area, areaMin: HEAD_AREA_MIN_PX2,
                                areaMax: HEAD_AREA_MAX_PX2,
                                shape: shape, shapeFloor: HEAD_MIN_COMPACTNESS,
                                dx: prev.map { cx - $0.x }, dy: prev.map { cy - $0.y })
      let motionFactor = blobMotionFactor(pixels: blob.pixels, area: area,
                                          roi: roi, motion: motion)
      // Same live head formula: motion rescues moving blobs from proximity.
      let conf = f.area * f.shape * max(f.proximity, motionFactor)
      scored.append((conf, [
        "x": cx * scale,
        "y": cy * scale,
        "areaPx": area * scale * scale,
        "areaFactor": f.area,
        "shapeFactor": f.shape,
        "proximityFactor": f.proximity,
        "motionFactor": motionFactor,
        "confidence": conf,
      ]))
    }
    return scored.sorted { $0.conf > $1.conf }.prefix(HEAD_DEBUG_TOP_N).map { $0.dict }
  }

  /// HEAD selection rule (mislock fix, seeded run on fixture 1d8722b8): the
  /// grip/hands are a LARGER dark blob at the TOP of the head ROI and won the
  /// confidence contest on 100% of frames (y≈1084 full-res vs mat level
  /// y≈1531). The putter head is by definition the lowest dark object in the
  /// ROI — so among candidates that clear MIN_CONFIDENCE_FLOOR, pick the one
  /// closest to mat level (LARGEST centroid y in top-left space), tie-breaking
  /// candidates within HEAD_Y_TIE_BAND_PX of the lowest by confidence.
  /// Ball selection is untouched (highest confidence).
  private static func pickMatLevelHead(_ candidates: [Detection]) -> Detection? {
    guard let maxY = candidates.map({ $0.y }).max() else { return nil }
    return candidates
      .filter { $0.y >= maxY - HEAD_Y_TIE_BAND_PX }
      .max { $0.confidence < $1.confidence }
  }

  /// Score all blobs in a labeled mask; return the best-scoring candidate
  /// (caller compares against MIN_CONFIDENCE_FLOOR — returning sub-floor best
  /// lets the caller decide whether to run the Vision fallback). `gate`, when
  /// present (seeded mode only), is a HARD filter: candidates whose centroid
  /// falls farther than `radius` from (x, y) are skipped before scoring; the
  /// confidence formula is unchanged for survivors. HEAD candidates that
  /// clear the floor are selected by pickMatLevelHead, not confidence.
  /// `motion` (head only) is the previous-frame changed-pixel mask feeding
  /// the motion factor; ball scoring ignores it entirely.
  private static func selectBlob(mask: [Bool], roi: Roi, isBall: Bool,
                                 prev: (x: Double, y: Double)?,
                                 gate: (x: Double, y: Double, radius: Double)? = nil,
                                 motion: (changed: [Bool], frameWidth: Int)? = nil) -> Detection? {
    let blobs = labelBlobs(mask: mask, w: roi.width, h: roi.height)
    let areaMin = isBall ? BALL_AREA_MIN_PX2 : HEAD_AREA_MIN_PX2
    let areaMax = isBall ? BALL_AREA_MAX_PX2 : HEAD_AREA_MAX_PX2
    let shapeFloor = isBall ? BALL_MIN_CIRCULARITY : HEAD_MIN_COMPACTNESS

    var best: Detection? = nil
    var headCleared: [Detection] = [] // head only: floor-clearing mat-level pool
    for blob in blobs where blob.area >= NOISE_BLOB_MIN_PX2 {
      let area = Double(blob.area)
      let cx = blob.sumX / area + Double(roi.x0)
      let cy = blob.sumY / area + Double(roi.y0)
      if let g = gate {
        let gdx = cx - g.x
        let gdy = cy - g.y
        if (gdx * gdx + gdy * gdy).squareRoot() > g.radius { continue }
      }
      let shape: Double
      if isBall {
        let p = Double(max(blob.boundary, 1))
        shape = min(1.0, 4 * Double.pi * area / (p * p))
      } else {
        let bboxArea = Double((blob.maxX - blob.minX + 1) * (blob.maxY - blob.minY + 1))
        shape = area / max(bboxArea, 1)
      }
      let f = confidenceFactors(area: area, areaMin: areaMin, areaMax: areaMax,
                                shape: shape, shapeFloor: shapeFloor,
                                dx: prev.map { cx - $0.x }, dy: prev.map { cy - $0.y })
      let conf: Double
      if isBall {
        // Ball: LOCKED formula, unchanged.
        conf = f.area * f.shape * f.proximity
      } else {
        // Head: motion must be REWARDED, not punished (fixture 1d8722b8,
        // frame 110: the real head scored 0.65 × 0.48 × prox 0.139 = 0.043
        // < floor — proximity collapses exactly when the stroke moves the
        // head). max(proximity, motion) keeps both regimes alive: at rest
        // the static head survives via proximity≈1; during the stroke the
        // moving head survives via motion; static decoys (shadows, chair,
        // mat marks) score motion 0 and still need proximity, so they are
        // NOT resurrected.
        let motionFactor = blobMotionFactor(pixels: blob.pixels, area: area,
                                            roi: roi, motion: motion)
        conf = f.area * f.shape * max(f.proximity, motionFactor)
      }
      let det = Detection(x: cx, y: cy, area: area, confidence: conf, source: "color")
      if conf > (best?.confidence ?? 0) {
        best = det
      }
      if !isBall && conf >= MIN_CONFIDENCE_FLOOR {
        headCleared.append(det)
      }
    }
    // Head: mat-level preference over the floor-clearing pool. Empty pool
    // falls through to the sub-floor confidence best so the caller still
    // triggers the Vision fallback exactly as before.
    if !isBall, let head = pickMatLevelHead(headCleared) {
      return head
    }
    return best
  }

  /// Apple Vision contour fallback. Runs ONLY when the color pass's best
  /// confidence is below MIN_CONFIDENCE_FLOOR (enforced by the caller); scores
  /// contours through the IDENTICAL confidence formula. Returns nil unless a
  /// contour clears the floor. `gate` is the same seeded-mode HARD filter as
  /// selectBlob — the fallback must not resurrect a decoy the gate rejected.
  private static func visionFallback(image: CIImage, roi: Roi, analysisH: Int,
                                     isBall: Bool,
                                     prev: (x: Double, y: Double)?,
                                     gate: (x: Double, y: Double, radius: Double)? = nil) -> Detection? {
    guard roi.width > 8, roi.height > 8 else { return nil }
    // ROI is top-left space; CIImage is bottom-left.
    let ciRect = CGRect(x: CGFloat(roi.x0), y: CGFloat(analysisH - roi.y1),
                        width: CGFloat(roi.width), height: CGFloat(roi.height))
    let cropped = image.cropped(to: ciRect)
      .transformed(by: CGAffineTransform(translationX: -ciRect.minX, y: -ciRect.minY))

    let request = VNDetectContoursRequest()
    request.contrastAdjustment = VISION_CONTRAST_ADJUSTMENT
    request.detectsDarkOnLight = !isBall // head = dark blob; ball = bright blob
    request.maximumImageDimension = VISION_MAX_IMAGE_DIMENSION

    let handler = VNImageRequestHandler(ciImage: cropped, options: [:])
    do {
      try handler.perform([request])
    } catch {
      return nil
    }
    guard let observation = request.results?.first else { return nil }

    let areaMin = isBall ? BALL_AREA_MIN_PX2 : HEAD_AREA_MIN_PX2
    let areaMax = isBall ? BALL_AREA_MAX_PX2 : HEAD_AREA_MAX_PX2
    let shapeFloor = isBall ? BALL_MIN_CIRCULARITY : HEAD_MIN_COMPACTNESS
    let roiW = Double(roi.width)
    let roiH = Double(roi.height)

    var best: Detection? = nil
    var headCleared: [Detection] = [] // head only: floor-clearing mat-level pool
    for contour in observation.topLevelContours {
      let pts = contour.normalizedPoints
      guard pts.count >= 3 else { continue }
      // Polygon metrics in analysis px, top-left space
      // (normalizedPoints are y-up within the crop).
      var area2 = 0.0
      var perimeter = 0.0
      var sumX = 0.0
      var sumY = 0.0
      var minX = Double.greatestFiniteMagnitude
      var maxX = -Double.greatestFiniteMagnitude
      var minY = Double.greatestFiniteMagnitude
      var maxY = -Double.greatestFiniteMagnitude
      var prevPt: (x: Double, y: Double)? = nil
      var firstPt: (x: Double, y: Double)? = nil
      for p in pts {
        let x = Double(roi.x0) + Double(p.x) * roiW
        let y = Double(roi.y0) + (1.0 - Double(p.y)) * roiH
        sumX += x
        sumY += y
        minX = min(minX, x)
        maxX = max(maxX, x)
        minY = min(minY, y)
        maxY = max(maxY, y)
        if let pp = prevPt {
          area2 += pp.x * y - x * pp.y
          perimeter += ((x - pp.x) * (x - pp.x) + (y - pp.y) * (y - pp.y)).squareRoot()
        } else {
          firstPt = (x, y)
        }
        prevPt = (x, y)
      }
      if let pp = prevPt, let fp = firstPt { // close the ring
        area2 += pp.x * fp.y - fp.x * pp.y
        perimeter += ((fp.x - pp.x) * (fp.x - pp.x) + (fp.y - pp.y) * (fp.y - pp.y)).squareRoot()
      }
      let area = abs(area2) / 2
      guard area >= Double(NOISE_BLOB_MIN_PX2) else { continue }
      let cx = sumX / Double(pts.count)
      let cy = sumY / Double(pts.count)
      if let g = gate {
        let gdx = cx - g.x
        let gdy = cy - g.y
        if (gdx * gdx + gdy * gdy).squareRoot() > g.radius { continue }
      }
      let shape: Double
      if isBall {
        shape = min(1.0, 4 * Double.pi * area / max(perimeter * perimeter, 1))
      } else {
        shape = area / max((maxX - minX) * (maxY - minY), 1)
      }
      let conf = confidence(area: area, areaMin: areaMin, areaMax: areaMax,
                            shape: shape, shapeFloor: shapeFloor,
                            dx: prev.map { cx - $0.x }, dy: prev.map { cy - $0.y })
      let det = Detection(x: cx, y: cy, area: area, confidence: conf, source: "vision")
      if conf > (best?.confidence ?? 0) {
        best = det
      }
      if !isBall && conf >= MIN_CONFIDENCE_FLOOR {
        headCleared.append(det)
      }
    }
    // Head: same mat-level preference as the color pass; nothing clearing
    // the floor → nil (identical to the pre-fix fallback contract).
    if !isBall {
      return pickMatLevelHead(headCleared)
    }
    guard let b = best, b.confidence >= MIN_CONFIDENCE_FLOOR else { return nil }
    return b
  }

  // MARK: - Overlay drawing

  /// Draw the head ROI outline + per-object markers straight onto the analysis
  /// buffer (which is then appended to the overlay writer). Found = filled dot;
  /// null = hollow ring at the LAST-KNOWN position. Ball yellow, head cyan.
  private static func drawOverlay(on buffer: CVPixelBuffer, headRoi: Roi,
                                  ball: Detection?, head: Detection?,
                                  lastBall: (x: Double, y: Double)?,
                                  lastHead: (x: Double, y: Double)?,
                                  shaftSegment: (x0: Double, y0: Double, x1: Double, y1: Double)? = nil,
                                  poseAnchor: (x: Double, y: Double)? = nil,
                                  analysisH: Int) {
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return }
    let w = CVPixelBufferGetWidth(buffer)
    let h = CVPixelBufferGetHeight(buffer)
    let bitmapInfo = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    guard let ctx = CGContext(data: base, width: w, height: h, bitsPerComponent: 8,
                              bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: bitmapInfo) else { return }

    // CGContext origin is bottom-left; detection coords are top-left.
    func flipY(_ y: Double) -> CGFloat { return CGFloat(Double(analysisH) - y) }

    let ballColor = UIColor(red: 1.0, green: 0.9, blue: 0.0, alpha: 1.0).cgColor
    let headColor = UIColor(red: 0.0, green: 0.9, blue: 1.0, alpha: 1.0).cgColor
    let roiColor = UIColor(red: 0.0, green: 0.9, blue: 1.0, alpha: 0.35).cgColor

    // Head ROI outline (shows anchored vs unanchored search area per frame).
    ctx.setStrokeColor(roiColor)
    ctx.setLineWidth(1)
    ctx.stroke(CGRect(x: CGFloat(headRoi.x0), y: flipY(Double(headRoi.y1)),
                      width: CGFloat(headRoi.width), height: CGFloat(headRoi.height)))

    // Fitted shaft line (shaft detector only; held frames redraw the stale
    // segment — the debug flag distinguishes them).
    if let seg = shaftSegment {
      ctx.setStrokeColor(headColor)
      ctx.setLineWidth(2)
      ctx.move(to: CGPoint(x: CGFloat(seg.x0), y: flipY(seg.y0)))
      ctx.addLine(to: CGPoint(x: CGFloat(seg.x1), y: flipY(seg.y1)))
      ctx.strokePath()
    }

    func drawMarker(_ det: Detection?, last: (x: Double, y: Double)?,
                    color: CGColor, radius: CGFloat) {
      if let d = det {
        ctx.setFillColor(color)
        ctx.fillEllipse(in: CGRect(x: CGFloat(d.x) - radius, y: flipY(d.y) - radius,
                                   width: radius * 2, height: radius * 2))
      } else if let l = last {
        ctx.setStrokeColor(color)
        ctx.setLineWidth(2)
        let r = radius + 2
        ctx.strokeEllipse(in: CGRect(x: CGFloat(l.x) - r, y: flipY(l.y) - r,
                                     width: r * 2, height: r * 2))
      }
    }

    let ballRadius = CGFloat(max(3.0, ball.map { ($0.area / Double.pi).squareRoot() } ?? 3.0))
    drawMarker(ball, last: lastBall, color: ballColor, radius: ballRadius)
    drawMarker(head, last: lastHead, color: headColor, radius: 5)

    // Pose hand-cluster anchor (shaft mode's prior) — small magenta dot.
    if let p = poseAnchor {
      ctx.setFillColor(UIColor(red: 1.0, green: 0.2, blue: 0.9, alpha: 1.0).cgColor)
      ctx.fillEllipse(in: CGRect(x: CGFloat(p.x) - 4, y: flipY(p.y) - 4, width: 8, height: 8))
    }
  }
}
