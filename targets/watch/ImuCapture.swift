import CoreMotion
import Foundation

// Metrics computed once at stop, from the retained window.
struct CaptureMetrics {
    let sampleCount: Int
    let durationMs: Double
    let derivedHz: Double
    let maxAccelMagnitudeG: Double
    let nominalHz: Int
}

// Wraps CMBatchedSensorManager device-motion (watchOS 10+, ~200 Hz batched).
// No legacy non-batched motion-manager fallback: deploymentTarget 10.0 makes the
// batched API always present (CMBatchedSensorManager.h: API_AVAILABLE(watchos(10.0))).
final class ImuCapture {
    private let manager = CMBatchedSensorManager()
    private let buffer = ImuRingBuffer()
    // All buffer access funnels through one serial queue; the batched handler
    // fires on an internal CoreMotion queue, so we hop here before mutating.
    private let queue = DispatchQueue(label: "com.honeyswing.watch.imu")

    func start() {
        guard CMBatchedSensorManager.isDeviceMotionSupported else {
            print("[HoneyWatch][capture] device motion NOT supported")
            return
        }
        queue.sync { buffer.reset() }
        manager.startDeviceMotionUpdates { [weak self] data, error in
            guard let self else { return }
            if let error {
                print("[HoneyWatch][capture] device-motion error: \(error.localizedDescription)")
                return
            }
            guard let data else { return }
            self.queue.async {
                for motion in data {
                    self.buffer.append(ImuSample(from: motion))
                }
            }
        }
    }

    /// Stop updates, snapshot the window, and compute the gate metrics.
    /// Returns the raw samples too — Phase 3 encodes them into the transfer blob.
    func stop() -> (samples: [ImuSample], metrics: CaptureMetrics) {
        manager.stopDeviceMotionUpdates()
        let nominalHz = manager.deviceMotionDataFrequency
        let samples = queue.sync { buffer.snapshot() }
        return (samples, Self.metrics(from: samples, nominalHz: nominalHz))
    }

    private static func metrics(from samples: [ImuSample], nominalHz: Int) -> CaptureMetrics {
        let count = samples.count
        guard let first = samples.first, let last = samples.last, count > 1 else {
            return CaptureMetrics(
                sampleCount: count, durationMs: 0, derivedHz: 0,
                maxAccelMagnitudeG: samples.first?.accelMagnitudeG ?? 0, nominalHz: nominalHz
            )
        }
        // durationMs/derivedHz use the first/last DELTA — epoch-independent, so
        // the unverified boot-relative clock basis does not affect the gate.
        let durationMs = last.t - first.t
        let derivedHz = durationMs > 0 ? Double(count - 1) / (durationMs / 1000) : 0
        let maxAccel = samples.reduce(0.0) { Swift.max($0, $1.accelMagnitudeG) }
        return CaptureMetrics(
            sampleCount: count, durationMs: durationMs, derivedHz: derivedHz,
            maxAccelMagnitudeG: maxAccel, nominalHz: nominalHz
        )
    }
}
