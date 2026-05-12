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

// CONVERGENCE: replace 500ms polling in Tab 1/2 with store.subscribe().
// First consumer: Tab 1 LiveView — next build after this one.
type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyListeners(): void {
  listeners.forEach((l) => l());
}

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

// Returns true iff a clinic session is currently active.
export function clinicSessionActive(): boolean {
  return currentSession !== null;
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
  notifyListeners();
  return currentSession;
}

// Stores the pre-flight snapshot on the active session.
export function setPreflight(snapshot: PreflightSnapshot): void {
  if (!currentSession) return;
  currentSession.preflight = snapshot;
  notifyListeners();
}

// Appends a baseline swing id to the active session.
export function appendBaselineSwing(swingId: string): void {
  if (!currentSession) return;
  currentSession.baselineSwingIds.push(swingId);
  notifyListeners();
}

// Appends a cue block id to the active session.
export function appendCueBlock(cueBlockId: string): void {
  if (!currentSession) return;
  currentSession.cueBlockIds.push(cueBlockId);
  notifyListeners();
}

// Appends a retention probe swing id to the active session.
export function appendRetentionSwing(swingId: string): void {
  if (!currentSession) return;
  currentSession.retentionProbeSwingIds.push(swingId);
  notifyListeners();
}

// Appends a physical check result to the active session.
export function appendPhysicalCheckResult(result: PhysicalScreenResult): void {
  if (!currentSession) return;
  currentSession.physicalCheckResults.push(result);
  notifyListeners();
}

// Marks the active session as ended (sets endedAt) and clears the in-memory pointer.
export function endClinicSession(): ClinicSession | null {
  if (!currentSession) return null;
  currentSession.endedAt = Date.now();
  const ended = currentSession;
  currentSession = null;
  notifyListeners();
  return ended;
}
