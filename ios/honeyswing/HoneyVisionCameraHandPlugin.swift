import Foundation
import VisionCamera
import CoreMedia
import MediaPipeTasksVision

@objc(HoneyVisionCameraHandPlugin)
public class HoneyVisionCameraHandPlugin: FrameProcessorPlugin {
  private var handLandmarker: HandLandmarker?
  private var initError: String?
  private let ciContext = CIContext(options: [.useSoftwareRenderer: false])
  private static var timingCounter: Int = 0

  /// MediaPipe Hand Landmarker — 21 landmarks per hand.
  private static let landmarkNames: [String] = [
    "wrist",
    "thumbCmc", "thumbMcp", "thumbIp", "thumbTip",
    "indexMcp", "indexPip", "indexDip", "indexTip",
    "middleMcp", "middlePip", "middleDip", "middleTip",
    "ringMcp", "ringPip", "ringDip", "ringTip",
    "pinkyMcp", "pinkyPip", "pinkyDip", "pinkyTip",
  ]

  public override init(proxy: VisionCameraProxyHolder, options: [AnyHashable: Any]! = [:]) {
    super.init(proxy: proxy, options: options)
    setupLandmarker()
  }

  private func setupLandmarker() {
    guard let modelPath = Bundle.main.path(
      forResource: "hand_landmarker",
      ofType: "task"
    ) else {
      initError = "model_not_found"
      print("[HoneySwing] hand_landmarker.task not found in app bundle")
      return
    }

    do {
      let opts = HandLandmarkerOptions()
      opts.baseOptions.modelAssetPath = modelPath
      opts.runningMode = .image
      opts.numHands = 2
      handLandmarker = try HandLandmarker(options: opts)
      print("[HoneySwing] MediaPipe HandLandmarker ready (\(modelPath))")
    } catch {
      initError = "init_failed: \(error.localizedDescription)"
      print("[HoneySwing] HandLandmarker init failed: \(error)")
    }
  }

  public override func callback(
    _ frame: Frame,
    withArguments arguments: [AnyHashable: Any]?
  ) -> Any {
    let t0 = CFAbsoluteTimeGetCurrent()

    // Surface init errors to JS so they show in Metro logs
    if let initError = initError {
      return [["_diagnostic": initError]]
    }
    guard let handLandmarker = handLandmarker else {
      return [["_diagnostic": "landmarker_nil"]]
    }
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(frame.buffer) else {
      return [["_diagnostic": "no_pixel_buffer"]]
    }

    // Rotate landscape sensor buffer → portrait via CIContext render.
    // UIImage(ciImage:) would have nil cgImage which MediaPipe cannot read.
    let ciImage = CIImage(cvPixelBuffer: pixelBuffer).oriented(.right)
    guard let cgImage = ciContext.createCGImage(ciImage, from: ciImage.extent) else {
      return [["_diagnostic": "cgimage_render_failed"]]
    }
    let uiImage = UIImage(cgImage: cgImage)

    do {
      let mpImage = try MPImage(uiImage: uiImage)
      let result = try handLandmarker.detect(image: mpImage)
      let t1 = CFAbsoluteTimeGetCurrent()

      var allHands: [[String: Any]] = []

      for handIndex in 0..<result.landmarks.count {
        let handLandmarks = result.landmarks[handIndex]

        // Handedness label ("Left" / "Right") and confidence
        let label = result.handedness[handIndex].first?.categoryName ?? "Unknown"
        let score = result.handedness[handIndex].first?.score ?? 0

        let points: [[String: Any]] = handLandmarks.enumerated().compactMap { idx, lm in
          let name = idx < Self.landmarkNames.count ? Self.landmarkNames[idx] : "landmark_\(idx)"
          return [
            "id": idx,
            "name": name,
            "x": lm.x,
            "y": lm.y,
            "z": lm.z,
            "visibility": lm.presence?.floatValue ?? 0,
          ]
        }

        allHands.append([
          "handIndex": handIndex,
          "label": label,
          "score": score,
          "landmarks": points,
        ])
      }

      let t2 = CFAbsoluteTimeGetCurrent()
      HoneyVisionCameraHandPlugin.timingCounter += 1
      if HoneyVisionCameraHandPlugin.timingCounter % 30 == 0 && !allHands.isEmpty {
        let inferenceMs = Int((t1 - t0) * 1000)
        let totalMs = Int((t2 - t0) * 1000)
        var first = allHands[0]
        first["debugInferenceMs"] = inferenceMs
        first["debugTotalMs"] = totalMs
        allHands[0] = first
      }

      return allHands
    } catch {
      return [["_diagnostic": "detect_error: \(error.localizedDescription)"]]
    }
  }
}
