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

import { LAYERS }                                      from './config.js';
import { fetchObservations, observationsToGeoJSON,
         partitionByLayer }                            from './api.js';
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

  try {
    const { observations, total } = await fetchObservations(d1, d2, (loaded, available) => {
      setStatus(`Loading… ${loaded.toLocaleString()} / ${available.toLocaleString()}`);
    });
    const geojson = observationsToGeoJSON(observations);
    const byLayer = partitionByLayer(geojson, LAYERS.map(l => l.id));

    for (const layer of LAYERS) {
      setLayerFeatures(layer.id, byLayer[layer.id]);
    }

    updateCounts(Object.fromEntries(
      LAYERS.map(l => [l.id, byLayer[l.id].length])
    ));

    const capped = observations.length < total;
    setStatus(
      `${observations.length.toLocaleString()} / ${total.toLocaleString()} observations` +
      (capped ? ' · scroll date range to load more' : '')
    );

  } catch (err) {
    console.error('Failed to load observations:', err);
    setStatus('Error — check console');
  } finally {
    setLoading(false);
  }
}

// ── Map ready ─────────────────────────────────────────────────────────────────

map.on('load', () => {

  // Register a GeoJSON source + circle layer for each logical group
  for (const layer of LAYERS) {
    registerLayer(layer.id, layer.defaultOn);
  }

  // Build the side-panel UI
  buildLayerPanel((id, visible) => setLayerVisibility(id, visible));
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
  const layerIds = getInteractiveLayerIds(LAYERS);
  wireInteractions(layerIds, (lngLat, props) => showPopup(lngLat, buildPopupHTML(props)));

  // Initial data load
  loadObservations();
});
