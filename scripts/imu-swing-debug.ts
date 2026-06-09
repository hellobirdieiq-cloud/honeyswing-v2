/**
 * scripts/imu-swing-debug.ts — Phase 4 Step 0 IMU swing-trace offline analyzer.
 *
 * Usage:
 *   npx --yes tsx scripts/imu-swing-debug.ts <dir>
 *
 * Reads swing-1.json … swing-5.json from <dir> (an unzipped iOS app
 * container session folder produced by app/clinic/imu-debug.tsx) and prints
 * each swing's |a|² − 1.0 trace plus summary stats and two candidate
 * baseline numbers.
 *
 * Diagnostic only — the operator decides the Step 0 STOP-or-proceed call
 * by eye across all 5 swings. This script does not judge.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// EXTERNAL ASSUMPTION (RULE 42): these two constants ARE what Step 0 will
// inform — they are starting values for inspection, not calibrated picks.
// Do not treat them as final. Adjust after looking at the 5 traces.
//
// DIAGNOSTIC ONLY: FIRST_K_SAMPLES and PERCENTILE are explicitly NOT the
// production baseline algorithm. They are two side-by-side candidates this
// script renders for the operator's eye. The production baseline method —
// which method, which window, which threshold — belongs to
// lib/imuSwingWindow.ts (Phase 4 Step 5) and is chosen from the real
// traces this script produces. Do not import these constants from there.
const FIRST_K_SAMPLES = 15; // ~0.5 s at the nominal 33 ms sample interval
const PERCENTILE = 25; // 25th percentile of the full trace

const SPARK_CHARS = "▁▂▃▄▅▆▇█";
const SWING_FILENAMES: readonly string[] = [
  "swing-1.json",
  "swing-2.json",
  "swing-3.json",
  "swing-4.json",
  "swing-5.json",
];

type Reading = { x: number; y: number; z: number };

type SwingPayload = {
  schema_version: 1;
  session_id: string;
  swing_index: number;
  captured_at_ms: number;
  requested_sample_interval_ms: number;
  sample_count: number;
  readings: Reading[];
  trace_magsq_minus_one: number[];
};

type ValidationResult =
  | { ok: true; payload: SwingPayload }
  | { ok: false; reason: string };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function printUsage(): void {
  process.stderr.write(
    "Usage: npx --yes tsx scripts/imu-swing-debug.ts <dir>\n" +
      "  <dir>: path to an unzipped iOS app container session folder\n" +
      "         containing swing-1.json … swing-5.json\n",
  );
}

function validatePayload(parsed: unknown): ValidationResult {
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "top-level is not an object" };
  }
  const p = parsed as Record<string, unknown>;

  const schemaVersion = p.schema_version;
  if (schemaVersion !== 1) {
    return {
      ok: false,
      reason: `schema_version=${String(schemaVersion)}, expected 1`,
    };
  }

  const sessionId = p.session_id;
  if (typeof sessionId !== "string") {
    return { ok: false, reason: "session_id missing or not a string" };
  }

  const swingIndex = p.swing_index;
  if (typeof swingIndex !== "number") {
    return { ok: false, reason: "swing_index missing or not a number" };
  }

  const capturedAtMs = p.captured_at_ms;
  if (typeof capturedAtMs !== "number") {
    return { ok: false, reason: "captured_at_ms missing or not a number" };
  }

  const requestedSampleIntervalMs = p.requested_sample_interval_ms;
  if (typeof requestedSampleIntervalMs !== "number") {
    return {
      ok: false,
      reason: "requested_sample_interval_ms missing or not a number",
    };
  }

  const sampleCount = p.sample_count;
  if (typeof sampleCount !== "number") {
    return { ok: false, reason: "sample_count missing or not a number" };
  }

  const readings = p.readings;
  if (!Array.isArray(readings)) {
    return { ok: false, reason: "readings missing or not an array" };
  }

  const trace = p.trace_magsq_minus_one;
  if (!Array.isArray(trace)) {
    return {
      ok: false,
      reason: "trace_magsq_minus_one missing or not an array",
    };
  }

  if (readings.length !== trace.length || trace.length !== sampleCount) {
    return {
      ok: false,
      reason:
        `length mismatch — readings.length=${readings.length}, ` +
        `trace_magsq_minus_one.length=${trace.length}, ` +
        `sample_count=${sampleCount}`,
    };
  }

  if (trace.length === 0) {
    return { ok: false, reason: "empty trace" };
  }

  const validatedTrace: number[] = [];
  for (let i = 0; i < trace.length; i++) {
    const v = trace[i];
    if (!isFiniteNumber(v)) {
      return {
        ok: false,
        reason: `non-finite value in trace_magsq_minus_one at sample ${i}: ${String(v)}`,
      };
    }
    validatedTrace.push(v);
  }

  const validatedReadings: Reading[] = [];
  for (let i = 0; i < readings.length; i++) {
    const r = readings[i];
    if (typeof r !== "object" || r === null) {
      return { ok: false, reason: `reading[${i}] is not an object` };
    }
    const rec = r as Record<string, unknown>;
    const x = rec.x;
    const y = rec.y;
    const z = rec.z;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
      return { ok: false, reason: `reading[${i}] has non-finite x/y/z` };
    }
    validatedReadings.push({ x, y, z });
  }

  return {
    ok: true,
    payload: {
      schema_version: 1,
      session_id: sessionId,
      swing_index: swingIndex,
      captured_at_ms: capturedAtMs,
      requested_sample_interval_ms: requestedSampleIntervalMs,
      sample_count: sampleCount,
      readings: validatedReadings,
      trace_magsq_minus_one: validatedTrace,
    },
  };
}

function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sortedAsc[0];
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) {
    return SPARK_CHARS[0].repeat(values.length);
  }
  const span = max - min;
  const buckets = SPARK_CHARS.length;
  let out = "";
  for (const v of values) {
    const t = (v - min) / span;
    let idx = Math.floor(t * buckets);
    if (idx >= buckets) idx = buckets - 1;
    if (idx < 0) idx = 0;
    out += SPARK_CHARS[idx];
  }
  return out;
}

function peakMarkerLine(width: number, peakIdx: number): string {
  if (width <= 0) return "";
  const i = Math.max(0, Math.min(width - 1, peakIdx));
  return " ".repeat(i) + "^" + " ".repeat(Math.max(0, width - i - 1));
}

function formatNum(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  return v.toFixed(3);
}

function formatRatio(peak: number, baseline: number): string {
  if (!Number.isFinite(peak) || peak <= 0) return "n/a";
  if (!Number.isFinite(baseline) || baseline <= 0) return "n/a";
  return (peak / baseline).toFixed(2);
}

function analyzeFile(dir: string, filename: string): void {
  const filePath = join(dir, filename);

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${filename}: SKIP — read error: ${msg}\n\n`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${filename}: SKIP — JSON parse error: ${msg}\n\n`);
    return;
  }

  const validation = validatePayload(parsed);
  if (!validation.ok) {
    process.stdout.write(`${filename}: SKIP — ${validation.reason}\n\n`);
    return;
  }

  const { payload } = validation;
  const trace = payload.trace_magsq_minus_one;
  const n = trace.length;

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let peakIdx = 0;
  for (let i = 0; i < n; i++) {
    const v = trace[i];
    if (v < min) min = v;
    if (v > max) {
      max = v;
      peakIdx = i;
    }
    sum += v;
  }
  const mean = sum / n;
  const peak = max;

  const kEffective = Math.min(FIRST_K_SAMPLES, n);
  let firstK = -Infinity;
  for (let i = 0; i < kEffective; i++) {
    if (trace[i] > firstK) firstK = trace[i];
  }
  const firstKClamped = kEffective < FIRST_K_SAMPLES;

  const sorted = trace.slice().sort((a, b) => a - b);
  const pBaseline = percentile(sorted, PERCENTILE);

  const dtMs = payload.requested_sample_interval_ms;
  const tPeakSec = (peakIdx * dtMs) / 1000;

  const spark = sparkline(trace);
  const marker = peakMarkerLine(spark.length, peakIdx);

  const lines: string[] = [];
  lines.push(`=== ${filename} ===`);
  lines.push(`  session_id: ${payload.session_id}`);
  lines.push(`  swing_index: ${payload.swing_index}`);
  lines.push(`  sample_count: ${payload.sample_count}`);
  lines.push(
    `  stats: min=${formatNum(min)}  max=${formatNum(max)}  mean=${formatNum(mean)}`,
  );
  lines.push(
    `  global peak: value=${formatNum(peak)} at sample ${peakIdx} (t≈${tPeakSec.toFixed(3)} s)`,
  );
  lines.push("");
  lines.push(
    `  baseline-first-K (max of first ${FIRST_K_SAMPLES} samples` +
      (firstKClamped ? ` — clamped to ${kEffective}` : "") +
      `): ${formatNum(firstK)}`,
  );
  lines.push(`    peak / baseline-first-K = ${formatRatio(peak, firstK)}`);
  lines.push("");
  lines.push(
    `  baseline-percentile (P${PERCENTILE} of full trace): ${formatNum(pBaseline)}`,
  );
  lines.push(
    `    peak / baseline-percentile = ${formatRatio(peak, pBaseline)}`,
  );
  lines.push("");
  lines.push(`  trace (n=${n}):`);
  lines.push(`  ${spark}`);
  lines.push(`  ${marker}  peak idx ${peakIdx}`);
  lines.push(`  y-range: [${formatNum(min)}, ${formatNum(max)}]`);
  lines.push("");
  lines.push("  [Diagnostic only — operator decides Step 0 margin by eye");
  lines.push("   across all 5 swings. This script does not judge.]");
  lines.push("  [Note: the 'global peak' above is only the maximum of");
  lines.push("   |a|²−1.0 across the trace. It is NOT asserted to correspond");
  lines.push("   to impact, transition, top-of-backswing, or any specific");
  lines.push("   swing phase — do not infer 'largest peak = swing center'.]");
  lines.push("");
  lines.push("");

  process.stdout.write(lines.join("\n"));
}

function main(): number {
  const dir = process.argv[2];
  if (!dir) {
    printUsage();
    return 1;
  }

  if (!existsSync(dir)) {
    process.stderr.write(`error: directory does not exist: ${dir}\n`);
    return 1;
  }
  if (!statSync(dir).isDirectory()) {
    process.stderr.write(`error: not a directory: ${dir}\n`);
    return 1;
  }

  const present: string[] = [];
  const missing: string[] = [];
  for (const fn of SWING_FILENAMES) {
    if (existsSync(join(dir, fn))) {
      present.push(fn);
    } else {
      missing.push(fn);
    }
  }

  process.stdout.write(
    `IMU swing-trace offline analyzer — Phase 4 Step 0 diagnostic\n` +
      `  dir: ${dir}\n` +
      `  constants: FIRST_K_SAMPLES=${FIRST_K_SAMPLES}, PERCENTILE=${PERCENTILE}\n` +
      `  found ${present.length} of 5 expected files` +
      (missing.length > 0 ? `; missing: ${missing.join(", ")}` : "") +
      `\n\n`,
  );

  for (const fn of present) {
    analyzeFile(dir, fn);
  }

  process.stdout.write(
    `--- end of session ---\n` +
      `Reminder: the two baseline numbers and their peak-to-baseline ratios\n` +
      `above are DIAGNOSTICS for operator inspection. The Step 0 STOP-or-\n` +
      `proceed call is made by the operator's eye across all 5 swings. The\n` +
      `constants FIRST_K_SAMPLES=${FIRST_K_SAMPLES} and PERCENTILE=${PERCENTILE} are\n` +
      `themselves what Step 0 informs — they are starting values, not\n` +
      `calibrated picks.\n`,
  );

  return 0;
}

process.exit(main());
