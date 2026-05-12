import type { PhysicalScreenResult } from '@/packages/domain/clinic/KidProfile';
import type {
  GripClassification,
  FaceAngleClassification,
  LumbarCupClassification,
  StanceClassification,
} from '@/packages/domain/clinic/enums';

export interface PreflightSnapshot {
  grip: GripClassification;
  stance: StanceClassification;
  lumbarCup: LumbarCupClassification;
  faceAngle: FaceAngleClassification;
  capturedAt: number;
}

export interface ClinicSession {
  id: string;
  kidId: string;
  clinicNumber: number;
  startedAt: number;
  endedAt: number | null;
  preflight: PreflightSnapshot | null;
  baselineSwingIds: string[];
  cueBlockIds: string[];
  retentionProbeSwingIds: string[];
  physicalCheckResults: PhysicalScreenResult[];
}

let currentSession: ClinicSession | null = null;

// Returns the active clinic session, or null if none is running.
export function getCurrentClinicSession(): ClinicSession | null {
  // stub
  throw new Error('Not implemented');
}

// Begins a new clinic session for a kid; replaces any current session in memory.
export function startClinicSession(
  kidId: string,
  clinicNumber: number,
): ClinicSession {
  // stub
  throw new Error('Not implemented');
}

// Stores the pre-flight snapshot on the active session.
export function setPreflight(snapshot: PreflightSnapshot): void {
  // stub
  throw new Error('Not implemented');
}

// Appends a baseline swing id to the active session.
export function appendBaselineSwing(swingId: string): void {
  // stub
  throw new Error('Not implemented');
}

// Appends a cue block id to the active session.
export function appendCueBlock(cueBlockId: string): void {
  // stub
  throw new Error('Not implemented');
}

// Appends a retention probe swing id to the active session.
export function appendRetentionSwing(swingId: string): void {
  // stub
  throw new Error('Not implemented');
}

// Appends a physical check result to the active session.
export function appendPhysicalCheckResult(result: PhysicalScreenResult): void {
  // stub
  throw new Error('Not implemented');
}

// Marks the active session as ended (sets endedAt) and clears the in-memory pointer.
export function endClinicSession(): ClinicSession | null {
  // stub
  throw new Error('Not implemented');
}
