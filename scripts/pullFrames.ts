/**
 * pullFrames.ts — Pull specific video frames for a swing as PNGs.
 *
 * Downloads the swing's recorded .mov from the `swing-videos` bucket (via a
 * signed URL) and uses ffmpeg to extract individual frames at their real
 * timestamps, so you can eyeball what the pose pipeline saw at a given frame.
 *
 * Usage:
 *   npx --yes tsx scripts/pullFrames.ts <swingId> <frame...>
 *   e.g. npx --yes tsx scripts/pullFrames.ts 9ea9c4cb 113 114 115 116 117
 *
 * <swingId> may be a prefix (resolved against `swings.id`). Frame numbers are
 * 0-based indices into pose_full. fps is read from the swing's real timestamps
 * (never hardcoded). Read-only on the DB. Outputs:
 *   scripts/output/<swingId>.mov                       (cached; re-used if present)
 *   scripts/output/frames/<idPrefix>-f<N>.png
 *
 * Env loader / Supabase client pattern cloned from scripts/dumpPoseFull.ts.
 */

import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Rtmw133Frame } from "../packages/pose/rtmw/Rtmw133Frame";

// ---------------------------------------------------------------------------
// .env loader (mirrors scripts/dumpPoseFull.ts)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const ENV_PATH = join(REPO_ROOT, ".env");
const OUT_DIR = join(REPO_ROOT, "scripts", "output");
const FRAMES_DIR = join(OUT_DIR, "frames");

const SIGNED_URL_TTL_S = 3600; // matches lib/getSwingVideoUrl.ts
const VIDEO_BUCKET = "swing-videos";

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  let text = "";
  try { text = readFileSync(ENV_PATH, "utf8"); } catch { return env; }
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(msg: string): never {
  console.error("[pullFrames] " + msg);
  process.exit(1);
}

/** Confirm ffmpeg is on PATH; clear error if not. */
function assertFfmpeg(): void {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    die(
      "ffmpeg not found on PATH. Install it first, e.g.:\n" +
      "  brew install ffmpeg",
    );
  }
}

/**
 * Real fps for the swing. Prefer pose_full timestamps (most faithful: the
 * actual capture cadence). Fall back to frame_count / duration_ms. Never
 * hardcoded.
 */
function deriveFps(
  poseFull: Rtmw133Frame[] | null,
  frameCount: number | null,
  durationMs: number | null,
): number {
  if (Array.isArray(poseFull) && poseFull.length >= 2) {
    const ts0 = poseFull[0]?.timestampMs;
    const tsN = poseFull[poseFull.length - 1]?.timestampMs;
    const spanMs = (tsN ?? NaN) - (ts0 ?? NaN);
    if (Number.isFinite(spanMs) && spanMs > 0) {
      const fps = ((poseFull.length - 1) * 1000) / spanMs;
      if (Number.isFinite(fps) && fps > 0) return fps;
    }
  }
  if (frameCount && durationMs && durationMs > 0) {
    const fps = (frameCount * 1000) / durationMs;
    if (Number.isFinite(fps) && fps > 0) return fps;
  }
  die("Could not derive fps from pose_full timestamps or frame_count/duration_ms.");
}

type SwingRow = {
  id: string;
  video_storage_path: string | null;
  pose_full: Rtmw133Frame[] | null;
  frame_count: number | null;
  duration_ms: number | null;
};

async function main(): Promise<void> {
  const [idArg, ...frameArgs] = process.argv.slice(2);
  if (!idArg || frameArgs.length === 0) {
    die("Usage: npx tsx scripts/pullFrames.ts <swingId> <frame...>\n" +
        "  e.g. npx tsx scripts/pullFrames.ts 9ea9c4cb 113 114 115 116 117");
  }

  const frames = frameArgs.map((a) => {
    const n = Number(a);
    if (!Number.isInteger(n) || n < 0) die(`Invalid frame number: "${a}" (want a non-negative integer).`);
    return n;
  });

  assertFfmpeg();

  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) die("Missing EXPO_PUBLIC_SUPABASE_URL or key in .env");

  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Resolve full id from prefix. `id` is a uuid column (no LIKE), so pull
  //    the id list and match the prefix in JS, then load the row by exact id.
  const { data: idRows, error: idErr } = await sb.from("swings").select("id");
  if (idErr) die("Supabase error: " + idErr.message);
  const candidates = ((idRows as { id: string }[]) ?? [])
    .map((r) => r.id)
    .filter((id) => id.startsWith(idArg));
  if (candidates.length === 0) die(`No swing matches id prefix "${idArg}".`);
  if (candidates.length > 1) {
    die(`Prefix "${idArg}" is ambiguous (${candidates.length} matches): ` + candidates.join(", "));
  }
  const swingId = candidates[0];

  const { data: rowData, error: rowErr } = await sb
    .from("swings")
    .select("id, video_storage_path, pose_full, frame_count, duration_ms")
    .eq("id", swingId)
    .maybeSingle();
  if (rowErr) die("Supabase error: " + rowErr.message);
  const row = rowData as unknown as SwingRow | null;
  if (!row) die(`Swing row vanished for ${swingId}.`);
  const idPrefix = swingId.slice(0, 8);
  if (!row.video_storage_path) {
    die(`Swing ${swingId} has no video_storage_path (no uploaded video).`);
  }

  const fps = deriveFps(row.pose_full, row.frame_count, row.duration_ms);
  console.log(`[pullFrames] swing ${swingId}`);
  console.log(`[pullFrames]   fps (real): ${fps.toFixed(3)}`);

  // 2. Download the video (skip if already cached).
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(FRAMES_DIR, { recursive: true });
  const movPath = join(OUT_DIR, `${swingId}.mov`);

  if (existsSync(movPath)) {
    console.log(`[pullFrames]   video : cached ${movPath}`);
  } else {
    const { data: signed, error: signErr } = await sb.storage
      .from(VIDEO_BUCKET)
      .createSignedUrl(row.video_storage_path, SIGNED_URL_TTL_S);
    if (signErr || !signed?.signedUrl) {
      die("Failed to create signed URL: " + (signErr?.message ?? "no URL returned"));
    }
    const res = await fetch(signed.signedUrl);
    if (!res.ok) die(`Video download failed: HTTP ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(movPath, buf);
    console.log(`[pullFrames]   video : downloaded ${movPath} (${(buf.length / 1e6).toFixed(2)} MB)`);
  }

  // 3. Extract each frame via ffmpeg at its real timestamp (-ss frame/fps).
  const outPaths: string[] = [];
  for (const n of frames) {
    const tSec = n / fps;
    const outPath = join(FRAMES_DIR, `${idPrefix}-f${n}.png`);
    try {
      execFileSync(
        "ffmpeg",
        ["-y", "-ss", tSec.toFixed(6), "-i", movPath, "-frames:v", "1", outPath],
        { stdio: "ignore" },
      );
    } catch {
      console.error(`[pullFrames]   frame ${n} (t=${tSec.toFixed(3)}s): ffmpeg failed`);
      continue;
    }
    outPaths.push(outPath);
    console.log(`[pullFrames]   frame ${n} (t=${tSec.toFixed(3)}s) -> ${outPath}`);
  }

  if (outPaths.length === 0) die("No frames were extracted.");

  // 4. Open the extracted PNGs.
  try {
    execFileSync("open", outPaths, { stdio: "ignore" });
  } catch {
    console.log("[pullFrames] (could not auto-open; paths printed above)");
  }
}

main();
