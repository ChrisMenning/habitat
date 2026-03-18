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

import { LAYERS, GBIF_LAYERS, AREA_LAYERS, HAZARD_LAYERS, WAYSTATION_LAYER, HNP_LAYER, RASTER_LAYERS, NLCD_LAYERS, EBIRD_LAYER } from './config.js';
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
         setLayerFeatures, setAreaFeatures, setAreaMarkersFeatures,
         setLayerVisibility, setAreaVisibility, setRasterLayerVisibility,
         setPointLayerOpacity, setAreaLayerOpacity, setRasterOpacity,
         getInteractiveLayerIds, getInteractiveAreaLayerIds,
         showPopup, closePopup, wireInteractions,
         showAlertHighlight, clearAlertHighlight, fitToCoords,
         getMap } from './map.js';
import { buildLayerPanel, buildEstLegend, buildAreaLegend, updateCounts,
         setLoading, setStatus, getDefaultDates,
         buildPopupHTML, buildAreaPopupHTML }          from './ui.js';
import { cacheGet, cacheSet }                         from './cache.js';
import { computeAlerts, renderAlerts }                from './alerts.js';
import { initFilters, setBaseFeatures, setHabitatCoords,
         setDatePredicate, buildFilterChips }             from './filters.js';
import { openDrawer, closeDrawer, isDrawerFeature,
         setSightings as setDrawerSightings,
         setHabitatSites as setDrawerHabitatSites }   from './drawer.js';
import { initTimeline, updateTimelineBounds,
         mountTimelineDrag, registerTemporalLayer }   from './timeline.js';
import { setExportData, exportReport, exportMapPng }  from './export.js';
import { parsePermalink, applyPermalinkState,
         initPermalink }                               from './permalink.js';
import { fetchEbirdObservations }                      from './ebird.js';

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

/** Populates the intel-bar summary strip with current data counts. */
function updateIntelBar({ corridorCount, waystationCount, inatCount, gbifCount, ebirdCount, alertCount, fromCache }) {
  document.getElementById('intel-val-corridor').textContent   = corridorCount;
  document.getElementById('intel-val-waystation').textContent = waystationCount;
  document.getElementById('intel-val-inat').textContent       = inatCount.toLocaleString();
  document.getElementById('intel-val-gbif').textContent       = gbifCount.toLocaleString();
  document.getElementById('intel-val-alerts').textContent     = alertCount;
  const ebirdEl = document.getElementById('intel-val-ebird');
  if (ebirdEl) ebirdEl.textContent = ebirdCount > 0 ? ebirdCount.toLocaleString() : '—';
  document.getElementById('intel-val-cache').textContent      = fromCache ? 'Cached' : 'Live';
  // Pulsing glow when there are active alerts
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
    updateConnectivityMesh(_corridorFeats, _waystationFeats, _hnpFeats, _activeSiteLayers);
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
// Active site-layer set — reflects current toggle state for the three site-layer types.
const _activeSiteLayers = new Set(['gbcc-corridor', 'waystations', 'hnp']);

const map = initMap('map');

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
  const d1 = document.getElementById('date-from').value || undefined;
  const d2 = document.getElementById('date-to').value   || undefined;

  setLoading(true);
  closePopup();
  setStatus('Loadingâ€¦');

  // TTL constants
  const OBS_TTL  =      60 * 60 * 1000;  // 1 h  â€” re-fetch when dates change
  const AREA_TTL = 24 * 60 * 60 * 1000;  // 24 h â€” area datasets change rarely

  // Embed dates in observation cache keys so a date change is a natural miss.
  const obsKey = `${d1 ?? ''}:${d2 ?? ''}`;

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
      quickStatsResult, cdlFringeResult, ebirdResult,
    ] = await Promise.allSettled([

      // â”€â”€ Observations (date-keyed, 1 h TTL) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Caches the fully-processed layer partition so partitionByLayer and
      // observationsToGeoJSON are also skipped on a cache hit.
      withCache(`obs/inat/${obsKey}`, OBS_TTL, async () => {
        const { observations, total } = await fetchObservations(d1, d2);
        const geojson  = observationsToGeoJSON(observations);
        const byLayer  = partitionByLayer(geojson, LAYERS.map(l => l.id));
        byLayer._total = total;  // stored alongside layer arrays
        return byLayer;
      }),

      // Caches the final GeoJSON features array â€” resolveOccurrenceEstKeys
      // (which makes extra iNat API calls) is also skipped on a cache hit.
      withCache(`obs/gbif-poll/${obsKey}`, OBS_TTL, async () => {
        const { occurrences } = await fetchGbifPollinators(d1, d2);
        const estMap = await resolveOccurrenceEstKeys(occurrences);
        return gbifToGeoJSON(occurrences, 'gbif-pollinators', estMap).features;
      }),

      withCache(`obs/gbif-plants/${obsKey}`, OBS_TTL, async () => {
        const { occurrences }       = await fetchGbifPlants(d1, d2);
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

      // ── eBird recent bird observations (date-keyed, 1 h TTL) ───
      withCache(`obs/ebird/${obsKey}`, OBS_TTL, () => fetchEbirdObservations()),
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
      setAreaMarkersFeatures('gbcc-corridor', corridorCentroids(corridorResult.value));
      counts['gbcc-corridor'] = corridorResult.value.features.length;
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
    if (!cdlStats) console.warn('CDL stats failed:', cdlStatsResult.reason);
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

    // Alerts
    const alerts = computeAlerts({
      corridorFeatures:    corridorFeats,
      waystationFeatures:  waystationFeats,
      pfasFeatures:        pfasFeats,
      pollinatorSightings: allPollinatorFeatures,
      hnpFeatures:         hnpFeats,
      cdlStats,
      quickStats,
    });
    renderAlerts(alerts, alert => {
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
    });

    // Timeline bounds
    updateTimelineBounds(allPollinatorFeatures);

    // Heatmaps â€” update with latest habitat node data
    updateConnectivityMesh(_corridorFeats, _waystationFeats, _hnpFeats, _activeSiteLayers);
    const allSightings = [
      ...(inatResult.status === 'fulfilled' ? [
        ...(inatResult.value['pollinators']    ?? []),
        ...(inatResult.value['native-plants']  ?? []),
        ...(inatResult.value['other-plants']   ?? []),
        ...(inatResult.value['other-wildlife'] ?? []),
      ] : []),
      ...(gbifPollResult.status  === 'fulfilled' ? gbifPollResult.value                                     : []),
      ...(gbifPlantResult.status === 'fulfilled' ? [...gbifPlantResult.value.native, ...gbifPlantResult.value.nonNative] : []),
      ...(ebirdResult.status     === 'fulfilled' ? ebirdResult.value.features ?? []                       : []),
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

    // Intel bar
    updateIntelBar({
      corridorCount:    counts['gbcc-corridor'] ?? 0,
      waystationCount:  56,
      inatCount:        pollinatorCount,
      gbifCount,
      ebirdCount,
      alertCount:       alerts.length,
      fromCache:        networkFetches === 0,
    });

    // Export snapshot
    setExportData({
      corridorCount:      counts['gbcc-corridor'] ?? 0,
      waystationCount:    56,
      inatCount:          inatObs,
      gbifCount,
      dateFrom:           d1 ?? '',
      dateTo:             d2 ?? '',
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
  }
  // 0c. Connectivity mesh — registered early so it sits above rasters but below point layers.
  // Visibility matches the corridor layer's defaultOn; no separate toggle.
  registerConnectivityMesh(true);
  registerPollinatorTrafficHeatmap(false);
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
    'icon-hummingbird'
  );

  // 2. Hazard point layers â€” above polygons, below observation points
  for (const layer of HAZARD_LAYERS) {
    registerLayer(layer.id, layer.defaultOn, { radius: 8, symbol: 'icon-biohazard' });
  }

  // 2b. Waystation static layer â€” above hazards
  // Rendered as a large violet circle with a monarch butterfly icon overlay.
  for (const layer of WAYSTATION_LAYER) {
    registerLayer(layer.id, layer.defaultOn, {
      radius: 14, strokeWidth: 2, opacity: 1.0, symbol: 'icon-butterfly-detailed',
    });
  }

  // 2c. Homegrown National Park native planting yards â€” immediately after waystations
  for (const layer of HNP_LAYER) {
    registerLayer(layer.id, layer.defaultOn, {
      radius: 13, strokeWidth: 2, opacity: 0.95, symbol: 'icon-park',
    });
  }
  // 2d. eBird bird sightings layer
  for (const layer of EBIRD_LAYER) {
    registerLayer(layer.id, layer.defaultOn, { radius: 7, symbol: 'icon-crow' });
  }
  // 3. GBIF observation layers â€” above hazards
  // No symbol icon: dots are already distinguished by color; tiny icons were illegible.
  // GBIF layers — same icon per category as iNat for cross-source consistency
  registerLayer('gbif-pollinators',       GBIF_LAYERS.find(l => l.id === 'gbif-pollinators').defaultOn,       { gbif: true, radius: 7, opacity: 0.55, symbol: 'icon-butterfly', iconSize: 0.50 });
  registerLayer('gbif-native-plants',     GBIF_LAYERS.find(l => l.id === 'gbif-native-plants').defaultOn,     { gbif: true, radius: 7, opacity: 0.55, symbol: 'icon-flower' });
  registerLayer('gbif-non-native-plants', GBIF_LAYERS.find(l => l.id === 'gbif-non-native-plants').defaultOn, { gbif: true, radius: 7, opacity: 0.55, symbol: 'icon-flower-tulip' });
  // 4. iNaturalist layers â€” topmost
  // iNat layers — SVG icons per category
  registerLayer('pollinators',    LAYERS.find(l => l.id === 'pollinators').defaultOn,    { radius: 8, symbol: 'icon-butterfly', iconSize: 0.50 });
  registerLayer('native-plants',  LAYERS.find(l => l.id === 'native-plants').defaultOn,  { radius: 8, symbol: 'icon-flower' });
  registerLayer('other-plants',   LAYERS.find(l => l.id === 'other-plants').defaultOn,   { radius: 8, symbol: 'icon-flower-tulip' });
  registerLayer('other-wildlife', LAYERS.find(l => l.id === 'other-wildlife').defaultOn, { radius: 8, symbol: 'icon-deer' });

  // Build the side-panel UI
  // Opacity callback: routes to the correct setter based on layer type
  function handleOpacity(id, opacity) {
    if (AREA_LAYERS.some(l => l.id === id))    setAreaLayerOpacity(id, opacity);
    else if (_rasterLayerIds.has(id))          setRasterOpacity(id, opacity);
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
    ],
    setLayerActive,
    document.getElementById('panel-areas-inner'),
    handleOpacity,
  );

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
      { groupLabel: 'Cropland Data Layer (USDA)', layers: RASTER_LAYERS },
    ],
    setLayerActive,
    document.getElementById('panel-landcover-inner'),
    handleOpacity,
  );

  // â”€â”€ Sightings (tertiary, for impact correlation, collapsed) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  buildLayerPanel(
    [
      { groupLabel: 'iNaturalist',     layers: LAYERS      },
      { groupLabel: 'GBIF',            layers: GBIF_LAYERS },
      { groupLabel: 'eBird (Cornell Lab)', layers: EBIRD_LAYER },
    ],
    setLayerActive,
    null,
    handleOpacity,
  );
  buildEstLegend();
  buildAreaLegend(setLayerActive);

  // Populate date inputs with defaults
  const { from, to } = getDefaultDates();
  document.getElementById('date-from').value = from;
  document.getElementById('date-to').value   = to;

  // Connectivity mesh follows corridor — no standalone toggle needed.
  document.getElementById('toggle-heatmap-traffic')?.addEventListener('change', e => {
    setHeatmapVisibility('pollinator-traffic-heat', e.target.checked);
  });
  document.getElementById('toggle-cdl-fringe')?.addEventListener('change', e => {
    setHeatmapVisibility('cdl-fringe-heat', e.target.checked);
  });

  // "All layers off" button â€” unchecks every visible toggle in the panel
  document.getElementById('btn-layers-all-off')?.addEventListener('click', () => {
    document.querySelectorAll('#panel input[type="checkbox"]:checked').forEach(cb => {
      cb.checked = false;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });

  document.getElementById('btn-reload').addEventListener('click', loadObservations);

  // Auto-reload when dates change (debounced so the request only fires once
  // the user finishes picking, not on every keystroke)
  const debouncedLoad = debounce(loadObservations, 600);
  document.getElementById('date-from').addEventListener('change', debouncedLoad);
  document.getElementById('date-to').addEventListener('change', debouncedLoad);

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
    if (e.key === 'Escape')
      document.querySelectorAll('.modal-overlay:not([hidden])').forEach(m => m.setAttribute('hidden', ''));
  });

  // Load static waystation GeoJSON immediately (no async fetch needed)
  setLayerFeatures('waystations', waystationGeoJSON().features);

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

  // Permalink — restore state from URL hash, then init sync
  const _permalinkState = parsePermalink();
  if (_permalinkState) applyPermalinkState(_permalinkState, map);
  initPermalink(
    () => getMap(),
    () => [_timelineStartYear, _timelineEndYear],
  );

  document.getElementById('site-drawer-close').addEventListener('click', closeDrawer);

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

  // Wire click interactions on all layers (points + polygon fills)
  const pointLayerIds = getInteractiveLayerIds([...GBIF_LAYERS, ...LAYERS, ...HAZARD_LAYERS, ...WAYSTATION_LAYER, ...HNP_LAYER]);
  const areaLayerIds  = getInteractiveAreaLayerIds(AREA_LAYERS);
  wireInteractions(
    [...areaLayerIds, ...pointLayerIds],
    (lngLat, props, feature) => {
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


