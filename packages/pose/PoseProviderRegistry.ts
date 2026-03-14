import { PoseProvider } from "./PoseProvider";
import { MLKitProvider } from "./providers/MLKitProvider";

let provider: PoseProvider | null = null;

export function getPoseProvider(): PoseProvider {
  if (!provider) {
    provider = new MLKitProvider();
  }
  return provider;
}