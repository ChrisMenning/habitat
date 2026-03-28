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
- The comment `// all raw API fields (area_sqft, website, socials, etc.)` in `hnp.js` was aspirational and has been corrected — those fields do not exist in the API response.
- If HNP ever extends their guest API, the `...p` spread in `hnp.js` will automatically pick up new fields — no code change needed to forward them to the popup.
- If richer local metadata is desired in the future, the only viable path is a manually curated supplemental JSON file for the Green Bay-area yards we care about (similar to `waystation_coords.json`).
