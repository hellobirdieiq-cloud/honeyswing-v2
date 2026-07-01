/**
 * testLeadWristImpact.ts — read-only test of a LEAD-hand (leftWrist) impact
 * candidate, fed through the REAL face-on phase assembly via the detectFaceOnPhases
 * `impactOverride` seam (phaseDetectionFaceOn.ts). No production detector edits.
 *
 * Context: the production face-on impact detector keys off rightWrist (the TRAIL
 * hand for a RH golfer) X-rise vs a foot reference — wrong hand + wrong axis — and
 * fails `impact_search_bounds` on 17/50 face_on/RH swings (sweepSwingGates.ts). A naive
 * GLOBAL argMax(leftWrist.y) was already tested and FAILED the zero-regression gate:
 * it lands at address (hands low at setup), breaking detectFaceOnTop's span bound.
 *
 * Candidate here: a 2D-SPEED-BANDED arc-bottom, swept over a velocity threshold T.
 *   speed[f] = ||leftWrist[f] - leftWrist[f-k]||  (k=3 lookback; speed[0..k-1]=0)
 *   peak     = ROBUST max = 95th-percentile speed (sort, index floor(0.95*n))
 *   band     = { f : speed[f] >= T * peak }
 *   candidate impact = the band frame with MAX leftWrist.y (arc bottom; y top-down)
 * Restricting the arc-bottom search to high-speed frames keeps it out of the slow
 * address/finish regions where the global max lands.
 *
 * Sweep T ∈ [0.80, 0.85, 0.90]. For each T the full tally runs (candidate fed through
 * detectFaceOnPhases via impactOverride): recovery on the 17 impact_search_bounds
 * failures, and (mandatory gate) ZERO regression on the current successes. candOrdered
 * = no gate fired AND phases > 0, matching sweepSwingGates.ts's own success definition.
 *
 * Read-only: one SELECT, no DB writes, no detector edits, no file output.
 *
 * Usage:
 *   npx --yes tsx scripts/testLeadWristImpact.ts            # up to 100 swings
 *   npx --yes tsx scripts/testLeadWristImpact.ts --limit 25
 *
 * Env: EXPO_PUBLIC_SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY or
 * EXPO_PUBLIC_SUPABASE_ANON_KEY (read from .env at repo root).
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PoseFrame, PoseSequence } from "../packages/pose/PoseTypes";
import type { SwingTrailPoint } from "../packages/domain/swing/phaseDetection";
import { analyzePoseSequence } from "../packages/domain/swing/analysisPipeline";
import { detectFaceOnPhases } from "../packages/domain/swing/phaseDetectionFaceOn";
import { detectCameraAngleEarly } from "../packages/domain/swing/cameraAngle";
import { vetoAndInterpolateKeypoints } from "../packages/domain/swing/keypointVeto";
import { toCanonicalSequence } from "../packages/domain/swing/canonicalTransform";
import { msPerFrameFromTrail } from "../packages/domain/swing/phaseDetectionShared";

const THRESHOLDS = [0.8, 0.85, 0.9];
const SPEED_LOOKBACK = 3;

// ---------------------------------------------------------------------------
// .env loader (mirrors scripts/sweepSwingGates.ts:49-70)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const ENV_PATH = join(REPO_ROOT, ".env");

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  let text = "";
  try {
    text = readFileSync(ENV_PATH, "utf8");
  } catch {
    return env;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (env[k] === undefined) env[k] = v;
  }
  return env;
}

function parseLimit(argv: string[], fallback: number): number {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    } else if (a.startsWith("--limit=")) {
      const n = Number(a.slice("--limit=".length));
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Mirror of analysisPipeline.ts:126-147 buildTrailPoints (module-local, not
// exported). Verbatim — skips frames missing either wrist. Feeds msPerFrame and
// the trail the dispatcher hands detectFaceOnPhases.
// ---------------------------------------------------------------------------

function buildTrailPoints(sequence: PoseSequence): SwingTrailPoint[] {
  const points: SwingTrailPoint[] = [];
  for (const frame of sequence.frames) {
    const lw = frame.joints.leftWrist;
    const rw = frame.joints.rightWrist;
    if (!lw || !rw) continue;
    points.push({
      x: (lw.x + rw.x) / 2,
      y: (lw.y + rw.y) / 2,
      timestamp: frame.timestampMs,
      leadX: rw.x,   // canonical LEAD = right* (CANONICAL_LEAD); TRAIL = left*
      leadY: rw.y,
      trailX: lw.x,
      trailY: lw.y,
    });
  }
  return points;
}

// ---------------------------------------------------------------------------
// Speed-banded lead-wrist arc-bottom candidate (T-parameterized).
// y normalized top-down (0=top..1=bottom), so arc bottom = MAX y.
// ---------------------------------------------------------------------------

function yTrace(frames: PoseFrame[], joint: "leftWrist" | "rightWrist"): (number | null)[] {
  return frames.map((f) => {
    const j = f.joints[joint];
    return j ? j.y : null;
  });
}

/** 2D leftWrist speed with lookback k; speed[0..k-1]=0; 0 when either frame's joint is null. */
function leadWristSpeed(frames: PoseFrame[], k: number): number[] {
  const n = frames.length;
  const speed = new Array<number>(n).fill(0);
  for (let f = k; f < n; f++) {
    const a = frames[f - k].joints.leftWrist;
    const b = frames[f].joints.leftWrist;
    if (!a || !b) {
      speed[f] = 0;
      continue;
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    speed[f] = Math.sqrt(dx * dx + dy * dy);
  }
  return speed;
}

/** Robust max = 95th-percentile speed (sort asc, index floor(0.95*n)). Avoids a single spike. */
function robustPeak(speed: number[]): number {
  const n = speed.length;
  if (n === 0) return 0;
  const sorted = [...speed].sort((a, b) => a - b);
  const idx = Math.min(Math.floor(0.95 * n), n - 1);
  return sorted[idx];
}

/** Frame in the speed band (speed >= T*peak) with MAX leftWrist.y; null if peak<=0 or band empty. */
function bandedArcBottom(
  speed: number[],
  peak: number,
  leftWristY: (number | null)[],
  T: number,
): number | null {
  if (!(peak > 0)) return null;
  const floor = T * peak;
  let bestIdx: number | null = null;
  let bestY = -Infinity;
  for (let f = 0; f < speed.length; f++) {
    if (speed[f] < floor) continue;
    const y = leftWristY[f];
    if (y == null) continue;
    if (y > bestY) {
      bestY = y;
      bestIdx = f;
    }
  }
  return bestIdx;
}

// ---------------------------------------------------------------------------
// Bucket precedence — mirror sweepSwingGates.ts:186-190.
// ---------------------------------------------------------------------------

function bucketOf(gate: string | null, phasesLength: number): string {
  if (gate != null) return gate;
  if (phasesLength > 0) return "success";
  return "no_gate_empty_phases";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SwingRow {
  id: string;
  created_at: string;
  frame_count: number | null;
  motion_frames: PoseFrame[] | null;
  swing_debug: Record<string, unknown> | null;
}

/** T-independent per-swing prep — computed once, reused across every threshold T. */
interface Prepared {
  swingId: string;
  currentBucket: string;
  crossOk: boolean;
  crossReason: string; // why crossOk failed, or "ok"
  canonical: PoseSequence;
  trail: SwingTrailPoint[];
  msPerFrame: number;
  speed: number[];
  peak: number;
  leftWristY: (number | null)[];
  frameCount: number;
}

/** Per-swing candidate evaluation at one threshold T. */
interface PerSwing {
  swingId: string;
  currentBucket: string;
  crossOk: boolean;
  candImpact: number | null;
  candLen: number;
  candGate: string | null;
  candOrdered: boolean;
}

interface TSummary {
  T: number;
  recovered: number;
  recEligible: number;
  regressions: number;
  regEligible: number;
  pass: boolean;
  noCand: number;
}

// ---------------------------------------------------------------------------
// Evaluate one threshold T over the prepared swings: print its block, return summary.
// ---------------------------------------------------------------------------

function evalThreshold(prepared: Prepared[], T: number): TSummary {
  const perSwing: PerSwing[] = prepared.map((p) => {
    const candImpact = bandedArcBottom(p.speed, p.peak, p.leftWristY, T);
    let candLen = 0;
    let candGate: string | null = null;
    let candOrdered = false;
    if (candImpact != null) {
      const over = detectFaceOnPhases({
        canonical: p.canonical,
        trail: p.trail,
        msPerFrame: p.msPerFrame,
        impactOverride: candImpact,
      });
      candGate = over.fallbackGate;
      candLen = over.phases.length;
      candOrdered = candGate === null && candLen > 0;
    }
    return {
      swingId: p.swingId,
      currentBucket: p.currentBucket,
      crossOk: p.crossOk,
      candImpact,
      candLen,
      candGate,
      candOrdered,
    };
  });

  const eligible = (b: string) =>
    perSwing.filter((s) => s.currentBucket === b && s.crossOk && s.candImpact != null);

  const breakdown = (list: PerSwing[], pred: (s: PerSwing) => boolean) => {
    const m = new Map<string, number>();
    for (const s of list) {
      if (!pred(s)) continue;
      const k = s.candImpact == null ? "(no_candidate)" : String(s.candGate);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  const recoveryCohort = eligible("impact_search_bounds");
  const recovered = recoveryCohort.filter((s) => s.candOrdered);
  const regressionCohort = eligible("success");
  const regressions = regressionCohort.filter((s) => !s.candOrdered);
  const noCand = perSwing.filter((s) => s.crossOk && s.candImpact == null).length;
  const pass = regressions.length === 0;

  // --- T block.
  console.log(`T=${T.toFixed(2)}`);
  console.log(
    `  RECOVERY (impact_search_bounds): ${recovered.length}/${recoveryCohort.length}`,
  );
  const nr = breakdown(recoveryCohort, (s) => !s.candOrdered);
  if (nr.length > 0) {
    console.log(`    not-recovered breakdown:`);
    for (const [g, n] of nr) console.log(`      ${g}: ${n}`);
  }
  console.log(
    `  REGRESSION (success): ${regressions.length} regressed / ${regressionCohort.length} eligible`,
  );
  for (const s of regressions) {
    console.log(`      ${s.swingId}  candImpact=${s.candImpact} → ${s.candGate} (len=${s.candLen})`);
  }
  console.log(`  GATE: regressions=${regressions.length} → ${pass ? "PASS ✓" : "FAIL ✗"}`);
  console.log("");

  return {
    T,
    recovered: recovered.length,
    recEligible: recoveryCohort.length,
    regressions: regressions.length,
    regEligible: regressionCohort.length,
    pass,
    noCand,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error(
      "[testLeadWristImpact] Missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/EXPO_PUBLIC_SUPABASE_ANON_KEY in .env",
    );
    process.exit(1);
  }

  const limit = parseLimit(process.argv.slice(2), 100);
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // Same population as sweepSwingGates.ts (JSONB paths inside swing_debug).
  const { data, error } = await sb
    .from("swings")
    .select("id, created_at, frame_count, motion_frames, swing_debug")
    .eq("swing_debug->>camera_angle", "face_on")
    .eq("swing_debug->>handedness", "right")
    .limit(limit);
  if (error) {
    console.error("Supabase query error:", error.message);
    process.exit(1);
  }

  const rows = (data ?? []) as unknown as SwingRow[];
  const rowsReturned = rows.length;

  const prepared: Prepared[] = [];
  const loadFailures: string[] = [];
  const errored: string[] = [];

  for (const row of rows) {
    const rawFrames = row.motion_frames;
    if (!rawFrames || !Array.isArray(rawFrames) || rawFrames.length === 0) {
      loadFailures.push(row.id);
      continue;
    }

    const isLeftHanded = false; // RH population
    const sequence: PoseSequence = {
      frames: rawFrames,
      source: "rtmw-l-2d-v1",
      metadata: {},
    };

    try {
      // (1) Authoritative current classification (matches sweepSwingGates.ts).
      const result = analyzePoseSequence(sequence, isLeftHanded);
      const currentGate = (result.swing_debug?.fallback_gate as string | null) ?? null;
      const currentPhases = (result.phases ?? []).length;
      const currentBucket = bucketOf(currentGate, currentPhases);

      // (2) Dispatcher-faithful frame prep (analysisPipeline.ts:527-528 + :556,
      //     phaseDetection.ts:134).
      const veto = vetoAndInterpolateKeypoints(sequence.frames);
      const canonical = toCanonicalSequence(
        { ...sequence, frames: veto.cleanedFrames },
        isLeftHanded,
      );
      const frames = canonical.frames;
      const trail = buildTrailPoints(canonical);
      const msPerFrame = msPerFrameFromTrail(trail);
      const earlyAngle = detectCameraAngleEarly(canonical).angle;

      // (3) Faithfulness cross-check: no-override detector must reproduce the
      //     pipeline. If not, the pipeline routed this swing to a different detector
      //     (or recompute diverged) — exclude from tally but still count it.
      const base = detectFaceOnPhases({ canonical, trail, msPerFrame });
      let crossOk = true;
      let crossReason = "ok";
      if (earlyAngle !== "face_on") {
        crossOk = false;
        crossReason = `early_angle=${earlyAngle}`;
      } else if (base.fallbackGate !== currentGate) {
        crossOk = false;
        crossReason = `base_gate=${base.fallbackGate}!=current=${currentGate}`;
      } else if (base.phases.length !== currentPhases) {
        crossOk = false;
        crossReason = `base_len=${base.phases.length}!=current=${currentPhases}`;
      }

      // (4) T-independent candidate inputs: leftWrist speed + robust peak + y trace.
      const speed = leadWristSpeed(frames, SPEED_LOOKBACK);
      const peak = robustPeak(speed);
      const leftWristY = yTrace(frames, "leftWrist");

      prepared.push({
        swingId: row.id,
        currentBucket,
        crossOk,
        crossReason,
        canonical,
        trail,
        msPerFrame,
        speed,
        peak,
        leftWristY,
        frameCount: frames.length,
      });
    } catch (err) {
      console.error(`  ! analyze failed for ${row.id}:`, err instanceof Error ? err.message : err);
      errored.push(row.id);
    }
  }

  // -------------------------------------------------------------------------
  // Header.
  // -------------------------------------------------------------------------
  console.log("");
  console.log("=== testLeadWristImpact (speed-banded arc-bottom, T sweep) ===");
  console.log(`Filter:        swing_debug.camera_angle = "face_on" AND swing_debug.handedness = "right"`);
  console.log(`Candidate:     band = { f : leadWristSpeed[f] >= T * p95(speed) }; impact = argmax_y(band)`);
  console.log(`               speed lookback k=${SPEED_LOOKBACK}; T ∈ [${THRESHOLDS.map((t) => t.toFixed(2)).join(", ")}]`);
  console.log(`--limit:       ${limit}`);
  console.log(`N (returned):  ${rowsReturned}`);
  console.log(`N (analyzed):  ${prepared.length}`);
  console.log("");

  // -------------------------------------------------------------------------
  // Per-T tally blocks.
  // -------------------------------------------------------------------------
  const summaries = THRESHOLDS.map((T) => evalThreshold(prepared, T));

  // -------------------------------------------------------------------------
  // Summary table.
  // -------------------------------------------------------------------------
  console.log("=== SUMMARY ===");
  console.log(`${"T".padEnd(6)}${"recovered".padEnd(14)}${"regressions".padEnd(14)}GATE`);
  console.log(`${"-".repeat(6)}${"-".repeat(14)}${"-".repeat(14)}${"-".repeat(6)}`);
  for (const r of summaries) {
    console.log(
      `${r.T.toFixed(2).padEnd(6)}${`${r.recovered}/${r.recEligible}`.padEnd(14)}${`${r.regressions}/${r.regEligible}`.padEnd(14)}${r.pass ? "PASS" : "FAIL"}`,
    );
  }
  console.log("");

  // -------------------------------------------------------------------------
  // Exclusions — crossOk failures are T-independent (printed once); no-candidate
  // is reported per T so denominators stay honest.
  // -------------------------------------------------------------------------
  const excludedCross = prepared.filter((s) => !s.crossOk);
  console.log("--- EXCLUSIONS ---");
  console.log(`cross-check failed (routing/recompute mismatch, T-independent): ${excludedCross.length}`);
  for (const s of excludedCross) console.log(`  ${s.swingId}  [${s.currentBucket}]  ${s.crossReason}`);
  console.log(
    `no banded candidate (peak<=0 or empty band) per T: ${summaries
      .map((r) => `T${(r.T * 100).toFixed(0)}=${r.noCand}`)
      .join(", ")}`,
  );
  console.log(`load failures: ${loadFailures.length}, analyze errors: ${errored.length} (of ${rowsReturned} returned)`);
  console.log("");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
