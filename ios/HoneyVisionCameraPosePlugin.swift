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
      return [999]
    }

    let request = VNDetectHumanBodyPoseRequest()

    do {
      let handler = VNImageRequestHandler(cvPixelBuffer: imageBuffer, orientation: .right, options: [:])
      try handler.perform([request])

      guard let observations = request.results else {
        return [111]
      }

      if observations.isEmpty {
        return [222]
      }

      return Array(repeating: 1, count: observations.count)
    } catch {
      return [333]
    }
  }
}