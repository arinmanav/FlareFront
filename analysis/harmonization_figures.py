"""Export county comparisons as matched PNG and vector SVG figures."""

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use('Agg')
from matplotlib import pyplot as plt
from matplotlib.lines import Line2D
import numpy as np

from analysis.figures import export, frame, plot_style


SIZE_3D = (7.16, 5.37)
SIZE_2D = (7.16, 3.58)
COLORS = ['#275b91', '#bb5723', '#55755e', '#7c5d8d', '#a57b24']
HARMONIZATION_COLORS = {'reference': '#59636e', 'raw': '#bc6c00', 'adjusted': '#007f73'}
MARKERS = ['o', 's', 'D', '^', 'v']
METHODS = ('raw', 'ratio', 'spatial_ratio')


def figure_3d(regions, method):
    comparison_color = HARMONIZATION_COLORS['raw' if method == 'raw' else 'adjusted']
    fig = plt.figure(figsize=SIZE_3D)
    ax = fig.add_subplot(projection='3d')
    for index, region in enumerate(regions):
        x = np.arange(len(region['months']))
        y = np.full(len(x), index)
        ax.plot(x, y, [row['terra'] for row in region['months']], color=HARMONIZATION_COLORS['reference'], linewidth=1.8)
        ax.plot(x, y, [row[method] for row in region['months']], color=comparison_color, linewidth=1.8, linestyle='--')
    ax.set(xlabel='Month (UTC)', ylabel='County', zlabel='Detections', xlim=(0, 71), ylim=(-.15, len(regions) - .85))
    ax.set_xticks([0, 12, 24, 36, 48, 60], ['2020', '2021', '2022', '2023', '2024', '2025'])
    ax.set_yticks(range(len(regions)), [region['county'].replace(' County', '') for region in regions])
    ax.set_zlim(bottom=0)
    ax.view_init(elev=24, azim=-58)
    ax.set_box_aspect((1.8, 1.2, .85), zoom=.8)
    ax.grid(False)
    for axis in (ax.xaxis, ax.yaxis, ax.zaxis):
        axis.pane.set_facecolor('white')
        axis.pane.set_edgecolor('#444444')
        axis.pane.set_alpha(1)
        axis.line.set_linewidth(1.2)
    ax.xaxis.labelpad = 12
    ax.yaxis.labelpad = 22
    ax.zaxis.labelpad = 8
    legend = fig.legend(handles=[Line2D([], [], color=HARMONIZATION_COLORS['reference'], lw=1.8, label='Terra MODIS reference'),
        Line2D([], [], color=comparison_color, lw=1.8, ls='--', label='VIIRS observed' if method == 'raw' else 'VIIRS adjusted')],
        loc='upper center', bbox_to_anchor=(.5, .97), ncol=2, frameon=True, fancybox=False, framealpha=1)
    legend.get_frame().set_edgecolor('#444444')
    legend.get_frame().set_linewidth(.6)
    fig.subplots_adjust(left=.02, right=.98, bottom=.06, top=.91)
    return fig


def figure_2d(regions, method):
    fig, ax = plt.subplots(figsize=SIZE_2D)
    maximum = max(max(row['terra'], row[method]) for region in regions for row in region['months'])
    ax.plot([0, maximum], [0, maximum], color='#666666', linestyle='--', linewidth=1.8, label='Equal counts')
    for index, region in enumerate(regions):
        ax.scatter([row['terra'] for row in region['months']], [row[method] for row in region['months']],
                   s=25, color=COLORS[index], marker=MARKERS[index],
                   label=region['county'].replace(' County', ''))
    ax.set(xlabel='Terra MODIS Detections', ylabel='VIIRS Detections' if method == 'raw' else 'VIIRS Terra-Equivalent Detections',
           xlim=(0, maximum * 1.05), ylim=(0, maximum * 1.05))
    frame(ax)
    legend = ax.legend(loc='lower right' if method == 'raw' else 'upper left',
                       frameon=True, fancybox=False, framealpha=1)
    legend.get_frame().set_edgecolor('#444444')
    legend.get_frame().set_linewidth(.6)
    fig.subplots_adjust(left=.12, right=.97, bottom=.2, top=.96)
    return fig


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path, default=Path('web/data/harmonization-study.json'))
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    study = json.loads(args.data.read_text(encoding='utf-8'))
    if not 1 <= len(study['regions']) <= len(COLORS) or any(len(region['months']) != 72 for region in study['regions']):
        raise ValueError('The comparison requires one to five complete county records')
    args.output_dir.mkdir(parents=True, exist_ok=True)
    reports = []
    with plt.rc_context(plot_style()):
        for method in METHODS:
            for view, make_figure in [('3d', figure_3d), ('2d', figure_2d)]:
                figure = make_figure(study['regions'], method)
                reports.append(export(figure, args.output_dir, f'harmonization_{method}_{view}'))
                svg = args.output_dir / f'harmonization_{method}_{view}.svg'
                svg.write_text('\n'.join(line.rstrip() for line in svg.read_text(encoding='utf-8').splitlines()) + '\n', encoding='utf-8')
    print(json.dumps(reports, indent=2))


if __name__ == '__main__':
    main()
