import Foundation
import CoreML
import React
import os.log

@objc(HoneyRTMWModule)
class HoneyRTMWModule: NSObject {

  static let log = OSLog(subsystem: "com.honeyswing.rtmw", category: "model-load")

  @objc static func requiresMainQueueSetup() -> Bool {
    return false
  }

  @objc(probeLoad:rejecter:)
  func probeLoad(_ resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    NSLog("HONEYSWING_RTMW_PROBE: probeLoad entered")
    os_log("HONEYSWING_RTMW_PROBE: probeLoad entered", log: HoneyRTMWModule.log, type: .default)

    guard let url = Bundle.main.url(forResource: "rtmw_l_256x192", withExtension: "mlmodelc") else {
      let msg = "HONEYSWING_RTMW_PROBE: Bundle.main.url returned nil for rtmw_l_256x192.mlmodelc"
      NSLog(msg)
      os_log("%{public}@", log: HoneyRTMWModule.log, type: .error, msg)
      reject("bundle_miss", msg, nil)
      return
    }

    NSLog("HONEYSWING_RTMW_PROBE: resolved url = %@", url.path)
    os_log("HONEYSWING_RTMW_PROBE: resolved url = %{public}@", log: HoneyRTMWModule.log, type: .default, url.path)

    do {
      let config = MLModelConfiguration()
      config.computeUnits = .cpuAndNeuralEngine
      let model = try MLModel(contentsOf: url, configuration: config)
      let inputNames = Array(model.modelDescription.inputDescriptionsByName.keys).sorted()
      let outputNames = Array(model.modelDescription.outputDescriptionsByName.keys).sorted()
      let result = "LOADED inputs=\(inputNames) outputs=\(outputNames)"
      NSLog("HONEYSWING_RTMW_PROBE: %@", result)
      os_log("HONEYSWING_RTMW_PROBE: %{public}@", log: HoneyRTMWModule.log, type: .default, result)
      resolve(result)
    } catch {
      let msg = "HONEYSWING_RTMW_PROBE: load/compile failed: \(error.localizedDescription)"
      NSLog(msg)
      os_log("%{public}@", log: HoneyRTMWModule.log, type: .error, msg)
      reject("load_fail", msg, error)
    }
  }
}
