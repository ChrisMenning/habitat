# Bay Hive — Architecture & Data Source Decisions

A running log of significant findings, tradeoffs, and deliberate choices made during development. Intended to prevent re-investigating dead ends and to preserve context between sessions.

---

## HNP (Homegrown National Park) — Public API is Minimal by Design

**Date:** 2026-03-28  
**Investigated by:** GitHub Copilot + Chris

### Finding
The HNP guest API endpoint (`https://map.homegrownnationalpark.org/api/guest/map/plantings?countryCode=US`) returns only three fields per planting:

```json
{ "id": 1, "latitude": 44.123, "longitude": -88.456, "type": "OTHER_INVIDIUALS" }
```

No name, acreage, date joined, website, or any other member metadata is available through this endpoint. 52,000+ records, all identical minimal structure.

### Why
Richer detail (name, acreage, join date) exists on the platform but is protected behind **AWS Cognito OAuth authentication**. Attempting to access `/api/planting/{id}` without a session token redirects immediately to the Cognito login page. This is not an oversight — it is a deliberate access control decision by HNP.

### Decision
Do not attempt to scrape, bypass, or request authenticated access to this data. The platform owners have clearly chosen not to expose member details publicly through the API. We respect that boundary.

**What we keep:** The `id` and `type` fields (org vs individual), coordinates, and a working link to `https://map.homegrownnationalpark.org/` so users can look up details themselves.

**What we do not attempt:** Fetching name, acreage, joined date, or any field not returned by the guest endpoint.

### If This Comes Up Again
- The comment `// all raw API fields (area_sqft, website, socials, etc.)` that was in `hnp.js` was aspirational and had been corrected — those fields did not exist in the API response.
- If richer local metadata is desired in the future, the only viable path is a manually curated supplemental JSON file for the Green Bay-area yards we care about (similar to `waystation_coords.json`).

**Superseded by the entry below — the guest endpoint this section describes no longer exists.**

---

## HNP Guest API Discontinued — Layer Removed Entirely

**Date:** 2026-08-24
**Investigated by:** Claude Code + Chris

### Finding
The HNP guest API endpoint described above (`/api/guest/map/plantings?countryCode=US`) now returns `404 Cannot GET`. The non-guest equivalent (`/api/map/plantings`) 302-redirects to HNP's Cognito login (`auth.map.homegrownnationalpark.org`). HNP appears to have removed public/unauthenticated access to planting data entirely — this is a step beyond the March 2026 finding above, which only found per-record detail gated behind auth; now the bulk listing itself requires it too.

### Decision
Per the existing boundary from the March finding, we do not attempt to authenticate, scrape, or otherwise work around HNP's access control. Since there is no longer any public data to proxy, the HNP layer was removed from Bay Hive entirely rather than left showing a permanent error:
- Deleted `js/hnp.js`, the `/api/hnp-plantings` and `/api/hnp-count` server proxy routes, the `HNP_LAYER` config entry, and all UI/legend/popup/export/alert-engine references to HNP (connectivity mesh, habitat node counts, drawer stats, expansion/problem-feature analysis).
- Removed the three now-permanently-failing tests (`GET /api/hnp-plantings`, `HNP plantings API reachable`) from `tests.html`.
- The habitat network model is now two programs (Corridor + Waystations) instead of three everywhere this was counted (intel bar, drawer summaries, connectivity mesh, exports, alert text).

### If This Comes Up Again
- If HNP ever restores public guest access, re-adding the layer means reversing this commit's removal — the old `hnp.js` fetch logic and proxy design (see git history around 2026-08-24) is a reasonable starting point, but re-verify the endpoint path and response shape first since it may have changed.

---

## `/api/nlcd-nesting` Switched from GET+Query to POST+Body

**Date:** 2026-08-24
**Investigated by:** Claude Code + Chris

### Finding
A test sending a 601-site batch (to confirm the server's own `sites.length > 600` validation returns 400) was instead getting `414 URI Too Long` from nginx. nginx's default `large_client_header_buffers` caps the request line at 8 KB; a 601-site URL-encoded query string is ~40 KB, so nginx rejected it before the request ever reached Node — the app-level validation was unreachable for any batch large enough to matter.

### Decision
Converted `/api/nlcd-nesting` from `GET ?sites=...` to `POST` with a JSON body (`{ sites: [...] }`). POST bodies aren't subject to nginx's request-line limit, only `client_max_body_size` (default 1 MB, comfortably fits the 600-site cap). This makes the server's own batch-size validation actually reachable, and let the client's `fetchGridNlcdScores` batch size go back up from 40 (a value only ever chosen to fit under the old GET URI limit) to 500.
- Updated: `serve.js` (`proxyNlcdNesting`, now reads the body instead of `url.parse`; route now requires POST, 405 otherwise), `js/nesting.js` (both fetch call sites), `tests.html` (both nlcd-nesting tests).
- `/api/canopy-check` uses the same GET+query pattern and has no batching or size cap at all (`fetchCanopyScores` sends every corridor site in one request). Left as-is here since its input is the small, fixed corridor-site list, not a synthetic grid, and no test exercises an oversized batch — but it has the same latent nginx-URI-limit exposure as the old `/api/nlcd-nesting` design if the corridor site count ever grows substantially. Worth converting to POST+body too if that becomes a problem.

---

## Live GDD Stat Frozen Since March — Stale IEM Snapshot Silently Overriding Good Live Data

**Date:** 2026-08-24
**Investigated by:** Claude Code + Chris

### Finding
Chris noticed the live GDD figure looked wrong and initially suspected an expired `NOAA_CDO_TOKEN`. That token turned out to be fine — tested directly against NCEI's live API, which returned real current data (and doesn't even require a token; the Access Data Service endpoint is CORS-open).

The actual bug: `js/climate.js` prefers Iowa Environmental Mesonet (IEM) data over live NOAA GHCND for current-year GDD (IEM is an independent archive, unaffected by the federal NOAA/NCEI data-access disruption also documented in this file's climate-ribbon UI copy). But that IEM data isn't fetched live — it's served from a static snapshot, `snapshots/observed-temps-GRB-{year}.json`, via `GET /api/observed-temps/{year}`. Every one of those files (2021–2026) had the identical `"retrieved": "2026-03-27"` timestamp — a one-time manual pull that nothing ever refreshed. The 2026 file only had 85 days of data (through March 26); 2025 only had 86 days despite being a fully completed year.

`initClimatePanel()` in `climate.js` unconditionally overwrote the live GHCND-derived current-GDD with whatever the IEM snapshot contained, with no freshness check. So the live GDD stat had been frozen at "~2 GDD, Pre-season" since March, in the middle of August, even though the live GHCND path was working correctly the whole time.

### Decision
Two fixes, both needed:
1. **`js/climate.js`**: the IEM-preference override is now conditional — it only takes effect when the IEM snapshot's last day-of-year is `>=` the live GHCND result's. A stale local snapshot can no longer silently clobber a good live reading; it's used only when it's genuinely at least as current.
2. **New harvest source `iem`**: added `_harvestIem(year)` to `serve.js` and wired it into the existing `_autoHarvestMissing()` scheduler (previously handled `inat`/`gbif`/`noaa`/`nass`/`cdl` only). It fetches from IEM's ASOS daily-summary CSV endpoint (`mesonet.agron.iastate.edu/cgi-bin/request/daily.py`, station `GRB`) and writes `observed-temps-GRB-{year}.json` — note the different filename convention from every other auto-harvested source, handled via `_snapshotFileName()`. Scoped to `IEM_START_YEAR = 2021` onward (matching what `js/climate.js` actually requests), not the general `AUTO_HARVEST_START_YEAR = 2015`.
3. Also added `scripts/fetch-iem.js` — a standalone CLI with the same fetch/parse logic, for manual one-off backfills (`node scripts/fetch-iem.js 2025 2026`). Used it to backfill 2025 (full year, was stuck at day 86) and 2026 (through the day before run) before this fix shipped, since the auto-harvest fix alone wouldn't retroactively fix already-stale files sitting at a "fresh enough" mtime.

### If This Comes Up Again
- `scripts/fetch-iem.js` and `serve.js`'s `_harvestIem()` duplicate the same fetch/parse logic (CommonJS `serve.js` can't `require()` the ES-module CLI script). If one changes, check whether the other needs the same fix.
- IEM's `daily.py` endpoint has no documented rate limit; the 3 s inter-harvest delay (`AUTO_HARVEST_DELAYS_MS.iem`) is a polite default, not a measured requirement.
- If NOAA/NCEI's public API access is ever fully restored and stays reliable, the IEM fallback and its freshness-comparison logic could eventually be simplified away — but there's no urgency, and the conditional-override fix means a stale IEM file is now harmless either way.
