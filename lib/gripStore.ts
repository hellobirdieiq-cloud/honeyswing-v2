// In-memory only, current-session only grip photo store.

interface GripData {
  photoUri: string;
  acceptedAt: number;
}

let current: GripData | null = null;

export function setGrip(photoUri: string): void {
  current = { photoUri, acceptedAt: Date.now() };
}

export function getGrip(): GripData | null {
  return current;
}

export function clearGrip(): void {
  current = null;
}
