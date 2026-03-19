import Foundation
import Vision
import VisionCamera
import CoreMedia

@objc(HoneyVisionCameraPosePlugin)
public class HoneyVisionCameraPosePlugin: FrameProcessorPlugin {
  public override init(proxy: VisionCameraProxyHolder, options: [AnyHashable: Any]! = [:]) {
    super.init(proxy: proxy, options: options)
  }

  public override func callback(_ frame: Frame, withArguments arguments: [AnyHashable: Any]?) -> Any {
    guard let imageBuffer = CMSampleBufferGetImageBuffer(frame.buffer) else {
      return []
    }

    let request = VNDetectHumanBodyPoseRequest()

    do {
      let handler = VNImageRequestHandler(cvPixelBuffer: imageBuffer, orientation: .right, options: [:])
      try handler.perform([request])

      guard let observation = request.results?.first else {
        return []
      }

      let supportedJoints: [(VNHumanBodyPoseObservation.JointName, Int, String)] = [
        (.nose, 0, "nose"),
        (.leftEye, 1, "leftEye"),
        (.rightEye, 2, "rightEye"),
        (.leftEar, 3, "leftEar"),
        (.rightEar, 4, "rightEar"),
        (.leftShoulder, 5, "leftShoulder"),
        (.rightShoulder, 6, "rightShoulder"),
        (.leftElbow, 7, "leftElbow"),
        (.rightElbow, 8, "rightElbow"),
        (.leftWrist, 9, "leftWrist"),
        (.rightWrist, 10, "rightWrist"),
        (.leftHip, 11, "leftHip"),
        (.rightHip, 12, "rightHip"),
        (.leftKnee, 13, "leftKnee"),
        (.rightKnee, 14, "rightKnee"),
        (.leftAnkle, 15, "leftAnkle"),
        (.rightAnkle, 16, "rightAnkle"),
      ]

      let recognizedPoints = try observation.recognizedPoints(.all)

      let landmarks: [[String: Any]] = supportedJoints.compactMap { jointName, id, outputName in
        guard let point = recognizedPoints[jointName], point.confidence > 0 else {
          return nil
        }

        return [
          "id": id,
          "name": outputName,
          "x": point.location.x,
          "y": 1.0 - point.location.y,
          "z": 0.0,
          "inFrameLikelihood": point.confidence,
          "isPresent": true
        ]
      }

      return landmarks
    } catch {
      return []
    }
  }
}
