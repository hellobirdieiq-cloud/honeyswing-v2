#!/usr/bin/env python3
"""
Reads exports/faceon-phase-analysis/per-frame-signals.csv and writes one PNG
per swing PER end-of-swing version, into plots/v1/ and plots/v2/.

Bottom chart is E_body (replaces signal3_avg). Top and middle charts unchanged.

Run with the project venv:
    .venv/bin/python3 scripts/plot-faceon-signals.py
"""

import csv
from collections import defaultdict
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

REPO_ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = REPO_ROOT / "exports" / "faceon-phase-analysis" / "per-frame-signals.csv"
PLOTS_ROOT = REPO_ROOT / "exports" / "faceon-phase-analysis" / "plots"
OUT_DIR_V1 = PLOTS_ROOT / "v1"
OUT_DIR_V2 = PLOTS_ROOT / "v2"

PHASE_COLORS = {
    "address": "gray",
    "backswing": "blue",
    "downswing": "orange",
    "forward_swing": "red",
    "finish": "green",
    "unknown": "white",
}
PHASE_ORDER = list(PHASE_COLORS.keys())
PHASE_ALPHA = 0.30


def to_float(x):
    if x == "" or x is None:
        return float("nan")
    try:
        return float(x)
    except ValueError:
        return float("nan")


def phase_runs(rows, phase_col):
    """Yield (start_frame, end_frame_exclusive, phase) for contiguous phase runs."""
    if not rows:
        return
    cur_phase = rows[0][phase_col]
    cur_start = int(rows[0]["frameIndex"])
    for r in rows[1:]:
        idx = int(r["frameIndex"])
        ph = r[phase_col]
        if ph != cur_phase:
            yield (cur_start, idx, cur_phase)
            cur_phase = ph
            cur_start = idx
    last_idx = int(rows[-1]["frameIndex"])
    yield (cur_start, last_idx + 1, cur_phase)


def shade_phases(ax, rows, phase_col):
    for start, end, phase in phase_runs(rows, phase_col):
        color = PHASE_COLORS.get(phase, "white")
        ax.axvspan(start, end, color=color, alpha=PHASE_ALPHA, linewidth=0)


def plot_swing(swing_id, rows, version, out_dir):
    """version is 'v1' or 'v2' — selects which phase_label column drives shading
    and which end_fs marker is reflected."""
    phase_col = f"phase_label_{version}"
    end_fs_col = f"detected_end_forward_swing_frame_{version}"

    frames = [int(r["frameIndex"]) for r in rows]
    rw_x = [to_float(r["rightWrist_x"]) for r in rows]
    th_x = [to_float(r["rightThumb_x"]) for r in rows]
    heel_x = [to_float(r["leftHeel_x"]) for r in rows]
    ankle_x = [to_float(r["leftAnkle_x"]) for r in rows]
    foot_ref = [to_float(r["foot_ref_x"]) for r in rows]
    rw_y = [to_float(r["rightWrist_y"]) for r in rows]
    e_body = [to_float(r["E_body"]) for r in rows]
    fps = rows[0]["fps_estimate"]
    foot_ref_val = next((v for v in foot_ref if v == v), float("nan"))

    end_fs_str = rows[0].get(end_fs_col, "")
    end_fs_disp = end_fs_str if end_fs_str else "—"

    fig, axes = plt.subplots(3, 1, figsize=(12, 9), sharex=True)
    fig.suptitle(
        f"Swing {swing_id[:8]} — {len(rows)} frames @ {fps} fps  ·  {version.upper()} "
        f"(end_fs={end_fs_disp})",
        fontsize=12,
    )

    ax = axes[0]
    shade_phases(ax, rows, phase_col)
    ax.plot(frames, rw_x, color="red", linewidth=1.2, label="rightWrist.x")
    ax.plot(frames, th_x, color="purple", linewidth=1.2, label="rightThumb.x")
    ax.plot(frames, heel_x, color="green", linewidth=1.2, linestyle="--", label="leftHeel.x")
    ax.plot(frames, ankle_x, color="blue", linewidth=1.2, linestyle="--", label="leftAnkle.x")
    if foot_ref_val == foot_ref_val:
        ax.axhline(
            foot_ref_val,
            color="magenta",
            linestyle="--",
            linewidth=1,
            label=f"foot_ref_x={foot_ref_val:.3f}",
        )
    ax.set_ylabel("normalized x")
    ax.legend(loc="upper right", fontsize=8)
    ax.grid(True, alpha=0.3)

    ax = axes[1]
    shade_phases(ax, rows, phase_col)
    ax.plot(frames, rw_y, color="black", linewidth=1.2, label="rightWrist_y")
    ax.set_ylabel("rightWrist_y (image-y, inverted)")
    ax.invert_yaxis()
    ax.legend(loc="upper right", fontsize=8)
    ax.grid(True, alpha=0.3)

    ax = axes[2]
    shade_phases(ax, rows, phase_col)
    ax.plot(frames, e_body, color="black", linewidth=1.2, label="E_body")
    ax.set_ylabel("E_body (composite)")
    ax.set_xlabel("frame")
    ax.legend(loc="upper right", fontsize=8)
    ax.grid(True, alpha=0.3)

    legend_handles = [
        plt.Rectangle((0, 0), 1, 1, color=PHASE_COLORS[p], alpha=PHASE_ALPHA + 0.2)
        for p in PHASE_ORDER
    ]
    fig.legend(
        legend_handles,
        PHASE_ORDER,
        loc="lower center",
        ncol=len(PHASE_ORDER),
        fontsize=9,
        frameon=False,
    )
    fig.tight_layout(rect=[0, 0.04, 1, 0.97])

    out_path = out_dir / f"{swing_id}.png"
    fig.savefig(out_path, dpi=120)
    plt.close(fig)
    return out_path


def clear_dir(d: Path):
    if d.exists():
        for p in d.glob("*.png"):
            p.unlink()


def main():
    if not CSV_PATH.exists():
        raise SystemExit(f"missing {CSV_PATH}; run scripts/export-faceon-phase-analysis.ts first")

    OUT_DIR_V1.mkdir(parents=True, exist_ok=True)
    OUT_DIR_V2.mkdir(parents=True, exist_ok=True)
    clear_dir(OUT_DIR_V1)
    clear_dir(OUT_DIR_V2)

    swings = defaultdict(list)
    with open(CSV_PATH, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            swings[row["swingId"]].append(row)
    if not swings:
        raise SystemExit(f"no rows in {CSV_PATH}")

    for swing_id, rows in swings.items():
        v1_path = plot_swing(swing_id, rows, "v1", OUT_DIR_V1)
        v2_path = plot_swing(swing_id, rows, "v2", OUT_DIR_V2)
        print(f"wrote {v1_path}")
        print(f"wrote {v2_path}")
    print(f"done — {len(swings)} PNGs each in {OUT_DIR_V1} and {OUT_DIR_V2}")


if __name__ == "__main__":
    main()
