import Foundation

// Phase 2: named capture constants. The three marked EXTERNAL ASSUMPTION are
// unverified at design time and gated on the G2 device test / Phase 5.5
// calibration — they are NOT user-configurable (single consumer this phase).
// See docs/architecture/apple-watch-imu.md.
enum WatchImuConstants {
    /// Rolling window the buffer retains. EXTERNAL ASSUMPTION (RING_BUFFER_SECONDS).
    /// Watch-primary: covers the clamped capture window (≤ maxCaptureDurationMs) plus
    /// margin so a slightly-long capture is never truncated by the ring.
    static let ringBufferSeconds: Double = 9

    /// Hard cap on a single capture; auto-stops a session left running.
    /// EXTERNAL ASSUMPTION — battery/awake guard.
    static let captureHardCapSeconds: Double = 60

    /// Default self-owned capture duration (watch-primary). The watch over-captures and
    /// the phone trims the IMU window to the video span after alignment.
    static let defaultCaptureDurationMs: Double = 7000

    /// Upper clamp on a phone-ARM `durationMs` override.
    static let maxCaptureDurationMs: Double = 8000

    /// Bound on the wait for the FIRST real IMU sample after imu.start(). If no sample
    /// arrives within this window the capture aborts to .ready (never finalizes 0 samples).
    static let armingTimeoutSeconds: Double = 3

    /// Binary blob layout version (byte 0 of the IMU `imu` Data). Bumped whenever the
    /// per-sample encoding changes; the phone decode asserts a match and drops on mismatch.
    static let blobLayoutVersion: UInt8 = 1

    /// G2 pass floor for a hard practice swing (userAcceleration magnitude, G).
    /// EXTERNAL ASSUMPTION — Phase 5.5 calibrates against the real impact spike.
    static let impactSpikeThresholdG: Double = 3.0

    /// Expected batched device-motion rate (Hz). Logged as `nominalHz`.
    static let nominalHz: Int = 200

    /// Ring capacity with headroom over a full window (≈ 1900 samples at 9 s / 200 Hz).
    static let ringCapacity: Int = Int(ringBufferSeconds * Double(nominalHz)) + 100
}
