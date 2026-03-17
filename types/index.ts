// types/index.ts
import type { V1PoseLandmark } from '../packages/pose/PoseTypes';

export interface PoseFrame {
  landmarks: V1PoseLandmark[];
  timestamp: number;
  frameIndex: number;

  // Added to match V1 PoseFrame expected by calculateGolfAngles
  joints: Record<string, any>;
  frameWidth: number;
  frameHeight: number;
}

export interface SwingTrailPoint {
  x: number;
  y: number;
  timestamp: number;
}

export interface SwingMotionData {
  frames: PoseFrame[];
  trailPoints: SwingTrailPoint[];
  durationMs: number;
  frameCount: number;
  recordedAt: number;
}