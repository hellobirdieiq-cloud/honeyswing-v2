import type { PersonalBand } from '@/packages/domain/clinic/PersonalBand';
import type { ClinicMetricKey } from '@/packages/domain/clinic/enums';

const bands = new Map<string, PersonalBand>();

function bandKey(kidId: string, metric: ClinicMetricKey): string {
  return `${kidId}::${metric}`;
}

// Returns a kid's personal band for a given metric, or null if not yet established.
export function getPersonalBand(
  kidId: string,
  metric: ClinicMetricKey,
): PersonalBand | null {
  return bands.get(bandKey(kidId, metric)) ?? null;
}

// Inserts or replaces a personal band in the store.
export function upsertPersonalBand(band: PersonalBand): void {
  bands.set(bandKey(band.kidId, band.metric), band);
}

// Returns all personal bands for a kid (one per metric).
export function getBandsByKid(kidId: string): PersonalBand[] {
  return Array.from(bands.values()).filter((b) => b.kidId === kidId);
}

// Clears all personal bands from the store (test/debug only).
export function clearPersonalBands(): void {
  console.warn('[personalBandStore] clearPersonalBands called — test/debug only');
  bands.clear();
}
