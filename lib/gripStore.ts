// In-memory only, current-session only grip photo store.
import type { GripClassification } from './classifyGrip';

const GRIP_TTL_MS = 30 * 60 * 1000;

interface GripData {
  photoUri: string;
  acceptedAt: number;
}

let current: GripData | null = null;

export function setGrip(photoUri: string): void {
  current = { photoUri, acceptedAt: Date.now() };
}

export function getGrip(): GripData | null {
  if (current && Date.now() - current.acceptedAt > GRIP_TTL_MS) {
    clearGrip();
    return null;
  }
  return current;
}

export function clearGrip(): void {
  current = null;
}

// Cloud grip classification — written by grip/result screen, consumed by persistSwing
let currentClassification: GripClassification | null = null;
let classificationExpiresAt = 0;

export function setGripClassification(c: GripClassification): void {
  currentClassification = c;
  classificationExpiresAt = Date.now() + GRIP_TTL_MS;
}

export function getGripClassification(): GripClassification | null {
  if (!currentClassification) return null;
  if (Date.now() > classificationExpiresAt) {
    clearGripClassification();
    return null;
  }
  return currentClassification;
}

export function clearGripClassification(): void {
  currentClassification = null;
  classificationExpiresAt = 0;
}
