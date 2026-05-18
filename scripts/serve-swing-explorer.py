#!/usr/bin/env python3
"""
Interactive Plotly/Dash swing explorer.

Reads exports/faceon-phase-analysis/per-frame-signals.csv and serves a local
web app on localhost:8050.

Usage:
    .venv/bin/python3 scripts/serve-swing-explorer.py

Layout:
    - Dropdown to pick a swing
    - V1 / V2 phase toggle
    - 4 stacked charts sharing the frame x-axis:
        Chart 1: rightWrist.x + rightThumb.x + foot_ref_x
        Chart 2: rightWrist.y (inverted)
        Chart 3: rightWrist_velocity
        Chart 4: E_body
    - Phase background shading + dashed vertical markers at the four phase frames
    - Unified x-axis hover showing frame, timestamp, and all signal values
"""

import csv
from collections import defaultdict
from pathlib import Path

import dash
from dash import Input, Output, dcc, html
import plotly.graph_objects as go
from plotly.subplots import make_subplots

REPO_ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = REPO_ROOT / "exports" / "faceon-phase-analysis" / "per-frame-signals.csv"

PHASE_COLORS = {
    "address": "gray",
    "backswing": "blue",
    "downswing": "orange",
    "forward_swing": "red",
    "finish": "green",
    "unknown": "white",
}
PHASE_ALPHA = 0.18


def to_float(x):
    if x == "" or x is None:
        return float("nan")
    try:
        return float(x)
    except ValueError:
        return float("nan")


def to_int_or_none(x):
    if x == "" or x is None:
        return None
    try:
        return int(x)
    except ValueError:
        return None


def load_csv():
    """Group rows by swingId. Each group is a list of dicts ordered by frameIndex."""
    if not CSV_PATH.exists():
        raise SystemExit(
            f"missing {CSV_PATH}; run `npx tsx scripts/export-faceon-phase-analysis.ts` first"
        )
    swings = defaultdict(list)
    with open(CSV_PATH, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            swings[row["swingId"]].append(row)
    if not swings:
        raise SystemExit(f"no rows in {CSV_PATH}")
    for sid, rows in swings.items():
        rows.sort(key=lambda r: int(r["frameIndex"]))
    return swings


def swing_dropdown_options(swings):
    opts = []
    for sid, rows in swings.items():
        fps = rows[0]["fps_estimate"]
        opts.append(
            {
                "label": f"{sid[:8]} — {fps} fps, {len(rows)} frames",
                "value": sid,
            }
        )
    opts.sort(key=lambda o: o["label"])
    return opts


def phase_runs(rows, phase_col):
    """Yield (start_frame, end_frame_exclusive, phase_name) for contiguous runs."""
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


def build_figure(rows, version):
    """version is 'v1' or 'v2' — selects phase_label_<version> and end_fs marker."""
    phase_col = f"phase_label_{version}"
    end_fs_col = f"detected_end_forward_swing_frame_{version}"

    frames = [int(r["frameIndex"]) for r in rows]
    timestamps = [to_float(r["timestampMs"]) for r in rows]
    rw_x = [to_float(r["rightWrist_x"]) for r in rows]
    th_x = [to_float(r["rightThumb_x"]) for r in rows]
    rw_y = [to_float(r["rightWrist_y"]) for r in rows]
    rw_vel = [to_float(r["rightWrist_velocity"]) for r in rows]
    e_body = [to_float(r["E_body"]) for r in rows]
    foot_refs = [to_float(r["foot_ref_x"]) for r in rows]
    foot_ref_val = next((v for v in foot_refs if v == v), float("nan"))

    fig = make_subplots(
        rows=4,
        cols=1,
        shared_xaxes=True,
        vertical_spacing=0.04,
        subplot_titles=(
            "Hand position X (rightWrist + rightThumb + foot_ref_x)",
            "Wrist height Y (inverted)",
            "Wrist velocity",
            "E_body composite",
        ),
    )

    # Each trace passes timestampMs as customdata so the unified hover shows it.
    cd = [[t] for t in timestamps]

    fig.add_trace(
        go.Scatter(
            x=frames, y=rw_x, mode="lines",
            name="rightWrist.x", line=dict(color="red", width=1.5),
            customdata=cd,
            hovertemplate="rightWrist.x: %{y:.4f}<extra></extra>",
        ),
        row=1, col=1,
    )
    fig.add_trace(
        go.Scatter(
            x=frames, y=th_x, mode="lines",
            name="rightThumb.x", line=dict(color="purple", width=1.5),
            hovertemplate="rightThumb.x: %{y:.4f}<extra></extra>",
        ),
        row=1, col=1,
    )
    if foot_ref_val == foot_ref_val:
        fig.add_hline(
            y=foot_ref_val,
            line=dict(color="magenta", dash="dash", width=1),
            row=1, col=1,
            annotation_text=f"foot_ref_x={foot_ref_val:.3f}",
            annotation_position="top right",
            annotation_font_size=10,
        )

    fig.add_trace(
        go.Scatter(
            x=frames, y=rw_y, mode="lines",
            name="rightWrist.y", line=dict(color="black", width=1.5),
            hovertemplate="rightWrist.y: %{y:.4f}<extra></extra>",
        ),
        row=2, col=1,
    )
    fig.update_yaxes(autorange="reversed", row=2, col=1)

    fig.add_trace(
        go.Scatter(
            x=frames, y=rw_vel, mode="lines",
            name="rightWrist_velocity", line=dict(color="black", width=1.5),
            hovertemplate="rw_velocity: %{y:.5f}<extra></extra>",
        ),
        row=3, col=1,
    )

    fig.add_trace(
        go.Scatter(
            x=frames, y=e_body, mode="lines",
            name="E_body", line=dict(color="black", width=1.5),
            hovertemplate="E_body: %{y:.5f}<extra></extra>",
        ),
        row=4, col=1,
    )

    # An invisible per-frame trace anchored at y=0 of subplot 1 so hover surfaces
    # the timestampMs and frame index even in regions with sparse traces.
    fig.add_trace(
        go.Scatter(
            x=frames, y=[None] * len(frames), mode="markers",
            marker=dict(size=1, opacity=0),
            customdata=cd, showlegend=False,
            hovertemplate="frame %{x} · t=%{customdata[0]:.0f} ms<extra></extra>",
        ),
        row=1, col=1,
    )

    # Phase background shading on every subplot.
    for start, end, phase in phase_runs(rows, phase_col):
        color = PHASE_COLORS.get(phase, "white")
        for r in range(1, 5):
            fig.add_vrect(
                x0=start, x1=end,
                fillcolor=color, opacity=PHASE_ALPHA,
                layer="below", line_width=0,
                row=r, col=1,
            )

    # Vertical phase markers spanning all subplots.
    markers = [
        ("address_start", to_int_or_none(rows[0].get("detected_swing_start_frame", ""))),
        ("top",           to_int_or_none(rows[0].get("detected_top_frame", ""))),
        ("impact",        to_int_or_none(rows[0].get("detected_impact_frame", ""))),
        (f"end_fs_{version}", to_int_or_none(rows[0].get(end_fs_col, ""))),
    ]
    for label, frame in markers:
        if frame is None:
            continue
        # add_vline without row/col spans all subplots in vertical stack
        fig.add_vline(
            x=frame,
            line=dict(color="black", dash="dash", width=1),
            annotation_text=f"{label} f{frame}",
            annotation_position="top",
            annotation_font_size=10,
            annotation_bgcolor="rgba(255,255,255,0.7)",
        )

    fig.update_layout(
        height=950,
        margin=dict(l=60, r=20, t=60, b=40),
        hovermode="x unified",
        showlegend=False,
        plot_bgcolor="white",
    )
    fig.update_xaxes(title_text="frame", row=4, col=1, gridcolor="lightgray")
    for r in range(1, 5):
        fig.update_yaxes(gridcolor="lightgray", row=r, col=1)
        if r != 4:
            fig.update_xaxes(gridcolor="lightgray", row=r, col=1)

    fig.update_yaxes(title_text="normalized x", row=1, col=1)
    fig.update_yaxes(title_text="rightWrist_y", row=2, col=1)
    fig.update_yaxes(title_text="velocity (norm/ms)", row=3, col=1)
    fig.update_yaxes(title_text="E_body", row=4, col=1)
    return fig


# ── Boot ────────────────────────────────────────────────────────────────────
SWINGS = load_csv()
SWING_OPTIONS = swing_dropdown_options(SWINGS)
DEFAULT_SWING = SWING_OPTIONS[0]["value"]

app = dash.Dash(__name__)
app.title = "HoneySwing Explorer"

app.layout = html.Div(
    [
        html.H2("HoneySwing Phase Explorer", style={"marginBottom": "10px"}),
        html.Div(
            [
                html.Label("Swing", style={"marginRight": "8px", "fontWeight": "600"}),
                dcc.Dropdown(
                    id="swing-dropdown",
                    options=SWING_OPTIONS,
                    value=DEFAULT_SWING,
                    clearable=False,
                    style={"width": "440px"},
                ),
                html.Label(
                    "Phases",
                    style={"marginLeft": "32px", "marginRight": "8px", "fontWeight": "600"},
                ),
                dcc.RadioItems(
                    id="version-toggle",
                    options=[
                        {"label": " V1 (capped argmax)  ", "value": "v1"},
                        {"label": " V2 (E_body decel)", "value": "v2"},
                    ],
                    value="v1",
                    inline=True,
                ),
            ],
            style={
                "display": "flex",
                "alignItems": "center",
                "gap": "8px",
                "marginBottom": "12px",
            },
        ),
        dcc.Graph(id="main-graph", config={"displaylogo": False}),
    ],
    style={"fontFamily": "system-ui, -apple-system, sans-serif", "padding": "16px"},
)


@app.callback(
    Output("main-graph", "figure"),
    Input("swing-dropdown", "value"),
    Input("version-toggle", "value"),
)
def update_figure(swing_id, version):
    rows = SWINGS[swing_id]
    return build_figure(rows, version)


if __name__ == "__main__":
    print(f"[explorer] {len(SWINGS)} swings loaded from {CSV_PATH}")
    print("[explorer] serving on http://localhost:8050")
    app.run(host="127.0.0.1", port=8050, debug=False)
