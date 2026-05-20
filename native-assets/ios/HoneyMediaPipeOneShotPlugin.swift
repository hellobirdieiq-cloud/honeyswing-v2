import Foundation
import React
import MediaPipeTasksVision
import UIKit

@objc(HoneyMediaPipeOneShotPlugin)
class HoneyMediaPipeOneShotPlugin: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool { return false }

  /// Match live-frame plugin's landmark name array
  /// (HoneyVisionCameraHandPlugin.swift:14-21). Same 21 names, same order.
  private static let landmarkNames: [String] = [
    "wrist",
    "thumbCmc", "thumbMcp", "thumbIp", "thumbTip",
    "indexMcp", "indexPip", "indexDip", "indexTip",
    "middleMcp", "middlePip", "middleDip", "middleTip",
    "ringMcp", "ringPip", "ringDip", "ringTip",
    "pinkyMcp", "pinkyPip", "pinkyDip", "pinkyTip",
  ]

  private static let landmarkerLock = NSLock()
  private static var landmarker: HandLandmarker?

  private static func sharedLandmarker() -> (HandLandmarker?, String?) {
    landmarkerLock.lock()
    defer { landmarkerLock.unlock() }
    if let existing = landmarker { return (existing, nil) }

    guard let modelPath = Bundle.main.path(
      forResource: "hand_landmarker", ofType: "task"
    ) else {
      return (nil, "model_load_failed")
    }
    do {
      let opts = HandLandmarkerOptions()
      opts.baseOptions.modelAssetPath = modelPath
      opts.runningMode = .image
      opts.numHands = 2
      let lm = try HandLandmarker(options: opts)
      landmarker = lm
      return (lm, nil)
    } catch {
      return (nil, "model_load_failed: \(error.localizedDescription)")
    }
  }

  @objc(detectMediaPipeHandInPhoto:resolver:rejecter:)
  func detectMediaPipeHandInPhoto(_ photoUri: NSString,
                                  resolver resolve: @escaping RCTPromiseResolveBlock,
                                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      // 1. Lazy-init shared landmarker
      let (landmarkerOpt, initErr) = Self.sharedLandmarker()
      guard let handLandmarker = landmarkerOpt else {
        DispatchQueue.main.async {
          reject("model_load_failed", initErr ?? "unknown", nil)
        }
        return
      }

      // 2. Load UIImage from URI
      guard let url = URL(string: photoUri as String),
            let data = try? Data(contentsOf: url),
            let uiImage = UIImage(data: data) else {
        DispatchQueue.main.async {
          reject("invalid_photo",
                 "Could not load image from URI: \(photoUri)", nil)
        }
        return
      }

      // 3. Detect
      do {
        let mpImage = try MPImage(uiImage: uiImage)
        let result = try handLandmarker.detect(image: mpImage)

        var allHands: [[String: Any]] = []
        for handIndex in 0..<result.landmarks.count {
          let handLandmarks = result.landmarks[handIndex]
          let label = result.handedness[handIndex].first?.categoryName ?? "Unknown"
          let score = result.handedness[handIndex].first?.score ?? 0

          let points: [[String: Any]] = handLandmarks.enumerated().map { idx, lm in
            let name = idx < Self.landmarkNames.count
              ? Self.landmarkNames[idx]
              : "landmark_\(idx)"
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

        DispatchQueue.main.async { resolve(allHands) }
      } catch {
        DispatchQueue.main.async {
          reject("native_error",
                 "MediaPipe detect failed: \(error.localizedDescription)", nil)
        }
      }
    }
  }
}
