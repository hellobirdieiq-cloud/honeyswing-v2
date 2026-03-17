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
      return [["debug": 999]]
    }

    let request = VNDetectHumanBodyPoseRequest()

    do {
      let handler = VNImageRequestHandler(cvPixelBuffer: imageBuffer, orientation: .right, options: [:])
      try handler.perform([request])

      guard let observation = request.results?.first else {
        return []
      }

      let recognizedPoints = try observation.recognizedPoints(.all)

      let nameMap: [(VNHumanBodyPoseObservation.JointName, String)] = [
        (.nose, "nose"),
        (.leftEye, "leftEye"),
        (.rightEye, "rightEye"),
        (.leftEar, "leftEar"),
        (.rightEar, "rightEar"),
        (.neck, "neck"),
        (.leftShoulder, "leftShoulder"),
        (.rightShoulder, "rightShoulder"),
        (.leftElbow, "leftElbow"),
        (.rightElbow, "rightElbow"),
        (.leftWrist, "leftWrist"),
        (.rightWrist, "rightWrist"),
        (.root, "root"),
        (.leftHip, "leftHip"),
        (.rightHip, "rightHip"),
        (.leftKnee, "leftKnee"),
        (.rightKnee, "rightKnee"),
        (.leftAnkle, "leftAnkle"),
        (.rightAnkle, "rightAnkle")
      ]

      var output: [[String: Any]] = []

      for (jointName, exportName) in nameMap {
        guard let point = recognizedPoints[jointName], point.confidence > 0 else {
          continue
        }

        output.append([
          "name": exportName,
          "x": point.location.x,
          "y": point.location.y,
          "confidence": point.confidence
        ])
      }

      return output
    } catch {
      return [["debug": 333]]
    }
  }
}
