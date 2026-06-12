import SwiftUI

// Watch UI: three states — ready / recording / sent(N, Hz). On stop the captured
// window is queued to the phone (Phase 3), so "captured" and "sent" are one state.
struct ContentView: View {
    @StateObject private var model = CaptureModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(spacing: 12) {
            switch model.state {
            case .ready:
                Text("Ready")
                    .font(.headline)
                Button("Start") { model.arm() }
                    .tint(.green)

            case .arming:
                // IMU spin-up; not yet recording. A Stop here arms a clean abort
                // (CaptureModel discards on the first sample — never finalizes 0).
                Text("Starting…")
                    .font(.headline)
                    .foregroundColor(.orange)
                Button("Cancel") { model.stop(reason: .userTap) }
                    .tint(.orange)

            case .recording:
                Text("Recording…")
                    .font(.headline)
                    .foregroundColor(.red)
                Button("Stop") { model.stop(reason: .userTap) }
                    .tint(.red)

            case let .sent(samples, hz):
                VStack(spacing: 2) {
                    Text("Sent ✓")
                        .font(.headline)
                        .foregroundColor(.green)
                    Text("\(samples) samples")
                    Text(String(format: "%.1f Hz", hz))
                }
                Button("Done") { model.acknowledge() }
            }
        }
        .padding()
        .onChange(of: scenePhase) { _, newPhase in
            // watchOS can background an active workout; stop cleanly so the session is
            // not left running — but ONLY for user-armed captures. Phone-armed captures
            // (auto-mode) are launched in the background and must not be killed here;
            // CaptureModel.handleBackground() applies that gate (60s hard cap bounds them).
            if newPhase == .background {
                model.handleBackground()
            }
        }
    }
}

struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView()
    }
}
