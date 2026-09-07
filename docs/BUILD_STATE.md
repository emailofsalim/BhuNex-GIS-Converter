# BUILD STATE — Universal BhuNex Converter

**Resumable progress ledger.** Any session (human or AI) picking this work up reads
`docs/UNIVERSAL_BHUNEX_CONVERTER_BUILD_INSTRUCTIONS.txt` first, then this file, then
runs `npm ci && npm run verify`, does the next open task, updates this file, commits
and pushes to `claude/gis-cad-chrome-converter-hk8uwg`.

---

## Context you must not lose

| Fact | Value |
|---|---|
| Repository | `emailofsalim/Universal-Converter` |
| Working branch | `claude/gis-cad-chrome-converter-hk8uwg` |
| Product | **Universal BhuNex Converter** — Chrome MV3 extension for GIS / geomatics / survey / CAD / LiDAR / mining |
| Scope | **Chrome MV3 extension only.** A web app is deferred and the reasoning is recorded in `docs/SCOPE.md` — do not start one without reading it. |
| Base project | `vendor/reference/Universal-Conveter.zip` (Flask + ODA DWG→DXF prototype) |
| Engine donor | `vendor/reference/Geo-Studio-Pro-main.zip` (React/TS, `src/lib/*`) |
| Spec of record | `docs/UNIVERSAL_BHUNEX_CONVERTER_BUILD_INSTRUCTIONS.txt` (v2.0) |
| Owner's master doc | merged into the spec; verbatim copy at `docs/reference/MASTER_INSTRUCTIONS_AS_SUPPLIED.txt` |
| Runtime deps | **zero** — platform APIs only (CompressionStream, DataView, Workers) |
| Build | Vite multi-entry → `dist/`, package → `dist-zip/` |
| Verify | `npm run verify` = `tsc --noEmit` + `vitest run` + `vite build` |
| Tests | 450 across 15 suites, all green |
| Install | **Load `dist/`, never the repo root.** On a managed laptop, extract outside OneDrive — `docs/INSTALL.md` |
| Store | Package + listing ready: `npm run store:package`, `docs/STORE_LISTING.md`, `docs/PRIVACY.md` |

### Where the donated engines came from
Ported/adapted from `Geo-Studio-Pro-main/src/lib/`: `formats.ts` (parsers/writers),
`universalDataBridge.ts` (detection), `zip.ts` (DEFLATE + ZIP), `geodesy.ts` +
`crsIdentity.ts` (UTM/CRS), `qa.ts`, `deduplication.ts`, `unitEngine.ts`,
`parseClient.ts` (worker threshold = 2 MB), `workers/parseWorker.ts`.
From `Universal-Conveter/Pakhar_CAD_GIS_Local_Server/`:
`backend/services/dwg_converter.py` (ODA invocation, isolated job dirs, output
validation) → became `native-host/universal_bhunex_host.py`.

The engines were **re-implemented against the CIR**, not copy-pasted: the originals
were coupled to Geo-Studio's `GeoFeature` type and its `(zone, south)` CRS model.

---

## Phase board

| Phase | Scope | Status |
|---|---|---|
| 0 | Repo scaffold, manifest, build/test config, instruction document | ✅ done |
| 1 | Foundation: CIR, registry, detector, companions, ZIP, workers, state | ✅ done |
| 2 | Core vector: CSV/survey tables, GeoJSON(+seq), KML/KMZ, GPX, WKT/WKB, Shapefile, DXF r/w, TopoJSON | ✅ done |
| 3 | Survey/engineering: LandXML, Surpac STR, MIF/MID, GML, OSM, ASCII Grid, world files, QGIS GCP, XLSX | ✅ done |
| 4 | Raster: GeoTIFF codec ✅ (read + write); resampling/reprojection/DEM products ⛔ | 🟡 partial |
| 5 | Point cloud: LAS ✅, LAZ codec ⛔, PLY ✅, PTS ✅, XYZ ✅, decimation ✅ | 🟡 partial |
| 6 | Native/advanced: DWG via native host ✅; DGN/E57/GPKG/FGB/Parquet adapters ⛔ | 🟡 partial |
| 7 | UI: workspace, side panel, popup, preview, QA report, batch | ✅ done |
| 8 | Structure preservation: layer paths, layout engine, delivery tree UI | ✅ done |
| 9 | Fidelity prediction ✅, "what will be lost" ✅, conversion report ✅, project health ✅ (§22, §29) | ✅ done |
| 10 | QA catalogue ✅, topology rules ✅, preview/apply/undo repair ✅, spatial index ✅; remaining repair ops ⛔ (§23, §24) | 🟡 partial |
| 11 | Measurement ✅, snapping ✅ (incl. shared edge); vertex editor, geometry ops, attribute table ⛔ (§25, §26) | 🟡 partial |
| 12 | Burn-in ✅, label placement ✅, CAD polygonisation ✅, borehole model + core-log balloon ✅; KML overlays/icons ⛔ (§27, §28) | 🟡 partial |
| 13 | Measured visual diff ✅, command palette ✅, presets ✅, dual canvas + geometry overlay ✅, operation history ✅, workflows ✅, project file ✅ (§30, §31) | ✅ done |

Legend: ✅ done · 🟡 partial · ⛔ not started

Phases 9–13 come from the owner's Master Build Instructions, merged into the spec
as sections 22–31. Order is deliberate: inspection before repair, repair before
editing, editing before automation — a workflow engine replaying an operation
nobody can preview or undo multiplies damage instead of saving labour.

> This board is rewritten at the end of every session. If it disagrees with the
> tree, the tree wins — run `npm run verify` and correct the board.

---

## What exists right now

**Core** (`extension/src/core/`) — `cir.ts`, `registry.ts`, `detect.ts` (9-layer,
noisy-OR confidence), `companions.ts`, `units.ts`, `geometry.ts`, `precision.ts`,
`naming.ts`, `errors.ts`, `hash.ts`, `layout.ts` (delivery structure),
`predict.ts` (fidelity prediction), `presets.ts`, `spatial-index.ts` (uniform grid),
`history.ts` (reversible operation history), `workflow.ts` (record and replay),
`measure.ts` (CRS-aware measurement; Vincenty on a geographic CRS, planar on a
projected one, and it says which),
`report.ts` (the per-file conversion report),
`project.ts` (the project file), `secrets.ts` (one definition of credential-shaped,
shared by every writer), `pipeline.ts` (the single dispatch point).

**CRS** (`extension/src/crs/`) — `projection.ts` (Snyder TM, all UTM zones, Web
Mercator, LCC), `epsg.ts` (bundled subset, Indian zones first), `wkt.ts`
(recursive-descent WKT1, UTM recovery from the k0 fingerprint), `transform.ts`
(refuses datum shifts it cannot perform).

**Engines** — `vector/` (geojson, topojson, kml, gpx, wkt, wkb, csv, shapefile, dbf,
gml, osm, mifmid, landxml, surpac, xlsx), `cad/` (dxf-read, dxf-write), `raster/`
(asciigrid, worldfile, geotiff, geotiff-write, tiff-codec), `pointcloud/` (las,
text, decimate),
`survey/schema.ts`, `survey/borehole.ts` (collar/interval join),
`vector/kml-templates.ts` (balloons, secret stripping), `archives/zip.ts`, `xml.ts` (worker-safe XML reader).

**QA** — `topology.ts` (per-feature checks + in-pipeline repair), `defects.ts`
(the relational catalogue: overlaps, shared-edge mismatch, slivers, spikes,
bow-ties, Z anomalies, crossings, dangles), `rules.ts` (ten asserted topology
rules with dataset/layer/feature scope), `repair.ts` (plan → apply → undo, with
protected layers), `burn-in.ts` (text inside polygons → attributes/labels),
`label-placement.ts` (pole of inaccessibility), `polygonize.ts` (CAD line work →
polygons), `snap.ts` (vertex, segment, intersection, grid and shared-edge
snapping — nothing moves unless it is named), `diff.ts` (measured source-vs-output comparison),
`geometry-overlay.ts` (where the differences are, for the second canvas),
`health.ts` (the project health score, drill-down mandatory),
`fidelity.ts` (re-import comparison; `NOT_VALIDATED` exists so
an unreadable target can never show PASS).

**UI** — `workspace/` (full page), `sidepanel/`, `popup/`, `ui/preview.ts` (canvas,
no tiles), `ui/dual-canvas.ts` (source and output side by side, linked views),
`ui/command-palette.ts`, `state/store.ts`, `workers/`.

**Native host** — `native-host/universal_bhunex_host.py` + `install.py`.

**Docs** — instruction TXT, this file, `INSTALL.md` (the manifest error, the
three folders people select by mistake, and the OneDrive placeholder trap),
`STORE_LISTING.md` (listing copy, permission justifications, submission steps),
`PRIVACY.md` (required by both stores), `NATIVE_HOST.md`, `FORMAT_MATRIX.md`
(generated from the registry; CI fails if stale).

**Store tooling** — `scripts/assert-store-ready.mjs` (every rule a store rejects
for, checked against `dist/`), `scripts/make-store-assets.mjs` (screenshots and
promo tiles rendered by headless Chromium at exact sizes, no dependency added).

---

## Known gaps — deliberate and documented, not bugs

1. **GeoTIFF decodes uncompressed, LZW, Deflate and PackBits only.** JPEG, JPEG
   2000, LERC, WebP and Zstandard are refused *by name*; the georeference,
   extent and footprint of such a file are still read. Multi-IFD pyramids and
   overviews are not read — only the first image. Resampling, raster
   reprojection and DEM products remain Phase 4 work.
2. **LAZ is refused, never mis-parsed.** No codec bundled, so the compressed
   payload is reported honestly (rule R5).
3. **DWG requires the native host.** No browser-native DWG; status states surface
   in the top bar.
4. **DGN / E57 / GeoPackage / FlatGeobuf / GeoParquet / vendor mining formats** are
   adapter contracts only.
5. **Datum shifts beyond the WGS 84 family** and **geoid (orthometric↔ellipsoidal)**
   are not offered — no engine, so no UI for it.

---

## Defects found by the test suite (fixed — keep the tests)

These were real bugs the round-trips caught. Do not "simplify" the tests that guard them.

| Bug | Fix |
|---|---|
| Detection confidence was a linear sum ÷ magic constant; an unambiguous survey CSV scored 57% and was blocked | Noisy-OR over per-layer diagnostic strengths, plus a survey-header signal |
| A valid JSON file with no GeoJSON structure was still called GeoJSON on its extension | Structural failure now rules the format out entirely |
| WKB detection read EWKB flag bits as part of the geometry type | Mask `0xE0000000` before decoding the type |
| DBF writer upper-cased field names (`plot_no` → `PLOT_NO`), breaking joins | Case preserved; uniqueness checked case-folded |
| DXF writer preferred the synthetic CIR layer name over the carried CAD layer | `_layer` is checked first; GeoJSON reader restores `sourceLayer`/`sourceEntity`/`sourceHandle` |
| Table→table conversions (CSV→XLSX) wrote a header and no rows | CSV and XLSX writers pass a `dataset.table` through verbatim |
| `buildPrj` emitted datum `D_GCS_WGS_1984`, which no reader recognises | Geographic CS name and datum name are separate; datum regex widened |
| FlatGeobuf was an adapter declaring neither `requiresNative` nor `requiresWasm` | Marked `requiresWasm` |
| KML writer emitted every placemark twice — the recursive folder render appended a child's placemarks, and the parent appended them again | Each node emits its own placemarks, then its child folders |
| GeoJSON→KML lost the layer hierarchy: a multi-layer source came back as one flat layer | GeoJSON carries `_layer` as a " / "-joined path; the reader regroups on it |
| Shapefile/MIF-MID writers returned a nested ZIP, producing a ZIP inside the batch ZIP | Writers return loose grouped members; `core/layout.ts` decides folder placement |
| TIFF LZW widened the code one entry too late — a decoder's table always lags the encoder's by one, so ~250 entries in, every later code shifted by a bit and produced plausible-looking false terrain | Widen when the decoder's next free code reaches 510, not 511; a differential test encodes the same data with the GIF rule and asserts it does **not** decode |
| **`isClockwise` was inverted** — it returned true for counter-clockwise rings, so `orientRing(ring, true)` produced counter-clockwise output. Shapefile and MIF/MID writers asked for clockwise outer rings and got the opposite, and the shapefile reader treated counter-clockwise rings as outers. Round trips passed because reader and writer cancelled the error out; only a different application would have seen a parcel render as a void | `isClockwise` anchored to `signedArea < 0`, the shapefile reader's own inverted copy fixed, and a test that checks the written `.shp` bytes against the textbook shoelace sum rather than against our own helper |
| Label placement took **11.8 seconds per polygon** on a thin diagonal strip — the best-first search picked its next cell by scanning the array, which is quadratic in the cell count, and that shape fills a near-square bounding box with cells that are all outside the polygon and all still plausible. Surfaced as the test suite going from 1 s to 13 s; the number that mattered was per-parcel, against a cadastral sheet of four thousand | Binary heap keyed on the cell bound (11,812 ms → 160 ms), plus precision relative to the polygon extent rather than absolute (→ ~1 ms): refining a 144-unit parcel to a millimetre bought four extra levels of subdivision to move the anchor by a distance invisible under a label metres tall. A regression test asserts the per-label cost stays under 50 ms |
| The measurement tests were written against remembered reference values rather than computed ones: a degree of longitude at 23N as 102 470 m (the spherical figure, not the ellipsoidal 102 522.5), a one-degree square as 12 308 km² (ellipsoidal, against a module that computes on the authalic sphere), and a transposed digit in the published Vincenty test vector's longitude that moved the endpoint 2.7 m. All four "failures" were the test being wrong and the engine being right | Every reference value now carries the formula it comes from in a comment beside it, so the next person can check the expectation rather than trusting it |
| The manifest description was 134 characters against the Chrome Web Store's silently-enforced hard limit of 132 — an automatic rejection that looks identical to a valid manifest when read | `scripts/assert-store-ready.mjs` checks it, and every other rule a store rejects for, against `dist/` in CI |
| The store-asset renderer used full Chromium, which subtracts window chrome from `--window-size` when laying out but captures the full requested size: a 440×280 tile laid out at 440×194 and lost its lower third, while the PNG was still exactly 440×280 — so a dimension check passed and the damage was invisible | Prefer `headless_shell`, which has no chrome; `assertFullBleed()` renders a single-colour page and decodes it before any asset is made, so the failure cannot ship silently |
| The worker path returned the re-imported output, the overlay, health and the report; the INLINE path for files under the 2 MB threshold silently returned none of them. A compare canvas that worked on a 3 MB DXF and was empty on a 300 KB one would read as a broken canvas rather than as the missing hand-off it was | The inline branch returns every field the worker branch does, with a comment saying so — a file under the threshold is not a lesser conversion |
| The credential value pattern was case-SENSITIVE, so it matched a lower-case `bearer ` and missed `Bearer ` — the capitalisation every HTTP header uses and therefore the only one anyone ever pastes. R23 looked enforced while letting the real case through into KMZ balloons | The pattern carries the `i` flag, the detection moved to one shared `core/secrets.ts` used by the KML writer, the project file and the report, and a test asserts all three capitalisations are caught |
| The geometry overlay matched layers by NAME, but single-layer readers name the layer after the file: `plots.geojson` is written, read back as `plots_converted_to_geojson.geojson`, and the commonest conversion there is reported every feature as simultaneously added and removed — a screen of red and green on a round trip that changed nothing | Layers pair by name first, then positionally for the leftovers when the counts on both sides are equal; the basis of each pairing is recorded in `paired` so a positional match is visible as one rather than passing for a name match |
| A GitHub source download could not be loaded as an extension — `dist/` is gitignored and `extension/` holds TypeScript, so "Load unpacked" on the repo root gives "Manifest file is missing or unreadable". Reported from a real install attempt | A `release.yml` workflow builds, verifies and attaches the packaged ZIP to a GitHub Release so installing needs no toolchain; `docs/INSTALL.md` names the three folders people select by mistake, and the README leads with a warning not to load the repo folder |
| A corrupt LZW code beyond the next free entry was accepted, storing a forward reference in the prefix chain; walking that chain never terminated and hung the conversion worker with no error | A code greater than `next` ends the decode and returns what was read |

---

## Structure preservation (rule R16) — how it works

`core/layout.ts` **plans and packages only**; format bytes are still written by the
pipeline. That split is why `tests/structure.test.ts` can assert on paths alone.

- `CirLayer.path` is an array of segments, never a joined string. KML folders nest,
  DXF layer names are flat, GML groups by feature type — the segments are what let a
  writer rebuild real folders.
- `CirDataset.origin` (`SourceOrigin`) records the source path, its directory and the
  archive chain it was extracted from, so `mirror-source` works even for a file found
  two ZIPs deep.
- Three layouts: `single`, `per-layer`, `mirror-source` (`OutputLayout`). Exposed in the
  workspace settings panel next to precision, and persisted in `AppSettings.outputLayout`.
- Invariants held by the layout engine and covered by tests: one layer gets no folder;
  one file is never wrapped in a ZIP; segments are sanitised so `../etc` cannot escape;
  colliding paths get numeric suffixes.
- The whole delivery tree is computed before packaging (`ConversionResult.tree`) and
  rendered in the workspace's **Delivery structure** tab.

---

## Next tasks, in order

1. **Phase 11 remainder (§25, §26).** Measurement and snapping are done. Next:
   the vertex editor (§25.1) on top of the snap engine, the attribute table
   (§25.5), and the geometry operations of §26.2 — all inheriting the
   plan/apply/undo contract `qa/repair.ts` and `qa/snap.ts` already share.
2. **Phase 5 — LAZ.** Bundle a genuine laszip decoder (WASM), then flip LAZ off
   `adapter`. Until then the honest refusal stays.
3. **Phase 6 — GeoPackage** via SQLite WASM; FlatGeobuf reader; DGN/E57 adapters.
4. **Phase 4 remainder** — resampling, raster reprojection, contour generation,
   clip-by-polygon, rasterize/vectorize.
5. **Perf** — the measured performance test from spec §14.2 (targets are to be
   measured, not claimed), and the spatial index of §14.5 in the same phase as the
   first feature that needs it.
6. **Batch** — pause/resume and retry-failed controls; the pipeline already isolates
   errors per file.

---

## Session log

| Date | Session | What landed |
|---|---|---|
| 2026-09-07 | scope: Chrome extension only | Scope decided and recorded in `docs/SCOPE.md`: the Chrome MV3 extension is the product, a web app is deferred with the reasoning written down (the engines are portable, but the extension apparatus is not, and a hosted page turns "nothing is uploaded" from a property of the artefact into a claim about a server's configuration). The packaged ZIP now carries `INSTALL-FIRST.txt` at its root — extracting it puts the instructions where the person is looking, including the OneDrive placeholder trap. `assert-store-ready.mjs` gained a loadability check: every file the manifest points at and every asset the pages reference must exist, which is what catches "loads but the workspace is blank"; proved by deleting a chunk and watching it fail. Version 1.0.1. |
| 2026-09-07 | snapping | `qa/snap.ts`: vertex, segment, intersection, grid and — the one the spec singles out — shared-edge snapping. Nothing moves unless it is named: a snap takes the features it may touch, so closing the gap between two parcels cannot also drag a road centreline or a monument that happened to be within tolerance. The shared run is found by testing each vertex against the other feature's *outline* rather than by pairing vertices, so it works when the two boundaries have different vertex counts, which after a re-survey they always do. Same plan/apply/undo contract as `qa/repair.ts`, closed rings stay closed, Z is preserved, and the maximum displacement is reported before anything moves. 450 tests (`snap.test.ts` new, 21). |
| 2026-09-07 | measurement | Phase 11 begins: `core/measure.ts` — distance, area, perimeter, bearing, azimuth, angle, slope and bearing/distance entry, each choosing its arithmetic from the CRS. Vincenty's inverse and direct solutions on a geographic CRS, planar on a projected one, and `planar-undeclared` when none is declared — carried in `Measurement.method` so a number is never read without knowing what produced it. This is the error the spec names: a degree of longitude is 111.3 km at the equator and 102.5 km at 23N, and a tool that treats degrees as a plane reports areas out by a factor that grows with latitude. 429 tests (`measure.test.ts` new, 32), anchored to published geodetic vectors rather than to the module itself. |
| 2026-09-07 | store readiness | Prepared publication to the Chrome Web Store and Edge Add-ons, which removes sideloading entirely: `scripts/assert-store-ready.mjs` (manifest limits, icon sizes, remote code, heavy permissions, stray `key`/`update_url`), `scripts/make-store-assets.mjs` (4 screenshots, 2 promo tiles, Edge logo, rendered by headless Chromium at exact sizes with a full-bleed guard), `docs/PRIVACY.md` and `docs/STORE_LISTING.md`. `nativeMessaging` moved to `optional_permissions` and requested from the DWG click, so a store install never demands it. Store build drops source maps: 1.1 MB → 303 KB. Two defects found: a 134-character description (a silent auto-rejection) and a renderer that clipped every asset's lower third while producing correctly-sized files. |
| 2026-09-07 | reporting + health | Phase 9 completed: `qa/health.ts` (seven weighted components — CRS certainty, geometry, topology, duplicates, attributes, conversion risk, warnings — each expandable into locatable findings; an unevaluated component is excluded from the mean and named rather than scored full marks, so an unassessable dataset can never outrank an assessable one; deductions are proportional to the share of features affected, not the raw count) and `core/report.ts` (self-contained HTML and text, no script, no remote fetch, every value escaped, credential-scrubbed with the omission stated, attachable to the delivery). Both wired through the pipeline as opt-in stages, with a Health tab and palette commands. Fixed a hand-off gap where files under the worker threshold lost the overlay, health and report. 397 tests (`health.test.ts` new, 27). |
| 2026-09-07 | project layer + install fix | Phase 13 completed: `core/history.ts` (reversible operation history — compact patches with a reference-equality fast path, checkpoints, branch discard, bounded with the drop reported), `core/workflow.ts` (record and replay; a step that would prompt by hand still prompts on replay, and a run with no confirmation handler refuses rather than assumes), `core/project.ts` (sources by identity not bytes, hash-based match on reopen, R23 scrub with the omission listed), `core/secrets.ts` (one definition of credential-shaped, shared), `qa/geometry-overlay.ts` + `ui/dual-canvas.ts` (source and output side by side, linked views that unlink themselves on a reprojection, the difference drawn over both). Three real defects fixed: a case-sensitive bearer-token pattern, name-only layer pairing, and a repository nobody could install. 370 tests (`project.test.ts` new, 52). |
| 2026-09-04/05 | initial build | Phases 0–3 and 7 complete; Phase 5 partial (LAS/PLY/PTS/XYZ + decimation); Phase 6 partial (DWG native host). 116 tests, CI, instruction document, generated format matrix, PR. |
| 2026-09-07 | workflow layer | Phase 13: `qa/diff.ts` (ten-axis measured source-vs-output comparison, computed from the QA re-import so verdict and numbers describe the same bytes), `core/presets.ts` (twelve presets, guarded so none can enable a destructive option or write KML without EPSG:4326), `ui/command-palette.ts` (Ctrl/Cmd+K, keyword-aware ranking, disabled commands shown with their reason). Compare tab added. 317 tests (`workflow.test.ts` new, 27). |
| 2026-09-07 | mining deliverables | §28: `engines/survey/borehole.ts` joins collars to interval logs by hole id across layers and packages (Datamine/Surpac/Micromine/spreadsheet aliases), computes thickness from the depths, reports orphaned intervals and finds log gaps and overlaps. `engines/vector/kml-templates.ts` renders the core-log balloon and six field-ordering templates, escapes every value, strips credential-shaped fields and reports the omission. 290 tests (`borehole.test.ts` new, 25). |
| 2026-09-07 | cadastral semantics | Phase 12: `qa/label-placement.ts` (pole of inaccessibility — the centroid of a C-shaped parcel falls outside it), `qa/burn-in.ts` (text inside polygons → attribute/label/geometry/CAD/KML, five tie-break rules, rejected candidates reported), `qa/polygonize.ts` (separate LINE entities → closed boundaries, gap recorded per polygon, crossing lines deliberately not noded). Both wired into the pipeline as opt-in stages and exposed as a Cadastral tools panel. 265 tests (`burnin.test.ts` new, 28). |
| 2026-09-07 | QA catalogue + rename | Phase 10: `core/spatial-index.ts` (uniform grid), `qa/defects.ts` (11 relational detectors), `qa/rules.ts` (10 asserted rules with scope), `qa/repair.ts` (plan → apply → diff-based undo, protected layers, fix-safe-issues). Found and fixed an inverted ring-winding convention that made every shapefile and MIF/MID this tool wrote non-conforming. Product renamed to **Universal BhuNex Converter**. 237 tests (`qa.test.ts` new, 37). |
| 2026-09-06 | fidelity prediction | Phase 9: `core/predict.ts` — eleven-axis GREEN/YELLOW/RED prediction computed before conversion, from a one-pass `DatasetProfile` so ranking 30 targets costs one walk over the features. `FormatLimits` moved the writer constraints (DBF 10-char names, 254-byte values, shapefile one-shape-type, mandated CRS, layer model) into the registry. Wired into the pipeline as a pre-flight (R22): impossible targets fail with a reason, lossy ones proceed with counted warnings. UI: fidelity badge on every format card, cards ordered by predicted fidelity, and a "What will be lost" tab with the axis grid. 199 tests (`predict.test.ts` new, 24). |
| 2026-09-06 | GeoTIFF codec + spec merge | Phase 4 raster: `tiff-codec.ts` (LZW with early change, Deflate, PackBits, predictors 2/3, strips/tiles, both planar configs), `geotiff-write.ts`, registry flipped to `full` with 33 new tests. Two real defects fixed: LZW widened a code too late, and a corrupt code could hang the worker for ever. Owner's Master Build Instructions merged into the spec (v2.0): rules R17–R24, sections 21–31, phases 9–13, traceability map. 175 tests. |
| 2026-09-06 | structure preservation | Phase 8: rule R16. `CirLayer.path` + `CirDataset.origin`, `core/layout.ts`, three output layouts wired through the pipeline / worker / batch ZIP, OSM writer added, hierarchy carried across format hops, Delivery structure tab. 141 tests (new `structure.test.ts`, 25). |
