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

  /// EXTERNAL ASSUMPTION — head ROI around ball-rest x: ±0.25 of frame WIDTH
  /// (generous so a long backstroke never clips the head at the top), from
  /// mat level up 0.25 of frame HEIGHT, plus a small below-ball margin (the
  /// head centroid can sit slightly below the ball centroid at address).
  private static let HEAD_ROI_HALF_WIDTH_FRAC = 0.25
  private static let HEAD_ROI_HEIGHT_FRAC = 0.25
  private static let HEAD_ROI_BELOW_BALL_FRAC = 0.05

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
    DispatchQueue.global(qos: .userInitiated).async {
      let step = stepMs.doubleValue
      guard step > 0, step.isFinite else {
        DispatchQueue.main.async { reject("invalid_step", "stepMs must be > 0, got \(step)", nil) }
        return
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
          }
          guard let buffer = Self.makeAnalysisBuffer(cgImage, width: analysisW, height: analysisH) else {
            return false
          }
          let band = Self.ballSearchBand(analysisW: analysisW, analysisH: analysisH)
          let mask = Self.buildMask(buffer: buffer, roi: band, kind: .brightBall)
          if let det = Self.selectBlob(mask: mask, roi: band, isBall: true, prev: anchorPrev),
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
      var anchored = false
      var anchorX = 0.0
      var anchorY = 0.0
      if anchorDetections.count >= Self.BALL_REST_ANCHOR_MIN_DETECTIONS {
        let xs = anchorDetections.map { $0.x }.sorted()
        let ys = anchorDetections.map { $0.y }.sorted()
        anchorX = xs[xs.count / 2]
        anchorY = ys[ys.count / 2]
        let maxDev = anchorDetections
          .map { max(abs($0.x - anchorX), abs($0.y - anchorY)) }
          .max() ?? 0
        anchored = maxDev <= Self.BALL_REST_ANCHOR_MAX_SPREAD_PX
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

      for ts in grid {
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
          }
          guard let buffer = Self.makeAnalysisBuffer(cgImage, width: analysisW, height: analysisH) else {
            return false
          }
          if writeOverlay, overlay == nil {
            overlay = OverlayWriter(width: analysisW, height: analysisH)
          }

          let band = Self.ballSearchBand(analysisW: analysisW, analysisH: analysisH)
          let headRoi = Self.headRoi(anchored: anchored, anchorX: anchorX, anchorY: anchorY,
                                     analysisW: analysisW, analysisH: analysisH)

          let ballMask = Self.buildMask(buffer: buffer, roi: band, kind: .brightBall)
          let headMask = Self.buildMask(buffer: buffer, roi: headRoi, kind: .darkHead)

          var ball = Self.selectBlob(mask: ballMask, roi: band, isBall: true, prev: prevBall)
          var head = Self.selectBlob(mask: headMask, roi: headRoi, isBall: false, prev: prevHead)

          // APPLE VISION FALLBACK — bounded exactly as specified: ONLY on
          // frames where the color pass's best confidence is below the floor.
          let analysisImage = CIImage(cvPixelBuffer: buffer)
          if (ball?.confidence ?? 0) < Self.MIN_CONFIDENCE_FLOOR {
            ball = Self.visionFallback(image: analysisImage, roi: band,
                                       analysisH: analysisH, isBall: true, prev: prevBall)
          }
          if (head?.confidence ?? 0) < Self.MIN_CONFIDENCE_FLOOR {
            head = Self.visionFallback(image: analysisImage, roi: headRoi,
                                       analysisH: analysisH, isBall: false, prev: prevHead)
          }
          if let b = ball, b.confidence < Self.MIN_CONFIDENCE_FLOOR { ball = nil }
          if let h = head, h.confidence < Self.MIN_CONFIDENCE_FLOOR { head = nil }

          // Overlay drawing happens BEFORE prev-position update so a null
          // frame rings the LAST-KNOWN position (hollow = missing).
          if let writer = overlay, !writer.failed {
            Self.drawOverlay(on: buffer, headRoi: headRoi, ball: ball, head: head,
                             lastBall: prevBall, lastHead: prevHead, analysisH: analysisH)
            writer.append(buffer, ptsMs: ts)
          }

          if let b = ball { prevBall = (b.x, b.y) }
          if let h = head { prevHead = (h.x, h.y) }

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
        "roiAnchor": anchored ? "ball_rest" : "unanchored",
        "overlayUri": overlayUri ?? NSNull(),
        "frames": frames,
      ]
      DispatchQueue.main.async { resolve(payload) }
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

  private static func headRoi(anchored: Bool, anchorX: Double, anchorY: Double,
                              analysisW: Int, analysisH: Int) -> Roi {
    if !anchored {
      // Unanchored (pre-moving ball): full frame width, same lower band as the
      // ball search — there is no trustworthy mat level to anchor to.
      return ballSearchBand(analysisW: analysisW, analysisH: analysisH)
    }
    let halfW = HEAD_ROI_HALF_WIDTH_FRAC * Double(analysisW)
    let up = HEAD_ROI_HEIGHT_FRAC * Double(analysisH)
    let below = HEAD_ROI_BELOW_BALL_FRAC * Double(analysisH)
    return Roi(x0: Int(anchorX - halfW), y0: Int(anchorY - up),
               x1: Int(anchorX + halfW), y1: Int(anchorY + below))
      .clamped(w: analysisW, h: analysisH)
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

  /// LOCKED confidence definition: areaFactor × shapeFactor × proximityFactor.
  private static func confidence(area: Double, areaMin: Double, areaMax: Double,
                                 shape: Double, shapeFloor: Double,
                                 dx: Double?, dy: Double?) -> Double {
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
    return areaFactor * shapeFactor * proximityFactor
  }

  /// Score all blobs in a labeled mask; return the best-scoring candidate
  /// (caller compares against MIN_CONFIDENCE_FLOOR — returning sub-floor best
  /// lets the caller decide whether to run the Vision fallback).
  private static func selectBlob(mask: [Bool], roi: Roi, isBall: Bool,
                                 prev: (x: Double, y: Double)?) -> Detection? {
    let blobs = labelBlobs(mask: mask, w: roi.width, h: roi.height)
    let areaMin = isBall ? BALL_AREA_MIN_PX2 : HEAD_AREA_MIN_PX2
    let areaMax = isBall ? BALL_AREA_MAX_PX2 : HEAD_AREA_MAX_PX2
    let shapeFloor = isBall ? BALL_MIN_CIRCULARITY : HEAD_MIN_COMPACTNESS

    var best: Detection? = nil
    for blob in blobs where blob.area >= NOISE_BLOB_MIN_PX2 {
      let area = Double(blob.area)
      let cx = blob.sumX / area + Double(roi.x0)
      let cy = blob.sumY / area + Double(roi.y0)
      let shape: Double
      if isBall {
        let p = Double(max(blob.boundary, 1))
        shape = min(1.0, 4 * Double.pi * area / (p * p))
      } else {
        let bboxArea = Double((blob.maxX - blob.minX + 1) * (blob.maxY - blob.minY + 1))
        shape = area / max(bboxArea, 1)
      }
      let conf = confidence(area: area, areaMin: areaMin, areaMax: areaMax,
                            shape: shape, shapeFloor: shapeFloor,
                            dx: prev.map { cx - $0.x }, dy: prev.map { cy - $0.y })
      if conf > (best?.confidence ?? 0) {
        best = Detection(x: cx, y: cy, area: area, confidence: conf, source: "color")
      }
    }
    return best
  }

  /// Apple Vision contour fallback. Runs ONLY when the color pass's best
  /// confidence is below MIN_CONFIDENCE_FLOOR (enforced by the caller); scores
  /// contours through the IDENTICAL confidence formula. Returns nil unless a
  /// contour clears the floor.
  private static func visionFallback(image: CIImage, roi: Roi, analysisH: Int,
                                     isBall: Bool,
                                     prev: (x: Double, y: Double)?) -> Detection? {
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
      let shape: Double
      if isBall {
        shape = min(1.0, 4 * Double.pi * area / max(perimeter * perimeter, 1))
      } else {
        shape = area / max((maxX - minX) * (maxY - minY), 1)
      }
      let conf = confidence(area: area, areaMin: areaMin, areaMax: areaMax,
                            shape: shape, shapeFloor: shapeFloor,
                            dx: prev.map { cx - $0.x }, dy: prev.map { cy - $0.y })
      if conf > (best?.confidence ?? 0) {
        best = Detection(x: cx, y: cy, area: area, confidence: conf, source: "vision")
      }
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
  }
}
