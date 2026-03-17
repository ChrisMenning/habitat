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

import { LAYERS, GBIF_LAYERS, AREA_LAYERS, HAZARD_LAYERS }     from './config.js';
import { fetchObservations, observationsToGeoJSON,
         partitionByLayer }                            from './api.js';
import { fetchGbifPollinators, fetchGbifPlants, gbifToGeoJSON,
         resolveOccurrenceEstKeys,
         partitionPlantOccurrences }                   from './gbif.js';
import { fetchPadUs, fetchDnrSna, fetchDnrManagedLands,
         fetchPollinatorCorridor, fetchCorridorTreatments,
         fetchChemicalHazards,
         corridorCentroids }                          from './areas.js';
import { initMap, registerLayer, registerAreaLayer,
         registerAreaMarkersLayer,
         setLayerFeatures, setAreaFeatures, setAreaMarkersFeatures,
         setLayerVisibility, setAreaVisibility,
         getInteractiveLayerIds, getInteractiveAreaLayerIds,
         showPopup, closePopup, wireInteractions }     from './map.js';
import { buildLayerPanel, buildEstLegend, buildAreaLegend, updateCounts,
         setLoading, setStatus, getDefaultDates,
         buildPopupHTML, buildAreaPopupHTML }          from './ui.js';

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

// ── Map setup ─────────────────────────────────────────────────────────────────

const map = initMap('map');

// ── Data loading ──────────────────────────────────────────────────────────────

/**
 * Reads the current date inputs, fetches observations, and updates all layers.
 * Safe to call multiple times (reload).
 */
async function loadObservations() {
  const d1 = document.getElementById('date-from').value || undefined;
  const d2 = document.getElementById('date-to').value   || undefined;

  setLoading(true);
  closePopup();
  setStatus('Loading iNaturalist + GBIF…');

  try {
    // Fire all data sources in parallel; failures in one source do not
    // block the others (Promise.allSettled never rejects).
    const [inatResult, gbifPollResult, gbifPlantResult,
           padusResult, snaResult, dnrResult,
           corridorResult, treatmentResult, pfasResult] = await Promise.allSettled([
      fetchObservations(d1, d2),
      fetchGbifPollinators(d1, d2),
      fetchGbifPlants(d1, d2),
      fetchPadUs(),
      fetchDnrSna(),
      fetchDnrManagedLands(),
      fetchPollinatorCorridor(),
      fetchCorridorTreatments(),
      fetchChemicalHazards(),
    ]);

    const counts = {};
    let inatObs = 0, inatTotal = 0, gbifCount = 0;

    // ── iNaturalist ──────────────────────────────────────────────────────
    if (inatResult.status === 'fulfilled') {
      const { observations, total } = inatResult.value;
      inatObs   = observations.length;
      inatTotal = total;
      const geojson = observationsToGeoJSON(observations);
      const byLayer = partitionByLayer(geojson, LAYERS.map(l => l.id));
      for (const layer of LAYERS) {
        setLayerFeatures(layer.id, byLayer[layer.id]);
        counts[layer.id] = byLayer[layer.id].length;
      }
    } else {
      console.error('iNaturalist failed:', inatResult.reason);
      for (const l of LAYERS) counts[l.id] = 0;
    }

    // ── GBIF Pollinators ──────────────────────────────────────────────
    if (gbifPollResult.status === 'fulfilled') {
      const pollOccs  = gbifPollResult.value.occurrences;
      const pollEstMap = await resolveOccurrenceEstKeys(pollOccs);
      const feats = gbifToGeoJSON(pollOccs, 'gbif-pollinators', pollEstMap).features;
      setLayerFeatures('gbif-pollinators', feats);
      counts['gbif-pollinators'] = feats.length;
      gbifCount += feats.length;
    } else {
      console.warn('GBIF pollinators failed:', gbifPollResult.reason);
      counts['gbif-pollinators'] = 0;
    }

    // ── GBIF Plants (native / non-native) ────────────────────────────
    if (gbifPlantResult.status === 'fulfilled') {
      const { native, nonNative } = await partitionPlantOccurrences(gbifPlantResult.value.occurrences);
      const nativeFeats    = gbifToGeoJSON(native,    'gbif-native-plants').features;
      const nonNativeFeats = gbifToGeoJSON(nonNative, 'gbif-non-native-plants').features;
      setLayerFeatures('gbif-native-plants',    nativeFeats);
      setLayerFeatures('gbif-non-native-plants', nonNativeFeats);
      counts['gbif-native-plants']     = nativeFeats.length;
      counts['gbif-non-native-plants'] = nonNativeFeats.length;
      gbifCount += nativeFeats.length + nonNativeFeats.length;
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

    updateCounts(counts);

    const capped = inatObs < inatTotal;
    setStatus(
      `iNat: ${inatObs.toLocaleString()} / ${inatTotal.toLocaleString()}${capped ? ' ▲' : ''}` +
      ` · GBIF: ${gbifCount.toLocaleString()}`
    );

  } catch (err) {
    console.error('Failed to load:', err);
    setStatus('Error — check console');
  } finally {
    setLoading(false);
  }
}

// ── Map ready ─────────────────────────────────────────────────────────────────

map.on('load', () => {

  // 1. Polygon area layers FIRST — they render at the bottom of the stack
  for (const layer of AREA_LAYERS) {
    registerAreaLayer(layer.id, layer.defaultOn, layer.fillColor, layer.outlineColor);
  }

  // Corridor pin markers — circle + label above the fill polygons so small
  // planting areas remain visible at any zoom level
  const corridorCfg = AREA_LAYERS.find(l => l.id === 'gbcc-corridor');
  registerAreaMarkersLayer(
    'gbcc-corridor', corridorCfg.defaultOn,
    corridorCfg.fillColor, corridorCfg.outlineColor
  );

  // 2. Hazard point layers — above polygons, below observation points
  for (const layer of HAZARD_LAYERS) {
    registerLayer(layer.id, layer.defaultOn);
  }

  // 3. GBIF observation layers — above hazards
  for (const layer of GBIF_LAYERS) {
    registerLayer(layer.id, layer.defaultOn, { gbif: true });
  }

  // 4. iNaturalist layers — topmost
  for (const layer of LAYERS) {
    registerLayer(layer.id, layer.defaultOn);
  }

  // Build the side-panel UI with named source groups
  buildLayerPanel(
    [
      { groupLabel: 'iNaturalist', layers: LAYERS      },
      { groupLabel: 'GBIF',        layers: GBIF_LAYERS },
    ],
    (id, visible) => setLayerVisibility(id, visible)
  );
  buildLayerPanel(
    [
      { groupLabel: 'Protected Areas', layers: AREA_LAYERS    },
      { groupLabel: 'Hazards',         layers: HAZARD_LAYERS  },
    ],
    (id, visible) => {
      if (AREA_LAYERS.some(l => l.id === id)) setAreaVisibility(id, visible);
      else setLayerVisibility(id, visible);
    },
    document.getElementById('panel-areas')
  );
  buildEstLegend();
  buildAreaLegend();

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

  // Wire click interactions on all layers (points + polygon fills)
  const pointLayerIds = getInteractiveLayerIds([...GBIF_LAYERS, ...LAYERS, ...HAZARD_LAYERS]);
  const areaLayerIds  = getInteractiveAreaLayerIds(AREA_LAYERS);
  wireInteractions(
    [...areaLayerIds, ...pointLayerIds],
    (lngLat, props) => {
      const html = props.data_source ? buildAreaPopupHTML(props) : buildPopupHTML(props);
      showPopup(lngLat, html);
    }
  );

  // Initial data load
  loadObservations();
});
