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
    override init() {
        super.init()
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    /// Encode the snapshot + metrics and queue them for the phone.
    func send(samples: [ImuSample], metrics: CaptureMetrics) {
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
        let payload: [String: Any] = [
            "imu": blob,
            "n": metrics.sampleCount,
            "hz": metrics.derivedHz,
            "g": metrics.maxAccelMagnitudeG,
        ]
        WCSession.default.transferUserInfo(payload)
        print("[HoneyWatch][wc] queued transferUserInfo bytes=\(blob.count) n=\(metrics.sampleCount)")
    }

    // MARK: WCSessionDelegate (watchOS requires only activation completion)

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
