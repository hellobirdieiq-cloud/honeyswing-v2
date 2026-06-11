import Combine
import Foundation

enum CaptureState: Equatable {
    case ready
    case recording
    case captured(samples: Int, hz: Double)
}

// Why a capture stopped. Logged, not configurable.
enum StopReason: String {
    case userTap
    case background
    case hardCap
}

// Single orchestrator the watch UI binds to. Wires WorkoutController + ImuCapture
// and owns the capture state machine. arm() and stop(reason:) are the only entry
// points; stop(reason:) is the single teardown path (tap / background / 60s cap).
final class CaptureModel: ObservableObject {
    @Published private(set) var state: CaptureState = .ready

    private let workout = WorkoutController()
    private let imu = ImuCapture()
    private var hardCapTimer: Timer?

    // MARK: Intents

    func arm() {
        guard state == .ready else { return }  // ignore taps while recording/captured
        state = .recording
        workout.requestAuthorization { [weak self] granted in
            DispatchQueue.main.async {
                guard let self else { return }
                guard self.state == .recording else { return }  // stopped before auth returned
                if !granted {
                    print("[HoneyWatch][capture] auth not granted — aborting")
                    self.resetToReady()
                    return
                }
                // Workout session first (unlocks batched sensors), then IMU.
                self.workout.start()
                self.imu.start()
                self.scheduleHardCap()
            }
        }
    }

    func stop(reason: StopReason) {
        guard state == .recording else { return }  // idempotent: only stops an active capture
        invalidateHardCap()
        let metrics = imu.stop()
        workout.end()
        let durationMs = Int(metrics.durationMs.rounded())
        let derivedHz = String(format: "%.1f", metrics.derivedHz)
        let maxAccelG = String(format: "%.2f", metrics.maxAccelMagnitudeG)
        print("[HoneyWatch][capture] STOP reason=\(reason.rawValue) sampleCount=\(metrics.sampleCount) durationMs=\(durationMs) derivedHz=\(derivedHz) nominalHz=\(metrics.nominalHz) maxAccelMagnitudeG=\(maxAccelG) workoutState=ended")
        state = .captured(samples: metrics.sampleCount, hz: metrics.derivedHz)
    }

    /// Captured screen → back to idle. Phase 3 inserts a "sent" state here.
    func acknowledge() {
        guard case .captured = state else { return }
        resetToReady()
    }

    // MARK: Internals

    private func resetToReady() {
        invalidateHardCap()
        state = .ready
        print("[HoneyWatch][capture] READY")
    }

    private func scheduleHardCap() {
        invalidateHardCap()
        // 60s cap so a session left running can't drain the battery / keep awake.
        hardCapTimer = Timer.scheduledTimer(
            withTimeInterval: WatchImuConstants.captureHardCapSeconds, repeats: false
        ) { [weak self] _ in
            self?.stop(reason: .hardCap)
        }
    }

    private func invalidateHardCap() {
        hardCapTimer?.invalidate()
        hardCapTimer = nil
    }
}
