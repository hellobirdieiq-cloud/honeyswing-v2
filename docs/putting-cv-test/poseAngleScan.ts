#!/usr/bin/env npx tsx
// THROWAWAY ANALYSIS — pose joint-pair angles vs human-measured shaft angles
// on fixture 1d8722b8 (putting go/no-go). Read-only; prints a table; never
// ships. DB access mirrors scripts/exportSwingArtSample.mjs (service role
// from .env — anon key is RLS-blocked and returns no row).
//
// LIMITATION (stated per spec): only 10 hand/wrist keypoints survive to
// motion_frames — the adapter drops the other 34 COCO-WholeBody hand points
// (thumb2/3, forefinger2-4, middle, ring, pinky2-4, hand_root) before the DB
// write. This scan covers all 45 pairs of the 10 that exist.
//
// usage: npx tsx docs/putting-cv-test/poseAngleScan.ts

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const SWING_ID = '1d8722b8-618b-4668-baf8-2a90c5aab748';

// Video grid frame f = f * 8.33ms.
const TARGETS = [
  { label: 'f55', ms: 458 },
  { label: 'f114', ms: 950 },
] as const;

// Ground truth (human-measured shaft angle vs vertical, image space,
// + = head-end toward target/right).
const GT_55 = 1.45;
const GT_114 = -16.75;
const GT_ROT = -18.2;

const GATE_DEG = 10; // pass gate on both d55 and d114
const MISS_DEG = 5; // "nearest miss" overshoot window
const MIN_CONF = 0.3;

// LEAD/TRAIL labels: player is right-handed (ball travels +x at impact)
// → LEAD = left-side joints, TRAIL = right-side joints.
const JOINTS: Array<{ label: string; db: string }> = [
  { label: 'LeadWrist', db: 'leftWrist' },
  { label: 'LeadThumb', db: 'leftThumb' },
  { label: 'LeadThumbTip', db: 'leftThumbTip' },
  { label: 'LeadIndex', db: 'leftIndex' },
  { label: 'LeadPinky', db: 'leftPinky' },
  { label: 'TrailWrist', db: 'rightWrist' },
  { label: 'TrailThumb', db: 'rightThumb' },
  { label: 'TrailThumbTip', db: 'rightThumbTip' },
  { label: 'TrailIndex', db: 'rightIndex' },
  { label: 'TrailPinky', db: 'rightPinky' },
];

type Joint = { x: number; y: number; confidence: number };
type Frame = {
  timestampMs: number;
  frameWidth: number;
  frameHeight: number;
  joints: Record<string, Joint | undefined>;
};

// Fold to (-90, +90]: line direction — 180° apart = same angle (operator).
function fold(a: number): number {
  let v = a;
  while (v > 90) v -= 180;
  while (v <= -90) v += 180;
  return v;
}

function diff(a: number, b: number): number {
  return Math.min(90, Math.abs(fold(a - b)));
}

// angle(f) = atan2(B.x - A.x, B.y - A.y) in degrees, PIXEL space (normalized
// coords scaled by frame dims first — normalized space distorts angles).
function pairAngle(a: Joint, b: Joint, w: number, h: number): number {
  return (Math.atan2(b.x * w - a.x * w, b.y * h - a.y * h) * 180) / Math.PI;
}

function fmt(v: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(2);
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const envPath = resolve(root, '.env');
  if (!existsSync(envPath)) throw new Error('.env not found at repo root');
  const env: Record<string, string> = {};
  for (const raw of readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    env[line.slice(0, eq).trim()] = val;
  }
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('EXPO_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env');

  const supabase = createClient(url, key);
  const { data, error } = await supabase
    .from('swings')
    .select('motion_frames')
    .eq('id', SWING_ID)
    .single();
  if (error || !data?.motion_frames) throw new Error(`fetch failed: ${error?.message ?? 'no motion_frames'}`);
  const frames = data.motion_frames as Frame[];
  console.log(`motion_frames: ${frames.length} entries`);
  console.log(
    'LIMITATION: only 10 hand keypoints are persisted — the adapter drops the other 34',
  );
  console.log(
    'COCO-WholeBody hand points (thumb2/3, forefinger2-4, middle, ring, pinky2-4, hand_root)',
  );
  console.log('before DB write. All 45 pairs of the 10 available joints analyzed.\n');

  // Frame alignment: nearest motion_frames entry to each target timestamp.
  const picked = TARGETS.map((t) => {
    let bestIdx = 0;
    for (let i = 1; i < frames.length; i++) {
      if (Math.abs(frames[i].timestampMs - t.ms) < Math.abs(frames[bestIdx].timestampMs - t.ms))
        bestIdx = i;
    }
    const f = frames[bestIdx];
    const off = f.timestampMs - t.ms;
    console.log(
      `${t.label}: target ${t.ms}ms → motion_frames[${bestIdx}] @ ${f.timestampMs.toFixed(2)}ms ` +
        `(offset ${off >= 0 ? '+' : ''}${off.toFixed(2)}ms)${Math.abs(off) > 30 ? '  ⚠️ >30ms off-target' : ''}`,
    );
    if (!f.frameWidth || !f.frameHeight) throw new Error(`${t.label}: frameWidth/Height missing`);
    return f;
  });
  const [fA, fB] = picked;
  console.log(`frame dims: ${fA.frameWidth}x${fA.frameHeight}\n`);

  // Joint gate: confidence > 0.3 at BOTH frames.
  const usable: typeof JOINTS = [];
  const excluded: string[] = [];
  console.log('joint confidences (f55 / f114):');
  for (const j of JOINTS) {
    const a = fA.joints[j.db];
    const b = fB.joints[j.db];
    const ca = a?.confidence ?? 0;
    const cb = b?.confidence ?? 0;
    const ok = ca > MIN_CONF && cb > MIN_CONF;
    console.log(
      `  ${j.label.padEnd(13)} ${ca.toFixed(3)} / ${cb.toFixed(3)}  ${ok ? 'ok' : 'EXCLUDED'}`,
    );
    if (ok) usable.push(j);
    else excluded.push(j.label);
  }
  if (excluded.length) {
    const dead = JOINTS.length - 1; // pairs lost per excluded joint vs full set is overlapping; report exact count below
    void dead;
    console.log(`\nexcluded joints: ${excluded.join(', ')}`);
    const totalPairs = (JOINTS.length * (JOINTS.length - 1)) / 2;
    const usablePairs = (usable.length * (usable.length - 1)) / 2;
    console.log(`pairs killed by exclusions: ${totalPairs - usablePairs} of ${totalPairs}`);
  } else {
    console.log('\nno joints excluded — all 45 pairs tested');
  }

  // All unordered pairs of usable joints.
  type Row = {
    pair: string;
    a55: number;
    a114: number;
    d55: number;
    d114: number;
    rot: number;
    rotErr: number;
  };
  const rows: Row[] = [];
  for (let i = 0; i < usable.length; i++) {
    for (let k = i + 1; k < usable.length; k++) {
      const A = usable[i];
      const B = usable[k];
      const a55 = fold(pairAngle(fA.joints[A.db]!, fA.joints[B.db]!, fA.frameWidth, fA.frameHeight));
      const a114 = fold(pairAngle(fB.joints[A.db]!, fB.joints[B.db]!, fB.frameWidth, fB.frameHeight));
      const d55 = diff(a55, GT_55);
      const d114 = diff(a114, GT_114);
      const rot = fold(a114 - a55);
      rows.push({
        pair: `${A.label}–${B.label}`,
        a55,
        a114,
        d55,
        d114,
        rot,
        rotErr: Math.abs(rot - GT_ROT),
      });
    }
  }

  const pass = rows.filter((r) => r.d55 <= GATE_DEG && r.d114 <= GATE_DEG);
  pass.sort((x, y) => x.rotErr - y.rotErr);

  const header = 'PAIR | ang@55 | ang@114 | d55 | d114 | pairRot | rotErr';
  console.log(`\n=== PASSING PAIRS (d55 ≤ ${GATE_DEG} AND d114 ≤ ${GATE_DEG}), sorted by rotErr ===`);
  console.log(header);
  if (pass.length === 0) {
    console.log('(none)');
  } else {
    for (const r of pass) {
      console.log(
        `${r.pair.padEnd(28)} | ${fmt(r.a55).padStart(7)} | ${fmt(r.a114).padStart(7)} | ` +
          `${r.d55.toFixed(2).padStart(5)} | ${r.d114.toFixed(2).padStart(5)} | ` +
          `${fmt(r.rot).padStart(7)} | ${r.rotErr.toFixed(2).padStart(6)}`,
      );
    }
  }

  // Nearest misses: exactly ONE gate failed, overshoot < 5°.
  const misses = rows
    .filter((r) => {
      const f55Fail = r.d55 > GATE_DEG;
      const f114Fail = r.d114 > GATE_DEG;
      if (f55Fail === f114Fail) return false; // both pass or both fail
      const overshoot = f55Fail ? r.d55 - GATE_DEG : r.d114 - GATE_DEG;
      return overshoot < MISS_DEG;
    })
    .sort((x, y) => {
      const ox = Math.max(x.d55, x.d114) - GATE_DEG;
      const oy = Math.max(y.d55, y.d114) - GATE_DEG;
      return ox - oy;
    })
    .slice(0, 5);
  console.log(`\n=== 5 NEAREST MISSES (one gate failed by <${MISS_DEG}°) ===`);
  console.log(header);
  if (misses.length === 0) console.log('(none)');
  for (const r of misses) {
    console.log(
      `${r.pair.padEnd(28)} | ${fmt(r.a55).padStart(7)} | ${fmt(r.a114).padStart(7)} | ` +
        `${r.d55.toFixed(2).padStart(5)} | ${r.d114.toFixed(2).padStart(5)} | ` +
        `${fmt(r.rot).padStart(7)} | ${r.rotErr.toFixed(2).padStart(6)}`,
    );
  }

  const best = pass[0];
  console.log(
    `\npairs tested: ${rows.length} / passing: ${pass.length} / best: ` +
      (best
        ? `${best.pair} (rotErr ${best.rotErr.toFixed(2)}°, d55 ${best.d55.toFixed(2)}°, d114 ${best.d114.toFixed(2)}°)`
        : 'NONE — no pair tracks the shaft within the gates'),
  );

  // Zero-pass fallback: all pairs sorted by (d55 + d114).
  if (pass.length === 0) {
    console.log(`\n=== FALLBACK: all ${rows.length} pairs sorted by (d55 + d114) ===`);
    console.log(header + ' | d55+d114');
    for (const r of [...rows].sort((x, y) => x.d55 + x.d114 - (y.d55 + y.d114))) {
      console.log(
        `${r.pair.padEnd(28)} | ${fmt(r.a55).padStart(7)} | ${fmt(r.a114).padStart(7)} | ` +
          `${r.d55.toFixed(2).padStart(5)} | ${r.d114.toFixed(2).padStart(5)} | ` +
          `${fmt(r.rot).padStart(7)} | ${r.rotErr.toFixed(2).padStart(6)} | ${(r.d55 + r.d114).toFixed(2).padStart(8)}`,
      );
    }
  }
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
