# Universal BhuNex Converter

A Chrome Manifest V3 extension that converts GIS, geomatics, land-survey, CAD,
LiDAR and mine-survey data **entirely on your own machine**.

Drop a file. It tells you exactly what it is, exactly what it can become,
converts it locally, and then proves the conversion was faithful by reading its
own output back and comparing it with the source.

```
INGEST → DETECT → INSPECT → CIR → TARGET → CONFIGURE → CONVERT → RE-IMPORT → QA → DELIVER
```

---

## Why this one is different

Most converters tell you a job succeeded. This one tells you what it did to your
data — and refuses to guess when guessing would be wrong.

| | |
|---|---|
| **No CRS is ever invented** | An easting of 412,345 is valid in all 60 UTM zones and both hemispheres. If a file declares no CRS and the numbers are ambiguous, conversion **stops and asks**. |
| **Nothing is dropped silently** | Unsupported CAD entities, lost attributes, dropped Z values and segmentized curves are counted by name and reported with what to do about it. |
| **Curves keep a stated tolerance** | An arc has no GIS equivalent, so it is densified against a sagitta tolerance you control — never replaced by its chord. |
| **LAZ is refused, not faked** | No LAZ decoder is bundled, so compressed point data is reported honestly rather than read as raw LAS coordinates. |
| **Unreadable compression is named, not guessed** | GeoTIFF pixels are decoded for uncompressed, LZW, Deflate and PackBits. JPEG, LERC and WebP are refused *by name* — a compressed tile read as raw samples would look like plausible terrain and be entirely fictional. |
| **DWG is honestly native** | It runs through a helper driving *your* ODA File Converter. A renamed DXF is never presented as a DWG. |
| **QA means re-import** | A green PASS means the output was read back and compared. A target with no reader reports `NOT VALIDATED`, never PASS. |
| **Repair is off by default** | Survey data is legal evidence. Geometry repair edits it, so it stays off until you switch it on, and reports every change. |
| **You are told the cost before you pay it** | Every output format is graded against *your* data across eleven axes before conversion, and "What will be lost" names and counts each loss — the field DBF will shorten, the arcs that will be densified, the Z that has nowhere to go. |
| **Input structure = output structure** | Layers become folders, folders stay folders, and a file found two ZIPs deep is delivered under the same tree. You see the exact delivery layout before you download it. |

Nothing is uploaded. `host_permissions` is empty, there is no network call in any
conversion path, and CI fails the build if a remote resource reaches the bundle.

---

## Install and run

```bash
npm ci
npm run verify        # typecheck + 237 tests + build
```

Then load it in Chrome:

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `dist/` folder
3. Click the toolbar icon → **Open converter workspace**

`npm run package` also produces `dist-zip/universal-bhunex-converter-1.0.0.zip`.

Optional: DWG support needs a small local helper — see
[docs/NATIVE_HOST.md](docs/NATIVE_HOST.md). Everything else works without it.

---

## What it converts

Full detail, with every limitation stated, is in
[docs/FORMAT_MATRIX.md](docs/FORMAT_MATRIX.md). In short:

- **GIS vector** — GeoJSON, GeoJSON Sequence, TopoJSON, Shapefile (complete
  .shp/.shx/.dbf/.prj/.cpg packages), KML, KMZ, GPX, WKT, WKB, GML, OSM, MapInfo
  MIF/MID
- **CAD** — DXF read and write with wide entity coverage (POINT through
  HATCH/MESH, block expansion, real B-spline evaluation); DWG via the native
  helper
- **Survey** — CSV/TSV/TXT coordinate tables with PNEZD, PENZD, NEZ, ENZ, XYZ and
  header-alias schemas; LandXML; XLSX
- **Mining** — Surpac `.str`, plus borehole, bench, crest/toe, blast-hole and
  cadastral field-name recognition (Khasra, Khewat, Khatian included)
- **LiDAR** — LAS 1.0–1.4 read and write, XYZ, PTS, PLY, with nth/grid/voxel
  decimation and classification, crop, elevation and intensity filters
- **Raster** — ESRI ASCII Grid (full DEM read/write), world files, QGIS GCP
  points, `.prj`/`.qpj`; GeoTIFF read and write (uncompressed, LZW, Deflate,
  PackBits; strips and tiles; predictors 2 and 3)

---

## Structure in, structure out

A conversion is not just a format change — the way your data is *organised* is
part of the data. Layers, folder nesting and archive nesting all survive the trip.

Choose the delivery shape in the settings panel, next to precision:

| Layout | What you get |
|---|---|
| **Single file** | One output file. The obvious case stays obvious. |
| **One file per layer** | Each layer becomes its own file, inside folders that reproduce the layer hierarchy. Several files are packaged as one ZIP whose folders *are* that hierarchy. |
| **Mirror the source tree** | As above, but rooted at the folder — and the archive — the file came from. |

```
survey.zip                          Delivery.zip
└─ Delivery/                        └─ survey/
   └─ plots.dxf         ──────▶        └─ Delivery/
      ├─ Boundary                         ├─ Boundary.geojson
      ├─ Mine/Haul road                   └─ Mine/
      └─ Mine/Bench toe                      ├─ Haul road.geojson
                                             └─ Bench toe.geojson
```

The hierarchy is carried as path segments rather than a flattened name, so it can
be rebuilt as **real containers** where the target supports them — nested KML
folders, DXF layers — and as real folders where it does not. Multi-file targets
stay loose inside the tree (`Borehole/Borehole.shp`), never a ZIP inside a ZIP.

The complete delivery tree is shown in the **Delivery structure** tab before you
download anything.

---

## Layout

```
extension/src/
  core/       CIR, format registry, detector, units, geometry, precision,
              layout (delivery structure), predict (fidelity), spatial index,
              pipeline
  crs/        projections, bundled EPSG subset, WKT/PRJ, transform safety
  engines/    vector/ cad/ raster/ pointcloud/ survey/ archives/
  qa/         defect catalogue, topology rules, preview-and-apply repair,
              and the fidelity re-import comparison
  workers/    off-thread conversion
  workspace/  the full-page professional workspace
  sidepanel/  quick drop + queue
  popup/      launcher
native-host/  Python DWG helper + installer
docs/         instruction document, build state, format matrix, native host
```

**Zero runtime dependencies.** ZIP, DEFLATE, DBF, SHP, DXF, LAS, XLSX and the
projections are all implemented in-repo or use platform APIs
(`CompressionStream`, `DataView`, Web Workers). MV3 forbids remote code, and a
package with no runtime dependency cannot silently acquire one.

---

## Architecture in one paragraph

Every reader produces a **Canonical Intermediate Representation** and every
writer consumes one. There are no direct format-to-format paths, so N formats
cost 2N engines instead of N×(N−1) converters — and a capability or a warning
added once is visible on every path through the tool. The single dispatch point
is `core/pipeline.ts`, which is also what makes the honesty rules enforceable:
the CRS gate, the decimation notice and the QA re-import sit on the one path
that every conversion takes.

---

## Development

```bash
npm run lint     # tsc --noEmit, strict
npm test         # vitest
npm run build    # vite → dist/
npm run package  # dist/ → dist-zip/*.zip
npm run dev      # watch build
```

A **registry guard test** enforces the central honesty rule directly: a format
claiming `full` support without a covering round-trip test fails the build. When
it fires, the fix is to add the test, not to lower the claim.

Provenance for the reused engines, the current phase board and the next tasks
live in [docs/BUILD_STATE.md](docs/BUILD_STATE.md). The authoritative
specification is
[docs/UNIVERSAL_BHUNEX_CONVERTER_BUILD_INSTRUCTIONS.txt](docs/UNIVERSAL_BHUNEX_CONVERTER_BUILD_INSTRUCTIONS.txt).

---

## Known gaps — documented, not hidden

1. **GeoTIFF pixels are not decoded.** Georeference and structure are read; a
   real codec is Phase 4.
2. **LAZ has no bundled decoder.** The header is reported and the points are
   refused.
3. **DGN, E57, GeoPackage, FlatGeobuf, GeoParquet, File Geodatabase and vendor
   mining formats** are adapter contracts only.
4. **Datum shifts outside the WGS 84 family** and **geoid conversions** are
   refused rather than approximated — there is no engine for them, so there is no
   UI offering them.

## Licence

MIT.
