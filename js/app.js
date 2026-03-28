/**
 * app.js — Application entry point and orchestrator.
 *
 * Wires together the map, iNaturalist API, and UI modules.
 * Contains no business logic — delegates entirely to the imported modules:
 *
 *   map.js   — MapLibre instance, layers, popup, interactions
 *   api.js   — iNaturalist API fetching and GeoJSON conversion
 *   ui.js    — DOM panel, legend, status, popup HTML builder
 *   config.js — Layer/establishment definitions and constants
 */

import { LAYERS, GBIF_LAYERS, BEE_LAYERS, AREA_LAYERS, HAZARD_LAYERS, WAYSTATION_LAYER, HNP_LAYER, RASTER_LAYERS, NLCD_LAYERS, EBIRD_LAYER, PESTICIDE_LAYER, PARCEL_LAYER, COMMONS_LAYER, TREE_CANOPY_LAYERS, EXPANSION_LAYER, PROBLEM_AREAS_LAYER, INVEST_LAYER, INAT_HISTORY_START_YEAR,
         LAYER_VINTAGES, LAYER_LABELS, STALENESS_THRESHOLD_YEARS, TEMPORAL_MISMATCH_THRESHOLD_YEARS,
         CENTER, RADIUS_KM, LAYER_PRESETS } from './config.js';
import { fetchObservations, fetchObservationsForYear, observationsToGeoJSON,
         partitionByLayer }                            from './api.js';
import { fetchGbifPollinators, fetchGbifPlants, fetchGbifWildlife,
         gbifToGeoJSON, resolveOccurrenceEstKeys,
         partitionPlantOccurrences }                   from './gbif.js';
import { fetchBeesAll, beesToGeoJSON,
         filterImperiledFeatures,
         computeSpeciesRichness }                      from './bees.js';
import { fetchPadUs, fetchDnrSna, fetchDnrManagedLands,
         fetchPollinatorCorridor, fetchCorridorTreatments,
         fetchChemicalHazards,
         corridorCentroids }                          from './areas.js';
import { waystationGeoJSON }                          from './waystations.js';
import { fetchHnpYards }                              from './hnp.js';
import { fetchCdlStats, fetchQuickStats, fetchCdlFringe } from './landcover.js';
import { initMap, registerLayer, registerAreaLayer,
         registerAreaMarkersLayer,
         registerSvgIcons,
         registerRasterLayer,
         registerConnectivityMesh,
         updateConnectivityMesh,
         registerPollinatorTrafficHeatmap,
         updatePollinatorTrafficHeatmap,
         registerNativePlantHeatmap,
         updateNativePlantHeatmap,
         setHeatmapVisibility,
         registerCdlFringeHeatmap,
         updateCdlFringeHeatmap,
         registerBeeRichnessHeatmap,
         updateBeeRichnessHeatmap,
         registerPesticideLayer,
         setPesticideFeatures,
         setPesticideLayerVisibility,
         registerNestingBadgeLayer,
         setNestingBadgeFeatures,
         setNestingBadgeVisibility,
         registerParcelLayer,
         setParcelFeatures as setMapParcelFeatures,
         setParcelLayerVisibility,
         registerCommonsLayer,
         setCommonsFeatures as setMapCommonsFeatures,
         setCommonsLayerVisibility,
         registerExpansionOpportunitiesLayer,
         updateExpansionOpportunitiesLayer,
         registerProblemAreasLayer,
         updateProblemAreasLayer,
         registerInVESTHeatmap,
         updateInVESTHeatmap,
         setLayerFeatures, setAreaFeatures, setAreaMarkersFeatures,
         setLayerVisibility, setAreaVisibility, setRasterLayerVisibility,
         setPointLayerOpacity, setAreaLayerOpacity, setRasterOpacity,
         getInteractiveLayerIds, getInteractiveAreaLayerIds,
         showPopup, closePopup, wireInteractions, wireHoverCursors, wireParcelClick,
         showAlertHighlight, clearAlertHighlight, fitToCoords,
         zoomToCluster, getEffectiveClusteredCoords,
         setWaystationApproxStyle,
         registerJourneyNorthLayer,
         setJourneyNorthFeatures,
         setJourneyNorthVisibility,
         getMap } from './map.js';
import { buildLayerPanel, buildEstLegend, buildAreaLegend, buildPesticideLegend, updateCounts,
         setLoading, setLoadingProgress, setStatus, initActivityBar,
         buildPopupHTML, buildAreaPopupHTML,
         esc, openLightbox, closeLightbox }                  from './ui.js';
import { cacheGet, cacheSet }                         from './cache.js';
import { computeAlerts, renderAlerts,
         computeExpansionOpportunities,
         computeProblemFeatures }             from './alerts.js';
import { initFilters, setBaseFeatures, setHabitatCoords,
         setDatePredicate, buildFilterChips, applyFilters } from './filters.js';
import { openDrawer, closeDrawer, isDrawerFeature, openIntelDrawer,
         setSightings as setDrawerSightings,
         setHabitatSites as setDrawerHabitatSites,
         setNestingScores as setDrawerNestingScores,
         setCanopyScores as setDrawerCanopyScores,
         setParcelFeatures as setDrawerParcelFeatures,
         setCommonsImages as setDrawerCommonsImages }  from './drawer.js';
import { initTimeline, updateTimelineBounds,
         mountTimelineDrag, registerTemporalLayer }   from './timeline.js';
import { setExportData, exportReport, exportMapPng,
         exportExecutiveBrief, exportOutreachReport, exportEcologicalAssessment } from './export.js';
import { parsePermalink, applyPermalinkState,
         initPermalink }                               from './permalink.js';
import { fetchEbirdObservations }                      from './ebird.js';
import { initClimatePanel, getClimateState, getGddIntelStat, openClimateRibbon } from './climate.js';
import { fetchPesticideCounties }                      from './pesticide.js';
import { fetchNestingScores, enrichCentroidsWithNesting, fetchCanopyScores, fetchGridNlcdScores, computeInVESTHeatmap } from './nesting.js';
import { fetchParcelsForBbox, classifyOwnership, hydrate as hydrateParcelCache, queryParcelsNear, OWNERSHIP_META } from './parcels.js';
import { fetchCommonsForApp }                             from './commons.js';
import { fetchSnapshotIndex, fetchSnapshot,
         availableYears, renderTrendChart,
         renderMonthlyChart, renderSpeciesTable }      from './history.js';
import { initHealthCheck }                            from './health.js';

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Returns a debounced version of `fn` — calls are delayed by `ms` and
 * any call within the delay window resets the timer.
 */
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Formats a square-footage value as acres (if large enough) or sq ft. */
function formatArea(sqft) {
  if (!sqft) return '—';
  if (sqft >= 43560) return `${(sqft / 43560).toFixed(1)} ac`;
  return `${Math.round(sqft).toLocaleString()} sq ft`;
}

/** Updates the notification badge on the activity-bar alerts button. */
function _updateAlertBadge(n) {
  const badge = document.getElementById('ab-badge-alerts');
  if (!badge) return;
  if (n > 0) { badge.textContent = n; badge.style.display = ''; }
  else        { badge.textContent = ''; badge.style.display = 'none'; }
}

/** Populates the intel-bar summary strip with current data counts. */
function updateIntelBar({ corridorSqFt, hnpCount, habitatNodeCount, pollinatorCount, gddStat, ebirdCount, nativeSpeciesCount, alertCount }) {
  document.getElementById('intel-val-corridor').textContent  = formatArea(corridorSqFt);
  document.getElementById('intel-val-habitat').textContent   = habitatNodeCount > 0 ? habitatNodeCount : '—';
  document.getElementById('intel-val-inat').textContent      = pollinatorCount.toLocaleString();
  if (gddStat) {
    document.getElementById('intel-val-climate').textContent = gddStat.value;
    const lbEl = document.getElementById('intel-lbl-climate-text') ?? document.getElementById('intel-lbl-climate');
    lbEl.textContent = gddStat.label;
  }
  const ebirdEl = document.getElementById('intel-val-ebird');
  if (ebirdEl) ebirdEl.textContent = ebirdCount > 0 ? ebirdCount.toLocaleString() : '—';
  document.getElementById('intel-val-species').textContent   = nativeSpeciesCount > 0 ? nativeSpeciesCount.toLocaleString() : '—';
  document.getElementById('intel-val-alerts').textContent    = alertCount;
  document.getElementById('intel-alerts')?.classList.toggle('intel-stat--has-alerts', alertCount > 0);
  _updateAlertBadge(alertCount);
}

// ── Layer visibility helpers (module-level so loadObservations can use them) ──

/**
 * IDs of all raster-backed layers — used to route visibility calls correctly.
 * Computed once from the static config; safe to evaluate before map 'load'.
 */
const _rasterLayerIds = new Set([
  ...RASTER_LAYERS.map(l => l.id),
  ...NLCD_LAYERS.map(l => l.id),
  ...TREE_CANOPY_LAYERS.map(l => l.id),
]);

/**
 * Dims any raster layer whose vintage year is older than STALENESS_THRESHOLD_YEARS
 * by reducing its opacity from the default 0.65 to 0.50.
 * Called once after all raster layers are registered.
 */
function _applyStaleRasterOpacity() {
  const currentYear = new Date().getFullYear();
  for (const layer of [...NLCD_LAYERS, ...TREE_CANOPY_LAYERS]) {
    const vintage = layer.vintage ?? LAYER_VINTAGES.get(layer.id);
    if (!vintage) continue;
    if ((currentYear - vintage.year) >= STALENESS_THRESHOLD_YEARS) {
      setRasterOpacity(layer.id, 0.50);
    }
  }
}

// ── Tree Canopy year-sync ────────────────────────────────────────────────────
let _treeCanopyOn = false;

/**
 * Shows the most recent tree canopy survey year whose year is ≤ endYear,
 * hiding all others. If the layer is toggled off, hides all.
 * @param {number} endYear
 */
function _syncTreeCanopyYear(endYear) {
  // Find the best matching year: largest year that is ≤ endYear
  const best = [...TREE_CANOPY_LAYERS].reverse().find(l => l.year <= endYear);
  for (const l of TREE_CANOPY_LAYERS) {
    setRasterLayerVisibility(l.id, _treeCanopyOn && best?.id === l.id);
  }
  // Update toggle label to reflect the active survey year
  const lbl = document.getElementById('tree-canopy-year-label');
  if (lbl) lbl.textContent = _treeCanopyOn && best ? String(best.year) : '';
}

/**
 * Routes a visibility change to the correct map helper based on layer type.
 * @param {string}  id
 * @param {boolean} visible
 */
function areaOrPointVisibility(id, visible) {
  if (AREA_LAYERS.some(l => l.id === id)) setAreaVisibility(id, visible);
  else if (_rasterLayerIds.has(id))       setRasterLayerVisibility(id, visible);
  else if (id === 'pesticide')            setPesticideLayerVisibility('pesticide', visible);
  else if (id === 'parcels')              setParcelLayerVisibility(visible);
  else if (id === 'commons-photos')       setCommonsLayerVisibility(visible);
  else if (id === 'bees-richness')        setHeatmapVisibility('bees-richness', visible);
  else if (id === 'invest-heat')                setHeatmapVisibility('invest-heat', visible);
  else if (id === 'journeynorth-monarchs')       setJourneyNorthVisibility(visible);
  else                                           setLayerVisibility(id, visible);
}

/**
 * Central layer-activation function.  Sets the map layer visibility AND
 * keeps all duplicate UI controls (panel checkbox + area-legend button) in
 * sync so neither source of truth diverges from the other.
 *
 * @param {string}  id
 * @param {boolean} visible
 */
function setLayerActive(id, visible) {
  areaOrPointVisibility(id, visible);

  // Track active layer set for temporal-mismatch alert
  if (visible) _activeLayerIds.add(id);
  else         _activeLayerIds.delete(id);

  // Connectivity mesh re-renders when any of the three site-layer types changes
  if (id === 'gbcc-corridor' || id === 'waystations' || id === 'hnp') {
    if (visible) _activeSiteLayers.add(id);
    else         _activeSiteLayers.delete(id);
    setHeatmapVisibility('connectivity-mesh', _activeSiteLayers.size > 0);
    refreshConnectivityMesh();
  }

  // Nesting badges follow NLCD active state
  if (_rasterLayerIds.has(id)) {
    syncNestingBadgeVisibility();
  }

  // Start viewport-gated parcel fetches when layer is enabled
  if (id === 'parcels' && visible) {
    _refreshParcelViewport();
  }

  // Lazy-fetch Commons photos on first enable
  if (id === 'commons-photos' && visible && !_commonsLoaded) {
    _lazyFetchCommons();
  }

  // Sync panel checkbox (programmatic assignment does NOT fire 'change')
  const cb = document.getElementById(`toggle-${id}`);
  if (cb) cb.checked = visible;

  // Sync area-legend button (data-layer-id attribute added by buildAreaLegend)
  const legendBtn = document.querySelector(`[data-layer-id="${id}"]`);
  if (legendBtn) legendBtn.classList.toggle('area-legend-row--off', !visible);
}

// ── Layer presets ─────────────────────────────────────────────────────────────

/**
 * All config-driven layer objects in one flat list.
 * Used by applyPreset() to enumerate every togglable layer.
 * (Excludes RASTER_LAYERS — empty — and TREE_CANOPY_LAYERS — controlled via
 *  the 'tree-canopy' hardcoded-cb suffix below, not a standalone config id.)
 */
const _ALL_CONFIG_LAYERS = [
  ...LAYERS, ...GBIF_LAYERS, ...BEE_LAYERS, ...AREA_LAYERS,
  ...HAZARD_LAYERS, ...WAYSTATION_LAYER, ...HNP_LAYER, ...NLCD_LAYERS,
  ...EBIRD_LAYER, ...EXPANSION_LAYER, ...PROBLEM_AREAS_LAYER,
  PESTICIDE_LAYER, PARCEL_LAYER, COMMONS_LAYER, INVEST_LAYER,
];

/**
 * Suffixes of hardcoded HTML heatmap checkboxes that are NOT managed by
 * setLayerActive. Toggle element IDs are `toggle-<suffix>`.
 * These need their `change` event dispatched directly.
 */
const _HARDCODED_CB_SUFFIXES = [
  'heatmap-traffic',
  'heatmap-native-plants',
  'tree-canopy',
  'cdl-fringe',
];

/**
 * Applies a layer preset using full-replace semantics: every known layer is
 * turned off, then only the layers listed in preset.on are turned on.
 *
 * @param {{ id: string|null, on: string[] }} preset
 */
function applyPreset(preset) {
  for (const layer of _ALL_CONFIG_LAYERS) {
    setLayerActive(layer.id, preset.on.includes(layer.id));
  }
  for (const suffix of _HARDCODED_CB_SUFFIXES) {
    const cb = document.getElementById(`toggle-${suffix}`);
    if (!cb) continue;
    cb.checked = preset.on.includes(suffix);
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // Sync active-tile highlight in the Views pane
  document.querySelectorAll('.preset-tile').forEach(btn => {
    btn.classList.toggle('preset-tile--active', btn.dataset.presetId === (preset.id ?? ''));
  });
}

/**
 * Builds preset tiles into #panel-presets-inner.
 * Called once during map init after panels are built.
 */
function renderPresets() {
  const container = document.getElementById('panel-presets-inner');
  if (!container) return;

  for (const preset of LAYER_PRESETS) {
    const btn = document.createElement('button');
    btn.type             = 'button';
    btn.className        = 'preset-tile';
    btn.dataset.presetId = preset.id;
    btn.setAttribute('aria-label', `Apply ${preset.label} layer view`);
    btn.innerHTML =
      `<span class="preset-tile-icon" aria-hidden="true"><i class="ph ph-${preset.icon}"></i></span>` +
      `<span class="preset-tile-text">` +
        `<span class="preset-tile-label">${preset.label}</span>` +
        `<span class="preset-tile-desc">${preset.description}</span>` +
      `</span>`;
    btn.addEventListener('click', () => applyPreset(preset));
    container.appendChild(btn);
  }

  // Reset to defaults button
  const defaultOn = [
    ..._ALL_CONFIG_LAYERS.filter(l => l.defaultOn).map(l => l.id),
    'cdl-fringe',  // only hardcoded-cb that has checked in HTML
  ];
  const resetBtn = document.createElement('button');
  resetBtn.type             = 'button';
  resetBtn.className        = 'preset-tile preset-tile--reset';
  resetBtn.dataset.presetId = '';
  resetBtn.setAttribute('aria-label', 'Reset all layers to default state');
  resetBtn.innerHTML =
    `<span class="preset-tile-icon" aria-hidden="true"><i class="ph ph-arrow-counter-clockwise"></i></span>` +
    `<span class="preset-tile-text">` +
      `<span class="preset-tile-label">Reset to Defaults</span>` +
      `<span class="preset-tile-desc">Restore the app to its initial layer state.</span>` +
    `</span>`;
  resetBtn.addEventListener('click', () => applyPreset({ id: null, on: defaultOn }));
  container.appendChild(resetBtn);
}

// ── Map setup ─────────────────────────────────────────────────────────────────

// Timeline year-range state (shared with permalink)
let _timelineStartYear   = new Date().getFullYear() - 1;
let _timelineEndYear     = new Date().getFullYear();
let _timelineActiveMonths = new Set();  // mirrors the Set from timeline.js; updated each scrubber change

// iNaturalist observation deduplication — prevents the same observation from
// appearing twice when the initial 'all' fetch overlaps with year-based history.
const _inatLoadedIds = new Set();

// Habitat node caches — kept module-level so setLayerActive can re-run the mesh
// without a full data reload.
let _corridorFeats            = [];
let _waystationFeats          = [];
let _confirmedWaystationFeats = [];  // approximate sites excluded
let _hnpFeats                 = [];
// Full unfiltered eBird features — retained for filter re-application without a network refetch.
let _ebirdAllFeats      = [];
// Active site-layer set — reflects current toggle state for the three site-layer types.
const _activeSiteLayers = new Set(['gbcc-corridor', 'waystations', 'hnp']);

// Tracks all currently-visible layer ids — used for temporal-mismatch alert detection.
// Initialised from defaultOn values after panels are built; updated on every toggle.
const _activeLayerIds = new Set();

// Nesting score state — populated async after corridor data loads
let _nestingScores    = new Map();   // site name → {score, counts, total}
let _gridNlcdScores   = new Map();   // nlcdGridKey → {score, counts, total}
let _nestingLoaded    = false;        // true once first fetch completes
let _canopyScores     = new Map();   // site name → canopyPct (0–100)
let _lastAlertArgs    = null;         // cached so re-render includes nesting scores
let _alertFocusHandler = null;        // module-level so async callbacks can re-render alerts

// Parcel and Commons state — populated lazily on first layer enable
let _parcelFeatures = [];
let _parcelLoaded   = false;
let _commonsLoaded  = false;

// Intel drawer data — cached after each observation load so click handlers
// always have access to the latest dataset without a re-fetch.
let _inatByLayer      = {};    // layerId → Feature[]  (raw iNat features)
let _gbifPollinators  = [];    // GBIF pollinator features
let _gbifNativePlants = [];    // GBIF native plant features
let _allSightings     = [];    // combined pollinator sightings for heatmap — refreshed on full load
let _allNativePlants  = [];    // combined native plant observations (iNat + GBIF, deduped) — refreshed on full load
let _hnpCount         = 0;     // count of HNP yards in bbox — refreshed on full load
let _lastAlertCount   = 0;     // most-recently rendered alert count for timeline-driven intel-bar updates

/**
 * Filters sighting features to the current timeline year+month window.
 * @param {GeoJSON.Feature[]} feats
 * @param {number}           startYear
 * @param {number}           endYear
 * @param {Set<number>}      activeMonths  (0=Jan…11=Dec; empty = all pass)
 * @returns {GeoJSON.Feature[]}
 */
function _filterSightingsByYear(feats, startYear, endYear, activeMonths) {
  return feats.filter(f => {
    const raw = f.properties?.date;
    if (!raw) return true;
    const d = new Date(raw);
    const y = d.getFullYear();
    if (y < startYear || y > endYear) return false;
    if (activeMonths.size > 0 && !activeMonths.has(d.getMonth())) return false;
    return true;
  });
}

/** Show/hide nesting badges based on whether any NLCD layer is currently on. */
function syncNestingBadgeVisibility() {
  if (!_nestingLoaded) return;
  const anyNlcd = NLCD_LAYERS.some(l => {
    const cb = document.getElementById(`toggle-${l.id}`);
    return cb?.checked;
  });
  setNestingBadgeVisibility(anyNlcd);
}

const map = initMap('map');

// ── Connectivity mesh ──────────────────────────────────────────────────────────

/**
 * Converts an array of [lng, lat] coordinates into minimal GeoJSON Point features
 * so they can be passed into updateConnectivityMesh.
 */
function _coordsToFeatures(coords) {
  return coords.map(c => ({
    type: 'Feature',
    geometry:   { type: 'Point', coordinates: c },
    properties: {},
  }));
}

/**
 * Rebuilds the connectivity mesh using the cluster-aware effective positions
 * of waystation and HNP nodes at the current zoom level.
 *
 * When a layer is clustered at the current zoom, cluster centroids are used
 * as mesh nodes (so lines connect groups, not every underlying individual).
 * When fully expanded (zoom ≥ clusterMaxZoom), individual points are used.
 */
function refreshConnectivityMesh() {
  // Foraging-range mesh uses confirmed-location waystations only — approximate
  // sites have no known address and would create false connectivity signals.
  const hnpCoords = getEffectiveClusteredCoords('hnp');
  const hnpFeats  = hnpCoords ? _coordsToFeatures(hnpCoords) : _hnpFeats;

  updateConnectivityMesh(_corridorFeats, _confirmedWaystationFeats, hnpFeats, _activeSiteLayers);
}

// ── Background iNaturalist historical loader ───────────────────────────────────
//
// Fetches each calendar year from INAT_HISTORY_START_YEAR through last year
// using the server-side proxy (/api/inat-history/:year), which pre-caches
// results at startup.  Browser Cache API stores processed results with long
// TTLs (30 days for past years, 7 days for the previous year) so subsequent
// page loads serve history from disk instantly without any network request.
//
// Observations are deduplicated against _inatLoadedIds before being merged
// into _inatByLayer, so no sighting ever appears twice.
//
// Long-TTL browser cache means:
//   • 1st visit: fetches each year from server (server serves from memory)
//   • 2nd+ visits: served instantly from browser cache (zero network)

/**
 * Background-loads and merges iNaturalist observations year-by-year from
 * INAT_HISTORY_START_YEAR to last year, extending the timeline as data arrives.
 *
 * Designed to run entirely in the background — any individual year failure is
 * caught, logged, and skipped without affecting the rest of the load.
 */
async function _loadHistoricalInat() {
  const currentYear   = new Date().getFullYear();
  const HIST_TTL_OLD  = 30 * 24 * 60 * 60 * 1000;  // 30 days — historical data is final
  const HIST_TTL_PREV =  7 * 24 * 60 * 60 * 1000;  // 7 days  — previous year may still grow

  const layerIds = LAYERS.map(l => l.id);
  let totalAdded = 0;
  const newSightings = [];  // accumulate for timeline bound update

  // Process newest-first so users see recent history appear before older data
  for (let year = currentYear - 1; year >= INAT_HISTORY_START_YEAR; year--) {
    // Update the Trends panel status indicator
    const statusEl = document.getElementById('history-load-status');
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.textContent = `\u21bb Loading historical records\u2026 ${year}`;
    }

    const cacheKey = `obs/inat/year-${year}`;
    const ttl      = year < currentYear - 1 ? HIST_TTL_OLD : HIST_TTL_PREV;

    try {
      // Try browser cache first (will be warm after first visit)
      let byLayer = await cacheGet(cacheKey);

      if (byLayer === null) {
        // Not cached — fetch from server proxy (pre-warmed) or direct iNat fallback
        const { observations } = await fetchObservationsForYear(year);
        const geojson  = observationsToGeoJSON(observations);
        byLayer        = partitionByLayer(geojson, layerIds);
        await cacheSet(cacheKey, byLayer, ttl);
      }

      // Merge, deduplicating by observation id
      let yearAdded = 0;
      for (const layerId of layerIds) {
        const newFeats = (byLayer[layerId] ?? []).filter(f => {
          const id = f.properties?.id;
          if (id == null || _inatLoadedIds.has(id)) return false;
          _inatLoadedIds.add(id);
          return true;
        });
        if (newFeats.length === 0) continue;

        _inatByLayer[layerId] = [...(_inatByLayer[layerId] ?? []), ...newFeats];
        setBaseFeatures(layerId, _inatByLayer[layerId]);
        yearAdded += newFeats.length;

        if (layerId === 'pollinators') {
          newSightings.push(...newFeats);
          _allSightings.push(...newFeats);     // extend heatmap cache incrementally
        }
        if (layerId === 'native-plants') {
          _allNativePlants.push(...newFeats);  // extend native plant heatmap cache
        }
      }

      if (yearAdded > 0) {
        totalAdded += yearAdded;
        applyFilters();

        // Re-render both heatmaps with the current timeline window applied
        updatePollinatorTrafficHeatmap(
          _filterSightingsByYear(_allSightings, _timelineStartYear, _timelineEndYear, _timelineActiveMonths)
        );
        updateNativePlantHeatmap(
          _filterSightingsByYear(_allNativePlants, _timelineStartYear, _timelineEndYear, _timelineActiveMonths)
        );

        // Update layer count badges in the panel
        const countPatch = {};
        for (const lid of layerIds) countPatch[lid] = _inatByLayer[lid]?.length ?? 0;
        updateCounts(countPatch);

        // Update intel bar pollinator count
        const pollinatorEl = document.getElementById('intel-val-inat');
        if (pollinatorEl) {
          const inatPolls = _inatByLayer['pollinators']?.length ?? 0;
          pollinatorEl.textContent = (inatPolls + _gbifPollinators.length).toLocaleString();
        }
      }
    } catch (err) {
      console.warn(`[inat-history] ${year} failed:`, err.message);
    }

    // Tiny yield between years — gives the browser a chance to paint and keeps
    // the apparent "loading" from spinning the event loop.
    await new Promise(r => setTimeout(r, 50));
  }

  // Extend the timeline scrubber back to cover newly-loaded historical dates
  if (newSightings.length > 0) {
    updateTimelineBounds(newSightings);
  }

  // Clear the Trends panel status indicator
  const statusEl = document.getElementById('history-load-status');
  if (statusEl) statusEl.hidden = true;

  if (totalAdded > 0) {
    console.log(`[inat-history] +${totalAdded} historical observations merged`);
  }
}

// ── Lazy data loaders (parcel + commons) ──────────────────────────────────────

/** Debounce helper — returns a version of fn that delays execution by ms. */
function _debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/**
 * Viewport-gated parcel fetch.  Called on moveend / zoomend whenever the
 * Parcel Ownership layer is active.  Only fires at zoom ≥ 13 (finer queries
 * time out on the county GIS server).
 */
const _refreshParcelViewport = _debounce(async () => {
  if (!document.getElementById('toggle-parcels')?.checked) return;
  if (map.getZoom() < 13) return;
  const b    = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  try {
    const feats  = await fetchParcelsForBbox(bbox);
    _parcelFeatures = feats;
    _parcelLoaded   = true;
    setMapParcelFeatures({ type: 'FeatureCollection', features: feats }, classifyOwnership);
    setDrawerParcelFeatures(feats);
    if (_lastAlertArgs) {
      _lastAlertArgs = { ..._lastAlertArgs, parcelFeatures: feats };
      const updatedAlerts = computeAlerts({ ..._lastAlertArgs, nestingScores: _nestingScores, canopyScores: _canopyScores });
      if (_alertFocusHandler) renderAlerts(updatedAlerts, _alertFocusHandler);
      // Sync ribbon and export snapshot so all counts agree
      document.getElementById('intel-val-alerts').textContent = updatedAlerts.length;
      document.getElementById('intel-alerts')?.classList.toggle('intel-stat--has-alerts', updatedAlerts.length > 0);
      _updateAlertBadge(updatedAlerts.length);
      setExportData({ alerts: updatedAlerts });
    }
  } catch (err) {
    console.warn('Parcel viewport fetch failed:', err);
    const hint = document.getElementById('parcel-zoom-hint-panel');
    if (hint) hint.textContent = 'Parcel data unavailable — county GIS endpoint could not be reached.';
  }
}, 800);

/**
 * Fetches Wikimedia Commons geotagged photos near the map centre on the first
 * time the Commons Photos layer is enabled.
 */
async function _lazyFetchCommons() {
  try {
    const center = map.getCenter().toArray();
    console.debug('[commons] fetching near', center);
    const images = await fetchCommonsForApp(center);
    console.debug('[commons] fetched', images.length, 'images');
    _commonsLoaded = true;
    setDrawerCommonsImages(images);
    const features = images
      .filter(img => img.lat && img.lng)
      .map(img => ({
        type:       'Feature',
        geometry:   { type: 'Point', coordinates: [img.lng, img.lat] },
        properties: {
          pageId:      img.pageId,
          title:       img.title,
          thumburl:    img.thumburl,
          description: img.description,
          artist:      img.artist,
          license:     img.license,
          descurl:     img.descurl,
        },
      }));
    console.debug('[commons] features with coords:', features.length);
    setMapCommonsFeatures({ type: 'FeatureCollection', features });
    updateCounts({ 'commons-photos': images.length });
  } catch (err) {
    console.warn('Commons photos unavailable:', err);
  }
}

// ── Data loading ──────────────────────────────────────────────────────────────

/**
 * Reads the current date inputs, loads observations and area data — serving
 * from the browser cache when available, and fetching from APIs only when a
 * cache entry is absent or expired.
 *
 * Cache TTLs:
 *   Observation data (iNat / GBIF)        — 1 hour,  keyed by date range
 *   Static area data (PAD-US, DNR, GBCC)  — 24 hours, fixed keys
 *
 * Changing the date range produces a different cache key for observations,
 * which triggers a fresh network fetch automatically.
 */
async function loadObservations() {
  // No date restriction — fetch all available history. The timeline scrubber
  // handles in-memory filtering by year range after data is loaded.

  setLoading(true);
  closePopup();
  setStatus('Loading…');

  // ── Restore cached parcel data so alerts run with ownership context immediately
  // without waiting for the user to enable the Parcel Ownership layer.
  // The cache is populated by the background prefetch at the end of this function.
  try {
    const cachedParcels = await cacheGet('parcels/alert-region');
    if (Array.isArray(cachedParcels) && cachedParcels.length > 0) {
      hydrateParcelCache(cachedParcels);
      _parcelFeatures = cachedParcels;
      _parcelLoaded   = true;
      setDrawerParcelFeatures(cachedParcels);
      console.log(`[parcels] restored ${cachedParcels.length} features from cache`);
    }
  } catch { /* cache miss or unavailable — continue without */ }

  // TTL constants
  const OBS_TTL  =      60 * 60 * 1000;  // 1 h  — re-fetch when dates change
  const AREA_TTL = 24 * 60 * 60 * 1000;  // 24 h — area datasets change rarely

  // Embed dates in observation cache keys so a date change is a natural miss.
  const obsKey = 'all';

  // Tracks how many sources required a real network fetch this call.
  let networkFetches = 0;

  /**
   * Returns cached data when present and fresh; otherwise calls fetcher(),
   * writes the result to cache, and returns the result.
   * Propagates fetcher errors so Promise.allSettled captures them correctly.
   */
  async function withCache(key, ttlMs, fetcher) {
    const hit = await cacheGet(key);
    if (hit !== null) return hit;
    networkFetches++;
    const val = await fetcher();
    await cacheSet(key, val, ttlMs);
    return val;
  }

  try {
    // All sources run in parallel. Failures in one never block the others.
    // Each promise is wrapped to update the loading progress counter as sources settle.
    const TOTAL_SOURCES = 17;
    let   _settled      = 0;
    const _phases       = [
      // indices 0-4: observations
      ...[0,1,2,3,4].map(() => 'Fetching observations'),
      // indices 5-15: area data
      ...[5,6,7,8,9,10,11,12,13,14,15].map(() => 'Loading area data'),
      // index 16: pesticide
      'Loading area data',
    ];
    function _tracked(p, idx) {
      return p.then(
        v => { setLoadingProgress(++_settled, TOTAL_SOURCES, _phases[idx]); return v; },
        e => { setLoadingProgress(++_settled, TOTAL_SOURCES, _phases[idx]); return Promise.reject(e); },
      );
    }

    const [
      inatResult, gbifPollResult, gbifPlantResult, gbifWildlifeResult, beesResult,
      padusResult, snaResult, dnrResult,
      corridorResult, treatmentResult, pfasResult, hnpResult, cdlStatsResult,
      quickStatsResult, cdlFringeResult, ebirdResult, pesticideResult,
    ] = await Promise.allSettled([

      // ── Observations (date-keyed, 1 h TTL) ──────────────────────────────
      // Caches the fully-processed layer partition so partitionByLayer and
      // observationsToGeoJSON are also skipped on a cache hit.
      _tracked(withCache(`obs/inat/all`, OBS_TTL, async () => {
        const { observations, total } = await fetchObservations(undefined, undefined);
        const geojson  = observationsToGeoJSON(observations);
        const byLayer  = partitionByLayer(geojson, LAYERS.map(l => l.id));
        byLayer._total = total;  // stored alongside layer arrays
        return byLayer;
      }), 0),

      // Caches the final GeoJSON features array — resolveOccurrenceEstKeys
      // (which makes extra iNat API calls) is also skipped on a cache hit.
      _tracked(withCache(`obs/gbif-poll/v3`, OBS_TTL, async () => {
        const { occurrences } = await fetchGbifPollinators(undefined, undefined);
        const estMap = await resolveOccurrenceEstKeys(occurrences);
        return gbifToGeoJSON(occurrences, 'gbif-pollinators', estMap).features;
      }), 1),

      _tracked(withCache(`obs/gbif-plants/v2`, OBS_TTL, async () => {
        const { occurrences }       = await fetchGbifPlants(undefined, undefined);
        const { native, nonNative } = await partitionPlantOccurrences(occurrences);
        return {
          native:    gbifToGeoJSON(native,    'gbif-native-plants').features,
          nonNative: gbifToGeoJSON(nonNative, 'gbif-non-native-plants').features,
        };
      }), 2),

      _tracked(withCache(`obs/gbif-wildlife/v1`, OBS_TTL, async () => {
        const { occurrences } = await fetchGbifWildlife(undefined, undefined);
        return gbifToGeoJSON(occurrences, 'gbif-wildlife').features;
      }), 3),

      _tracked(withCache(`obs/bees/v1`, OBS_TTL, async () => {
        const { occurrences } = await fetchBeesAll(undefined, undefined);
        return beesToGeoJSON(occurrences, 'bees-records').features;
      }), 4),

      // ── Static area data (fixed keys, 24 h TTL) ──────────────────────────────────────────────
      _tracked(withCache('area/padus',          AREA_TTL, fetchPadUs), 5),
      _tracked(withCache('area/dnr-sna',        AREA_TTL, fetchDnrSna), 6),
      _tracked(withCache('area/dnr-managed',    AREA_TTL, fetchDnrManagedLands), 7),
      _tracked(withCache('area/gbcc-corridor',  AREA_TTL, fetchPollinatorCorridor), 8),
      _tracked(withCache('area/gbcc-treatment', AREA_TTL, fetchCorridorTreatments), 9),
      _tracked(withCache('area/dnr-pfas',       AREA_TTL, fetchChemicalHazards), 10),
      _tracked(withCache('area/hnp',            AREA_TTL, fetchHnpYards), 11),
      _tracked(withCache('area/cdl-stats',       AREA_TTL, fetchCdlStats), 12),
      _tracked(withCache('area/quickstats',        AREA_TTL, fetchQuickStats), 13),
      _tracked(withCache('area/cdl-fringe',        AREA_TTL, fetchCdlFringe), 14),

      // ── eBird recent bird observations (1 h TTL, always last 30 days) ───
      _tracked(withCache(`obs/ebird/all`, OBS_TTL, () => fetchEbirdObservations()), 15),

      // ── Pesticide county choropleth (24 h TTL, static county data) ──────────
      _tracked(withCache('area/pesticide', AREA_TTL, fetchPesticideCounties), 16),
    ]);

    setLoadingProgress(TOTAL_SOURCES, TOTAL_SOURCES, 'Rendering layers');
    const counts = {};
    let inatObs = 0, inatTotal = 0, gbifCount = 0;

    // ── iNaturalist ───────────────────────────────────────────────────────────
    if (inatResult.status === 'fulfilled') {
      const byLayer = inatResult.value;
      inatTotal = byLayer._total ?? 0;
      for (const layer of LAYERS) {
        const feats = byLayer[layer.id] ?? [];
        setLayerFeatures(layer.id, feats);
        counts[layer.id] = feats.length;
        inatObs += feats.length;
        // Seed deduplication set so the background historical loader skips these
        for (const f of feats) { const id = f.properties?.id; if (id != null) _inatLoadedIds.add(id); }
      }
    } else {
      console.error('iNaturalist failed:', inatResult.reason);
      for (const l of LAYERS) counts[l.id] = 0;
    }

    // ── GBIF Pollinators ──────────────────────────────────────────────────────
    if (gbifPollResult.status === 'fulfilled') {
      const feats = gbifPollResult.value;
      setLayerFeatures('gbif-pollinators', feats);
      counts['gbif-pollinators'] = feats.length;
      gbifCount += feats.length;
    } else {
      console.warn('GBIF pollinators failed:', gbifPollResult.reason);
      counts['gbif-pollinators'] = 0;
    }

    // ── GBIF Plants (native / non-native) ─────────────────────────────────────
    if (gbifPlantResult.status === 'fulfilled') {
      const { native, nonNative } = gbifPlantResult.value;
      setLayerFeatures('gbif-native-plants',     native);
      setLayerFeatures('gbif-non-native-plants', nonNative);
      counts['gbif-native-plants']     = native.length;
      counts['gbif-non-native-plants'] = nonNative.length;
      gbifCount += native.length + nonNative.length;
    } else {
      console.warn('GBIF plants failed:', gbifPlantResult.reason);
      counts['gbif-native-plants']     = 0;
      counts['gbif-non-native-plants'] = 0;
    }

    // ── GBIF Wildlife (non-pollinator animals) ────────────────────────────────
    if (gbifWildlifeResult.status === 'fulfilled') {
      const feats = gbifWildlifeResult.value;
      setLayerFeatures('gbif-wildlife', feats);
      counts['gbif-wildlife'] = feats.length;
      gbifCount += feats.length;
    } else {
      console.warn('GBIF wildlife failed:', gbifWildlifeResult.reason);
      counts['gbif-wildlife'] = 0;
    }

    // ── FWS Bee Distribution (all 6 families) ─────────────────────────────────
    if (beesResult.status === 'fulfilled') {
      const allFeats       = beesResult.value;
      const imperiledFeats = filterImperiledFeatures(allFeats);
      setLayerFeatures('bees-records',   allFeats);
      setLayerFeatures('bees-imperiled', imperiledFeats);
      updateBeeRichnessHeatmap(allFeats);
      counts['bees-records']   = allFeats.length;
      counts['bees-imperiled'] = imperiledFeats.length;
    } else {
      console.warn('Bee distribution failed:', beesResult.reason);
      counts['bees-records']   = 0;
      counts['bees-imperiled'] = 0;
    }


    // ── PAD-US protected areas ────────────────────────────────────────
    if (padusResult.status === 'fulfilled') {
      setAreaFeatures('padus', padusResult.value);
      counts['padus'] = padusResult.value.features.length;
    } else {
      console.warn('PAD-US failed:', padusResult.reason);
      counts['padus'] = 0;
    }

    // ── WI DNR State Natural Areas ────────────────────────────────────
    if (snaResult.status === 'fulfilled') {
      setAreaFeatures('dnr-sna', snaResult.value);
      counts['dnr-sna'] = snaResult.value.features.length;
    } else {
      console.warn('WI DNR SNA failed:', snaResult.reason);
      counts['dnr-sna'] = 0;
    }

    // ── WI DNR Managed Lands ──────────────────────────────────────────
    if (dnrResult.status === 'fulfilled') {
      setAreaFeatures('dnr-managed', dnrResult.value);
      counts['dnr-managed'] = dnrResult.value.features.length;
    } else {
      console.warn('WI DNR Managed Lands failed:', dnrResult.reason);
      counts['dnr-managed'] = 0;
    }

    // ── GBCC Pollinator Corridor ──────────────────────────────────────
    if (corridorResult.status === 'fulfilled') {
      setAreaFeatures('gbcc-corridor', corridorResult.value);
      const _corridorCentroids = corridorCentroids(corridorResult.value);
      setAreaMarkersFeatures('gbcc-corridor', _corridorCentroids);
      counts['gbcc-corridor'] = corridorResult.value.features.length;
      // Async: fetch NLCD nesting scores and update badges progressively
      fetchNestingScores(_corridorCentroids.features).then(scores => {
        _nestingScores = scores;
        _nestingLoaded = true;
        setDrawerNestingScores(scores);
        const enriched = enrichCentroidsWithNesting(_corridorCentroids, scores);
        setNestingBadgeFeatures(enriched);
        syncNestingBadgeVisibility();
        // Re-render alerts to include the poor-nesting-habitat alert
        if (_lastAlertArgs) {
          const updatedAlerts = computeAlerts({ ..._lastAlertArgs, nestingScores: scores, canopyScores: _canopyScores });
          renderAlerts(updatedAlerts, _alertFocusHandler);
          // Sync ribbon and export snapshot so all counts agree
          _lastAlertCount = updatedAlerts.length;
          document.getElementById('intel-val-alerts').textContent = updatedAlerts.length;
          document.getElementById('intel-alerts')?.classList.toggle('intel-stat--has-alerts', updatedAlerts.length > 0);
          _updateAlertBadge(updatedAlerts.length);
          setExportData({ alerts: updatedAlerts, nestingScores: scores });
        }
      }).catch(() => { /* nesting scores unavailable — silent degradation */ });

      // Async: fetch WI DNR tree canopy coverage scores after corridor data loads
      fetchCanopyScores(_corridorCentroids.features).then(scores => {
        _canopyScores = scores;
        setDrawerCanopyScores(scores);
        if (_lastAlertArgs) {
          const updatedAlerts = computeAlerts({ ..._lastAlertArgs, nestingScores: _nestingScores, canopyScores: scores });
          renderAlerts(updatedAlerts, _alertFocusHandler);
          _lastAlertCount = updatedAlerts.length;
          document.getElementById('intel-val-alerts').textContent = updatedAlerts.length;
          document.getElementById('intel-alerts')?.classList.toggle('intel-stat--has-alerts', updatedAlerts.length > 0);
          _updateAlertBadge(updatedAlerts.length);
          setExportData({ alerts: updatedAlerts });
        }
      }).catch(() => { /* canopy scores unavailable — silent degradation */ });

      // Async: fetch per-cell NLCD scores for the full analysis grid
      fetchGridNlcdScores(CENTER[0], CENTER[1], RADIUS_KM).then(scores => {
        _gridNlcdScores = scores;
        updateInVESTHeatmap(computeInVESTHeatmap(_gridNlcdScores, CENTER[0], CENTER[1], RADIUS_KM));
      }).catch(() => { /* grid NLCD unavailable — silent degradation */ });
    } else {
      console.warn('GBCC corridor failed:', corridorResult.reason);
      counts['gbcc-corridor'] = 0;
    }

    // ── GBCC Habitat Treatments ───────────────────────────────────────
    if (treatmentResult.status === 'fulfilled') {
      setAreaFeatures('gbcc-treatment', treatmentResult.value);
      counts['gbcc-treatment'] = treatmentResult.value.features.length;
      registerTemporalLayer(
        'gbcc-treatment',
        treatmentResult.value.features,
        f => f.properties?.date,
        filtered => setAreaFeatures('gbcc-treatment', { type: 'FeatureCollection', features: filtered }),
      );
    } else {
      console.warn('GBCC treatments failed:', treatmentResult.reason);
      counts['gbcc-treatment'] = 0;
    }

    // ── WI DNR PFAS Chemical Hazard Sites ────────────────────────────
    if (pfasResult.status === 'fulfilled') {
      setLayerFeatures('dnr-pfas', pfasResult.value.features);
      counts['dnr-pfas'] = pfasResult.value.features.length;
    } else {
      console.warn('PFAS sites failed:', pfasResult.reason);
      counts['dnr-pfas'] = 0;
    }
    // ── Homegrown National Park native planting yards ────────────────────
    if (hnpResult.status === 'fulfilled') {
      setLayerFeatures('hnp', hnpResult.value.features);
      counts['hnp'] = hnpResult.value.features.length;
    } else {
      console.warn('HNP failed:', hnpResult.reason);
      counts['hnp'] = 0;
    }

    // ── eBird bird sightings ────────────────────────────────────────────────────
    let ebirdCount = 0;
    if (ebirdResult.status === 'fulfilled') {
      const ebirdFeats = ebirdResult.value.features ?? [];
      _ebirdAllFeats = ebirdFeats;
      setLayerFeatures('ebird', ebirdFeats);
      setBaseFeatures('ebird', ebirdFeats);
      counts['ebird'] = ebirdFeats.length;
      ebirdCount = ebirdFeats.length;
    } else {
      console.warn('eBird failed:', ebirdResult.reason);
      counts['ebird'] = 0;
    }

    const cdlStats   = cdlStatsResult.status   === 'fulfilled' ? cdlStatsResult.value   : null;
    const quickStats  = quickStatsResult.status  === 'fulfilled' ? quickStatsResult.value  : null;
    if (!cdlStats) console.warn('CDL stats unavailable (API returned null or failed)');
    // Waystations are static/synchronous — count them now so the badge is included
    // in the single updateCounts() call below (they were previously set too late).
    _waystationFeats = waystationGeoJSON().features;
    counts['waystations'] = _waystationFeats.length;
    updateCounts(counts);

    const capped     = inatObs < inatTotal;
    const cacheLabel = networkFetches === 0 ? ' · cached' : '';
    setStatus(
      `iNat: ${inatObs.toLocaleString()} / ${inatTotal.toLocaleString()}${capped ? ' ▲' : ''}` +
      ` · GBIF: ${gbifCount.toLocaleString()}${cacheLabel}`
    );

    // ── Intelligence modules ─────────────────────────────────────────────────

    // Collect unified feature sets for cross-module consumers
    const inatFeatures = inatResult.status === 'fulfilled' ? inatResult.value : {};
    const allPollinatorFeatures = [
      ...(inatFeatures['pollinators']       ?? []),
      ...(inatFeatures['native-plants']     ?? []),
      ...(gbifPollResult.status === 'fulfilled'  ? gbifPollResult.value              : []),
      ...(gbifPlantResult.status === 'fulfilled' ? gbifPlantResult.value.native      : []),
      ...(gbifPlantResult.status === 'fulfilled' ? gbifPlantResult.value.nonNative   : []),
    ];

    _corridorFeats            = corridorResult.status === 'fulfilled' ? corridorResult.value.features : [];
    _confirmedWaystationFeats = _waystationFeats.filter(f => !f.properties.approximate);
    const corridorFeats       = _corridorFeats;
    const waystationFeats     = _waystationFeats;
    const confirmedWaystationFeats = _confirmedWaystationFeats;
    const pfasFeats        = pfasResult.status      === 'fulfilled' ? pfasResult.value.features     : [];
    _hnpFeats              = hnpResult.status       === 'fulfilled' ? hnpResult.value.features      : [];
    _hnpCount              = _hnpFeats.length;
    const hnpFeats         = _hnpFeats;
    const allHabitatFeats  = [...corridorFeats, ...waystationFeats, ...hnpFeats];

    // Drawer data
    setDrawerSightings(allPollinatorFeatures);
    setDrawerHabitatSites(allHabitatFeats);

    // Filter chip base features
    const byLayer = inatResult.status === 'fulfilled' ? inatResult.value : {};
    // Cache for intel drawer click handlers
    _inatByLayer      = byLayer;
    _gbifPollinators  = gbifPollResult.status  === 'fulfilled' ? gbifPollResult.value              : [];
    _gbifNativePlants = gbifPlantResult.status === 'fulfilled' ? gbifPlantResult.value.native      : [];
    for (const layer of LAYERS) setBaseFeatures(layer.id, byLayer[layer.id] ?? []);
    setBaseFeatures('gbif-pollinators',       gbifPollResult.status     === 'fulfilled' ? gbifPollResult.value              : []);
    setBaseFeatures('gbif-native-plants',     gbifPlantResult.status    === 'fulfilled' ? gbifPlantResult.value.native      : []);
    setBaseFeatures('gbif-non-native-plants', gbifPlantResult.status    === 'fulfilled' ? gbifPlantResult.value.nonNative   : []);
    setBaseFeatures('gbif-wildlife',          gbifWildlifeResult.status === 'fulfilled' ? gbifWildlifeResult.value          : []);
    setBaseFeatures('bees-records',           beesResult.status         === 'fulfilled' ? beesResult.value                  : []);
    setBaseFeatures('bees-imperiled',         beesResult.status         === 'fulfilled' ? filterImperiledFeatures(beesResult.value) : []);

    // Habitat centroids for near-habitat filter
    const habitatCoords = allHabitatFeats.map(f => {
      const g = f.geometry;
      if (!g) return null;
      if (g.type === 'Point') return g.coordinates;
      const ring = g.coordinates?.[0];
      if (!ring?.length) return null;
      return [
        ring.reduce((s, c) => s + c[0], 0) / ring.length,
        ring.reduce((s, c) => s + c[1], 0) / ring.length,
      ];
    }).filter(Boolean);
    setHabitatCoords(habitatCoords);

    // Pesticide county choropleth — must be resolved before computeAlerts
    const pesticideCounties = pesticideResult.status === 'fulfilled' && pesticideResult.value
      ? pesticideResult.value.features : [];
    if (pesticideResult.status === 'fulfilled' && pesticideResult.value) {
      setPesticideFeatures('pesticide', pesticideResult.value);
    } else if (pesticideResult.status === 'rejected') {
      console.warn('Pesticide county data unavailable:', pesticideResult.reason);
    }

    // Alerts — approximate waystations are excluded from connectivity calculations
    // because their location is not known at address precision.
    _lastAlertArgs = {
      corridorFeatures:    corridorFeats,
      waystationFeatures:  confirmedWaystationFeats,
      pfasFeatures:        pfasFeats,
      pollinatorSightings: allPollinatorFeatures,
      hnpFeatures:         hnpFeats,
      cdlStats,
      quickStats,
      climateData:         getClimateState(),
      pesticideCounties,
      parcelFeatures:      _parcelFeatures,
      activeLayerIds:      [..._activeLayerIds],
      layerVintages:       LAYER_VINTAGES,
    };
    const alerts = computeAlerts({ ..._lastAlertArgs, nestingScores: _nestingScores, canopyScores: _canopyScores });
    _alertFocusHandler = alert => {
      // Activate any heatmaps tied to this alert and sync their toggle checkboxes.
      for (const heatId of alert.heatmaps ?? []) {
        setHeatmapVisibility(heatId, true);
        const toggle = document.getElementById(`toggle-${heatId.replace(/-heat$/, '')}`);
        if (toggle) toggle.checked = true;
      }
      // Ensure all layers relevant to this alert are visible before zooming.
      for (const layerId of alert.layers ?? []) {
        setLayerActive(layerId, true);
      }
      if (!alert.coords?.length) return;
      showAlertHighlight(alert.coords, alert.level);
      const isGap = alert.key === 'connectivity-gap';
      fitToCoords(alert.coords, {
        padding: { top: 80, bottom: 100, left: 540, right: 80 },
        maxZoom: isGap ? 12 : 15,
      });
      // Public land gap: also open a contextual info drawer
      if (alert.key?.startsWith('public-land-gap')) {
        const [lng, lat] = alert.coords[0];
        const parcelText = alert.text.startsWith('High-Value Public Land Gap:')
          ? alert.text.replace(/^High-Value Public Land Gap:\s*/, '').replace(/\s*\u2014\s*no habitat.*$/i, '')
          : alert.text;
        const publicLandHtml = _buildExpansionPublicLandSection({ lng, lat });
        const body = `
          <div class="drawer-severity-badge" style="background:rgba(245,158,11,0.12);border-color:rgba(245,158,11,0.35);color:#f59e0b">
            <span class="drawer-severity-dot" style="background:#f59e0b"></span>
            HIGH-VALUE OPPORTUNITY
          </div>
          <div class="drawer-section-label">Location</div>
          <p class="drawer-intel-note" style="margin-top:4px">${parcelText}</p>
          <div class="drawer-section-label">Why This Is Actionable</div>
          <p class="drawer-intel-note">This parcel sits in an active pollinator opportunity zone — an area with documented pollinators but no formal habitat program within 800 m. Because it is publicly owned, no private negotiation is needed. Habitat improvements can be proposed directly through the parks department or municipal planning process.</p>
          ${publicLandHtml || '<p class="drawer-intel-note" style="margin-top:8px;color:#6b7280">Enable the Parcel Ownership layer and zoom to level 13 or higher to load contact details for this location.</p>'}`;
        openIntelDrawer('High-Value Public Land Gap', body, {
          headerStyle: 'background:#451a03',
          labelHtml:   '<i class="ph ph-buildings"></i> Opportunity',
        });
      }
    };
    renderAlerts(alerts, _alertFocusHandler);

    // ── Analysis layers — expansion, problems, suitability ───────────────────
    const _analysisCtx = {
      corridorFeatures:    corridorFeats,
      waystationFeatures:  confirmedWaystationFeats,
      hnpFeatures:         hnpFeats,
      pfasFeatures:        pfasFeats,
      pollinatorSightings: allPollinatorFeatures,
      pesticideCounties,
    };
    const _expansionFC = computeExpansionOpportunities({
      ..._analysisCtx,
      nestingScores: _nestingScores,
    });
    updateExpansionOpportunitiesLayer(_expansionFC);
    setExportData({ expansionFeatures: _expansionFC.features, parcelFeatures: _parcelFeatures });
    updateProblemAreasLayer(computeProblemFeatures({
      ..._analysisCtx,
      nestingScores: _nestingScores,
      canopyScores:  _canopyScores,
    }));

    // Timeline bounds
    updateTimelineBounds(allPollinatorFeatures);

    // Heatmaps — update with latest habitat node data
    refreshConnectivityMesh();
    // UUID for the iNaturalist Research-grade Observations dataset on GBIF.
    // Records carrying this key are already included via the direct iNat API
    // fetch; excluding them from the GBIF contribution prevents double-counting.
    const INAT_DATASET_KEY = '50c9509d-22c7-4a22-a47d-8c48425ef4a7';

    _allSightings = [
      // iNat pollinators only (butterflies, bees, etc.) — exclude plants and non-pollinator wildlife
      ...(inatResult.status === 'fulfilled' ? (inatResult.value['pollinators'] ?? []) : []),
      // GBIF pollinators — exclude records that originated on iNaturalist (already in the iNat slice)
      ...(gbifPollResult.status === 'fulfilled'
        ? gbifPollResult.value.filter(f => f.properties?.datasetKey !== INAT_DATASET_KEY)
        : []),
      // eBird: hummingbirds only (the only reliable pollinator birds in Green Bay area)
      ...(ebirdResult.status === 'fulfilled'
        ? (ebirdResult.value.features ?? []).filter(f =>
            f.properties?.common?.toLowerCase().includes('hummingbird'))
        : []),
    ];
    updatePollinatorTrafficHeatmap(_allSightings);

    // Native plant density heatmap — iNat native plants + GBIF native plants,
    // with iNaturalist-sourced GBIF records stripped to avoid double-counting.
    _allNativePlants = [
      ...(inatResult.status === 'fulfilled' ? (inatResult.value['native-plants'] ?? []) : []),
      ...(gbifPlantResult.status === 'fulfilled'
        ? gbifPlantResult.value.native.filter(f => f.properties?.datasetKey !== INAT_DATASET_KEY)
        : []),
    ];
    updateNativePlantHeatmap(_allNativePlants);

    // CDL fringe — static per-load; update source data once available
    if (cdlFringeResult.status === 'fulfilled' && cdlFringeResult.value) {
      updateCdlFringeHeatmap(cdlFringeResult.value);
    }

    // Combined pollinator count: iNat pollinators + GBIF pollinators
    const pollinatorCount =
      (byLayer['pollinators']?.length ?? 0) +
      (gbifPollResult.status === 'fulfilled' ? gbifPollResult.value.length : 0);

    // Corridor habitat area (sum of area_sqft across all corridor polygons)
    const corridorSqFt = _corridorFeats.reduce((sum, f) => sum + (+(f.properties?.area_sqft ?? 0)), 0);

    // Total active habitat network nodes (corridor centroids + waystations + HNP yards)
    const habitatNodeCount = _corridorFeats.length + _waystationFeats.length + _hnpFeats.length;

    // Unique native plant species observed (iNat + GBIF native-plants, deduplicated by scientific name)
    const nativeSpeciesCount = new Set([
      ...(inatResult.status === 'fulfilled' ? (inatResult.value['native-plants'] ?? []).map(f => f.properties?.name).filter(Boolean) : []),
      ...(gbifPlantResult.status === 'fulfilled' ? gbifPlantResult.value.native.map(f => f.properties?.name).filter(Boolean) : []),
    ]).size;

    // Intel bar
    updateIntelBar({
      corridorSqFt,
      hnpCount:          _hnpCount,
      habitatNodeCount,
      pollinatorCount,
      gddStat:           getGddIntelStat(),
      ebirdCount,
      nativeSpeciesCount,
      alertCount:        alerts.length,
    });
    _lastAlertCount = alerts.length;

    // Export snapshot
    const _topSpecies = (() => {
      const freq = {};
      for (const f of byLayer['pollinators'] ?? []) {
        const sp = f.properties?.common || f.properties?.name;
        if (sp) freq[sp] = (freq[sp] || 0) + 1;
      }
      return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 15)
        .map(([name, count]) => ({ name, count }));
    })();

    setExportData({
      corridorCount:      counts['gbcc-corridor'] ?? 0,
      waystationCount:    _waystationFeats.length,
      inatCount:          inatObs,
      gbifCount,
      dateFrom:           '',
      dateTo:             '',
      alerts,
      corridorFeatures:   corridorFeats,
      waystationFeatures: waystationFeats,
      mapZoom:            map.getZoom(),
      mapCenter:          map.getCenter().toArray(),
      activeFilters:      [],
      // Extended fields
      hnpCount:           _hnpFeats.length,
      ebirdCount,
      habitatNodeCount,
      pollinatorCount,
      nativeSpeciesCount,
      corridorSqFt,
      inatByLayer: {
        pollinators:    counts['pollinators']    ?? 0,
        nativePlants:   counts['native-plants']  ?? 0,
        otherPlants:    counts['other-plants']   ?? 0,
        otherWildlife:  counts['other-wildlife'] ?? 0,
      },
      gbifByLayer: {
        pollinators:     counts['gbif-pollinators']       ?? 0,
        nativePlants:    counts['gbif-native-plants']     ?? 0,
        nonNativePlants: counts['gbif-non-native-plants'] ?? 0,
        wildlife:        counts['gbif-wildlife']          ?? 0,
      },
      beeRecords:   counts['bees-records']   ?? 0,
      beeImperiled: counts['bees-imperiled'] ?? 0,
      topSpecies:         _topSpecies,
      pfasFeatures:       pfasFeats,
      cdlStats,
      quickStats,
      climateState:       getClimateState(),
      pesticideCounties,
      nestingScores:      _nestingScores,
      padusCount:         counts['padus']         ?? 0,
      snaCount:           counts['dnr-sna']        ?? 0,
      dnrManagedCount:    counts['dnr-managed']    ?? 0,
    });

  } catch (err) {
    console.error('Failed to load:', err);
    setStatus('Error — check console');
  } finally {
    setLoading(false);
  }

  // ── Background parcel prefetch for alert-region coverage ─────────────────────
  // Runs after the UI is unblocked.  Fetches all tiles that cover the
  // full 15 km study area (the same region the server pre-warms) so
  // parcel ownership data is available for alerting on every page load
  // — even before the user enables the Parcel Ownership map layer.
  //
  // The server pre-warms all 300 tiles over ~12 min on startup, so by
  // the time a typical user interacts with the app each tile request is
  // an in-memory cache hit and returns in milliseconds.
  //
  // The result is persisted in the browser Cache API (12 h TTL) and
  // will be restored by the cacheGet block at the top of this function
  // on the next page load.
  const PARCEL_TTL = 12 * 60 * 60 * 1000; // 12 h
  setTimeout(async () => {
    // Bbox covering the full tile grid (slightly wider than 15 km radius)
    const FULL_BBOX = [-88.20, 44.40, -87.80, 44.70];
    try {
      const feats = await fetchParcelsForBbox(FULL_BBOX);
      if (feats.length === 0) return;

      // Update live alert state if alerts have already been computed
      const changed = feats.length > _parcelFeatures.length;
      _parcelFeatures = feats;
      _parcelLoaded   = true;
      setDrawerParcelFeatures(feats);
      setMapParcelFeatures({ type: 'FeatureCollection', features: feats }, classifyOwnership);

      if (changed && _lastAlertArgs) {
        _lastAlertArgs = { ..._lastAlertArgs, parcelFeatures: feats };
        const updatedAlerts = computeAlerts({ ..._lastAlertArgs, nestingScores: _nestingScores, canopyScores: _canopyScores });
        if (_alertFocusHandler) renderAlerts(updatedAlerts, _alertFocusHandler);
        document.getElementById('intel-val-alerts').textContent = updatedAlerts.length;
        document.getElementById('intel-alerts')?.classList.toggle('intel-stat--has-alerts', updatedAlerts.length > 0);
        _updateAlertBadge(updatedAlerts.length);
        setExportData({ alerts: updatedAlerts });
      }

      // Persist for next page load
      await cacheSet('parcels/alert-region', feats, PARCEL_TTL);
      console.log(`[parcels] background prefetch complete — ${feats.length} features cached`);
    } catch (err) {
      console.warn('[parcels] background prefetch failed:', err.message);
    }
  }, 3000); // 3 s delay — let the main render settle first
}
// ── Historical trends ─────────────────────────────────────────────────────────────────

/**
 * Fetch available snapshots and render year-over-year trend charts into
 * #panel-history-inner.  Called asynchronously after the main data load so
 * it never delays the primary render.
 *
 * Memory policy: holds at most 5 years x 2 sources = 10 small objects.
 * References are nullified after rendering to allow GC.
 */
// ── Trends panel ──────────────────────────────────────────────────────────────
// State: 'yearly' | 'monthly'
let _trendsView     = 'yearly';
let _trendsMonthYear = null; // selected year for monthly view

async function loadHistoricalTrends() {
  const container = document.getElementById('panel-history-inner');
  if (!container) return;

  let index;
  try { index = await fetchSnapshotIndex(); }
  catch { index = []; }

  const inatYears = availableYears(index, 'inat').slice(-8).reverse(); // newest first
  const noaaYears = availableYears(index, 'noaa').slice(-5);

  container.innerHTML = '';

  // Status line shown while auto-harvest is still running
  const statusLine = document.createElement('p');
  statusLine.id = 'history-load-status';
  statusLine.className = 'layer-desc trends-status-line';
  statusLine.hidden = true;
  container.appendChild(statusLine);

  if (!inatYears.length && noaaYears.length < 2) {
    statusLine.hidden = false;
    statusLine.textContent = '↻ Snapshot data is being collected automatically — check back in a few minutes.';
    return;
  }

  // ── View toggle ────────────────────────────────────────────────────────────
  const toggleWrap = document.createElement('div');
  toggleWrap.className = 'trends-toggle';
  toggleWrap.innerHTML =
    `<button class="trends-toggle-btn${_trendsView === 'yearly' ? ' trends-toggle-btn--active' : ''}" data-view="yearly">Yearly overview</button>` +
    `<button class="trends-toggle-btn${_trendsView === 'monthly' ? ' trends-toggle-btn--active' : ''}" data-view="monthly">Monthly detail</button>`;
  container.appendChild(toggleWrap);

  const chartsArea = document.createElement('div');
  chartsArea.id = 'trends-charts-area';
  container.appendChild(chartsArea);

  toggleWrap.querySelectorAll('.trends-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _trendsView = btn.dataset.view;
      toggleWrap.querySelectorAll('.trends-toggle-btn').forEach(b =>
        b.classList.toggle('trends-toggle-btn--active', b.dataset.view === _trendsView));
      _renderTrendsCharts(chartsArea, inatYears, noaaYears);
    });
  });

  await _renderTrendsCharts(chartsArea, inatYears, noaaYears);
}

async function _renderTrendsCharts(area, inatYears, noaaYears) {
  area.innerHTML = '';

  if (_trendsView === 'yearly') {
    await _renderYearlyView(area, inatYears, noaaYears);
  } else {
    await _renderMonthlyView(area, inatYears);
  }
}

async function _renderYearlyView(area, inatYears, noaaYears) {
  // Fetch up to 8 inat years — use pollinators+native-plants for the y-value
  // (scoped count: ignores other-plants and other-wildlife)
  let inatPoints = null;
  if (inatYears.length >= 2) {
    inatPoints = [];
    for (const yr of [...inatYears].reverse()) { // chronological order for chart
      const snap = await fetchSnapshot('inat', yr);
      if (snap) {
        const v = (snap.byLayer?.pollinators ?? 0) + (snap.byLayer?.['native-plants'] ?? 0);
        inatPoints.push({ year: yr, value: v || (snap.total ?? 0) });
      }
    }
  }

  if (inatPoints && inatPoints.length >= 2) {
    const wrap = document.createElement('div');
    wrap.className = 'history-chart-block';
    wrap.innerHTML =
      '<p class="layer-group-label" style="margin:0.5rem 0 0.25rem;">Pollinator &amp; native plant sightings by year</p>' +
      '<div id="history-chart-inat"></div>';
    area.appendChild(wrap);
    renderTrendChart('history-chart-inat', inatPoints, 'Pollinator and native plant sighting totals by year');
  }

  const noaaYearsAsc = [...(noaaYears ?? [])].sort((a, b) => a - b);
  if (noaaYearsAsc.length >= 2) {
    const noaaPoints = [];
    for (const yr of noaaYearsAsc) {
      const snap = await fetchSnapshot('noaa', yr);
      if (snap) noaaPoints.push({ year: yr, value: snap.gddTotal ?? 0 });
    }
    if (noaaPoints.length >= 2) {
      const wrap = document.createElement('div');
      wrap.className = 'history-chart-block';
      wrap.innerHTML =
        '<p class="layer-group-label" style="margin:0.75rem 0 0.25rem;">GDD accumulation (base 50 °F)</p>' +
        '<div id="history-chart-noaa"></div>';
      area.appendChild(wrap);
      renderTrendChart('history-chart-noaa', noaaPoints, 'Annual growing degree day totals by year');
    }
  }

  if (!area.firstChild) {
    area.innerHTML = '<p class="layer-desc trends-status-line">↻ Snapshots are being collected — check back soon.</p>';
  }
}

async function _renderMonthlyView(area, inatYears) {
  if (!inatYears.length) {
    area.innerHTML = '<p class="layer-desc trends-status-line">No iNaturalist snapshots yet.</p>';
    return;
  }

  // Year selector
  if (!_trendsMonthYear || !inatYears.includes(_trendsMonthYear)) {
    _trendsMonthYear = inatYears[0]; // default to most recent
  }

  const yearOpts = inatYears.map(y =>
    `<option value="${y}"${y === _trendsMonthYear ? ' selected' : ''}>${y}</option>`
  ).join('');

  const selRow = document.createElement('div');
  selRow.className = 'trends-year-row';
  selRow.innerHTML =
    `<label class="layer-desc" style="margin:0.4rem 0;">Year: <select class="trends-month-select" id="trends-year-picker">${yearOpts}</select></label>`;
  area.appendChild(selRow);

  const chartArea = document.createElement('div');
  chartArea.className = 'history-chart-block';
  chartArea.innerHTML = '<div id="history-chart-monthly"></div><div id="history-species-table"></div>';
  area.appendChild(chartArea);

  const loadYear = async (yr) => {
    chartArea.querySelector('#history-chart-monthly').innerHTML = '<p class="layer-desc" style="color:#6b7280;font-size:11px;">Loading…</p>';
    const snap = await fetchSnapshot('inat', yr);
    renderMonthlyChart('history-chart-monthly', snap?.byLayerByMonth ?? null, yr);
    renderSpeciesTable('history-species-table', snap?.topPollinators, snap?.topNativePlants);
  };

  await loadYear(_trendsMonthYear);

  selRow.querySelector('#trends-year-picker').addEventListener('change', async e => {
    _trendsMonthYear = parseInt(e.target.value, 10);
    await loadYear(_trendsMonthYear);
  });
}


// ── Map ready ─────────────────────────────────────────────────────────────────

map.on('load', async () => {

  // Register white vector icon sprites.
  // Must be called before registerAreaMarkersLayer and waystation registerLayer.
  // ðŸŒ¸ flower = pollinator corridor site pins  ðŸ¦‹ butterfly = waystation markers
  await registerSvgIcons();

  // 0. Raster background layers — rendered beneath all vector layers
  for (const layer of RASTER_LAYERS) {
    registerRasterLayer(layer.id, layer.defaultOn, layer.tileUrl, layer.attribution);
  }
  // 0b. NLCD per-class raster layers (16 toggleable land-cover types)
  for (const layer of NLCD_LAYERS) {
    registerRasterLayer(layer.id, layer.defaultOn, layer.tileUrl, layer.attribution);
  }
  // 0c. WI DNR tree canopy layers — all 3 survey years, all initially hidden
  for (const layer of TREE_CANOPY_LAYERS) {
    registerRasterLayer(layer.id, false, layer.tileUrl, layer.attribution);
  }

  // Dim any raster layers whose vintage is older than STALENESS_THRESHOLD_YEARS.
  // Called once after all rasters are registered; the user-controlled opacity slider
  // can still override this at any time via handleOpacity().
  _applyStaleRasterOpacity();

  // 0c. Pesticide pressure choropleth — registered beneath all vector area layers
  registerPesticideLayer('pesticide', PESTICIDE_LAYER.defaultOn);
  // 0d. Parcel ownership fill — beneath area polygon layers; lazy data loaded on first toggle
  registerParcelLayer(false);
  // 0d. Nesting badge layer — rendered above all other layers; badges start hidden
  //     until nesting scores arrive and an NLCD layer is toggled on.
  registerNestingBadgeLayer(false);
  // 0d. Connectivity mesh — registered early so it sits above rasters but below point layers.
  // Visibility matches the corridor layer's defaultOn; no separate toggle.
  registerConnectivityMesh(true);
  registerPollinatorTrafficHeatmap(true);
  registerNativePlantHeatmap(false);
  // 0d. CDL fringe heatmap — agricultural field edges near the corridor
  registerCdlFringeHeatmap(true);
  // 0e. Analysis layers — expansion opportunities, problem areas, suitability heatmap
  registerExpansionOpportunitiesLayer(false);
  registerProblemAreasLayer(false);
  registerInVESTHeatmap(false);

  // 1. Polygon area layers FIRST — they render at the bottom of the stack
  for (const layer of AREA_LAYERS) {
    registerAreaLayer(layer.id, layer.defaultOn, layer.fillColor, layer.outlineColor);
  }

  // Corridor pin markers — circle + label above the fill polygons so small
  // planting areas remain visible at any zoom level
  const corridorCfg = AREA_LAYERS.find(l => l.id === 'gbcc-corridor');
  registerAreaMarkersLayer(
    'gbcc-corridor', corridorCfg.defaultOn,
    corridorCfg.fillColor, corridorCfg.outlineColor,
    'icon-hummingbird',
    true  // cluster corridor nodes that are close together
  );

  // 2. Hazard point layers — above polygons, below observation points
  for (const layer of HAZARD_LAYERS) {
    registerLayer(layer.id, layer.defaultOn, { radius: 8, symbol: 'icon-biohazard' });
  }

  // 2b. Waystation static layer — above hazards
  // Rendered as a large violet circle with a monarch butterfly icon overlay.
  for (const layer of WAYSTATION_LAYER) {
    registerLayer(layer.id, layer.defaultOn, {
      radius: 14, strokeWidth: 2, opacity: 1.0, symbol: 'icon-butterfly-detailed', iconSize: 0.44,      cluster: true, clusterColor: '#8b5cf6',    });
  }

  // Journey North historical monarch observations (off by default; requires pre-processed data file)
  registerJourneyNorthLayer(false);

  // 2c. Homegrown National Park native planting yards — immediately after waystations
  for (const layer of HNP_LAYER) {
    registerLayer(layer.id, layer.defaultOn, {
      radius: 13, strokeWidth: 2, opacity: 0.95, symbol: 'icon-park',      cluster: true, clusterColor: '#10b981',    });
  }
  // 2d. eBird bird sightings layer
  for (const layer of EBIRD_LAYER) {
    registerLayer(layer.id, layer.defaultOn, {
      radius: 7, symbol: 'icon-crow', iconSize: 0.50,
    });
  }
  // 3. GBIF observation layers — above hazards
  // No symbol icon: dots are already distinguished by color; tiny icons were illegible.
  // GBIF layers — same icon per category as iNat for cross-source consistency
  registerLayer('gbif-pollinators',       GBIF_LAYERS.find(l => l.id === 'gbif-pollinators').defaultOn,       { gbif: true, radius: 7, opacity: 0.55, symbol: 'icon-butterfly', iconSize: 0.40 });
  registerLayer('gbif-native-plants',     GBIF_LAYERS.find(l => l.id === 'gbif-native-plants').defaultOn,     { gbif: true, radius: 7, opacity: 0.55, symbol: 'icon-flower' });
  registerLayer('gbif-non-native-plants', GBIF_LAYERS.find(l => l.id === 'gbif-non-native-plants').defaultOn, { gbif: true, radius: 7, opacity: 0.55, symbol: 'icon-flower-tulip' });
  registerLayer('gbif-wildlife',          GBIF_LAYERS.find(l => l.id === 'gbif-wildlife').defaultOn,          { gbif: true, radius: 7, opacity: 0.55, symbol: 'icon-deer' });
  // 3b. FWS Bee Distribution Tool layers — GBIF records for 6 bee families + NatureServe status
  registerLayer('bees-records',   BEE_LAYERS.find(l => l.id === 'bees-records').defaultOn,   { gbif: true, radius: 8, opacity: 0.60, symbol: 'icon-butterfly', iconSize: 0.38 });
  registerLayer('bees-imperiled', BEE_LAYERS.find(l => l.id === 'bees-imperiled').defaultOn, { gbif: true, radius: 9, opacity: 0.75, symbol: 'icon-butterfly', iconSize: 0.38 });
  registerBeeRichnessHeatmap(BEE_LAYERS.find(l => l.id === 'bees-richness').defaultOn);
  // 4. iNaturalist layers — topmost
  // iNat layers — SVG icons per category
  registerLayer('pollinators',    LAYERS.find(l => l.id === 'pollinators').defaultOn,    { radius: 8, symbol: 'icon-butterfly', iconSize: 0.40 });
  registerLayer('native-plants',  LAYERS.find(l => l.id === 'native-plants').defaultOn,  { radius: 8, symbol: 'icon-flower' });
  registerLayer('other-plants',   LAYERS.find(l => l.id === 'other-plants').defaultOn,   { radius: 8, symbol: 'icon-flower-tulip' });
  registerLayer('other-wildlife', LAYERS.find(l => l.id === 'other-wildlife').defaultOn, { radius: 8, symbol: 'icon-deer' });
  // Commons photo markers — registered last so they render above all other layers
  registerCommonsLayer(false);
  {
    const map = getMap();
    map.on('mouseenter', 'commons-photo-circle', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'commons-photo-circle', () => { map.getCanvas().style.cursor = ''; });
    map.on('click', 'commons-photo-circle', e => {
      const p = e.features?.[0]?.properties;
      if (!p) return;
      openLightbox({
        thumburl:    p.thumburl,
        title:       p.title,
        description: p.description,
        artist:      p.artist,
        license:     p.license,
        descurl:     p.descurl,
      });
    });
  }

  // Build the side-panel UI
  // Opacity callback: routes to the correct setter based on layer type
  function handleOpacity(id, opacity) {
    if (AREA_LAYERS.some(l => l.id === id))    setAreaLayerOpacity(id, opacity);
    else if (_rasterLayerIds.has(id))          setRasterOpacity(id, opacity);
    else if (id === 'pesticide')               { /* choropleth opacity is fixed by band expressions */ }
    else if (id === 'parcels')                 { /* parcel opacity is zoom-interpolated in registerParcelLayer */ }
    else if (id === 'commons-photos')          { /* commons circle opacity is fixed */ }
    else                                       setPointLayerOpacity(id, opacity);
  }

  // Habitat Programs = active planting programs (corridor only)
  // Conservation = background land protection + treatments + hazards
  const habitatAreaLayers     = AREA_LAYERS.filter(l => l.id === 'gbcc-corridor');
  const conservationLayers    = AREA_LAYERS.filter(l => l.id !== 'gbcc-corridor');


  // ── Habitat Programs (primary section) ─────────────────────────────────────────
  buildLayerPanel(
    [
      { groupLabel: 'Pollinator Corridor · GBCC', layers: habitatAreaLayers  },
      { groupLabel: 'Monarch Watch Waystations',  layers: WAYSTATION_LAYER   },
      { groupLabel: 'Homegrown National Park',    layers: HNP_LAYER          },
    ],
    setLayerActive,
    document.getElementById('panel-habitat-inner'),
    handleOpacity,
  );

  // ── Opportunity & Risk (pane-analysis) ─────────────────────────────────────
  buildLayerPanel(
    [
      { groupLabel: 'Opportunity & Risk', layers: [...EXPANSION_LAYER, ...PROBLEM_AREAS_LAYER] },
      { groupLabel: 'Pollinator Modeling', layers: [INVEST_LAYER] },
    ],
    setLayerActive,
    document.getElementById('panel-analysis-inner'),
    handleOpacity,
  );

  // ── Conservation Areas & Hazards (pane-conservation) ────────────────────────
  buildLayerPanel(
    [
      { groupLabel: 'Ownership',           layers: [PARCEL_LAYER]     },
      { groupLabel: 'Habitat Treatments',  layers: conservationLayers.filter(l => l.id === 'gbcc-treatment') },
      { groupLabel: 'Protected Lands',     layers: conservationLayers.filter(l => !l.id.startsWith('gbcc-')) },
      { groupLabel: 'Hazards',             layers: HAZARD_LAYERS      },
      { groupLabel: 'Chemical Threats',    layers: [PESTICIDE_LAYER]  },
    ],
    setLayerActive,
    document.getElementById('panel-areas-inner'),
    handleOpacity,
  );
  buildPesticideLegend(document.getElementById('panel-areas-inner'));

  // Zoom-level hint for parcel layer — injected after the toggle's description
  // paragraph so it sits naturally beneath the layer row.
  const _parcelToggleWrap = document.getElementById('toggle-parcels')?.closest('div');
  if (_parcelToggleWrap) {
    const _parcelHint = document.createElement('p');
    _parcelHint.id        = 'parcel-zoom-hint-panel';
    _parcelHint.className = 'parcel-zoom-hint-panel';
    _parcelHint.setAttribute('aria-live', 'polite');
    _parcelHint.textContent = 'Parcel detail visible at neighborhood zoom (zoom in to see).';
    _parcelToggleWrap.appendChild(_parcelHint);
  }

  /** Updates the parcel zoom hint text based on current map zoom. */
  function _updateParcelZoomHint() {
    const hint = document.getElementById('parcel-zoom-hint-panel');
    if (!hint) return;
    hint.textContent = map.getZoom() >= 14
      ? 'Parcel ownership visible.'
      : 'Parcel detail visible at neighborhood zoom (zoom in to see).';
  }

  // ── Land Cover Analysis (NLCD classes + CDL, collapsed) ──────────────────────
  // Group the 16 NLCD classes by their semantic group property.
  const nlcdByGroup = NLCD_LAYERS.reduce((acc, l) => {
    (acc[l.group] = acc[l.group] || []).push(l);
    return acc;
  }, {});
  buildLayerPanel(
    [
      ...Object.entries(nlcdByGroup).map(([g, layers]) => ({
        groupLabel: `NLCD · ${g}`,
        layers,
      })),
    ],
    setLayerActive,
    document.getElementById('panel-landcover-inner'),
    handleOpacity,
  );

  // Stale-data note beneath NLCD group
  const _nlcdStaleNote = document.createElement('p');
  _nlcdStaleNote.className = 'layer-stale-note';
  _nlcdStaleNote.textContent = 'Layers from data vintages \u2265 3\u00a0years old are shown at reduced opacity.';
  document.getElementById('panel-landcover-inner')?.appendChild(_nlcdStaleNote);
  buildLayerPanel(
    [
      { groupLabel: 'iNaturalist',         layers: LAYERS          },
      { groupLabel: 'GBIF',                layers: GBIF_LAYERS     },
      { groupLabel: 'eBird (Cornell Lab)', layers: EBIRD_LAYER     },
      { groupLabel: 'Wikimedia Commons',   layers: [COMMONS_LAYER] },
    ],
    setLayerActive,
    null,
    handleOpacity,
  );

  // ── Sightings — Bee Records / Imperiled Species (pane-sightings) ───────────
  buildLayerPanel(
    [
      { groupLabel: 'FWS Bee Distribution Tool 🐝', layers: BEE_LAYERS },
    ],
    setLayerActive,
    document.getElementById('panel-bee-layers'),
    handleOpacity,
  );
  buildEstLegend();
  buildAreaLegend(setLayerActive);
  renderPresets();

  // Seed _activeLayerIds from all layers that are on by default.
  // setLayerActive() keeps the set updated on subsequent toggles.
  for (const layer of [
    ...LAYERS, ...GBIF_LAYERS, ...BEE_LAYERS, ...AREA_LAYERS,
    ...HAZARD_LAYERS, ...WAYSTATION_LAYER, ...HNP_LAYER, ...NLCD_LAYERS,
    ...EBIRD_LAYER, ...EXPANSION_LAYER, ...PROBLEM_AREAS_LAYER,
    PESTICIDE_LAYER, PARCEL_LAYER, COMMONS_LAYER, INVEST_LAYER,
  ]) {
    if (layer.defaultOn) _activeLayerIds.add(layer.id);
  }

  // Initialise the activity bar (opens/closes flyout panes)
  const activityBar = initActivityBar();

  // Permalink — restore state from URL hash, then init sync
  const _permalinkState = parsePermalink();
  if (_permalinkState) {
    applyPermalinkState(_permalinkState, map);
  } else {
    // Apply the Orientation view as the default starting state
    const _orientPreset = LAYER_PRESETS.find(p => p.id === 'orientation');
    if (_orientPreset) applyPreset(_orientPreset);
  }

  // Connectivity mesh follows corridor — no standalone toggle needed.
  document.getElementById('toggle-heatmap-traffic')?.addEventListener('change', e => {
    setHeatmapVisibility('pollinator-traffic-heat', e.target.checked);
  });
  document.getElementById('toggle-heatmap-native-plants')?.addEventListener('change', e => {
    setHeatmapVisibility('native-plant-heat', e.target.checked);
  });
  document.getElementById('toggle-bees-richness')?.addEventListener('change', e => {
    setHeatmapVisibility('bees-richness', e.target.checked);
  });
  document.getElementById('toggle-tree-canopy')?.addEventListener('change', e => {
    _treeCanopyOn = e.target.checked;
    _syncTreeCanopyYear(_timelineEndYear);
  });
  document.getElementById('toggle-cdl-fringe')?.addEventListener('change', e => {
    setHeatmapVisibility('cdl-fringe-heat', e.target.checked);
  });
  // "All layers off" button — unchecks every visible toggle in the panel
  document.getElementById('btn-layers-all-off')?.addEventListener('click', () => {
    document.querySelectorAll('#panel-flyout input[type="checkbox"]:checked').forEach(cb => {
      cb.checked = false;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });

  // Export dropdown — menu lives on <body> to escape MapLibre stacking context
  const btnExport  = document.getElementById('btn-export');
  const exportMenu = document.getElementById('export-menu');
  const reportFns  = { full: exportReport, brief: exportExecutiveBrief, outreach: exportOutreachReport, ecological: exportEcologicalAssessment };

  function _positionExportMenu() {
    const r = btnExport.getBoundingClientRect();
    // Prefer right-aligned to button; clamp to viewport left edge
    const menuW = exportMenu.offsetWidth || 220;
    let left = r.right - menuW;
    if (left < 4) left = 4;
    exportMenu.style.top  = `${r.bottom + 4}px`;
    exportMenu.style.left = `${left}px`;
  }

  btnExport?.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !exportMenu.hidden;
    exportMenu.hidden = open;
    btnExport.setAttribute('aria-expanded', String(!open));
    if (!open) _positionExportMenu();
  });
  exportMenu?.addEventListener('click', (e) => {
    const item = e.target.closest('[data-report]');
    if (!item) return;
    exportMenu.hidden = true;
    btnExport.setAttribute('aria-expanded', 'false');
    (reportFns[item.dataset.report] ?? exportReport)();
  });
  document.addEventListener('click', (e) => {
    if (!btnExport?.contains(e.target) && !exportMenu?.contains(e.target)) {
      if (exportMenu) exportMenu.hidden = true;
      btnExport?.setAttribute('aria-expanded', 'false');
    }
  });
  document.getElementById('btn-export-png')?.addEventListener('click', exportMapPng);

  // Help / About modals
  document.getElementById('btn-help')?.addEventListener('click',  () => document.getElementById('modal-help')?.removeAttribute('hidden'));
  document.getElementById('btn-about')?.addEventListener('click', () => document.getElementById('modal-about')?.removeAttribute('hidden'));
  document.querySelectorAll('.modal-close').forEach(btn =>
    btn.addEventListener('click', () => btn.closest('.modal-overlay')?.setAttribute('hidden', ''))
  );
  document.querySelectorAll('.modal-overlay').forEach(el =>
    el.addEventListener('click', e => { if (e.target === el) el.setAttribute('hidden', ''); })
  );
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay:not([hidden])').forEach(m => m.setAttribute('hidden', ''));
      closeLightbox();
    }
  });
  // Lightbox close button and overlay-click
  document.getElementById('lightbox-overlay')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeLightbox();
  });
  document.querySelector('.lightbox-close')?.addEventListener('click', closeLightbox);

  // Load static waystation GeoJSON immediately (no async fetch needed)
  setLayerFeatures('waystations', waystationGeoJSON().features);
  // Apply data-driven paint for approximate-location markers (faded ghost style)
  setWaystationApproxStyle();

  // Journey North historical monarchs — pre-processed static GeoJSON (see scripts/fetch-journeynorth.js)
  // Cached for 1 week; graceful no-op if the file is absent.
  (() => {
    const JN_URL    = '/data/journeynorth_monarchs.json';
    const statusEl  = () => document.getElementById('jn-monarchs-status');
    cacheGet(JN_URL).then(cached => {
      if (cached) { setJourneyNorthFeatures(cached); return; }
      fetch(JN_URL)
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then(data => {
          setJourneyNorthFeatures(data);
          cacheSet(JN_URL, data, 7 * 24 * 60 * 60 * 1000);
          const el = statusEl();
          if (el) el.textContent = 'Historical · 1996–2020 (CC BY)';
        })
        .catch(() => {
          const el = statusEl();
          if (el) el.textContent = 'No data — run scripts/fetch-journeynorth.js first';
        });
    });
    // Wire hover cursor + click popup for JN points
    const map = getMap();
    map.on('mouseenter', 'points-journeynorth-monarchs', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'points-journeynorth-monarchs', () => { map.getCanvas().style.cursor = ''; });
    map.on('click', 'points-journeynorth-monarchs', e => {
      const f = e.features?.[0]?.properties;
      if (!f) return;
      const label = f.type || 'Monarch observation';
      const dateStr = f.date ? ` · ${f.date}` : '';
      const nStr = f.n && f.n > 1 ? ` (${f.n})` : '';
      showPopup(e.lngLat,
        `<div class="popup-body" style="min-width:170px">
          <strong class="popup-name">${esc(label)}${nStr}</strong>
          <span class="popup-source">🦋 Journey North${dateStr}</span>
          <p style="font-size:10px;color:#6b7280;margin:6px 0 0">Historical 1996–2020 · not live</p>
        </div>`);
    });
  })();

  // API key health check — shows a dismissible banner if any keys are missing
  initHealthCheck();

  // Climate data — loads async; once done, patch the GDD stat into the intel bar
  // (loadObservations may finish before climate data arrives on first paint).
  initClimatePanel().then(() => {
    const gddStat = getGddIntelStat();
    if (gddStat.value !== '\u2014') {
      document.getElementById('intel-val-climate').textContent = gddStat.value;
    const lbEl2 = document.getElementById('intel-lbl-climate-text') ?? document.getElementById('intel-lbl-climate');
    lbEl2.textContent = gddStat.label;
    }
  });

  // Filter chips
  buildFilterChips(document.getElementById('panel-filter-chips'));
  initFilters((layerId, features) => setLayerFeatures(layerId, features));

  // Timeline scrubber + month filter — range goes back to earliest recorded sighting (~2009
  // for iNaturalist; GBIF records can go further).  Default window is last 5 years.
  initTimeline((startYear, endYear, activeMonths) => {
    _timelineStartYear    = startYear;
    _timelineEndYear      = endYear;
    _timelineActiveMonths = activeMonths;
    _syncTreeCanopyYear(endYear);
    setDatePredicate(dateStr => {
      if (!dateStr) return true;
      const d = new Date(dateStr);
      const y = d.getFullYear();
      if (y < startYear || y > endYear) return false;
      if (activeMonths.size > 0 && !activeMonths.has(d.getMonth())) return false;
      return true;
    });
    applyFilters();

    // ── Reactive heatmap update ───────────────────────────────────────────────
    if (_allSightings.length > 0) {
      const filteredSightings = _filterSightingsByYear(_allSightings, startYear, endYear, activeMonths);
      updatePollinatorTrafficHeatmap(filteredSightings);
      setDrawerSightings(filteredSightings);
    }
    if (_allNativePlants.length > 0) {
      updateNativePlantHeatmap(_filterSightingsByYear(_allNativePlants, startYear, endYear, activeMonths));
    }

    // ── Reactive waystation cumulative filter (show if registered ≤ endYear) ─
    if (_waystationFeats.length > 0) {
      const wsFiltered = _waystationFeats.filter(f => {
        const raw = f.properties?.registered;
        if (!raw) return true;
        const parts = String(raw).trim().split('/');
        if (parts.length < 3) return true;
        const yy = parseInt(parts[2], 10);
        if (isNaN(yy)) return true;
        const registeredYear = yy <= 30 ? 2000 + yy : 1900 + yy;
        return registeredYear <= endYear;
      });
      setLayerFeatures('waystations', wsFiltered);
      _confirmedWaystationFeats = wsFiltered.filter(f => !f.properties.approximate);
      refreshConnectivityMesh();
    }

    // ── Reactive intel bar update ─────────────────────────────────────────────
    if (_inatByLayer && Object.keys(_inatByLayer).length > 0) {
      const passDate = f => {
        const raw = f.properties?.date;
        if (!raw) return true;
        const d = new Date(raw);
        const y = d.getFullYear();
        if (y < startYear || y > endYear) return false;
        if (activeMonths.size > 0 && !activeMonths.has(d.getMonth())) return false;
        return true;
      };
      const pollinatorCount     = [...(_inatByLayer['pollinators'] ?? []), ..._gbifPollinators].filter(passDate).length;
      const ebirdCount          = _ebirdAllFeats.filter(passDate).length;
      const nativeSpeciesCount  = new Set([
        ...(_inatByLayer['native-plants'] ?? []).filter(passDate).map(f => f.properties?.name).filter(Boolean),
        ..._gbifNativePlants.filter(passDate).map(f => f.properties?.name).filter(Boolean),
      ]).size;
      updateIntelBar({
        corridorSqFt:     _corridorFeats.reduce((s, f) => s + (+(f.properties?.area_sqft ?? 0)), 0),
        hnpCount:         _hnpCount,
        habitatNodeCount: _corridorFeats.length + _waystationFeats.length + _hnpFeats.length,
        pollinatorCount,
        gddStat:          getGddIntelStat(),
        ebirdCount,
        nativeSpeciesCount,
        alertCount:       _lastAlertCount,
      });
    }
  }, 2009);
  mountTimelineDrag();

  // Permalink — init sync (state already restored above)
  initPermalink(
    () => getMap(),
    () => [_timelineStartYear, _timelineEndYear],
  );

  document.getElementById('site-drawer-close').addEventListener('click', closeDrawer);

  // Recompute mesh on zoom — cluster state changes at each zoom step
  map.on('zoomend', refreshConnectivityMesh);
  // Update parcel zoom hint and refresh parcel data on zoom
  map.on('zoomend', _updateParcelZoomHint);
  map.on('zoomend', _refreshParcelViewport);
  // Refresh parcel data when the viewport moves
  map.on('moveend', _refreshParcelViewport);

  // Clicking empty map space clears any active alert highlight
  map.on('click', e => {
    const hits = map.queryRenderedFeatures(e.point);
    if (!hits.length) clearAlertHighlight();
  });

  // Intel-bar alerts stat → open the alerts flyout pane
  const openAlertsPanel = () => activityBar.openPane('pane-alerts');
  document.getElementById('intel-alerts').addEventListener('click', openAlertsPanel);
  document.getElementById('intel-alerts').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAlertsPanel(); }
  });

  // Climate intel stat → open climate ribbon modal
  const openClimateFromBar = () => openClimateRibbon(getClimateState());
  document.getElementById('intel-climate')?.addEventListener('click', openClimateFromBar);
  document.getElementById('intel-climate')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openClimateFromBar(); }
  });

  // ── Intel bar stat drawers ────────────────────────────────────────────────
  function _featCentroid(f) {
    const g = f.geometry;
    if (!g) return null;
    if (g.type === 'Point') return g.coordinates;
    const ring = g.coordinates?.[0];
    return ring?.length
      ? [ring.reduce((s, c) => s + c[0], 0) / ring.length, ring.reduce((s, c) => s + c[1], 0) / ring.length]
      : null;
  }

  // Corridor stat → show corridor site list
  const openCorridorDrawer = () => {
    if (!_corridorFeats.length) return;
    const sorted = [..._corridorFeats].sort((a, b) => (b.properties?.area_sqft ?? 0) - (a.properties?.area_sqft ?? 0));
    const totalSqft = _corridorFeats.reduce((s, f) => s + (+(f.properties?.area_sqft ?? 0)), 0);
    const rows = sorted.map(f => {
      const p = f.properties ?? {};
      return `<tr><td>${esc(p.name || 'Unnamed')}</td><td style="text-align:right">${p.area_sqft > 0 ? formatArea(+p.area_sqft) : '—'}</td></tr>`;
    }).join('');
    openIntelDrawer('Pollinator Corridor',
      `<p class="drawer-intel-note">${_corridorFeats.length} active sites · ${formatArea(totalSqft)} total</p>
       <table class="drawer-intel-table"><thead><tr><th>Site</th><th>Area</th></tr></thead><tbody>${rows}</tbody></table>`);
    setLayerActive('gbcc-corridor', true);
    const coords = _corridorFeats.map(_featCentroid).filter(Boolean);
    if (coords.length) { showAlertHighlight(coords, 'positive'); fitToCoords(coords, { padding: { top: 80, bottom: 80, left: 80, right: 340 } }); }
  };
  document.getElementById('intel-corridor')?.addEventListener('click', openCorridorDrawer);
  document.getElementById('intel-corridor')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCorridorDrawer(); }
  });

  // Habitat stat → show habitat network summary
  const openHabitatDrawer = () => {
    const total = _corridorFeats.length + _waystationFeats.length + _hnpFeats.length;
    if (!total) return;
    openIntelDrawer('Habitat Network',
      `<div class="drawer-intel-stat-grid">
         <div class="drawer-intel-stat-cell"><strong>${_corridorFeats.length}</strong><span>Corridor sites</span></div>
         <div class="drawer-intel-stat-cell"><strong>${_waystationFeats.length}</strong><span>Waystations</span></div>
         <div class="drawer-intel-stat-cell"><strong>${_hnpFeats.length}</strong><span>HNP yards</span></div>
       </div>
       <p class="drawer-intel-note">${total} total habitat nodes across 3 programs</p>`);
    const coords = [..._corridorFeats, ..._waystationFeats, ..._hnpFeats].map(_featCentroid).filter(Boolean);
    if (coords.length) { showAlertHighlight(coords, 'positive'); fitToCoords(coords, { padding: { top: 80, bottom: 80, left: 80, right: 340 } }); }
  };
  document.getElementById('intel-habitat')?.addEventListener('click', openHabitatDrawer);
  document.getElementById('intel-habitat')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHabitatDrawer(); }
  });

  // iNat/GBIF pollinator stat → show top pollinator species
  const openPollinatorDrawer = () => {
    const all = [...(_inatByLayer['pollinators'] ?? []), ..._gbifPollinators];
    if (!all.length) return;
    const freq = {};
    for (const f of all) { const n = f.properties?.common || f.properties?.name || 'Unknown'; freq[n] = (freq[n] ?? 0) + 1; }
    const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 25);
    const rows = top.map(([name, cnt]) =>
      `<tr><td>${esc(name)}</td><td style="text-align:right">${cnt}</td></tr>`).join('');
    openIntelDrawer('Pollinator Sightings',
      `<p class="drawer-intel-note">${all.length.toLocaleString()} total observations · top species</p>
       <table class="drawer-intel-table"><thead><tr><th>Species</th><th>#</th></tr></thead><tbody>${rows}</tbody></table>`);
    setLayerActive('pollinators', true);
    const coords = all.map(f => f.geometry?.coordinates).filter(Boolean);
    if (coords.length) showAlertHighlight(coords.slice(0, 200), 'positive');
  };
  document.getElementById('intel-inat')?.addEventListener('click', openPollinatorDrawer);
  document.getElementById('intel-inat')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPollinatorDrawer(); }
  });

  // eBird stat → show top bird species
  const openEbirdDrawer = () => {
    if (!_ebirdAllFeats.length) return;
    const freq = {};
    for (const f of _ebirdAllFeats) { const n = f.properties?.common || f.properties?.name || 'Unknown'; freq[n] = (freq[n] ?? 0) + 1; }
    const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 30);
    const rows = top.map(([name, cnt]) =>
      `<tr><td>${esc(name)}</td><td style="text-align:right">${cnt}</td></tr>`).join('');
    openIntelDrawer('eBird Sightings',
      `<p class="drawer-intel-note">${_ebirdAllFeats.length.toLocaleString()} observations · top species</p>
       <table class="drawer-intel-table"><thead><tr><th>Species</th><th>#</th></tr></thead><tbody>${rows}</tbody></table>`);
    setLayerActive('ebird', true);
    const coords = _ebirdAllFeats.map(f => f.geometry?.coordinates).filter(Boolean);
    if (coords.length) showAlertHighlight(coords.slice(0, 200), 'positive');
  };
  document.getElementById('intel-ebird')?.addEventListener('click', openEbirdDrawer);
  document.getElementById('intel-ebird')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEbirdDrawer(); }
  });

  // Native species stat → show unique native species list
  const openNativeDrawer = () => {
    const inatNative = _inatByLayer['native-plants'] ?? [];
    const all = [...inatNative, ..._gbifNativePlants];
    if (!all.length) return;
    const seen = new Map();
    for (const f of inatNative) { const n = f.properties?.name || f.properties?.common; if (n) seen.set(n, 'iNat'); }
    for (const f of _gbifNativePlants) { const n = f.properties?.name || f.properties?.common; if (n && !seen.has(n)) seen.set(n, 'GBIF'); }
    const sorted = [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const rows = sorted.map(([name, src]) =>
      `<tr><td>${esc(name)} <span class="td-source">${esc(src)}</span></td></tr>`).join('');
    openIntelDrawer('Native Species',
      `<p class="drawer-intel-note">${seen.size} unique species · iNat + GBIF</p>
       <table class="drawer-intel-table"><thead><tr><th>Species</th></tr></thead><tbody>${rows}</tbody></table>`);
    setLayerActive('native-plants', true);
    const coords = all.map(f => f.geometry?.coordinates).filter(Boolean);
    if (coords.length) showAlertHighlight(coords.slice(0, 200), 'positive');
  };
  document.getElementById('intel-species')?.addEventListener('click', openNativeDrawer);
  document.getElementById('intel-species')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openNativeDrawer(); }
  });

  // Wire click interactions on all layers (points + polygon fills)
  const pointLayerIds = getInteractiveLayerIds([...GBIF_LAYERS, ...LAYERS, ...HAZARD_LAYERS, ...WAYSTATION_LAYER, ...HNP_LAYER, ...EBIRD_LAYER, ...BEE_LAYERS.filter(l => l.id !== 'bees-richness')]);
  const areaLayerIds  = getInteractiveAreaLayerIds(AREA_LAYERS);
  const alertLayerIds = ['points-expansion-opportunities', 'points-problem-areas'];

  // Wire hover cursors for all interactive layers (no click listener here)
  wireHoverCursors([...areaLayerIds, ...pointLayerIds, ...alertLayerIds]);

  // Single unified click dispatcher — one query, one decision tree, no double-firing
  getMap().on('click', e => {
    const allHits = getMap().queryRenderedFeatures(e.point, {
      layers: [...areaLayerIds, ...pointLayerIds, ...alertLayerIds],
    });
    if (!allHits.length) return;

    const lngLat = e.lngLat;

    // Cluster — zoom in to expand (check first; cluster marker sits in pointLayerIds)
    const clusterHit = allHits.find(f => f.properties.cluster);
    if (clusterHit) {
      zoomToCluster(clusterHit.layer.source, clusterHit.properties.cluster_id, clusterHit.geometry.coordinates);
      return;
    }

    // Split hits into drawer-worthy features vs alert annotations
    const drawerHit   = allHits.find(f => isDrawerFeature(f.properties));
    const alertHits   = allHits.filter(f =>
      f.properties.layer_id === 'problem-areas' ||
      f.properties.layer_id === 'expansion-opportunities'
    );

    // Corridor / waystation / protected area — open dossier, inject any alert context
    if (drawerHit) {
      openDrawer(drawerHit, alertHits);
      return;
    }

    // Alert-only click (no drawer feature underneath) — open intel drawer for topmost
    if (alertHits.length) {
      const props = alertHits[0].properties;
      if (props.layer_id === 'expansion-opportunities') {
        const score    = props.score ?? 0;
        const suit     = props.suitability ?? 'moderate';
        const barColor = suit === 'good' ? '#10b981' : suit === 'moderate' ? '#f59e0b' : '#ef4444';
        const hdrBg    = suit === 'good' ? '#064e3b' : suit === 'moderate' ? '#451a03' : '#450a0a';
        const pollCount   = props.pollinator_count   ?? 0;
        const plantCount  = props.native_plant_count ?? 0;
        const nestScore   = props.nesting_proxy;
        const nestSite    = props.nesting_proxy_site ?? '';
        const nearCorrKm  = props.near_corridor_km;
        const rec         = props.recommendation ?? 'both';
        const pfas        = props.pfas_nearby    ? '<span class="factor-bad">Yes &#x26A0;</span>'  : '<span class="factor-good">None detected</span>';
        const pest        = props.high_pesticide ? '<span class="factor-bad">High pressure</span>' : '<span class="factor-good">Low / moderate</span>';
        const suitLabel   = suit.charAt(0).toUpperCase() + suit.slice(1);

        const nestingRow  = nestScore != null
          ? `<dt>Nesting Habitat (proxy)</dt><dd>${nestScore}/100 — from ${nestSite} (${nearCorrKm != null ? (nearCorrKm * 1000).toFixed(0) + '\u202fm' : 'nearby'})</dd>`
          : `<dt>Nesting Habitat</dt><dd><em>No scored corridor site within 3 km — field assessment recommended</em></dd>`;

        // Recommendation block
        const recHtml = _expansionRecHtml(rec);

        // Scoring breakdown uses new weights
        const nestPts  = nestScore != null ? (nestScore >= 70 ? 30 : nestScore >= 45 ? 20 : nestScore >= 20 ? 10 : 2) : 0;
        const plantPts = plantCount >= 8 ? 35 : plantCount >= 3 ? 22 : plantCount >= 1 ? 10 : 0;
        const corrPts  = nearCorrKm != null && nearCorrKm > 0.8 && nearCorrKm <= 1.5 ? 15 : nearCorrKm != null && nearCorrKm <= 3.0 ? 8 : 0;
        const pfasPts  = props.pfas_nearby    ? -20 : 10;
        const pestPts  = props.high_pesticide ? -10 :  5;
        const pollPts  = pollCount >= 20 ? 5 : pollCount >= 8 ? 2 : 0;

        const body = `
          <div class="drawer-score-hero">
            <div class="drawer-score-ring">
              <span class="drawer-score-num">${score}</span>
              <span class="drawer-score-denom">/100</span>
            </div>
            <div class="drawer-score-bar-wrap">
              <div class="drawer-score-bar"><div class="drawer-score-fill" style="width:${score}%;background:${barColor}"></div></div>
              <span class="drawer-score-tier" style="color:${barColor}">${suitLabel} suitability</span>
            </div>
          </div>
          ${recHtml}
          <div class="drawer-section-label">Ecological Signals</div>
          <dl class="drawer-meta">
            <dt>Native Plant Records</dt><dd>${plantCount} records within 800 m</dd>
            ${nestingRow}
            <dt>Pollinator Records</dt><dd>${pollCount} sightings nearby (supporting evidence)</dd>
            <dt>PFAS Contamination</dt><dd>${pfas}</dd>
            <dt>Pesticide Pressure</dt><dd>${pest}</dd>
          </dl>
          <div class="drawer-section-label">Scoring Breakdown</div>
          <div class="drawer-factor-list">
            ${_expansionFactorRow('Native plant presence (primary)', plantPts, 35, barColor)}
            ${_expansionFactorRow('Nesting habitat suitability (primary)', nestPts, 30, barColor)}
            ${_expansionFactorRow('Corridor stepping-stone proximity', corrPts, 15, barColor)}
            ${_expansionFactorRow('PFAS-free environment', pfasPts, 10, barColor)}
            ${_expansionFactorRow('Low pesticide pressure', pestPts, 5, barColor)}
            ${_expansionFactorRow('Pollinator activity (supporting)', pollPts, 5, barColor)}
          </div>
          ${_buildExpansionPublicLandSection(lngLat)}`;
        openIntelDrawer(
          props.name ?? 'Expansion Opportunity',
          body,
          { headerStyle: `background:${hdrBg}`, labelHtml: '&#x26A1; Expansion Opportunity' }
        );

      } else if (props.layer_id === 'problem-areas') {
        const sev      = props.severity ?? 'medium';
        const sevColor = sev === 'high' ? '#dc2626' : sev === 'medium' ? '#d97706' : '#6b7280';
        const hdrBg    = sev === 'high' ? '#450a0a'  : sev === 'medium' ? '#451a03'  : '#1f2937';
        const typeLabel = _problemTypeLabel(props.problem_type ?? '');
        const body = `
          <div class="drawer-severity-badge" style="background:${sevColor}22;border-color:${sevColor}66;color:${sevColor}">
            <span class="drawer-severity-dot" style="background:${sevColor}"></span>
            ${sev.toUpperCase()} SEVERITY
          </div>
          <div class="drawer-section-label">Problem Type</div>
          <dl class="drawer-meta">
            <dt>Category</dt><dd>${typeLabel}</dd>
            <dt>Details</dt><dd>${props.common ?? ''}</dd>
          </dl>
          <div class="drawer-section-label">What This Means</div>
          <p class="drawer-intel-note" style="margin-top:4px">${_problemTypeExplanation(props.problem_type ?? '')}</p>`;
        openIntelDrawer(
          props.name ?? 'Problem Area',
          body,
          { headerStyle: `background:${hdrBg}`, labelHtml: '&#x26A0; Problem Area' }
        );
      }
      return;
    }

    // Regular popup — topmost non-alert, non-drawer feature
    const topProps = allHits[0].properties;
    const html = topProps.data_source ? buildAreaPopupHTML(topProps) : buildPopupHTML(topProps);
    showPopup(lngLat, html);
  });

  // Wire clicks on public land parcels → contact info drawer
  wireParcelClick((_lngLat, props) => {
    const own   = props.own_class ?? 'private';
    if (own === 'private') return; // private parcels don't get a contact drawer

    const muni     = String(props.Municipality ?? '').trim();
    const muniTC   = muni ? muni.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : '';
    const area     = props.MapAreaTxt ? ` · ${props.MapAreaTxt}` : '';
    const parcelId = String(props.PARCELID ?? '').trim();

    // Contact info by ownership class
    const c = _PUBLIC_CONTACTS[own] ?? _PUBLIC_CONTACTS.institutional;
    const resolvedAgency = c.agency ?? (muniTC || 'Municipal / Institutional');
    const phoneHtml = c.phone ? `<dt>Phone</dt><dd><a href="tel:${c.phone.replace(/[^+\d]/g,'')}">${c.phone}</a></dd>` : '';
    const emailHtml = c.email ? `<dt>Email</dt><dd><a href="mailto:${c.email}">${c.email}</a></dd>` : '';
    const webHtml   = c.web   ? `<dt>Website</dt><dd><a href="${c.web}" target="_blank" rel="noopener">${c.webLabel} ↗</a></dd>` : '';
    const idHtml    = parcelId ? `<dt>Parcel ID</dt><dd>${parcelId}</dd>` : '';

    const body = `
      <dl class="drawer-meta" style="margin-top:8px">
        <dt>Owner</dt><dd>${resolvedAgency}</dd>
        <dt>Department</dt><dd>${c.dept}</dd>
        ${idHtml}
        <dt>Municipality</dt><dd>${muniTC || '—'}${area}</dd>
      </dl>
      <div class="drawer-section-label" style="margin-top:14px">Contact for Habitat Inquiries</div>
      <dl class="drawer-meta">
        ${phoneHtml}
        ${emailHtml}
        ${webHtml}
      </dl>
      <p class="drawer-intel-note" style="margin-top:10px">${c.note}</p>`;

    openIntelDrawer(
      resolvedAgency,
      body,
      { headerStyle: `background:${c.hdrBg}`, labelHtml: 'Public Land' }
    );
  });

  // Initial data load
  loadObservations().then(() => {
    // Start background historical iNat loading 2 s after the map renders.
    // Each previous year is fetched (or served from its long-TTL browser cache)
    // and merged into the live dataset, extending the timeline back to
    // INAT_HISTORY_START_YEAR without blocking the initial display.
    setTimeout(() => _loadHistoricalInat().catch(err => console.warn('[inat-history]', err.message)), 2000);
  });
  // Historical trends — deferred so it never delays the primary render
  setTimeout(() => loadHistoricalTrends(), 0);
});

// ── Analysis drawer helpers ──────────────────────────────────────────────────

// Public land contact info — used both by the parcel click drawer and the
// expansion opportunity drawer.  `institutional.agency` is null and must be
// resolved from the specific parcel's norm.owner at render time.
const _PUBLIC_CONTACTS = {
  city: {
    hdrBg:    '#0d9488',
    agency:   'City of Green Bay',
    dept:     'Parks, Recreation &amp; Forestry',
    phone:    '(920) 448-3365',
    email:    'parksrec@greenbaywi.gov',
    web:      'https://www.greenbaywi.gov/departments/parks/',
    webLabel: 'greenbaywi.gov/parks',
    note:     'Contact the Parks, Recreation &amp; Forestry Department to inquire about native planting, habitat partnerships, or land-use permissions on City of Green Bay parcels.',
  },
  county: {
    hdrBg:    '#65a30d',
    agency:   'Brown County',
    dept:     'Parks &amp; Recreation Department',
    phone:    '(920) 448-4466',
    email:    '',
    web:      'https://www.browncountywi.gov/departments/parks-and-recreation/',
    webLabel: 'browncountywi.gov/parks',
    note:     'Contact Brown County Parks &amp; Recreation for inquiries about county-owned natural areas, trail corridors, and partnership opportunities for habitat restoration on county land.',
  },
  state: {
    hdrBg:    '#166534',
    agency:   'State of Wisconsin',
    dept:     'WI Department of Natural Resources',
    phone:    '1-888-936-7463',
    email:    '',
    web:      'https://dnr.wisconsin.gov',
    webLabel: 'dnr.wisconsin.gov',
    note:     'Wisconsin DNR owns or co-manages this parcel. Contact the DNR Northeast Region (Green Bay) to learn about permitted habitat projects, restoration partnerships, or volunteering on state natural areas.',
  },
  institutional: {
    hdrBg:    '#b45309',
    agency:   null,   // resolved from parcel norm.owner at render time
    dept:     'Municipal Offices',
    phone:    '',
    email:    '',
    web:      '',
    webLabel: '',
    note:     'This parcel is publicly owned by a municipality, town, village, or institutional entity. Contact the relevant local government office or agency directly to inquire about habitat projects or land access.',
  },
};

function _expansionFactorRow(label, points, max, barColor) {
  const pct     = Math.max(0, Math.min(100, (Math.abs(points) / max) * 100));
  const isNeg   = points < 0;
  const color   = isNeg ? '#ef4444' : barColor;
  const sign    = isNeg ? '−' : '+';
  const abs     = Math.abs(points);
  return `<div class="drawer-factor-row">
    <span class="drawer-factor-label">${label}</span>
    <span class="drawer-factor-pts" style="color:${color}">${sign}${abs}</span>
    <div class="drawer-factor-bar"><div class="drawer-factor-fill" style="width:${pct}%;background:${color}"></div></div>
  </div>`;
}

function _expansionRecHtml(rec) {
  if (rec === 'corridor') {
    return `<div class="drawer-rec-block drawer-rec-corridor">
      <div class="drawer-rec-icon">&#x1F3DB;</div>
      <div>
        <strong>Corridor Expansion Candidate</strong>
        <p>This location is within stepping-stone range of an existing Pollinator Corridor site on public or city-managed land.
        It is a candidate for a new formal Corridor planting. Verify parcel ownership and coordinate with the City of Green Bay Parks division.</p>
      </div>
    </div>`;
  }
  if (rec === 'community') {
    return `<div class="drawer-rec-block drawer-rec-community">
      <div class="drawer-rec-icon">&#x1F3E0;</div>
      <div>
        <strong>Community Engagement Opportunity</strong>
        <p>This area appears to be primarily private residential land (nearby Waystations or HNP yards rather than Corridor sites).
        Rather than a formal Corridor planting, consider engaging nearby property owners about the benefits of native plants and pollinators.
        Residents can register their yards as a <strong>Monarch Waystation</strong> or join the <strong>Homegrown National Park</strong> program.</p>
      </div>
    </div>`;
  }
  // 'both'
  return `<div class="drawer-rec-block drawer-rec-both">
    <div class="drawer-rec-icon">&#x1F4CD;</div>
    <div>
      <strong>Dual-Pathway Opportunity</strong>
      <p>Both public and private land access may be present here. Consider two parallel approaches:
      (1) assess nearby parcels for Pollinator Corridor eligibility with the City; and
      (2) engage residents about Monarch Waystation and Homegrown National Park registration.
      A field visit is recommended to determine land character.</p>
    </div>
  </div>`;
}

/**
 * Queries _parcelFeatures within 800 m of lngLat and returns an HTML block
 * of public-land contact cards for use in the expansion opportunity drawer.
 * Returns an empty string when parcels aren't loaded or no public land is nearby.
 * @param {{ lng: number, lat: number }} lngLat
 * @returns {string}
 */
function _buildExpansionPublicLandSection(lngLat) {
  if (!_parcelFeatures.length) return '';

  const coord = [lngLat.lng, lngLat.lat];
  const nearbyPublic = queryParcelsNear(coord, 800, _parcelFeatures)
    .filter(p => p.ownerClass !== 'private');
  if (!nearbyPublic.length) return '';

  // One card per unique ownership class, taking the largest / closest parcel
  // as representative (queryParcelsNear already sorts public first, then by acres desc).
  const seenClasses = new Set();
  const cards = nearbyPublic
    .filter(p => { if (seenClasses.has(p.ownerClass)) return false; seenClasses.add(p.ownerClass); return true; })
    .map(p => {
      const c      = _PUBLIC_CONTACTS[p.ownerClass] ?? _PUBLIC_CONTACTS.institutional;
      const agency = c.agency ?? p.norm.owner ?? 'Municipal / Institutional';
      const meta   = OWNERSHIP_META[p.ownerClass];
      const bg     = meta?.color    ?? '#6b7280';
      const fg     = meta?.textColor ?? '#fff';
      const phoneHtml = c.phone ? `<dt>Phone</dt><dd><a href="tel:${c.phone.replace(/[^+\d]/g,'')}">${c.phone}</a></dd>` : '';
      const emailHtml = c.email ? `<dt>Email</dt><dd><a href="mailto:${c.email}">${c.email}</a></dd>` : '';
      const webHtml   = c.web   ? `<dt>Website</dt><dd><a href="${c.web}" target="_blank" rel="noopener">${c.webLabel} ↗</a></dd>` : '';
      const acresLabel = p.norm.acres > 0 ? ` · ${p.norm.acres.toFixed(2)}\u202fac` : '';
      return `
        <div style="border-left:3px solid ${bg};padding-left:8px;margin-bottom:10px">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <span style="background:${bg};color:${fg};border-radius:3px;padding:1px 6px;font-size:0.7rem;font-weight:600">${agency}</span>
            <span style="font-size:0.72rem;color:#9ca3af">${p.distM}\u202fm away${acresLabel}</span>
          </div>
          <dl class="drawer-meta" style="margin:0">
            <dt>Department</dt><dd>${c.dept}</dd>
            ${phoneHtml}
            ${emailHtml}
            ${webHtml}
          </dl>
          <p class="drawer-intel-note" style="margin:4px 0 0">${c.note}</p>
        </div>`;
    }).join('');

  return `<div class="drawer-section-label" style="margin-top:14px">Nearby Public Land — Contact for Habitat Inquiries</div>${cards}`;
}

function _problemTypeLabel(type) {
  return {
    'pfas-proximity':   'PFAS Contamination Proximity',
    'unsupported-site': 'No Pollinator Activity Recorded',
    'isolated-site':    'Isolated from Corridor Network',
    'weak-node':        'Weak Network Connection',
    'poor-nesting':     'Poor Nesting Habitat (NLCD)',
    'shaded-habitat':   'Excessive Tree Canopy Shading',
    'pesticide-high':   'High Agricultural Pesticide Pressure',
  }[type] ?? type;
}

function _problemTypeExplanation(type) {
  return {
    'pfas-proximity':
      'A PFAS detection site is within 1 km of this habitat. Per- and polyfluoroalkyl substances persist in soil and water and may affect insect physiology and plant uptake. Monitoring and soil testing are recommended.',
    'unsupported-site':
      'No pollinator sightings (iNaturalist, GBIF) have been recorded within 500 m of this site. This may indicate low visibility, lack of observation effort, or genuinely poor pollinator visitation. Field surveys would help distinguish.',
    'isolated-site':
      'No other corridor site exists within 2 km — beyond the reliable foraging range of even large bumble bees. This site cannot exchange pollinators with the broader network without a new stepping-stone planting.',
    'weak-node':
      'The nearest corridor neighbor is 700 m–2 km away, placing this connection at the outer edge of small-bee foraging range. Mining bees, sweat bees, and mason bees may not reliably traverse this gap. A new planting within 700 m would restore optimal connectivity.',
    'poor-nesting':
      'NLCD land-cover analysis shows low bare ground and sparse grassland cover within 300 m of this site. Ground-nesting species (70% of native bees) may have limited nesting substrate here.',
    'shaded-habitat':
      'More than 55% tree canopy coverage within 150 m shades out sun-loving pollinator plants such as wild bergamot, coneflowers, and milkweeds. Selective canopy thinning or edge planting could improve conditions.',
    'pesticide-high':
      'This site is located in a county ranked in the top quartile for agricultural pesticide application pressure (USGS NWQP). Sublethal pesticide exposure can impair bee navigation, reproduction, and foraging efficiency.',
  }[type] ?? 'Review conditions at this site to understand the potential impact on corridor function.';
}


