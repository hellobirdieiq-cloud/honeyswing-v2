import Foundation
import WatchConnectivity

// Watch-side WatchConnectivity. Two channels:
//
//  - Control IN (phone→watch): arm / stop / clocksync, delivered over sendMessage
//    (reachable-only). clocksync and arm carry a replyHandler the phone uses as an ack /
//    clock reply. The watch never receives anything over transferUserInfo.
//
//  - Data OUT (watch→phone): the captured window, flattened to one binary Data blob and
//    handed to transferUserInfo (queued/guaranteed, survives unreachability). The `started`
//    signal goes out over sendMessage (reachable-only) — its durable copy rides the blob.
//
// Blob layout: byte0 = BLOB_LAYOUT_VERSION, then N×7 Float32 records in
// {t_offset,ax,ay,az,gx,gy,gz} order, where t_offset = sample.t − watchStartMs (ms). Float32
// halves the payload (28 B/sample) so the longer watch-primary window fits transferUserInfo;
// the version byte makes a watch/phone build mismatch fail loudly on the phone decode.
final class WatchConnectivityManager: NSObject, WCSessionDelegate {
    /// Phone→watch warm-path control signals. Set by CaptureModel; the WC delegate fires on
    /// a background queue, so onArm/onStop are dispatched to the main queue.
    var onArm: ((_ seq: Double, _ startMs: Double, _ durationMs: Double, _ mode: String?) -> Void)?
    var onStop: (() -> Void)?

    override init() {
        super.init()
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    /// Notify the phone that capture started (reachable-only). When pre-armed + fresh the
    /// phone adopts the seq and auto-starts video. Unreachable → dropped; the blob carries
    /// the durable {seq, watchStartMs} for late-join / IMU-only.
    func sendStarted(seq: Double, watchStartMs: Double, durationMs: Double, mode: String?) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.isReachable else {
            print("[HoneyWatch][wc] started NOT sent (unreachable) seq=\(seq)")
            return
        }
        var msg: [String: Any] = [
            "type": "started",
            "seq": seq,
            "watchStartMs": watchStartMs,
            "durationMs": durationMs,
        ]
        if let mode { msg["mode"] = mode }
        session.sendMessage(msg, replyHandler: nil) { error in
            print("[HoneyWatch][wc] started send error: \(error.localizedDescription)")
        }
        print("[HoneyWatch][wc] sent started seq=\(seq) watchStartMs=\(Int(watchStartMs))")
    }

    /// Encode the snapshot + metrics and queue them for the phone (transferUserInfo).
    func send(samples: [ImuSample], metrics: CaptureMetrics, seq: Double?,
              armStartMs: Double?, durationMs: Double, mode: String?) {
        guard WCSession.isSupported() else {
            print("[HoneyWatch][wc] WCSession unsupported — skipping transfer")
            return
        }
        // Offsets are relative to the first retained sample; that same base rides as the
        // `watchStartMs` scalar so the phone reconstructs absolute watch-mono ms = base + offset.
        let base = samples.first?.t ?? 0
        var floats = [Float32]()
        floats.reserveCapacity(samples.count * 7)
        for s in samples {
            floats.append(Float32(s.t - base))
            floats.append(Float32(s.ax))
            floats.append(Float32(s.ay))
            floats.append(Float32(s.az))
            floats.append(Float32(s.gx))
            floats.append(Float32(s.gy))
            floats.append(Float32(s.gz))
        }
        var blob = Data([WatchImuConstants.blobLayoutVersion])
        floats.withUnsafeBytes { blob.append(contentsOf: $0) }

        var payload: [String: Any] = [
            "imu": blob,
            "n": metrics.sampleCount,
            "hz": metrics.derivedHz,
            "g": metrics.maxAccelMagnitudeG,
            "watchStartMs": base,
            "watchEndMs": samples.last?.t ?? base,
            "durationMs": durationMs,
        ]
        // Echo the arm signal's {seq, armStartMs} (nil for legacy/manual paths — additive).
        if let seq { payload["seq"] = seq }
        if let armStartMs { payload["armStartMs"] = armStartMs }
        if let mode { payload["mode"] = mode }
        WCSession.default.transferUserInfo(payload)
        print("[HoneyWatch][wc] queued transferUserInfo bytes=\(blob.count) n=\(metrics.sampleCount) seq=\(String(describing: seq)) v=\(WatchImuConstants.blobLayoutVersion)")
    }

    // MARK: WCSessionDelegate — control channel (sendMessage, reachable-only)

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        _ = handleMessage(message)
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any],
                 replyHandler: @escaping ([String: Any]) -> Void) {
        replyHandler(handleMessage(message) ?? [:])
    }

    /// Parse a control message; returns an optional reply dict (clocksync reply / arm-stop ack).
    private func handleMessage(_ message: [String: Any]) -> [String: Any]? {
        guard let type = message["type"] as? String else { return nil }
        switch type {
        case "arm":
            let seq = message["seq"] as? Double ?? 0
            let startMs = message["startMs"] as? Double ?? 0
            let durationMs = message["durationMs"] as? Double ?? WatchImuConstants.defaultCaptureDurationMs
            let mode = message["mode"] as? String
            print("[HoneyWatch][wc] received arm seq=\(seq) startMs=\(startMs) durationMs=\(durationMs)")
            DispatchQueue.main.async { [weak self] in self?.onArm?(seq, startMs, durationMs, mode) }
            return ["ok": true]
        case "stop":
            print("[HoneyWatch][wc] received stop (advisory)")
            DispatchQueue.main.async { [weak self] in self?.onStop?() }
            return ["ok": true]
        case "clocksync":
            // Reply in the SAME monotonic domain as CMDeviceMotion.timestamp (the IMU sample
            // clock, ImuSample.t) so the phone's computed offset is applicable to IMU samples.
            let watchMonoMs = ProcessInfo.processInfo.systemUptime * 1000
            return ["watchMonoMs": watchMonoMs]
        default:
            print("[HoneyWatch][wc] received unknown type=\(type)")
            return nil
        }
    }

    func session(_ session: WCSession,
                 activationDidCompleteWith activationState: WCSessionActivationState,
                 error: Error?) {
        if let error {
            print("[HoneyWatch][wc] activation error: \(error.localizedDescription)")
        } else {
            print("[HoneyWatch][wc] activation state=\(activationState.rawValue)")
        }
    }
}
