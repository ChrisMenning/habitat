/**
 * alerts.js — Automated intelligence alerts computed from loaded GeoJSON data.
 *
 * All computation happens client-side against features already in memory — no
 * extra network requests. Alerts are regenerated whenever loadObservations
 * completes and calls renderAlerts().
 *
 * Alert types:
 *   PFAS_NEAR_HABITAT  — PFAS site within 1 km of a waystation or corridor site
 *   SIGHTINGS_NO_SITE  — zip/area with notable sightings but no habitat program site
 *   CORRIDOR_COVERAGE  — corridor sites with zero nearby pollinators sightings
 *   SITE_CLUSTER       — multiple habitat program sites within 200 m of each other
 */

// ── Geometry helpers ──────────────────────────────────────────────────────────

/**
 * Haversine distance in kilometres between two [lng, lat] points.
 * @param {[number,number]} a
 * @param {[number,number]} b
 * @returns {number}
 */
function distKm(a, b) {
  const R  = 6371;
  const d1 = (b[1] - a[1]) * Math.PI / 180;
  const d2 = (b[0] - a[0]) * Math.PI / 180;
  const x  = Math.sin(d1 / 2) ** 2
            + Math.cos(a[1] * Math.PI / 180)
            * Math.cos(b[1] * Math.PI / 180)
            * Math.sin(d2 / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/** Returns the centroid [lng, lat] of a GeoJSON feature (Point or Polygon). */
function centroid(feature) {
  const geom = feature.geometry;
  if (geom.type === 'Point') return geom.coordinates;
  // Polygon — average of exterior ring vertices
  const ring = geom.coordinates[0];
  const lng  = ring.reduce((s, c) => s + c[0], 0) / ring.length;
  const lat  = ring.reduce((s, c) => s + c[1], 0) / ring.length;
  return [lng, lat];
}

// ── Alert computation ─────────────────────────────────────────────────────────

/**
 * Computes all intelligence alerts from current feature sets.
 *
 * @param {object} ctx
 * @param {GeoJSON.Feature[]} ctx.corridorFeatures
 * @param {GeoJSON.Feature[]} ctx.waystationFeatures
 * @param {GeoJSON.Feature[]} ctx.pfasFeatures
 * @param {GeoJSON.Feature[]} ctx.pollinatorSightings   — iNat pollinators + GBIF pollinators combined
 * @returns {Alert[]}
 */
export function computeAlerts({
  corridorFeatures   = [],
  waystationFeatures = [],
  pfasFeatures       = [],
  pollinatorSightings = [],
}) {
  const alerts = [];

  const habitatSites = [
    ...corridorFeatures.map(f => ({ ...f, _kind: 'corridor' })),
    ...waystationFeatures.map(f => ({ ...f, _kind: 'waystation' })),
  ];

  // ── Alert: PFAS contamination near a habitat site ────────────────────────
  const PFAS_RADIUS_KM = 1.0;
  for (const pfas of pfasFeatures) {
    const pfasCoord = centroid(pfas);
    const nearby = habitatSites.filter(site =>
      distKm(pfasCoord, centroid(site)) <= PFAS_RADIUS_KM
    );
    if (nearby.length > 0) {
      const names = nearby.map(s => s.properties.name || s.properties.registrant || 'Site').slice(0, 2);
      // Gather all relevant coords: PFAS site + nearby habitat sites
      const allCoords = [pfasCoord, ...nearby.map(centroid)];
      alerts.push({
        level:  'warn',
        icon:   '⚠️',
        key:    `pfas-${pfas.properties.name}`,
        text:   `PFAS site "${pfas.properties.name}" is within 1 km of ${names.join(', ')}${nearby.length > 2 ? ` +${nearby.length - 2} more` : ''}.`,
        coords: allCoords,
      });
    }
  }

  // ── Alert: Habitat sites with no pollinator sightings within 500 m ──────
  const COVERAGE_RADIUS_KM = 0.5;
  const unsupportedSites = habitatSites.filter(site => {
    const siteCoord = centroid(site);
    return !pollinatorSightings.some(s =>
      distKm(siteCoord, s.geometry.coordinates) <= COVERAGE_RADIUS_KM
    );
  });
  if (unsupportedSites.length > 0) {
    const names = unsupportedSites.map(s => s.properties.name || s.properties.registrant || 'Site').slice(0, 3);
    alerts.push({
      level:  'info',
      icon:   'ℹ️',
      key:    'unsupported-sites',
      text:   `${unsupportedSites.length} habitat site${unsupportedSites.length > 1 ? 's have' : ' has'} no recorded pollinator sightings within 500 m: ${names.join(', ')}${unsupportedSites.length > 3 ? ` +${unsupportedSites.length - 3} more` : ''}.`,
      coords: unsupportedSites.map(centroid),
    });
  }

  // ── Alert: Areas with sightings but no habitat site ──────────────────────
  // Cluster sightings into ~1 km buckets, flag clusters with no site nearby.
  const OPPORTUNITY_RADIUS_KM = 0.8;
  const CLUSTER_MIN           = 5;  // minimum sightings to flag as opportunity
  // Simple grid bucketing at ~0.01° ≈ 1 km
  const buckets = new Map();
  for (const s of pollinatorSightings) {
    const [lng, lat] = s.geometry.coordinates;
    const key = `${(lng * 100 | 0)},${(lat * 100 | 0)}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const opportunityClusters = [];
  for (const [key, count] of buckets) {
    if (count < CLUSTER_MIN) continue;
    const [lx, ly] = key.split(',').map(Number);
    const clusterCoord = [lx / 100 + 0.005, ly / 100 + 0.005];
    const hasSite = habitatSites.some(site =>
      distKm(clusterCoord, centroid(site)) <= OPPORTUNITY_RADIUS_KM
    );
    if (!hasSite) opportunityClusters.push({ coord: clusterCoord, count });
  }
  if (opportunityClusters.length > 0) {
    const total = opportunityClusters.reduce((s, c) => s + c.count, 0);
    alerts.push({
      level:    'opportunity',
      icon:     '🌱',
      key:      'opportunity-zones',
      text:     `${opportunityClusters.length} area${opportunityClusters.length > 1 ? 's' : ''} with active pollinator sightings (${total.toLocaleString()} records) have no nearby habitat program site — potential expansion zones.`,
      clusters: opportunityClusters,
      coords:   opportunityClusters.map(c => c.coord),
    });
  }

  // ── Alert: Connected habitat clusters ───────────────────────────────────
  if (habitatSites.length >= 2) {
    const CLUSTER_RADIUS_KM = 0.3;
    let clusterCount = 0;
    const clusteredSiteCoords = [];
    const seen = new Set();
    for (let i = 0; i < habitatSites.length; i++) {
      for (let j = i + 1; j < habitatSites.length; j++) {
        if (seen.has(j)) continue;
        if (distKm(centroid(habitatSites[i]), centroid(habitatSites[j])) <= CLUSTER_RADIUS_KM) {
          clusterCount++;
          seen.add(i);
          seen.add(j);
        }
      }
    }
    // Collect coords of all sites that are part of some connected pair
    for (const idx of seen) clusteredSiteCoords.push(centroid(habitatSites[idx]));
    if (clusterCount > 0) {
      alerts.push({
        level:  'positive',
        icon:   '✅',
        key:    'site-clusters',
        text:   `${clusterCount} habitat site pair${clusterCount > 1 ? 's are' : ' is'} within 300 m of each other — forming connected corridor nodes.`,
        coords: clusteredSiteCoords,
      });
    }
  }

  return alerts;
}

// ── DOM rendering ─────────────────────────────────────────────────────────────

/**
 * Renders alert items into the #alerts-list container.
 * Clears any previous alerts first.
 *
 * @param {object[]}  alerts
 * @param {function(alert: object): void} [onFocus]
 *   Optional callback. When provided, each alert is rendered as a keyboard-
 *   focusable button. Clicking / pressing Enter fires onFocus(alert).
 */
export function renderAlerts(alerts, onFocus = null) {
  const container = document.getElementById('alerts-list');
  if (!container) return;

  container.innerHTML = '';

  const header = document.getElementById('alerts-header-count');
  if (header) {
    const warnCount = alerts.filter(a => a.level === 'warn').length;
    header.textContent = alerts.length > 0
      ? `${alerts.length} alert${alerts.length > 1 ? 's' : ''}${warnCount ? ` · ${warnCount} ⚠️` : ''}`
      : 'No alerts';
    header.className = warnCount > 0 ? 'alerts-badge alerts-badge--warn' : 'alerts-badge';
  }

  if (alerts.length === 0) {
    container.innerHTML = '<p class="alert-empty">No issues detected in current data.</p>';
    return;
  }

  // Auto-expand the alerts panel so the user sees them immediately
  const details = document.querySelector('#panel-alerts details');
  if (details) details.open = true;

  for (const alert of alerts) {
    const hasGeo = alert.coords?.length > 0;
    const clickable = onFocus && hasGeo;

    // Use a <button> when the alert is actionable so it gets keyboard focus
    // and screen-reader affordance; plain <div> otherwise.
    const item = document.createElement(clickable ? 'button' : 'div');
    item.className = `alert-item alert-item--${alert.level}${clickable ? ' alert-item--clickable' : ''}`;
    if (clickable) {
      item.type = 'button';
      item.title = 'Click to zoom map to these locations';
    }

    const hint = clickable
      ? `<span class="alert-zoom-hint" aria-hidden="true">🔍</span>`
      : '';

    item.innerHTML =
      `<span class="alert-icon" aria-hidden="true">${alert.icon}</span>` +
      `<span class="alert-text">${alert.text}</span>` +
      hint;

    if (clickable) {
      item.addEventListener('click', () => onFocus(alert));
    }

    container.appendChild(item);
  }
}
