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

import { LAYERS, GBIF_LAYERS, AREA_LAYERS, HAZARD_LAYERS, WAYSTATION_LAYER, HNP_LAYER } from './config.js';
import { fetchObservations, observationsToGeoJSON,
         partitionByLayer }                            from './api.js';
import { fetchGbifPollinators, fetchGbifPlants, gbifToGeoJSON,
         resolveOccurrenceEstKeys,
         partitionPlantOccurrences }                   from './gbif.js';
import { fetchPadUs, fetchDnrSna, fetchDnrManagedLands,
         fetchPollinatorCorridor, fetchCorridorTreatments,
         fetchChemicalHazards,
         corridorCentroids }                          from './areas.js';
import { waystationGeoJSON }                          from './waystations.js';
import { fetchHnpYards }                              from './hnp.js';
import { initMap, registerLayer, registerAreaLayer,
         registerAreaMarkersLayer,
         registerVectorIcons,
         setLayerFeatures, setAreaFeatures, setAreaMarkersFeatures,
         setLayerVisibility, setAreaVisibility,
         getInteractiveLayerIds, getInteractiveAreaLayerIds,
         showPopup, closePopup, wireInteractions,
         showAlertHighlight, clearAlertHighlight, fitToCoords } from './map.js';
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
         mountTimelineDrag }                          from './timeline.js';
import { setExportData, exportReport }                from './export.js';

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

/** Populates the intel-bar summary strip with current data counts. */
function updateIntelBar({ corridorCount, waystationCount, inatCount, gbifCount, alertCount, fromCache }) {
  document.getElementById('intel-val-corridor').textContent   = corridorCount;
  document.getElementById('intel-val-waystation').textContent = waystationCount;
  document.getElementById('intel-val-inat').textContent       = inatCount.toLocaleString();
  document.getElementById('intel-val-gbif').textContent       = gbifCount.toLocaleString();
  document.getElementById('intel-val-alerts').textContent     = alertCount;
  document.getElementById('intel-val-cache').textContent      = fromCache ? 'Cached' : 'Live';
}

// ── Map setup ─────────────────────────────────────────────────────────────────

const map = initMap('map');

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
  const d1 = document.getElementById('date-from').value || undefined;
  const d2 = document.getElementById('date-to').value   || undefined;

  setLoading(true);
  closePopup();
  setStatus('Loading…');

  // TTL constants
  const OBS_TTL  =      60 * 60 * 1000;  // 1 h  — re-fetch when dates change
  const AREA_TTL = 24 * 60 * 60 * 1000;  // 24 h — area datasets change rarely

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
      corridorResult, treatmentResult, pfasResult, hnpResult,
    ] = await Promise.allSettled([

      // ── Observations (date-keyed, 1 h TTL) ──────────────────────────────
      // Caches the fully-processed layer partition so partitionByLayer and
      // observationsToGeoJSON are also skipped on a cache hit.
      withCache(`obs/inat/${obsKey}`, OBS_TTL, async () => {
        const { observations, total } = await fetchObservations(d1, d2);
        const geojson  = observationsToGeoJSON(observations);
        const byLayer  = partitionByLayer(geojson, LAYERS.map(l => l.id));
        byLayer._total = total;  // stored alongside layer arrays
        return byLayer;
      }),

      // Caches the final GeoJSON features array — resolveOccurrenceEstKeys
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

      // ── Static area data (fixed keys, 24 h TTL) ──────────────────────────
      withCache('area/padus',          AREA_TTL, fetchPadUs),
      withCache('area/dnr-sna',        AREA_TTL, fetchDnrSna),
      withCache('area/dnr-managed',    AREA_TTL, fetchDnrManagedLands),
      withCache('area/gbcc-corridor',  AREA_TTL, fetchPollinatorCorridor),
      withCache('area/gbcc-treatment', AREA_TTL, fetchCorridorTreatments),
      withCache('area/dnr-pfas',       AREA_TTL, fetchChemicalHazards),
      withCache('area/hnp',            AREA_TTL, fetchHnpYards),
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
      setAreaMarkersFeatures('gbcc-corridor', corridorCentroids(corridorResult.value));
      counts['gbcc-corridor'] = corridorResult.value.features.length;
    } else {
      console.warn('GBCC corridor failed:', corridorResult.reason);
      counts['gbcc-corridor'] = 0;
    }

    // ── GBCC Habitat Treatments ───────────────────────────────────────
    if (treatmentResult.status === 'fulfilled') {
      setAreaFeatures('gbcc-treatment', treatmentResult.value);
      counts['gbcc-treatment'] = treatmentResult.value.features.length;
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
      ...(gbifPollResult.status === 'fulfilled'  ? gbifPollResult.value  : []),
      ...(gbifPlantResult.status === 'fulfilled' ? gbifPlantResult.value.native    : []),
      ...(gbifPlantResult.status === 'fulfilled' ? gbifPlantResult.value.nonNative : []),
    ];

    const corridorFeats    = corridorResult.status  === 'fulfilled' ? corridorResult.value.features  : [];
    const waystationFeats  = waystationGeoJSON().features;
    const pfasFeats        = pfasResult.status      === 'fulfilled' ? pfasResult.value.features     : [];
    const hnpFeats         = hnpResult.status       === 'fulfilled' ? hnpResult.value.features      : [];
    const allHabitatFeats  = [...corridorFeats, ...waystationFeats, ...hnpFeats];

    // Drawer data
    setDrawerSightings(allPollinatorFeatures);
    setDrawerHabitatSites(allHabitatFeats);

    // Filter chip base features
    const byLayer = inatResult.status === 'fulfilled' ? inatResult.value : {};
    for (const layer of LAYERS) setBaseFeatures(layer.id, byLayer[layer.id] ?? []);
    setBaseFeatures('gbif-pollinators',    gbifPollResult.status  === 'fulfilled' ? gbifPollResult.value              : []);
    setBaseFeatures('gbif-native-plants',  gbifPlantResult.status === 'fulfilled' ? gbifPlantResult.value.native      : []);
    setBaseFeatures('gbif-non-native-plants', gbifPlantResult.status === 'fulfilled' ? gbifPlantResult.value.nonNative : []);

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
      corridorFeatures:   corridorFeats,
      waystationFeatures: waystationFeats,
      pfasFeatures:       pfasFeats,
      pollinatorSightings: allPollinatorFeatures,
    });
    renderAlerts(alerts, alert => {
      if (!alert.coords?.length) return;
      showAlertHighlight(alert.coords, alert.level);
      fitToCoords(alert.coords, { padding: 100, maxZoom: 15 });
    });

    // Timeline bounds
    updateTimelineBounds(allPollinatorFeatures);

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
    setStatus('Error — check console');
  } finally {
    setLoading(false);
  }
}

// ── Map ready ─────────────────────────────────────────────────────────────────

map.on('load', () => {

  // Register white vector icon sprites.
  // Must be called before registerAreaMarkersLayer and waystation registerLayer.
  // 🌸 flower = pollinator corridor site pins  🦋 butterfly = waystation markers
  registerVectorIcons();

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
    'icon-hummingbird'
  );

  // 2. Hazard point layers — above polygons, below observation points
  for (const layer of HAZARD_LAYERS) {
    registerLayer(layer.id, layer.defaultOn, { radius: 7 });
  }

  // 2b. Waystation static layer — above hazards
  // Rendered as a large violet circle with a monarch butterfly icon overlay.
  for (const layer of WAYSTATION_LAYER) {
    registerLayer(layer.id, layer.defaultOn, {
      radius: 11, strokeWidth: 2, opacity: 1.0, symbol: 'icon-butterfly',
    });
  }

  // 2c. Homegrown National Park native planting yards — immediately after waystations
  for (const layer of HNP_LAYER) {
    registerLayer(layer.id, layer.defaultOn, {
      radius: 9, strokeWidth: 2, opacity: 0.95, symbol: 'icon-park',
    });
  }

  // 3. GBIF observation layers — above hazards
  // No symbol icon: dots are already distinguished by color; tiny icons were illegible.
  for (const layer of GBIF_LAYERS) {
    registerLayer(layer.id, layer.defaultOn, { gbif: true });
  }

  // 4. iNaturalist layers — topmost
  for (const layer of LAYERS) {
    registerLayer(layer.id, layer.defaultOn);
  }

  // Build the side-panel UI
  // Habitat Programs = active planting programs (corridor only)
  // Conservation = background land protection + treatments + hazards
  const habitatAreaLayers     = AREA_LAYERS.filter(l => l.id === 'gbcc-corridor');
  const conservationLayers    = AREA_LAYERS.filter(l => l.id !== 'gbcc-corridor');
  const areaOrPointVisibility = (id, visible) => {
    if (AREA_LAYERS.some(l => l.id === id)) setAreaVisibility(id, visible);
    else setLayerVisibility(id, visible);
  };

  // ── Habitat Programs (primary section) ─────────────────────────────────────────
  buildLayerPanel(
    [
      { groupLabel: 'Pollinator Corridor · GBCC', layers: habitatAreaLayers  },
      { groupLabel: 'Monarch Watch Waystations',  layers: WAYSTATION_LAYER   },
      { groupLabel: 'Homegrown National Park',    layers: HNP_LAYER          },
    ],
    areaOrPointVisibility,
    document.getElementById('panel-habitat-inner')
  );

  // ── Conservation Areas & Hazards (secondary, collapsed) ──────────────────────
  buildLayerPanel(
    [
      { groupLabel: 'Habitat Treatments',  layers: conservationLayers.filter(l => l.id === 'gbcc-treatment') },
      { groupLabel: 'Protected Lands',     layers: conservationLayers.filter(l => !l.id.startsWith('gbcc-')) },
      { groupLabel: 'Hazards',             layers: HAZARD_LAYERS      },
    ],
    areaOrPointVisibility,
    document.getElementById('panel-areas-inner')
  );

  // ── Sightings (tertiary, for impact correlation, collapsed) ──────────────────
  buildLayerPanel(
    [
      { groupLabel: 'iNaturalist', layers: LAYERS      },
      { groupLabel: 'GBIF',        layers: GBIF_LAYERS },
    ],
    (id, visible) => setLayerVisibility(id, visible)
  );
  buildEstLegend();
  buildAreaLegend(areaOrPointVisibility);

  // Populate date inputs with defaults
  const { from, to } = getDefaultDates();
  document.getElementById('date-from').value = from;
  document.getElementById('date-to').value   = to;

  document.getElementById('btn-reload').addEventListener('click', loadObservations);

  // Auto-reload when dates change (debounced so the request only fires once
  // the user finishes picking, not on every keystroke)
  const debouncedLoad = debounce(loadObservations, 600);
  document.getElementById('date-from').addEventListener('change', debouncedLoad);
  document.getElementById('date-to').addEventListener('change', debouncedLoad);

  // Export button
  document.getElementById('btn-export').addEventListener('click', exportReport);

  // Load static waystation GeoJSON immediately (no async fetch needed)
  setLayerFeatures('waystations', waystationGeoJSON().features);

  // Filter chips
  buildFilterChips(document.getElementById('panel-filter-chips'));
  initFilters((layerId, features) => setLayerFeatures(layerId, features));

  // Timeline scrubber
  initTimeline((startYear, endYear) => {
    setDatePredicate(dateStr => {
      if (!dateStr) return true;
      const y = new Date(dateStr).getFullYear();
      return y >= startYear && y <= endYear;
    });
  }, new Date().getFullYear() - 10);
  mountTimelineDrag();

  // Drawer close button
  document.getElementById('site-drawer-close').addEventListener('click', closeDrawer);

  // Clicking empty map space clears any active alert highlight
  map.on('click', e => {
    const hits = map.queryRenderedFeatures(e.point);
    if (!hits.length) clearAlertHighlight();
  });

  // Intel-bar alerts stat → open the Alerts panel and scroll it into view
  const openAlertsPanel = () => {
    const details = document.querySelector('#panel-alerts details');
    if (details) {
      details.open = true;
      details.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
