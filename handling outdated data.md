Phase A — Temporal badges on layer toggles (lowest risk, highest visibility)
Every layer toggle in the slide-out panels that has a known fixed data vintage should display a small inline badge showing that year (e.g., 2021, 2022, 2013–2022). Layers backed by live APIs (iNaturalist, GBIF occurrence, eBird) should show no badge or a Live badge in a distinct color.

Add a vintage field to each layer definition in config.js. Use null for live/streaming layers and an object like { year: 2021 } or { yearMin: 2013, yearMax: 2022 } for fixed datasets.
In ui.js, when rendering each layer toggle, read vintage and inject a <span class="layer-vintage-badge"> immediately after the layer label.
Style the badge in styles.css: small, muted, monospace, inline. Use amber (#b45309 on a #fef3c7 chip) for fixed-vintage layers and a distinct teal or green for Live. Ensure WCAG 2.2 AA contrast on the dark panel background.
Do not alter toggle behavior, layer rendering, or any other logic in this phase.


Phase B — Tooltip / hover warning on stale layer toggles
When a user hovers or focuses a fixed-vintage layer toggle, surface a short warning that the data has a fixed ceiling and comparisons with live layers may be inaccurate.

Add a title attribute or a custom aria-describedby tooltip to each toggle that has a non-null vintage. Text pattern: "Data vintage: 2021. No newer data available. Comparisons with live layers may be inaccurate."
For layers with a year range (e.g., Tree Canopy 2013–2022), use: "Most recent data: 2022. Earlier survey years (2013, 2020) also available via the timeline control."
Prefer native title if a custom tooltip component does not already exist in the codebase. If a tooltip pattern does exist, match it exactly.
Ensure the tooltip is keyboard-accessible (visible on focus, not just hover).


Phase C — Desaturation / hatch overlay on active stale layers
When a fixed-vintage layer is currently visible on the map, apply a subtle visual treatment to signal its age relative to the live data.

Define a staleness threshold in config.js (default: current year minus 3). Any fixed-vintage layer whose yearMax (or year) is older than this threshold is considered stale.
For stale raster layers (NLCD, Cropland, Tree Canopy): reduce the MapLibre layer's raster-opacity by 15 percentage points from its default when stale. Add a comment in layers.js explaining the intent.
For stale vector layers: apply a subtle SVG diagonal-hatch fill-pattern or reduce fill-opacity slightly. Do not alter stroke/outline weight.
Add a one-line note in the legend panel explaining the dimming convention: "Layers dimmed ≥ 3 yrs past vintage."
Do not apply desaturation to Live-badged layers under any circumstance.


Phase D — Temporal mismatch alert in the existing alert engine
Extend alerts.js to add a fifteenth alert type: Temporal Mismatch. This alert fires when the user has simultaneously activated two or more layers whose vintages differ by more than a configurable threshold.

Add a TEMPORAL_MISMATCH_THRESHOLD_YEARS constant to config.js (default: 3).
In alerts.js, after the existing fourteen alert evaluations, add a checkTemporalMismatch() function. It should: (a) collect all currently active layers that have a non-null vintage; (b) compute the pairwise year gap between each fixed-vintage layer and the most-recent active fixed-vintage or live layer; (c) if any gap exceeds the threshold, generate an alert.
Alert format should match existing alert objects exactly (same fields: type, severity, title, detail, affectedFeatures). Example title: "Temporal Mismatch — Land Cover vs. Tree Canopy". Example detail: "NLCD 2021 and Tree Canopy 2013 are active simultaneously. A 8-year gap may make overlay comparisons unreliable."
The alert should appear in the Alerts panel alongside the existing fourteen. It should not trigger for layers where both vintages are within the threshold.
Write a brief inline comment block above checkTemporalMismatch() describing the algorithm so future contributors can tune it.


Constraints that apply to all phases:

No new runtime dependencies. No build step changes.
All changes must degrade gracefully if vintage is null or missing.
Do not refactor unrelated code. Surgical edits only.
Match existing code style, naming conventions, and comment patterns exactly.
After each phase, describe what you changed and in which files, so the implementer can review before proceeding.