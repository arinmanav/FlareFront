"""Export fixed-size scientific figures from the dashboard's observed counts."""

import argparse
import calendar
from collections import defaultdict
from datetime import date, timedelta
import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
from matplotlib import colors, font_manager, pyplot as plt
import numpy as np
from PIL import Image


YEARS = tuple(range(2001, 2026))
HEATMAP_SIZE = (7.16, 5.37)
LINE_SIZE = (7.16, 3.58)
DPI = 600
SENSORS = {"terra": ("Terra", "#426c99"), "aqua": ("Aqua", "#22867d"),
           "snpp": ("S-NPP", "#df6b25")}


def number(value, context):
    if value is None:
        return np.nan
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{context}: expected a nonnegative number or null")
    if not math.isfinite(value) or value < 0:
        raise ValueError(f"{context}: expected a finite nonnegative number")
    return float(value)


def load_data(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    months = {}
    for row in data["months"]:
        key = (row["year"], row["month"])
        if key in months:
            raise ValueError(f"Duplicate month: {key}")
        for field in ("main", *SENSORS):
            number(row[field], f"{key} {field}")
        months[key] = row
    expected = {(year, month) for year in YEARS for month in range(1, 13)}
    if set(months) != expected:
        raise ValueError("Monthly data must contain each month of 2001–2025 exactly once")
    return data, months


def plot_style():
    font = font_manager.findfont(font_manager.FontProperties(family="Arial", style="normal",
                                                          weight="normal"),
                                 fallback_to_default=False)
    if font_manager.FontProperties(fname=font).get_name() != "Arial":
        raise RuntimeError(f"Arial Regular could not be resolved: {font}")
    return {"font.family": "Arial", "font.weight": "normal", "font.size": 10,
            "axes.labelsize": 11, "axes.labelweight": "normal", "xtick.labelsize": 10,
            "ytick.labelsize": 10, "legend.fontsize": 9, "axes.edgecolor": "black",
            "axes.linewidth": 1.2, "axes.grid": False, "figure.facecolor": "white",
            "axes.facecolor": "white", "savefig.facecolor": "white",
            "svg.fonttype": "path", "savefig.bbox": None}


def frame(ax):
    for spine in ax.spines.values():
        spine.set_visible(True)
        spine.set_color("black")
        spine.set_linewidth(1.2)
    ax.grid(False)


def export(fig, output_dir, name):
    png = output_dir / f"{name}.png"
    svg = output_dir / f"{name}.svg"
    fig.savefig(png, dpi=DPI)
    fig.savefig(svg, dpi=DPI)
    expected_pixels = tuple(round(size * DPI) for size in fig.get_size_inches())
    with Image.open(png) as image:
        if image.size != expected_pixels:
            raise RuntimeError(f"Unexpected PNG dimensions: {image.size}")
        png_dpi = image.info.get("dpi")
        if png_dpi is None or any(abs(value - DPI) > 0.1 for value in png_dpi):
            raise RuntimeError(f"Unexpected PNG DPI: {png_dpi}")
    root = ET.parse(svg).getroot()
    if root.findall(".//{http://www.w3.org/2000/svg}image"):
        raise RuntimeError(f"Raster content found in vector figure: {svg}")
    report = {"png": str(png.resolve()), "svg": str(svg.resolve()),
              "pixels": expected_pixels, "dpi": png_dpi,
              "svg_width": root.attrib["width"], "svg_height": root.attrib["height"],
              "svg_embedded_images": 0}
    plt.close(fig)
    return report


def heatmap(months):
    values = np.array([[number(months[(year, month)]["main"], "main")
                        for month in range(1, 13)] for year in YEARS])
    cmap = colors.LinearSegmentedColormap.from_list(
        "detections", ["#fcf1dc", "#f4c690", "#e79249", "#cc5b21", "#73321b"])
    cmap.set_bad("#d9d9d9")
    fig, ax = plt.subplots(figsize=HEATMAP_SIZE)
    fig.subplots_adjust(left=0.12, bottom=0.12, right=0.81, top=0.97)
    maximum = float(np.nanmax(values))
    norm = colors.FuncNorm((np.log1p, np.expm1), vmin=0, vmax=maximum or 1)
    mesh = ax.pcolormesh(np.arange(13), np.arange(26), np.ma.masked_invalid(values),
                         cmap=cmap, norm=norm, shading="flat", rasterized=False,
                         edgecolors="none")
    ax.set(xticks=np.arange(12) + 0.5,
           xticklabels=[calendar.month_abbr[month] for month in range(1, 13)],
           yticks=np.arange(25) + 0.5, yticklabels=YEARS, xlabel="Month", ylabel="Year",
           xlim=(0, 12), ylim=(25, 0))
    frame(ax)
    color_ax = fig.add_axes((0.84, 0.12, 0.025, 0.85))
    bar = fig.colorbar(mesh, cax=color_ax)
    ticks = [value for value in [0, 1, 3, 10, 30, 100, 300, 1000, 3000]
             if value < maximum * 0.8] + [maximum]
    bar.set_ticks(ticks, labels=[f"{value:g}" if value != maximum else f"{value:.1f}" for value in ticks])
    bar.set_label("Terra-Equivalent Detections\n(Logarithmic Color Scale)", fontsize=11)
    bar.ax.tick_params(labelsize=10)
    bar.outline.set_linewidth(1.2)
    bar.solids.set_rasterized(False)
    # Overlap colorbar segments to avoid seams in SVG viewers.
    bar.solids.set_edgecolor("face")
    return fig


def weekly_trend(data):
    start, end = date(2025, 1, 1), date(2025, 1, 31)
    daily = {}
    for row in data["daily"]:
        day = date.fromisoformat(row["date"])
        if start <= day <= end:
            if day in daily:
                raise ValueError(f"Duplicate daily observation: {day}")
            daily[day] = number(row["main"], f"{day} main")
    expected = {start + timedelta(days=offset) for offset in range(31)}
    if set(daily) != expected:
        raise ValueError("January 2025 requires exactly 31 daily rows")
    bins = defaultdict(list)
    for day, value in sorted(daily.items()):
        bins[day - timedelta(days=day.weekday())].append(value)
    weeks = sorted(bins)
    # Edge bins contain only dates inside January; missing days invalidate a bin.
    values = [sum(bins[week]) if all(np.isfinite(bins[week])) else np.nan for week in weeks]
    fig, ax = plt.subplots(figsize=LINE_SIZE)
    fig.subplots_adjust(left=0.13, right=0.97, bottom=0.22, top=0.96)
    ax.plot(weeks, values, color="#8054a6", linewidth=2)
    ax.set(xlabel="Week Starting (UTC)", ylabel="Terra-Equivalent Detections")
    ax.set_xticks(weeks)
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%d %b %Y"))
    ax.set_ylim(bottom=0)
    frame(ax)
    return fig


def annual_comparison(months):
    fig, ax = plt.subplots(figsize=LINE_SIZE)
    fig.subplots_adjust(left=0.13, right=0.97, bottom=0.20, top=0.96)
    for sensor, (label, color) in SENSORS.items():
        annual = []
        for year in YEARS:
            values = [number(months[(year, month)][sensor], f"{year} {sensor}")
                      for month in range(1, 13)]
            # Retain reported partial first-year totals; all-unavailable years stay gaps.
            reported = [value for value in values if np.isfinite(value)]
            annual.append(sum(reported) if reported else np.nan)
        ax.plot(YEARS, annual, color=color, linewidth=2, label=label)
    ax.set(xlabel="Year", ylabel="Raw Detections", xlim=(2001, 2025), ylim=(0, None))
    ax.set_xticks([2001, 2005, 2010, 2015, 2020, 2025])
    legend = ax.legend(loc="upper left", fancybox=False, framealpha=1, facecolor="white",
                       edgecolor="#444444", borderpad=0.5)
    legend.get_frame().set_linewidth(0.6)
    frame(ax)
    return fig


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--preview", action="store_true",
                        help="Export only the representative monthly heatmap")
    args = parser.parse_args()
    data, months = load_data(args.data)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    with plt.rc_context(plot_style()):
        reports = [export(heatmap(months), args.output_dir, "monthly_heatmap")]
        if not args.preview:
            reports.append(export(weekly_trend(data), args.output_dir, "weekly_january_2025"))
            reports.append(export(annual_comparison(months), args.output_dir, "raw_annual_sensors"))
    print(json.dumps(reports, indent=2))


if __name__ == "__main__":
    main()
