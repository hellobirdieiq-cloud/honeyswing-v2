import Foundation
import HealthKit
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

  // Phase 3 auto-mode: HealthKit store used only to launch the watch app into a
  // workout via startWatchApp (phone-driven). The watch arms IMU on the arm signal,
  // NOT on this launch (D2 integration contract).
  private let healthStore = HKHealthStore()

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

  // Ensures the shared session has our delegate and is activated, then returns it.
  // Mirrors activate(); calling transferUserInfo before activation would raise.
  private func activatedSession() -> WCSession {
    let session = WCSession.default
    session.delegate = self
    if session.activationState != .activated {
      session.activate()
    }
    return session
  }

  // Auto-mode (Phase 3): phone launches the watch app into a golf workout, then signals
  // ARM. startWatchApp only LAUNCHES + creates the OS workout — the watch arms IMU on the
  // arm signal it receives (D2 integration contract), not on this launch. Completion
  // failures print (existing convention) AND reject the JS promise — no silent fallback.
  @objc(startWatchAndArm:startMs:resolver:rejecter:)
  func startWatchAndArm(_ seq: NSNumber,
                        startMs: NSNumber,
                        resolver resolve: @escaping RCTPromiseResolveBlock,
                        rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard WCSession.isSupported() else {
      print("[HoneyWatchImu] startWatchAndArm: WCSession unsupported")
      reject("watch_unsupported", "WCSession not supported on this device", nil)
      return
    }
    guard HKHealthStore.isHealthDataAvailable() else {
      print("[HoneyWatchImu] startWatchAndArm: HealthKit unavailable")
      reject("health_unavailable", "HealthKit not available on this device", nil)
      return
    }
    let session = activatedSession()

    let config = HKWorkoutConfiguration()
    config.activityType = .golf
    config.locationType = .outdoor
    healthStore.startWatchApp(with: config) { success, error in
      if let error = error {
        print("[HoneyWatchImu] startWatchApp error: \(error.localizedDescription)")
        reject("start_watch_app_failed", error.localizedDescription, error)
        return
      }
      guard success else {
        print("[HoneyWatchImu] startWatchApp returned false")
        reject("start_watch_app_failed", "startWatchApp returned false", nil)
        return
      }
      let payload: [String: Any] = [
        "type": "arm",
        "seq": seq.doubleValue,
        "startMs": startMs.doubleValue,
      ]
      session.transferUserInfo(payload)
      print("[HoneyWatchImu] startWatchApp ok; queued arm seq=\(seq) startMs=\(startMs)")
      resolve(true)
    }
  }

  // Auto-mode (Phase 3): signal STOP. The watch snapshots its ring buffer + sends the
  // blob (existing transferUserInfo path). seq lets the watch echo it back for the
  // Phase 4/5 seq match. transferUserInfo is queued/guaranteed (no reachability needed).
  @objc(stopWatch:resolver:rejecter:)
  func stopWatch(_ seq: NSNumber,
                 resolver resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard WCSession.isSupported() else {
      print("[HoneyWatchImu] stopWatch: WCSession unsupported")
      reject("watch_unsupported", "WCSession not supported on this device", nil)
      return
    }
    let session = activatedSession()
    let payload: [String: Any] = ["type": "stop", "seq": seq.doubleValue]
    session.transferUserInfo(payload)
    print("[HoneyWatchImu] queued stop seq=\(seq)")
    resolve(true)
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
