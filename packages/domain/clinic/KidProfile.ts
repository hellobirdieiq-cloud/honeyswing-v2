import type {
  Handedness,
  GripClassification,
  FaceAngleClassification,
  LumbarCupClassification,
  PhysicalTest,
  PhysicalTestResult,
} from './enums';

// Local mirror of lib/ageTier.ts AgeTier. Declared here to keep packages/domain free of lib imports.
export type KidAgeTier = 'junior' | 'youth' | 'teen' | 'adult';

export interface GripSessionEntry {
  sessionId: string;
  clinicNumber: number;
  recordedAt: number;
  classification: GripClassification;
  notes?: string;
}

export interface FaceAngleSessionEntry {
  sessionId: string;
  clinicNumber: number;
  recordedAt: number;
  classification: FaceAngleClassification;
  notes?: string;
}

export interface LumbarCupSessionEntry {
  sessionId: string;
  clinicNumber: number;
  recordedAt: number;
  classification: LumbarCupClassification;
  notes?: string;
}

export interface PhysicalScreenResult {
  sessionId: string;
  clinicNumber: number;
  recordedAt: number;
  test: PhysicalTest;
  result: PhysicalTestResult;
  notes?: string;
}

export interface KidProfile {
  id: string;
  name: string;
  ageTier: KidAgeTier;
  handedness: Handedness;
  gripHistory: GripSessionEntry[];
  faceAngleHistory: FaceAngleSessionEntry[];
  lumbarCupHistory: LumbarCupSessionEntry[];
  physicalScreenResults: PhysicalScreenResult[];
  createdAt: number;
  updatedAt: number;
}
