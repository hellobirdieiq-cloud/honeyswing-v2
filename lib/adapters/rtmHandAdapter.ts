import type { CanonicalHandFrame } from '../canonicalHandFrame';

/**
 * Placeholder for RTM-ANE hand detector adapter. Reserves the file slot so the
 * future RTM detector drops in without touching the three-adapter list elsewhere.
 * Signature is locked per Phase 2 plan D3.
 */
export function rtmToCanonical(_: unknown): CanonicalHandFrame {
  throw new Error('rtm_adapter_not_implemented');
}
