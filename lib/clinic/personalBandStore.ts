import type { PersonalBand } from '@/packages/domain/clinic/PersonalBand';
import type { ClinicMetricKey } from '@/packages/domain/clinic/enums';

const bands = new Map<string, PersonalBand>();

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyListeners(): void {
  listeners.forEach((l) => l());
}

function bandKey(
  kidId: string,
  clinicNumber: number,
  metric: ClinicMetricKey,
): string {
  return `${kidId}::${clinicNumber}::${metric}`;
}

// Returns a kid's personal band for a given metric in a given clinic, or null if not yet established.
export function getPersonalBand(
  kidId: string,
  clinicNumber: number,
  metric: ClinicMetricKey,
): PersonalBand | null {
  return bands.get(bandKey(kidId, clinicNumber, metric)) ?? null;
}

// Inserts or replaces a personal band in the store, keyed by kidId + clinicNumber + metric.
export function upsertPersonalBand(
  band: PersonalBand,
  clinicNumber: number,
): void {
  bands.set(bandKey(band.kidId, clinicNumber, band.metric), band);
  notifyListeners();
}

// Returns all personal bands for a kid (one per metric per clinic).
export function getBandsByKid(kidId: string): PersonalBand[] {
  return Array.from(bands.values()).filter((b) => b.kidId === kidId);
}

// Clears all personal bands from the store (test/debug only).
export function clearPersonalBands(): void {
  console.warn('[personalBandStore] clearPersonalBands called — test/debug only');
  bands.clear();
  notifyListeners();
}
