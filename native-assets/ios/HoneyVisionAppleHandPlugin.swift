import Foundation
import React
import Vision
import UIKit

@objc(HoneyVisionAppleHandPlugin)
class HoneyVisionAppleHandPlugin: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool { return false }

  /// Maps Swift's VNHumanHandPoseObservation.JointName cases →
  /// the bare-name strings AppleVisionJointName expects.
  /// Per visionHandAdapter.ts:18-39 / :61-83 — TS-side lookup uses
  /// these EXACT keys. Don't reorder or rename.
  private static let jointNames: [(VNHumanHandPoseObservation.JointName, String)] = [
    (.wrist, "wrist"),
    (.thumbCMC, "thumbCMC"),
    (.thumbMP, "thumbMP"),
    (.thumbIP, "thumbIP"),
    (.thumbTip, "thumbTip"),
    (.indexMCP, "indexMCP"),
    (.indexPIP, "indexPIP"),
    (.indexDIP, "indexDIP"),
    (.indexTip, "indexTip"),
    (.middleMCP, "middleMCP"),
    (.middlePIP, "middlePIP"),
    (.middleDIP, "middleDIP"),
    (.middleTip, "middleTip"),
    (.ringMCP, "ringMCP"),
    (.ringPIP, "ringPIP"),
    (.ringDIP, "ringDIP"),
    (.ringTip, "ringTip"),
    (.littleMCP, "littleMCP"),
    (.littlePIP, "littlePIP"),
    (.littleDIP, "littleDIP"),
    (.littleTip, "littleTip"),
  ]

  @objc(detectAppleHandInPhoto:resolver:rejecter:)
  func detectAppleHandInPhoto(_ photoUri: NSString,
                              resolver resolve: @escaping RCTPromiseResolveBlock,
                              rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      // 1. Load UIImage from file:// URI
      guard let url = URL(string: photoUri as String),
            let data = try? Data(contentsOf: url),
            let uiImage = UIImage(data: data),
            let cgImage = uiImage.cgImage else {
        DispatchQueue.main.async {
          reject("invalid_photo",
                 "Could not load image from URI: \(photoUri)", nil)
        }
        return
      }

      // 2. Build VNDetectHumanHandPoseRequest (maxHandCount=2 to mirror MP)
      let request = VNDetectHumanHandPoseRequest()
      request.maximumHandCount = 2

      let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
      do {
        try handler.perform([request])
      } catch {
        DispatchQueue.main.async {
          reject("native_error",
                 "Vision request failed: \(error.localizedDescription)", nil)
        }
        return
      }

      // 3. Empty observations → resolve [] (not an error)
      let observations = request.results ?? []
      var hands: [[String: Any]] = []

      for obs in observations {
        var joints: [String: [String: Any]] = [:]
        for (jointName, stringKey) in Self.jointNames {
          guard let point = try? obs.recognizedPoint(jointName) else {
            continue
          }
          joints[stringKey] = [
            "x": point.location.x,
            "y": point.location.y,
            "confidence": point.confidence,
          ]
        }

        let chirality: String = {
          switch obs.chirality {
          case .left: return "left"
          case .right: return "right"
          case .unknown: return "unknown"
          @unknown default: return "unknown"
          }
        }()

        hands.append([
          "chirality": chirality,
          "score": obs.confidence,
          "joints": joints,
        ])
      }

      DispatchQueue.main.async { resolve(hands) }
    }
  }
}
