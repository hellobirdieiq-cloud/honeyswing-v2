import Foundation

// Phase 2: named capture constants. The three marked EXTERNAL ASSUMPTION are
// unverified at design time and gated on the G2 device test / Phase 5.5
// calibration — they are NOT user-configurable (single consumer this phase).
// See docs/architecture/apple-watch-imu.md.
enum WatchImuConstants {
    /// Rolling window the buffer retains. EXTERNAL ASSUMPTION (RING_BUFFER_SECONDS).
    static let ringBufferSeconds: Double = 4

    /// Hard cap on a single capture; auto-stops a session left running.
    /// EXTERNAL ASSUMPTION — battery/awake guard.
    static let captureHardCapSeconds: Double = 60

    /// G2 pass floor for a hard practice swing (userAcceleration magnitude, G).
    /// EXTERNAL ASSUMPTION — Phase 5.5 calibrates against the real impact spike.
    static let impactSpikeThresholdG: Double = 3.0

    /// Expected batched device-motion rate (Hz). Logged as `nominalHz`.
    static let nominalHz: Int = 200

    /// Ring capacity with headroom over a full window (≈ 900 samples).
    static let ringCapacity: Int = Int(ringBufferSeconds * Double(nominalHz)) + 100
}
