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

### Where the donated engines came from
Ported/adapted from `Geo-Studio-Pro-main/src/lib/`:
`formats.ts` (parsers/writers), `universalDataBridge.ts` (detection), `zip.ts`
(DEFLATE + ZIP), `geodesy.ts` + `crsIdentity.ts` (UTM/CRS), `qa.ts`,
`deduplication.ts`, `unitEngine.ts`, `parseClient.ts` (worker threshold = 2 MB),
`workers/parseWorker.ts`.
From `Universal-Conveter/Pakhar_CAD_GIS_Local_Server/`: `backend/services/dwg_converter.py`
(ODA invocation + isolated job dirs + validation) → became the native messaging host.

---

## Phase board

| Phase | Scope | Status |
|---|---|---|
| 0 | Repo scaffold, manifest, build/test config, instruction document | 🔄 in progress |
| 1 | Foundation: CIR, registry, detector, ZIP, workers, state | ⛔ not started |
| 2 | Core vector: CSV/survey tables, GeoJSON(+seq), KML/KMZ, GPX, WKT/WKB, Shapefile, DXF r/w, TopoJSON | ⛔ not started |
| 3 | Survey/engineering: LandXML, Surpac STR, MIF/MID, GML, OSM, ASCII Grid, world files, QGIS GCP, XLSX | ⛔ not started |
| 4 | Raster: full GeoTIFF codec, resampling, reprojection, DEM products | ⛔ not started — GeoTIFF stays **metadata-only** until then |
| 5 | Point cloud: LAS, LAZ codec, PLY, PTS, decimation | ⛔ not started |
| 6 | Native/advanced: DWG via native host, DGN/E57/GPKG/FGB/Parquet adapters | ⛔ not started |

Legend: ✅ done · 🔄 in progress · 🟡 partial · ⛔ not started

> This board is rewritten at the end of every session. If it disagrees with the
> tree, the tree wins — run `npm run verify` and correct the board.

---

## What exists right now

### Core (`extension/src/core/`)
- `cir.ts` — canonical intermediate representation types + constructors
- `registry.ts` — single source of truth for every format's capabilities
- `detect.ts` — 9-layer detector with confidence scoring
- `companions.ts` — basename grouping (shp/shx/dbf/prj/cpg, mif/mid, tif/tfw)
- `units.ts` — linear/angular/area/volume namespaces, us-ft ≠ int-ft
- `geometry.ts` — geometry ops, bounds, segmentization, ring orientation
- `precision.ts`, `naming.ts`, `errors.ts`, `provenance.ts`, `hash.ts`
- `pipeline.ts` — ingest → detect → parse → convert → QA → package orchestration

### CRS (`extension/src/crs/`)
- `projection.ts` — Krueger-series Transverse Mercator, WGS 84, all UTM zones
- `epsg.ts` — bundled EPSG subset (4326, 3857, 326xx/327xx, common Indian grids)
- `wkt.ts` — WKT1 parse + build, `.prj`/`.qpj` handling
- `transform.ts` — CRS transform pipeline + safety rules (never guess)

### Engines (`extension/src/engines/`)
- `vector/`: `geojson.ts`, `topojson.ts`, `kml.ts`, `gpx.ts`, `wkt.ts`, `wkb.ts`,
  `csv.ts`, `shapefile.ts`, `dbf.ts`, `gml.ts`, `osm.ts`, `mifmid.ts`,
  `landxml.ts`, `surpac.ts`, `xlsx.ts`
- `cad/`: `dxf-read.ts` (expanded entity coverage), `dxf-write.ts`
- `raster/`: `asciigrid.ts` (full r/w), `worldfile.ts`, `geotiff.ts` (metadata-only),
  `gcp.ts`
- `pointcloud/`: `las.ts` (full r/w + honest LAZ refusal), `xyz.ts`, `ply.ts`, `pts.ts`,
  `decimate.ts`
- `survey/schema.ts` — PNEZD/PENZD/NEZ/ENZ alias detection + column mapping
- `archives/zip.ts` — ZIP read/write, zip-bomb + traversal guards

### QA (`extension/src/qa/`)
- `fidelity.ts` — re-import comparison, PASS / PASS WITH WARNINGS / FAILED / NOT VALIDATED
- `topology.ts` — self-intersection, rings, duplicates, orientation

### UI (`extension/src/workspace|sidepanel|popup`, `ui/`)
Framework-free TypeScript workspace: drop zone, queue, inspector, canvas preview,
format picker with search/chips/cards, target-driven settings, QA report, log.

### Native host (`native-host/`)
`universal_geo_host.py` (stdio length-prefixed JSON, ODA File Converter wrapper,
isolated temp jobs, DWG magic-byte validation) + per-platform installers.

---

## Known gaps — deliberate and documented, not bugs

1. **GeoTIFF is metadata-only.** Georeference/structure are read; pixels are not
   decoded. Registry level `metadata-only`, raster export disabled for such sources.
   Closing this = Phase 4.
2. **LAZ is refused, never mis-parsed.** No real codec is bundled, so the reader
   reports the compressed payload honestly (Rule R5).
3. **DWG requires the native host.** No browser-native DWG. Status states are
   surfaced in the top bar.
4. **DGN / E57 / GeoPackage / FlatGeobuf / GeoParquet / vendor mining formats** are
   adapter contracts only.
5. **Datum shifts beyond the WGS 84 family** and **geoid (orthometric↔ellipsoidal)**
   are not offered — no engine, so no UI for it.

---

## Next tasks, in order

1. Phase 4 — real GeoTIFF codec (uncompressed + LZW + Deflate strips/tiles), then
   raster reprojection and DEM products; flip registry to `full` **in the same commit
   as its round-trip test**.
2. Phase 5 — bundle a genuine LAZ decoder (WASM), then flip LAZ off `adapter`.
3. Phase 6 — GeoPackage via SQLite WASM; FlatGeobuf reader; DGN/E57 adapters.
4. Preview: add classification colour ramps and raster band selection.
5. Perf: add the measured performance test from instruction §14.2.

---

## Session log

| Date | Session | What landed |
|---|---|---|
| 2026-09-04 | initial build | Phases 1–3 complete, Phase 5 partial (LAS/PLY/PTS/XYZ), Phase 6 partial (DWG native host). Instruction doc, CI, tests, PR. |
