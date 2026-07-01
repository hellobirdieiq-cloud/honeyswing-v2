import Combine
import Foundation

enum CaptureState: Equatable {
    case ready
    case arming      // auth/IMU spin-up; didStartIMU=false; a stop here never finalizes
    case recording
    case sent(samples: Int, hz: Double)
}

// Why a capture stopped. Logged, not configurable.
enum StopReason: String {
    case userTap
    case background
    case hardCap
    case phoneStop
    case duration    // watch-owned duration timer (watch-primary auto-stop)
}

// Single orchestrator the watch UI binds to. Wires WorkoutController + ImuCapture and
// owns the capture state machine.
//
// Watch-primary: the watch is the primary initiator. arm() starts a self-owned capture
// immediately and locally (no phone dependency); a duration timer auto-stops it; phone
// STOP is advisory. The machine is ready → arming → recording → sent → ready.
//
// Invariants:
//  - didStartIMU flips only on the FIRST real IMU sample (ImuCapture.onFirstSample),
//    never on calling imu.start().
//  - A stop intent during .arming NEVER finalizes: a user tap arms a clean abort (send
//    nothing); an advisory phone stop is ignored (capture proceeds to its duration timer).
//  - The watch never finalizes 0 samples (arming watchdog aborts a dead spin-up).
//  - Finalize is idempotent across all sources via the `guard state == .recording`
//    terminal-state guard — exactly one finalize.
//  - Background/wrist-down never finalizes (every capture is duration/hard-cap bounded).
final class CaptureModel: ObservableObject {
    @Published private(set) var state: CaptureState = .ready

    // How the current capture was armed — logged only (background no longer branches on it
    // now that every capture is duration-bounded).
    enum ArmSource { case userTap, phoneArmed }
    private var armSource: ArmSource = .userTap
    private var armSeq: Double?       // echoed in started/blob for the phone seq-match
    private var armStartMs: Double?   // phone warm-path startMs (nil for watch taps)
    private var armMode: String?
    private var armDurationMs: Double = WatchImuConstants.defaultCaptureDurationMs

    private var didStartIMU = false
    private var pendingUserAbort = false   // user tapped Stop while still .arming
    private var watchStartMs: Double?      // first-sample boot-relative ms (window anchor)

    // Monotonic-ish seq for watch-initiated captures. Boot-relative ms keeps values unique
    // across the phone's seq-match lookback window without a persisted counter.
    private var watchSeqCounter: Double = ProcessInfo.processInfo.systemUptime * 1000

    private let workout = WorkoutController()
    private let imu = ImuCapture()
    private let wc = WatchConnectivityManager()
    private var hardCapTimer: Timer?
    private var durationTimer: Timer?
    private var armingTimer: Timer?

    init() {
        // Phone→watch warm-path signals (reachable-only sendMessage; see WatchConnectivityManager).
        wc.onArm = { [weak self] seq, startMs, durationMs, mode in
            self?.armFromPhone(seq: seq, startMs: startMs, durationMs: durationMs, mode: mode)
        }
        wc.onStop = { [weak self] in
            self?.stop(reason: .phoneStop)
        }
        // didStartIMU signal — fires on the first real batch, carrying its first timestamp.
        imu.onFirstSample = { [weak self] firstMs in
            self?.handleImuStarted(firstSampleMs: firstMs)
        }
    }

    // MARK: Intents

    /// Manual entry (watch Start button, content.swift). Watch-primary: the watch owns the
    /// captureSeq; the phone adopts it from the `started` signal / blob.
    func arm() {
        watchSeqCounter += 1
        beginCapture(source: .userTap, seq: watchSeqCounter, startMs: nil,
                     durationMs: WatchImuConstants.defaultCaptureDurationMs, mode: nil)
    }

    /// Phone-driven warm path (reachable-only ARM). Keeps the phone-generated seq and may
    /// override the duration; marks the capture phone-armed (logging only).
    func armFromPhone(seq: Double, startMs: Double, durationMs: Double, mode: String?) {
        beginCapture(source: .phoneArmed, seq: seq, startMs: startMs,
                     durationMs: durationMs, mode: mode)
    }

    private func beginCapture(source: ArmSource, seq: Double?, startMs: Double?,
                              durationMs: Double, mode: String?) {
        // Readiness check BEFORE any metadata mutation: an arm arriving during a running
        // capture must NOT relabel/overwrite the active capture — it is ignored.
        guard state == .ready else {
            print("[HoneyWatch][capture] arm ignored (state != ready); attempted source=\(source)")
            return
        }
        armSource = source
        armSeq = seq
        armStartMs = startMs
        armMode = mode
        armDurationMs = Swift.min(Swift.max(durationMs, 0), WatchImuConstants.maxCaptureDurationMs)
        didStartIMU = false
        pendingUserAbort = false
        watchStartMs = nil
        state = .arming
        print("[HoneyWatch][capture] ARMING source=\(source) seq=\(String(describing: seq)) durationMs=\(Int(armDurationMs))")
        workout.requestAuthorization { [weak self] granted in
            DispatchQueue.main.async {
                guard let self else { return }
                guard self.state == .arming else { return }  // aborted before auth returned
                if !granted {
                    print("[HoneyWatch][capture] auth not granted — aborting")
                    self.resetToReady()
                    return
                }
                // Workout session first (unlocks batched sensors), then IMU. didStartIMU
                // flips later, on the first real sample (imu.onFirstSample).
                self.workout.start()
                self.imu.start()
                self.scheduleArmingTimeout()  // bound the first-sample wait
            }
        }
    }

    /// First real IMU sample arrived (didStartIMU). Resolves the arming phase: either a
    /// clean abort (user cancelled) or the transition into .recording.
    private func handleImuStarted(firstSampleMs: Double) {
        guard state == .arming else { return }  // already resolved
        invalidateArmingTimeout()
        didStartIMU = true
        if pendingUserAbort {
            // User tapped Stop during arming → abort cleanly, send NOTHING (never finalize 0).
            print("[HoneyWatch][capture] user abort during arming — discarding capture")
            _ = imu.stop()
            workout.end()
            resetToReady()
            return
        }
        watchStartMs = firstSampleMs
        state = .recording
        // Notify the phone (reachable-only sendMessage). The phone adopts the seq and, when
        // pre-armed + fresh, auto-starts video. Unreachable → dropped; the blob carries the
        // durable copy for late-join / IMU-only.
        wc.sendStarted(seq: armSeq ?? 0, watchStartMs: firstSampleMs,
                       durationMs: armDurationMs, mode: armMode)
        scheduleDurationTimer(armDurationMs)
        scheduleHardCap()
        print("[HoneyWatch][capture] RECORDING seq=\(String(describing: armSeq)) watchStartMs=\(Int(firstSampleMs)) durationMs=\(Int(armDurationMs))")
    }

    func stop(reason: StopReason) {
        // Arming-phase intents never finalize (the watch never finalizes 0 samples).
        if state == .arming {
            switch reason {
            case .userTap:
                pendingUserAbort = true
                print("[HoneyWatch][capture] userTap during arming — will abort on IMU start")
            default:
                print("[HoneyWatch][capture] \(reason.rawValue) during arming — ignored (advisory)")
            }
            return
        }
        // Terminal-state guard: exactly one finalize across duration/phoneStop/hardCap/userTap.
        guard state == .recording else { return }
        invalidateDurationTimer()
        invalidateHardCap()
        let (samples, metrics) = imu.stop()
        workout.end()
        let durationMs = Int(metrics.durationMs.rounded())
        let derivedHz = String(format: "%.1f", metrics.derivedHz)
        let maxAccelG = String(format: "%.2f", metrics.maxAccelMagnitudeG)
        print("[HoneyWatch][capture] STOP reason=\(reason.rawValue) sampleCount=\(metrics.sampleCount) durationMs=\(durationMs) derivedHz=\(derivedHz) nominalHz=\(metrics.nominalHz) maxAccelMagnitudeG=\(maxAccelG) workoutState=ended")
        // Hand the captured window to the phone (transferUserInfo; queued/guaranteed).
        wc.send(samples: samples, metrics: metrics, seq: armSeq, armStartMs: armStartMs,
                durationMs: armDurationMs, mode: armMode)
        state = .sent(samples: metrics.sampleCount, hz: metrics.derivedHz)
    }

    /// scenePhase→background hook (content.swift). Watch-primary: every capture is bounded
    /// by its duration timer + the 60s hard cap, so wrist-down / backgrounding must NOT end
    /// a capture (constraint: background parity for watch-initiated captures).
    func handleBackground() {
        switch state {
        case .arming, .recording:
            print("[HoneyWatch][capture] background ignored (duration-bounded)")
        case .ready, .sent:
            break
        }
    }

    /// Sent screen → back to idle.
    func acknowledge() {
        guard case .sent = state else { return }
        resetToReady()
    }

    // MARK: Internals

    private func resetToReady() {
        invalidateArmingTimeout()
        invalidateDurationTimer()
        invalidateHardCap()
        state = .ready
        print("[HoneyWatch][capture] READY")
    }

    private func scheduleDurationTimer(_ ms: Double) {
        invalidateDurationTimer()
        durationTimer = Timer.scheduledTimer(
            withTimeInterval: ms / 1000.0, repeats: false
        ) { [weak self] _ in
            self?.stop(reason: .duration)
        }
    }

    private func invalidateDurationTimer() {
        durationTimer?.invalidate()
        durationTimer = nil
    }

    private func scheduleArmingTimeout() {
        invalidateArmingTimeout()
        armingTimer = Timer.scheduledTimer(
            withTimeInterval: WatchImuConstants.armingTimeoutSeconds, repeats: false
        ) { [weak self] _ in
            guard let self, self.state == .arming else { return }
            print("[HoneyWatch][capture] ARMING_TIMEOUT — no IMU sample within \(WatchImuConstants.armingTimeoutSeconds)s post-auth; clean abort, no finalize/send")
            _ = self.imu.stop()
            self.workout.end()
            self.resetToReady()
        }
    }

    private func invalidateArmingTimeout() {
        armingTimer?.invalidate()
        armingTimer = nil
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
