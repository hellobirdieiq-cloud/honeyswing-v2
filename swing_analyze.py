#!/usr/bin/env python3
"""
swing_analyze.py  —  DTL phase signal analysis via Supabase REST
Usage: python3 swing_analyze.py <swing_id>

Reads EXPO_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env
No pip installs required — stdlib only.
"""

import sys, os, math, json
import urllib.request, urllib.parse

def load_env():
    env = {}
    if os.path.exists(".env"):
        for line in open(".env"):
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    env.update(os.environ)
    return env

def supabase_query(url, key, table, params):
    qs = urllib.parse.urlencode(params)
    endpoint = f"{url}/rest/v1/{table}?{qs}"
    req = urllib.request.Request(endpoint, headers={
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def analyze(swing_id):
    env = load_env()
    url = env.get("EXPO_PUBLIC_SUPABASE_URL", "").rstrip("/")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY", "")

    if not url or not key:
        print("ERROR: Missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env")
        sys.exit(1)

    params = {
        "id": f"eq.{swing_id}",
        "select": "id,frame_count,duration_ms,phases,phase_source,motion_frames,swing_debug"
    }
    rows = supabase_query(url, key, "swings", params)
    if not rows:
        print(f"Swing {swing_id} not found.")
        sys.exit(1)

    row = rows[0]
    frames = row["motion_frames"]
    phases_raw = row["phases"] or []
    pipeline = {p["phase"]: p["index"] for p in phases_raw}
    debug = row.get("swing_debug") or {}
    ag = debug.get("angle_gating", {})

    print(f"\n=== SWING {swing_id[:8]} ===")
    print(f"frames={row['frame_count']}  duration={row['duration_ms']}ms  "
          f"phase_source={row['phase_source']}  bucket={ag.get('bucket')}  "
          f"cam_raw={debug.get('camera_angle')}")
    print(f"Pipeline: {pipeline}\n")

    t0 = float(frames[0]["timestampMs"])
    S = []
    for i, f in enumerate(frames):
        j = f["joints"]
        lw = j["leftWrist"];  rw = j["rightWrist"]
        lh = j["leftHip"];    rh = j["rightHip"]
        S.append({
            "i":     i,
            "dt":    (float(f["timestampMs"]) - t0) / 1000.0,
            "lw_x":  lw["x"], "lw_y": lw["y"],
            "rw_x":  rw["x"], "rw_y": rw["y"],
            "hip_sp": rh["x"] - lh["x"],
            "wy_mid": (lw["y"] + rw["y"]) / 2,
        })

    for i in range(len(S)):
        if i == 0:
            S[i]["vel"] = 0.0
        else:
            p, c = S[i-1], S[i]
            dt = c["dt"] - p["dt"]
            v = (math.sqrt((c["lw_x"]-p["lw_x"])**2 + (c["lw_y"]-p["lw_y"])**2 +
                           (c["rw_x"]-p["rw_x"])**2 + (c["rw_y"]-p["rw_y"])**2) / dt
                 if dt > 0 else 0.0)
            S[i]["vel"] = v

    print(f"  F   dt_s  lw_x   lw_y  rw_x   rw_y  hip_sp wy_mid   vel   PHASE")
    print("-" * 82)
    for s in S:
        tag = " ".join(ph for ph, pi in pipeline.items() if pi == s["i"])
        marker = " <<" if tag else ""
        print(f"{s['i']:3d} {s['dt']:6.2f} {s['lw_x']:6.4f} {s['lw_y']:6.4f} "
              f"{s['rw_x']:6.4f} {s['rw_y']:6.4f} {s['hip_sp']:+6.4f} "
              f"{s['wy_mid']:6.4f} {s['vel']:6.3f}{marker}  {tag}")

    print("\n=== SIGNAL RANGES ===")
    for col in ("lw_x", "lw_y", "wy_mid", "hip_sp"):
        vals = [s[col] for s in S]
        mn, mx = min(vals), max(vals)
        print(f"  {col:8s}  min={mn:+.4f}@f{vals.index(mn)}  max={mx:+.4f}@f{vals.index(mx)}")

    print("\n=== PIPELINE SNAPSHOTS ===")
    idx_map = {s["i"]: s for s in S}
    for phase, fi in sorted(pipeline.items(), key=lambda x: x[1]):
        if fi in idx_map:
            s = idx_map[fi]
            print(f"  [{fi:3d}] {phase:<12} lw_x={s['lw_x']:.4f} lw_y={s['lw_y']:.4f} "
                  f"hip_sp={s['hip_sp']:+.4f} vel={s['vel']:.3f}")
        else:
            print(f"  [{fi:3d}] {phase:<12} (outside frame range)")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 swing_analyze.py <swing_id>")
        sys.exit(1)
    analyze(sys.argv[1])
