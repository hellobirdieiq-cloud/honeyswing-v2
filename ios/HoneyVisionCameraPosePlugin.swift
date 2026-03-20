import Foundation
import VisionCamera
import CoreMedia
import MediaPipeTasksVision

@objc(HoneyVisionCameraPosePlugin)
public class HoneyVisionCameraPosePlugin: FrameProcessorPlugin {
  private var poseLandmarker: PoseLandmarker?
  private var initError: String?
  private let ciContext = CIContext(options: [.useSoftwareRenderer: false])

  /// MediaPipe BlazePose GHUM index → (JS id, JS joint name).
  /// Only the 17 joints the JS side already knows about.
  private static let jointMapping: [(mpIndex: Int, id: Int, name: String)] = [
    ( 0,  0, "nose"),
    ( 2,  1, "leftEye"),
    ( 5,  2, "rightEye"),
    ( 7,  3, "leftEar"),
    ( 8,  4, "rightEar"),
    (11,  5, "leftShoulder"),
    (12,  6, "rightShoulder"),
    (13,  7, "leftElbow"),
    (14,  8, "rightElbow"),
    (15,  9, "leftWrist"),
    (16, 10, "rightWrist"),
    (23, 11, "leftHip"),
    (24, 12, "rightHip"),
    (25, 13, "leftKnee"),
    (26, 14, "rightKnee"),
    (27, 15, "leftAnkle"),
    (28, 16, "rightAnkle"),
  ]

  public override init(proxy: VisionCameraProxyHolder, options: [AnyHashable: Any]! = [:]) {
    super.init(proxy: proxy, options: options)
    setupLandmarker()
  }

  private func setupLandmarker() {
    guard let modelPath = Bundle.main.path(
      forResource: "pose_landmarker_full",
      ofType: "task"
    ) else {
      initError = "model_not_found"
      print("[HoneySwing] pose_landmarker_full.task not found in app bundle")
      return
    }

    do {
      let opts = PoseLandmarkerOptions()
      opts.baseOptions.modelAssetPath = modelPath
      opts.runningMode = .image
      opts.numPoses = 1
      poseLandmarker = try PoseLandmarker(options: opts)
      print("[HoneySwing] MediaPipe PoseLandmarker ready (\(modelPath))")
    } catch {
      initError = "init_failed: \(error.localizedDescription)"
      print("[HoneySwing] PoseLandmarker init failed: \(error)")
    }
  }

  public override func callback(
    _ frame: Frame,
    withArguments arguments: [AnyHashable: Any]?
  ) -> Any {
    // Surface init errors to JS so they show in Metro logs
    if let initError = initError {
      return [["_diagnostic": initError]]
    }
    guard let poseLandmarker = poseLandmarker else {
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
      let result = try poseLandmarker.detect(image: mpImage)

      guard let poseLandmarks = result.landmarks.first else { return [] }

      let landmarks: [[String: Any]] = Self.jointMapping.compactMap { mapping in
        guard mapping.mpIndex < poseLandmarks.count else { return nil }
        let lm = poseLandmarks[mapping.mpIndex]
        let visibility = lm.visibility?.floatValue ?? 0
        guard visibility > 0 else { return nil }

        return [
          "id": mapping.id,
          "name": mapping.name,
          "x": lm.x,
          "y": lm.y,
          "z": 0.0,
          "inFrameLikelihood": visibility,
          "isPresent": true,
        ]
      }

      return landmarks
    } catch {
      return [["_diagnostic": "detect_error: \(error.localizedDescription)"]]
    }
  }
}
