/**
 * validate-phase-rules.ts — Validates the angle-aware phase-detection
 * dispatcher against the 8 swings labelled in
 * docs/HoneySwing_Phase_Detection_Rules.md.
 *
 * Read-only: fetches `motion_frames` from Supabase, runs the dispatcher
 * (via `analyzePoseSequence` for the full canonical → trail → phase
 * pipeline), and prints expected-vs-actual frame indices with a pass/fail
 * verdict at ±3 frame tolerance.
 *
 * Usage:
 *   npx --yes tsx scripts/validate-phase-rules.ts
 *
 * Env: EXPO_PUBLIC_SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY or
 * EXPO_PUBLIC_SUPABASE_ANON_KEY (.env auto-loaded).
 */


import type { PoseFrame, PoseSequence } from "../packages/pose/PoseTypes";
import { analyzePoseSequence } from "../packages/domain/swing/analysisPipeline";

// ---------------------------------------------------------------------------
// Expectations (from rules doc validation tables)
// ---------------------------------------------------------------------------

type PhaseSlot = "swing_start" | "true_address" | "top" | "impact" | "finish";
type Expect = Partial<Record<PhaseSlot, number>>;

interface ValidatedSwing {
  idPrefix: string;
  detector: "dtl" | "face_on";
  note: string;
  expect: Expect;
}

const VALIDATED: ValidatedSwing[] = [
  {
    idPrefix: "a7a310fe",
    detector: "dtl",
    note: "Adult male RH",
    expect: { swing_start: 66 },
  },
  {
    idPrefix: "6ea31cb0",
    detector: "dtl",
    note: "Adult male RH",
    expect: { swing_start: 44 },
  },
  {
    idPrefix: "e4297195",
    detector: "dtl",
    note: "Youth female LH",
    expect: { swing_start: 25 },
  },
  {
    idPrefix: "9148f404",
    detector: "dtl",
    note: "Youth female LH",
    expect: { swing_start: 24 },
  },
  {
    idPrefix: "3b035cd6",
    detector: "face_on",
    note: "Face-on Phase 0–5 N=1",
    expect: { swing_start: 61, top: 86, impact: 105, finish: 124 },
  },
  {
    idPrefix: "c6860ce5",
    detector: "face_on",
    note: "Face-on Phase 0/4/5 N=1",
    expect: { swing_start: 47, impact: 92, finish: 118 },
  },
];

const TOLERANCE_FRAMES = 3;

// Env loader + client come from the shared scaffold (T9-71).
import { loadEnv, makeClient } from "./lib/replayCommon";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtFrame(actual: number | null | undefined, expected: number | undefined): string {
  if (expected == null) return actual == null ? "—" : `${actual} (no expectation)`;
  if (actual == null) return `MISSING (expected ${expected})`;
  const delta = actual - expected;
  const within = Math.abs(delta) <= TOLERANCE_FRAMES;
  const sign = delta >= 0 ? "+" : "";
  const verdict = within ? "✓" : "✗";
  return `${actual} (expected ${expected}, Δ${sign}${delta}) ${verdict}`;
}

function frameIsWithinTolerance(actual: number | null | undefined, expected: number | undefined): boolean {
  if (expected == null) return true;
  if (actual == null) return false;
  return Math.abs(actual - expected) <= TOLERANCE_FRAMES;
}

// ---------------------------------------------------------------------------
// Per-swing validation
// ---------------------------------------------------------------------------

function evaluate(frames: PoseFrame[], spec: ValidatedSwing): {
  passedAll: boolean;
  lines: string[];
} {
  const lines: string[] = [];
  const sequence: PoseSequence = {
    frames,
    source: "validation",
    metadata: { fps: undefined, durationMs: undefined },
  };

  // analyzePoseSequence handles canonicalization + dispatcher.
  // Pass isLeftHanded=true for the validated LH youth swings.
  const isLeftHanded = spec.note.includes("LH");
  const result = analyzePoseSequence(sequence, isLeftHanded);

  const phaseRules = result.swing_debug?.phase_rules;
  const cameraAnglePre = result.swing_debug?.camera_angle_pre;

  lines.push(
    `  camera_angle_pre = ${cameraAnglePre ?? "?"}  detector = ${phaseRules?.detector ?? "?"}  ` +
      `(expected ${spec.detector})`,
  );

  const detectorOk = phaseRules?.detector === spec.detector;
  if (!detectorOk) {
    lines.push(`    ✗ wrong detector path`);
  }

  const phases = result.phases ?? [];
  const topPhase = phases.find((p) => p.phase === "top");
  const impactPhase = phases.find((p) => p.phase === "impact");
  const finishPhase = phases.find((p) => p.phase === "follow_through");

  const actual: Record<PhaseSlot, number | null> = {
    swing_start: phaseRules?.swing_start_frame ?? null,
    true_address: phaseRules?.true_address_frame ?? null,
    top: topPhase?.index ?? null,
    impact: impactPhase?.index ?? null,
    finish: finishPhase?.index ?? null,
  };

  const slots: PhaseSlot[] = ["swing_start", "true_address", "top", "impact", "finish"];
  let passedAll = detectorOk;
  for (const slot of slots) {
    if (spec.expect[slot] == null) continue;
    const ok = frameIsWithinTolerance(actual[slot], spec.expect[slot]);
    passedAll = passedAll && ok;
    lines.push(`    ${ok ? "✓" : "✗"} ${slot.padEnd(13)} ${fmtFrame(actual[slot], spec.expect[slot])}`);
  }

  if (phaseRules) {
    const rel = phaseRules.reliability;
    lines.push(
      `    reliability  ss=${rel.swing_start ?? "—"}  ta=${rel.true_address ?? "—"}  ` +
        `top=${rel.top ?? "—"}  impact=${rel.impact ?? "—"}  finish=${rel.finish ?? "—"}`,
    );
  }

  return { passedAll, lines };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const sb = makeClient(loadEnv());

  let totalSwings = 0;
  let passingSwings = 0;
  let missing = 0;

  for (const spec of VALIDATED) {
    console.log(`\n— ${spec.idPrefix} (${spec.note}) [${spec.detector}] —`);

    // Resolve short ID prefix → full UUID.
    const { data: rows, error: lookupErr } = await sb
      .from("swings")
      .select("id")
      .like("id", `${spec.idPrefix}%`)
      .limit(1);

    if (lookupErr) {
      console.log(`  ✗ lookup failed: ${lookupErr.message}`);
      missing++;
      continue;
    }
    if (!rows || rows.length === 0) {
      console.log(`  ✗ no swing matching prefix in Supabase`);
      missing++;
      continue;
    }
    const fullId = rows[0].id as string;

    const { data, error } = await sb
      .from("swings")
      .select("id, motion_frames")
      .eq("id", fullId)
      .maybeSingle();
    if (error || !data || !data.motion_frames) {
      console.log(`  ✗ fetch failed: ${error?.message ?? "missing motion_frames"}`);
      missing++;
      continue;
    }
    const frames = data.motion_frames as PoseFrame[];
    if (!Array.isArray(frames) || frames.length === 0) {
      console.log(`  ✗ empty motion_frames`);
      missing++;
      continue;
    }

    totalSwings++;
    const { passedAll, lines } = evaluate(frames, spec);
    for (const line of lines) console.log(line);
    if (passedAll) passingSwings++;
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Swings evaluated: ${totalSwings}`);
  console.log(`  Swings passing:   ${passingSwings}`);
  console.log(`  Swings missing:   ${missing}`);
  console.log(`  Tolerance:        ±${TOLERANCE_FRAMES} frames`);
  console.log(`${"═".repeat(60)}`);

  if (passingSwings < totalSwings) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
