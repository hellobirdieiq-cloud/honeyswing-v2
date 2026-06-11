import Foundation
import WatchConnectivity

// Phase 3: capture-then-transfer. After a swing stops, the retained window is
// flattened to one binary Data blob and handed to transferUserInfo — which queues
// and delivers reliably in the background (no live streaming, no sendMessage).
//
// Blob layout: flat Float64, 7 per sample in {t,ax,ay,az,gx,gy,gz} order. Simplest
// binary for a single fixed-schema consumer — decode on the phone is a reinterpret
// + chunk-by-7. The three summary scalars ride alongside as native plist values.
final class WatchConnectivityManager: NSObject, WCSessionDelegate {
    /// Phone→watch control signals (auto-mode, Phase 4). Set by CaptureModel; the
    /// delegate fires on a background queue, so these are invoked on the main queue.
    var onArm: ((_ seq: Double, _ startMs: Double) -> Void)?
    var onStop: (() -> Void)?

    override init() {
        super.init()
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    /// Encode the snapshot + metrics and queue them for the phone.
    func send(samples: [ImuSample], metrics: CaptureMetrics, seq: Double?, armStartMs: Double?) {
        guard WCSession.isSupported() else {
            print("[HoneyWatch][wc] WCSession unsupported — skipping transfer")
            return
        }
        var flat = [Double]()
        flat.reserveCapacity(samples.count * 7)
        for s in samples {
            flat.append(contentsOf: [s.t, s.ax, s.ay, s.az, s.gx, s.gy, s.gz])
        }
        let blob = flat.withUnsafeBytes { Data($0) }
        var payload: [String: Any] = [
            "imu": blob,
            "n": metrics.sampleCount,
            "hz": metrics.derivedHz,
            "g": metrics.maxAccelMagnitudeG,
        ]
        // Auto-mode (Phase 4): echo the arm signal's {seq, armStartMs} additively so the
        // phone can match this blob to the originating capture (R4). Absent for manual
        // captures (no arm signal) — the phone decode path is unchanged this phase.
        if let seq { payload["seq"] = seq }
        if let armStartMs { payload["armStartMs"] = armStartMs }
        WCSession.default.transferUserInfo(payload)
        print("[HoneyWatch][wc] queued transferUserInfo bytes=\(blob.count) n=\(metrics.sampleCount) seq=\(String(describing: seq))")
    }

    // MARK: WCSessionDelegate

    // Phone→watch control channel (auto-mode). transferUserInfo is queued/guaranteed;
    // delivered here in the background after startWatchApp launches the app.
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        guard let type = userInfo["type"] as? String else { return }
        switch type {
        case "arm":
            let seq = userInfo["seq"] as? Double ?? 0
            let startMs = userInfo["startMs"] as? Double ?? 0
            print("[HoneyWatch][wc] received arm seq=\(seq) startMs=\(startMs)")
            DispatchQueue.main.async { [weak self] in self?.onArm?(seq, startMs) }
        case "stop":
            print("[HoneyWatch][wc] received stop")
            DispatchQueue.main.async { [weak self] in self?.onStop?() }
        default:
            print("[HoneyWatch][wc] received unknown type=\(type)")
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
