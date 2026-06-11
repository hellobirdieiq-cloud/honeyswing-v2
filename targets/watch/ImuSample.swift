import CoreMotion
import Foundation

// One IMU reading. Field set = arch doc's WatchImuReading minus the worn-wrist
// field (that field is Phase 5). t is milliseconds; ax/ay/az are userAcceleration
// in G (gravity already removed by CMDeviceMotion); gx/gy/gz are rotationRate (rad/s).
struct ImuSample {
    let t: Double   // CMDeviceMotion.timestamp * 1000 (ms; boot-relative monotonic)
    let ax: Double
    let ay: Double
    let az: Double
    let gx: Double
    let gy: Double
    let gz: Double

    init(from motion: CMDeviceMotion) {
        // timestamp is NSTimeInterval seconds (CMLogItem); store ms for intra-stream spacing.
        t = motion.timestamp * 1000
        // userAcceleration: gravity removed, units of G (CMDeviceMotion.h:118).
        ax = motion.userAcceleration.x
        ay = motion.userAcceleration.y
        az = motion.userAcceleration.z
        // rotationRate: rad/s (CMDeviceMotion.h:96).
        gx = motion.rotationRate.x
        gy = motion.rotationRate.y
        gz = motion.rotationRate.z
    }

    /// userAcceleration magnitude (G). ~0 at rest, spikes on a hard swing.
    var accelMagnitudeG: Double {
        (ax * ax + ay * ay + az * az).squareRoot()
    }
}
