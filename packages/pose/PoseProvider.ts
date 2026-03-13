import { PoseSequence, PoseFrame } from "./PoseTypes";

export interface PoseProvider {
  readonly name: string;

  detectFromVideo(params: {
    videoUri: string;
  }): Promise<PoseSequence>;

  detectFromFrame?(params: {
    frame: unknown;
    timestampMs: number;
    frameWidth: number;
    frameHeight: number;
  }): Promise<PoseFrame>;
}