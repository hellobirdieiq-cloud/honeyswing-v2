import Combine
import Foundation

enum CaptureState: Equatable {
    case ready
    case recording
    case sent(samples: Int, hz: Double)
}

// Why a capture stopped. Logged, not configurable.
enum StopReason: String {
    case userTap
    case background
    case hardCap
    case phoneStop
}

// Single orchestrator the watch UI binds to. Wires WorkoutController + ImuCapture
// and owns the capture state machine. arm() and stop(reason:) are the only entry
// points; stop(reason:) is the single teardown path (tap / background / 60s cap).
final class CaptureModel: ObservableObject {
    @Published private(set) var state: CaptureState = .ready

    // How the current capture was armed. Phone-armed captures suppress the scenePhase
    // background auto-stop (the watch app is launched in the background by the phone);
    // the 60s hard cap remains the bound. Manual taps stay userTap (D4).
    enum ArmSource { case userTap, phoneArmed }
    private var armSource: ArmSource = .userTap
    private var armSeq: Double?      // echoed back in the blob for the phone seq-match (R4)
    private var armStartMs: Double?

    private let workout = WorkoutController()
    private let imu = ImuCapture()
    private let wc = WatchConnectivityManager()
    private var hardCapTimer: Timer?

    init() {
        // Phone→watch signals (Phase 4): arm/stop delivered over WatchConnectivity.
        wc.onArm = { [weak self] seq, startMs in
            self?.armFromPhone(seq: seq, startMs: startMs)
        }
        wc.onStop = { [weak self] in
            self?.stop(reason: .phoneStop)
        }
    }

    // MARK: Intents

    /// Manual entry (watch Start button, content.swift). D4: user taps set userTap.
    func arm() {
        beginCapture(source: .userTap, seq: nil, startMs: nil)
    }

    /// Phone-driven entry (auto-mode arm signal). Stores {seq, startMs} for the blob
    /// echo (R4) and marks the capture phone-armed so background auto-stop is suppressed.
    func armFromPhone(seq: Double, startMs: Double) {
        beginCapture(source: .phoneArmed, seq: seq, startMs: startMs)
    }

    private func beginCapture(source: ArmSource, seq: Double?, startMs: Double?) {
        // Readiness check BEFORE any metadata mutation: a phone arm arriving during a
        // running (e.g. manual) capture must NOT relabel armSource or overwrite the
        // running capture's seq/startMs — it is ignored, leaving the active capture intact.
        guard state == .ready else {
            print("[HoneyWatch][capture] arm ignored (state != ready); attempted source=\(source)")
            return
        }
        armSource = source
        armSeq = seq
        armStartMs = startMs
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
        let (samples, metrics) = imu.stop()
        workout.end()
        let durationMs = Int(metrics.durationMs.rounded())
        let derivedHz = String(format: "%.1f", metrics.derivedHz)
        let maxAccelG = String(format: "%.2f", metrics.maxAccelMagnitudeG)
        print("[HoneyWatch][capture] STOP reason=\(reason.rawValue) sampleCount=\(metrics.sampleCount) durationMs=\(durationMs) derivedHz=\(derivedHz) nominalHz=\(metrics.nominalHz) maxAccelMagnitudeG=\(maxAccelG) workoutState=ended")
        // Phase 3: hand the captured window to the phone (queues; delivers in background).
        // Phase 4: echo the arm {seq, armStartMs} (nil for manual captures — additive).
        wc.send(samples: samples, metrics: metrics, seq: armSeq, armStartMs: armStartMs)
        state = .sent(samples: metrics.sampleCount, hz: metrics.derivedHz)
    }

    /// scenePhase→background hook (content.swift). Stops only USER-armed captures;
    /// a phone-armed capture is launched in the background by the phone and must NOT be
    /// killed by backgrounding — the 60s hard cap bounds it instead (constraint 10).
    func handleBackground() {
        guard state == .recording else { return }
        if armSource == .phoneArmed {
            print("[HoneyWatch][capture] background ignored (phone-armed; 60s cap bounds)")
            return
        }
        stop(reason: .background)
    }

    /// Sent screen → back to idle.
    func acknowledge() {
        guard case .sent = state else { return }
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
