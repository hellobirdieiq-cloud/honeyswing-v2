import Foundation
import HealthKit

// Golf HKWorkoutSession lifecycle. The active session is the EXTERNAL ASSUMPTION
// gate that unlocks CMBatchedSensorManager — start it before IMU updates, end it
// after. Logs every state transition (esp. .ended) for the G2 teardown check.
final class WorkoutController: NSObject, HKWorkoutSessionDelegate {
    private let healthStore = HKHealthStore()
    private var session: HKWorkoutSession?

    /// Authorize WRITE of workout data (a session writes it). read = [] — Phase 2
    /// reads nothing. Governed by NSHealthUpdateUsageDescription (HKHealthStore.h).
    func requestAuthorization(_ completion: @escaping (Bool) -> Void) {
        guard HKHealthStore.isHealthDataAvailable() else {
            print("[HoneyWatch][workout] HealthKit unavailable")
            completion(false)
            return
        }
        let toShare: Set<HKSampleType> = [HKObjectType.workoutType()]
        healthStore.requestAuthorization(toShare: toShare, read: []) { success, error in
            if let error {
                print("[HoneyWatch][workout] auth error: \(error.localizedDescription)")
            }
            completion(success)
        }
    }

    func start() {
        let config = HKWorkoutConfiguration()
        config.activityType = .golf
        config.locationType = .outdoor
        do {
            let session = try HKWorkoutSession(healthStore: healthStore, configuration: config)
            session.delegate = self
            self.session = session
            session.startActivity(with: nil)
            print("[HoneyWatch][workout] startActivity (golf)")
        } catch {
            print("[HoneyWatch][workout] start failed: \(error.localizedDescription)")
        }
    }

    func end() {
        session?.end()
    }

    // MARK: HKWorkoutSessionDelegate

    func workoutSession(_ workoutSession: HKWorkoutSession,
                        didChangeTo toState: HKWorkoutSessionState,
                        from fromState: HKWorkoutSessionState,
                        date: Date) {
        print("[HoneyWatch][workout] state -> \(Self.name(toState)) (was \(Self.name(fromState)))")
        if toState == .ended {
            session = nil
        }
    }

    func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        print("[HoneyWatch][workout] failed: \(error.localizedDescription)")
        session = nil
    }

    private static func name(_ state: HKWorkoutSessionState) -> String {
        switch state {
        case .notStarted: return "notStarted"
        case .prepared: return "prepared"
        case .running: return "running"
        case .paused: return "paused"
        case .stopped: return "stopped"
        case .ended: return "ended"
        @unknown default: return "unknown"
        }
    }
}
