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
