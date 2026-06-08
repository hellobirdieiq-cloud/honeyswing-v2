/**
 * datetime.ts — the ONE sanctioned gateway for DB timestamp strings.
 *
 * HOUSE RULE: never call `new Date()` directly on a Postgres/DB column value.
 * An offset-less string (e.g. "2026-06-06T22:03:28") is parsed by JS as
 * DEVICE-LOCAL, which shifts the instant by the device's UTC offset. We store
 * UTC; this gateway guarantees the parse reads offset-less strings as UTC while
 * leaving zone-marked strings (Z / +00:00 / -04:00 …) untouched.
 *
 * Model: store-UTC / parse-through-one-gateway (here) / render-device-local.
 */

// Trailing zone marker, anchored at end-of-string so the date-part dashes in
// "2026-06-06" never match: a literal Z/z, or a ±HH:MM / ±HHMM numeric offset.
const HAS_TZ = /(?:[Zz]|[+-]\d{2}:?\d{2})$/;

/**
 * Parse a DB timestamp string into a Date with the correct instant.
 * Use this everywhere a DB timestamp is turned into a Date; never `new Date(col)`.
 */
export function parseDbTimestamp(iso: string): Date {
  return new Date(HAS_TZ.test(iso) ? iso : iso + 'Z');
}
