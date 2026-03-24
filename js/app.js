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

import { LAYERS, GBIF_LAYERS, BEE_LAYERS, AREA_LAYERS, HAZARD_LAYERS, WAYSTATION_LAYER, HNP_LAYER, RASTER_LAYERS, NLCD_LAYERS, EBIRD_LAYER, PESTICIDE_LAYER, PARCEL_LAYER, COMMONS_LAYER, TREE_CANOPY_LAYERS, EXPANSION_LAYER, PROBLEM_AREAS_LAYER, INAT_HISTORY_START_YEAR } from './config.js';
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
         registerSuitabilityHeatmap,
         updateSuitabilityHeatmap,
         setLayerFeatures, setAreaFeatures, setAreaMarkersFeatures,
         setLayerVisibility, setAreaVisibility, setRasterLayerVisibility,
         setPointLayerOpacity, setAreaLayerOpacity, setRasterOpacity,
         getInteractiveLayerIds, getInteractiveAreaLayerIds,
         showPopup, closePopup, wireInteractions,
         showAlertHighlight, clearAlertHighlight, fitToCoords,
         zoomToCluster, getEffectiveClusteredCoords,
         getMap } from './map.js';
import { buildLayerPanel, buildEstLegend, buildAreaLegend, buildPesticideLegend, updateCounts,
         setLoading, setStatus, initActivityBar,
         buildPopupHTML, buildAreaPopupHTML,
         esc, closeLightbox }                               from './ui.js';
import { cacheGet, cacheSet }                         from './cache.js';
import { computeAlerts, renderAlerts,
         computeExpansionOpportunities,
         computeProblemFeatures,
         computeSuitabilityPoints }            from './alerts.js';
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
import { setExportData, exportReport, exportMapPng }  from './export.js';
import { parsePermalink, applyPermalinkState,
         initPermalink }                               from './permalink.js';
import { fetchEbirdObservations }                      from './ebird.js';
import { initClimatePanel, getClimateState, getGddIntelStat, openClimateRibbon } from './climate.js';
import { fetchPesticideCounties }                      from './pesticide.js';
import { fetchNestingScores, enrichCentroidsWithNesting, fetchCanopyScores } from './nesting.js';
import { fetchParcelsForBbox, classifyOwnership, hydrate as hydrateParcelCache } from './parcels.js';
import { fetchCommonsForApp }                             from './commons.js';
import { fetchSnapshotIndex, fetchSnapshot,
         availableYears, renderTrendChart }            from './history.js';
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
function updateIntelBar({ corridorSqFt, habitatNodeCount, pollinatorCount, gddStat, ebirdCount, nativeSpeciesCount, alertCount }) {
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
  else                                    setLayerVisibility(id, visible);
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

// ── Map setup ─────────────────────────────────────────────────────────────────

// Timeline year-range state (shared with permalink)
let _timelineStartYear = new Date().getFullYear() - 1;
let _timelineEndYear   = new Date().getFullYear();

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

// Nesting score state — populated async after corridor data loads
let _nestingScores    = new Map();   // site name → {score, counts, total}
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

        if (layerId === 'pollinators') newSightings.push(...newFeats);
      }

      if (yearAdded > 0) {
        totalAdded += yearAdded;
        applyFilters();

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
    const images = await fetchCommonsForApp(center);
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
    setMapCommonsFeatures({ type: 'FeatureCollection', features });
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
    const [
      inatResult, gbifPollResult, gbifPlantResult, gbifWildlifeResult, beesResult,
      padusResult, snaResult, dnrResult,
      corridorResult, treatmentResult, pfasResult, hnpResult, cdlStatsResult,
      quickStatsResult, cdlFringeResult, ebirdResult, pesticideResult,
    ] = await Promise.allSettled([

      // ── Observations (date-keyed, 1 h TTL) ──────────────────────────────
      // Caches the fully-processed layer partition so partitionByLayer and
      // observationsToGeoJSON are also skipped on a cache hit.
      withCache(`obs/inat/all`, OBS_TTL, async () => {
        const { observations, total } = await fetchObservations(undefined, undefined);
        const geojson  = observationsToGeoJSON(observations);
        const byLayer  = partitionByLayer(geojson, LAYERS.map(l => l.id));
        byLayer._total = total;  // stored alongside layer arrays
        return byLayer;
      }),

      // Caches the final GeoJSON features array — resolveOccurrenceEstKeys
      // (which makes extra iNat API calls) is also skipped on a cache hit.
      withCache(`obs/gbif-poll/v2`, OBS_TTL, async () => {
        const { occurrences } = await fetchGbifPollinators(undefined, undefined);
        const estMap = await resolveOccurrenceEstKeys(occurrences);
        return gbifToGeoJSON(occurrences, 'gbif-pollinators', estMap).features;
      }),

      withCache(`obs/gbif-plants/v2`, OBS_TTL, async () => {
        const { occurrences }       = await fetchGbifPlants(undefined, undefined);
        const { native, nonNative } = await partitionPlantOccurrences(occurrences);
        return {
          native:    gbifToGeoJSON(native,    'gbif-native-plants').features,
          nonNative: gbifToGeoJSON(nonNative, 'gbif-non-native-plants').features,
        };
      }),

      withCache(`obs/gbif-wildlife/v1`, OBS_TTL, async () => {
        const { occurrences } = await fetchGbifWildlife(undefined, undefined);
        return gbifToGeoJSON(occurrences, 'gbif-wildlife').features;
      }),

      withCache(`obs/bees/v1`, OBS_TTL, async () => {
        const { occurrences } = await fetchBeesAll(undefined, undefined);
        return beesToGeoJSON(occurrences, 'bees-records').features;
      }),

      // ── Static area data (fixed keys, 24 h TTL) ──────────────────────────────────────────────
      withCache('area/padus',          AREA_TTL, fetchPadUs),
      withCache('area/dnr-sna',        AREA_TTL, fetchDnrSna),
      withCache('area/dnr-managed',    AREA_TTL, fetchDnrManagedLands),
      withCache('area/gbcc-corridor',  AREA_TTL, fetchPollinatorCorridor),
      withCache('area/gbcc-treatment', AREA_TTL, fetchCorridorTreatments),
      withCache('area/dnr-pfas',       AREA_TTL, fetchChemicalHazards),
      withCache('area/hnp',            AREA_TTL, fetchHnpYards),
      withCache('area/cdl-stats',       AREA_TTL, fetchCdlStats),
      withCache('area/quickstats',        AREA_TTL, fetchQuickStats),
      withCache('area/cdl-fringe',        AREA_TTL, fetchCdlFringe),

      // ── eBird recent bird observations (1 h TTL, always last 30 days) ───
      withCache(`obs/ebird/all`, OBS_TTL, () => fetchEbirdObservations()),

      // ── Pesticide county choropleth (24 h TTL, static county data) ──────────
      withCache('area/pesticide', AREA_TTL, fetchPesticideCounties),
    ]);

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
          document.getElementById('intel-val-alerts').textContent = updatedAlerts.length;
          document.getElementById('intel-alerts')?.classList.toggle('intel-stat--has-alerts', updatedAlerts.length > 0);
          _updateAlertBadge(updatedAlerts.length);
          setExportData({ alerts: updatedAlerts });
        }
      }).catch(() => { /* nesting scores unavailable — silent degradation */ });

      // Async: fetch WI DNR tree canopy coverage scores after corridor data loads
      fetchCanopyScores(_corridorCentroids.features).then(scores => {
        _canopyScores = scores;
        setDrawerCanopyScores(scores);
        if (_lastAlertArgs) {
          const updatedAlerts = computeAlerts({ ..._lastAlertArgs, nestingScores: _nestingScores, canopyScores: scores });
          renderAlerts(updatedAlerts, _alertFocusHandler);
          document.getElementById('intel-val-alerts').textContent = updatedAlerts.length;
          document.getElementById('intel-alerts')?.classList.toggle('intel-stat--has-alerts', updatedAlerts.length > 0);
          _updateAlertBadge(updatedAlerts.length);
          setExportData({ alerts: updatedAlerts });
        }
      }).catch(() => { /* canopy scores unavailable — silent degradation */ });
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

    _corridorFeats         = corridorResult.status  === 'fulfilled' ? corridorResult.value.features  : [];
    _waystationFeats          = waystationGeoJSON().features;
    _confirmedWaystationFeats = _waystationFeats.filter(f => !f.properties.approximate);
    const corridorFeats       = _corridorFeats;
    const waystationFeats     = _waystationFeats;
    const confirmedWaystationFeats = _confirmedWaystationFeats;
    counts['waystations']  = waystationFeats.length;
    registerTemporalLayer(
      'waystations',
      waystationFeats,
      f => f.properties?.registered,
      filtered => setLayerFeatures('waystation', filtered),
    );
    const pfasFeats        = pfasResult.status      === 'fulfilled' ? pfasResult.value.features     : [];
    _hnpFeats              = hnpResult.status       === 'fulfilled' ? hnpResult.value.features      : [];
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
    updateExpansionOpportunitiesLayer(computeExpansionOpportunities({
      ..._analysisCtx,
      nestingScores: _nestingScores,
    }));
    updateProblemAreasLayer(computeProblemFeatures({
      ..._analysisCtx,
      nestingScores: _nestingScores,
      canopyScores:  _canopyScores,
    }));
    updateSuitabilityHeatmap(computeSuitabilityPoints({
      ..._analysisCtx,
      nestingScores: _nestingScores,
    }));

    // Timeline bounds
    updateTimelineBounds(allPollinatorFeatures);

    // Heatmaps — update with latest habitat node data
    refreshConnectivityMesh();
    const allSightings = [
      // iNat pollinators only (butterflies, bees, etc.) — exclude plants and non-pollinator wildlife
      ...(inatResult.status === 'fulfilled' ? (inatResult.value['pollinators'] ?? []) : []),
      // GBIF pollinators only
      ...(gbifPollResult.status === 'fulfilled' ? gbifPollResult.value : []),
      // eBird: hummingbirds only (the only reliable pollinator birds in Green Bay area)
      ...(ebirdResult.status === 'fulfilled'
        ? (ebirdResult.value.features ?? []).filter(f =>
            f.properties?.common?.toLowerCase().includes('hummingbird'))
        : []),
    ];
    updatePollinatorTrafficHeatmap(allSightings);

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
      habitatNodeCount,
      pollinatorCount,
      gddStat:           getGddIntelStat(),
      ebirdCount,
      nativeSpeciesCount,
      alertCount:        alerts.length,
    });

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
async function loadHistoricalTrends() {
  const container = document.getElementById('panel-history-inner');
  if (!container) return;

  let index;
  try { index = await fetchSnapshotIndex(); }
  catch { index = []; }

  const inatYears = availableYears(index, 'inat').slice(-5);
  const noaaYears = availableYears(index, 'noaa').slice(-5);

  if (inatYears.length < 2 && noaaYears.length < 2) {
    container.innerHTML =
      '<p class="layer-desc" style="margin:0.5rem 0.25rem;">No trend data yet.<br>' +
      'Trigger a harvest via:<br>' +
      '<code style="font-size:0.72rem;word-break:break-all;">POST /api/harvest ' +
      '{ &quot;source&quot;: &quot;inat&quot;, &quot;year&quot;: 2025 }</code></p>';
    return;
  }

  // Fetch up to 5 most recent inat years, one at a time (avoid parallel RAM spike)
  let inatPoints = null;
  if (inatYears.length >= 2) {
    inatPoints = [];
    for (const yr of inatYears) {
      const snap = await fetchSnapshot('inat', yr);
      if (snap) inatPoints.push({ year: yr, value: snap.total ?? 0 });
    }
  }

  // Fetch up to 5 most recent noaa years sequentially
  let noaaPoints = null;
  if (noaaYears.length >= 2) {
    noaaPoints = [];
    for (const yr of noaaYears) {
      const snap = await fetchSnapshot('noaa', yr);
      if (snap) noaaPoints.push({ year: yr, value: snap.gddTotal ?? 0 });
    }
  }

  container.innerHTML = '';

  if (inatPoints && inatPoints.length >= 2) {
    const wrap = document.createElement('div');
    wrap.className = 'history-chart-block';
    wrap.innerHTML =
      '<p class="layer-group-label" style="margin:0.5rem 0 0.25rem;">iNat pollinator sightings</p>' +
      '<div id="history-chart-inat"></div>';
    container.appendChild(wrap);
    renderTrendChart('history-chart-inat', inatPoints, 'iNaturalist pollinator sighting totals by year');
  }

  if (noaaPoints && noaaPoints.length >= 2) {
    const wrap = document.createElement('div');
    wrap.className = 'history-chart-block';
    wrap.innerHTML =
      '<p class="layer-group-label" style="margin:0.75rem 0 0.25rem;">GDD accumulation (base 50 °F)</p>' +
      '<div id="history-chart-noaa"></div>';
    container.appendChild(wrap);
    renderTrendChart('history-chart-noaa', noaaPoints, 'Annual growing degree day totals by year');
  }

  // Nullify refs to allow GC
  inatPoints = null;
  noaaPoints = null;
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
  }  // 0c. Pesticide pressure choropleth — registered beneath all vector area layers
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
  // 0d. CDL fringe heatmap — agricultural field edges near the corridor
  registerCdlFringeHeatmap(true);
  // 0e. Analysis layers — expansion opportunities, problem areas, suitability heatmap
  registerExpansionOpportunitiesLayer(false);
  registerProblemAreasLayer(false);
  registerSuitabilityHeatmap(false);

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

  // ── Sightings (pane-sightings) ────────────────────────────────────────────────
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

  // Initialise the activity bar (opens/closes flyout panes)
  const activityBar = initActivityBar();

  // Permalink — restore state from URL hash, then init sync
  const _permalinkState = parsePermalink();
  if (_permalinkState) applyPermalinkState(_permalinkState, map);

  // Connectivity mesh follows corridor — no standalone toggle needed.
  document.getElementById('toggle-heatmap-traffic')?.addEventListener('change', e => {
    setHeatmapVisibility('pollinator-traffic-heat', e.target.checked);
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
  document.getElementById('toggle-suitability-heat')?.addEventListener('change', e => {
    setHeatmapVisibility('suitability-heat', e.target.checked);
  });
  // "All layers off" button — unchecks every visible toggle in the panel
  document.getElementById('btn-layers-all-off')?.addEventListener('click', () => {
    document.querySelectorAll('#panel-flyout input[type="checkbox"]:checked').forEach(cb => {
      cb.checked = false;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });

  // Export button
  document.getElementById('btn-export').addEventListener('click', exportReport);
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
  // for iNaturalist; GBIF records can go further).  Default window is last 1 yr.
  initTimeline((startYear, endYear, activeMonths) => {
    _timelineStartYear = startYear;
    _timelineEndYear   = endYear;
    _syncTreeCanopyYear(endYear);
    setDatePredicate(dateStr => {
      if (!dateStr) return true;
      const d = new Date(dateStr);
      const y = d.getFullYear();
      if (y < startYear || y > endYear) return false;
      if (activeMonths.size > 0 && !activeMonths.has(d.getMonth())) return false;
      return true;
    });
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
  wireInteractions(
    [...areaLayerIds, ...pointLayerIds],
    (lngLat, props, feature) => {
      // Cluster aggregate — zoom in to expand
      if (props.cluster) {
        zoomToCluster(feature.layer.source, props.cluster_id, feature.geometry.coordinates);
        return;
      }
      if (isDrawerFeature(props)) {
        openDrawer(feature ?? { properties: props, geometry: { type: 'Point', coordinates: [lngLat.lng, lngLat.lat] } });
      } else {
        const html = props.data_source ? buildAreaPopupHTML(props) : buildPopupHTML(props);
        showPopup(lngLat, html);
      }
    }
  );

  // Wire clicks for analysis layers → intel drawer
  wireInteractions(
    ['points-expansion-opportunities', 'points-problem-areas'],
    (_lngLat, props) => {
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
          </div>`;
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
    }
  );

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


