# Bay Hive

A browser-based public-data intelligence tool for pollinator habitat in the Green Bay, WI area. Bay Hive fuses field observations, conservation boundaries, land cover data, and hazard records into a unified situational map with automated intelligence alerts.

![Interface styled as a dark intelligence platform with a left icon bar and slide-out panels]

---

## Features

- **Activity bar + slide-out panels** — Icon strip opens labeled content panes: Habitat Sites, Sightings, Analysis, Conservation & Hazards, Landcover & Cropland, Legend, Trends, and Alerts
- **Intelligence alerts** — fourteen automated spatial alerts covering PFAS proximity, pesticide pressure, connectivity gaps, shaded habitat, poor nesting conditions, opportunity zones, and pollinator–crop mismatch
- **Multi-source sightings** — iNaturalist (up to 2,000 obs), GBIF records (up to 600), eBird, and Wikimedia Commons photos, filterable by research grade, native species, proximity to habitat
- **Bee distribution analysis** — FWS Bee Distribution Tool dataset (all 6 bee families), species richness heatmap in the Analysis pane, imperiled species layer (NatureServe G1–G3, IUCN VU+)
- **Conservation layers** — USGS PAD-US v3.0, WI DNR State Natural Areas, DNR Managed Lands, GBCC Pollinator Corridor, Habitat Treatments
- **Land cover & cropland** — NLCD 2021 (16 toggleable classes), USDA cropland data layer with bee-crop fringe heatmap, WI DNR Urban Tree Canopy (3 survey years: 2013/2020/2022, timeline-linked)
- **Hazard overlay** — WI DNR PFAS contamination sites with 1 km proximity alerts to habitat
- **Site detail drawer** — click any feature for full metadata, coordinates, nesting suitability score, tree canopy %, and data provenance
- **Clickable intel bar** — five stats (Corridor area, Habitat nodes, Pollinators, eBird, Native species) open info drawers; Alerts stat opens the alerts panel
- **Date range scrubber** — filter observations to any date window, with a year-range timeline control that also syncs the Tree Canopy survey year
- **Trends pane** — year-over-year charts once ≥2 snapshot years have been harvested via `POST /api/harvest`
- **Export** — plain-text intelligence report of current map state
- **IndexedDB caching** — area layers cached 24 hours; observation data cached 1 hour; cache/live status shown in the intel bar
- **WCAG 2.2 AA** — full keyboard navigation, roving tabindex, `aria-live` regions, sufficient contrast throughout

---

## Data Sources

| Layer | Source |
|---|---|
| NE WI Pollinator Corridor | GBCC ArcGIS Feature Service |
| GBCC Habitat Treatments | GBCC ArcGIS Feature Service |
| Monarch Watch Waystations | `waystation_coords.json` (56 manually curated sites) |
| Homegrown National Park yards | HNP API (proxied — no CORS) |
| iNaturalist Sightings | iNaturalist API v1 |
| GBIF Records | GBIF Occurrence API v1 |
| Bee Distribution (FWS dataset) | GBIF occurrence records — 6 bee families |
| Protected Areas | USGS PAD-US v3.0 |
| State Natural Areas | WI DNR ArcGIS MapServer |
| DNR Managed Lands | WI DNR ArcGIS MapServer |
| PFAS Sites | WI DNR PFAS MapServer |
| Land Cover | NLCD 2021 via MRLC GeoServer WMS (PNG proxy) |
| Cropland | USDA NASS CropScape WMS |
| Tree Canopy | WI DNR Urban Tree Canopy ImageServer (2013 / 2020 / 2022, 1 m NAIP imagery) |
| Wikimedia Commons Photos | Wikimedia Commons API (keyword search, proximity-filtered) |
| Crop statistics | USDA NASS QuickStats API *(optional)* |
| Bird sightings | Cornell eBird API *(optional)* |
| Climate data | NOAA CDO / NCEI *(optional)* |

Analysis radius: **15 km** from Green Bay city center (44.519°N, 88.020°W).

---

## Prerequisites

- **Node.js 18 or later** — no other dependencies; `node_modules` is never needed

---

## Running Locally

```bash
node serve.js
```

Open **http://localhost:3000** in your browser.

There is no build step, no bundler, and no `npm install`. All JavaScript is loaded as native ES modules directly in the browser.

---

## API Keys (optional)

Three external data sources require API keys. The app works without them — those layers simply won't load.

Create an `api-keys.txt` file in the project root (this file is gitignored):

```
# Bay Hive — API keys
# One KEY=value per line. Lines starting with # are ignored.

NASS_API_KEY=your-usda-nass-key
EBIRD_API_KEY=your-ebird-key
NOAA_CDO_TOKEN=your-noaa-token
```

Keys can also be set as environment variables (`NASS_API_KEY`, `EBIRD_API_KEY`, `NOAA_CDO_TOKEN`); environment variables take precedence over the file.

| Key | Source |
|---|---|
| `NASS_API_KEY` | [USDA NASS QuickStats](https://quickstats.nass.usda.gov/api) |
| `EBIRD_API_KEY` | [Cornell eBird](https://ebird.org/api/keygen) |
| `NOAA_CDO_TOKEN` | [NOAA CDO / NCEI](https://www.ncdc.noaa.gov/cdo-web/token) |

---

## Architecture

```
habitat/
├── index.html               # App shell — all UI, panels, modals
├── serve.js                 # Node.js static server + CORS proxy + NLCD PNG filter
├── waystation_coords.json   # Manually curated waystation locations
├── api-keys.txt             # API credentials (gitignored — create locally)
├── render.yaml              # Render.com deployment config
├── css/
│   └── styles.css           # All styles — no CSS framework
└── js/
    ├── app.js               # Entry point — initializes map and orchestrates module load order
    ├── config.js            # Layer definitions, constants, color values
    ├── ui.js                # Populates layer toggle panels; owns layer registry; activity bar
    ├── alerts.js            # Intelligence alerts engine — client-side only, no network calls
    ├── drawer.js            # Site detail drawer — populates on feature click
    ├── filters.js           # Observation filter chips (research grade, native, near habitat…)
    ├── cache.js             # IndexedDB wrapper — all network fetches go through this
    ├── map.js               # MapLibre layer management helpers
    ├── layers.js            # Layer source + paint definitions
    ├── api.js               # External API fetch wrappers
    ├── gbif.js              # GBIF-specific fetch and normalisation
    ├── ebird.js             # eBird fetch and normalisation
    ├── bees.js              # Bee distribution layer (FWS dataset)
    ├── areas.js             # Conservation area polygon layers
    ├── landcover.js         # NLCD + CDL raster tile layers
    ├── parcels.js           # Parcel layer management
    ├── health.js            # Site health scoring
    ├── climate.js           # NOAA climate data integration
    ├── nesting.js           # Nesting habitat layer
    ├── pesticide.js         # Pesticide / chemical threat data
    ├── waystations.js       # Monarch Watch waystation layer
    ├── hnp.js               # Homegrown National Park layer
    ├── classify.js          # Observation classification helpers
    ├── commons.js           # Wikimedia Commons sightings
    ├── history.js           # Observation history / timeline
    ├── timeline.js          # Year-range scrubber control
    ├── permalink.js         # URL state serialisation
    ├── export.js            # Plain-text intelligence report
    ├── filters.js           # Filter chip controls
    └── alerts.js            # Spatial alert algorithms
```

**Key design constraints:**
- No build step, no bundler, no framework — vanilla ES modules only
- MapLibre GL 3.6.2 loaded from CDN as a global; do not import as an ES module
- No npm runtime dependencies
- All data fetches go through `cache.js` — no bare `fetch()` calls for area layer data
- NASS API key is optional; all key-gated code degrades gracefully

---

## Intelligence Alerts

The alert engine runs entirely client-side against data already loaded in memory. Fourteen alert types are evaluated on every data load:

| Alert | Logic |
|---|---|
| PFAS Near Habitat | Any PFAS site within 1 km of a corridor or waystation site (Haversine) |
| Unsupported Sites | Corridor sites with no pollinator sighting within 500 m |
| Opportunity Zones | ~1 km grid cell with ≥5 sightings and no habitat within 800 m |
| Declining Public Zone | Opportunity zone with a declining sighting trend ⬇️ + publicly owned land nearby |
| Public Land Gap | City/County parcel ≥0.5 ac within an opportunity zone and no habitat within 500 m |
| Connected Pairs | Habitat site pairs within 300 m (corridor stepping-stone distance) |
| Isolated Habitat | Habitat site with no other habitat within 2 km |
| Weak Nodes | Corridor sites whose nearest neighbour is 700 m–2 km away |
| Connectivity Gap | Widest MST edge among corridor sites; flagged if >2.5 km |
| Quadrant Coverage | 4 quadrants around map centroid; flagged if any quadrant has no habitat |
| Pollinator Mismatch | Bee-dependent crop acreage % vs. estimated habitat coverage |
| High Pesticide Pressure | Corridor sites/waystations in Critical-band pesticide counties (top quartile) |
| Poor Nesting Habitat | Corridor sites scoring below 25/100 on the NLCD nesting suitability index |
| Shaded Habitat | Corridor sites with >55% tree canopy coverage within 150 m (WI DNR UTC 2022) |

---

## Deployment

The app deploys as a static-file Node.js service. A `render.yaml` is included for [Render.com](https://render.com):

```bash
# Start command
node serve.js
```

Set the optional API keys as environment variables in your hosting provider's dashboard.

---

## Browser Support

Modern evergreen browsers (Chrome, Firefox, Edge, Safari). Requires ES module support and IndexedDB.

---

## License

Data displayed in Bay Hive is sourced from public agencies and open-access repositories. See each data source's terms of use for redistribution rights.
