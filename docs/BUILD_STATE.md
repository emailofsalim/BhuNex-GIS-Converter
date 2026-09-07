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
| Base project | `vendor/reference/Universal-Conveter.zip` (Flask + ODA DWG→DXF prototype) |
| Engine donor | `vendor/reference/Geo-Studio-Pro-main.zip` (React/TS, `src/lib/*`) |
| Spec of record | `docs/UNIVERSAL_BHUNEX_CONVERTER_BUILD_INSTRUCTIONS.txt` (v2.0) |
| Owner's master doc | merged into the spec; verbatim copy at `docs/reference/MASTER_INSTRUCTIONS_AS_SUPPLIED.txt` |
| Runtime deps | **zero** — platform APIs only (CompressionStream, DataView, Workers) |
| Build | Vite multi-entry → `dist/`, package → `dist-zip/` |
| Verify | `npm run verify` = `tsc --noEmit` + `vitest run` + `vite build` |
| Tests | 237 across 8 suites, all green |

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
| 9 | Fidelity prediction ✅ + "what will be lost" ✅; conversion report doc ⛔, project health ⛔ (§22, §29) | 🟡 partial |
| 10 | QA catalogue ✅, topology rules ✅, preview/apply/undo repair ✅, spatial index ✅; remaining repair ops ⛔ (§23, §24) | 🟡 partial |
| 11 | Vertex editor, snapping, measurement, geometry ops, attribute table (§25, §26) | ⛔ not started |
| 12 | Label/attribute burn-in, CAD polygonisation, styled KMZ (§27, §28) | ⛔ not started |
| 13 | Dual canvas + visual diff, command palette, workflows, project file (§30, §31) | ⛔ not started |

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
`predict.ts` (fidelity prediction), `spatial-index.ts` (uniform grid),
`pipeline.ts` (the single dispatch point).

**CRS** (`extension/src/crs/`) — `projection.ts` (Snyder TM, all UTM zones, Web
Mercator, LCC), `epsg.ts` (bundled subset, Indian zones first), `wkt.ts`
(recursive-descent WKT1, UTM recovery from the k0 fingerprint), `transform.ts`
(refuses datum shifts it cannot perform).

**Engines** — `vector/` (geojson, topojson, kml, gpx, wkt, wkb, csv, shapefile, dbf,
gml, osm, mifmid, landxml, surpac, xlsx), `cad/` (dxf-read, dxf-write), `raster/`
(asciigrid, worldfile, geotiff, geotiff-write, tiff-codec), `pointcloud/` (las,
text, decimate),
`survey/schema.ts`, `archives/zip.ts`, `xml.ts` (worker-safe XML reader).

**QA** — `topology.ts` (per-feature checks + in-pipeline repair), `defects.ts`
(the relational catalogue: overlaps, shared-edge mismatch, slivers, spikes,
bow-ties, Z anomalies, crossings, dangles), `rules.ts` (ten asserted topology
rules with dataset/layer/feature scope), `repair.ts` (plan → apply → undo, with
protected layers), `fidelity.ts` (re-import comparison; `NOT_VALIDATED` exists so
an unreadable target can never show PASS).

**UI** — `workspace/` (full page), `sidepanel/`, `popup/`, `ui/preview.ts` (canvas,
no tiles), `state/store.ts`, `workers/`.

**Native host** — `native-host/universal_bhunex_host.py` + `install.py`.

**Docs** — instruction TXT, this file, `NATIVE_HOST.md`, `FORMAT_MATRIX.md`
(generated from the registry; CI fails if stale).

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

1. **Phase 12 — burn-in (§27).** The distinctive requirement: cadastral text inside
   polygons becomes polygon attributes. Nothing else in the tool does this, and it
   is why CAD→GIS cadastral conversion is normally redone by hand.
2. **Phase 9 remainder (§22.4, §29.2).** The per-file conversion report document,
   and the project health score. The prediction engine they both build on is done.
3. **Phase 11 (§25, §26).** The vertex editor, cross-feature snapping and the
   remaining repair operations — all of which inherit the plan/apply/undo contract
   `qa/repair.ts` already defines, rather than reinventing it.
4. **Phase 5 — LAZ.** Bundle a genuine laszip decoder (WASM), then flip LAZ off
   `adapter`. Until then the honest refusal stays.
5. **Phase 6 — GeoPackage** via SQLite WASM; FlatGeobuf reader; DGN/E57 adapters.
6. **Phase 4 remainder** — resampling, raster reprojection, contour generation,
   clip-by-polygon, rasterize/vectorize.
7. **Perf** — the measured performance test from spec §14.2 (targets are to be
   measured, not claimed), and the spatial index of §14.5 in the same phase as the
   first feature that needs it.
8. **Batch** — pause/resume and retry-failed controls; the pipeline already isolates
   errors per file.

---

## Session log

| Date | Session | What landed |
|---|---|---|
| 2026-09-04/05 | initial build | Phases 0–3 and 7 complete; Phase 5 partial (LAS/PLY/PTS/XYZ + decimation); Phase 6 partial (DWG native host). 116 tests, CI, instruction document, generated format matrix, PR. |
| 2026-09-07 | QA catalogue + rename | Phase 10: `core/spatial-index.ts` (uniform grid), `qa/defects.ts` (11 relational detectors), `qa/rules.ts` (10 asserted rules with scope), `qa/repair.ts` (plan → apply → diff-based undo, protected layers, fix-safe-issues). Found and fixed an inverted ring-winding convention that made every shapefile and MIF/MID this tool wrote non-conforming. Product renamed to **Universal BhuNex Converter**. 237 tests (`qa.test.ts` new, 37). |
| 2026-09-06 | fidelity prediction | Phase 9: `core/predict.ts` — eleven-axis GREEN/YELLOW/RED prediction computed before conversion, from a one-pass `DatasetProfile` so ranking 30 targets costs one walk over the features. `FormatLimits` moved the writer constraints (DBF 10-char names, 254-byte values, shapefile one-shape-type, mandated CRS, layer model) into the registry. Wired into the pipeline as a pre-flight (R22): impossible targets fail with a reason, lossy ones proceed with counted warnings. UI: fidelity badge on every format card, cards ordered by predicted fidelity, and a "What will be lost" tab with the axis grid. 199 tests (`predict.test.ts` new, 24). |
| 2026-09-06 | GeoTIFF codec + spec merge | Phase 4 raster: `tiff-codec.ts` (LZW with early change, Deflate, PackBits, predictors 2/3, strips/tiles, both planar configs), `geotiff-write.ts`, registry flipped to `full` with 33 new tests. Two real defects fixed: LZW widened a code too late, and a corrupt code could hang the worker for ever. Owner's Master Build Instructions merged into the spec (v2.0): rules R17–R24, sections 21–31, phases 9–13, traceability map. 175 tests. |
| 2026-09-06 | structure preservation | Phase 8: rule R16. `CirLayer.path` + `CirDataset.origin`, `core/layout.ts`, three output layouts wired through the pipeline / worker / batch ZIP, OSM writer added, hierarchy carried across format hops, Delivery structure tab. 141 tests (new `structure.test.ts`, 25). |
