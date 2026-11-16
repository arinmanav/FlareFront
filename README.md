# FlareFront

**Compare MODIS and VIIRS hotspot records on a common reference, then explore when and where detections were reported.**

[Open FlareFront](https://flarefront.pages.dev/) | 2001-2025 | Five California Counties | 251,426 Qualifying Observations

## Five Locations, One Reproducible Comparison

Lake, Shasta, Siskiyou, Glenn and Mariposa were selected from all 58 California counties using a fixed training-only screen. Eligible counties need at least 100 Terra detections and 24 positive Terra months during 2013-2019. Forward validation predicts 2016, 2017, 2018 and 2019 using only preceding years. A county must beat both raw VIIRS and a seasonal median baseline; the five lowest normalized errors are shown. There were 41 eligible counties and 39 passers.

The full [58-county screening record](web/data/location-screen.json) retains every score and exclusion. The [selection protocol](analysis/selection_protocol.json) was fixed before screening; county identities were frozen before the 2020-2025 comparisons were calculated. This selected showcase does not establish agreement across all locations. Later-year results remain exploratory.

| County | Forward-Validation MAE / Mean Terra | 2020-2025 Adjusted MAE | Raw VIIRS MAE | Seasonal MAE |
| --- | ---: | ---: | ---: | ---: |
| Lake | 0.173 | 3.213 | 52.736 | 7.403 |
| Shasta | 0.180 | 5.472 | 158.194 | 18.556 |
| Siskiyou | 0.189 | 14.655 | 614.653 | 73.333 |
| Glenn | 0.217 | 7.298 | 159.500 | 21.847 |
| Mariposa | 0.234 | 2.974 | 61.306 | 10.194 |

Later-period errors use the same 72 months per county, in detections per month. Lower is better. Count-ratio calibration beats both baselines in all five counties.

![Five-county Terra and calibrated VIIRS comparison](web/figures/harmonization_ratio_3d.png)

## Explore The Record

- **Fire Calendar:** the selected month's Terra, raw VIIRS and adjusted VIIRS counts appear in a compact table above the calendar and map. The initial view is August 2020 in Lake County, its largest Terra month in the later comparison period.
- **Daily Activity And Trends:** its own month picker and Previous/Next buttons update the calendar, map and weekly totals together. Daily and weekly views use the same raw sensor counts, including when the monthly calendar uses a Terra-equivalent estimate.
- **Long-Term Patterns:** compare monthly means and medians, annual totals with trailing five-year averages, or the twelve-month profiles of any two complete years. One raw sensor is used at a time so the calendar's 2013 source switch does not create a trend.
- **Compare Locations:** rotate a 3D comparison or inspect a 2D agreement plot. Change between raw VIIRS, count ratio and spatial aggregation, with errors and limitations beside the plots.

Harmonized views open by default; the calendar and comparison selectors also expose unharmonized observations. Calendar intensity keeps the warm logarithmic ramp. Harmonization uses gray reference, teal adjusted and amber raw traces; weekly activity uses purple, and long-term comparisons use blue and plum.

Buttons have visible boundaries, keyboard focus and pressed states. Sections expand on demand; numeric calendar values provide a keyboard-accessible alternative to color. Calendar colors follow log(1 + count), using a fixed full-record range per sensor and area. Daily cells retain exact numbers and choose black or white text with at least 4.5:1 contrast.

**Select an area:** draw a rectangle with two clicks or taps, or enter latitude, longitude and a radius of 0.1-100 km. The center must be inside the selected county; the analysis uses the intersection. Custom areas contain raw sensor counts only. County coefficients and validation do not transfer to an arbitrary shape. Escape cancels drawing; Clear Area restores the county record.

CSV downloads follow the selected county, area, month range and sensor. The complete county source tables are also available as losslessly compressed CSV.gz downloads, keeping every Cloudflare asset below 25 MiB. The uncompressed originals remain in this repository. Interactive plots export matching 600 dpi PNG and vector SVG figures using Arial: 7.16 x 5.37 in for calendars and 3D comparisons, 7.16 x 3.58 in for trends and 2D plots.

## What Harmonization Means Here

The common calendar uses Terra MODIS through 2012 and a county-specific coefficient multiplied by Suomi-NPP VIIRS from 2013. Each coefficient is the ratio of total Terra to total VIIRS detections during 2013-2019. Satellite locations and raw observations stay unchanged. Evaluation compares later adjusted counts against Terra, raw VIIRS and the training seasonal baseline.

The spatial experiment groups VIIRS detections into nominal 1 km occupied cells per acquisition group, averages four grid origins, and fits ratio or absolute-error slopes. It does not recreate MODIS pixels or synchronize overpasses. Training selects a spatial absolute-error fit for Lake and a count absolute-error fit for Shasta; the other three retain the ratio. In later years, Lake's selected alternative is worse than the ratio (MAE 3.389 versus 3.213), while Shasta's is slightly better (5.192 versus 5.472). The website calendar retains count-ratio calibration consistently; [all candidate results](web/data/harmonization-study.json) remain available.

See the [spatial protocol](analysis/spatial_harmonization_protocol.json), [NASA VIIRS product description](https://firms.modaps.eosdis.nasa.gov/content/descriptions/FIRMS_VIIRS_Firehotspots.html), and [Schroeder et al. (2014)](https://doi.org/10.1016/j.rse.2013.12.008).

## Historical Patterns And Their Limits

Monthly anomalies compare the selected value with the arithmetic mean of the same month in other eligible years. Missing values and explicitly partial first months are excluded; observed zeros remain. The full county or area record supplies the baseline independently of date filters. Percentages are undefined when the baseline is zero.

Long-term summaries admit only years with twelve reported, non-partial monthly values. Moving averages require five consecutive complete years. Pearson correlation compares monthly counts; [Spearman correlation](https://www.itl.nist.gov/div898/software/dataplot/refman2/ch2/rankcorr.pdf) compares their ranks with average ranks for ties. Constant profiles have undefined correlation. All unique year-pair coefficients are downloadable; pairs share years and are not independent replicates.

For Lake's 2001-2025 Terra record, August has a mean of 66.6 detections but a median of zero. The median year-pair rank correlation is 0.102 across 300 pairs. Extreme seasons strongly affect the average, and a high average does not establish a consistently repeating yearly pattern.

- Hotspots are **satellite detections, not individual fires**, burned area, severity, forecasts or emergency guidance.
- Zero means no qualifying detections were reported. Complete monthly records do not establish observing coverage, cloud-free conditions or absence of fire.
- Counts retain supplied processing labels: MODIS `6.2`, `6.03`, `61.03` and VIIRS CSV version `2`. The archive is not verified as uniform Collection 6.1.
- Qualification uses the Census 2026 county polygon, type 0, MODIS confidence at least 30 or VIIRS nominal/high confidence. Exact location/date/time/satellite duplicates are removed; distinct overpasses remain separate. Dates are UTC.

The original Los Angeles, San Diego, Santa Clara and Sacramento pilot datasets remain in the repository for reproduction. Los Angeles reference figures in the downloads section are labeled separately from the current five-county comparison.

## Run locally

Requires **Node.js 22+**. Data and browser dependencies are bundled; no package installation is required.

```sh
npm run build
npm start
```

Open the local address printed by the server. The build output is `dist/`.

For Cloudflare Pages, connect this GitHub repository, select the `main` branch, set the build command to `npm run build`, and set the output directory to `dist`. Set `NODE_VERSION=22` and `SKIP_DEPENDENCY_INSTALL=true` in the build environment; the static build requires no dependency installation. The project uses [flarefront.pages.dev](https://flarefront.pages.dev); local changes appear there only after a successful GitHub-triggered deployment.

Static asset requests are [free and unlimited](https://developers.cloudflare.com/pages/functions/pricing/); the Free plan allows [500 builds per month](https://developers.cloudflare.com/pages/platform/limits/). This application has no Pages Functions. Scientific data are bundled. The geographic background loads visible map tiles from OpenStreetMap, a separate best-effort service governed by its [tile usage policy](https://operations.osmfoundation.org/policies/tiles/). If tiles fail, the county outline and hotspot data remain available. No offline tile download or prefetch is provided.

## Reproduce the analysis

Python is used for offline preprocessing, validation, and reference figures. Requires **Python 3.12+**, the pinned dependencies in [requirements.txt](requirements.txt), and the original NASA FIRMS annual ZIPs: `modis_2001_all_countries.zip` through `modis_2025_all_countries.zip`, plus `viirs-snpp_2012_all_countries.zip` through `viirs-snpp_2025_all_countries.zip`. Only each archive's `United_States` CSV member is read; originals are unchanged.

To reproduce the county screen and selected datasets from the original archives:

```sh
python -m analysis.screen_regions --source-dir PATH_TO_ARCHIVES --boundary build-data/california-counties-2026.geojson --download-boundaries --staging-root build-data/location-screen --build-selected
python -m analysis.build_spatial_harmonization --output web/data/harmonization-study.json
python -m analysis.harmonization_figures --output-dir web/figures
npm run build
```

The screening report records the exact boundary hash, source-member names, archive CRCs, qualification counts, fold coefficients and selection rule. The original boundary snapshot is Census January 1, 2026; the live Census endpoint can change, so retain the downloaded boundary file when reproducing a release. Filter definitions live in [analysis/config.json](analysis/config.json). Original ZIPs are never modified.

For an already selected registry, `python analysis/build_regions.py --source-dir PATH_TO_ARCHIVES --boundary-root web/data/regions --staging-root build-data/regions --output-root web/data` rebuilds its records using bundled polygons. It does not rerun selection. The original Los Angeles reference can still be rebuilt with `analysis/stage_firms.py` and `analysis/build_data.py`.

### Calibration Benchmarks

The [benchmark protocol](analysis/harmonization_protocol.json) compares the existing ratio with eight alternatives: a recent-training-window ratio, two quarterly adjustments, two solar-day/night adjustments and three regularized Poisson count models. Selection uses expanding training windows ending before each validation year from 2016 through 2019. A replacement must reduce pooled validation MAE by more than 5% without increasing the top-five peak-month MAE by more than 10%; these are engineering selection thresholds, not significance tests. The previously inspected 2020–2025 record is an exploratory benchmark, not an untouched confirmation set.

```sh
python analysis/benchmark_harmonization.py --output-dir build-data/harmonization-benchmark
python -m unittest tests.test_harmonization_benchmark
```

The command reads bundled county records and writes `report.json`, `summary.csv` and `predictions.csv` outside runtime data. Outputs include every candidate, failed fits, source hashes, fitted parameters, validation folds, monthly errors, bias and peak diagnostics. Solar time is approximated from acquisition time and longitude; it does not establish illumination quality or simultaneous observations. Poisson models estimate conditional mean counts and provide no probabilistic uncertainty claim for these overdispersed data.

On the original four-county pilot, training-only selection retained the original ratio in San Diego, Santa Clara and Sacramento. It selected a solar-period adjustment in Los Angeles, whose later-period MAE increases from 4.924891 to 5.142033. These experiments therefore do not replace the website calibration. Selecting a different candidate because it looks best on the already-inspected benchmark would require a new independent evaluation.

```powershell
npm test
.venv\Scripts\python -B -m unittest discover -s tests -p test_analysis.py -v
.venv\Scripts\python analysis/figures.py --data web/data/dashboard.json --output-dir web/figures
```

Set `FLAREFRONT_INPUT_DIR` to the staging directory for the real-data acceptance case outside the original workspace. Reference figures are exported as matching 600 dpi PNG and vector SVG files; Arial Regular is required.

Earlier prediction, allocation and weather/spectral experiments remain in the repository with their source data and tests. They are excluded from the website build. Their outputs do not establish improved forecasting or firefighting outcomes.

## Sources and license

[NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/country/) supplies the MODIS and Suomi-NPP observations. The county geometry comes from [U.S. Census TIGERweb](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer), using the same 2026 boundary for every year.

Background map data is © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). Separate archived research inputs retain their original NWS and NASA EMIT provenance in their data files.

Original application and analysis code is licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) for attribution and third-party terms.

An AI-assisted code editor was used for editting, debugging and documenting the code used in this project.
