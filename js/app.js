/**
 * app.js â€” Application entry point and orchestrator.
 *
 * Wires together the map, iNaturalist API, and UI modules.
 * Contains no business logic â€” delegates entirely to the imported modules:
 *
 *   map.js   â€” MapLibre instance, layers, popup, interactions
 *   api.js   â€” iNaturalist API fetching and GeoJSON conversion
 *   ui.js    â€” DOM panel, legend, status, popup HTML builder
 *   config.js â€” Layer/establishment definitions and constants
 */

import { LAYERS, GBIF_LAYERS, AREA_LAYERS, HAZARD_LAYERS, WAYSTATION_LAYER, HNP_LAYER, RASTER_LAYERS, NLCD_LAYERS, EBIRD_LAYER, PESTICIDE_LAYER, PARCEL_LAYER, COMMONS_LAYER } from './config.js';
import { fetchObservations, observationsToGeoJSON,
         partitionByLayer }                            from './api.js';
import { fetchGbifPollinators, fetchGbifPlants,
         gbifToGeoJSON, resolveOccurrenceEstKeys,
         partitionPlantOccurrences }                   from './gbif.js';
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
         setLayerFeatures, setAreaFeatures, setAreaMarkersFeatures,
         setLayerVisibility, setAreaVisibility, setRasterLayerVisibility,
         setPointLayerOpacity, setAreaLayerOpacity, setRasterOpacity,
         getInteractiveLayerIds, getInteractiveAreaLayerIds,
         showPopup, closePopup, wireInteractions,
         showAlertHighlight, clearAlertHighlight, fitToCoords,
         zoomToCluster, getEffectiveClusteredCoords,
         getMap } from './map.js';
import { buildLayerPanel, buildEstLegend, buildAreaLegend, buildPesticideLegend, updateCounts,
         setLoading, setStatus,
         buildPopupHTML, buildAreaPopupHTML,
         closeLightbox }                               from './ui.js';
import { cacheGet, cacheSet }                         from './cache.js';
import { computeAlerts, renderAlerts }                from './alerts.js';
import { initFilters, setBaseFeatures, setHabitatCoords,
         setDatePredicate, buildFilterChips, applyFilters } from './filters.js';
import { openDrawer, closeDrawer, isDrawerFeature,
         setSightings as setDrawerSightings,
         setHabitatSites as setDrawerHabitatSites,
         setNestingScores as setDrawerNestingScores,
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
import { fetchNestingScores, enrichCentroidsWithNesting } from './nesting.js';
import { fetchParcelsForBbox, classifyOwnership }         from './parcels.js';
import { fetchCommonsForApp }                             from './commons.js';

// â”€â”€ Utility â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Returns a debounced version of `fn` â€” calls are delayed by `ms` and
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

/** Populates the intel-bar summary strip with current data counts. */
function updateIntelBar({ corridorSqFt, habitatNodeCount, pollinatorCount, gddStat, ebirdCount, nativeSpeciesCount, alertCount }) {
  document.getElementById('intel-val-corridor').textContent  = formatArea(corridorSqFt);
  document.getElementById('intel-val-habitat').textContent   = habitatNodeCount > 0 ? habitatNodeCount : '—';
  document.getElementById('intel-val-inat').textContent      = pollinatorCount.toLocaleString();
  if (gddStat) {
    document.getElementById('intel-val-climate').textContent = gddStat.value;
    document.getElementById('intel-lbl-climate').textContent = gddStat.label;
  }
  const ebirdEl = document.getElementById('intel-val-ebird');
  if (ebirdEl) ebirdEl.textContent = ebirdCount > 0 ? ebirdCount.toLocaleString() : '—';
  document.getElementById('intel-val-species').textContent   = nativeSpeciesCount > 0 ? nativeSpeciesCount.toLocaleString() : '—';
  document.getElementById('intel-val-alerts').textContent    = alertCount;
  document.getElementById('intel-alerts')?.classList.toggle('intel-stat--has-alerts', alertCount > 0);
}

// â”€â”€ Layer visibility helpers (module-level so loadObservations can use them) â”€â”€

/**
 * IDs of all raster-backed layers â€” used to route visibility calls correctly.
 * Computed once from the static config; safe to evaluate before map 'load'.
 */
const _rasterLayerIds = new Set([
  ...RASTER_LAYERS.map(l => l.id),
  ...NLCD_LAYERS.map(l => l.id),
]);

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

// â”€â”€ Map setup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Timeline year-range state (shared with permalink)
let _timelineStartYear = new Date().getFullYear() - 1;
let _timelineEndYear   = new Date().getFullYear();

// Habitat node caches — kept module-level so setLayerActive can re-run the mesh
// without a full data reload.
let _corridorFeats   = [];
let _waystationFeats = [];
let _hnpFeats        = [];
// Full unfiltered eBird features — retained so the hummingbird toggle can re-filter
// without a network refetch.
let _ebirdAllFeats      = [];
let _ebirdHummingOnly   = false;
// Active site-layer set — reflects current toggle state for the three site-layer types.
const _activeSiteLayers = new Set(['gbcc-corridor', 'waystations', 'hnp']);

// Nesting score state — populated async after corridor data loads
let _nestingScores    = new Map();   // site name → {score, counts, total}
let _nestingLoaded    = false;        // true once first fetch completes
let _lastAlertArgs    = null;         // cached so re-render includes nesting scores
let _alertFocusHandler = null;        // module-level so async callbacks can re-render alerts

// Parcel and Commons state — populated lazily on first layer enable
let _parcelFeatures = [];
let _parcelLoaded   = false;
let _commonsLoaded  = false;

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
  const wsCoords  = getEffectiveClusteredCoords('waystations');
  const hnpCoords = getEffectiveClusteredCoords('hnp');

  const wsFeats  = wsCoords  ? _coordsToFeatures(wsCoords)  : _waystationFeats;
  const hnpFeats = hnpCoords ? _coordsToFeatures(hnpCoords) : _hnpFeats;

  updateConnectivityMesh(_corridorFeats, wsFeats, hnpFeats, _activeSiteLayers);
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
      const updatedAlerts = computeAlerts({ ..._lastAlertArgs, nestingScores: _nestingScores });
      if (_alertFocusHandler) renderAlerts(updatedAlerts, _alertFocusHandler);
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

// â”€â”€ Data loading â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Reads the current date inputs, loads observations and area data â€” serving
 * from the browser cache when available, and fetching from APIs only when a
 * cache entry is absent or expired.
 *
 * Cache TTLs:
 *   Observation data (iNat / GBIF)        â€” 1 hour,  keyed by date range
 *   Static area data (PAD-US, DNR, GBCC)  â€” 24 hours, fixed keys
 *
 * Changing the date range produces a different cache key for observations,
 * which triggers a fresh network fetch automatically.
 */
async function loadObservations() {
  // No date restriction — fetch all available history. The timeline scrubber
  // handles in-memory filtering by year range after data is loaded.

  setLoading(true);
  closePopup();
  setStatus('Loadingâ€¦');

  // TTL constants
  const OBS_TTL  =      60 * 60 * 1000;  // 1 h  â€” re-fetch when dates change
  const AREA_TTL = 24 * 60 * 60 * 1000;  // 24 h â€” area datasets change rarely

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
      inatResult, gbifPollResult, gbifPlantResult,
      padusResult, snaResult, dnrResult,
      corridorResult, treatmentResult, pfasResult, hnpResult, cdlStatsResult,
      quickStatsResult, cdlFringeResult, ebirdResult, pesticideResult,
    ] = await Promise.allSettled([

      // â”€â”€ Observations (date-keyed, 1 h TTL) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Caches the fully-processed layer partition so partitionByLayer and
      // observationsToGeoJSON are also skipped on a cache hit.
      withCache(`obs/inat/all`, OBS_TTL, async () => {
        const { observations, total } = await fetchObservations(undefined, undefined);
        const geojson  = observationsToGeoJSON(observations);
        const byLayer  = partitionByLayer(geojson, LAYERS.map(l => l.id));
        byLayer._total = total;  // stored alongside layer arrays
        return byLayer;
      }),

      // Caches the final GeoJSON features array â€” resolveOccurrenceEstKeys
      // (which makes extra iNat API calls) is also skipped on a cache hit.
      withCache(`obs/gbif-poll/all`, OBS_TTL, async () => {
        const { occurrences } = await fetchGbifPollinators(undefined, undefined);
        const estMap = await resolveOccurrenceEstKeys(occurrences);
        return gbifToGeoJSON(occurrences, 'gbif-pollinators', estMap).features;
      }),

      withCache(`obs/gbif-plants/all`, OBS_TTL, async () => {
        const { occurrences }       = await fetchGbifPlants(undefined, undefined);
        const { native, nonNative } = await partitionPlantOccurrences(occurrences);
        return {
          native:    gbifToGeoJSON(native,    'gbif-native-plants').features,
          nonNative: gbifToGeoJSON(nonNative, 'gbif-non-native-plants').features,
        };
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

    // â”€â”€ iNaturalist â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (inatResult.status === 'fulfilled') {
      const byLayer = inatResult.value;
      inatTotal = byLayer._total ?? 0;
      for (const layer of LAYERS) {
        const feats = byLayer[layer.id] ?? [];
        setLayerFeatures(layer.id, feats);
        counts[layer.id] = feats.length;
        inatObs += feats.length;
      }
    } else {
      console.error('iNaturalist failed:', inatResult.reason);
      for (const l of LAYERS) counts[l.id] = 0;
    }

    // â”€â”€ GBIF Pollinators â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (gbifPollResult.status === 'fulfilled') {
      const feats = gbifPollResult.value;
      setLayerFeatures('gbif-pollinators', feats);
      counts['gbif-pollinators'] = feats.length;
      gbifCount += feats.length;
    } else {
      console.warn('GBIF pollinators failed:', gbifPollResult.reason);
      counts['gbif-pollinators'] = 0;
    }

    // â”€â”€ GBIF Plants (native / non-native) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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



    // â”€â”€ PAD-US protected areas â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (padusResult.status === 'fulfilled') {
      setAreaFeatures('padus', padusResult.value);
      counts['padus'] = padusResult.value.features.length;
    } else {
      console.warn('PAD-US failed:', padusResult.reason);
      counts['padus'] = 0;
    }

    // â”€â”€ WI DNR State Natural Areas â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (snaResult.status === 'fulfilled') {
      setAreaFeatures('dnr-sna', snaResult.value);
      counts['dnr-sna'] = snaResult.value.features.length;
    } else {
      console.warn('WI DNR SNA failed:', snaResult.reason);
      counts['dnr-sna'] = 0;
    }

    // â”€â”€ WI DNR Managed Lands â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (dnrResult.status === 'fulfilled') {
      setAreaFeatures('dnr-managed', dnrResult.value);
      counts['dnr-managed'] = dnrResult.value.features.length;
    } else {
      console.warn('WI DNR Managed Lands failed:', dnrResult.reason);
      counts['dnr-managed'] = 0;
    }

    // â”€â”€ GBCC Pollinator Corridor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
          const updatedAlerts = computeAlerts({ ..._lastAlertArgs, nestingScores: scores });
          renderAlerts(updatedAlerts, _alertFocusHandler);
        }
      }).catch(() => { /* nesting scores unavailable — silent degradation */ });
    } else {
      console.warn('GBCC corridor failed:', corridorResult.reason);
      counts['gbcc-corridor'] = 0;
    }

    // â”€â”€ GBCC Habitat Treatments â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // â”€â”€ WI DNR PFAS Chemical Hazard Sites â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (pfasResult.status === 'fulfilled') {
      setLayerFeatures('dnr-pfas', pfasResult.value.features);
      counts['dnr-pfas'] = pfasResult.value.features.length;
    } else {
      console.warn('PFAS sites failed:', pfasResult.reason);
      counts['dnr-pfas'] = 0;
    }
    // â”€â”€ Homegrown National Park native planting yards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      // Apply hummingbird filter if the toggle is already on (e.g. page reload with saved state)
      const ebirdVisible = _ebirdHummingOnly
        ? ebirdFeats.filter(f => f.properties?.common?.toLowerCase().includes('hummingbird'))
        : ebirdFeats;
      setLayerFeatures('ebird', ebirdVisible);
      setBaseFeatures('ebird', ebirdVisible);
      counts['ebird'] = ebirdVisible.length;
      ebirdCount = ebirdVisible.length;
    } else {
      console.warn('eBird failed:', ebirdResult.reason);
      counts['ebird'] = 0;
    }

    const cdlStats   = cdlStatsResult.status   === 'fulfilled' ? cdlStatsResult.value   : null;
    const quickStats  = quickStatsResult.status  === 'fulfilled' ? quickStatsResult.value  : null;
    if (!cdlStats) console.warn('CDL stats unavailable (API returned null or failed)');
    updateCounts(counts);

    const capped     = inatObs < inatTotal;
    const cacheLabel = networkFetches === 0 ? ' Â· cached' : '';
    setStatus(
      `iNat: ${inatObs.toLocaleString()} / ${inatTotal.toLocaleString()}${capped ? ' â–²' : ''}` +
      ` Â· GBIF: ${gbifCount.toLocaleString()}${cacheLabel}`
    );

    // â”€â”€ Intelligence modules â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    _waystationFeats       = waystationGeoJSON().features;
    const corridorFeats    = _corridorFeats;
    const waystationFeats  = _waystationFeats;
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
    for (const layer of LAYERS) setBaseFeatures(layer.id, byLayer[layer.id] ?? []);
    setBaseFeatures('gbif-pollinators',       gbifPollResult.status  === 'fulfilled' ? gbifPollResult.value              : []);
    setBaseFeatures('gbif-native-plants',     gbifPlantResult.status === 'fulfilled' ? gbifPlantResult.value.native      : []);
    setBaseFeatures('gbif-non-native-plants', gbifPlantResult.status === 'fulfilled' ? gbifPlantResult.value.nonNative   : []);

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

    // Alerts
    _lastAlertArgs = {
      corridorFeatures:    corridorFeats,
      waystationFeatures:  waystationFeats,
      pfasFeatures:        pfasFeats,
      pollinatorSightings: allPollinatorFeatures,
      hnpFeatures:         hnpFeats,
      cdlStats,
      quickStats,
      climateData:         getClimateState(),
      pesticideCounties,
      parcelFeatures:      _parcelFeatures,
    };
    const alerts = computeAlerts({ ..._lastAlertArgs, nestingScores: _nestingScores });
    _alertFocusHandler = alert => {
      if (!alert.coords?.length) return;
      // Ensure all layers relevant to this alert are visible before zooming.
      for (const layerId of alert.layers ?? []) {
        setLayerActive(layerId, true);
      }
      showAlertHighlight(alert.coords, alert.level);
      const isGap = alert.key === 'connectivity-gap';
      fitToCoords(alert.coords, {
        padding: { top: 80, bottom: 100, left: 540, right: 80 },
        maxZoom: isGap ? 12 : 15,
      });
    };
    renderAlerts(alerts, _alertFocusHandler);

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

    // CDL fringe â€” static per-load; update source data once available
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
    });

  } catch (err) {
    console.error('Failed to load:', err);
    setStatus('Error â€” check console');
  } finally {
    setLoading(false);
  }
}

// â”€â”€ Map ready â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

map.on('load', async () => {

  // Register white vector icon sprites.
  // Must be called before registerAreaMarkersLayer and waystation registerLayer.
  // ðŸŒ¸ flower = pollinator corridor site pins  ðŸ¦‹ butterfly = waystation markers
  await registerSvgIcons();

  // 0. Raster background layers â€” rendered beneath all vector layers
  for (const layer of RASTER_LAYERS) {
    registerRasterLayer(layer.id, layer.defaultOn, layer.tileUrl, layer.attribution);
  }
  // 0b. NLCD per-class raster layers (16 toggleable land-cover types)
  for (const layer of NLCD_LAYERS) {
    registerRasterLayer(layer.id, layer.defaultOn, layer.tileUrl, layer.attribution);
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
  // 0d. CDL fringe heatmap â€” agricultural field edges near the corridor
  registerCdlFringeHeatmap(true);

  // 1. Polygon area layers FIRST â€” they render at the bottom of the stack
  for (const layer of AREA_LAYERS) {
    registerAreaLayer(layer.id, layer.defaultOn, layer.fillColor, layer.outlineColor);
  }

  // Corridor pin markers â€” circle + label above the fill polygons so small
  // planting areas remain visible at any zoom level
  const corridorCfg = AREA_LAYERS.find(l => l.id === 'gbcc-corridor');
  registerAreaMarkersLayer(
    'gbcc-corridor', corridorCfg.defaultOn,
    corridorCfg.fillColor, corridorCfg.outlineColor,
    'icon-hummingbird',
    true  // cluster corridor nodes that are close together
  );

  // 2. Hazard point layers â€” above polygons, below observation points
  for (const layer of HAZARD_LAYERS) {
    registerLayer(layer.id, layer.defaultOn, { radius: 8, symbol: 'icon-biohazard' });
  }

  // 2b. Waystation static layer â€” above hazards
  // Rendered as a large violet circle with a monarch butterfly icon overlay.
  for (const layer of WAYSTATION_LAYER) {
    registerLayer(layer.id, layer.defaultOn, {
      radius: 14, strokeWidth: 2, opacity: 1.0, symbol: 'icon-butterfly-detailed', iconSize: 0.44,      cluster: true, clusterColor: '#8b5cf6',    });
  }

  // 2c. Homegrown National Park native planting yards â€” immediately after waystations
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
  // 3. GBIF observation layers â€” above hazards
  // No symbol icon: dots are already distinguished by color; tiny icons were illegible.
  // GBIF layers — same icon per category as iNat for cross-source consistency
  registerLayer('gbif-pollinators',       GBIF_LAYERS.find(l => l.id === 'gbif-pollinators').defaultOn,       { gbif: true, radius: 7, opacity: 0.55, symbol: 'icon-butterfly', iconSize: 0.40 });
  registerLayer('gbif-native-plants',     GBIF_LAYERS.find(l => l.id === 'gbif-native-plants').defaultOn,     { gbif: true, radius: 7, opacity: 0.55, symbol: 'icon-flower' });
  registerLayer('gbif-non-native-plants', GBIF_LAYERS.find(l => l.id === 'gbif-non-native-plants').defaultOn, { gbif: true, radius: 7, opacity: 0.55, symbol: 'icon-flower-tulip' });
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


  // â”€â”€ Habitat Programs (primary section) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  buildLayerPanel(
    [
      { groupLabel: 'Pollinator Corridor Â· GBCC', layers: habitatAreaLayers  },
      { groupLabel: 'Monarch Watch Waystations',  layers: WAYSTATION_LAYER   },
      { groupLabel: 'Homegrown National Park',    layers: HNP_LAYER          },
    ],
    setLayerActive,
    document.getElementById('panel-habitat-inner'),
    handleOpacity,
  );

  // â”€â”€ Conservation Areas & Hazards (secondary, collapsed) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  buildLayerPanel(
    [
      { groupLabel: 'Habitat Treatments',  layers: conservationLayers.filter(l => l.id === 'gbcc-treatment') },
      { groupLabel: 'Protected Lands',     layers: conservationLayers.filter(l => !l.id.startsWith('gbcc-')) },
      { groupLabel: 'Hazards',             layers: HAZARD_LAYERS      },
      { groupLabel: 'Chemical Threats',    layers: [PESTICIDE_LAYER]  },
      { groupLabel: 'Ownership',           layers: [PARCEL_LAYER]     },
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

  // â”€â”€ Land Cover Analysis (NLCD classes + CDL, collapsed) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Group the 16 NLCD classes by their semantic group property.
  const nlcdByGroup = NLCD_LAYERS.reduce((acc, l) => {
    (acc[l.group] = acc[l.group] || []).push(l);
    return acc;
  }, {});
  buildLayerPanel(
    [
      ...Object.entries(nlcdByGroup).map(([g, layers]) => ({
        groupLabel: `NLCD Â· ${g}`,
        layers,
      })),
    ],
    setLayerActive,
    document.getElementById('panel-landcover-inner'),
    handleOpacity,
  );

  // â”€â”€ Sightings (tertiary, for impact correlation, collapsed) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  buildLayerPanel(
    [
      { groupLabel: 'iNaturalist',        layers: LAYERS      },
      { groupLabel: 'GBIF',               layers: GBIF_LAYERS },
      { groupLabel: 'eBird (Cornell Lab)', layers: EBIRD_LAYER },
      { groupLabel: 'Wikimedia Commons',  layers: [COMMONS_LAYER] },
    ],
    setLayerActive,
    null,
    handleOpacity,
  );
  buildEstLegend();
  buildAreaLegend(setLayerActive);

  // Permalink — restore state from URL hash, then init sync
  const _permalinkState = parsePermalink();
  if (_permalinkState) applyPermalinkState(_permalinkState, map);

  // Connectivity mesh follows corridor — no standalone toggle needed.
  document.getElementById('toggle-heatmap-traffic')?.addEventListener('change', e => {
    setHeatmapVisibility('pollinator-traffic-heat', e.target.checked);
  });
  document.getElementById('toggle-cdl-fringe')?.addEventListener('change', e => {
    setHeatmapVisibility('cdl-fringe-heat', e.target.checked);
  });
  document.getElementById('toggle-ebird-hummingbird')?.addEventListener('change', e => {
    _ebirdHummingOnly = e.target.checked;
    if (!_ebirdAllFeats.length) return; // not loaded yet
    const base = _ebirdHummingOnly
      ? _ebirdAllFeats.filter(f => f.properties?.common?.toLowerCase().includes('hummingbird'))
      : _ebirdAllFeats;
    setBaseFeatures('ebird', base);
    applyFilters();            // re-apply any active date/species filters on the new base
    // Update intel bar count to reflect the active subset
    const valEl = document.getElementById('intel-val-ebird');
    if (valEl) valEl.textContent = base.length.toLocaleString();
  });

  // "All layers off" button â€” unchecks every visible toggle in the panel
  document.getElementById('btn-layers-all-off')?.addEventListener('click', () => {
    document.querySelectorAll('#panel input[type="checkbox"]:checked').forEach(cb => {
      cb.checked = false;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });

  document.getElementById('btn-reload').addEventListener('click', loadObservations);

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

  // Climate data — loads async; once done, patch the GDD stat into the intel bar
  // (loadObservations may finish before climate data arrives on first paint).
  initClimatePanel().then(() => {
    const gddStat = getGddIntelStat();
    if (gddStat.value !== '\u2014') {
      document.getElementById('intel-val-climate').textContent = gddStat.value;
      document.getElementById('intel-lbl-climate').textContent = gddStat.label;
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

  // Alerts panel collapse/expand toggle
  const alertsToggleBtn = document.getElementById('alerts-panel-toggle');
  if (alertsToggleBtn) {
    alertsToggleBtn.addEventListener('click', () => {
      const panel    = document.getElementById('alerts-panel');
      const expanded = alertsToggleBtn.getAttribute('aria-expanded') === 'true';
      panel.classList.toggle('alerts-panel--collapsed', expanded);
      alertsToggleBtn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      alertsToggleBtn.textContent = expanded ? 'â–¶' : 'â–¼';
    });
  }

  // Intel-bar alerts stat â†’ expand and scroll the alerts panel into view
  const openAlertsPanel = () => {
    const panel = document.getElementById('alerts-panel');
    if (panel) {
      panel.classList.remove('alerts-panel--collapsed');
      const toggle = document.getElementById('alerts-panel-toggle');
      if (toggle) { toggle.textContent = 'â–¼'; toggle.setAttribute('aria-expanded', 'true'); }
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };
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

  // Wire click interactions on all layers (points + polygon fills)
  const pointLayerIds = getInteractiveLayerIds([...GBIF_LAYERS, ...LAYERS, ...HAZARD_LAYERS, ...WAYSTATION_LAYER, ...HNP_LAYER, ...EBIRD_LAYER]);
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

  // Initial data load
  loadObservations();
});


