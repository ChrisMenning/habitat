---
applyTo: "js/nesting.js,js/map.js,js/config.js,js/app.js,serve.js"
---

# InVEST Pollination Model — Bay Hive Implementation Reference

## Overview

Bay Hive implements a **client-side JavaScript approximation** of the Lonsdorf et al. (2009)
pollinator abundance model (formalized in the InVEST Crop Pollination User's Guide by the
Natural Capital Project). This is NOT a call to an external InVEST API — it is a from-scratch
JS implementation of the same equations.

**Canonical documentation:**
https://storage.googleapis.com/releases.naturalcapitalproject.org/invest-userguide/latest/en/croppollination.html

---

## Model Architecture

### Inputs Required by the Real InVEST Model

| Input | Format | Purpose |
|---|---|---|
| LULC raster | Raster | Land use/land cover (NLCD 2021 in our case) |
| Biophysical table | CSV | Per-LULC class: `nesting_[SUBSTRATE]_availability_index`, `floral_resources_[SEASON]_index` |
| Guild table | CSV | Per-species/guild: `nesting_suitability_[SUBSTRATE]_index`, `foraging_activity_[SEASON]_index`, `alpha` (m), `relative_abundance` |

### Bay Hive Data Sources

- **LULC**: NLCD 2021 WMS tiles from `www.mrlc.gov/geoserver` at zoom 13 per grid cell, via `/api/nlcd-nesting`
- **Biophysical table**: Hardcoded JS objects `INVEST_NESTING_GROUND`, `INVEST_NESTING_CAVITY`, `INVEST_FLORAL_SPRING`, `INVEST_FLORAL_SUMMER` in `js/nesting.js` — shared by both layers below, unchanged between them
- **Guild table**: `INVEST_GUILDS` (landscape layer) or `INVEST_GUILDS_URBAN` (urban layer, reweighted — see §Guild Table)
- **Grid**: This model runs as **two separate layers with different grid parameters** — there is no single shared grid:
  | Layer | Function | Grid step | Radius | Guild table |
  |---|---|---|---|---|
  | Landscape Suitability Index | `computeInVESTHeatmap()` | 0.012° ≈ 1.3 km | 15 km (`RADIUS_KM`) | `INVEST_GUILDS` |
  | Urban Habitat Index | `computeInVESTHeatmapUrban()` | 0.006° ≈ 660 m | 12 km (hardcoded) | `INVEST_GUILDS_URBAN` |

  Both call the same `fetchGridNlcdScores(centerLng, centerLat, radiusKm, gridStep)` helper with different arguments. Full urban-specific detail (opportunity rescoring, color ramp, known limitations) is in `invest-urban-methodology.md` — this file covers the shared math both layers are built on.

---

## Core Mathematics

### Pollinator Supply Index PS(x,s) — Eq. 61

```
PS(x, s) = FR(x, s) × HN(x, s) × sa(s)
```

- `FR(x,s)` — accessible floral resources (spatially weighted, normalized exponential kernel)
- `HN(x,s)` — habitat nesting suitability at x for species s
- `sa(s)` — relative species abundance (guild weight, sums to 1 across guilds)

### Floral Resources FR(x,s) — Eq. 62 (normalized exponential kernel)

```
FR(x, s) = Σ_x' [ exp(-D(x,x')/α_s) × Σ_j RA(l(x'),j) × fa(s,j) ]
           ÷ Σ_x' [ exp(-D(x,x')/α_s) ]
```

- `RA(l,j)` — floral resource index for LULC class `l` in season `j`
- `fa(s,j)` — relative foraging activity for species `s` in season `j`
- `α_s` — mean foraging distance for species `s`
- **The denominator normalizes the kernel spatially** — CRITICAL, prevents density bias

**This full kernel is only implemented by `computeInVESTHeatmap()` (landscape layer)** — a real
O(cells²) loop over every cell pair, exactly as above, with the bounding-box/3α cutoff described
in Implementation Notes below.

`computeInVESTHeatmapUrban()` (urban layer) does **not** implement Eq. 62 — it uses each cell's
own floral resource directly, equivalent to a degenerate kernel with weight 1 at distance 0 and 0
everywhere else (`FR(x,s) = RA(l(x),j)`, no neighbor contribution at all). This is a deliberate
performance tradeoff, not an oversight: at the urban layer's finer 660 m grid, the full kernel
would be too slow for interactive use. See `invest-urban-methodology.md` §5 and `computeInVESTHeatmapUrban`'s
header comment in `js/nesting.js` for the reasoning and its consequences (it's part of why the
layer needed the opportunity rescoring described below — see §Urban Opportunity Rescoring).

### Habitat Nesting HN(x,s) — Eq. 63

```
HN(x, s) = max_n [ N(l(x), n) × ns(s, n) ]
```

- `N(l,n)` — nesting substrate availability for LULC `l` in substrate `n` (ground or cavity)
- `ns(s,n)` — nesting preference of guild `s` for substrate `n`
- The `max` over substrates means cavity nesters can dominate in forested areas

---

## Guild Table (Wisconsin-calibrated)

Two variants exist as of 2026-08-24 — `INVEST_GUILDS` for the landscape layer, `INVEST_GUILDS_URBAN`
for the urban layer. They share the same three guilds (alpha unchanged between them) but differ in
substrate preference, seasonal activity, and relative abundance:

**`INVEST_GUILDS`** (landscape layer, `computeInVESTHeatmap`):

| Guild | alpha (km) | ground_pref | cavity_pref | spring_activity | summer_activity | relative_abundance |
|---|---|---|---|---|---|---|
| small_solitary | 0.30 | 0.9 | 0.1 | 0.8 | 1.0 | 0.25 |
| medium_solitary | 0.70 | 0.6 | 0.8 | 1.0 | 0.9 | 0.35 |
| bumble | 1.50 | 0.9 | 0.1 | 0.7 | 1.0 | 0.40 |

**`INVEST_GUILDS_URBAN`** (urban layer, `computeInVESTHeatmapUrban`):

| Guild | alpha (km) | ground_pref | cavity_pref | spring_activity | summer_activity | relative_abundance |
|---|---|---|---|---|---|---|
| small_solitary | 0.30 | 0.8 | 0.3 | 0.7 | 1.0 | 0.40 |
| medium_solitary | 0.70 | 0.6 | 0.8 | 1.0 | 0.9 | 0.45 |
| bumble | 1.50 | 0.9 | 0.1 | 0.8 | 1.0 | 0.15 |

Bumble bee relative abundance drops sharply in the urban table (0.40 → 0.15), with the difference
redistributed to the solitary guilds — see `invest-urban-methodology.md` §2 "Guild Reweighting for
Urban" for the ecological rationale (long-range bumble bees are less constrained by fine-grained
urban patchwork; small/medium solitary bees are better discriminators of urban planting quality).

Sources: Greenleaf et al. 2007 (alpha, body-size allometry); Koh et al. 2016 (nesting preferences, Wisconsin abundance); Walther-Hellwig 2000

---

## Biophysical Tables (NLCD 2021)

### Ground Nesting Suitability (`INVEST_NESTING_GROUND`)

| NLCD | Class | Score |
|---|---|---|
| 11 | Open Water | 0.00 |
| 21 | Developed Open Space | 0.20 |
| 22 | Developed Low | 0.05 |
| 23 | Developed Medium | 0.00 |
| 24 | Developed High | 0.00 |
| 31 | Barren Land | 0.90 |
| 41 | Deciduous Forest | 0.10 |
| 42 | Evergreen Forest | 0.05 |
| 43 | Mixed Forest | 0.10 |
| 52 | Shrub/Scrub | 0.60 |
| 71 | Grassland/Herbaceous | 0.80 |
| 81 | Pasture/Hay | 0.50 |
| 82 | Cultivated Crops | 0.10 |
| 90 | Woody Wetlands | 0.05 |
| 95 | Emergent Wetlands | 0.10 |

### Cavity Nesting Suitability (`INVEST_NESTING_CAVITY`)

Source: Koh et al. 2016 — scores for snag density, wood structure, and stem availability

| NLCD | Score |
|---|---|
| 11 | 0.00 |
| 21 | 0.30 |
| 22 | 0.15 |
| 23 | 0.05 |
| 24 | 0.00 |
| 31 | 0.00 |
| 41 | 0.60 |
| 42 | 0.35 |
| 43 | 0.50 |
| 52 | 0.40 |
| 71 | 0.10 |
| 81 | 0.10 |
| 82 | 0.00 |
| 90 | 0.35 |
| 95 | 0.05 |

### Spring Floral Resources (`INVEST_FLORAL_SPRING`)

Emphasizes early-season bloomers: forest ephemerals, urban open space (dandelion, redbud), wetlands.

| NLCD | Score |
|---|---|
| 11 | 0.00 |
| 21 | 0.45 |
| 22 | 0.20 |
| 23 | 0.08 |
| 24 | 0.00 |
| 31 | 0.02 |
| 41 | 0.50 |
| 42 | 0.05 |
| 43 | 0.30 |
| 52 | 0.40 |
| 71 | 0.60 |
| 81 | 0.50 |
| 82 | 0.15 |
| 90 | 0.40 |
| 95 | 0.55 |

### Summer Floral Resources (`INVEST_FLORAL_SUMMER`)

Emphasizes mid/late summer bloom: native prairie, wetland emergents, shrubs.

| NLCD | Score |
|---|---|
| 11 | 0.00 |
| 21 | 0.35 |
| 22 | 0.12 |
| 23 | 0.03 |
| 24 | 0.00 |
| 31 | 0.08 |
| 41 | 0.15 |
| 42 | 0.12 |
| 43 | 0.15 |
| 52 | 0.80 |
| 71 | 1.00 |
| 81 | 0.40 |
| 82 | 0.25 |
| 90 | 0.30 |
| 95 | 0.70 |

---

## Data Pipeline — Landscape Layer

```
fetchGridNlcdScores(center, RADIUS_KM)   — grid at 0.012° ≈ 1.3 km, 15 km radius, batches to /api/nlcd-nesting
       ↓
/api/nlcd-nesting (serve.js)             — MRLC WMS PNG tile decode → pixel counts per NLCD class per cell
       ↓
computeInVESTHeatmap()                   — biophysical tables × full Eq. 62 kernel × HN(max substrate) × FR normalization
       ↓
updateInVESTHeatmap(geojson)             — pushes GeoJSON to MapLibre 'invest-heat' source
       ↓
heatmap layer (map.js)                   — MapLibre `heatmap` type, radius interpolated by zoom, opacity 0.80
```

~650 cells at this grid/radius. This layer's `weight` is the final value — no further rescoring.

## Data Pipeline — Urban Layer

```
fetchGridNlcdScores(center, 12, 0.006)   — grid at 0.006° ≈ 660 m, 12 km radius (both hardcoded in
                                            app.js's _lazyComputeUrbanInVEST, not named constants)
       ↓
/api/nlcd-nesting (serve.js)             — same tile-decode endpoint as the landscape layer
       ↓
computeInVESTHeatmapUrban()              — biophysical tables × degenerate (no-neighbor) kernel ×
                                            HN(max substrate) × FR normalization → per-cell `quality`
                                            → opportunity = urbanFrac × (1 − quality), re-normalized
                                            → final `weight` (see §Urban Opportunity Rescoring)
       ↓
updateInVESTUrbanHeatmap(geojson)        — pushes GeoJSON to MapLibre 'invest-urban-heat' source
       ↓
circle layer (map.js)                    — MapLibre `circle` type (NOT `heatmap` — see below),
                                            circle-color driven directly by `weight`
```

~1,400 raw grid points, ~870 pass the ≥20% developed filter and appear in the output.

**Why `circle`, not `heatmap`, for the urban layer:** a `heatmap` layer colors by `heatmap-density`,
a kernel-accumulated value summed across every nearby point — appropriate for sparse point clouds,
not a dense regular grid. With ~870 cells packed across the urban core, density saturated to
maximum almost everywhere, regardless of individual cell scores (rendered as one undifferentiated
yellow blob). `circle-color` bound directly to `weight` shows each cell's actual score. The
landscape layer keeps `heatmap` because its grid is sparser relative to its render radius and
doesn't hit this problem. See decisions.md, 2026-08-24, for the full incident writeup.

---

## Urban Opportunity Rescoring

Added 2026-08-24 (see decisions.md for the full investigation). `computeInVESTHeatmapUrban()`
does not stop at the raw Lonsdorf `P(x)` score — an extra step converts it from a *habitat quality*
score to a *planting opportunity* score:

```
quality     = P(x) normalized against the max P(x) among urban cells (urbanFrac ≥ 0.20)
opportunity = urbanFrac × (1 − quality)
weight      = opportunity, re-normalized against the max opportunity among urban cells
```

Both `quality` and `weight` are exposed on each output feature (`properties.quality`,
`properties.weight`); every downstream consumer (map layer, corridor crosswalk, alerts, drawer,
exports) reads `weight`. Rationale: at 660 m with no spatial kernel (see above), a cell's raw
quality is driven entirely by its own land cover. A low-density cell at the city's edge that just
clears the 20% developed threshold but is mostly natural cover scored *higher* than any dense
urban block ever could — ecologically correct, useless for "where should we plant." The
opportunity formula rewards cells that are both genuinely developed and currently low-quality,
without changing the underlying kernel, guild weights, or grid.

The landscape layer has no equivalent rescoring — its `weight` is still raw normalized quality.

---

## Implementation Notes

- The `computeInVESTHeatmap` (landscape) inner loop is O(cells² × guilds) — a real neighbourhood
  kernel. At ~650 cells and 3 guilds this stays fast; use the existing bounding-box pre-filter
  (`|dLng|>cutoff` skip) religiously. For the bumble bee guild (α=1.5 km, cutoff=4.5 km) most
  pairs are culled before the `sqrt`.
- `computeInVESTHeatmapUrban` deliberately skips the O(cells²) kernel entirely (see §Data
  Pipeline — Urban Layer) — at ~870 cells on a finer grid, the full kernel was judged too slow
  for interactive toggling. This is a real accuracy tradeoff, not just a performance one: a
  cell's floral resource no longer reflects its neighbors at all.
- Do NOT skip the kernel normalization denominator (`normSum`) in the landscape layer. Without
  it, edge cells produce systematically biased FR values.
- Grid step should ideally not exceed `alpha_min / 2` = 150 m to avoid undersampling the small
  guild (α=300 m). Neither layer meets this today — landscape is 1.3 km, urban is 660 m, both
  well above the ideal. This is a known, accepted tradeoff for interactive load times, not an
  oversight; do not "fix" by shrinking the grid step without also solving the resulting
  performance cost (see §5 in `invest-urban-methodology.md`).
- The 2% floor (landscape layer only — the urban layer has no floor, see its own doc) is
  intentionally low to preserve faint urban signals within the landscape-scale view.
- `/api/nlcd-nesting` has a 24-hour tile cache in `snapshots/cache/nlcd-nesting/`. On first run
  after a grid resolution change, expect the full 15–60 s (urban) or several-second (landscape)
  fetch again for any newly-touched cells.

---

## References

- Lonsdorf et al. (2009). Modelling pollination services across agricultural landscapes. *Annals of Botany* 103(9): 1589–1600.
- Sharp et al. (2018). InVEST User's Guide. Natural Capital Project.
- Koh et al. (2016). Modeling the status, trends, and impacts of wild bee abundance in the United States. *PNAS* 113(1): 140–145. https://doi.org/10.1073/pnas.1517685113
- Greenleaf et al. (2007). Bee foraging ranges and their relationship to body size. *Oecologia* 153: 589–596.
- Wentling et al. (2021). Landscape-scale factors affecting pollinator community diversity and abundance in the Upper Midwest. *Landscape Ecology*.
