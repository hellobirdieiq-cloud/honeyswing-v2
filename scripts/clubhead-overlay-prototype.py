#!/usr/bin/env python3
"""
Wrist-based clubhead path overlay — research prototype.

Tests whether extending the arm vector (elbow -> wrist) past the wrist by a
constant factor approximates the clubhead well enough to be useful without
training a real tracker.

Run with the project venv:
    .venv/bin/python3 scripts/clubhead-overlay-prototype.py [swing_id]

If no swing_id is given, the most recent swing with both motion_frames and
video_storage_path is used.

Renders to exports/clubhead-overlay/{swing_id}/:
  - overlay.mp4       (frame-by-frame overlay with all 3 variants)
  - trajectory.png    (single static plot over the middle frame)
"""

import os
import sys
from pathlib import Path
from typing import Optional

import cv2
import matplotlib
import numpy as np
import requests

matplotlib.use("Agg")
import matplotlib.pyplot as plt

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = REPO_ROOT / ".env"
OUT_ROOT = REPO_ROOT / "exports" / "clubhead-overlay"
CACHE_ROOT = OUT_ROOT / "_cache"

K_EXTENSION = 4.0           # forearm-multiples; rough shaft+grip / forearm ratio
CONF_RENDER_MIN = 0.20      # skip variant + trail when wrist confidence below this
CONF_DIM_THRESHOLD = 0.5    # below this, draw joint dots dimmer
TRAIL_LEN = 30              # frames of trail kept behind each variant

# Variant colors (BGR for OpenCV)
COLOR_A = (60, 60, 255)     # lead-arm — red
COLOR_B = (60, 220, 60)     # trail-arm — green
COLOR_C = (255, 200, 0)     # midpoint — cyan-ish
COLOR_JOINT = (255, 255, 0) # cyan for joint dots
COLOR_JOINT_DIM = (140, 140, 0)


def load_env() -> dict:
    env = dict(os.environ)
    try:
        text = ENV_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        return env
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, _, v = s.partition("=")
        k, v = k.strip(), v.strip()
        if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
            v = v[1:-1]
        env.setdefault(k, v)
    return env


def supabase_get_json(env: dict, path: str, params: dict) -> list:
    url = env["EXPO_PUBLIC_SUPABASE_URL"].rstrip("/") + path
    key = env.get("SUPABASE_SERVICE_ROLE_KEY") or env["EXPO_PUBLIC_SUPABASE_ANON_KEY"]
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    r = requests.get(url, headers=headers, params=params, timeout=60)
    r.raise_for_status()
    return r.json()


def supabase_download_storage(env: dict, bucket: str, object_path: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        return
    url = f"{env['EXPO_PUBLIC_SUPABASE_URL'].rstrip('/')}/storage/v1/object/{bucket}/{object_path}"
    key = env.get("SUPABASE_SERVICE_ROLE_KEY") or env["EXPO_PUBLIC_SUPABASE_ANON_KEY"]
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    dest.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, headers=headers, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(1 << 16):
                f.write(chunk)


def fetch_swing(env: dict, swing_id: Optional[str]) -> dict:
    if swing_id:
        rows = supabase_get_json(
            env, "/rest/v1/swings",
            {"id": f"eq.{swing_id}", "select": "id,motion_frames,video_storage_path", "limit": 1},
        )
    else:
        rows = supabase_get_json(
            env, "/rest/v1/swings",
            {
                "select": "id,motion_frames,video_storage_path,created_at",
                "motion_frames": "not.is.null",
                "video_storage_path": "not.is.null",
                "order": "created_at.desc",
                "limit": 1,
            },
        )
    if not rows:
        raise SystemExit(f"no swing found (id={swing_id!r})")
    row = rows[0]
    if not row.get("motion_frames"):
        raise SystemExit(f"swing {row['id']} has no motion_frames")
    if not row.get("video_storage_path"):
        raise SystemExit(f"swing {row['id']} has no video_storage_path")
    return row


def joint(frame: dict, name: str):
    j = frame.get("joints", {}).get(name)
    if not j:
        return None
    return j


def xy(j) -> Optional[np.ndarray]:
    if j is None:
        return None
    return np.array([j["x"], j["y"]], dtype=np.float64)


def conf(j) -> float:
    if j is None:
        return 0.0
    return float(j.get("confidence") or 0.0)


def compute_variants(frame: dict):
    """Returns dict of variant_name -> (clubhead_norm_xy or None, used_wrist_conf).
    Skips variant if relevant wrist confidence < CONF_RENDER_MIN.
    """
    le, lw = joint(frame, "leftElbow"), joint(frame, "leftWrist")
    re_, rw = joint(frame, "rightElbow"), joint(frame, "rightWrist")
    lec, lwc, rec, rwc = conf(le), conf(lw), conf(re_), conf(rw)
    out = {"A": (None, lwc), "B": (None, rwc), "C": (None, max(lwc, rwc))}

    # A — lead (left) arm
    if lwc >= CONF_RENDER_MIN and lec >= CONF_RENDER_MIN:
        lwp, lep = xy(lw), xy(le)
        out["A"] = (lwp + (lwp - lep) * K_EXTENSION, lwc)

    # B — trail (right) arm
    if rwc >= CONF_RENDER_MIN and rec >= CONF_RENDER_MIN:
        rwp, rep = xy(rw), xy(re_)
        out["B"] = (rwp + (rwp - rep) * K_EXTENSION, rwc)

    # C — bi-manual midpoint extended along confidence-weighted arm direction
    have_left = lwc >= CONF_RENDER_MIN and lec >= CONF_RENDER_MIN
    have_right = rwc >= CONF_RENDER_MIN and rec >= CONF_RENDER_MIN
    if have_left or have_right:
        if have_left and have_right:
            grip = (xy(lw) + xy(rw)) / 2.0
            dl = xy(lw) - xy(le)
            dr = xy(rw) - xy(re_)
            wl, wr = lwc, rwc
            arm_dir = (dl * wl + dr * wr) / (wl + wr)
        elif have_left:
            grip = xy(lw)
            arm_dir = xy(lw) - xy(le)
        else:
            grip = xy(rw)
            arm_dir = xy(rw) - xy(re_)
        out["C"] = (grip + arm_dir * K_EXTENSION, max(lwc, rwc))
    return out


def to_px(p: np.ndarray, w: int, h: int):
    return int(round(p[0] * w)), int(round(p[1] * h))


def draw_trail(img, trail, color, w, h):
    pts = [t for t in trail if t is not None]
    if len(pts) < 2:
        return
    pixel_pts = [to_px(p, w, h) for p in pts]
    n = len(pixel_pts)
    for i in range(1, n):
        # older segments thinner
        thickness = max(1, int(round(1 + 2 * (i / n))))
        cv2.line(img, pixel_pts[i - 1], pixel_pts[i], color, thickness, cv2.LINE_AA)


def draw_overlay(img, frame_pose, variants, trails, w, h, frame_idx, fps, pose_idx):
    # joint dots: wrists + elbows
    for name in ("leftElbow", "leftWrist", "rightElbow", "rightWrist"):
        j = joint(frame_pose, name)
        if j is None:
            continue
        p = to_px(xy(j), w, h)
        c = conf(j)
        color = COLOR_JOINT if c >= CONF_DIM_THRESHOLD else COLOR_JOINT_DIM
        radius = 5 if c >= CONF_DIM_THRESHOLD else 3
        cv2.circle(img, p, radius, color, -1, cv2.LINE_AA)

    # trails first (so dots draw on top)
    draw_trail(img, trails["A"], COLOR_A, w, h)
    draw_trail(img, trails["B"], COLOR_B, w, h)
    draw_trail(img, trails["C"], COLOR_C, w, h)

    # current clubhead dots
    for key, color in (("A", COLOR_A), ("B", COLOR_B), ("C", COLOR_C)):
        pt, _ = variants[key]
        if pt is None:
            continue
        cv2.circle(img, to_px(pt, w, h), 7, color, -1, cv2.LINE_AA)

    # legend + text
    lwc = conf(joint(frame_pose, "leftWrist"))
    rwc = conf(joint(frame_pose, "rightWrist"))
    legend = [
        (f"video frame {frame_idx}  pose frame {pose_idx}  k={K_EXTENSION}", (255, 255, 255)),
        (f"A lead-arm   lWrist conf {lwc:.2f}", COLOR_A),
        (f"B trail-arm  rWrist conf {rwc:.2f}", COLOR_B),
        (f"C midpoint", COLOR_C),
    ]
    y0 = 20
    for text, color in legend:
        cv2.putText(img, text, (10, y0), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(img, text, (10, y0), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA)
        y0 += 20


def render_overlay_video(video_path: Path, motion_frames: list, out_path: Path) -> dict:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise SystemExit(f"could not open video: {video_path}")
    vw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    vh = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    n_video_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    n_pose = len(motion_frames)

    # Both streams come from the same camera session (frame processor + recorder
    # both consume the live camera feed) but the pose stream is delivered at a
    # much lower rate than the video records at — typically ~30-50 fps pose vs
    # 120 fps video. We assume both span the same time window and map by
    # normalized position. The pose timestamps are monotonic but not zero-based,
    # so we use the pose range as our clock and lerp video frames into it.
    pose_t0 = float(motion_frames[0].get("timestampMs", 0.0))
    pose_t1 = float(motion_frames[-1].get("timestampMs", 0.0))
    pose_duration_ms = pose_t1 - pose_t0
    pose_fps_est = (n_pose - 1) / (pose_duration_ms / 1000.0) if pose_duration_ms > 0 else 0.0
    video_duration_s = n_video_frames / fps if fps > 0 else 0.0

    print(f"  video: {vw}x{vh} @ {fps:.2f} fps, {n_video_frames} frames ({video_duration_s:.2f}s)")
    print(f"  pose:  {n_pose} frames @ ~{pose_fps_est:.1f} fps ({pose_duration_ms/1000:.2f}s span)")

    pose_ts_norm = np.array(
        [(float(f.get("timestampMs", 0.0)) - pose_t0) / pose_duration_ms for f in motion_frames]
    ) if pose_duration_ms > 0 else np.linspace(0, 1, n_pose)

    def nearest_pose_idx(video_frame_idx: int) -> int:
        t_norm = video_frame_idx / max(1, n_video_frames - 1)
        return int(np.argmin(np.abs(pose_ts_norm - t_norm)))

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(str(out_path), fourcc, fps, (vw, vh))

    trails = {"A": [], "B": [], "C": []}
    all_paths = {"A": [], "B": [], "C": []}  # full trajectories for the static PNG
    seen_pose_idx = -1

    fi = 0
    while True:
        ok, img = cap.read()
        if not ok:
            break
        pi = nearest_pose_idx(fi)
        pose = motion_frames[pi]
        variants = compute_variants(pose)
        # only append to all_paths on pose-frame transition so the static PNG
        # has one point per actual pose sample, not per video frame
        if pi != seen_pose_idx:
            for k in trails:
                pt, _ = variants[k]
                all_paths[k].append(pt)
            seen_pose_idx = pi
        for k in trails:
            pt, _ = variants[k]
            trails[k].append(pt)
            if len(trails[k]) > TRAIL_LEN:
                trails[k] = trails[k][-TRAIL_LEN:]
        draw_overlay(img, pose, variants, trails, vw, vh, fi, fps, pi)
        writer.write(img)
        fi += 1

    cap.release()
    writer.release()
    return {
        "video_width": vw,
        "video_height": vh,
        "video_frames": n_video_frames,
        "pose_frames": n_pose,
        "fps": fps,
        "all_paths": all_paths,
    }


def render_trajectory_png(video_path: Path, all_paths: dict, out_path: Path) -> None:
    cap = cv2.VideoCapture(str(video_path))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    middle = max(0, n // 2)
    cap.set(cv2.CAP_PROP_POS_FRAMES, middle)
    ok, frame = cap.read()
    cap.release()
    if not ok:
        raise SystemExit(f"could not read middle frame from {video_path}")
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    h, w = rgb.shape[:2]

    fig, ax = plt.subplots(figsize=(10, 10 * h / w))
    ax.imshow(rgb)
    color_map = {"A": "red", "B": "limegreen", "C": "deepskyblue"}
    label_map = {"A": "A lead-arm", "B": "B trail-arm", "C": "C midpoint"}
    for k, pts in all_paths.items():
        xs, ys = [], []
        for p in pts:
            if p is None:
                xs.append(np.nan); ys.append(np.nan)
            else:
                xs.append(p[0] * w); ys.append(p[1] * h)
        ax.plot(xs, ys, color=color_map[k], linewidth=1.5, label=label_map[k], alpha=0.85)
    ax.set_title(f"Clubhead estimate trajectories (overlaid on frame {middle})")
    ax.legend(loc="upper right")
    ax.set_xlim(0, w); ax.set_ylim(h, 0)
    ax.set_xticks([]); ax.set_yticks([])
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


def main():
    env = load_env()
    if not env.get("EXPO_PUBLIC_SUPABASE_URL"):
        raise SystemExit("EXPO_PUBLIC_SUPABASE_URL not set in .env")

    swing_id = sys.argv[1] if len(sys.argv) > 1 else None
    print(f"fetching swing (id={swing_id or 'most-recent'})...")
    row = fetch_swing(env, swing_id)
    sid = row["id"]
    storage_path = row["video_storage_path"]
    motion_frames = row["motion_frames"]
    print(f"swing {sid}: {len(motion_frames)} pose frames; video {storage_path}")

    out_dir = OUT_ROOT / sid
    out_dir.mkdir(parents=True, exist_ok=True)
    cached_video = CACHE_ROOT / f"{sid}.mov"
    print(f"downloading video -> {cached_video}")
    supabase_download_storage(env, "swing-videos", storage_path, cached_video)

    overlay_path = out_dir / "overlay.mp4"
    print(f"rendering overlay -> {overlay_path}")
    summary = render_overlay_video(cached_video, motion_frames, overlay_path)

    traj_path = out_dir / "trajectory.png"
    print(f"rendering trajectory png -> {traj_path}")
    render_trajectory_png(cached_video, summary["all_paths"], traj_path)

    print("done")
    print(f"  {overlay_path}")
    print(f"  {traj_path}")


if __name__ == "__main__":
    main()
