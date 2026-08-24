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
- **Biophysical table**: Hardcoded JS objects `INVEST_NESTING_GROUND`, `INVEST_NESTING_CAVITY`, `INVEST_FLORAL_SPRING`, `INVEST_FLORAL_SUMMER` in `js/nesting.js`
- **Guild table**: Hardcoded `INVEST_GUILDS` array with α, substrate preferences, seasonal activity weights, and relative abundance
- **Grid**: Uniform spacing (~330 m) within 15 km radius of Green Bay center (44.5133 N, −88.0133 W)

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

### Habitat Nesting HN(x,s) — Eq. 63

```
HN(x, s) = max_n [ N(l(x), n) × ns(s, n) ]
```

- `N(l,n)` — nesting substrate availability for LULC `l` in substrate `n` (ground or cavity)
- `ns(s,n)` — nesting preference of guild `s` for substrate `n`
- The `max` over substrates means cavity nesters can dominate in forested areas

---

## Guild Table (Wisconsin-calibrated)

| Guild | alpha (m) | ground_pref | cavity_pref | spring_activity | summer_activity | relative_abundance |
|---|---|---|---|---|---|---|
| small_solitary | 300 | 0.8 | 0.3 | 0.7 | 1.0 | 0.25 |
| medium_solitary | 700 | 0.6 | 0.8 | 1.0 | 0.9 | 0.35 |
| bumble | 1500 | 0.9 | 0.1 | 0.8 | 1.0 | 0.40 |

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

## Data Pipeline

```
fetchGridNlcdScores()         — generates uniform grid (0.003° ≈ 330 m), batches to /api/nlcd-nesting
       ↓
/api/nlcd-nesting (serve.js)  — MRLC WMS PNG tile decode → pixel counts per NLCD class per cell
       ↓
computeInVESTHeatmap()        — biophysical tables × guild kernels × HN(max substrate) × FR normalization
       ↓
updateInVESTHeatmap(geojson)  — pushes GeoJSON to MapLibre 'invest-heat' source
       ↓
heatmap layer (map.js)        — radius interpolated by zoom (z8→18px … z14→300px), opacity 0.80
```

---

## Implementation Notes

- The `computeInVESTHeatmap` inner loop is O(cells² × guilds). At 7,500 cells and 3 guilds the
  triple loop is ~168M iterations. Use the existing bounding-box pre-filter (|dLng|>cutoff skip)
  religiously. For bumble bee guild (α=1.5 km, cutoff=4.5 km) most pairs are culled.
- Do NOT skip the kernel normalization denominator (`normSum`). Without it, edge cells and
  dense urban grids produce systematically biased FR values.
- Grid step must not exceed `alpha_min / 2` = 150 m to avoid undersampling the small guild.
  Current 0.003° ≈ 330 m is acceptable; do not increase.
- The 2% floor is intentionally low to preserve faint urban signals.
- `/api/nlcd-nesting` has a 24-hour tile cache in `snapshots/cache/nlcd-nesting/`.
  On first run after grid resolution change, expect ~1–2 min for cache warm-up.

---

## References

- Lonsdorf et al. (2009). Modelling pollination services across agricultural landscapes. *Annals of Botany* 103(9): 1589–1600.
- Sharp et al. (2018). InVEST User's Guide. Natural Capital Project.
- Koh et al. (2016). Modeling the status, trends, and impacts of wild bee abundance in the United States. *PNAS* 113(1): 140–145. https://doi.org/10.1073/pnas.1517685113
- Greenleaf et al. (2007). Bee foraging ranges and their relationship to body size. *Oecologia* 153: 589–596.
- Wentling et al. (2021). Landscape-scale factors affecting pollinator community diversity and abundance in the Upper Midwest. *Landscape Ecology*.
