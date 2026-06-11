import Foundation
import React
import WatchConnectivity

// Phase 3 (phone side): receives the watch's capture-then-transfer payload over
// WatchConnectivity, decodes the binary Data blob, and holds the LATEST result for
// JS to pull at persist time (promise-pull — matches the repo's native-module shape;
// no event emitter). Gated on the phone by the JS toggle: when the watch toggle is
// OFF, JS never calls activate(), so WCSession is never activated here.
@objc(HoneyWatchImuModule)
class HoneyWatchImuModule: NSObject, WCSessionDelegate {

  // Guards `latest` across the WC delegate queue (writes) and the JS queue (reads).
  private let lock = NSLock()
  private var latest: [String: Any]?

  @objc static func requiresMainQueueSetup() -> Bool {
    return false
  }

  // Idempotent WCSession activation. Called from JS at recording start (enabled only).
  @objc(activate:rejecter:)
  func activate(_ resolve: @escaping RCTPromiseResolveBlock,
                rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard WCSession.isSupported() else {
      resolve(false)
      return
    }
    let session = WCSession.default
    session.delegate = self
    if session.activationState != .activated {
      session.activate()
    }
    resolve(true)
  }

  // Returns the most recently received payload (or nil). JS applies the staleness
  // guard (receivedAtMs >= captureStartMs) so a prior swing's blob is not reused.
  @objc(getLatestWatchImu:rejecter:)
  func getLatestWatchImu(_ resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
    lock.lock()
    let snapshot = latest
    lock.unlock()
    resolve(snapshot)
  }

  // MARK: WCSessionDelegate

  func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
    guard let blob = userInfo["imu"] as? Data else {
      print("[HoneyWatchImu] payload missing imu blob")
      return
    }
    let doubles: [Double] = blob.withUnsafeBytes { Array($0.bindMemory(to: Double.self)) }
    guard !doubles.isEmpty, doubles.count % 7 == 0 else {
      print("[HoneyWatchImu] bad blob length \(doubles.count) (not a multiple of 7)")
      return
    }
    var readings: [[String: Double]] = []
    readings.reserveCapacity(doubles.count / 7)
    var i = 0
    while i < doubles.count {
      readings.append([
        "t": doubles[i], "ax": doubles[i + 1], "ay": doubles[i + 2], "az": doubles[i + 3],
        "gx": doubles[i + 4], "gy": doubles[i + 5], "gz": doubles[i + 6],
      ])
      i += 7
    }
    let receivedAtMs = Date().timeIntervalSince1970 * 1000
    let payload: [String: Any] = [
      "readings": readings,
      "n": userInfo["n"] ?? readings.count,
      "hz": userInfo["hz"] ?? 0,
      "g": userInfo["g"] ?? 0,
      "receivedAtMs": receivedAtMs,
    ]
    lock.lock()
    latest = payload
    lock.unlock()
    print("[HoneyWatchImu] received n=\(readings.count) receivedAtMs=\(receivedAtMs)")
  }

  func session(_ session: WCSession,
               activationDidCompleteWith activationState: WCSessionActivationState,
               error: Error?) {
    if let error {
      print("[HoneyWatchImu] activation error: \(error.localizedDescription)")
    }
  }

  // iOS-only delegate requirements; re-activate so the phone keeps receiving.
  func sessionDidBecomeInactive(_ session: WCSession) {}
  func sessionDidDeactivate(_ session: WCSession) {
    WCSession.default.activate()
  }
}
