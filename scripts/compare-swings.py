#!/usr/bin/env python3
"""
Side-by-side comparison plot of two swings from the existing per-frame-signals.csv.

Layout: 3 rows × 2 columns. Each column = one swing.
  Row 1: rightWrist.x + rightThumb.x + foot_ref_x reference line
  Row 2: rightWrist.y (image-y, inverted)
  Row 3: E_body (composite)

Phase shading uses phase_label_v1 on both.

Usage:
    .venv/bin/python3 scripts/compare-swings.py <left_swing_id> <right_swing_id>

Output: exports/faceon-phase-analysis/plots/compare_<l8>_vs_<r8>.png
"""

import csv
import sys
from collections import defaultdict
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

REPO_ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = REPO_ROOT / "exports" / "faceon-phase-analysis" / "per-frame-signals.csv"
PLOTS_DIR = REPO_ROOT / "exports" / "faceon-phase-analysis" / "plots"

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


def load_swing(swings, swing_id):
    """Find a row group whose swingId starts with the given prefix or matches exactly."""
    if swing_id in swings:
        return swing_id, swings[swing_id]
    matches = [k for k in swings if k.startswith(swing_id)]
    if len(matches) == 1:
        return matches[0], swings[matches[0]]
    if len(matches) == 0:
        raise SystemExit(f"no swing matching {swing_id!r} in {CSV_PATH}")
    raise SystemExit(f"swing prefix {swing_id!r} matches {len(matches)} swings; provide more characters")


def extract_series(rows):
    return {
        "frames": [int(r["frameIndex"]) for r in rows],
        "rw_x": [to_float(r["rightWrist_x"]) for r in rows],
        "th_x": [to_float(r["rightThumb_x"]) for r in rows],
        "foot_ref": [to_float(r["foot_ref_x"]) for r in rows],
        "rw_y": [to_float(r["rightWrist_y"]) for r in rows],
        "e_body": [to_float(r["E_body"]) for r in rows],
        "fps": rows[0]["fps_estimate"],
    }


def plot_column(axes_col, rows, series, swing_id):
    """Populate the 3 axes for one column with this swing's data."""
    foot_ref_val = next((v for v in series["foot_ref"] if v == v), float("nan"))

    # Row 1: rightWrist.x + rightThumb.x + foot_ref_x
    ax = axes_col[0]
    shade_phases(ax, rows, "phase_label_v1")
    ax.plot(series["frames"], series["rw_x"], color="red", linewidth=1.2, label="rightWrist.x")
    ax.plot(series["frames"], series["th_x"], color="purple", linewidth=1.2, label="rightThumb.x")
    if foot_ref_val == foot_ref_val:
        ax.axhline(
            foot_ref_val,
            color="magenta",
            linestyle="--",
            linewidth=1,
            label=f"foot_ref_x={foot_ref_val:.3f}",
        )
    ax.set_title(f"Swing {swing_id[:8]} @ {series['fps']} fps", fontsize=11)
    ax.set_ylabel("normalized x")
    ax.legend(loc="upper right", fontsize=7)
    ax.grid(True, alpha=0.3)

    # Row 2: rightWrist.y (inverted)
    ax = axes_col[1]
    shade_phases(ax, rows, "phase_label_v1")
    ax.plot(series["frames"], series["rw_y"], color="black", linewidth=1.2, label="rightWrist.y")
    ax.set_ylabel("rightWrist_y (inverted)")
    ax.invert_yaxis()
    ax.legend(loc="upper right", fontsize=7)
    ax.grid(True, alpha=0.3)

    # Row 3: E_body
    ax = axes_col[2]
    shade_phases(ax, rows, "phase_label_v1")
    ax.plot(series["frames"], series["e_body"], color="black", linewidth=1.2, label="E_body")
    ax.set_ylabel("E_body (composite)")
    ax.set_xlabel("frame")
    ax.legend(loc="upper right", fontsize=7)
    ax.grid(True, alpha=0.3)


def main():
    if len(sys.argv) != 3:
        raise SystemExit(
            "usage: compare-swings.py <left_swing_id> <right_swing_id>\n"
            "  IDs may be full UUIDs or prefixes (>= 8 chars recommended)"
        )
    left_arg, right_arg = sys.argv[1], sys.argv[2]

    if not CSV_PATH.exists():
        raise SystemExit(f"missing {CSV_PATH}; run scripts/export-faceon-phase-analysis.ts first")

    swings = defaultdict(list)
    with open(CSV_PATH, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            swings[row["swingId"]].append(row)
    if not swings:
        raise SystemExit(f"no rows in {CSV_PATH}")

    left_id, left_rows = load_swing(swings, left_arg)
    right_id, right_rows = load_swing(swings, right_arg)
    left_series = extract_series(left_rows)
    right_series = extract_series(right_rows)

    fig, axes = plt.subplots(3, 2, figsize=(16, 10), sharex="col", sharey="row")
    fig.suptitle(
        f"Comparison: {left_id[:8]} ({len(left_rows)} frames @ {left_series['fps']} fps)"
        f"   vs   {right_id[:8]} ({len(right_rows)} frames @ {right_series['fps']} fps)",
        fontsize=13,
    )

    plot_column([axes[0, 0], axes[1, 0], axes[2, 0]], left_rows, left_series, left_id)
    plot_column([axes[0, 1], axes[1, 1], axes[2, 1]], right_rows, right_series, right_id)

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
    fig.tight_layout(rect=[0, 0.04, 1, 0.96])

    PLOTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = PLOTS_DIR / f"compare_{left_id[:8]}_vs_{right_id[:8]}.png"
    fig.savefig(out_path, dpi=120)
    plt.close(fig)
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
