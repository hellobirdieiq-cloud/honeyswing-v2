import Foundation
import React
import AVFoundation
import Vision
import CoreImage

@objc(HoneyAppleVisionBodyConfirmPlugin)
class HoneyAppleVisionBodyConfirmPlugin: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool { return false }

  @objc(confirmBodyAtVideo:timestampMs:resolver:rejecter:)
  func confirmBodyAtVideo(_ videoUri: NSString,
                          timestampMs: NSNumber,
                          resolver resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      guard let url = URL(string: videoUri as String) else {
        DispatchQueue.main.async {
          reject("invalid_video", "Could not parse video URI: \(videoUri)", nil)
        }
        return
      }

      let asset = AVURLAsset(url: url)
      let generator = AVAssetImageGenerator(asset: asset)
      generator.appliesPreferredTrackTransform = true
      generator.requestedTimeToleranceBefore = .zero
      generator.requestedTimeToleranceAfter = .zero

      let cmTime = CMTime(value: CMTimeValue(timestampMs.doubleValue), timescale: 1000)
      guard let cgImage = try? generator.copyCGImage(at: cmTime, actualTime: nil) else {
        DispatchQueue.main.async {
          reject("frame_extract_failed",
                 "copyCGImage failed at \(timestampMs.doubleValue)ms", nil)
        }
        return
      }

      let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])
      let rectRequest = VNDetectHumanRectanglesRequest()
      let poseRequest = VNDetectHumanBodyPoseRequest()

      do {
        try handler.perform([rectRequest, poseRequest])
      } catch {
        DispatchQueue.main.async {
          reject("vision_failed", "Vision perform failed: \(error.localizedDescription)", nil)
        }
        return
      }

      let rectObs = (rectRequest.results ?? [])
        .max(by: { $0.confidence < $1.confidence })

      let poseObs = (poseRequest.results ?? [])
        .max(by: { $0.confidence < $1.confidence })

      let humanPresent = (rectObs != nil) || (poseObs != nil)

      var bboxDict: [String: Any] = ["x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0]
      if let r = rectObs {
        let bb = r.boundingBox
        bboxDict = [
          "x": bb.origin.x,
          "y": 1.0 - bb.origin.y - bb.height,
          "w": bb.width,
          "h": bb.height,
        ]
      }

      let bodyPoseConfidence: Float = poseObs?.confidence ?? 0.0

      DispatchQueue.main.async {
        resolve([
          "humanPresent": humanPresent,
          "humanBoundingBox": bboxDict,
          "bodyPoseConfidence": bodyPoseConfidence,
        ])
      }
    }
  }
}
