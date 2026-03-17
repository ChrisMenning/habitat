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

import { LAYERS, GBIF_LAYERS }                         from './config.js';
import { fetchObservations, observationsToGeoJSON,
         partitionByLayer }                            from './api.js';
import { fetchGbifPollinators, fetchGbifPlants,
         gbifToGeoJSON }                               from './gbif.js';
import { initMap, registerLayer, setLayerFeatures,
         setLayerVisibility, getInteractiveLayerIds,
         showPopup, closePopup, wireInteractions }     from './map.js';
import { buildLayerPanel, buildEstLegend, updateCounts,
         setLoading, setStatus, getDefaultDates,
         buildPopupHTML }                              from './ui.js';

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
    // Fire all three data sources in parallel; failures in one source do not
    // block the others (Promise.allSettled never rejects).
    const [inatResult, gbifPollResult, gbifPlantResult] = await Promise.allSettled([
      fetchObservations(d1, d2),
      fetchGbifPollinators(d1, d2),
      fetchGbifPlants(d1, d2),
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
      const feats = gbifToGeoJSON(gbifPollResult.value.occurrences, 'gbif-pollinators').features;
      setLayerFeatures('gbif-pollinators', feats);
      counts['gbif-pollinators'] = feats.length;
      gbifCount += feats.length;
    } else {
      console.warn('GBIF pollinators failed:', gbifPollResult.reason);
      counts['gbif-pollinators'] = 0;
    }

    // ── GBIF Plants ───────────────────────────────────────────────────
    if (gbifPlantResult.status === 'fulfilled') {
      const feats = gbifToGeoJSON(gbifPlantResult.value.occurrences, 'gbif-plants').features;
      setLayerFeatures('gbif-plants', feats);
      counts['gbif-plants'] = feats.length;
      gbifCount += feats.length;
    } else {
      console.warn('GBIF plants failed:', gbifPlantResult.reason);
      counts['gbif-plants'] = 0;
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

  // Register GBIF layers FIRST so they render below iNaturalist layers
  for (const layer of GBIF_LAYERS) {
    registerLayer(layer.id, layer.defaultOn, { gbif: true });
  }
  // iNaturalist layers on top
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
  buildEstLegend();

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

  // Wire map pointer interactions
  // Click interactions on all layers from both sources
  const layerIds = getInteractiveLayerIds([...GBIF_LAYERS, ...LAYERS]);
  wireInteractions(layerIds, (lngLat, props) => showPopup(lngLat, buildPopupHTML(props)));

  // Initial data load
  loadObservations();
});
