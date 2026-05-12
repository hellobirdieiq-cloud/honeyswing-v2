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

function generateSessionId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Returns the active clinic session, or null if none is running.
export function getCurrentClinicSession(): ClinicSession | null {
  return currentSession;
}

// Begins a new clinic session for a kid; replaces any current session in memory.
export function startClinicSession(
  kidId: string,
  clinicNumber: number,
): ClinicSession {
  currentSession = {
    id: generateSessionId(),
    kidId,
    clinicNumber,
    startedAt: Date.now(),
    endedAt: null,
    preflight: null,
    baselineSwingIds: [],
    cueBlockIds: [],
    retentionProbeSwingIds: [],
    physicalCheckResults: [],
  };
  return currentSession;
}

// Stores the pre-flight snapshot on the active session.
export function setPreflight(snapshot: PreflightSnapshot): void {
  if (!currentSession) return;
  currentSession.preflight = snapshot;
}

// Appends a baseline swing id to the active session.
export function appendBaselineSwing(swingId: string): void {
  if (!currentSession) return;
  currentSession.baselineSwingIds.push(swingId);
}

// Appends a cue block id to the active session.
export function appendCueBlock(cueBlockId: string): void {
  if (!currentSession) return;
  currentSession.cueBlockIds.push(cueBlockId);
}

// Appends a retention probe swing id to the active session.
export function appendRetentionSwing(swingId: string): void {
  if (!currentSession) return;
  currentSession.retentionProbeSwingIds.push(swingId);
}

// Appends a physical check result to the active session.
export function appendPhysicalCheckResult(result: PhysicalScreenResult): void {
  if (!currentSession) return;
  currentSession.physicalCheckResults.push(result);
}

// Marks the active session as ended (sets endedAt) and clears the in-memory pointer.
export function endClinicSession(): ClinicSession | null {
  if (!currentSession) return null;
  currentSession.endedAt = Date.now();
  const ended = currentSession;
  currentSession = null;
  return ended;
}
