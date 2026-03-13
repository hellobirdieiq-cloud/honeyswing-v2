import { PoseProvider } from "../PoseProvider";
import { PoseSequence } from "../PoseTypes";

export class MLKitProvider implements PoseProvider {
  name = "mlkit";

  async detectFromVideo({ videoUri }: { videoUri: string }): Promise<PoseSequence> {
    throw new Error("MLKitProvider not implemented yet");
  }
}