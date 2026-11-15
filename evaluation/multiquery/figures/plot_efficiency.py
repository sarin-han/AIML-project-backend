"""Regenerate the ClipCraft efficiency-evaluation figures (speedup charts).

Data: mean of 3 repeats per condition (evaluation/multiquery/results/*_summary.csv).
Usage: python plot_efficiency.py   (writes files next to this script)
"""
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

OUT = Path(__file__).resolve().parent

# ---- measured data (seconds) ----
Q = [1, 5, 10, 20]
BASELINE = [32.3, 161.9, 321.0, 643.3]
FEATURE_CACHE = [32.3, 34.6, 37.5, 42.9]
MULTI_BATCH = [32.3, 32.8, 33.4, 35.1]

U = [1, 2, 5, 10]
NO_SHARED = [32.5, 65.1, 165.5, 327.7]
SHARED = [32.5, 33.6, 37.8, 41.8]

sp_cache = [b / o for b, o in zip(BASELINE, FEATURE_CACHE)]
sp_multi = [b / o for b, o in zip(BASELINE, MULTI_BATCH)]
sp_shared = [b / o for b, o in zip(NO_SHARED, SHARED)]

C_CACHE, C_MULTI, C_SHARED = "#E07B00", "#0B5CAD", "#1B8A5A"
FS = 14
plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": FS,
    "axes.titlesize": FS + 3, "axes.titleweight": "bold",
    "axes.labelsize": FS, "xtick.labelsize": FS - 1, "ytick.labelsize": FS - 1,
    "axes.spines.top": False, "axes.spines.right": False,
    "figure.facecolor": "white", "axes.facecolor": "white",
})
LW, MS = 2.6, 8


def style(ax, xs, ymax):
    ax.set_xticks(xs)
    ax.set_xlim(xs[0] - 0.8, xs[-1] + 2.2)
    ax.set_ylim(0, ymax)
    ax.grid(True, color="#E3E3E3", linewidth=0.8)
    ax.set_axisbelow(True)
    ax.set_ylabel("Speedup (×)")


def line(ax, xs, ys, color, label, marker, last_dy=0):
    ax.plot(xs, ys, color=color, lw=LW, ms=MS, marker=marker, label=label)
    ax.annotate(f"{ys[-1]:.1f}×", (xs[-1], ys[-1]), xytext=(10, last_dy),
                textcoords="offset points", color=color, fontweight="bold",
                fontsize=FS + 2, va="center")


def draw1(ax):
    line(ax, Q, sp_cache, C_CACHE, "Feature Cache", "o")
    style(ax, Q, 18)
    ax.set_xlabel("Number of Queries")
    ax.set_title("Multi-Query Processing", pad=64)
    ax.legend(loc="upper left", frameon=False, fontsize=FS - 1)
    ax.text(0.5, 1.10, "15.0× Faster", transform=ax.transAxes, ha="center",
            fontsize=FS + 4, fontweight="bold", color=C_CACHE)
    ax.text(0.5, 1.03, "643.3s → 42.9s (20 Queries)", transform=ax.transAxes,
            ha="center", fontsize=FS - 2, color="#444444")


def draw2(ax):
    line(ax, U, sp_shared, C_SHARED, "With Shared Cache", "o")
    style(ax, U, 9.5)
    ax.set_xlabel("Number of Users")
    ax.set_title("Shared Feature Caching", pad=64)
    ax.legend(loc="upper left", frameon=False, fontsize=FS - 1)
    ax.text(0.5, 1.10, "7.8× Faster", transform=ax.transAxes, ha="center",
            fontsize=FS + 4, fontweight="bold", color=C_SHARED)
    ax.text(0.5, 1.03, "327.7s → 41.8s (10 Users)", transform=ax.transAxes,
            ha="center", fontsize=FS - 2, color="#444444")


def save_single(draw, name):
    fig, ax = plt.subplots(figsize=(7, 5))
    draw(ax)
    fig.tight_layout()
    fig.savefig(OUT / name, dpi=300, facecolor="white")
    plt.close(fig)


save_single(draw1, "experiment1_speedup.png")
save_single(draw2, "experiment2_speedup.png")

fig, (a1, a2) = plt.subplots(1, 2, figsize=(14, 5.4))
draw1(a1)
draw2(a2)
fig.tight_layout(w_pad=3)
fig.savefig(OUT / "efficiency_evaluation.png", dpi=300, facecolor="white")
fig.savefig(OUT / "efficiency_evaluation.pdf", facecolor="white")
print("speedups:", [round(x, 1) for x in sp_cache], [round(x, 1) for x in sp_multi],
      [round(x, 1) for x in sp_shared])
