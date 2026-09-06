# BUILD STATE — Universal Geo Converter

**Resumable progress ledger.** Any session (human or AI) picking this work up reads
`docs/UNIVERSAL_GEO_CONVERTER_BUILD_INSTRUCTIONS.txt` first, then this file, then
runs `npm ci && npm run verify`, does the next open task, updates this file, commits
and pushes to `claude/gis-cad-chrome-converter-hk8uwg`.

---

## Context you must not lose

| Fact | Value |
|---|---|
| Repository | `emailofsalim/Universal-Converter` |
| Working branch | `claude/gis-cad-chrome-converter-hk8uwg` |
| Product | Chrome MV3 extension — GIS / geomatics / survey / CAD / LiDAR / mining converter |
| Base project | `vendor/reference/Universal-Conveter.zip` (Flask + ODA DWG→DXF prototype) |
| Engine donor | `vendor/reference/Geo-Studio-Pro-main.zip` (React/TS, `src/lib/*`) |
| Spec of record | `docs/UNIVERSAL_GEO_CONVERTER_BUILD_INSTRUCTIONS.txt` |
| Runtime deps | **zero** — platform APIs only (CompressionStream, DataView, Workers) |
| Build | Vite multi-entry → `dist/`, package → `dist-zip/` |
| Verify | `npm run verify` = `tsc --noEmit` + `vitest run` + `vite build` |
| Tests | 141 across 5 suites, all green |

### Where the donated engines came from
Ported/adapted from `Geo-Studio-Pro-main/src/lib/`: `formats.ts` (parsers/writers),
`universalDataBridge.ts` (detection), `zip.ts` (DEFLATE + ZIP), `geodesy.ts` +
`crsIdentity.ts` (UTM/CRS), `qa.ts`, `deduplication.ts`, `unitEngine.ts`,
`parseClient.ts` (worker threshold = 2 MB), `workers/parseWorker.ts`.
From `Universal-Conveter/Pakhar_CAD_GIS_Local_Server/`:
`backend/services/dwg_converter.py` (ODA invocation, isolated job dirs, output
validation) → became `native-host/universal_geo_host.py`.

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
| 4 | Raster: full GeoTIFF codec, resampling, reprojection, DEM products | ⛔ not started — GeoTIFF stays **metadata-only** until then |
| 5 | Point cloud: LAS ✅, LAZ codec ⛔, PLY ✅, PTS ✅, XYZ ✅, decimation ✅ | 🟡 partial |
| 6 | Native/advanced: DWG via native host ✅; DGN/E57/GPKG/FGB/Parquet adapters ⛔ | 🟡 partial |
| 7 | UI: workspace, side panel, popup, preview, QA report, batch | ✅ done |
| 8 | Structure preservation: layer paths, layout engine, delivery tree UI | ✅ done |

Legend: ✅ done · 🟡 partial · ⛔ not started

> This board is rewritten at the end of every session. If it disagrees with the
> tree, the tree wins — run `npm run verify` and correct the board.

---

## What exists right now

**Core** (`extension/src/core/`) — `cir.ts`, `registry.ts`, `detect.ts` (9-layer,
noisy-OR confidence), `companions.ts`, `units.ts`, `geometry.ts`, `precision.ts`,
`naming.ts`, `errors.ts`, `hash.ts`, `layout.ts` (delivery structure),
`pipeline.ts` (the single dispatch point).

**CRS** (`extension/src/crs/`) — `projection.ts` (Snyder TM, all UTM zones, Web
Mercator, LCC), `epsg.ts` (bundled subset, Indian zones first), `wkt.ts`
(recursive-descent WKT1, UTM recovery from the k0 fingerprint), `transform.ts`
(refuses datum shifts it cannot perform).

**Engines** — `vector/` (geojson, topojson, kml, gpx, wkt, wkb, csv, shapefile, dbf,
gml, osm, mifmid, landxml, surpac, xlsx), `cad/` (dxf-read, dxf-write), `raster/`
(asciigrid, worldfile, geotiff), `pointcloud/` (las, text, decimate),
`survey/schema.ts`, `archives/zip.ts`, `xml.ts` (worker-safe XML reader).

**QA** — `topology.ts`, `fidelity.ts` (re-import comparison; `NOT_VALIDATED` exists
so an unreadable target can never show PASS).

**UI** — `workspace/` (full page), `sidepanel/`, `popup/`, `ui/preview.ts` (canvas,
no tiles), `state/store.ts`, `workers/`.

**Native host** — `native-host/universal_geo_host.py` + `install.py`.

**Docs** — instruction TXT, this file, `NATIVE_HOST.md`, `FORMAT_MATRIX.md`
(generated from the registry; CI fails if stale).

---

## Known gaps — deliberate and documented, not bugs

1. **GeoTIFF is metadata-only.** Georeference/structure read; pixels not decoded.
   Registry level `metadata-only`; raster export from such a source is refused.
   Closing this is Phase 4.
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

1. **Phase 4 — GeoTIFF codec.** Uncompressed + LZW + Deflate, strips and tiles.
   Flip the registry to `full` **in the same commit as its round-trip test**.
2. **Phase 5 — LAZ.** Bundle a genuine laszip decoder (WASM), then flip LAZ off
   `adapter`. Until then the honest refusal stays.
3. **Phase 6 — GeoPackage** via SQLite WASM; FlatGeobuf reader; DGN/E57 adapters.
4. **Preview** — classification colour ramps, raster band selection, layer toggles
   in the UI (the renderer already supports per-layer visibility).
5. **Perf** — add the measured performance test from instruction §14.2 (targets are
   to be measured, not claimed).
6. **Batch** — pause/resume and retry-failed controls; the pipeline already isolates
   errors per file.

---

## Session log

| Date | Session | What landed |
|---|---|---|
| 2026-09-04/05 | initial build | Phases 0–3 and 7 complete; Phase 5 partial (LAS/PLY/PTS/XYZ + decimation); Phase 6 partial (DWG native host). 116 tests, CI, instruction document, generated format matrix, PR. |
| 2026-09-06 | structure preservation | Phase 8: rule R16. `CirLayer.path` + `CirDataset.origin`, `core/layout.ts`, three output layouts wired through the pipeline / worker / batch ZIP, OSM writer added, hierarchy carried across format hops, Delivery structure tab. 141 tests (new `structure.test.ts`, 25). |
