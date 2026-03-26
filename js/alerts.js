/**
 * alerts.js — Automated intelligence alerts computed from loaded GeoJSON data.
 *
 * All computation happens client-side against features already in memory — no
 * extra network requests. Alerts are regenerated whenever loadObservations
 * completes and calls renderAlerts().
 *
 * Alert types:
 *   PFAS_NEAR_HABITAT    — PFAS site within 1 km of a waystation or corridor site
 *   SIGHTINGS_NO_SITE    — zip/area with notable sightings but no habitat program site
 *   CORRIDOR_COVERAGE    — corridor sites with zero nearby pollinators sightings
 *   SITE_CLUSTER         — multiple habitat program sites within 200 m of each other
 *   TEMPORAL_MISMATCH    — stale fixed-vintage layer active alongside live observation layers
 */

import { TEMPORAL_MISMATCH_THRESHOLD_YEARS, LAYER_LABELS } from './config.js';

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

const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];

/**
 * Computes a 12-element sighting count array (indexed 0=Jan … 11=Dec)
 * for observations within radiusKm of a given coordinate.
 *
 * @param {[number,number]}    coord
 * @param {GeoJSON.Feature[]}  sightings
 * @param {number}             [radiusKm=0.5]
 * @returns {number[]}  12-element array of monthly counts
 */
export function computeMonthHistogram(coord, sightings, radiusKm = 0.5) {
  const counts = new Array(12).fill(0);
  for (const s of sightings) {
    const sc = s.geometry?.coordinates;
    if (!sc || distKm(coord, sc) > radiusKm) continue;
    const date = s.properties?.date;
    if (!date) continue;
    const m = new Date(date).getMonth();
    counts[m]++;
  }
  return counts;
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
 * @param {GeoJSON.Feature[]} [ctx.pesticideCounties]   — county features from pesticide.js
 * @param {GeoJSON.Feature[]} [ctx.parcelFeatures]      — parcel features from parcels.js
 * @returns {Alert[]}
 */
export function computeAlerts({
  corridorFeatures   = [],
  waystationFeatures = [],
  pfasFeatures       = [],
  pollinatorSightings = [],
  hnpFeatures        = [],
  cdlStats           = null,
  quickStats         = null,
  climateData        = null,
  pesticideCounties  = [],
  nestingScores      = new Map(),
  canopyScores       = new Map(),
  parcelFeatures     = [],
  activeLayerIds     = [],
  layerVintages      = new Map(),
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
        icon:   '<i class="ph ph-warning"></i>',
        key:    `pfas-${pfas.properties.name}`,
        text:   `PFAS site "${pfas.properties.name}" is within 1 km of ${names.join(', ')}${nearby.length > 2 ? ` +${nearby.length - 2} more` : ''}.`,
        coords: allCoords,
        layers: ['dnr-pfas'],
      });
    }
  }

  // ── Alert: Corridor sites with no pollinator sightings within 500 m ──────
  const COVERAGE_RADIUS_KM = 0.5;
  const unsupportedSites = corridorFeatures.filter(site => {
    const siteCoord = centroid(site);
    return !pollinatorSightings.some(s =>
      distKm(siteCoord, s.geometry.coordinates) <= COVERAGE_RADIUS_KM
    );
  });
  if (unsupportedSites.length > 0) {
    const names = unsupportedSites.map(s => s.properties.name || 'Corridor site').slice(0, 3);
    alerts.push({
      level:  'info',
      icon:   '<i class="ph ph-info"></i>',
      key:    'unsupported-sites',
      text:   `${unsupportedSites.length} corridor site${unsupportedSites.length > 1 ? 's have' : ' has'} no recorded pollinator sightings within 500 m: ${names.join(', ')}${unsupportedSites.length > 3 ? ` +${unsupportedSites.length - 3} more` : ''}.`,
      coords: unsupportedSites.map(centroid),
      layers: ['gbcc-corridor'],
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
    if (!hasSite) {
      // Suitability factors — weigh nesting potential, native plant presence, and
      // distance from pollution sources before classifying as an expansion zone.
      const nativePlantCount = pollinatorSightings.filter(s => {
        const lid = s.properties?.layer_id;
        if (lid !== 'native-plants' && lid !== 'gbif-native-plants') return false;
        const sc = s.geometry?.coordinates;
        return sc && distKm(clusterCoord, sc) <= OPPORTUNITY_RADIUS_KM;
      }).length;
      const pfasNearby = pfasFeatures.some(p => {
        const pc = centroid(p);
        return pc && distKm(clusterCoord, pc) <= 1.5;
      });
      const pestBand  = _getPesticideBandForCoord(clusterCoord, pesticideCounties);
      opportunityClusters.push({
        coord: clusterCoord, count,
        nativePlantCount, pfasNearby,
        pesticideHigh: pestBand?.band === 4,
      });
    }
  }
  if (opportunityClusters.length > 0) {
    const total = opportunityClusters.reduce((s, c) => s + c.count, 0);

    // Enrich with parcel ownership when parcel data is loaded
    const enrichedClusters = opportunityClusters.map(oc => {
      if (!parcelFeatures.length) return { ...oc, ownerSummary: null };
      const nearby = _queryParcelsNearCoord(oc.coord, 800, parcelFeatures);
      const counts  = _summariseOwnership(nearby);
      return { ...oc, ownerSummary: counts, nearbyParcels: nearby };
    });

    // ── Temporal trend per cluster ──────────────────────────────────────────
    // Compare sighting counts in the most recent 12 months (Period B) against
    // the prior 12 months (Period A).  A cluster is "declining" when:
    //   • Period A has ≥ 3 sightings (enough signal), AND
    //   • Period B count is < 70% of Period A count (meaningful drop, not noise).
    const _now          = new Date();
    const _msPerYear    = 365.25 * 24 * 60 * 60 * 1000;
    const _cutoffRecent = new Date(_now - _msPerYear);        // 12 mo ago
    const _cutoffEarly  = new Date(_now - 2 * _msPerYear);    // 24 mo ago

    enrichedClusters.forEach(oc => {
      const nearby = pollinatorSightings.filter(s => {
        const sc = s.geometry?.coordinates;
        return sc && distKm(oc.coord, sc) <= OPPORTUNITY_RADIUS_KM;
      });
      let periodA = 0, periodB = 0;
      for (const s of nearby) {
        const d = s.properties?.date ? new Date(s.properties.date) : null;
        if (!d || isNaN(d)) continue;
        if (d >= _cutoffEarly && d < _cutoffRecent) periodA++;
        else if (d >= _cutoffRecent)                periodB++;
      }
      oc.periodA   = periodA;
      oc.periodB   = periodB;
      oc.declining = periodA >= 3 && periodB < periodA * 0.7;
    });

    // Build per-cluster ownership phrases
    const zonePhrases = enrichedClusters.map((oc) => {
      if (!oc.ownerSummary) return null;
      const parts = [];
      if (oc.ownerSummary.city)          parts.push(`${oc.ownerSummary.city} City parcel${oc.ownerSummary.city > 1 ? 's' : ''}`);
      if (oc.ownerSummary.county)        parts.push(`${oc.ownerSummary.county} County parcel${oc.ownerSummary.county > 1 ? 's' : ''}`);
      if (oc.ownerSummary.state)         parts.push(`${oc.ownerSummary.state} State parcel${oc.ownerSummary.state > 1 ? 's' : ''}`);
      if (oc.ownerSummary.institutional) parts.push(`${oc.ownerSummary.institutional} institutional parcel${oc.ownerSummary.institutional > 1 ? 's' : ''}`);
      if (!parts.length && oc.ownerSummary.private > 0) parts.push('private land — neighbor outreach needed');
      return parts.length ? parts.join(', ') : null;
    }).filter(Boolean);

    const ownerNote = zonePhrases.length
      ? ` Nearby: ${zonePhrases.slice(0, 2).join('; ')}.`
      : '';

    // Classify by suitability: weigh native plants, PFAS, and pesticide pressure
    const highSuit = enrichedClusters.filter(oc => oc.nativePlantCount >= 3 && !oc.pfasNearby && !oc.pesticideHigh);
    const lowSuit  = enrichedClusters.filter(oc => oc.pfasNearby || oc.pesticideHigh);
    let suitNote = '';
    if (highSuit.length)                       suitNote += ` ${highSuit.length} show strong suitability indicators (native plants present, low pollution).`;
    if (lowSuit.length)                        suitNote += ` ${lowSuit.length} have limiting factors (PFAS proximity or high pesticide pressure) that warrant assessment before investment.`;
    if (!highSuit.length && !lowSuit.length)   suitNote += ' Nesting suitability, native plant coverage, and pollution levels should be assessed before acting on these areas.';
    alerts.push({
      level:    'opportunity',
      icon:     '<i class="ph ph-plant"></i>',
      key:      'opportunity-zones',
      text:     `${enrichedClusters.length} area${enrichedClusters.length > 1 ? 's' : ''} with documented pollinator activity (${total.toLocaleString()} records) have no nearby formal habitat program site.${suitNote}${ownerNote}`,
      clusters: enrichedClusters,
      coords:   enrichedClusters.map(c => c.coord),
      layers:   ['pollinators', 'gbif-pollinators'],
    });

    // ── Temporal enrichment: escalate when declining trend + public land ────
    // For each cluster showing a statistically meaningful decline in the most
    // recent 12-month window (Period B < 70% of Period A) that also has at
    // least one City-of-Green-Bay or Brown-County parcel within 800 m, fire a
    // separate ⚠️ Warning alert.  This is the "compounding alert" — ownership
    // accessibility + observed decline = highest-priority intervention candidate.
    for (const oc of enrichedClusters) {
      if (!oc.declining) continue;
      if (!oc.ownerSummary) continue;
      const pubCity   = oc.ownerSummary.city   ?? 0;
      const pubCounty = oc.ownerSummary.county ?? 0;
      if (!pubCity && !pubCounty) continue;

      const pubParts = [];
      if (pubCity)   pubParts.push(`${pubCity} City of Green Bay parcel${pubCity > 1 ? 's' : ''}`);
      if (pubCounty) pubParts.push(`${pubCounty} Brown County parcel${pubCounty > 1 ? 's' : ''}`);

      alerts.push({
        level:  'warn',
        icon:   '<i class="ph ph-warning"></i>',
        key:    `declining-public-zone-${oc.coord.join(',')}`,
        text:   `Sighting activity in this zone has declined — publicly owned land nearby makes this an urgent outreach target. ${pubParts.join(' and ')} within 800 m of an active opportunity zone where recent sightings dropped ${Math.round((1 - (oc.periodB / oc.periodA)) * 100)}% from the prior year.`,
        coords: [oc.coord],
        layers: ['pollinators', 'gbif-pollinators', 'parcels'],
      });
    }
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
        icon:   '<i class="ph ph-check-circle"></i>',
        key:    'site-clusters',
        text:   `${clusterCount} habitat site pair${clusterCount > 1 ? 's sit' : ' sits'} within optimal stepping-stone range (≤300 m) — accessible to all native bee species including small mining bees, sweat bees, and mason bees.`,
        coords: clusteredSiteCoords,
        layers: ['gbcc-corridor', 'waystations'],
      });
    }
  }

  // ── Alert: Isolated corridor sites — no corridor neighbour within 2 km ───
  // 2 km is the upper bound of bumble bee foraging range and the practical
  // limit for corridor continuity. Only corridor sites are evaluated; waystations
  // and HNP yards are fixed private registrations outside active management.
  const ISOLATION_KM = 2.0;
  const allHabitat = [
    ...corridorFeatures.map(f  => ({ coord: centroid(f),  name: f.properties.name || 'Corridor site',  kind: 'corridor'  })),
    ...waystationFeatures.map(f => ({ coord: centroid(f), name: f.properties.name || f.properties.registrant || 'Waystation', kind: 'waystation' })),
    ...hnpFeatures.map(f        => ({ coord: centroid(f), name: f.properties.name || 'HNP yard',        kind: 'hnp'       })),
  ];
  if (corridorFeatures.length >= 2) {
    const corridorNodes = corridorFeatures.map(f => ({
      coord: centroid(f),
      name:  f.properties.name || 'Corridor site',
    }));
    const isolated = corridorNodes.filter(site =>
      !corridorNodes.some(other => other !== site && distKm(site.coord, other.coord) < ISOLATION_KM)
    );
    if (isolated.length > 0) {
      const labels = isolated.slice(0, 3).map(s => s.name);
      const extra  = isolated.length > 3 ? ` +${isolated.length - 3} more` : '';
      alerts.push({
        level:  'opportunity',
        icon:   '<i class="ph ph-island"></i>',
        key:    'isolated-habitat',
        text:   `${isolated.length} corridor site${isolated.length > 1 ? 's are' : ' is'} isolated — no other corridor site within ${ISOLATION_KM} km: ${labels.join(', ')}${extra}. A new corridor planting within 2 km would restore network continuity.`,
        coords: isolated.map(s => s.coord),
        layers: ['gbcc-corridor'],
      });
    }
  }

  // ── Alert: Weak Network Nodes — closest corridor neighbour is 700 m–2 km ──
  // Aggregated into a single alert to avoid flooding the panel.
  const MESH_KM = 0.7;  // bumble bee / large solitary bee max comfortable range
  const weakNodes = [];
  for (const site of corridorFeatures) {
    const siteCoord = centroid(site);
    let closestDist = Infinity;
    for (const other of corridorFeatures) {
      if (other === site) continue;
      closestDist = Math.min(closestDist, distKm(siteCoord, centroid(other)));
    }
    if (closestDist > MESH_KM && closestDist <= ISOLATION_KM) {
      weakNodes.push({ name: site.properties.name || 'Corridor site', coord: siteCoord, dist: closestDist });
    }
  }
  if (weakNodes.length > 0) {
    const names = weakNodes.slice(0, 3).map(n => n.name);
    const extra = weakNodes.length > 3 ? ` +${weakNodes.length - 3} more` : '';
    alerts.push({
      level:  'info',
      icon:   '<i class="ph ph-link-simple"></i>',
      key:    'weak-nodes',
      text:   `${weakNodes.length} corridor site${weakNodes.length > 1 ? 's sit' : ' sits'} at the outer edge of small-bee foraging range — nearest corridor neighbour 700 m–2 km away: ${names.join(', ')}${extra}. Bumble bees reliably traverse this gap; small-bodied species (mining bees, sweat bees, mason bees) may not. A new planting within 700 m of each would bring these pairs into the optimal connectivity tier.`,
      coords: weakNodes.map(n => n.coord),
      layers: ['gbcc-corridor'],
    });
  }

  // ── Alert: Corridor connectivity gap ─────────────────────────────────────
  // Build a Minimum Spanning Tree (MST) over all corridor sites using Prim's
  // algorithm, then report the longest edge.  The longest MST edge is the
  // true bottleneck in the corridor network — the pair that are genuinely
  // adjacent in the least-cost spanning graph but separated by the most
  // distance.  The old "global max-distance pair" approach was misleading: it
  // could flag two distant sites that each already have closer neighbours.
  // A gap ≥ 2.5 km is enough to strand many native bees (foraging range
  // 0.5–3 km).
  if (corridorFeatures.length >= 2) {
    const cSites = corridorFeatures.map(f => ({
      coord: centroid(f),
      name:  f.properties.name || 'Corridor site',
    }));
    const n = cSites.length;

    // Prim's MST — O(n²), fine for the small corridor datasets in use here.
    const inTree  = new Array(n).fill(false);
    const edgeDist = new Array(n).fill(Infinity);
    const edgeFrom = new Array(n).fill(0);
    edgeDist[0] = 0;

    const mstEdges = [];
    for (let step = 0; step < n; step++) {
      // Pick the cheapest not-yet-added node
      let u = -1;
      for (let i = 0; i < n; i++) {
        if (!inTree[i] && (u === -1 || edgeDist[i] < edgeDist[u])) u = i;
      }
      inTree[u] = true;
      if (step > 0) mstEdges.push({ dist: edgeDist[u], from: edgeFrom[u], to: u });

      // Relax neighbours
      for (let v = 0; v < n; v++) {
        if (inTree[v]) continue;
        const d = distKm(cSites[u].coord, cSites[v].coord);
        if (d < edgeDist[v]) { edgeDist[v] = d; edgeFrom[v] = u; }
      }
    }

    // Longest MST edge = true connectivity gap
    const worst = mstEdges.reduce((max, e) => e.dist > max.dist ? e : max, mstEdges[0]);
    if (worst && worst.dist >= 2.5) {
      const a = cSites[worst.from], b = cSites[worst.to];
      // Check for pollinator sightings in the gap — their presence suggests
      // unmapped habitat may already be providing some connectivity.
      const gapMid = [
        (a.coord[0] + b.coord[0]) / 2,
        (a.coord[1] + b.coord[1]) / 2,
      ];
      const gapCheckKm = Math.min(worst.dist * 0.45, 1.5);
      const sightingsInGap = pollinatorSightings.filter(s => {
        const sc = s.geometry?.coordinates;
        return sc && distKm(gapMid, sc) <= gapCheckKm;
      });
      const n = sightingsInGap.length;

      // Thresholds: ≥15 sightings = well-documented activity ("handled");
      //             1–14 sightings = suppress (some activity, not conclusive);
      //             0 sightings    = fire a warn-level alert urging action.
      if (n === 0) {
        alerts.push({
          level:  'warn',
          icon:   '<i class="ph ph-link-simple-break"></i>',
          key:    'connectivity-gap',
          text:   `Corridor connectivity gap: ${worst.dist.toFixed(1)} km between "${a.name}" and "${b.name}" — longer than most native bees forage. No pollinator activity was detected in the gap. A stepping-stone planting here would close the gap and restore functional connectivity for all species.`,
          coords: [a.coord, b.coord],
          layers: ['gbcc-corridor'],
        });
      } else if (n >= 15) {
        alerts.push({
          level:  'positive',
          icon:   '<i class="ph ph-link-simple"></i>',
          key:    'connectivity-gap',
          text:   `Corridor connectivity gap: ${worst.dist.toFixed(1)} km between "${a.name}" and "${b.name}". ${n} pollinator sightings were recorded in the gap — high activity suggests functional connectivity is likely maintained by unmapped habitat. No immediate action required, but field verification could confirm.`,
          coords: [a.coord, b.coord],
          layers: ['gbcc-corridor'],
        });
      } else {
        // 1–14 sightings: some activity present but not enough to confirm connectivity.
        alerts.push({
          level:  'info',
          icon:   '<i class="ph ph-link-simple"></i>',
          key:    'connectivity-gap',
          text:   `Corridor gap: ${worst.dist.toFixed(1)} km between "${a.name}" and "${b.name}". ${n} pollinator sighting${n > 1 ? 's were' : ' was'} recorded in the gap — some activity present, but not enough to confirm functional connectivity. A light stepping-stone planting here is worth considering.`,
          coords: [a.coord, b.coord],
          layers: ['gbcc-corridor'],
        });
      }
    }
  }

  // ── Alert: Pollinator mismatch (CDL-based) ───────────────────────────────
  // High bee-dependent crop acreage + low habitat site density → unmet
  // pollination demand.  Thresholds are calibrated for a 15 km radius.
  if (cdlStats) {
    const { beePct, beeOfCropPct, topBeeCrops } = cdlStats;
    // Estimate rough habitat coverage: each site's planting supports ~0.8 km²
    const SITE_COVER_KM2 = 0.8;
    const REGION_KM2     = Math.PI * (15 ** 2);   // ~707 km² for 15 km radius
    const habitatCount   = allHabitat.length;
    const coveragePct    = (habitatCount * SITE_COVER_KM2 / REGION_KM2) * 100;

    // Build optional colony-count context from NASS QuickStats when available.
    let colonyNote = '';
    if (quickStats?.available && quickStats.colonies) {
      colonyNote = ` Wisconsin tracked ${quickStats.colonies.toLocaleString()} managed honey bee colonies in ${quickStats.coloniesYear}.`;
    }
    // Build optional Census crop-acreage corroboration when available.
    let censusNote = '';
    if (quickStats?.available && quickStats.totalNotableAcres > 0) {
      const topCensus = Object.entries(quickStats.notableAcres)
        .sort(([, a], [, b]) => b - a).slice(0, 2)
        .map(([name, acres]) => `${name} (${acres.toLocaleString()} ac)`).join(', ');
      censusNote = ` Census 2022 confirms bee-dependent crops in Brown County: ${topCensus}.`;
    }

    if (beePct > 8 && coveragePct < 12) {
      const cropNames = topBeeCrops.slice(0, 2).map(c => c.category).join(', ');
      alerts.push({
        level:  'warn',
        icon:   '<i class="ph ph-scales"></i>',
        key:    'mismatch-high',
        text:   `Pollinator mismatch — HIGH: ${beePct.toFixed(1)}% of Brown County land includes bee-dependent crops (${cropNames}), but current habitat covers an estimated ${coveragePct.toFixed(0)}% of the region.${colonyNote}${censusNote} Strategic HNP or corridor expansion near agricultural zones would have high economic leverage.`,
        coords: [],
        layers: [],
        heatmaps: ['cdl-fringe-heat'],
      });
    } else if (beePct > 4) {
      const cropNames = topBeeCrops.slice(0, 2).map(c => c.category).join(', ');
      alerts.push({
        level:  'opportunity',
        icon:   '<i class="ph ph-scales"></i>',
        key:    'mismatch-moderate',
        text:   `Pollinator leverage opportunity: ${beePct.toFixed(1)}% of the county features bee-dependent crops (${beeOfCropPct.toFixed(0)}% of all cropland; top: ${cropNames}).${colonyNote}${censusNote} Targeted habitat additions near these fields would provide measurable crop yield benefits.`,
        coords: [],
        layers: [],
        heatmaps: ['cdl-fringe-heat'],
      });
    }
  }

  // ── Alert: Regional service gap (quadrant analysis) ──────────────────────
  // Divide the bbox into four quadrants and flag any without a single habitat
  // site — indicating areas with no programmatic pollinator support at all.
  if (allHabitat.length > 0) {
    // Use the centroid of all sites as the dividing point so sparsely-covered
    // halves are detected even when data is asymmetric.
    const avgLng = allHabitat.reduce((s, h) => s + h.coord[0], 0) / allHabitat.length;
    const avgLat = allHabitat.reduce((s, h) => s + h.coord[1], 0) / allHabitat.length;
    const quadrants = [
      { name: 'Northwest',  test: ([lo, la]) => lo < avgLng && la >= avgLat },
      { name: 'Northeast',  test: ([lo, la]) => lo >= avgLng && la >= avgLat },
      { name: 'Southwest',  test: ([lo, la]) => lo < avgLng && la < avgLat  },
      { name: 'Southeast',  test: ([lo, la]) => lo >= avgLng && la < avgLat  },
    ];
    const empty = quadrants.filter(q => !allHabitat.some(h => q.test(h.coord)));
    if (empty.length > 0) {
      alerts.push({
        level:  'opportunity',
        icon:   '<i class="ph ph-map-pin"></i>',
        key:    'regional-gap',
        text:   `Service gap detected: no habitat program sites in the ${empty.map(q => q.name).join(' or ')} area. Adding even one registered HNP yard or waystation there would begin corridor coverage.`,
        coords: [],
        layers: ['gbcc-corridor', 'waystations', 'hnp'],
      });
    }
  }

  // ── Alert: Below-Normal GDD ───────────────────────────────────────────────
  // Fires May–Sep when accumulated GDD is more than 15% below the 30-year normal.
  if (climateData?.pctDeviation != null && climateData.pctDeviation < -15) {
    const month = new Date().getMonth() + 1;   // 1-based
    if (month >= 5 && month <= 9) {
      const deficit = Math.abs(Math.round(climateData.pctDeviation));
      alerts.push({
        level:  'info',
        icon:   '<i class="ph ph-info"></i>',
        key:    'gdd-below-normal',
        text:   `GDD accumulation is ${deficit}% below the 1991–2020 normal for this date. Pollinator emergence and bloom timing may be running late this season.`,
        coords: [],
        layers: [],
      });
    }
  }

  // ── Alert: Late Season Frost Risk ─────────────────────────────────────────
  // Fires when today is within 14 calendar days of the 50% probability first fall frost.
  const fallFrost50Doy = climateData?.frost?.fallFrost32?.p50;
  if (fallFrost50Doy != null) {
    const today    = new Date();
    const yearDoy  = Math.round((today - new Date(today.getFullYear(), 0, 0)) / 86400000);
    const daysAway = fallFrost50Doy - yearDoy;
    if (daysAway >= 0 && daysAway <= 14) {
      // doyToLabel is imported from climate.js via the climateData caller in app.js;
      // derive the label here to avoid a circular import.
      const frostDate = new Date(2010, 0, fallFrost50Doy)
        .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      alerts.push({
        level:  'warn',
        icon:   '<i class="ph ph-warning"></i>',
        key:    'fall-frost-risk',
        text:   `First fall frost likely within ~2 weeks (50% probability ~${frostDate}). Annual plantings at corridor sites may be approaching end of season.`,
        coords: [],
        layers: [],
      });
    }
  }

  // ── Alert: High Pesticide Pressure ──────────────────────────────────────────
  // Fires when a corridor site or waystation falls in a top-quartile (band 4)
  // county.  Band is resolved by nearest county ring centroid so it works even
  // when polygon tile delivery is delayed.
  if (pesticideCounties.length > 0) {
    const criticalSites = habitatSites.filter(site => {
      const info = _getPesticideBandForCoord(centroid(site), pesticideCounties);
      return info?.band === 4;
    });
    if (criticalSites.length > 0) {
      const countyNames = [...new Set(
        criticalSites
          .map(s => _getPesticideBandForCoord(centroid(s), pesticideCounties)?.county)
          .filter(Boolean)
      )];
      const siteNames = criticalSites.map(
        s => s.properties.name || s.properties.registrant || 'Site'
      ).slice(0, 3);
      const extra = criticalSites.length > 3 ? ` +${criticalSites.length - 3} more` : '';
      alerts.push({
        level:  'warn',
        icon:   '<i class="ph ph-warning"></i>',
        key:    'pesticide-pressure',
        text:   `High Pesticide Pressure: ${criticalSites.length} habitat site${criticalSites.length > 1 ? 's fall' : ' falls'} in a critical-band county (${countyNames.join(', ')}). Dominant row-crop agriculture drives neonicotinoid seed treatment and intensive herbicide use in this area. Coordinated buffer plantings and reduced spray windows would significantly benefit pollinators at: ${siteNames.join(', ')}${extra}.`,
        coords: criticalSites.map(centroid),
        layers: ['gbcc-corridor', 'waystations', 'pesticide'],
      });
    }
  }

  // ── Alert: Poor Nesting Habitat ──────────────────────────────────────────
  // Fires when any corridor site scores below 25 on the 300 m NLCD nesting index.
  // Level ‘opportunity’: flagging these sites as candidates for bare-ground or
  // grassland enhancement rather than treating them as imminent threats.
  if (nestingScores.size > 0) {
    const poorSites = corridorFeatures.filter(f => {
      const key  = f.properties?.name ?? '';
      const info = nestingScores.get(key);
      return info && info.score < 25;
    });
    if (poorSites.length > 0) {
      const names = poorSites
        .map(f => f.properties?.name || 'Corridor site')
        .slice(0, 3);
      const extra = poorSites.length > 3 ? ` +${poorSites.length - 3} more` : '';
      alerts.push({
        level:  'opportunity',
        icon:   '<i class="ph ph-plant"></i>',
        key:    'poor-nesting-habitat',
        text:   `Poor Nesting Habitat: ${poorSites.length} corridor site${poorSites.length > 1 ? 's score' : ' scores'} below 25/100 on the NLCD nesting suitability index (class 31 Barren Land, 52 Shrub/Scrub, 71 Grassland) — little bare ground or grassland detected within 300 m. About 70% of native bee species are ground-nesters relying on exposed soil or sparse cover; adding bare-soil patches, sand berms, or unmowed edges would significantly expand nesting substrate: ${names.join(', ')}${extra}.`,
        coords: poorSites.map(centroid),
        layers: ['gbcc-corridor'],
      });
    }
  }

  // ── Alert: Shaded Habitat ──────────────────────────────────────────────────
  // Fires when a corridor site has >55% tree canopy coverage within a ~150 m
  // radius. High canopy closure suppresses sun-dependent pollinator wildflowers,
  // which is a concern for open-meadow corridor planting goals.
  // Threshold: 55% — open pollinator meadow is recommended at <40% canopy;
  // 55% provides a meaningful warning margin above that target.
  if (canopyScores.size > 0) {
    const CANOPY_THRESHOLD = 55;
    const shadedSites = corridorFeatures.filter(f => {
      const key = f.properties?.name ?? '';
      const pct = canopyScores.get(key);
      return typeof pct === 'number' && pct > CANOPY_THRESHOLD;
    });
    if (shadedSites.length > 0) {
      const names = shadedSites.map(f => f.properties?.name || 'Corridor site').slice(0, 3);
      const extra = shadedSites.length > 3 ? ` +${shadedSites.length - 3} more` : '';
      alerts.push({
        level:  'opportunity',
        icon:   '<i class="ph ph-tree"></i>',
        key:    'shaded-habitat',
        text:   `Shaded Habitat: ${shadedSites.length} corridor site${shadedSites.length > 1 ? 's have' : ' has'} >55% tree canopy coverage within 150 m — shading suppresses sun-loving pollinator plants and compacts soil, reducing bare-ground substrate for ground-nesting bees (~70% of bee species). Consider canopy thinning or selective edge management near: ${names.join(', ')}${extra}.`,
        coords: shadedSites.map(centroid),
        layers: ['gbcc-corridor'],
      });
    }
  }

  // ── Alert: High-Value Public Land Gap ───────────────────────────────────────
  // Fires when: (a) a City or County parcel lies within an opportunity zone
  //             (b) that parcel has no existing habitat site within 500 m
  //             (c) it is ≥ 0.5 acres
  // Alert level: 'warn' (elevated from standard opportunity because public land
  // is actionable without private negotiation).
  if (parcelFeatures.length > 0) {
    const PUBLIC_MIN_ACRES = 0.5;
    const HABITAT_RADIUS_KM = 0.5;
    const ZONE_RADIUS_M     = 800;

    // Build opportunity zone centroids from sighting buckets (reuse bucket logic above)
    const zoneCentroids = [];
    for (const [key, count] of buckets) {
      if (count < CLUSTER_MIN) continue;
      const [lx, ly] = key.split(',').map(Number);
      const c = [lx / 100 + 0.005, ly / 100 + 0.005];
      if (!habitatSites.some(s => distKm(c, centroid(s)) <= OPPORTUNITY_RADIUS_KM)) {
        zoneCentroids.push(c);
      }
    }

    if (zoneCentroids.length > 0) {
      const seen = new Set();
      const publicSubItems = [];
      for (const zoneCoord of zoneCentroids) {
        const nearbyParcels = _queryParcelsNearCoord(zoneCoord, ZONE_RADIUS_M, parcelFeatures);
        for (const p of nearbyParcels) {
          const cls = p.ownerClass;
          if (cls !== 'city' && cls !== 'county') continue;
          const acres = p.norm.acres;
          if (acres < PUBLIC_MIN_ACRES) continue;
          const pid  = p.norm.parcelId;
          if (seen.has(pid)) continue;
          const pCoord = _parcelCentroidCoord(p.feature);
          if (!pCoord) continue;
          // Must not already have a habitat site within 500 m
          if (habitatSites.some(s => distKm(pCoord, centroid(s)) <= HABITAT_RADIUS_KM)) continue;
          seen.add(pid);
          const ownerLabel = cls === 'city' ? 'City of Green Bay' : 'Brown County';
          const addrNote   = p.norm.address !== '—' ? ` · ${p.norm.address}` : '';
          publicSubItems.push({
            level:  'warn',
            icon:   '<i class="ph ph-map-pin"></i>',
            key:    `public-land-gap-${pid}`,
            text:   `${acres.toFixed(1)} ac — ${ownerLabel}${addrNote}`,
            coords: [pCoord],
            layers: ['gbcc-corridor', 'waystations', 'parcels'],
          });
        }
      }
      if (publicSubItems.length === 1) {
        const sub = publicSubItems[0];
        alerts.push({
          level:  'warn',
          icon:   '<i class="ph ph-buildings"></i>',
          key:    sub.key,
          text:   `High-Value Public Land Gap: ${sub.text} — no habitat program site within 500 m, in an active opportunity zone. Public ownership makes this an actionable outreach target.`,
          coords: sub.coords,
          layers: sub.layers,
        });
      } else if (publicSubItems.length > 1) {
        alerts.push({
          level:    'warn',
          icon:     '<i class="ph ph-buildings"></i>',
          key:      'public-land-gap-group',
          text:     `High-Value Public Land: ${publicSubItems.length} parcels in active opportunity zones have no nearby habitat program. Public ownership makes these actionable outreach targets — no private negotiation required.`,
          coords:   publicSubItems.flatMap(s => s.coords),
          layers:   ['gbcc-corridor', 'waystations', 'parcels'],
          subItems: publicSubItems,
        });
      }
    }
  }

  // ── Alert: Temporal mismatch — stale fixed-vintage layer + live layer active ─
  if (activeLayerIds.length > 0 && layerVintages.size > 0) {
    const currentYear = new Date().getFullYear();
    const stale = activeLayerIds.filter(id => {
      const v = layerVintages.get(id);
      return v && (currentYear - v.year) >= TEMPORAL_MISMATCH_THRESHOLD_YEARS;
    });
    const hasLive = activeLayerIds.some(id => !layerVintages.has(id));
    if (stale.length > 0 && hasLive) {
      const names = stale
        .map(id => LAYER_LABELS.get(id) ?? id)
        .join(', ');
      alerts.push({
        level:  'info',
        icon:   '<i class="ph ph-calendar-x"></i>',
        key:    'temporal-mismatch',
        text:   `Temporal mismatch: ${names} ${stale.length === 1 ? 'uses' : 'use'} fixed vintage data (${stale.map(id => layerVintages.get(id)?.year).join(', ')}) while live observation layers are also active. Patterns may not reflect current conditions. Consider comparing independently.`,
        coords: [],
        layers: stale,
      });
    }
  }

  return alerts;
}

// ── Parcel spatial helpers (used by alert engine — mirrors parcels.js logic) ──

function _parcelCentroidCoord(feature) {
  const geom = feature.geometry;
  if (!geom) return null;
  if (geom.type === 'Point') return geom.coordinates;
  const ring = geom.type === 'MultiPolygon'
    ? geom.coordinates[0]?.[0]
    : geom.coordinates?.[0];
  if (!ring?.length) return null;
  return [
    ring.reduce((s, c) => s + c[0], 0) / ring.length,
    ring.reduce((s, c) => s + c[1], 0) / ring.length,
  ];
}

function _classifyParcelOwnership(props) {
  // New Brown County schema (2026): explicit PublicOwner field
  const pubOwner = props?.PublicOwner ?? null;
  if (!pubOwner) return 'private';
  if (pubOwner === 'State')  return 'state';
  if (pubOwner === 'County') return 'county';
  if (pubOwner === 'Other')  return 'institutional';
  if (pubOwner === 'Municipal') {
    const muni = String(props?.Municipality ?? '').toLowerCase();
    if (/city\s+of\s+green\s+bay|green\s+bay/.test(muni)) return 'city';
    return 'institutional';
  }
  return 'private';
}

function _queryParcelsNearCoord(coord, radiusM, features) {
  const radiusKm = radiusM / 1000;
  const results  = [];
  for (const f of features) {
    const c = _parcelCentroidCoord(f);
    if (!c) continue;
    const d = distKm(coord, c);
    if (d > radiusKm) continue;
    const ownerClass = _classifyParcelOwnership(f.properties ?? {});
    // Parse acres from MapAreaTxt ('0.264 AC' or '8,274 SF')
    const mapAreaTxt = String(f.properties?.MapAreaTxt ?? '').replace(/,/g, '');
    const acMatch    = mapAreaTxt.match(/^([\d.]+)\s*AC$/i);
    const sfMatch    = mapAreaTxt.match(/^([\d.]+)\s*SF$/i);
    const acres      = acMatch ? parseFloat(acMatch[1]) : sfMatch ? parseFloat(sfMatch[1]) / 43560 : 0;
    const muni  = String(f.properties?.Municipality ?? '').trim();
    const muniTC = muni ? muni.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : '';
    let owner = '—';
    if      (f.properties?.PublicOwner === 'County')    owner = 'Brown County';
    else if (f.properties?.PublicOwner === 'State')     owner = 'State of Wisconsin';
    else if (f.properties?.PublicOwner === 'Municipal') owner = muniTC || 'Municipality';
    else if (f.properties?.PublicOwner === 'Other')     owner = 'Public (Other)';
    results.push({ feature: f, ownerClass, distM: Math.round(d * 1000),
      norm: {
        owner,
        parcelId: String(f.properties?.PARCELID ?? '').trim() || '—',
        address:  muniTC || '—',
        acres,
      },
    });
  }
  return results;
}

function _summariseOwnership(parcels) {
  const counts = { city: 0, county: 0, state: 0, institutional: 0, private: 0 };
  for (const p of parcels) counts[p.ownerClass] = (counts[p.ownerClass] ?? 0) + 1;
  return counts;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Finds the nearest county in pesticideCounties to the given [lng,lat] point
 * (using squared degree distance from polygon ring centroid) and returns its
 * properties, or null if no counties are loaded.
 *
 * @param {[number,number]}   coord
 * @param {GeoJSON.Feature[]} counties
 * @returns {{ band: number, band_label: string, county: string }|null}
 */
function _getPesticideBandForCoord(coord, counties) {
  if (!counties?.length) return null;
  let best = null, bestDSq = Infinity;
  for (const f of counties) {
    const geom = f?.geometry;
    if (!geom) continue;
    const ring = geom.type === 'MultiPolygon'
      ? geom.coordinates[0]?.[0]
      : geom.coordinates?.[0];
    if (!ring?.length) continue;
    const cx = ring.reduce((s, c) => s + c[0], 0) / ring.length;
    const cy = ring.reduce((s, c) => s + c[1], 0) / ring.length;
    const dSq = (coord[0] - cx) ** 2 + (coord[1] - cy) ** 2;
    if (dSq < bestDSq) { bestDSq = dSq; best = f; }
  }
  if (!best) return null;
  return {
    band:       best.properties.band,
    band_label: best.properties.band_label,
    county:     best.properties.name,
  };
}

// ── Expansion Opportunities ───────────────────────────────────────────────────

/**
 * Computes Expansion Opportunity point features — active pollinator zones
 * with no nearby formal habitat site, scored by habitat suitability.
 *
 * Suitability factors (same criteria as the opportunity-zones alert):
 *   + Native plant sightings nearby      (primary positive signal)
 *   + Clean environment (no PFAS nearby) (secondary positive)
 *   + Low pesticide pressure             (secondary positive)
 *   + Existing habitat within stepping-stone range (connectivity bonus)
 *
 * @param {object} ctx  — same shape as computeAlerts ctx
 * @returns {GeoJSON.FeatureCollection}
 */
export function computeExpansionOpportunities({
  corridorFeatures   = [],
  waystationFeatures = [],
  hnpFeatures        = [],
  pollinatorSightings = [],
  pfasFeatures       = [],
  pesticideCounties  = [],
  nestingScores      = new Map(),   // site name → {score, ...} — from NLCD analysis of corridor sites
}) {
  // Pollinator sightings are used only as a FILTER (≥5 records → candidate location),
  // not as a primary suitability driver. The goal of a new site is to ATTRACT pollinators,
  // so their absence is not disqualifying — ecology (plants, nesting habitat) matters more.
  const allSites       = [...corridorFeatures, ...waystationFeatures, ...hnpFeatures];
  const SITE_EXCLUSION_KM  = 0.8;  // skip if already has a registered site this close
  const CLUSTER_MIN        = 3;    // lower threshold — detect emerging hotspots
  const NESTING_PROXY_KM   = 3.0;  // use nearby corridor site's nesting score as proxy

  // Build sighting buckets keyed to ~1 km grid cells
  const buckets = new Map();
  for (const s of pollinatorSightings) {
    if (!s.geometry?.coordinates) continue;
    const [lng, lat] = s.geometry.coordinates;
    const key = `${(lng * 100 | 0)},${(lat * 100 | 0)}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  const features = [];
  for (const [key, pollCount] of buckets) {
    if (pollCount < CLUSTER_MIN) continue;
    const [lx, ly] = key.split(',').map(Number);
    const coord = [lx / 100 + 0.005, ly / 100 + 0.005];

    // Skip locations already covered by any registered program
    if (allSites.some(s => { const c = centroid(s); return c && distKm(coord, c) <= SITE_EXCLUSION_KM; })) continue;

    // ── Ecological signals ──────────────────────────────────────────────────
    const nativePlantCount = pollinatorSightings.filter(s => {
      const lid = s.properties?.layer_id;
      if (lid !== 'native-plants' && lid !== 'gbif-native-plants') return false;
      const sc = s.geometry?.coordinates;
      return sc && distKm(coord, sc) <= SITE_EXCLUSION_KM;
    }).length;

    // Nesting habitat proxy: use the nesting score of the nearest scored corridor site
    let nestingProxy = null;
    let nestingProxySite = '';
    let bestNestDist = Infinity;
    for (const site of corridorFeatures) {
      const sc  = centroid(site);
      if (!sc) continue;
      const d = distKm(coord, sc);
      const info = nestingScores.get(site.properties?.name ?? '');
      if (info?.score != null && d < bestNestDist && d <= NESTING_PROXY_KM) {
        bestNestDist  = d;
        nestingProxy  = info.score;
        nestingProxySite = site.properties?.name ?? '';
      }
    }

    // ── Land access classification ──────────────────────────────────────────
    // Corridor sites can only be placed on public / city-owned land.
    // Waystations and HNP yards are on private residential land.
    // Use which site types are near as a proxy for land character.
    const nearCorridorKm  = corridorFeatures.reduce((min, s) => {
      const c = centroid(s); return c ? Math.min(min, distKm(coord, c)) : min;
    }, Infinity);
    const nearPrivateKm   = [...waystationFeatures, ...hnpFeatures].reduce((min, s) => {
      const c = centroid(s); return c ? Math.min(min, distKm(coord, c)) : min;
    }, Infinity);

    // In the corridor stepping-stone zone (0.8–3 km from a corridor site) →
    // contiguous public land is plausible; recommend Pollinator Corridor expansion.
    // Near only private habitat programs → site is likely residential; recommend
    // engaging homeowners about native plantings (Waystations / HNP).
    // Both or neither → recommend both pathways; note field assessment needed.
    const corridorCandidate = nearCorridorKm > SITE_EXCLUSION_KM && nearCorridorKm <= 3.0;
    const communityZone     = nearPrivateKm  <= 2.0;
    const recommendation    =
      corridorCandidate && !communityZone ? 'corridor'    :
      communityZone && !corridorCandidate ? 'community'   : 'both';

    // ── Environmental quality ───────────────────────────────────────────────
    const pfasNearby    = pfasFeatures.some(p => { const pc = centroid(p); return pc && distKm(coord, pc) <= 1.5; });
    const pestBand      = _getPesticideBandForCoord(coord, pesticideCounties);
    const highPesticide = pestBand?.band === 4;

    // ── Composite score 0–100 (NESTING + NATIVE PLANTS are primary) ─────────
    let score = 0;

    // Primary: native plant documentation (strongest ecological signal)
    if (nativePlantCount >= 8)      score += 35;
    else if (nativePlantCount >= 3) score += 22;
    else if (nativePlantCount >= 1) score += 10;

    // Primary: nesting habitat suitability (NLCD land-cover proxy)
    if (nestingProxy !== null) {
      if (nestingProxy >= 70)      score += 30;
      else if (nestingProxy >= 45) score += 20;
      else if (nestingProxy >= 20) score += 10;
      else                         score += 2;   // low nesting score still noted
    }

    // Secondary: corridor stepping-stone proximity (connectivity value)
    if (nearCorridorKm > SITE_EXCLUSION_KM && nearCorridorKm <= 1.5)     score += 15;
    else if (nearCorridorKm > 1.5 && nearCorridorKm <= 3.0)              score += 8;

    // Environmental quality (absence of contamination is a bonus here)
    if (!pfasNearby)    score += 10;
    if (!highPesticide) score += 5;

    // Pollinator activity as light supporting evidence (not primary driver)
    if (pollCount >= 20) score += 5;
    else if (pollCount >= 8) score += 2;

    // Penalties
    if (pfasNearby)     score -= 20;
    if (highPesticide)  score -= 10;

    score = Math.max(0, Math.min(100, score));

    // Require meaningful multi-factor support to surface as an opportunity
    const hasEcologicalBasis = nativePlantCount >= 1 || nestingProxy != null;
    if (!hasEcologicalBasis) continue;

    const suitability = score >= 65 ? 'good' : score >= 38 ? 'moderate' : 'poor';
    const suitLabel   = suitability.charAt(0).toUpperCase() + suitability.slice(1);
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: coord },
      properties: {
        layer_id:            'expansion-opportunities',
        est_key:             'expansion',
        suitability,
        score,
        recommendation,
        pollinator_count:    pollCount,
        native_plant_count:  nativePlantCount,
        nesting_proxy:       nestingProxy,
        nesting_proxy_site:  nestingProxySite,
        pfas_nearby:         pfasNearby,
        high_pesticide:      highPesticide,
        near_corridor_km:    nearCorridorKm === Infinity ? null : +nearCorridorKm.toFixed(2),
        name:    `Expansion Opportunity · ${suitLabel} Suitability`,
        common:  `${nativePlantCount} native plant records · ${pollCount} pollinator sightings · score ${score}/100`,
        date:    '', user: '', image: '',
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

// ── Problem Features ──────────────────────────────────────────────────────────

/**
 * Aggregates all site-level problems inferred from loaded data into a single
 * GeoJSON FeatureCollection of Point features.
 *
 * Problem types:
 *   pfas-proximity   — corridor site within 1 km of a PFAS detection
 *   unsupported-site — no pollinator sightings within 500 m
 *   isolated-site    — no other corridor site within 2 km
 *   weak-node        — nearest corridor neighbor 700 m–2 km
 *   poor-nesting     — NLCD nesting score < 25 /100
 *   shaded-habitat   — >55% tree canopy coverage within 150 m
 *   pesticide-high   — site in a top-quartile pesticide-pressure county
 *
 * @param {object} ctx  — same shape as computeAlerts ctx
 * @returns {GeoJSON.FeatureCollection}
 */
export function computeProblemFeatures({
  corridorFeatures   = [],
  waystationFeatures = [],
  hnpFeatures        = [],
  pfasFeatures       = [],
  pollinatorSightings = [],
  nestingScores      = new Map(),
  canopyScores       = new Map(),
  pesticideCounties  = [],
}) {
  const features = [];

  // All registered habitat sites — used for connectivity / isolation checks
  const allSites = [...corridorFeatures, ...waystationFeatures, ...hnpFeatures];

  function push(coord, problemType, severity, name, description) {
    if (!coord) return;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: coord },
      properties: {
        layer_id:     'problem-areas',
        est_key:      'problem',
        problem_type: problemType,
        severity,
        name,
        common:       description,
        date: '', user: '', image: '',
      },
    });
  }

  const PFAS_KM      = 1.0;
  const COVERAGE_KM  = 0.5;
  const ISOLATION_KM = 2.0;
  const MESH_KM      = 0.7;

  // 1. PFAS-proximate corridor sites
  for (const pfas of pfasFeatures) {
    const pfasCoord = centroid(pfas);
    if (!pfasCoord) continue;
    for (const site of corridorFeatures) {
      const d = distKm(pfasCoord, centroid(site));
      if (d <= PFAS_KM) {
        push(centroid(site), 'pfas-proximity', 'high',
          `PFAS Near Site: ${site.properties?.name || 'Corridor Site'}`,
          `PFAS site \u201c${pfas.properties?.name || 'Detection'}\u201d is ${(d * 1000).toFixed(0)}\u202fm away`);
      }
    }
  }

  // 2. Unsupported corridor sites (zero sightings within 500 m)
  for (const site of corridorFeatures) {
    const siteCoord = centroid(site);
    const supported = pollinatorSightings.some(s => {
      const sc = s.geometry?.coordinates;
      return sc && distKm(siteCoord, sc) <= COVERAGE_KM;
    });
    if (!supported) {
      push(siteCoord, 'unsupported-site', 'medium',
        `No Sightings: ${site.properties?.name || 'Corridor Site'}`,
        'No recorded pollinator sightings within 500 m');
    }
  }

  // 3. Isolated corridor sites (no neighbor of ANY site type within 2 km)
  for (const site of corridorFeatures) {
    const siteCoord = centroid(site);
    const hasNeighbor = allSites.some(
      other => other !== site && distKm(siteCoord, centroid(other)) < ISOLATION_KM
    );
    if (!hasNeighbor) {
      push(siteCoord, 'isolated-site', 'high',
        `Isolated Site: ${site.properties?.name || 'Site'}`,
        'No habitat site of any type within 2 km — beyond bumble bee foraging range');
    }
  }

  // 4. Weak-node corridor sites (nearest neighbor of ANY site type 700 m–2 km)
  for (const site of corridorFeatures) {
    const siteCoord = centroid(site);
    let closest = Infinity;
    let closestName = '';
    for (const other of allSites) {
      if (other === site) continue;
      const d = distKm(siteCoord, centroid(other));
      if (d < closest) {
        closest = d;
        closestName = other.properties?.name || other.properties?.registrant || 'site';
      }
    }
    if (closest > MESH_KM && closest <= ISOLATION_KM) {
      push(siteCoord, 'weak-node', 'medium',
        `Weak Connection: ${site.properties?.name || 'Site'}`,
        `Nearest habitat neighbor (${closestName}) is ${(closest * 1000).toFixed(0)}\u202fm away \u2014 at the outer edge of small-bee foraging range`);
    }
  }

  // 5. Poor nesting habitat (NLCD score < 25)
  if (nestingScores.size > 0) {
    for (const site of corridorFeatures) {
      const info = nestingScores.get(site.properties?.name ?? '');
      if (info?.score < 25) {
        push(centroid(site), 'poor-nesting', 'medium',
          `Poor Nesting: ${site.properties?.name || 'Site'}`,
          `Nesting suitability score ${info.score}/100 \u2014 low bare ground and grassland cover within 300 m`);
      }
    }
  }

  // 6. Shaded habitat (canopy > 55% within 150 m)
  if (canopyScores.size > 0) {
    for (const site of corridorFeatures) {
      const pct = canopyScores.get(site.properties?.name ?? '');
      if (typeof pct === 'number' && pct > 55) {
        push(centroid(site), 'shaded-habitat', 'low',
          `Shaded Habitat: ${site.properties?.name || 'Site'}`,
          `${pct.toFixed(0)}% tree canopy within 150 m \u2014 may suppress sun-loving pollinator plants`);
      }
    }
  }

  // 7. High pesticide pressure
  if (pesticideCounties.length > 0) {
    for (const site of corridorFeatures) {
      const info = _getPesticideBandForCoord(centroid(site), pesticideCounties);
      if (info?.band === 4) {
        push(centroid(site), 'pesticide-high', 'high',
          `High Pesticide Pressure: ${site.properties?.name || 'Site'}`,
          `${info.county} county \u2014 top-quartile agricultural pesticide pressure`);
      }
    }
  }

  return { type: 'FeatureCollection', features };
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
      ? `${alerts.length} alert${alerts.length > 1 ? 's' : ''}${warnCount ? ` · ${warnCount} ⚠` : ''}`
      : 'No alerts';
    header.className = warnCount > 0 ? 'alerts-badge alerts-badge--warn' : 'alerts-badge';
  }

  if (alerts.length === 0) {
    container.innerHTML = '<p class="alert-empty">No issues detected in current data.</p>';
    return;
  }

  for (const alert of alerts) {
    // ── Grouped alert (expandable sub-list) ───────────────────────────────────
    if (alert.subItems?.length > 0) {
      const details = document.createElement('details');
      details.className = `alert-item alert-item--${alert.level} alert-item--group`;

      const summary = document.createElement('summary');
      summary.className = 'alert-item-summary';
      summary.innerHTML =
        `<span class="alert-icon" aria-hidden="true">${alert.icon}</span>` +
        `<span class="alert-text">${alert.text}</span>` +
        `<span class="alert-group-chevron" aria-hidden="true">›</span>`;
      details.appendChild(summary);

      const ul = document.createElement('ul');
      ul.className = 'alert-subitems';
      for (const sub of alert.subItems) {
        const li = document.createElement('li');
        li.className = `alert-subitem${onFocus ? ' alert-subitem--clickable' : ''}`;
        if (onFocus) {
          li.setAttribute('role', 'button');
          li.setAttribute('tabindex', '0');
          li.title = 'Click to zoom to this parcel';
          li.innerHTML =
            `<span>${sub.text}</span>` +
            `<span class="alert-zoom-hint" aria-hidden="true">🔍</span>`;
          li.addEventListener('click', () => onFocus(sub));
          li.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFocus(sub); }
          });
        } else {
          li.textContent = sub.text;
        }
        ul.appendChild(li);
      }
      details.appendChild(ul);
      container.appendChild(details);
      continue;
    }

    // ── Standard alert item ────────────────────────────────────────────────────
    // Alerts are clickable if they have map coordinates OR a heatmap to activate.
    const hasGeo = alert.coords?.length > 0 || alert.heatmaps?.length > 0;
    const clickable = onFocus && hasGeo;

    // Use a <button> when the alert is actionable so it gets keyboard focus
    // and screen-reader affordance; plain <div> otherwise.
    const item = document.createElement(clickable ? 'button' : 'div');
    item.className = `alert-item alert-item--${alert.level}${clickable ? ' alert-item--clickable' : ''}`;
    if (clickable) {
      item.type = 'button';
      item.title = alert.coords?.length
        ? 'Click to zoom map to these locations'
        : 'Click to show this layer on the map';
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
