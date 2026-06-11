import SwiftUI

// Phase 2 watch UI: three states — ready / recording / captured(N, Hz).
// A "sent" state arrives in Phase 3 (watch→phone transfer) — not built here.
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

            case .recording:
                Text("Recording…")
                    .font(.headline)
                    .foregroundColor(.red)
                Button("Stop") { model.stop(reason: .userTap) }
                    .tint(.red)

            case let .captured(samples, hz):
                VStack(spacing: 2) {
                    Text("Captured")
                        .font(.headline)
                    Text("\(samples) samples")
                    Text(String(format: "%.1f Hz", hz))
                }
                Button("Done") { model.acknowledge() }
            }
        }
        .padding()
        .onChange(of: scenePhase) { _, newPhase in
            // watchOS can background an active workout; stop cleanly so the
            // session is not left running. (G2 watch-item: if this fires
            // mid-swing, the rule is too aggressive — report, don't fix here.)
            if newPhase == .background {
                model.stop(reason: .background)
            }
        }
    }
}

struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView()
    }
}
