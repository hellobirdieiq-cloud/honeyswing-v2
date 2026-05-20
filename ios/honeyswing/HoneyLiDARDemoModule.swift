import Foundation
import ARKit
import UIKit
import React

@objc(HoneyLiDARDemoModule)
class HoneyLiDARDemoModule: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool {
    return false
  }

  @objc(isAvailable:rejecter:)
  func isAvailable(_ resolve: @escaping RCTPromiseResolveBlock,
                   rejecter reject: @escaping RCTPromiseRejectBlock) {
    let supported = ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    resolve(supported)
  }

  @objc(present:rejecter:)
  func present(_ resolve: @escaping RCTPromiseResolveBlock,
               rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) else {
      reject("no_lidar",
             "This device does not have LiDAR depth sensing.",
             nil)
      return
    }

    DispatchQueue.main.async {
      let rootVC: UIViewController? = UIApplication.shared
        .connectedScenes
        .filter { $0.activationState == .foregroundActive }
        .compactMap { $0 as? UIWindowScene }
        .flatMap { $0.windows }
        .first(where: { $0.isKeyWindow })?
        .rootViewController

      guard let root = rootVC else {
        reject("no_root_vc",
               "Could not find an active root view controller.",
               nil)
        return
      }

      let vc = HoneyLiDARDemoViewController()
      vc.modalPresentationStyle = .fullScreen
      root.present(vc, animated: true) {
        resolve(nil)
      }
    }
  }
}
