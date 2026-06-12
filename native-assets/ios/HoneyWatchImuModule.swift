import Foundation
import HealthKit
import React
import WatchConnectivity

// Phone side of the watch-primary IMU pipeline. Two roles:
//
//  - Real-time control to JS (RCTEventEmitter): the watch is the primary initiator, so a
//    watch-started capture pushes `onWatchStarted` to JS (seq adoption + freshness-gated
//    video auto-start). Promise methods cover the warm path (armWatch/stopWatch), the
//    clock-sync handshake (clockSyncPing), the monotonic anchor (monotonicNowMs), and the
//    latest-blob pull (getLatestWatchImu).
//
//  - Data IN: decodes the watch's binary IMU blob (Float32, version-tagged) and holds the
//    LATEST for JS to pull at persist time.
//
// Gated on the phone by the JS toggle: when the watch toggle is OFF, JS never calls
// activate()/armWatch, so WCSession is never activated here.
@objc(HoneyWatchImuModule)
class HoneyWatchImuModule: RCTEventEmitter, WCSessionDelegate {

  // Must match the watch's WatchImuConstants.blobLayoutVersion. A mismatch means the paired
  // watch/phone builds disagree on the binary layout — drop loudly rather than mis-parse.
  private static let expectedBlobLayoutVersion: UInt8 = 1

  // Guards `latest` across the WC delegate queue (writes) and the JS queue (reads).
  private let lock = NSLock()
  private var latest: [String: Any]?

  // RCTEventEmitter listener gate — avoids "sending event with no listeners" warnings.
  private var hasListeners = false

  // HealthKit store used only for the OPTIONAL warm-path launch (launchWatchApp). The watch
  // arms IMU locally on its own tap, NOT on this launch.
  private let healthStore = HKHealthStore()

  override static func requiresMainQueueSetup() -> Bool {
    return false
  }

  override func supportedEvents() -> [String]! {
    // onWatchStarted: capture began (seq adoption + freshness-gated video auto-start).
    // onWatchBatch: an IMU blob arrived (drives late-join attach when it lands post-persist).
    return ["onWatchStarted", "onWatchBatch"]
  }

  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  // Idempotent WCSession activation. Called from JS when the watch toggle is on.
  @objc(activate:rejecter:)
  func activate(_ resolve: @escaping RCTPromiseResolveBlock,
                rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard WCSession.isSupported() else {
      resolve(false)
      return
    }
    _ = activatedSession()
    resolve(true)
  }

  // Returns the most recently received payload (or nil). JS applies the seq-match / staleness
  // guard so a prior swing's blob is not reused.
  @objc(getLatestWatchImu:rejecter:)
  func getLatestWatchImu(_ resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
    lock.lock()
    let snapshot = latest
    lock.unlock()
    resolve(snapshot)
  }

  // Monotonic clock in the SAME domain as the clock-sync offset (ProcessInfo.systemUptime).
  // JS stamps phoneMonoAtVideoStart with this at the startRecording call so alignment maps
  // watch-mono → phone-mono → video time consistently.
  @objc(monotonicNowMs:rejecter:)
  func monotonicNowMs(_ resolve: RCTPromiseResolveBlock,
                      rejecter reject: RCTPromiseRejectBlock) {
    resolve(ProcessInfo.processInfo.systemUptime * 1000)
  }

  // Ensures the shared session has our delegate and is activated, then returns it.
  private func activatedSession() -> WCSession {
    let session = WCSession.default
    session.delegate = self
    if session.activationState != .activated {
      session.activate()
    }
    return session
  }

  // MARK: Warm path (phone→watch), reachable-only

  // Warm-path ARM. sendMessage ONLY when reachable; the replyHandler is the delivery ack.
  // Unreachable / send failure → reject with a distinct code; JS surfaces "start from the
  // watch". Never queues ARM over transferUserInfo (a stale queued arm could fire a capture).
  @objc(armWatch:startMs:durationMs:mode:resolver:rejecter:)
  func armWatch(_ seq: NSNumber,
                startMs: NSNumber,
                durationMs: NSNumber,
                mode: NSString?,
                resolver resolve: @escaping RCTPromiseResolveBlock,
                rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard WCSession.isSupported() else {
      reject("watch_unsupported", "WCSession not supported on this device", nil)
      return
    }
    let session = activatedSession()
    guard session.isReachable else {
      print("[HoneyWatchImu] armWatch: watch unreachable")
      reject("watch_unreachable", "watch not reachable; start from the watch", nil)
      return
    }
    var msg: [String: Any] = [
      "type": "arm",
      "seq": seq.doubleValue,
      "startMs": startMs.doubleValue,
      "durationMs": durationMs.doubleValue,
    ]
    if let mode { msg["mode"] = mode as String }
    session.sendMessage(msg, replyHandler: { _ in
      print("[HoneyWatchImu] armWatch acked seq=\(seq)")
      resolve(true)
    }, errorHandler: { error in
      print("[HoneyWatchImu] armWatch send error: \(error.localizedDescription)")
      reject("arm_send_failed", error.localizedDescription, error)
    })
  }

  // Advisory STOP (reachable-only sendMessage). Not required for success — the watch stops on
  // its own duration timer — so an unreachable/failed stop resolves false rather than rejecting.
  @objc(stopWatch:resolver:rejecter:)
  func stopWatch(_ seq: NSNumber,
                 resolver resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard WCSession.isSupported() else {
      reject("watch_unsupported", "WCSession not supported on this device", nil)
      return
    }
    let session = activatedSession()
    guard session.isReachable else {
      print("[HoneyWatchImu] stopWatch: unreachable — advisory stop skipped")
      resolve(false)
      return
    }
    session.sendMessage(["type": "stop", "seq": seq.doubleValue], replyHandler: { _ in
      resolve(true)
    }, errorHandler: { error in
      print("[HoneyWatchImu] stopWatch send error: \(error.localizedDescription)")
      resolve(false)
    })
  }

  // Optional warm-path launch: wakes the watch app into a golf workout. Kept available for a
  // "wake watch" affordance; the watch-primary flow does not require it.
  @objc(launchWatchApp:rejecter:)
  func launchWatchApp(_ resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard WCSession.isSupported() else {
      reject("watch_unsupported", "WCSession not supported on this device", nil)
      return
    }
    guard HKHealthStore.isHealthDataAvailable() else {
      reject("health_unavailable", "HealthKit not available on this device", nil)
      return
    }
    _ = activatedSession()
    let config = HKWorkoutConfiguration()
    config.activityType = .golf
    config.locationType = .outdoor
    healthStore.startWatchApp(with: config) { success, error in
      if let error = error {
        print("[HoneyWatchImu] launchWatchApp error: \(error.localizedDescription)")
        reject("start_watch_app_failed", error.localizedDescription, error)
        return
      }
      guard success else {
        reject("start_watch_app_failed", "startWatchApp returned false", nil)
        return
      }
      print("[HoneyWatchImu] launchWatchApp ok")
      resolve(true)
    }
  }

  // MARK: Clock sync

  // Clock-sync handshake (reachable-only). Runs up to `rounds` ping/pong rounds, keeps the
  // lowest-RTT round, and resolves {clockOffsetMs, roundTripMs, handshakeAtMs}. clockOffsetMs
  // = watchMono − phoneMonoMid, where the watch reply is in CMDeviceMotion.timestamp's domain.
  @objc(clockSyncPing:resolver:rejecter:)
  func clockSyncPing(_ rounds: NSNumber,
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard WCSession.isSupported() else {
      reject("watch_unsupported", "WCSession not supported on this device", nil)
      return
    }
    let session = activatedSession()
    guard session.isReachable else {
      print("[HoneyWatchImu] clockSyncPing: watch unreachable")
      reject("watch_unreachable", "watch not reachable for clock sync", nil)
      return
    }
    let total = Swift.max(1, Swift.min(rounds.intValue, 8))
    var bestOffset: Double = 0
    var bestRtt: Double = .greatestFiniteMagnitude
    var anySuccess = false

    func runRound(_ i: Int) {
      if i >= total {
        guard anySuccess else {
          reject("clock_sync_failed", "no successful clock-sync rounds", nil)
          return
        }
        let handshakeAtMs = ProcessInfo.processInfo.systemUptime * 1000
        resolve([
          "clockOffsetMs": bestOffset,
          "roundTripMs": bestRtt,
          "handshakeAtMs": handshakeAtMs,
        ])
        return
      }
      let tSend = ProcessInfo.processInfo.systemUptime * 1000
      session.sendMessage(["type": "clocksync"], replyHandler: { reply in
        let tRecv = ProcessInfo.processInfo.systemUptime * 1000
        let watchMonoMs = (reply["watchMonoMs"] as? Double) ?? 0
        let rtt = tRecv - tSend
        let phoneMonoMid = (tSend + tRecv) / 2
        if rtt < bestRtt {
          bestRtt = rtt
          bestOffset = watchMonoMs - phoneMonoMid
        }
        anySuccess = true
        runRound(i + 1)
      }, errorHandler: { error in
        print("[HoneyWatchImu] clocksync round \(i) error: \(error.localizedDescription)")
        runRound(i + 1)
      })
    }
    runRound(0)
  }

  // MARK: WCSessionDelegate

  // Watch→phone `started` (sendMessage, no reply). Emits onWatchStarted so JS can adopt the
  // seq and — when pre-armed + fresh — auto-start video. receivedMonoMs is the phone-monotonic
  // receipt time for the no-offset freshness fallback.
  func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    guard let type = message["type"] as? String, type == "started" else { return }
    let receivedMonoMs = ProcessInfo.processInfo.systemUptime * 1000
    guard hasListeners else {
      print("[HoneyWatchImu] onWatchStarted dropped (no JS listener)")
      return
    }
    let body: [String: Any] = [
      "seq": message["seq"] ?? 0,
      "watchStartMs": message["watchStartMs"] ?? 0,
      "durationMs": message["durationMs"] ?? 0,
      "mode": message["mode"] ?? NSNull(),
      "receivedMonoMs": receivedMonoMs,
    ]
    sendEvent(withName: "onWatchStarted", body: body)
    print("[HoneyWatchImu] onWatchStarted seq=\(message["seq"] ?? 0) receivedMonoMs=\(receivedMonoMs)")
  }

  // Data IN: the captured window blob (transferUserInfo, queued/guaranteed).
  func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
    guard let blob = userInfo["imu"] as? Data, blob.count >= 1 else {
      print("[HoneyWatchImu] payload missing imu blob")
      return
    }
    let version = blob[0]
    guard version == Self.expectedBlobLayoutVersion else {
      print("[HoneyWatchImu] BLOB_VERSION_MISMATCH got=\(version) expected=\(Self.expectedBlobLayoutVersion) — dropping (watch/phone build mismatch)")
      return
    }
    // subdata(in:) copies into a fresh (aligned) allocation, so the Float32 bind is safe.
    let floatData = blob.count > 1 ? blob.subdata(in: 1..<blob.count) : Data()
    let floats: [Float32] = floatData.withUnsafeBytes { Array($0.bindMemory(to: Float32.self)) }
    guard !floats.isEmpty, floats.count % 7 == 0 else {
      print("[HoneyWatchImu] bad blob length \(floats.count) (not a multiple of 7)")
      return
    }
    let watchStartMs = (userInfo["watchStartMs"] as? Double) ?? 0
    var readings: [[String: Double]] = []
    readings.reserveCapacity(floats.count / 7)
    var i = 0
    while i < floats.count {
      // t reconstructed to absolute watch-mono ms (base + offset). Motion fields are Float32.
      readings.append([
        "t": watchStartMs + Double(floats[i]),
        "ax": Double(floats[i + 1]), "ay": Double(floats[i + 2]), "az": Double(floats[i + 3]),
        "gx": Double(floats[i + 4]), "gy": Double(floats[i + 5]), "gz": Double(floats[i + 6]),
      ])
      i += 7
    }
    let receivedAtMs = Date().timeIntervalSince1970 * 1000
    let receivedMonoMs = ProcessInfo.processInfo.systemUptime * 1000
    var payload: [String: Any] = [
      "readings": readings,
      "n": userInfo["n"] ?? readings.count,
      "hz": userInfo["hz"] ?? 0,
      "g": userInfo["g"] ?? 0,
      "receivedAtMs": receivedAtMs,
      "receivedMonoMs": receivedMonoMs,
      "watchStartMs": watchStartMs,
      "watchEndMs": userInfo["watchEndMs"] ?? watchStartMs,
      "durationMs": userInfo["durationMs"] ?? 0,
    ]
    // Forward the seq-match / alignment scalars when present (auto/watch-primary captures).
    if let seq = userInfo["seq"] { payload["seq"] = seq }
    if let armStartMs = userInfo["armStartMs"] { payload["armStartMs"] = armStartMs }
    if let mode = userInfo["mode"] { payload["mode"] = mode }
    lock.lock()
    latest = payload
    lock.unlock()
    print("[HoneyWatchImu] received n=\(readings.count) seq=\(String(describing: userInfo["seq"])) receivedAtMs=\(receivedAtMs)")
    // Notify JS a blob landed so the late-join path can seq-match/attach when this batch
    // drained AFTER the swing was persisted. The full payload is pulled via getLatestWatchImu.
    if hasListeners {
      sendEvent(withName: "onWatchBatch", body: [
        "seq": userInfo["seq"] ?? NSNull(),
        "n": readings.count,
        "receivedMonoMs": receivedMonoMs,
      ])
    }
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
