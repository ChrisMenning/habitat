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
  parcelFeatures     = [],
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
      icon:   'ℹ️',
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
    if (!hasSite) opportunityClusters.push({ coord: clusterCoord, count });
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

    alerts.push({
      level:    'opportunity',
      icon:     '🌱',
      key:      'opportunity-zones',
      text:     `${enrichedClusters.length} area${enrichedClusters.length > 1 ? 's' : ''} with active pollinator sightings (${total.toLocaleString()} records) have no nearby habitat program site — potential expansion zones.${ownerNote}`,
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
        icon:   '⚠️',
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
        icon:   '✅',
        key:    'site-clusters',
        text:   `${clusterCount} habitat site pair${clusterCount > 1 ? 's are' : ' is'} within 300 m of each other — forming connected corridor nodes.`,
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
        icon:   '🏝️',
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
      icon:   '🔗',
      key:    'weak-nodes',
      text:   `${weakNodes.length} corridor site${weakNodes.length > 1 ? 's sit' : ' sits'} in a weak-signal zone — nearest corridor neighbour is 700 m–2 km away, beyond comfortable solitary bee foraging range: ${names.join(', ')}${extra}. A new planting within 700 m of each would restore mesh-level connectivity.`,
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
      alerts.push({
        level:  'info',
        icon:   '🔗',
        key:    'connectivity-gap',
        text:   `Corridor connectivity gap: the largest gap in the spanning network is ${worst.dist.toFixed(1)} km (between "${a.name}" and "${b.name}"). Most native bees forage < 2 km — a stepping-stone planting here would close the gap.`,
        coords: [a.coord, b.coord],
        layers: ['gbcc-corridor'],
      });
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
        icon:   '⚖️',
        key:    'mismatch-high',
        text:   `Pollinator mismatch — HIGH: ${beePct.toFixed(1)}% of Brown County land includes bee-dependent crops (${cropNames}), but current habitat covers an estimated ${coveragePct.toFixed(0)}% of the region.${colonyNote}${censusNote} Strategic HNP or corridor expansion near agricultural zones would have high economic leverage.`,
        coords: [],
        layers: [],
      });
    } else if (beePct > 4) {
      const cropNames = topBeeCrops.slice(0, 2).map(c => c.category).join(', ');
      alerts.push({
        level:  'opportunity',
        icon:   '⚖️',
        key:    'mismatch-moderate',
        text:   `Pollinator leverage opportunity: ${beePct.toFixed(1)}% of the county features bee-dependent crops (${beeOfCropPct.toFixed(0)}% of all cropland; top: ${cropNames}).${colonyNote}${censusNote} Targeted habitat additions near these fields would provide measurable crop yield benefits.`,
        coords: [],
        layers: [],
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
        icon:   '📍',
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
        icon:   'ℹ️',
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
        icon:   '⚠️',
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
        icon:   '⚠️',
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
        icon:   '🌱',
        key:    'poor-nesting-habitat',
        text:   `Poor Nesting Habitat: ${poorSites.length} corridor site${poorSites.length > 1 ? 's score' : ' scores'} below 25/100 on the NLCD nesting suitability index — little bare ground, shrubland, or grassland detected within 300 m. Adding bare-soil patches, sand berms, or letting edges go unmowed would significantly expand nesting resources: ${names.join(', ')}${extra}.`,
        coords: poorSites.map(centroid),
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
          const addrNote   = p.norm.address !== '—' ? ` at ${p.norm.address}` : '';
          alerts.push({
            level:  'warn',
            icon:   '⚠️',
            key:    `public-land-gap-${pid}`,
            text:   `High-Value Public Land Gap: ${acres.toFixed(1)}-acre ${ownerLabel} parcel${addrNote} has no habitat program site within 500 m and sits in an active opportunity zone. Public ownership makes this an actionable outreach target — no private negotiation required.`,
            coords: [pCoord],
            layers: ['gbcc-corridor', 'waystations', 'parcels'],
          });
          if (alerts.filter(a => a.key.startsWith('public-land-gap-')).length >= 3) break;
        }
      }
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
  const alertsPanel = document.getElementById('alerts-panel');
  if (alertsPanel) {
    alertsPanel.classList.remove('alerts-panel--collapsed');
    const toggle = document.getElementById('alerts-panel-toggle');
    if (toggle) { toggle.textContent = '▼'; toggle.setAttribute('aria-expanded', 'true'); }
  }

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
