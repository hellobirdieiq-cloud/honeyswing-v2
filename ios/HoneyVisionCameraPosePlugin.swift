import Foundation
import VisionCamera
import CoreMedia
import MediaPipeTasksVision
import CoreML
import Vision
import ImageIO
import os

@objc(HoneyVisionCameraPosePlugin)
public class HoneyVisionCameraPosePlugin: FrameProcessorPlugin, PoseLandmarkerLiveStreamDelegate {
  private var poseLandmarker: PoseLandmarker?
  private var initError: String?
  private static let resultLock = OSAllocatedUnfairLock<PoseLandmarkerResult?>(initialState: nil)

  private static let ciContext = CIContext(options: [.useSoftwareRenderer: false])
  private static var frameCount: Int = 0

  private static func convertToBGRA(_ pixelBuffer: CVPixelBuffer, orientation: UIImage.Orientation) -> CVPixelBuffer? {
    let exif: Int32 = {
      switch orientation {
      case .up:            return 1
      case .down:          return 3
      case .left:          return 6
      case .right:         return 8
      case .upMirrored:    return 2
      case .downMirrored:  return 4
      case .leftMirrored:  return 5
      case .rightMirrored: return 7
      @unknown default:    return 1
      }
    }()

    let ciImage = CIImage(cvPixelBuffer: pixelBuffer).oriented(forExifOrientation: exif)
    let extent = ciImage.extent

    var outBuffer: CVPixelBuffer?
    let status = CVPixelBufferCreate(
      kCFAllocatorDefault,
      Int(extent.width),
      Int(extent.height),
      kCVPixelFormatType_32BGRA,
      nil,
      &outBuffer
    )
    guard status == kCVReturnSuccess, let bgraBuffer = outBuffer else { return nil }

    ciContext.render(ciImage, to: bgraBuffer)
    return bgraBuffer
  }

  /// MediaPipe BlazePose GHUM — all 33 landmarks mapped to JS joint names.
  private static let jointMapping: [(mpIndex: Int, id: Int, name: String)] = [
    ( 0,  0, "nose"),
    ( 1,  1, "leftEyeInner"),
    ( 2,  2, "leftEye"),
    ( 3,  3, "leftEyeOuter"),
    ( 4,  4, "rightEyeInner"),
    ( 5,  5, "rightEye"),
    ( 6,  6, "rightEyeOuter"),
    ( 7,  7, "leftEar"),
    ( 8,  8, "rightEar"),
    ( 9,  9, "mouthLeft"),
    (10, 10, "mouthRight"),
    (11, 11, "leftShoulder"),
    (12, 12, "rightShoulder"),
    (13, 13, "leftElbow"),
    (14, 14, "rightElbow"),
    (15, 15, "leftWrist"),
    (16, 16, "rightWrist"),
    (17, 17, "leftPinky"),
    (18, 18, "rightPinky"),
    (19, 19, "leftIndex"),
    (20, 20, "rightIndex"),
    (21, 21, "leftThumb"),
    (22, 22, "rightThumb"),
    (23, 23, "leftHip"),
    (24, 24, "rightHip"),
    (25, 25, "leftKnee"),
    (26, 26, "rightKnee"),
    (27, 27, "leftAnkle"),
    (28, 28, "rightAnkle"),
    (29, 29, "leftHeel"),
    (30, 30, "rightHeel"),
    (31, 31, "leftFootIndex"),
    (32, 32, "rightFootIndex"),
  ]

  // MARK: - Grip Ring Buffer (Step 1)
  private static let gripBufferCapacity = 12
  private static var gripBuffer: [(buffer: CVPixelBuffer, timestamp: Double)?] = Array(repeating: nil, count: 12)
  private static var gripBufferWriteIndex = 0

  public override init(proxy: VisionCameraProxyHolder, options: [AnyHashable: Any]! = [:]) {
    super.init(proxy: proxy, options: options)
    setupLandmarker()
  }

  private func setupLandmarker() {
    let modelPath =
      Bundle.main.path(forResource: "pose_landmarker_full", ofType: "task") ??
      Bundle.main.path(forResource: "pose_landmarker_full", ofType: "task", inDirectory: "honeyswing")

    guard let modelPath = modelPath else {
      initError = "model_not_found"
      print("[HoneySwing] pose_landmarker_full.task not found in app bundle")
      print("[HoneySwing] Bundle path: \(Bundle.main.bundlePath)")
      let allTasks = Bundle.main.paths(forResourcesOfType: "task", inDirectory: nil)
      print("[HoneySwing] All .task files in bundle: \(allTasks)")
      return
    }

    do {
      let opts = PoseLandmarkerOptions()
      opts.baseOptions.modelAssetPath = modelPath
      opts.runningMode = .liveStream
      opts.poseLandmarkerLiveStreamDelegate = self
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
    #if DEBUG
    if Self.frameCount % 60 == 0 {
      print("[HoneyPose] orientation=\(frame.orientation.rawValue) w=\(CVPixelBufferGetWidth(pixelBuffer)) h=\(CVPixelBufferGetHeight(pixelBuffer))")
    }
    #endif
    Self.frameCount += 1

    do {
      let mpImage = try MPImage(pixelBuffer: pixelBuffer, orientation: frame.orientation)
      let timestampMs = Int(CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(frame.buffer)) * 1000)
      try poseLandmarker.detectAsync(image: mpImage, timestampInMilliseconds: timestampMs)

      // Grip path retains the pre-rotated BGRA buffer; cropForGrip is coupled to that orientation.
      let pts = CMSampleBufferGetPresentationTimeStamp(frame.buffer)
      if let bgraBuffer = Self.convertToBGRA(pixelBuffer, orientation: frame.orientation) {
        Self.stashGripFrame(pixelBuffer: bgraBuffer, timestamp: CMTimeGetSeconds(pts))
      }

      let consumed = Self.resultLock.withLock { (r: inout PoseLandmarkerResult?) -> PoseLandmarkerResult? in
        let out = r; r = nil; return out
      }
      guard let poseLandmarks = consumed?.landmarks.first else { return [] }

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
          "z": lm.z,
          "inFrameLikelihood": visibility,
          "isPresent": true,
        ]
      }

      return landmarks
    } catch {
      return [["_diagnostic": "detect_error: \(error.localizedDescription)"]]
    }
  }

  // MARK: - PoseLandmarkerLiveStreamDelegate

  public func poseLandmarker(
    _ poseLandmarker: PoseLandmarker,
    didFinishDetection result: PoseLandmarkerResult?,
    timestampInMilliseconds: Int,
    error: (any Error)?
  ) {
    guard let result = result, error == nil else { return }
    Self.resultLock.withLock { $0 = result }
  }

  @objc public class func resetPoseState() {
    resultLock.withLock { $0 = nil }
  }

  // MARK: - Grip Ring Buffer Methods (Step 1)

  private static func stashGripFrame(pixelBuffer: CVPixelBuffer, timestamp: Double) {
    let idx = gripBufferWriteIndex % gripBufferCapacity
    gripBuffer[idx] = (buffer: pixelBuffer, timestamp: timestamp)
    gripBufferWriteIndex += 1
  }

  private static func findClosestBuffer(timestamp: Double, toleranceSec: Double = 0.050) -> (buffer: CVPixelBuffer, timestamp: Double)? {
    var best: (buffer: CVPixelBuffer, timestamp: Double)? = nil
    var bestDelta = Double.infinity
    for entry in gripBuffer {
      guard let entry = entry else { continue }
      let delta = abs(entry.timestamp - timestamp)
      if delta < bestDelta {
        bestDelta = delta
        best = entry
      }
    }
    return (bestDelta <= toleranceSec) ? best : nil
  }

  private static func gripBufferCount() -> Int {
    gripBuffer.compactMap { $0 }.count
  }

  // MARK: - Grip Model Loading (Steps 2, 7)

  private static var gripModel: MLModel?
  private static var gripModelLoaded = false

  private static func loadGripModelIfNeeded() {
    guard !gripModelLoaded else { return }
    gripModelLoaded = true
    if let url = Bundle.main.url(forResource: "GripClassifier", withExtension: "mlpackage") {
      print("[GripModel] FOUND:", url)
      do {
        let compiledUrl = try MLModel.compileModel(at: url)
        gripModel = try MLModel(contentsOf: compiledUrl)
        print("[GripModel] Model compiled and loaded successfully")
      } catch {
        print("[GripModel] Failed to compile/load model:", error)
      }
    } else {
      print("[GripModel] MODEL_NOT_FOUND — fix bundling before continuing")
    }
  }

  // MARK: - Grip Crop (Step 3)

  private static let gripCIContext = CIContext(options: [.useSoftwareRenderer: false])

  private static func cropForGrip(pixelBuffer: CVPixelBuffer, wristX: Double, wristY: Double) -> CGImage? {
    let ciImage = CIImage(cvPixelBuffer: pixelBuffer).oriented(.right)
    let extent = ciImage.extent
    guard let fullImage = gripCIContext.createCGImage(ciImage, from: extent) else {
      print("[GripCrop] Failed to render full CGImage")
      return nil
    }
    let imgW = CGFloat(fullImage.width)
    let imgH = CGFloat(fullImage.height)
    let centerX = CGFloat(wristX) * imgW
    let centerY = CGFloat(wristY) * imgH
    let cropHalf = imgW * 0.15
    let x = max(0, centerX - cropHalf)
    let y = max(0, centerY - cropHalf)
    let w = min(cropHalf * 2, imgW - x)
    let h = min(cropHalf * 2, imgH - y)
    return fullImage.cropping(to: CGRect(x: x, y: y, width: w, height: h).integral)
  }

  // MARK: - Grip CoreML Inference (Step 3)

  private static func classifyGripImage(_ cgImage: CGImage) -> [String: Any]? {
    guard let model = gripModel else { return nil }
    guard let vnModel = try? VNCoreMLModel(for: model) else {
      print("[GripModel] Failed to create VNCoreMLModel")
      return nil
    }
    var result: [String: Any]? = nil
    let request = VNCoreMLRequest(model: vnModel) { request, error in
      if let error = error {
        print("[GripModel] VNCoreMLRequest error:", error)
        return
      }
      guard let observations = request.results as? [VNCoreMLFeatureValueObservation] else { return }
      var dict: [String: Any] = [:]
      for obs in observations {
        if let multiArray = obs.featureValue.multiArrayValue {
          var values: [Double] = []
          for i in 0..<multiArray.count {
            values.append(multiArray[i].doubleValue)
          }
          dict[obs.featureName] = values
        }
      }
      result = dict
    }
    request.imageCropAndScaleOption = .scaleFill
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do { try handler.perform([request]) }
    catch { print("[GripModel] Inference error:", error) }
    return result
  }

  // MARK: - classifyGripFrames (Step 3 — single native entry point)

  @objc(classifyGripFramesWithTimestamps:wristX:wristY:completion:)
  static func classifyGripFrames(
    timestamps: [Double],
    wristX: [Double],
    wristY: [Double],
    completion: @escaping ([[String: Any]]?) -> Void
  ) {
    DispatchQueue.global(qos: .userInitiated).async {
      loadGripModelIfNeeded()
      guard gripModel != nil else {
        print("[GripModel] Model not available — skipping grip classification")
        completion(nil)
        return
      }
      let bufferCount = gripBufferCount()
      print("[GripBuffer] Buffer has \(bufferCount) frames for \(timestamps.count) requested timestamps")
      if bufferCount == 0 {
        print("[GripBuffer] EMPTY — ring buffer has no frames")
        completion(nil)
        return
      }
      var results: [[String: Any]] = []
      for i in 0..<timestamps.count {
        let ts = timestamps[i]
        guard let entry = findClosestBuffer(timestamp: ts) else {
          print("[GripBuffer] requested ts=\(ts), no match within 50ms tolerance")
          continue
        }
        let deltaMs = abs(entry.timestamp - ts) * 1000.0
        print("[GripBuffer] requested ts=\(ts), closest ts=\(entry.timestamp), delta=\(String(format: "%.1f", deltaMs))ms")
        guard let crop = cropForGrip(pixelBuffer: entry.buffer, wristX: wristX[i], wristY: wristY[i]) else {
          print("[GripCrop] Failed to crop for timestamp \(ts)")
          continue
        }
        let tmpDir = FileManager.default.temporaryDirectory
        let cropUrl = tmpDir.appendingPathComponent("grip_crop_\(i).jpg")
        if let dest = CGImageDestinationCreateWithURL(cropUrl as CFURL, "public.jpeg" as CFString, 1, nil) {
          CGImageDestinationAddImage(dest, crop, nil)
          CGImageDestinationFinalize(dest)
          print("[GripCrop] saving crop to tmp for visual inspection: \(cropUrl.path)")
        }
        guard let prediction = classifyGripImage(crop) else {
          print("[GripModel] Inference returned nil for frame \(i)")
          continue
        }
        var frameResult: [String: Any] = ["timestamp": ts, "deltaMs": deltaMs]
        for (key, value) in prediction { frameResult[key] = value }
        results.append(frameResult)
      }
      print("[GripEstimation] Completed: \(results.count)/\(timestamps.count) frames classified")
      completion(results)
    }
  }

  // MARK: - releaseGripBuffer (Step 4)

  @objc static func releaseGripBuffer() {
    for i in 0..<gripBufferCapacity {
      gripBuffer[i] = nil
    }
    gripBufferWriteIndex = 0
    print("[GripBuffer] Released all buffers")
  }
}
