import type { PersonalBand } from '@/packages/domain/clinic/PersonalBand';
import type { ClinicMetricKey } from '@/packages/domain/clinic/enums';

const bands = new Map<string, PersonalBand>();

// Returns a kid's personal band for a given metric, or null if not yet established.
export function getPersonalBand(
  kidId: string,
  metric: ClinicMetricKey,
): PersonalBand | null {
  // stub
  throw new Error('Not implemented');
}

// Inserts or replaces a personal band in the store.
export function upsertPersonalBand(band: PersonalBand): void {
  // stub
  throw new Error('Not implemented');
}

// Returns all personal bands for a kid (one per metric).
export function getBandsByKid(kidId: string): PersonalBand[] {
  // stub
  throw new Error('Not implemented');
}

// Clears all personal bands from the store (test/debug only).
export function clearPersonalBands(): void {
  // stub
  throw new Error('Not implemented');
}
