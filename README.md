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

## Install

A **Chrome Manifest V3 extension**. The same package runs in **Google Chrome and
Microsoft Edge** — both are Chromium, and nothing changes between them.

> **Do not load this repository folder into your browser.** It contains
> TypeScript, not a built extension, and there is no `manifest.json` at the
> root — that is what produces *"Manifest file is missing or unreadable"*.

### The easy way — no Node, no build

1. Download `universal-bhunex-converter-<version>.zip` from
   **[Releases](https://github.com/emailofsalim/Universal-Converter/releases)**.
2. **Extract it to a plain local folder such as `C:\Extensions\`** — browsers
   load a folder, not an archive, and a folder inside OneDrive loads as
   unreadable placeholders on a managed laptop.
3. Read `INSTALL-FIRST.txt`, which is inside the folder you just extracted.
4. `edge://extensions` (or `chrome://extensions`) → turn on **Developer mode**.
5. **Load unpacked** → select the unzipped folder, the one that directly
   contains `manifest.json`.
6. Toolbar icon → **Open converter workspace**.

Keep the folder where you put it: the browser re-reads it at every start.

### Building it yourself

Node 20+:

```bash
npm ci
npm run verify        # typecheck + 450 tests + build
```

Then **Load unpacked** → select **`dist/`**. Not the repository root, and not
`extension/` — the root has no manifest and `extension/` is the source that
`npm run build` compiles into `dist/`.

`npm run store:package` produces `dist-zip/universal-bhunex-converter-<version>.zip`
— a store build with no source maps, checked against every rule the stores enforce.

Seeing *"Manifest file is missing or unreadable"*? On a work laptop it is
usually OneDrive, not the wrong folder — **[docs/INSTALL.md](docs/INSTALL.md)**
explains both causes and how to tell them apart.

**[docs/PACKAGE_CONTENTS.md](docs/PACKAGE_CONTENTS.md)** lists every file and
folder the ZIP must contain to load through Developer mode in Chrome and Edge,
and the archive rules behind it. `npm run package:check` enforces all of it —
it reads the archive the way a strict extractor does, which is how a malformed
central directory that Node and 7-Zip happily recovered from, but Windows
Explorer did not, was found.

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

## Beyond converting

Six things the tool does that a format converter normally does not.

**It tells you the cost before you pay it.** Every output format is graded
against *your* data across eleven axes — geometry, attributes, CRS, Z, style,
labels, layers, precision, source entities, topology, metadata — before anything
is written. The *What will be lost* tab names and counts each loss:

> 3 field names exceed DBF's 10-character limit: `sample_description` →
> `sample_des`, `collar_elevation` → `collar_ele`

That is the silent join break you would otherwise find weeks later. An
impossible target fails immediately with the reason; a merely *lossy* one
proceeds, because what to trade away is your decision, not the tool's.

**It makes a cadastral DXF usable as GIS.** A cadastral drawing holds boundaries
as line work on one layer and plot numbers as text on another, with nothing
linking them — which is why that conversion is normally redone by hand, plot by
plot. Two opt-in steps fix it: separate LINE entities are assembled into closed
boundaries (with the gap closed recorded per polygon, and anything beyond your
tolerance left open and reported), then the text inside each parcel is attached
to it. Labels go at the *pole of inaccessibility*, not the centroid — the
centroid of a C-shaped parcel falls outside it, putting the plot number in the
neighbouring plot.

**It finds the defects that ruin survey data.** Overlapping parcels,
shared-edge mismatches that become slivers on dissolve, slivers, spikes,
bow-ties, holes outside their shell, crossing contours, dangling endpoints, and
elevations with a transposed decimal point. Every defect names its tolerance and
where to look. Ten topology rules can be asserted over the whole dataset, one
layer, or a single disputed parcel. Repair is previewed before it is applied,
undone as a diff rather than a snapshot, and refuses layers you mark legally
operative.

**It produces a borehole KMZ that opens anywhere.** Collars are joined to their
interval logs by hole id — across files, with column aliases for Datamine,
Surpac, Micromine and spreadsheet naming — and each balloon carries the full core
log with any unlogged gap or overlapping record flagged beside it. Every value is
escaped, and anything credential-shaped is withheld and reported: a KMZ gets
emailed around.

**It edits, and the edits reach the file.** An attribute table with a field
calculator, a layer manager, a vertex editor on the canvas, and sixteen geometry
operations — buffer, offset, union, intersection, difference, symmetric
difference, dissolve, clip, erase, convex hull, centroid, envelope, split by
line, line merge, explode and multipart. Every one is previewed before it
commits; the geometry ones are drawn over the source, because a dissolve on the
wrong field and one on the right field both report "1,240 features → 1" and only
the shape tells them apart.

The part that makes this real rather than decorative: the workspace holds a
5,000-feature preview, so an edit is stored as an INSTRUCTION and re-planned
against the whole file when you convert. A bulk set reaches all 40,000 parcels,
not the 5,000 on screen — and a convex hull is computed over all of them, which
is a different polygon rather than a smaller one.

**It measures, and says how.** Click a run of points for its length, its legs
and their bearings in DMS and quadrant form; close a ring for its area and
perimeter. The CRS decides whether the arithmetic is geodesic or planar and the
panel prints which it used, always — a degree of longitude is 111.3 km at the
equator and 102.5 km at 23°N, so a tool that treats degrees as a plane is wrong
by a factor that grows with latitude and looks entirely reasonable. Buffer and
offset go further and **refuse** on a geographic CRS: a "10 metre" setback there
is about 1,100 km, and unlike a wrong length, a wrong polygon does not invite a
sanity check.

Ctrl/Cmd+K opens a command palette over all of it, so the first screen stays
minimal.

---

## Layout

```
extension/src/
  core/       CIR, format registry, detector, units, geometry, precision,
              layout (delivery structure), predict (fidelity), presets,
              spatial index, expression parser, attributes, layers, edits,
              measure, polygon boolean, buffer, geometry operations, pipeline
  crs/        projections, bundled EPSG subset, WKT/PRJ, transform safety
  engines/    vector/ cad/ raster/ pointcloud/ survey/ archives/
  qa/         defect catalogue, topology rules, preview-and-apply repair,
              burn-in, label placement, CAD polygonisation, the fidelity
              re-import comparison and the measured source-vs-output diff
  ui/         canvas preview, the editing, measuring and comparison layers,
              and the command palette
  workers/    off-thread conversion: a worker pool, cancellation by
              termination, and progress reported as a stage
  workspace/  the full-page workspace — a shell plus one module per panel
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

1. **GeoTIFF decodes uncompressed, LZW, Deflate and PackBits.** JPEG, JPEG 2000,
   LERC, WebP and Zstandard are refused *by name*; the georeference, extent and
   footprint of such a file are still read. Only the first image of a file is
   read — overviews and multi-IFD pyramids are not.
2. **LAZ has no bundled decoder.** The header is reported and the points are
   refused, never read as uncompressed LAS.
3. **DGN, E57, GeoPackage, FlatGeobuf, GeoParquet, File Geodatabase and vendor
   mining formats** are adapter contracts only.
4. **Datum shifts outside the WGS 84 family** and **geoid conversions** are
   refused rather than approximated — there is no engine for them, so there is no
   UI offering them.
5. **Gap detection finds gaps along adjacent boundaries**, not a whole missing
   parcel inside a coverage; that needs a boolean union this build does not have,
   and the violation text says so.
6. **The second canvas is not built.** The source-versus-output comparison is
   measured and reported in the Compare tab; the side-by-side geometry overlay
   that would render it is still to come.

## Licence

MIT.
