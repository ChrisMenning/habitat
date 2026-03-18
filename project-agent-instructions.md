# Bay Hive — Copilot Instructions

> Read this file in full before suggesting any changes. It is the authoritative reference for architecture, constraints, and conventions.

---

## What This Project Is

**Bay Hive** is a browser-based public-data intelligence tool for pollinator habitat in the Green Bay, WI area. It is a civic OSINT tool, not a nature dashboard. The aesthetic and framing are deliberate: intelligence-platform UI, not consumer app.

It runs entirely as static files served by a minimal Node.js server (`serve.js`). There is no build step, no bundler, no framework, no npm install. All JavaScript is ES modules loaded directly in the browser.

---

## Project Structure

```
habitat/
├── index.html               # App shell + all UI panels + Help/About modals
├── serve.js                 # Node.js static file server + CORS proxy + NLCD PNG filter
├── waystation_coords.json   # Manually curated Monarch Watch waystation locations
├── css/
│   └── styles.css           # All styles — no CSS framework
└── js/
    ├── app.js               # Entry point — initializes map, orchestrates module load order
    ├── ui.js                # Populates layer toggle panels from live data; owns layer registry
    ├── alerts.js            # Intelligence alerts engine — pure client-side, no network calls
    ├── drawer.js            # Site detail drawer — populates #site-drawer-body on feature click
    ├── filters.js           # Observation filter chips (research grade, native, near habitat, etc.)
    ├── cache.js             # IndexedDB wrapper — all network fetches go through this
    └── [other modules]      # <!-- TODO: fill in any additional JS files in js/ -->
```

---

## Module Responsibilities

### `app.js`
- Initializes the MapLibre GL map instance (stored on `window.map` or equivalent)
- Controls startup sequence: map load → area layers → observations → alerts
- Manages the `#status` and `#loading` indicator
- Owns the top-level data fetch orchestration; calls into other modules

### `ui.js`
- Populates all `<!-- populated by ui.js -->` placeholders in index.html at runtime
- Owns the layer toggle registry: layer ID → source → MapLibre visibility
- Handles "All off" button (`#btn-layers-all-off`)
- Renders legend (`#panel-area-legend-inner`) and establishment ring key (`#panel-est-inner`)
- **Does not fetch data directly** — receives feature collections from app.js

### `alerts.js`
- Runs entirely client-side against data already in memory
- **Never makes network requests**
- Recalculates on every data load
- Populates `#alerts-list`
- Updates `#intel-val-alerts` count badge

Alert types and their spatial logic:
| Alert | Algorithm |
|---|---|
| PFAS Near Habitat | Haversine, 1 km radius from each PFAS site to corridor + waystation sites |
| Unsupported Sites | Any pollinator sighting within 500 m of habitat site |
| Opportunity Zones | ~1 km grid buckets; ≥5 sightings + no habitat within 800 m |
| Connected Pairs | Habitat pairs within 300 m (corridor stepping-stone distance) |
| Isolated Habitat | No other habitat within 2 km |
| Connectivity Gap | Widest gap among corridor sites within 8 km; flags if >2.5 km |
| Quadrant Coverage | 4 quadrants around centroid; flags any quadrant with no habitat |
| Pollinator Mismatch | Bee-dependent crop acreage % vs. estimated habitat coverage |

### `drawer.js`
- Populates `#site-drawer-body` when a feature is clicked
- Opens/closes `#site-drawer` (toggle `aria-hidden`)
- Close button: `#site-drawer-close`
- Handles all feature types: corridor sites, waystations, HNP yards, PFAS sites, protected areas

### `filters.js`
- Populates `#panel-filter-chips`
- Filter options: research grade, near habitat site, native species, non-native/invasive
- Triggers observation re-render (does not re-fetch from network)

### `cache.js`
- Thin IndexedDB wrapper
- Area layers (corridor, waystations, land cover): 24-hour TTL
- Observation data: 1-hour TTL, keyed by date range
- Intel bar shows `Cached` vs `Live` via `#intel-val-cache`

### `serve.js`
- Node.js static file server (no dependencies)
- CORS proxy at `/api/hnp-plantings` for Homegrown National Park API (no CORS headers)
- Custom PNG pixel-filter proxy for NLCD tiles: strips non-matching land cover class pixels to transparent
  - Implements CRC32, Paeth predictor, palette PNG support, RGBA encoder — all in pure Node.js, no npm
  - **Do not refactor or "improve" this without explicit instruction — it is bespoke infrastructure**

---

## Data Sources & Layer IDs

| Layer | Source | Type | Notes |
|---|---|---|---|
| NE WI Pollinator Corridor | GBCC ArcGIS Feature Service | GeoJSON polygon | Core backbone of the map |
| GBCC Habitat Treatments | GBCC ArcGIS Feature Service | GeoJSON polygon | Restoration treatment areas |
| Monarch Waystations | `waystation_coords.json` | GeoJSON point | Manually curated, 56 sites |
| Homegrown National Park | HNP API via `/api/hnp-plantings` proxy | GeoJSON point | Self-reported native yards |
| iNaturalist Sightings | iNaturalist API v1 | GeoJSON point | Up to 2,000 obs, 15 km radius |
| GBIF Records | GBIF Occurrence API v1 | GeoJSON point | Up to 600 records per query |
| USGS PAD-US | USGS PAD-US v3.0 ArcGIS Feature Service | GeoJSON polygon | Protected areas |
| WI DNR State Natural Areas | WI DNR ArcGIS MapServer | GeoJSON polygon | |
| WI DNR Managed Lands | WI DNR ArcGIS MapServer | GeoJSON polygon | |
| WI DNR PFAS Sites | WI DNR PFAS MapServer | GeoJSON point | Alert threshold: 1 km from habitat |
| NLCD 2021 | MRLC GeoServer WMS via PNG proxy | Raster tile | 16 toggleable land cover classes |
| CDL 2023 | USDA NASS CropScape WMS | Raster tile | Full-color crop type map |
| USDA NASS QuickStats | NASS QuickStats API | JSON | Optional; requires `nass-key.txt` or `NASS_API_KEY` env var |

**MapLibre layer ID conventions:** <!-- TODO: document your actual layer ID naming scheme here, e.g. "corridor-fill", "corridor-outline", "inat-pollinators", etc. -->

---

## Key UI Elements (DOM IDs)

| ID | Purpose |
|---|---|
| `#map` | MapLibre container |
| `#status` | Header status text (aria-live) |
| `#loading` | Loading spinner overlay |
| `#intel-bar` | Situational summary strip |
| `#intel-val-corridor` | Corridor site count |
| `#intel-val-waystation` | Waystation count |
| `#intel-val-inat` | iNaturalist sighting count |
| `#intel-val-gbif` | GBIF record count |
| `#intel-val-alerts` | Alert count badge |
| `#intel-val-cache` | Cache/Live indicator |
| `#panel` | Left layer controls panel |
| `#panel-habitat-inner` | Populated by ui.js — habitat toggles |
| `#panel-areas-inner` | Populated by ui.js — conservation/hazard toggles |
| `#panel-landcover-inner` | Populated by ui.js — NLCD class toggles |
| `#panel-layers` | Populated by ui.js — sightings toggles |
| `#panel-filter-chips` | Populated by filters.js |
| `#panel-area-legend-inner` | Populated by ui.js — color legend |
| `#panel-est-inner` | Populated by ui.js — establishment ring key |
| `#alerts-list` | Populated by alerts.js |
| `#alerts-panel` | Right alerts panel |
| `#site-drawer` | Site detail drawer |
| `#site-drawer-body` | Populated by drawer.js |
| `#btn-layers-all-off` | Hides all layers |
| `#btn-reload` | Re-fetches observations |
| `#btn-export` | Plain-text intelligence report |
| `#btn-help` | Opens `#modal-help` |
| `#btn-about` | Opens `#modal-about` |
| `#toggle-heatmap-proximity` | Corridor proximity bands toggle |
| `#toggle-heatmap-traffic` | Pollinator access traffic heatmap toggle |
| `#toggle-cdl-fringe` | Bee-crop field fringe heatmap toggle (on by default) |
| `#date-from` / `#date-to` | Observation date range inputs |
| `#timeline` | Year-range scrubber (bottom of page) |

---

## Hard Constraints — Do Not Violate

1. **No build step.** No webpack, vite, rollup, parcel, or any bundler. Ever.
2. **No npm dependencies at runtime.** `serve.js` and all JS files run without `node_modules`.
3. **No framework.** No React, Vue, Svelte, etc. Vanilla ES modules only.
4. **MapLibre GL is loaded from CDN** (`unpkg.com`) as a global script before the module entry point. It is available as `maplibregl` on `window`. Do not import it as an ES module.
5. **No tracking, no analytics, no external JS beyond MapLibre.**
6.  `serve.js`'s PNG filter logic is bespoke and has no tests — rewriting it will break NLCD tile rendering. In fact, I think this was already previously broken. Once it is working perfectly never change it again.
7. **All data fetches go through `cache.js`.** Do not add direct `fetch()` calls to area layer data outside of the cache wrapper.
8. **NASS API key is optional.** Code that uses it must gracefully degrade if the key is absent.

---

## Spatial Analysis Assumptions

- Map center: Green Bay, WI (~44.519°N, 88.020°W)
- Analysis radius: 15 km from center
- Coordinate system: WGS84 (EPSG:4326) for all GeoJSON
- Distance calculations: Haversine formula (not geodesic, not projected)
- Corridor stepping-stone threshold: 300 m
- Native bee foraging range: 2.5 km (used for connectivity gap alert)

---

## Aesthetic & Framing Notes

Bay Hive is styled as an intelligence platform, not a nature app. When adding UI copy, alerts text, or labels:
- Prefer operational language: "corridor sites," "waystation nodes," "sightings," "alerts," "opportunity zones"
- Avoid consumer-app softness: not "explore," "discover," "connect with nature"
- The intel bar, alert severity levels, and "Load Observations" button are intentional framing choices — keep them

---

## What "Done" Looks Like

When suggesting code changes, prefer:
- Minimal diffs over rewrites
- Keeping existing DOM IDs and MapLibre layer IDs stable
- Adding JSDoc `@param`/`@returns` to any new exported functions
- Matching the existing module pattern (no default exports that aren't functions or objects)