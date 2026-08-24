# Bay Hive — InVEST Urban Analysis Methodology

## Overview

Bay Hive implements **two complementary InVEST-derived heatmaps** plus a **Foraging Range Bands** overlay:

| Layer | Grid | Purpose |
|---|---|---|
| Landscape Suitability Index | ~1.3 km (0.012°) | Regional ecological context |
| Urban Habitat Index | ~330 m (0.003°) | Within-city habitat comparison |
| Foraging Range Bands | per-site polygons | Visual foraging range per corridor site |

---

## 1. Landscape Suitability Index (Original InVEST Layer)

**Source:** `computeInVESTHeatmap()` in `js/nesting.js`  
**Model:** Lonsdorf et al. 2009, equations 61–64

### Grid
- Step: 0.012° ≈ 1.3 km
- Extent: bounding box of study area, radius 30 km from center

### Guilds

| Guild | Alpha (km) | Ground Pref | Cavity Pref | Spring | Summer | Abundance |
|---|---|---|---|---|---|---|
| Small solitary | 0.30 | 0.9 | 0.1 | 0.8 | 1.0 | 0.25 |
| Medium solitary | 0.70 | 0.6 | 0.8 | 1.0 | 0.9 | 0.35 |
| Bumble bee | 1.50 | 0.9 | 0.1 | 0.7 | 1.0 | 0.40 |

### Normalization
- Score normalized against the global maximum across all grid cells.
- 2% floor applied (no cell below 0.02 regardless of land cover).

### Interpretation & Limitation
The 1.3 km grid cannot resolve sub-acre corridor plantings.
A corridor site in the middle of Green Bay will score low because the sampling kernel
captures mostly impervious surface at that resolution — this is *correct* behavior, not a bug.
Rural wetlands and grasslands will always dominate this index.
**Use this layer for regional landscape context only.**

---

## 2. Urban Habitat Index

**Source:** `computeInVESTHeatmapUrban()` in `js/nesting.js`  
**Export also:** `INVEST_GUILDS_URBAN`, `URBAN_NLCD_THRESHOLD`

### Grid
- Step: 0.003° ≈ 330 m
- Same bounding box as landscape, 30 km radius
- Lazy-fetched on first toggle, cached in `_urbanNlcdScores` / `_urbanInVESTGeojson` in `app.js`

### Urban Threshold
`URBAN_NLCD_THRESHOLD = 0.20` — Only cells where ≥20% of NLCD pixels fall in developed classes
(NLCD 21–24) are included in the output GeoJSON and appear on the heatmap.
Rural grassland does **not** set the normalization ceiling.

**Why 20%?** Most Green Bay grid cells at 330 m contain some impervious surface. 20% ensures
we exclude purely agricultural and wetland cells without requiring a majority-developed threshold
that would exclude parks and greenways at the urban fringe.

### Guild Reweighting for Urban

| Guild | Alpha (km) | Ground Pref | Cavity Pref | Spring | Summer | Abundance |
|---|---|---|---|---|---|---|
| Small solitary | 0.30 | 0.8 | 0.3 | 0.7 | 1.0 | 0.40 |
| Medium solitary | 0.70 | 0.6 | 0.8 | 1.0 | 0.9 | 0.45 |
| Bumble bee | 1.50 | 0.9 | 0.1 | 0.8 | 1.0 | 0.15 |

Bumble bee weight is reduced from 0.40 → 0.15 in urban settings because:
- Long-range bumble bees are less constrained by the fine-grained patchwork of urban land cover.
- Small and medium solitary bees are *more* sensitive to the local 100–700 m matrix, making
  them better discriminators of urban planting quality.

### Normalization
- Score ceiling is the **maximum P(x)** among urban cells only (urbanFrac ≥ 0.20).
- No floor is applied — urban cells can score 0.

### Map Layer
- Source ID: `invest-urban-heat` (heatmap), `invest-urban-heat-hits` (transparent hit targets for click)
- Color ramp: violet → indigo → pink → yellow
- Opacity: 0.82
- Radii: z8=6px, z10=14px, z12=36px, z14=80px

### Click Behavior
Clicking the heatmap opens an Intel Drawer with:
- Score (0–100)
- Percentile interpretation
- Explanation of what the 330 m grid measures
- Disclaimer that individual corridor sites are not resolved

---

## 3. Corridor Crosswalk

**Source:** `crosswalkInVESTCorridor()` in `js/nesting.js`

Takes `urbanGeojson` (the urban heatmap FeatureCollection) and `corridorSites` (array of `{name, lng, lat}`).
For each corridor site, finds the nearest GeoJSON feature by Euclidean distance in degrees and
returns `{name, lng, lat, investScore}`.

The top-10 crosswalk results are logged to `console.log('[invest-crosswalk] top sites:', ...)` when
the Urban Habitat Index loads. This is useful for identifying which corridor sites happen to sit near
urban cells with relatively good habitat context.

**Note:** Because individual plantings are below 330 m resolution, the crosswalk score reflects the
*surrounding urban matrix*, not the planting quality. A high score means the area *around* the site
has favorable land cover context.

---

## 4. Foraging Range Bands

**Source:** `computeForagingBands()` in `js/nesting.js`

For each corridor site, generates 3 concentric **64-point polygon rings**:

| Band | Radius | Guild | Color |
|---|---|---|---|
| Outer | 1.50 km | Bumble bee | Rose |
| Middle | 0.70 km | Medium solitary | Amber |
| Inner | 0.30 km | Small solitary | Teal |

### Rendering Design
- Bands are rendered **outer → inner** (largest first) so inner rings overlay outer rings.
- Fill opacity: 0.07 — low enough that a single ring is subtle, but overlapping rings from nearby
  sites visibly darken, creating an **isobar / pressure-chart** aesthetic showing where foraging
  zones converge.
- Outline: dashed `[3,3]`, opacity 0.28 — visible boundary without cluttering the map.

### Map Layers
- Source ID: `foraging-bands`
- Fill layer: `foraging-bands-fill`
- Outline layer: `foraging-bands-outline`
- Guild color expression: teal (#0d9488) for small, amber (#d97706) for medium, rose (#e11d48) for bumble

---

## 5. Performance Notes

| Operation | Cell count | API calls | Approx load time |
|---|---|---|---|
| Landscape grid (0.012°) | ~650 | ~7 | 4–10 s |
| Urban grid (0.003°) | ~4,000–7,500 | ~40–80 | 15–60 s |

The urban grid is lazy-loaded on first toggle and cached for the session. Subsequent toggles are instant.

NLCD data is fetched tile-by-tile from the server's `/api/nlcd` endpoint, which proxies NASS and the
NLCD WCS. Slow network or server throttling is the dominant cost.

---

## 6. Known Limitations

1. **Sub-acre corridor plantings are invisible** at both landscape (1.3 km) and urban (330 m) grids.
   The maps show the habitat *matrix* pollinators travel through, not the planting quality itself.

2. **No temporal variation in NLCD:** NLCD 2021 is a static snapshot. Recent plantings since 2021
   are not reflected.

3. **Foraging bands are Euclidean circles** — they do not account for barriers (roads, buildings,
   water bodies). They represent maximum possible range, not realized flight paths.

4. **Crosswalk uses nearest-cell Euclidean distance** — a corridor site near a park cell and
   a corridor site in a dense impervious block could have very different realistic scores even
   if their nearest urban cell is equidistant.

5. **Urban threshold (20%)** is tunable but currently hardcoded as `URBAN_NLCD_THRESHOLD`.
   Lowering it includes more peri-urban fringe; raising it restricts to dense urban core.

---

## 7. Future Refinements

- Route-aware foraging polygons (network distance to green space).
- NLCD vintage toggle (2019 vs 2021) to show change in urban habitat context.
- Per-guild separate heatmaps instead of abundance-weighted average.
- Crosswalk panel in the UI showing the ranked corridor site list with their urban scores.
- Machine-learning nesting suitability instead of NLCD lookup tables.
