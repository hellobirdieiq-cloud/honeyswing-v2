/**
 * READ-ONLY corpus validation for the top re-anchor + median-X-extreme cutover.
 *
 * For every face-on swing (handedness known, swing_start_frame + impact_arcbottom present)
 * it compares the STORED production values (BEFORE = the old top rule, from the DB) against
 * a fresh run of the CURRENT pipeline (AFTER = analyzePoseSequence on the stored frames).
 *
 * Confirms:
 *   1. Ground-truth tops AFTER: e212431b→108, d5084eb5→101, 16c98eeb→85, 3a814184→87.
 *   2. RH thumb-impact non-regression (Δimpact per RH swing; 16c98eeb must stay 112).
 *   3. The 3 rescued captures (0e8df2ce/655f971c/73a32bfb) → 5 phases + non-null score.
 *   4. No NEW gate on any swing that was previously scored.
 *   5. Tempo before/after (downswingMs > 0 for every scored swing).
 *
 * Read-only: only DB .select() + stdout. No DB writes, no file writes.
 *   npx --yes tsx scripts/validateTopReanchor.ts
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PoseFrame, PoseSequence } from "../packages/pose/PoseTypes";
import { analyzePoseSequence } from "../packages/domain/swing/analysisPipeline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(resolve(__dirname, ".."), ".env");

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  let text = "";
  try { text = readFileSync(ENV_PATH, "utf8"); } catch { return env; }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (env[k] === undefined) env[k] = v;
  }
  return env;
}

// Ground truth + cohorts of interest.
const GT_TOP: Record<string, number> = { e212431b: 108, d5084eb5: 101, "16c98eeb": 85, "3a814184": 87 };
const RESCUE = new Set(["0e8df2ce", "655f971c", "73a32bfb"]);

type PhaseLike = { phase?: string; index?: number };
const phaseIdx = (phases: PhaseLike[] | null | undefined, name: string): number | null => {
  const p = (phases ?? []).find((x) => x.phase === name);
  return p && typeof p.index === "number" ? p.index : null;
};
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const s = (v: unknown, w: number) => String(v ?? "—").padEnd(w);
const sr = (v: unknown, w: number) => String(v ?? "—").padStart(w);

type Row = {
  id8: string; hand: string;
  topB: number | null; topA: number | null;
  impB: number | null; impA: number | null; dImp: number | null;
  gateB: string | null; gateA: string | null;
  phB: number | null; phA: number | null;
  tempoB: number | null; tempoA: number | null; dswMsA: number | null;
  scoreB: number | null; scoreA: number | null;
  err?: string;
};

async function main() {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Missing EXPO_PUBLIC_SUPABASE_URL / SUPABASE key in .env");
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // Fetch all face-on swings with known handedness; filter the 32 cohort in JS.
  const { data, error } = await sb
    .from("swings")
    .select("id, motion_frames, swing_debug, phases, tempo_ratio, downswing_ms, score, impact_frame_index")
    .eq("swing_debug->>camera_angle", "face_on")
    .in("swing_debug->>handedness", ["left", "right"]);
  if (error) throw error;

  const rows: Row[] = [];
  for (const sw of data ?? []) {
    const dbg = (sw.swing_debug ?? {}) as Record<string, any>;
    const pr = (dbg.phase_rules ?? {}) as Record<string, any>;
    const ss = n(pr.swing_start_frame);
    const arc = n(pr.impact_arcbottom);
    if (ss == null || arc == null) continue;            // restrict to the 32 cohort
    if (!sw.motion_frames) continue;

    const id8 = String(sw.id).slice(0, 8);
    const hand = dbg.handedness === "left" ? "L" : "R";
    const isLeftHanded = dbg.handedness === "left";
    const beforePhases = (sw.phases ?? []) as PhaseLike[];

    const row: Row = {
      id8, hand,
      topB: phaseIdx(beforePhases, "top"), topA: null,
      impB: phaseIdx(beforePhases, "impact") ?? n(sw.impact_frame_index), impA: null, dImp: null,
      gateB: beforePhases.length === 0 ? (dbg.fallback_gate ?? "(empty)") : null, gateA: null,
      phB: beforePhases.length, phA: null,
      tempoB: n(sw.tempo_ratio), tempoA: null, dswMsA: null,
      scoreB: n(sw.score), scoreA: null,
    };

    try {
      const sequence: PoseSequence = {
        frames: sw.motion_frames as PoseFrame[],
        source: "rtmw-l-2d-v1",
        metadata: {},
      };
      const r = analyzePoseSequence(sequence, isLeftHanded);
      row.topA = phaseIdx(r.phases as PhaseLike[], "top");
      row.impA = phaseIdx(r.phases as PhaseLike[], "impact");
      row.gateA = (r.swing_debug as any)?.fallback_gate ?? null;
      row.phA = r.phases?.length ?? 0;
      row.tempoA = n(r.tempo?.tempoRatio);
      row.dswMsA = n(r.tempo?.downswingMs);
      row.scoreA = n(r.score);
      if (row.impB != null && row.impA != null) row.dImp = row.impA - row.impB;
    } catch (e) {
      row.err = e instanceof Error ? e.message : String(e);
    }
    rows.push(row);
  }

  rows.sort((a, b) => (a.hand === b.hand ? a.id8.localeCompare(b.id8) : a.hand.localeCompare(b.hand)));

  // ── Before/after table ────────────────────────────────────────────────────
  console.log(`\nCorpus: ${rows.length} face-on swings (handedness known, swing_start_frame + impact_arcbottom present)\n`);
  console.log(
    s("id8", 9) + s("H", 2) +
    s("topB", 6) + s("topA", 6) +
    s("impB", 6) + s("impA", 6) + s("Δimp", 6) +
    s("phB", 4) + s("phA", 4) +
    s("tempoB", 8) + s("tempoA", 8) + s("dswMsA", 8) +
    s("scrB", 5) + s("scrA", 5) + "gateB→gateA",
  );
  console.log("─".repeat(108));
  for (const r of rows) {
    const gates = `${r.gateB ?? "ok"}→${r.gateA ?? "ok"}`;
    console.log(
      s(r.id8, 9) + s(r.hand, 2) +
      sr(r.topB, 5) + " " + sr(r.topA, 5) + " " +
      sr(r.impB, 5) + " " + sr(r.impA, 5) + " " + sr(r.dImp, 5) + " " +
      sr(r.phB, 3) + " " + sr(r.phA, 3) + " " +
      sr(r.tempoB, 7) + " " + sr(r.tempoA, 7) + " " + sr(r.dswMsA, 7) + " " +
      sr(r.scoreB, 4) + " " + sr(r.scoreA, 4) + " " +
      (r.err ? `ERR: ${r.err}` : gates),
    );
  }

  // ── Checks ────────────────────────────────────────────────────────────────
  let pass = 0, fail = 0;
  const check = (ok: boolean, label: string) => {
    console.log(`  ${ok ? "✅" : "❌ FAIL"}: ${label}`);
    ok ? pass++ : fail++;
  };
  const byId = (id: string) => rows.find((r) => r.id8 === id);

  console.log(`\n── Check 1: ground-truth tops AFTER ──`);
  for (const [id, want] of Object.entries(GT_TOP)) {
    const r = byId(id);
    check(r != null && r.topA === want, `${id} top_after = ${want} (got ${r?.topA ?? "missing"})`);
  }

  console.log(`\n── Check 2: RH thumb-impact (Δimpact; flag any move; 16c98eeb must stay 112) ──`);
  const rh = rows.filter((r) => r.hand === "R");
  const moved = rh.filter((r) => r.dImp != null && r.dImp !== 0);
  for (const r of rh) {
    if (r.dImp != null && r.dImp !== 0) console.log(`     ⚠ moved: ${r.id8} impact ${r.impB}→${r.impA} (Δ${r.dImp})`);
  }
  check(moved.length === 0, `no RH impact moved (${moved.length} moved${moved.length ? ": " + moved.map((r) => r.id8).join(",") : ""})`);
  const c98 = byId("16c98eeb");
  check(c98 != null && c98.impA === 112, `16c98eeb impact_after = 112 (got ${c98?.impA ?? "missing"})`);

  console.log(`\n── Check 3: rescued captures → 5 phases + non-null score ──`);
  for (const id of RESCUE) {
    const r = byId(id);
    check(r != null && r.phA === 5 && r.scoreA != null,
      `${id}: phases_after=${r?.phA ?? "?"} (want 5), score_after=${r?.scoreA ?? "null"} (want non-null)`);
  }

  console.log(`\n── Check 4: no NEW gate on a previously-scored swing ──`);
  const newlyGated = rows.filter((r) => r.scoreB != null && r.gateA != null);
  for (const r of newlyGated) console.log(`     ⚠ regressed: ${r.id8} was scored, now gated "${r.gateA}"`);
  check(newlyGated.length === 0, `no previously-scored swing newly gated (${newlyGated.length})`);

  console.log(`\n── Check 5: tempo — downswingMs > 0 for every scored-after swing ──`);
  const badTempo = rows.filter((r) => r.scoreA != null && !(r.dswMsA != null && r.dswMsA > 0));
  for (const r of badTempo) console.log(`     ⚠ ${r.id8} scored but downswingMs=${r.dswMsA}`);
  check(badTempo.length === 0, `all scored-after swings have downswingMs>0 (${badTempo.length} bad)`);
  const tempoChanged = rows.filter((r) => r.tempoB != null && r.tempoA != null && r.tempoB !== r.tempoA).length;
  console.log(`     (tempo_ratio changed on ${tempoChanged}/${rows.length} swings — expected, the split rebalances)`);

  console.log(`\n${"═".repeat(55)}\n  Results: ${pass} passed, ${fail} failed\n${"═".repeat(55)}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
