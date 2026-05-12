import type {
  Handedness,
  GripClassification,
  FaceAngleClassification,
  LumbarCupClassification,
  PhysicalTest,
  PhysicalTestResult,
} from './enums';

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
  ageYears: number;
  handedness: Handedness;
  gripHistory: GripSessionEntry[];
  faceAngleHistory: FaceAngleSessionEntry[];
  lumbarCupHistory: LumbarCupSessionEntry[];
  physicalScreenResults: PhysicalScreenResult[];
  createdAt: number;
  updatedAt: number;
}
